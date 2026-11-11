import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Orchestrator } from '../daemon/orchestrator.ts';
import { ConfigSchema } from '../design/schemas.ts';
import { configDir } from '../github/app.ts';
import { run } from '../util.ts';

/** One setting the daemon runs with: its value, whether harness/config.json sets it, and the default it replaces. */
export interface ConfigSetting {
  /** Dotted, like `roles.developer.attemptTimeoutMinutes`. */
  path: string;
  value: unknown;
  /** Set in harness/config.json on main; otherwise the value is the default. */
  set: boolean;
  /** The default, when the file sets another value. */
  default?: unknown;
  /** No default: the file has to set it. */
  required?: boolean;
}

/** A setting kept outside harness/config.json, in words. */
export interface ConfigFact {
  name: string;
  value: string;
}

/** The Config tab (§14.1): every setting of the harness, wherever it is kept. No secret: keys stay where they are. */
export interface ConfigView {
  settings: ConfigSetting[];
  /** What the owner set through the dashboard or the CLI, kept in the daemon's state. */
  daemon: ConfigFact[];
  /** This machine: the tools, the providers and the GitHub App the harness uses. */
  machine: ConfigFact[];
}

export async function configView(o: Orchestrator): Promise<ConfigView> {
  const config = o.design.config;
  const raw = JSON.parse((await o.repo.show('refs/heads/main', 'harness/config.json').catch(() => undefined)) ?? '{}') as unknown;
  // The defaults, from the same file with only what has none: the project, and an AWS region and provider.
  const required = { harnessVersion: config.harnessVersion, project: config.project, ...(config.aws ? { aws: { region: config.aws.region, provider: config.aws.provider } } : {}) };
  const defaults = ConfigSchema.parse({ ...required, ...(config.terraform ? { terraform: {} } : {}) });
  const settings = leaves(config).map(([path, value]): ConfigSetting => {
    const name = path.join('.');
    if (has(required, path)) return { path: name, value, set: true, required: true };
    const set = has(raw, path);
    const fallback = has(defaults, path) ? at(defaults, path) : undefined;
    return { path: name, value, set, ...(set && fallback !== undefined && JSON.stringify(fallback) !== JSON.stringify(value) ? { default: fallback } : {}) };
  });
  return { settings, daemon: daemonFacts(o), machine: await machineFacts(o) };
}

function daemonFacts(o: Orchestrator): ConfigFact[] {
  const { state } = o;
  const paused = state.pipeline.paused;
  return [
    { name: 'Your hours', value: state.budgets.ownerHours !== undefined ? `${state.budgets.ownerHours} h for the whole project` : 'not set' },
    { name: 'Pipeline', value: paused ? `paused: ${paused.reason}${paused.until ? `, until ${paused.until}` : ''}` : 'running' },
    { name: 'Daemon', value: state.daemon ? `razzou-harness ${state.daemon.version}, pid ${state.daemon.pid}` : 'stopped' },
    { name: 'Project folder', value: o.options.projectDir },
  ];
}

async function machineFacts(o: Orchestrator): Promise<ConfigFact[]> {
  const [gateway, providers, claude] = await Promise.all([
    o.driver.gateway().catch((error: Error) => ({ status: 'unreachable', problem: error.message, version: undefined })),
    o.driver.providers().catch(() => undefined),
    claudeVersion(),
  ]);
  const dir = configDir();
  const app = readApp(dir);
  return [
    { name: 'Node.js', value: process.version },
    { name: 'Claude Code', value: claude ?? 'not found' },
    { name: 'OpenShell gateway', value: `${gateway.status}${gateway.version ? `, ${gateway.version}` : ''}` },
    { name: 'OpenShell providers', value: providers === undefined ? "the gateway didn't list them" : providers.join(', ') || 'none' },
    {
      name: 'GitHub App',
      value: app
        ? `${app.name} (${app.slug}, id ${app.appId}), owned by ${app.owner}; its private key ${existsSync(join(dir, 'app.pem')) ? 'is' : 'is not'} on this machine`
        : 'none on this machine',
    },
    { name: "The harness's folder on this machine", value: dir },
  ];
}

/** app.json's public part: the App's name, slug, id and owner, never its key. */
function readApp(dir: string): { name: string; slug: string; appId: number; owner: string } | undefined {
  try {
    const { name, slug, appId, owner } = JSON.parse(readFileSync(join(dir, 'app.json'), 'utf8')) as Record<string, unknown>;
    return typeof name === 'string' && typeof slug === 'string' ? { name, slug, appId: Number(appId), owner: String(owner) } : undefined;
  } catch {
    return undefined;
  }
}

/** The host's Claude Code version, read again after ten minutes: an update shows without a restart. */
let claude: { at: number; version: Promise<string | undefined> } | undefined;
function claudeVersion(): Promise<string | undefined> {
  if (!claude || Date.now() - claude.at > 600_000) {
    claude = { at: Date.now(), version: run('claude', ['--version'], { timeout: 10_000 }).then((r) => (r.code === 0 ? r.stdout.trim() : undefined), () => undefined) };
  }
  return claude.version;
}

/** Every setting as a path and a value: objects open up, and arrays, records left empty and plain values are leaves. */
function leaves(value: unknown, path: string[] = []): Array<[string[], unknown]> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0) {
    return Object.entries(value).filter(([, inner]) => inner !== undefined).flatMap(([key, inner]) => leaves(inner, [...path, key]));
  }
  return [[path, value]];
}

function has(value: unknown, path: string[]): boolean {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== 'object' || !(key in current)) return false;
    current = (current as Record<string, unknown>)[key];
  }
  return true;
}

function at(value: unknown, path: string[]): unknown {
  return path.reduce<unknown>((current, key) => (current !== null && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined), value);
}
