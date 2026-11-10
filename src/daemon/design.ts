import { archMayChange, computeLock, protectionRules, type Lock } from '../ci/harness-ci.ts';
import { moduleOwnerTime, ownerTimeProblems } from '../design/owner-time.ts';
import { checkScripts, definitionHash, featureDependency, loadDesign, scriptsOf, type Feature, type ModuleDesign } from '../design/schemas.ts';
import { HARNESS } from '../git/repo.ts';
import type { LockedChange, ModuleState } from '../state/state.ts';
import { canonicalJson, clip } from '../util.ts';
import type { Orchestrator } from './orchestrator.ts';
import { preMerge, sandboxName } from './refs.ts';

/** Where the daemon keeps the Architect's latest submitted commit. */
export const architectRef = (module: string) => `refs/architect/${module}`;

/** Where it keeps the Architect's latest change to locked files (v5). */
export const lockedRef = (module: string) => `refs/architect-locked/${module}`;

/** A plan is built once it is past `active`: its features are locked (v5). */
const isBuilt = (o: Orchestrator, module: string, plan: string): boolean => {
  const status = o.state.plans[`${module}/${plan}`]?.status;
  return status !== undefined && status !== 'active';
};

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

  // Judged by the rules it starts from, as CI judges it: a design can't widen the protected set to change application code with it.
  const rules = await protectionRules(o.repo.treeReader(base));
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
  // A feature is locked with its plan once the plan is past its build (v5): its definition changes only in a
  // CHANGED_LOCKED_FILES PR, and new behavior comes in a new plan, whose feature supersedes it.
  const previous = await loadDesign(o.repo, base).catch(() => undefined);
  for (const plan of previous?.modules.find((m) => m.id === module.module)?.plans ?? []) {
    const status = o.state.plans[`${module.module}/${plan.id}`]?.status;
    if (status === undefined || status === 'active' || !mine) continue;
    const now = mine.plans.find((p) => p.id === plan.id);
    for (const feature of plan.features) {
      const after = now?.features.find((f) => f.id === feature.id);
      if (!after || definitionHash(after) !== definitionHash(feature)) {
        problems.push(`${plan.id}/${feature.id}: plan ${plan.id} is past its build (${status.replaceAll('_', ' ')}), so this feature is locked. Fix a wrong definition with submit_locked_change, a CHANGED_LOCKED_FILES PR of its own; for new behavior, add a plan whose feature supersedes ${plan.id}/${feature.id}`);
      }
    }
  }
  // A feature supersedes a built one: one still to build is simply changed.
  for (const plan of mine?.plans ?? []) {
    for (const feature of plan.features) {
      for (const ref of feature.supersedes) {
        const target = featureDependency(plan.id, ref);
        if (!isBuilt(o, module.module, target.plan)) problems.push(`${plan.id}/${feature.id}: it supersedes ${ref}, whose plan isn't built: change ${ref} instead`);
      }
    }
  }
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
  // Once the owner budgets their time, every owner action is estimated, and the module fits what is available (v3 §4.1).
  if (mine) problems.push(...ownerTimeProblems(await o.ownerTime(), moduleOwnerTime(mine, o.state)));
  if (problems.length > 0 || !mine) return { ok: false, problems };

  // The new checks, run once on the repository as it is: nothing is built yet, so they should fail.
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
    // The module's first design, or a change to it once merged: the one that froze the module is told apart (v5).
    title: `Arch: [${module.frozenCommit ? 'DESIGN_MODIFY' : 'DESIGN'}] [${module.module}] ${clip(summary.split('\n')[0]!, 70)}`,
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

export type LockedOutcome =
  | { ok: true; head: string; pr: { number: number; url: string }; opened: boolean; changes: LockedChange[] }
  | { ok: false; problems: string[] };

/** A feature's spec: what changes in these fields is what a reviewer of a locked change reads first. */
const SPEC_FIELDS = ['title', 'kind', 'description', 'expected', 'dependsOn', 'supersedes', 'gates', 'resources'] as const;

/**
 * Turns a submitted change to built features' definitions into a CHANGED_LOCKED_FILES PR
 * (v5). It changes nothing else: only features of built plans, in their plan files, and
 * the scripts in the module's folder that their checks run, never a plan's own fields, nor
 * a feature added, removed or moved. Every changed feature's pre-merge checks pass on the change as it is, as they
 * must for work already built. Then the protected files are hashed, as for a design, and
 * `locked/<module>` is pushed with its PR, which the owner alone merges.
 */
export async function submitLockedChange(o: Orchestrator, module: ModuleState, summary: string, submitted: string): Promise<LockedOutcome> {
  if (!module.frozenCommit) return { ok: false, problems: ['nothing is locked yet: the owner merges the first design before any feature is built'] };
  const main = (await o.repo.revParse('refs/heads/main'))!;
  // Judged on main as it is: the built work, which the checks run on, is there.
  let head = submitted;
  if (!(await o.repo.isAncestor(main, submitted))) {
    const merged = await o.repo.merge({ ours: submitted, theirs: main, message: `Merge main into the change to ${module.module}'s locked files\n`, committer: HARNESS });
    if ('conflicts' in merged) return { ok: false, problems: [`it conflicts with main in ${merged.conflicts.join(', ')}: start the branch from main again (git switch -C locked main) and submit again`] };
    head = merged.commit;
  }
  // The checks run from this ref: what is judged, merged with main if it had to be.
  await o.repo.setRef(lockedRef(module.module), head);
  const base = main;
  const problems: string[] = [];
  const load = async (ref: string) => (await loadDesign(o.repo, ref)).modules.find((m) => m.id === module.module);
  const before = await load(base).catch(() => undefined);
  let after: ModuleDesign | undefined;
  try {
    after = await load(head);
  } catch (error) {
    problems.push((error as Error).message);
  }
  if (!before || !after) return { ok: false, problems: problems.length > 0 ? problems : [`there is no design of ${module.module} to change`] };

  // Only the module's plan files, and the scripts in its folder that its checks run on either side: another
  // module's script would redefine that module's features too.
  const own = `harness/modules/${module.module}/`;
  const runs = new Set([before, after].flatMap((design) => design.plans.flatMap((p) => p.features.flatMap((f) => f.checks.flatMap(checkScripts)))));
  for (const path of await o.repo.changedFiles(base, head)) {
    if (path === 'harness/lock.json' || (runs.has(path) && path.startsWith(own))) continue;
    if (!(path.startsWith(`${own}plans/`) && path.endsWith('.json'))) {
      problems.push(`${path}: a change to locked files changes only built features' definitions and the scripts in ${own} that their checks run; anything else goes through submit_design`);
    }
  }
  if (before.plans.map((p) => p.id).join('\n') !== after.plans.map((p) => p.id).join('\n')) {
    problems.push('a change to locked files neither adds nor removes a plan: that goes through submit_design');
  }
  const changes: LockedChange[] = [];
  for (const plan of after.plans) {
    const was = before.plans.find((p) => p.id === plan.id);
    if (!was) continue;
    const { features: oldFeatures, ...oldPlan } = was;
    const { features: newFeatures, ...newPlan } = plan;
    if (canonicalJson(oldPlan) !== canonicalJson(newPlan)) problems.push(`${plan.id}: the plan's own fields changed; a change to locked files changes features only`);
    if (oldFeatures.map((f) => f.id).join('\n') !== newFeatures.map((f) => f.id).join('\n')) {
      problems.push(`${plan.id}: features were added, removed, renamed or moved; a change to locked files keeps them as they are`);
      continue;
    }
    for (const feature of newFeatures) {
      const old = oldFeatures.find((f) => f.id === feature.id)!;
      if (definitionHash(old) === definitionHash(feature)) continue;
      // A script shared with a feature still to build would redefine it too: that is a design change.
      if (!isBuilt(o, module.module, plan.id)) {
        problems.push(`${plan.id}/${feature.id}: plan ${plan.id} isn't built, so this feature isn't locked: change it with submit_design`);
        continue;
      }
      changes.push(describe(plan.id, old, feature));
    }
  }
  if (problems.length === 0 && changes.length === 0) problems.push("no built feature's definition changes: there is nothing locked to submit");
  if (problems.length > 0) return { ok: false, problems };

  // Work already built: every changed feature's pre-merge checks pass on the change as it is.
  const checks = changes.flatMap((c) => preMerge(after.plans.find((p) => p.id === c.plan)!.features.find((f) => f.id === c.feature)!.checks));
  if (checks.length > 0) {
    const results = await o.runChecksIn(sandboxName('chk', o.design.config.project.name, module.module, 'locked'), lockedRef(module.module), o.moduleDir(module.module), checks);
    const failed = results.filter((r) => r.exit !== 0);
    if (failed.length > 0) {
      return { ok: false, problems: failed.map((r) => `${r.id} fails on the change, though its feature is built: it must pass\n${clip(r.output.trim(), 1500)}`) };
    }
  }

  const tree = o.repo.treeReader(head);
  const lock = await computeLock(tree);
  const lockText = `${JSON.stringify(lock, null, 2)}\n`;
  const branchHead = (await tree.read('harness/lock.json')) === lockText ? head : await o.repo.commitTree({
    parent: head,
    tree: head,
    files: { 'harness/lock.json': lockText },
    message: `chore(harness): hash the protected files of the change to ${module.module}'s locked files\n`,
    author: HARNESS,
    committer: HARNESS,
  });
  const branch = `locked/${module.module}`;
  await o.repo.setRef(`refs/heads/${branch}`, branchHead);
  try {
    await o.forge.push(o.repo, branch);
  } catch (error) {
    return { ok: false, problems: [`the branch couldn't be pushed; build on the change already under review (${(error as Error).message.split('\n')[0]})`] };
  }
  const existing = await o.forge.findPullRequest(branch, { open: true });
  const pr = existing ?? (await o.forge.openPullRequest({
    branch,
    title: `Arch: [CHANGED_LOCKED_FILES] [${module.module}] ${clip(summary.split('\n')[0]!, 70)}`,
    body: await lockedBody(o, module, summary, changes, base, lock),
  }));
  return { ok: true, head: branchHead, pr, opened: !existing, changes };
}

/** What a locked change does to one feature: its spec's fields, its checks, and their scripts that change. */
function describe(plan: string, old: Feature, now: Feature): LockedChange {
  const fields = SPEC_FIELDS.filter((key) => canonicalJson(old[key]) !== canonicalJson(now[key]));
  const before = scriptsOf(old);
  const after = scriptsOf(now);
  const scripts = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((path) => before[path] !== after[path]).sort();
  const ids = [...new Set([...old.checks, ...now.checks].map((c) => c.id))];
  const checks = ids.filter((id) => {
    const a = old.checks.find((c) => c.id === id);
    const b = now.checks.find((c) => c.id === id);
    if (!a || !b) return true;
    return canonicalJson(a) !== canonicalJson(b) || checkScripts(b).some((path) => scripts.includes(path));
  }).map((id) => (!old.checks.some((c) => c.id === id) ? `${id} (added)` : !now.checks.some((c) => c.id === id) ? `${id} (removed)` : id));
  return { plan, feature: now.id, title: now.title, expected: now.expected, fields, checks, scripts };
}

async function lockedBody(o: Orchestrator, module: ModuleState, summary: string, changes: LockedChange[], base: string, lock: Lock): Promise<string> {
  const before = await computeLock(o.repo.treeReader(base));
  const old = new Set(before.entries.map((e) => JSON.stringify(e)));
  const changed = [...new Set(lock.entries.filter((e) => !old.has(JSON.stringify(e))).map((e) => e.path))];
  return [
    summary,
    '',
    '> [!CAUTION]',
    '> Changing locked files can make a broken feature look like it works: a check that proves less turns red into green without fixing anything. Merge only if each changed check still proves its feature\'s expected result.',
    '> A locked change rebuilds nothing: if a feature must work differently, ask the Architect for a new plan.',
    '',
    '## Built features it changes',
    '',
    ...changes.flatMap((c) => [
      `- **${c.plan}/${c.feature}** ${c.title}`,
      `  - Expected: ${c.expected}`,
      ...(c.fields.length > 0 ? [`  - Spec fields: ${c.fields.join(', ')}`] : []),
      ...(c.checks.length > 0 ? [`  - Checks: ${c.checks.join(', ')}`] : []),
      ...(c.scripts.length > 0 ? [`  - Scripts: ${c.scripts.map((s) => `\`${s}\``).join(', ')}`] : []),
    ]),
    '',
    '## Protected changes',
    '',
    ...(changed.length > 0 ? changed.map((p) => `- \`${p}\``) : ['None.']),
    '',
    'Merge with a merge commit.',
    '',
    `<!-- harness: locked ${module.module} -->`,
  ].join('\n');
}
