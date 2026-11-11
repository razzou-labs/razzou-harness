import type { DashboardState } from '../../src/dashboard/server.ts';
import type { ActionState, FeatureState, ModuleState, OwnerRequest, PlanState, State } from '../../src/state/state.ts';

type Design = DashboardState['design'];
type ModuleDesign = Design['modules'][number];
export type OwnerAction = ModuleDesign['actions'][number];

/** A plan that held-back work builds on and that isn't complete, with the held-back plans that build on it. */
export interface Upstream {
  plan: string;
  /** 'waiting' before the plan starts. */
  status: PlanState['status'] | 'waiting';
  /** Its deploy or its post-deploy checks failed: it is merged, so the work that builds on it can start all the same. */
  failed: boolean;
  holds: string[];
}

/** One thing waiting for the owner: a card of Needs you. */
export type Need =
  | { kind: 'paused'; key: string; paused: NonNullable<State['pipeline']['paused']> }
  | { kind: 'locked'; key: string; module: ModuleState; rechecks: string[] }
  | { kind: 'design'; key: string; module: ModuleState }
  | { kind: 'proposal'; key: string; module: ModuleState; version: number }
  | { kind: 'escalation'; key: string; module: ModuleState; escalation: ModuleState['escalations'][number] }
  | { kind: 'request'; key: string; request: OwnerRequest }
  | { kind: 'left' | 'merge'; key: string; plan: PlanState }
  | { kind: 'escalated'; key: string; feature: FeatureState }
  | { kind: 'action'; key: string; module: string; action: OwnerAction; status?: ActionState; holds: string[]; waits: Upstream[] };

/**
 * Everything waiting for the owner, in the order to handle it: what changes the work
 * first, what starts new work last.
 *
 * 1. A paused pipeline: nothing new starts until it is resumed.
 * 2. Each module's cards from its Architect: a change to locked files, a design, a
 *    proposal, a Manager's question to it. They may redefine what the cards below are
 *    about, a gate's check among them.
 * 3. The build's own: the Managers' questions, the blocking ones first, then the oldest;
 *    the plans' pull requests, in the design's order; the escalated features.
 * 4. Gates and tasks, since marking one done starts the work it held back: those whose
 *    work builds on nothing unfinished first.
 *
 * The daemon holds back whatever isn't ready, so most cards can't be handled too early.
 * A gate can: its `when` is a sentence for the owner, which the daemon can't check.
 */
export function listNeeds({ state, design }: Pick<DashboardState, 'state' | 'design'>): Need[] {
  const needs: Need[] = [];
  const paused = state.pipeline.paused;
  if (paused) needs.push({ kind: 'paused', key: 'paused', paused });

  for (const module of Object.values(state.modules)) {
    const id = module.module;
    if (module.locked?.pr) needs.push({ kind: 'locked', key: `locked:${id}`, module, rechecks: rechecks(design, state, module) });
    if (module.status === 'in_review' && module.design?.pr) needs.push({ kind: 'design', key: `design:${id}`, module });
    const latest = module.proposals.at(-1);
    if (module.status === 'proposed' && latest && !latest.acceptedAt) needs.push({ kind: 'proposal', key: `proposal:${id}`, module, version: latest.version });
    for (const escalation of module.escalations) {
      if (escalation.decision === undefined) needs.push({ kind: 'escalation', key: `escalation:${escalation.id}`, module, escalation });
    }
  }

  const requests = Object.values(state.ownerRequests)
    .filter((r) => r.answer === undefined)
    .sort((a, b) => Number(b.blocking) - Number(a.blocking) || a.askedAt.localeCompare(b.askedAt));
  for (const request of requests) needs.push({ kind: 'request', key: `request:${request.requestId}`, request });

  const order = new Map(design.modules.flatMap((m) => m.plans.map((p) => `${m.id}/${p.id}`)).map((key, index) => [key, index]));
  const position = (plan: PlanState) => order.get(`${plan.module}/${plan.plan}`) ?? order.size;
  const open = Object.values(state.plans)
    .filter((p) => p.pr && (p.status === 'ready_to_merge' || p.status === 'pr_open'))
    .sort((a, b) => position(a) - position(b));
  for (const plan of open) {
    // In Swarm, the merge policy may leave a PR to the owner, with its reason (v3 §3.2).
    if (plan.leftToOwner) needs.push({ kind: 'left', key: `left:${plan.module}/${plan.plan}`, plan });
    else if (plan.status === 'ready_to_merge') needs.push({ kind: 'merge', key: `merge:${plan.module}/${plan.plan}`, plan });
  }

  for (const feature of Object.values(state.features)) {
    if (feature.status === 'escalated') needs.push({ kind: 'escalated', key: `escalated:${feature.module}/${feature.plan}/${feature.feature}`, feature });
  }

  const actions: Array<Extract<Need, { kind: 'action' }>> = [];
  for (const module of design.modules) {
    for (const action of module.actions) {
      const status = state.actions[`${module.id}/${action.id}`];
      if (status?.status === 'done') continue;
      const holds = heldBack(module, action);
      actions.push({
        kind: 'action', key: `action:${module.id}/${action.id}`, module: module.id, action,
        ...(status ? { status } : {}), holds, waits: upstream(module, state, holds),
      });
    }
  }
  needs.push(...actions.filter((a) => a.waits.length === 0), ...actions.filter((a) => a.waits.length > 0));
  return needs;
}

/** What a gate holds back: the plans and features it blocks, and the features that name it. A task holds nothing back. */
export function heldBack(module: ModuleDesign, action: OwnerAction): string[] {
  if (action.kind !== 'gate') return [];
  const named = module.plans.flatMap((p) => p.features.filter((f) => f.gates.includes(action.id)).map((f) => `${p.id}/${f.id}`));
  // A feature of a plan held back whole is already said.
  return [...new Set([...action.blocks, ...named.filter((ref) => !action.blocks.includes(ref.split('/')[0]!))])];
}

/**
 * The plans that held-back work builds on and that aren't complete: those its plan
 * depends on, and those of the other plans' features it depends on. The daemon starts
 * the work once they are merged; until they are complete, their deploy or their
 * post-deploy checks may still fail, or already have.
 */
export function upstream(module: ModuleDesign, state: Pick<State, 'plans'>, holds: string[]): Upstream[] {
  const found = new Map<string, Upstream>();
  for (const held of holds) {
    const [planId, featureId] = held.split('/') as [string, string | undefined];
    const plan = module.plans.find((p) => p.id === planId);
    if (!plan) continue;
    const features = featureId ? plan.features.filter((f) => f.id === featureId) : plan.features;
    const across = features.flatMap((f) => f.dependsOn.filter((d) => d.includes('/')).map((d) => d.split('/')[0]!));
    for (const id of new Set([...plan.dependsOn, ...across])) {
      const built = state.plans[`${module.id}/${id}`];
      const status = built?.status ?? 'waiting';
      if (id === planId || status === 'completed') continue;
      // A fix round before the merge is CI's or a reviewer's: nothing builds on the plan yet.
      const failed = status === 'deploy_failed' || status === 'verify_failed' || (status === 'fixing' && built?.mergeCommit !== undefined);
      const entry = found.get(id) ?? { plan: id, status, failed, holds: [] };
      if (!entry.holds.includes(planId)) entry.holds.push(planId);
      found.set(id, entry);
    }
  }
  return module.plans.flatMap((p) => found.get(p.id) ?? []);
}

/**
 * The plans whose failed post-deploy checks a change to locked files touches: the daemon
 * runs them again once the change is on main. A check the change adds isn't on main yet,
 * so its phase isn't known here: it names no plan.
 */
function rechecks(design: Design, state: State, module: ModuleState): string[] {
  const plans = design.modules.find((m) => m.id === module.module)?.plans ?? [];
  const out: string[] = [];
  for (const change of module.locked?.changes ?? []) {
    if (out.includes(change.plan) || state.plans[`${module.module}/${change.plan}`]?.status !== 'verify_failed') continue;
    const feature = plans.find((p) => p.id === change.plan)?.features.find((f) => f.id === change.feature);
    const postDeploy = new Set(feature?.checks.filter((c) => c.phase === 'post-deploy').map((c) => c.id));
    if (change.checks.some((id) => postDeploy.has(id.replace(/ \((?:added|removed)\)$/, '')))) out.push(change.plan);
  }
  return out;
}

/** How a plan that isn't complete stands, as the end of "P5 builds on P3, …". */
const STANDING: Record<Upstream['status'], string> = {
  waiting: "which hasn't started",
  active: 'which is being built',
  validating: 'whose full check run is under way',
  pr_open: 'whose pull request is open',
  fixing: 'which is being fixed',
  ready_to_merge: 'whose pull request waits to be merged',
  deploying: 'which is deploying',
  verifying: 'whose post-deploy checks are running',
  deploy_failed: 'whose deploy failed',
  verify_failed: 'whose post-deploy checks failed',
  completed: 'which is complete',
};

/**
 * "P5 builds on P3, which is deploying.", and for a plan that failed, what the gate would
 * let through: the daemon starts work once what it builds on is merged, failed or not.
 */
export function waitText(wait: Upstream): string {
  const held = list(wait.holds);
  const standing = `${held} ${wait.holds.length === 1 ? 'builds' : 'build'} on ${wait.plan}, ${STANDING[wait.status]}.`;
  return wait.failed ? `${standing} Marking this done lets ${held} start all the same.` : standing;
}

/** "P2", "P2 and P3", "P2, P3 and P4". */
export function list(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)!}`;
}
