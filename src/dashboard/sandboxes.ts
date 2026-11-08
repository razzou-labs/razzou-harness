import type { Orchestrator } from '../daemon/orchestrator.ts';
import type { UsageReading } from '../sandbox/docker.ts';
import { PROJECT_LABEL, type GatewayStatus, type SandboxInfo } from '../sandbox/driver.ts';
import { LOG_LINES, parseDenials, type Denial } from '../sandbox/refusals.ts';
import type { State } from '../state/state.ts';
import { machineSize } from '../util.ts';

export type { Denial, UsageReading };

export type SandboxRole = 'Architect' | 'Manager' | 'Developer' | 'Reviewer' | 'Checks';

/** A sandbox on the gateway, as the Sandboxes view shows it. */
export interface SandboxRow {
  name: string;
  /** OpenShell's word for its state. */
  phase: string;
  createdAt?: string;
  /** What it is for, when it is this project's. */
  role?: SandboxRole;
  title?: string;
  /** Its card in the Agents view. */
  agent?: string;
  /**
   * `in use`: an agent or a check run of this project needs it. `left over`: this
   * project's, and nothing needs it any more, so the owner may delete it. `other`:
   * another project's, or not the harness's.
   */
  use: 'in use' | 'left over' | 'other';
  /** For another project's, the project its label names. */
  project?: string;
}

export interface SandboxOverview {
  gateway: GatewayStatus;
  /** This project's first, those in use before the left-over ones, then the others. */
  sandboxes: SandboxRow[];
  /** Why OpenShell's list couldn't be read. */
  problem?: string;
  /** The owner's caps on each new sandbox, and the machine they share. */
  limits: { cpu?: number; memoryGiB?: number };
  machine: { cpus: number; memoryGiB: number };
}

interface Known {
  role: SandboxRole;
  title: string;
  agent?: string;
  live: boolean;
}

const LIVE_ATTEMPT = ['starting', 'running', 'collecting', 'checking', 'reviewing'];
const ROLES: Record<string, SandboxRole> = { arc: 'Architect', mgr: 'Manager', dev: 'Developer', rev: 'Reviewer', chk: 'Checks' };

/** Every sandbox the state names, and the check runs under way, with what each is for and whether it is still meant to be there. */
export function knownSandboxes(state: State, checking: ReadonlyMap<string, string>): Map<string, Known> {
  const known = new Map<string, Known>();
  for (const module of Object.values(state.modules)) {
    // An Architect stays for as long as its module: the owner designs with it, and it answers the Managers.
    known.set(module.architect.sandbox, { role: 'Architect', title: module.module, agent: `architect:${module.module}`, live: true });
  }
  for (const manager of Object.values(state.managers)) {
    const key = manager.plan ? `${manager.module}/${manager.plan}` : manager.module;
    known.set(manager.sandbox, { role: 'Manager', title: key, agent: `manager:${key}`, live: manager.status !== 'stopped' });
  }
  for (const feature of Object.values(state.features)) {
    for (const attempt of feature.attempts) {
      const key = `${feature.module}/${feature.plan}/${feature.feature}`;
      known.set(attempt.sandbox, { role: 'Developer', title: `${key} #${attempt.n}`, agent: `developer:${key}/a${attempt.n}`, live: LIVE_ATTEMPT.includes(attempt.status) });
    }
  }
  for (const plan of Object.values(state.plans)) {
    for (const review of plan.reviews ?? []) {
      const head = review.head.slice(0, 8);
      known.set(review.sandbox, {
        role: 'Reviewer', title: `${plan.module}/${plan.plan} · ${review.role} · ${head}`, agent: `${review.role}:${head}`, live: review.status === 'starting' || review.status === 'running',
      });
    }
  }
  for (const [name, ref] of checking) known.set(name, { role: 'Checks', title: `checks on ${ref}`, live: true });
  return known;
}

/** The gateway's sandboxes, each told apart as this project's in use, left over, or another's. Throws when OpenShell can't list them. */
export async function sandboxRows(o: Orchestrator): Promise<SandboxRow[]> {
  const listed = await o.driver.list();
  const known = knownSandboxes(o.state, o.checking);
  const project = o.design.config.project.name;
  const order = { 'in use': 0, 'left over': 1, other: 2 };
  return listed
    .map((sandbox) => row(sandbox, known.get(sandbox.name), project))
    .sort((a, b) => order[a.use] - order[b.use] || (a.createdAt ?? '').localeCompare(b.createdAt ?? '', 'en') || a.name.localeCompare(b.name, 'en'));
}

export async function sandboxOverview(o: Orchestrator): Promise<SandboxOverview> {
  const gateway = await o.driver.gateway();
  const settings = { limits: o.state.sandboxLimits ?? {}, machine: machineSize() };
  try {
    return { gateway, sandboxes: await sandboxRows(o), ...settings };
  } catch (error) {
    return { gateway, sandboxes: [], problem: (error as Error).message, ...settings };
  }
}

/** The requests a sandbox of this project was refused, from the last lines OpenShell keeps of its log; undefined for any other sandbox. */
export async function sandboxDenials(o: Orchestrator, name: string): Promise<Denial[] | undefined> {
  const found = (await sandboxRows(o)).find((s) => s.name === name && s.use !== 'other');
  return found ? parseDenials(await o.driver.logs(name, LOG_LINES)) : undefined;
}

/**
 * One reading of what the sandboxes use at a time, shared for a few seconds: each open
 * dashboard asks every few seconds, and `docker stats` takes two. Never rejects.
 */
export function sharedReading(read: () => Promise<UsageReading>, ttlMs = 3000, now: () => number = Date.now): () => Promise<UsageReading> {
  let last: { at: number; reading: Promise<UsageReading> } | undefined;
  return () => {
    if (last && now() - last.at < ttlMs) return last.reading;
    const reading = read().catch((error: Error): UsageReading => ({ at: new Date(now()).toISOString(), sandboxes: {}, total: { cpu: 0, memoryBytes: 0 }, problem: error.message }));
    last = { at: now(), reading };
    return reading;
  };
}

/** Deletes a left-over sandbox of this project, judged afresh: never one in use, nor another project's. */
export async function removeLeftOver(o: Orchestrator, name: string): Promise<{ done: boolean; error?: string }> {
  const found = (await sandboxRows(o)).find((s) => s.name === name);
  if (!found) return { done: false, error: 'the gateway has no such sandbox' };
  if (found.use === 'in use') return { done: false, error: 'it is in use' };
  if (found.use === 'other') return { done: false, error: "it isn't this project's" };
  await o.driver.remove(name);
  o.log(`the owner deleted the left-over sandbox ${name}`);
  return { done: true };
}

function row(sandbox: SandboxInfo, known: Known | undefined, project: string): SandboxRow {
  const base = { name: sandbox.name, phase: sandbox.phase, ...(sandbox.createdAt ? { createdAt: sandbox.createdAt } : {}) };
  if (known) return { ...base, role: known.role, title: known.title, ...(known.agent ? { agent: known.agent } : {}), use: known.live ? 'in use' : 'left over' };
  const label = sandbox.labels[PROJECT_LABEL];
  // This project's, but the state no longer names it: what a crash or a failed delete leaves.
  if (label === project) {
    const role = ROLES[sandbox.name.split('-')[0] ?? ''];
    return { ...base, ...(role ? { role } : {}), use: 'left over' };
  }
  return { ...base, use: 'other', ...(label ? { project: label } : {}) };
}
