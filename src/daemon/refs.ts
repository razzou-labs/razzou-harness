import type { Check } from '../design/schemas.ts';
import type { Ref } from '../state/events.ts';
import type { Attempt, FeatureState } from '../state/state.ts';
import { resolve } from 'node:path';
import { sh, sha256 } from '../util.ts';

/** What tells one checkout of a project from any other on this machine: a hash of its folder's path. */
export const checkoutId = (projectDir: string): string => sha256(resolve(projectDir)).slice(0, 8);

/**
 * A project as its sandboxes and its providers on the gateway name it: its name, and the
 * checkout it is. Names alone collide: two folders called `api`, or two clones of one
 * repository, would share sandbox names and the keys of their APIs.
 */
export const projectKey = (projectDir: string, name: string): string => `${name}-${checkoutId(projectDir)}`;

/**
 * OpenShell names a sandbox with a DNS label of at most 19 characters, so the name is a
 * hash of what the sandbox works on, like `dev-1a2b3c4d-a1`. The hash includes the
 * project because several projects can share one gateway.
 */
export function sandboxName(kind: 'dev' | 'chk' | 'mgr' | 'arc' | 'rev', project: string, key: string, suffix?: string): string {
  return `${kind}-${sha256(`${project}/${key}`).slice(0, 8)}${suffix ? `-${suffix}` : ''}`;
}

/** Where an attempt's commits are kept in the daemon's repository. */
export const attemptRefName = (ref: Ref) => `refs/attempts/${ref.module}/${ref.plan}/${ref.feature}/a${ref.attempt}`;

export const refOf = (state: FeatureState, attempt: Attempt): Ref => ({ module: state.module, plan: state.plan, feature: state.feature, attempt: attempt.n });

export const preMerge = (checks: Check[]) => checks.filter((c) => c.phase === 'pre-merge');

/**
 * Prints a detached agent's exit code, "running", or "gone" if it died without one. The
 * exit file is read again after the process check: an agent that ends between the two
 * reads isn't "gone".
 */
export function probeScript(exitFile: string, pidFile: string): string {
  return `cat ${sh(exitFile)} 2>/dev/null || { kill -0 "$(cat ${sh(pidFile)} 2>/dev/null)" 2>/dev/null && echo running; } || cat ${sh(exitFile)} 2>/dev/null || echo gone`;
}

/** A script line that waits up to 10 s for a file, such as a pid file written by a detached process. */
export function waitForFile(file: string): string {
  return `for i in $(seq 1 100); do test -s ${sh(file)} && exit 0; sleep 0.1; done; echo 'nothing in ${file} after 10 s' >&2; exit 1`;
}

/**
 * The largest bundle of commits taken out of a sandbox. What an attempt or a design
 * commits is source: anything larger is data or a mistake, which would fill the daemon's
 * disk and which GitHub would refuse.
 */
export const BUNDLE_BYTES = 512 * 1024 * 1024;
