import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { streamUsage } from '../agents/claude-code.ts';
import type { Usage } from '../state/events.ts';
import type { State } from '../state/state.ts';

export type TokenRole = 'Developers' | 'Managers' | 'Architects' | 'Reviewers';

/** What Claude read and wrote for one role, for the Project view. */
export interface RoleTokens {
  role: TokenRole;
  /** Every token read, the prompt cache's included. */
  read: number;
  /** Of `read`, what the prompt cache served, where it is known. */
  cacheRead: number;
  /**
   * The part of `read` whose cache reads are known: all of it, but what a Manager's or an
   * Architect's sandbox read before it went, if it went before 0.5.1, and a session whose
   * saved stream is gone.
   */
  known: number;
  written: number;
}

/** The end of a file: a session's result is its stream's last line. */
function tail(path: string, bytes = 1 << 20): string {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** The cache reads of sessions recorded before 0.5.1, found again in their streams, by stream and usage. */
const found = new Map<string, number | null>();

/**
 * A session recorded before 0.5.1 has no cache reads: its saved stream has them, when it
 * is the stream that gave the usage recorded. A review run again on the same head writes
 * over its folder's, whose totals then differ, so it stays unknown.
 */
function cacheReadsOf(stream: string, usage: Usage): number | null {
  const key = `${stream}\n${usage.inputTokens}/${usage.outputTokens}`;
  if (!found.has(key)) {
    let cache: number | null = null;
    try {
      const again = streamUsage(tail(stream));
      if (again?.inputTokens === usage.inputTokens && again.outputTokens === usage.outputTokens) cache = again.cacheReadTokens ?? null;
    } catch {
      // No stream: unknown.
    }
    found.set(key, cache);
  }
  return found.get(key)!;
}

/**
 * Claude's tokens by role: a Developer's and a reviewer's from their sessions' end, a
 * Manager's and an Architect's from the daemon's readings of their sandboxes. What the
 * prompt cache served is known for all of it but what `known` leaves out.
 */
export function tokensByRole(state: State, harnessDir: string): RoleTokens[] {
  const roles: Record<TokenRole, RoleTokens> = {
    Developers: { role: 'Developers', read: 0, cacheRead: 0, known: 0, written: 0 },
    Managers: { role: 'Managers', read: 0, cacheRead: 0, known: 0, written: 0 },
    Architects: { role: 'Architects', read: 0, cacheRead: 0, known: 0, written: 0 },
    Reviewers: { role: 'Reviewers', read: 0, cacheRead: 0, known: 0, written: 0 },
  };
  const session = (role: TokenRole, usage: Usage | undefined, stream: string) => {
    if (!usage) return;
    const tokens = roles[role];
    tokens.read += usage.inputTokens;
    tokens.written += usage.outputTokens;
    const cache = usage.cacheReadTokens ?? cacheReadsOf(stream, usage);
    if (cache === null) return;
    tokens.cacheRead += cache;
    tokens.known += usage.inputTokens;
  };
  const modules = join(harnessDir, 'modules');
  for (const feature of Object.values(state.features)) {
    for (const attempt of feature.attempts) {
      session('Developers', attempt.usage, join(modules, feature.module, 'attempts', `${feature.plan}-${feature.feature}-a${attempt.n}`, 'stream.jsonl'));
    }
  }
  for (const plan of Object.values(state.plans)) {
    for (const review of plan.reviews ?? []) {
      session('Reviewers', review.usage, join(modules, plan.module, 'reviews', `${plan.plan}-${review.role}-${review.head.slice(0, 8)}`, 'stream.jsonl'));
    }
  }
  for (const [agent, { total }] of Object.entries(state.agentTokens ?? {})) {
    const tokens = roles[agent.startsWith('manager:') ? 'Managers' : agent.startsWith('architect:') ? 'Architects' : 'Developers'];
    tokens.read += total.inputTokens;
    tokens.written += total.outputTokens;
    tokens.cacheRead += total.cacheReadTokens ?? 0;
    tokens.known += total.splitInputTokens ?? 0;
  }
  return Object.values(roles);
}
