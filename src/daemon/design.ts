import { archMayChange, computeLock, protectionRules, type Lock } from '../ci/harness-ci.ts';
import { checkScripts, definitionHash, loadDesign, type ModuleDesign } from '../design/schemas.ts';
import { HARNESS } from '../git/repo.ts';
import type { ModuleState } from '../state/state.ts';
import { clip } from '../util.ts';
import type { Orchestrator } from './orchestrator.ts';
import { preMerge, sandboxName } from './refs.ts';

/** Where the daemon keeps the Architect's latest submitted commit. */
export const architectRef = (module: string) => `refs/architect/${module}`;

export type DesignOutcome =
  | { ok: true; head: string; suspect: string[]; pr: { number: number; url: string }; opened: boolean }
  | { ok: false; problems: string[] };

/**
 * Turns a submitted design into an Arch PR (§7.1 step 4): validates it, runs its new
 * checks once on the unbuilt repository, hashes the protected files into
 * `harness/lock.json` in a commit of the daemon's own, pushes `arch/<module>`, and opens
 * the PR, or finds the one already open.
 */
export async function submitDesign(o: Orchestrator, module: ModuleState, summary: string, head: string): Promise<DesignOutcome> {
  const main = (await o.repo.revParse('refs/heads/main'))!;
  const base = await o.repo.mergeBase(main, head);
  const tree = o.repo.treeReader(head);
  const changed = await o.repo.changedFiles(base, head);
  const problems: string[] = [];

  const rules = await protectionRules(tree);
  for (const path of changed) {
    if (!archMayChange(path, rules)) problems.push(`${path}: a design may change only harness/, shared knowledge, agents' instructions and tool configs`);
    else if (path.startsWith('harness/modules/') && !path.startsWith(`harness/modules/${module.module}/`)) {
      problems.push(`${path}: that is another module's design`);
    }
  }
  let mine: ModuleDesign | undefined;
  try {
    mine = (await loadDesign(o.repo, head)).modules.find((m) => m.id === module.module);
  } catch (error) {
    problems.push((error as Error).message);
  }
  if (mine && mine.plans.length === 0) problems.push(`there is no plan: write harness/modules/${module.module}/plans/P1.json`);
  if (!mine && problems.length === 0) problems.push(`there is no design for ${module.module}: write harness/modules/${module.module}/plans/P1.json`);
  for (const plan of mine?.plans ?? []) {
    for (const feature of plan.features) {
      for (const check of feature.checks) {
        const scripts: string[] = [];
        for (const file of checkScripts(check)) {
          const script = await tree.read(file);
          if (script === undefined) problems.push(`${plan.id}/${feature.id}: check ${check.id} runs ${file}, which isn't in the design`);
          else scripts.push(script);
        }
        // Checks run in sandboxes and in CI: the repository isn't always at /sandbox/work.
        if ([check.run, ...scripts].some((text) => text.includes('/sandbox/'))) {
          problems.push(`${plan.id}/${feature.id}: check ${check.id} uses a /sandbox/ path, which only harness sandboxes have; CI runs the repository elsewhere. Use paths from the repository root (save ROOT="$PWD" before you cd).`);
        }
      }
    }
  }
  if (problems.length > 0 || !mine) return { ok: false, problems };

  // The new checks, run once on the repository as it is: nothing is built yet, so they should fail.
  const previous = await loadDesign(o.repo, base).catch(() => undefined);
  const known = new Set(previous?.modules.flatMap((m) => m.plans.flatMap((p) => p.features.map((f) => `${m.id}/${p.id}/${f.id}:${definitionHash(f)}`))) ?? []);
  const fresh = mine.plans.flatMap((p) => p.features.filter((f) => !known.has(`${module.module}/${p.id}/${f.id}:${definitionHash(f)}`)).flatMap((f) => preMerge(f.checks)));
  const results = fresh.length === 0 ? [] : await o.runChecksIn(
    sandboxName('chk', o.design.config.project.name, module.module, 'design'),
    architectRef(module.module),
    o.moduleDir(module.module),
    fresh,
  );
  const init = results.find((r) => r.id === 'init.sh');
  if (init && init.exit !== 0) return { ok: false, problems: [`init.sh fails on the repository as it is:\n${clip(init.output.trim(), 1500)}`] };
  const suspect = results.filter((r) => r.exit === 0).map((r) => r.id);

  // The hash list, as the daemon computes it: no agent writes it (§8.7).
  const lock = await computeLock(tree);
  const lockText = `${JSON.stringify(lock, null, 2)}\n`;
  const branchHead = (await tree.read('harness/lock.json')) === lockText ? head : await o.repo.commitTree({
    parent: head,
    tree: head,
    files: { 'harness/lock.json': lockText },
    message: `chore(harness): hash the protected files of the ${module.module} design\n`,
    author: HARNESS,
    committer: HARNESS,
  });
  const branch = `arch/${module.module}`;
  await o.repo.setRef(`refs/heads/${branch}`, branchHead);
  try {
    await o.forge.push(o.repo, branch);
  } catch (error) {
    return { ok: false, problems: [`the branch couldn't be pushed; build on the design already under review (${(error as Error).message.split('\n')[0]})`] };
  }

  const existing = await o.forge.findPullRequest(branch, { open: true });
  const pr = existing ?? (await o.forge.openPullRequest({
    branch,
    title: `Arch: ${module.module} — ${clip(summary.split('\n')[0]!, 70)}`,
    body: await prBody(o, module, mine, summary, suspect, base, lock),
  }));
  return { ok: true, head: branchHead, suspect, pr, opened: !existing };
}

async function prBody(o: Orchestrator, module: ModuleState, design: ModuleDesign, summary: string, suspect: string[], base: string, lock: Lock): Promise<string> {
  const before = await computeLock(o.repo.treeReader(base));
  const key = (e: Lock['entries'][number]) => JSON.stringify(e);
  const old = new Set(before.entries.map(key));
  const changed = lock.entries.filter((e) => !old.has(key(e))).map((e) => e.path);
  const plans = design.plans.map((p) => `- **${p.id}** ${p.title}: ${p.features.map((f) => `${f.id} ${f.title}`).join('; ')}`);
  const actions = design.actions.map((a) => `- **${a.id}** (${a.kind}) ${a.title}`);
  return [
    summary,
    '',
    `Proposal v${module.accepted ?? '?'}, accepted by the owner.`,
    '',
    '## Plans',
    '',
    ...plans,
    ...(actions.length ? ['', '## Owner actions', '', ...actions] : []),
    '',
    '## Protected changes',
    '',
    ...(changed.length ? [...new Set(changed)].map((p) => `- \`${p}\``) : ['None.']),
    '',
    suspect.length
      ? `**Suspect checks:** ${suspect.join(', ')} already pass on the unbuilt repository. They may be too weak.`
      : 'Every new check failed on the unbuilt repository, as it should.',
    '',
    'Merge with a merge commit.',
    '',
    `<!-- harness: design ${module.module} -->`,
  ].join('\n');
}
