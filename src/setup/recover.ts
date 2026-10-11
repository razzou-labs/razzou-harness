import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isAlive, readDaemonInfo } from '../daemon/main.ts';
import { makeForge } from '../daemon/orchestrator.ts';
import { loadDesign } from '../design/schemas.ts';
import { Repo } from '../git/repo.ts';
import type { Forge } from '../github/forge.ts';
import { EventStore } from '../state/events.ts';
import type { ActionState, FeatureState, PlanState } from '../state/state.ts';

export interface RecoverOptions {
  projectDir: string;
  harnessDir: string;
  /** A stand-in for GitHub, in tests. */
  forge?: Forge;
  now?: () => number;
}

/**
 * Rebuilds `.harness/` after it was lost (§15.2), from what outlives it: the designs and
 * `progress.txt` on main, and the plans' pull requests and branches on GitHub. The result
 * is one RECOVERED event, the first of a new log. Whatever lived only in `.harness/` is
 * gone: attempts under way, sessions, unanswered questions, unpushed plan branches.
 */
export async function recover(options: RecoverOptions): Promise<string[]> {
  const daemon = readDaemonInfo(options.harnessDir);
  if (daemon && isAlive(daemon.pid)) throw new Error(`a daemon runs for this project (pid ${daemon.pid}): stop it with \`harness down\` first`);
  const log = join(options.harnessDir, 'events.jsonl');
  if (existsSync(log) && statSync(log).size > 0) {
    throw new Error(`${log} exists, so there is nothing to recover. If it is damaged, move .harness away first.`);
  }
  const at = new Date((options.now ?? Date.now)()).toISOString();
  const repo = await Repo.open(join(options.harnessDir, 'git', 'repo.git'));
  const main = await repo.fetchMain(options.projectDir);
  const design = await loadDesign(repo, 'refs/heads/main');
  const forge = options.forge ?? makeForge(design.config, options.projectDir);
  const onMain = progress(await repo.show('refs/heads/main', 'progress.txt'));
  const plans: Record<string, PlanState> = {};
  const features: Record<string, FeatureState> = {};
  const notes: string[] = [];
  const accept = (module: string, plan: string, feature: string) => {
    features[`${module}/${plan}/${feature}`] = { module, plan, feature, status: 'accepted', attempts: [], extraAttempts: 0 };
  };

  for (const module of design.modules) {
    for (const plan of module.plans) {
      const key = `${module.id}/${plan.id}`;
      const branch = `plan/${key}`;
      const found = await forge.findPullRequest(branch);
      const pr = found ? await forge.pullRequest(found.number) : undefined;
      if (pr?.merged || (!pr && plan.features.every((f) => onMain.features.has(`${key}/${f.id}`)))) {
        for (const feature of plan.features) accept(module.id, plan.id, feature.id);
        plans[key] = {
          module: module.id, plan: plan.id, status: 'completed', branch, base: main, head: pr?.mergeCommit ?? main,
          ...(pr ? { pr: { number: pr.number, url: pr.url } } : {}),
        };
        notes.push(`${key}: completed${pr ? `, PR #${pr.number} merged` : ''}`);
      } else if (pr?.state === 'open') {
        const head = await forge.fetchBranch(repo, branch);
        if (!head) {
          notes.push(`${key}: PR #${pr.number} is open, but its branch couldn't be fetched. Close the PR and delete the branch, and the plan starts again.`);
          continue;
        }
        const onBranch = progress(await repo.show(`refs/heads/${branch}`, 'progress.txt'));
        for (const feature of plan.features.filter((f) => onBranch.features.has(`${key}/${f.id}`))) accept(module.id, plan.id, feature.id);
        for (const gate of onBranch.gates) onMain.gates.add(gate);
        plans[key] = {
          module: module.id, plan: plan.id, status: 'pr_open', branch, base: await repo.mergeBase('refs/heads/main', head), head, pushed: head,
          pr: { number: pr.number, url: pr.url }, ci: { sha: head, status: 'pending', since: at },
        };
        notes.push(`${key}: PR #${pr.number} is open; its CI is read again`);
      } else if (pr) {
        notes.push(`${key}: PR #${pr.number} was closed without being merged. Delete its branch on GitHub, and the plan starts again.`);
      }
    }
  }
  const actions: Record<string, ActionState> = {};
  for (const gate of onMain.gates) actions[gate] = { status: 'done', at, note: 'recovered from progress.txt' };
  if (onMain.gates.size > 0) notes.push(`gates satisfied: ${[...onMain.gates].join(', ')}`);
  notes.push('Not recovered: attempts under way, the Architects\' and Managers\' sessions, unanswered questions, plan branches that were never pushed, and deploys a merge started.');
  new EventStore(log).append({ type: 'RECOVERED', payload: { plans, features, actions, notes } });
  return notes;
}

/** The accepted features and satisfied gates that a progress.txt records (§8.5). */
function progress(text: string | undefined): { features: Set<string>; gates: Set<string> } {
  const features = new Set<string>();
  const gates = new Set<string>();
  for (const line of (text ?? '').split('\n')) {
    const feature = / feature\.accepted (\S+)/.exec(line)?.[1];
    if (feature) features.add(feature);
    const gate = / gate\.satisfied (\S+)/.exec(line)?.[1];
    if (gate) gates.add(gate);
  }
  return { features, gates };
}
