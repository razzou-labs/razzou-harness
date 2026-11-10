/**
 * The subscription's usage, as the agents' Claude Code reports it (proposal v3 §4.3).
 * Every model call made with the subscription's token comes back with its unified
 * rate-limit headers, and Claude Code writes them into its stream-json as a
 * `rate_limit_event`: each window the plan has, with its utilization and when it resets.
 * Most plans have a five-hour session window and a seven-day one; a plan without a
 * session limit reports the seven-day window alone, and the harness reads whichever come
 * (0.5.2). The daemon follows the Developers', the Manager's and the reviewers' streams,
 * so it needs no token of its own: the one from `claude setup-token` has `user:inference`
 * only, which the usage endpoint refuses.
 */
export interface UsageLimit {
  /** `session`, `weekly_all`, or the window's own name for one Claude Code adds. */
  kind: string;
  percent: number;
  resetsAt: string;
  /** The model a scoped limit counts, when a window names one. */
  model?: string;
}

export interface SubscriptionUsage {
  /** The highest percentage across the windows: the one that binds. */
  percent: number;
  /** When that window resets. */
  resetsAt: string;
  limits: UsageLimit[];
}

/** What the dashboard and the Swarm ceiling call the windows Claude Code reports. */
const KINDS: Record<string, string> = { five_hour: 'session', seven_day: 'weekly_all' };

/** A window as a message names it: "the five-hour session", "the weekly window". */
export function windowName(kind: string): string {
  if (kind === 'session') return 'the five-hour session';
  if (kind === 'weekly_all') return 'the weekly window';
  return `the ${kind.replace(/_/g, ' ')} window`;
}

type Window = { utilization?: unknown; resetsAt?: unknown };

/**
 * The windows one `rate_limit_event` reports, from a parsed stream-json line; undefined
 * for any other line. Utilization comes as a fraction, the reset as Unix seconds. Without
 * `unifiedWindows`, the event's own window is the one it names at its top, when it gives
 * its numbers.
 */
export function usageFromEvent(item: unknown): SubscriptionUsage | undefined {
  const event = (item ?? {}) as { type?: unknown; rate_limit_info?: Window & { rateLimitType?: unknown; unifiedWindows?: Record<string, Window | null> } };
  if (event.type !== 'rate_limit_event') return undefined;
  const info = event.rate_limit_info ?? {};
  const windows = info.unifiedWindows ?? (typeof info.rateLimitType === 'string' ? { [info.rateLimitType]: info } : {});
  const limits: UsageLimit[] = [];
  for (const [name, window] of Object.entries(windows)) {
    if (!window || typeof window.utilization !== 'number' || typeof window.resetsAt !== 'number') continue;
    limits.push({ kind: KINDS[name] ?? name, percent: Math.round(window.utilization * 100), resetsAt: new Date(window.resetsAt * 1000).toISOString() });
  }
  if (limits.length === 0) return undefined;
  const binding = limits.reduce((top, limit) => (limit.percent > top.percent ? limit : top));
  return { percent: binding.percent, resetsAt: binding.resetsAt, limits };
}
