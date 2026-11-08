import { run } from '../util.ts';

/** What a sandbox uses of the machine right now. */
export interface SandboxUsage {
  /** CPUs busy: 1.5 is one and a half. */
  cpu: number;
  memoryBytes: number;
  /** The caps it was created with, when it has them. */
  cpuLimit?: number;
  memoryLimitBytes?: number;
}

/** What the OpenShell sandboxes on this machine use right now, as Docker reports it. */
export interface UsageReading {
  at: string;
  /** By sandbox name: its container that runs the agent and its commands. */
  sandboxes: Record<string, SandboxUsage>;
  /** Every OpenShell container on the machine, the supervisors next to the sandboxes included. */
  total: { cpu: number; memoryBytes: number };
  /** Why there is no reading, or only part of one. */
  problem?: string;
}

const LABEL = 'openshell.ai';

/**
 * Reads what every OpenShell sandbox on the machine uses from Docker, OpenShell's compute
 * driver here: OpenShell's CLI doesn't report it. A sandbox is two containers, labelled
 * with its name: the sandbox itself, where the agent and its commands run under the caps,
 * and OpenShell's supervisor next to it. `docker stats` samples for about two seconds.
 */
export async function readDockerUsage(bin = 'docker', now: () => number = Date.now): Promise<UsageReading> {
  const empty: UsageReading = { at: new Date(now()).toISOString(), sandboxes: {}, total: { cpu: 0, memoryBytes: 0 } };
  const docker = (args: string[], timeout: number) =>
    run(bin, args, { timeout, killSignal: 'SIGKILL' }).catch((error: Error) => ({ code: -1, stdout: '', stderr: error.message }));
  const listed = await docker(['ps', '--filter', `label=${LABEL}/managed-by=openshell`, '--format', `{{.ID}}\t{{.Label "${LABEL}/sandbox-name"}}\t{{.Label "${LABEL}/isolation-role"}}`], 15_000);
  if (listed.code !== 0) return { ...empty, problem: `docker ps failed: ${clip(listed.stderr || listed.stdout)}` };
  const containers = listed.stdout.split('\n').map((line) => line.split('\t')).filter((fields) => /^[0-9a-f]{12,64}$/.test(fields[0] ?? ''))
    .map(([id, sandbox, role]) => ({ id: id!, sandbox: sandbox ?? '', role: role ?? '' }));
  if (containers.length === 0) return empty;
  const ids = containers.map((c) => c.id);
  // A container that went meanwhile makes both commands fail, after they report the others.
  const [stats, inspect] = await Promise.all([
    docker(['stats', '--no-stream', '--format', '{{json .}}', ...ids], 30_000),
    docker(['inspect', '--format', '{{.Id}}\t{{.HostConfig.NanoCpus}}\t{{.HostConfig.Memory}}', ...ids], 15_000),
  ]);
  const used = new Map<string, { cpu: number; memoryBytes: number }>();
  for (const line of stats.stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    const item = JSON.parse(line) as { ID?: string; CPUPerc?: string; MemUsage?: string };
    const cpu = Number.parseFloat(item.CPUPerc ?? '');
    const memory = bytes((item.MemUsage ?? '').split('/')[0] ?? '');
    if (item.ID) used.set(item.ID, { cpu: Number.isFinite(cpu) ? Math.round(cpu * 100) / 1e4 : 0, memoryBytes: Math.round(memory ?? 0) });
  }
  const limits = new Map<string, { cpuLimit?: number; memoryLimitBytes?: number }>();
  for (const [id, nanoCpus, memory] of inspect.stdout.split('\n').map((line) => line.split('\t'))) {
    const cpuLimit = Number(nanoCpus) / 1e9;
    const memoryLimitBytes = Number(memory);
    if (id) limits.set(id, { ...(cpuLimit > 0 ? { cpuLimit } : {}), ...(memoryLimitBytes > 0 ? { memoryLimitBytes } : {}) });
  }
  const reading: UsageReading = { ...empty, sandboxes: {}, total: { cpu: 0, memoryBytes: 0 } };
  for (const container of containers) {
    const usage = used.get(container.id) ?? [...used].find(([id]) => id.startsWith(container.id) || container.id.startsWith(id))?.[1];
    if (!usage) continue;
    reading.total.cpu += usage.cpu;
    reading.total.memoryBytes += usage.memoryBytes;
    if (container.role !== 'sandbox' || !container.sandbox) continue;
    const caps = [...limits].find(([id]) => id.startsWith(container.id))?.[1] ?? {};
    reading.sandboxes[container.sandbox] = { ...usage, ...caps };
  }
  if (used.size === 0) reading.problem = `docker stats failed: ${clip(stats.stderr || stats.stdout || `it exited with ${stats.code}`)}`;
  return reading;
}

/** `5.656MiB` and `1.2GB` in bytes; undefined for anything else. */
export function bytes(text: string): number | undefined {
  const match = /^([\d.]+)\s*([kKMGTP]?)(i?)B$/.exec(text.trim());
  if (!match) return undefined;
  const power = ' KMGTP'.indexOf((match[2] || ' ').toUpperCase());
  return Number(match[1]) * (match[3] ? 1024 : 1000) ** power;
}

const clip = (text: string) => text.trim().replace(/\s+/g, ' ').slice(0, 300);
