import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '../github/app.ts';

/**
 * The subscription's usage, read before a launch in Swarm mode (proposal v3 §4.3, spike
 * 5). The endpoint is the one Claude Code's `/usage` reads, undocumented: the daemon
 * treats it as optional, and the pause after a limit is hit remains the brake without it.
 */
export interface UsageLimit {
  /** `session`, `weekly_all`, `weekly_scoped`, or whatever the endpoint adds. */
  kind: string;
  percent: number;
  resetsAt: string;
  /** The model a scoped limit counts, as the endpoint names it: `Fable`. */
  model?: string;
}

export interface SubscriptionUsage {
  /** The highest percentage across the windows: the one that binds. */
  percent: number;
  /** When that window resets. */
  resetsAt: string;
  limits: UsageLimit[];
}

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

/** Reads the usage with the token the provider was created with. Throws when the endpoint refuses, answers something else, or not within 15 seconds. */
export async function readUsage(token: string, fetchImpl: typeof fetch = fetch): Promise<SubscriptionUsage> {
  const response = await fetchImpl(USAGE_URL, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'anthropic-beta': 'oauth-2025-04-20', 'user-agent': 'razzou-harness' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`the usage endpoint answered ${response.status}`);
  return parseUsage(await response.json());
}

/** The windows the body lists, or the two it always carries when the list is missing. */
export function parseUsage(body: unknown): SubscriptionUsage {
  const data = (body ?? {}) as Record<string, unknown>;
  const limits: UsageLimit[] = [];
  const listed = Array.isArray(data.limits) ? (data.limits as Array<Record<string, unknown>>) : [];
  for (const limit of listed) {
    if (typeof limit.percent === 'number' && typeof limit.resets_at === 'string') {
      const model = ((limit.scope as { model?: { display_name?: unknown } } | undefined)?.model)?.display_name;
      limits.push({
        kind: typeof limit.kind === 'string' ? limit.kind : 'limit', percent: limit.percent, resetsAt: limit.resets_at,
        ...(typeof model === 'string' && model ? { model } : {}),
      });
    }
  }
  if (limits.length === 0) {
    for (const [kind, key] of [['session', 'five_hour'], ['weekly_all', 'seven_day']] as const) {
      const window = data[key] as Record<string, unknown> | undefined;
      if (window && typeof window.utilization === 'number' && typeof window.resets_at === 'string') limits.push({ kind, percent: window.utilization, resetsAt: window.resets_at });
    }
  }
  if (limits.length === 0) throw new Error('the usage endpoint answered without any limit');
  const binding = limits.reduce((top, limit) => (limit.percent > top.percent ? limit : top));
  return { percent: binding.percent, resetsAt: binding.resetsAt, limits };
}

/** Where the doctor stores the token, next to the App's key: mode 0600, read by the daemon for this one call. */
export function claudeTokenFile(dir = configDir()): string {
  return join(dir, 'claude.token');
}

export function loadClaudeToken(dir = configDir()): string | undefined {
  const file = claudeTokenFile(dir);
  if (!existsSync(file)) return undefined;
  const token = readFileSync(file, 'utf8').trim();
  return token === '' ? undefined : token;
}

export function saveClaudeToken(token: string, dir = configDir()): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = claudeTokenFile(dir);
  writeFileSync(file, `${token.trim()}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}
