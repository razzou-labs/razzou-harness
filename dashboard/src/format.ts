import type { HarnessEvent } from '../../src/state/events.ts';

export function refText(ref?: { module: string; plan?: string; feature?: string; attempt?: number }): string {
  if (!ref) return '';
  return [ref.module, ref.plan, ref.feature].filter(Boolean).join('/') + (ref.attempt ? ` #${ref.attempt}` : '');
}

export const clock = (ts: string) => new Date(ts).toLocaleTimeString();

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** Bytes in MiB or GiB, as Docker counts them. */
export function size(bytes: number): string {
  const mib = bytes / 1024 ** 2;
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)} GiB` : `${Math.round(mib)} MiB`;
}

/** CPUs busy, like 1.2, or 0.04 when it is next to nothing. */
export const cpus = (n: number) => (n < 0.1 ? n.toFixed(2) : n.toFixed(1));

/** Only GitHub's own https links are followed: agents choose the rest of the text. */
export const isGithubLink = (url?: string) => url !== undefined && /^https:\/\/github\.com\//.test(url);

/** One line about an event, for the feed. */
export function eventSummary(event: HarnessEvent): string {
  const p = event.payload as Record<string, unknown>;
  const first = ['reason', 'question', 'summary', 'guidance', 'answer', 'text', 'decision', 'outcome', 'title', 'key', 'commit']
    .map((k) => p[k])
    .find((v) => typeof v === 'string' && v !== '');
  return typeof first === 'string' ? first.replace(/\s+/g, ' ').slice(0, 240) : '';
}

/** Status words and the color class they get. */
export function tone(status: string): string {
  if (/^(accepted|completed|passed|done|frozen|success|running ok)$/.test(status)) return 'ok';
  if (/(failed|refused|failure|error|closed)/.test(status)) return 'bad';
  if (/(escalated|paused|proposed|in_review|ready_to_merge|blocked|waiting)/.test(status)) return 'warn';
  if (/^(pending|stopped|exited|skipped|waiting)$/.test(status)) return 'muted';
  return 'run';
}

/**
 * A model as people name it: `claude-fable-5-2` is Fable 5.2, `claude-sonnet-4-5-20250929`
 * Sonnet 4.5, with "(1M)" for a `[1m]` context; any other name, such as an alias, as it is.
 */
export function modelName(id: string): string {
  const parts = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i.exec(id);
  if (!parts) return id;
  const [, family, major, minor, wide] = parts as unknown as [string, string, string, string | undefined, string | undefined];
  return `${family[0]!.toUpperCase()}${family.slice(1)} ${major}${minor ? `.${minor}` : ''}${wide ? ' (1M)' : ''}`;
}
