import type { CheckResult } from '../checks/runner.ts';
import { definitionHash, planDependencies } from '../design/schemas.ts';
import type { Ref } from '../state/events.ts';
import { countedAttempts, featureKey, managerKey, planKey, type Attempt, type FeatureState, type ManagerState, type PlanState } from '../state/state.ts';
import { clip, tail } from '../util.ts';
import type { Orchestrator } from './orchestrator.ts';
import { attemptRefName, refOf } from './refs.ts';

/**
 * Something that waits for the Manager's decision (proposal v2 §9.5). Items are derived
 * from the state on every pass, so one is pending exactly as long as the state says so.
 */
export interface Item {
  key: string;
  /** For reminders and pauses, like "the review of shop/P1/F02 attempt 1". */
  title: string;
  /** What the Manager is expected to call. */
  ask: string;
  /** What the Manager is shown, in a folder of its clone: an attempt's commits, or else the branch's head; with `main`, main comes along as `harness/main`. */
  show?: Show;
  text: () => Promise<string>;
}

export interface Show {
  attempt?: Ref;
  branch: string;
  main?: boolean;
}

/** The folder of a Manager's clone that holds what its items show, each in a folder of its own. */
export const SHOWN_DIR = 'harness-shown';

/**
 * What an item shows, resolved: the commit, and the folder of the Manager's clone that
 * holds it. The folder is the item's alone and never moves, where the top of the clone
 * follows the latest item: several wait at once, and a review read from the top could be
 * of another attempt's files.
 */
export async function shown(o: Orchestrator, show: Show): Promise<{ commit: string; dir: string } | undefined> {
  const attempt = show.attempt ? await o.repo.revParse(attemptRefName(show.attempt)) : undefined;
  const commit = attempt ?? (await o.repo.revParse(`refs/heads/${show.branch}`));
  if (!commit) return undefined;
  const label = attempt && show.attempt ? `${show.attempt.plan}-${show.attempt.feature}-a${show.attempt.attempt}` : show.branch.replace(/[^A-Za-z0-9._-]+/g, '-');
  return { commit, dir: `${SHOWN_DIR}/${label}-${commit.slice(0, 8)}` };
}

/** "`harness-shown/…/` of your clone", or the top of the clone when the commit is gone. */
async function folder(o: Orchestrator, show: Show): Promise<string> {
  const at = await shown(o, show);
  return at ? `\`${at.dir}/\` of your clone` : 'your clone';
}

/**
 * What waits for a Manager: the items of its module. A plan's Manager, which Swarm
 * started before 0.6.0 and which keeps its plan until that is complete, gets its plan's
 * alone, and the module's Manager leaves that plan to it: no item is delivered twice.
 */
export function pendingItems(o: Orchestrator, scope: { module: string; plan?: string | undefined }): Item[] {
  const { module, plan: only } = scope;
  const mine = (plan: string) => (only !== undefined ? plan === only : !hasOwnManager(o, module, plan));
  const questions: Item[] = [];
  const others: Item[] = [];
  for (const feature of Object.values(o.state.features).filter((f) => f.module === module && mine(f.plan))) {
    const last = feature.attempts.at(-1);
    // A feature a design change dropped waits for nobody: an attempt under way stops (v3 §6.6).
    if (!last || !o.featureDefinition(feature)) continue;
    if (last.status === 'running') {
      for (const question of (last.questions ?? []).filter((q) => q.answer === undefined)) {
        questions.push(questionItem(feature, last, question.requestId, question.text));
      }
    }
    if (last.status === 'reviewing' && !last.decision) others.push(reviewItem(o, feature, last));
    if (feature.awaitingGuidanceSince && feature.status !== 'escalated' && attemptsLeft(o, feature) > 0) {
      others.push(failureItem(o, feature, last));
    }
    // Out of attempts: the Manager takes it to the Architect, once, and the owner isn't asked first.
    if (outOfAttempts(o, feature) && !takenToArchitect(o, feature)) others.push(exhaustedItem(o, feature, last));
  }
  const rounds = o.design.config.brakes.ciFixRounds;
  const deployRounds = o.design.config.brakes.deployFixRounds;
  for (const plan of Object.values(o.state.plans).filter((p) => p.module === module && mine(p.plan))) {
    if ((plan.status === 'deploy_failed' || plan.status === 'verify_failed') && (plan.deployFixRounds ?? 0) < deployRounds) {
      const key = planKey(plan);
      const what = plan.status === 'deploy_failed' ? 'DEPLOY FAILED' : 'POST-DEPLOY CHECKS FAILED';
      const show: Show = { branch: 'main' };
      others.push({
        key: `${plan.status}:${key}@${plan.mergeCommit}`,
        title: `the failed deploy of ${key}`,
        ask: `Call request_fix(plan: "${key}", guidance) to start a Fix PR, or ask_owner if it can't be fixed in code.`,
        show,
        text: async () => [
          `[harness] ${what} ${key} (merged as ${short(plan.mergeCommit)}, ${plan.deployFixRounds ?? 0} of ${deployRounds} Fix PRs used)`,
          '',
          deployReport(plan),
          '',
          `Main is checked out in ${await folder(o, show)}. Diagnose the failure, then call`,
          `request_fix(plan: "${key}", guidance): a Developer fixes it on a new fix branch, you review the fix, and its pull request goes through CI and ${fixPrMerge(o)}. If a check is wrong while the deploy is right, that is the Architect's: escalate_to_architect. If the cause is outside the code and the design (a missing permission, a quota, an account setting), use ask_owner.`,
        ].join('\n'),
      });
    }
    // Main no longer merges into the branch (v3 §6.6): the Manager says how the files must come out, and a merge round starts.
    if (plan.mainConflict && CONFLICT_STATUSES.includes(plan.status)) others.push(conflictItem(o, plan));
    // Accepted work fails its checks on the branch, twice: the Manager says what breaks, and a fix round starts.
    if (checksFail(plan)) others.push(checksItem(o, plan));
    if (plan.status === 'pr_open' && plan.ci?.status === 'failed' && (plan.fixRounds ?? 0) < rounds) {
      const key = planKey(plan);
      const show: Show = { branch: plan.branch };
      others.push({
        key: `ci:${key}@${plan.ci.sha}`,
        title: `the failed CI of ${key}`,
        ask: `Call request_fix(plan: "${key}", guidance), or ask_owner if it can't be fixed in code.`,
        show,
        text: async () => [
          `[harness] CI FAILED ${key} (PR #${plan.pr?.number}, ${plan.fixRounds ?? 0} of ${rounds} fix rounds used)`,
          '',
          ciReport(plan),
          '',
          `The plan branch is checked out in ${await folder(o, show)}. Diagnose the failure from the code and the logs, then call`,
          `request_fix(plan: "${key}", guidance) with what fails, why, and where to fix it: a Developer then fixes it on the plan branch, and CI runs again. If the cause isn't in the code (CI setup, a secret, a flaky runner), use ask_owner instead.`,
        ].join('\n'),
      });
    }
    if (plan.status === 'validating' && plan.validation?.status === 'passed' && plan.summary === undefined) {
      const key = planKey(plan);
      others.push({
        key: `plan:${key}`,
        title: `the submission of plan ${key}`,
        ask: `Call submit_plan(plan: "${key}", summary).`,
        text: async () => [
          `[harness] PLAN READY ${key}`,
          '',
          `Every feature of ${key} is accepted, and the full check run passed on the plan branch (${short(plan.head)}):`,
          '',
          ...checkLines(plan.validation?.results ?? []),
          '',
          `Call submit_plan(plan: "${key}", summary) with a summary for its pull request: what the plan delivers, how it was verified, and anything the owner should look at.`,
        ].join('\n'),
      });
    }
  }
  return [...questions, ...others];
}

/** Where a plan stands when a conflict with main can go to its Manager: being built, or with its pull request open. */
export const CONFLICT_STATUSES: PlanState['status'][] = ['active', 'pr_open', 'ready_to_merge'];

/**
 * The work accepted on a plan's branch failed its checks twice on the commit the branch
 * is at, while the plan is built: its Manager has it fixed, and nothing new starts in it.
 */
export const checksFail = (plan: PlanState): boolean =>
  plan.status === 'active' && plan.validation?.status === 'failed' && plan.validation.head === plan.head && (plan.validation.runs ?? 0) >= 2;

/** What fails on a plan's branch, with the end of each failing check's output. */
export function checksReport(plan: PlanState): string {
  const failing = (plan.validation?.results ?? []).filter((r) => r.exit !== 0);
  return [
    `The work accepted on ${plan.branch} no longer passes its checks there, at ${short(plan.head)}. The daemon ran them twice; the second time:`,
    ...checkLines(failing, true),
  ].join('\n');
}

function checksItem(o: Orchestrator, plan: PlanState): Item {
  const key = planKey(plan);
  const show: Show = { branch: plan.branch };
  return {
    key: `checks:${key}@${plan.head}`,
    title: `the failing checks of ${key}`,
    ask: `Call request_fix(plan: "${key}", guidance), or escalate_to_architect if a check is wrong, or ask_owner if the cause is outside the code.`,
    show,
    text: async () => [
      `[harness] PLAN CHECKS FAILED ${key}`,
      '',
      checksReport(plan),
      '',
      `Nothing new starts in this plan until they pass again; its attempts under way finish, and the module's other plans go on. The branch is checked out in ${await folder(o, show)}, and \`git log --oneline -8 ${short(plan.head)}\` shows what reached it last: a feature landed beside another, or main merged in.`,
      '',
      `Find the cause, then call request_fix(plan: "${key}", guidance) with what breaks, why, and where to fix it: a Developer fixes it on the plan branch, every check of accepted work runs on the result, and you review the fix like a feature. If a check itself is wrong, or two features ask for contradictory things, that is the design's: escalate_to_architect, and the checks run again once its change reaches the branch. If the cause is outside the code and the design, such as a registry that doesn't answer or a host the sandbox can't reach, use ask_owner: the checks run again once the owner answers.`,
    ].join('\n'),
  };
}

/** A feature that used up its attempts, in a module with an Architect: the Manager takes it there before the owner hears of it. */
export const outOfAttempts = (o: Orchestrator, feature: FeatureState): boolean =>
  feature.status === 'escalated' && o.state.modules[feature.module] !== undefined;

/** Since when a feature is escalated; one escalated before 0.6.0 has only its last attempt's end. */
const escalatedSince = (feature: FeatureState): string => feature.escalatedAt ?? feature.attempts.at(-1)?.endedAt ?? feature.attempts.at(-1)?.startedAt ?? '';

/** The Manager's escalations about a feature since it ran out of attempts, oldest first. */
function escalationsAbout(o: Orchestrator, feature: FeatureState) {
  const since = escalatedSince(feature);
  return (o.state.modules[feature.module]?.escalations ?? []).filter((e) => e.feature === featureKey(feature) && e.askedAt >= since);
}

const takenToArchitect = (o: Orchestrator, feature: FeatureState): boolean => escalationsAbout(o, feature).length > 0;

/**
 * What lets a Manager give a feature out of attempts one more: a decision of the
 * Architect on an escalation about it, or the owner's answer to a question asked since,
 * either of which came after it stopped. Undefined while neither has.
 */
export function grantFor(o: Orchestrator, feature: FeatureState): string | undefined {
  const decided = escalationsAbout(o, feature).find((e) => e.decision !== undefined);
  if (decided) return `escalation:${decided.id}`;
  const since = escalatedSince(feature);
  const answered = Object.values(o.state.ownerRequests).find((r) => r.module === feature.module && r.askedAt >= since && r.answer !== undefined);
  return answered ? `request:${answered.requestId}` : undefined;
}

function exhaustedItem(o: Orchestrator, feature: FeatureState, last: Attempt): Item {
  const key = featureKey(feature);
  const ref = refOf(feature, last);
  const show: Show = { attempt: ref, branch: o.state.plans[planKey(ref)]!.branch };
  return {
    key: `exhausted:${key}#${feature.attempts.length}`,
    title: `${key}, which is out of attempts`,
    ask: `Call escalate_to_architect(feature: "${key}", question).`,
    show,
    text: async () => {
      const { feature: definition } = o.lookup(feature);
      return [
        `[harness] ATTEMPTS USED UP ${key}`,
        '',
        `Feature "${definition.title}": ${definition.description}`,
        `Expected: ${definition.expected}`,
        '',
        `Why it stopped: ${feature.escalation ?? 'its attempts are used up'}`,
        ...feature.attempts.map((a) => `- attempt ${a.n}: ${a.status}${a.reason ? `, ${clip(a.reason, 300)}` : ''}${a.guidance ? `. It had this guidance: ${clip(a.guidance, 300)}` : ''}`),
        ...inARow(o),
        '',
        `Its last attempt is checked out in ${await folder(o, show)}; get_attempt gives each one in full.`,
        '',
        `You have no attempt left to give, and the owner isn't asked first: take it to the Architect, which defined the feature and its checks. Call escalate_to_architect(feature: "${key}", question) with what failed each time, what your guidance already tried, and your own view: is the definition wrong or contradictory, the feature too large for one attempt, a check testing the wrong thing, or would one more attempt with different guidance be enough?`,
        '',
        `Its decision comes to you as a message. When it grants another attempt, call retry_feature(feature: "${key}", guidance) with its direction: that is accepted once per decision. When it changes the design instead, do nothing: the feature starts again by itself once the change is merged. Use ask_owner only for what neither of you can settle, such as an account, a credential or a host to allow; retry_feature is accepted after the owner's answer too.`,
      ].join('\n');
    },
  };
}

/** From `brakes.consecutiveFailures` on, what a Manager is told with a failure: they add up, and nothing pauses by itself. */
function inARow(o: Orchestrator): string[] {
  const row = o.state.pipeline.consecutiveFailures;
  if (row < o.design.config.brakes.consecutiveFailures) return [];
  return [
    '',
    `${row} attempts have now failed in a row in this module, with nothing accepted in between, and nothing pauses by itself. If they share a cause outside the Developers' work, such as the environment, an account or a host the sandbox can't reach, the next attempt fails the same way: use ask_owner with blocking: true, which holds new attempts until the owner answers. If the design is the cause, escalate_to_architect.`,
  ];
}

function conflictItem(o: Orchestrator, plan: PlanState): Item {
  const key = planKey(plan);
  const show: Show = { branch: plan.branch, main: true };
  const [ours, theirs] = [short(plan.head), short(plan.mainConflict!.main)];
  return {
    key: `conflict:${key}@${plan.mainConflict!.main}`,
    title: `the conflict of ${key} with main`,
    ask: `Call request_fix(plan: "${key}", guidance) with how each file must come out, or escalate_to_architect if the two sides contradict each other.`,
    show,
    text: async () => [
      `[harness] CONFLICT WITH MAIN ${key}`,
      '',
      await conflictReport(o, plan),
      '',
      `The plan branch, at ${ours}, is checked out in ${await folder(o, show)}, and your clone has main at ${theirs}. For a file, \`git diff ${theirs}...${ours} -- <file>\` shows what the plan did to it since the two diverged, and \`git diff ${ours}...${theirs} -- <file>\` what main did; \`git show ${theirs}:<file>\` is the file as main has it.`,
      '',
      `Nothing new starts in this plan until main is merged in. Work out how each file must come out so that the work of both sides holds, then call request_fix(plan: "${key}", guidance) with that, file by file: a Developer merges main into the plan branch following it, every check of accepted work runs on the result, and you review the merge like a feature. If the two sides contradict each other in a way only the design can settle, use escalate_to_architect first, or ask_owner when the module has no Architect, and call request_fix once you have the decision.`,
    ].join('\n'),
  };
}

/** What conflicts between main and a plan's branch, and what main gained since the two diverged. */
export async function conflictReport(o: Orchestrator, plan: PlanState): Promise<string> {
  const { main, files } = plan.mainConflict!;
  const base = await o.repo.mergeBase(main, plan.head);
  const gained = await o.repo.gained(base, main, 15);
  return [
    `Main moved to ${short(main)} and no longer merges into ${plan.branch} (at ${short(plan.head)}): both changed the same lines in`,
    ...files.map((file) => `- ${file}`),
    '',
    `What main gained since the two diverged at ${short(base)}, newest first:`,
    ...gained.map((line) => `- ${line}`),
  ].join('\n');
}

function questionItem(feature: FeatureState, attempt: Attempt, requestId: string, question: string): Item {
  const key = featureKey(feature);
  return {
    key: `question:${requestId}`,
    title: `the Developer's question on ${key}`,
    ask: `Call answer_developer(question_id: "${requestId}", answer).`,
    text: async () => [
      `[harness] QUESTION from the Developer of ${key} attempt ${attempt.n} (question_id: ${requestId})`,
      '',
      question,
      '',
      `Answer with answer_developer(question_id: "${requestId}", answer). The Developer waits for you, at most 15 minutes. Decide within the design; if only the owner can decide, give your best default and ask the owner as well.`,
    ].join('\n'),
  };
}

function reviewItem(o: Orchestrator, feature: FeatureState, attempt: Attempt): Item {
  const key = featureKey(feature);
  const ref = refOf(feature, attempt);
  const branch = o.state.plans[planKey(ref)]!.branch;
  // A merge round's result (v3 §6.6): main comes along, to compare with.
  const merge = feature.fix?.kind === 'merge' ? feature.fix : undefined;
  const show: Show = { attempt: ref, branch, ...(merge ? { main: true } : {}) };
  const [base, head] = [short(attempt.base), short(attempt.head)];
  return {
    key: `review:${key}#${attempt.n}`,
    title: `the review of ${key} attempt ${attempt.n}`,
    ask: `Call accept_feature or reject_feature for ${key} attempt ${attempt.n}.`,
    show,
    text: async () => {
      const { feature: definition } = o.lookup(feature);
      const where = await folder(o, show);
      return [
        `[harness] REVIEW ${key} attempt ${attempt.n}`,
        '',
        `Feature "${definition.title}": ${definition.description}`,
        `Expected: ${definition.expected}`,
        '',
        `The Developer reports done: ${attempt.summary ?? '(no summary)'}`,
        ...(attempt.notes ? ['', `Its notes: ${attempt.notes}`] : []),
        ...questionsAsked(attempt),
        ...refusedLines(attempt, false),
        '',
        'Every check passed in a fresh sandbox:',
        ...checkLines(attempt.checks ?? []),
        '',
        ...(merge
          ? [
            `It conflicted in: ${(merge.files ?? []).join(', ')}`,
            `The merge is checked out in ${where}: read its files there. Its head is ${head}, the plan branch at ${base} with main at ${short(merge.main)} merged in. \`git diff ${short(merge.main)} ${head}\` is what the plan holds on top of main, and \`git diff ${base} ${head}\` what the merge brought to the plan branch.`,
            '',
            `Review the files that conflicted: the work of both sides must hold in each, and nothing else may have changed beyond what the merge needs. Then call accept_feature or reject_feature (feature: "${key}", attempt: ${attempt.n}). Accepted, it lands as the merge of main into the plan branch.`,
          ]
          : [
            `Changed files: ${(attempt.files ?? []).join(', ') || '(none)'}`,
            `The attempt is checked out in ${where}: read its files there. Its head is ${head}, on top of the plan branch at ${base}: see \`git diff ${base} ${head}\` and \`git log ${base}..${head}\`.`,
            '',
            `Review it against the feature and the design, then call accept_feature or reject_feature (feature: "${key}", attempt: ${attempt.n}).`,
          ]),
      ].join('\n');
    },
  };
}

function failureItem(o: Orchestrator, feature: FeatureState, attempt: Attempt): Item {
  const key = featureKey(feature);
  const ref = refOf(feature, attempt);
  const branch = o.state.plans[planKey(ref)]!.branch;
  const left = attemptsLeft(o, feature);
  const show: Show = { attempt: ref, branch };
  return {
    key: `guidance:${key}#${attempt.n}`,
    title: `the guidance for ${key} after attempt ${attempt.n}`,
    ask: `Call retry_feature(feature: "${key}", guidance), or ask_owner if only the owner can unblock it.`,
    show,
    text: async () => {
      const { feature: definition } = o.lookup(feature);
      const head = await o.repo.revParse(attemptRefName(ref));
      const where = await folder(o, show);
      const finding = attempt.finding;
      const failing = (attempt.checks ?? []).filter((c) => c.exit !== 0);
      return [
        `[harness] ATTEMPT FAILED ${key} attempt ${attempt.n}`,
        '',
        `Feature "${definition.title}": ${definition.description}`,
        '',
        `Why it failed: ${attempt.reason ?? attempt.outcome ?? 'unknown'}`,
        ...(attempt.summary ? [`The Developer's report: ${attempt.summary}`] : []),
        ...(attempt.notes ? [`Its notes: ${attempt.notes}`] : []),
        ...(finding
          ? ['', `Its finding (${finding.category}): ${finding.summary}`, ...(finding.tried?.length ? [`Tried: ${finding.tried.join('; ')}`] : []), ...(finding.needs ? [`Needs: ${finding.needs}`] : [])]
          : []),
        ...questionsAsked(attempt),
        ...refusedLines(attempt, true),
        ...(failing.length ? ['', 'Failing checks:', ...checkLines(failing, true)] : []),
        ...inARow(o),
        '',
        head
          ? `Its commits are checked out in ${where} (head ${short(head)}, on top of ${short(attempt.base)}): \`git diff ${short(attempt.base)} ${short(head)}\` is what it wrote.`
          : `It committed nothing: ${where} holds the plan branch as it found it.`,
        '',
        `${left} attempt${left === 1 ? '' : 's'} left. The next Developer starts fresh: it sees the feature, why this attempt failed, and your guidance. Call retry_feature(feature: "${key}", guidance) with what would have prevented this failure. ${o.state.modules[feature.module]
          ? 'If the design is the cause, such as a contradiction, a decision it left open or a check that tests the wrong thing, use escalate_to_architect; if only the owner can unblock it, such as an account, a credential or a host to allow, use ask_owner. Then retry_feature once you have the answer.'
          : 'If only the owner can unblock it, use ask_owner, then retry_feature once you have the answer.'}`,
      ].join('\n');
    },
  };
}

/** What went wrong after a merge: the apply job's log, or the post-deploy checks' output. */
export function deployReport(plan: PlanState): string {
  if (plan.deploy?.status === 'failed') {
    const jobs = plan.deploy.jobs ?? [];
    const lines = jobs.map((job) => [`- ${job.name}: ${job.conclusion}${job.url ? ` (${job.url})` : ''}`, ...(job.log?.trim() ? ['```', tail(job.log.trim(), 3000), '```'] : [])].join('\n'));
    // A skipped apply never started: the jobs it waits for on main failed, and their logs say why.
    const skipped = jobs.some((job) => job.conclusion === 'skipped');
    return [...(skipped ? ['The apply did not start: it runs once the other jobs pass on main, and one of them failed there.'] : []), ...lines].join('\n');
  }
  if (plan.postDeploy?.status === 'failed') {
    return ['The post-deploy checks, run with the view-only role:', ...checkLines(plan.postDeploy.results, true)].join('\n');
  }
  return `${planKey(plan)} is ${plan.status}.`;
}

/** What CI said about a plan's pull request, failures first, with the end of their logs. */
export function ciReport(plan: PlanState): string {
  const ci = plan.ci;
  if (!plan.pr) return `${planKey(plan)} has no pull request yet (it is ${plan.status}).`;
  if (!ci) return `PR #${plan.pr.number} (${plan.pr.url}): a fix is being pushed; CI hasn't run on it yet.`;
  const jobs = [...(ci.jobs ?? [])].sort((a, b) => Number(a.conclusion === 'success') - Number(b.conclusion === 'success'));
  return [
    `PR #${plan.pr.number} (${plan.pr.url}), CI on ${short(ci.sha)}: ${ci.status}.`,
    ...jobs.flatMap((job) => [
      `- ${job.name}: ${job.conclusion}${job.url ? ` (${job.url})` : ''}`,
      ...(job.log ? ['```', tail(job.log.trim(), 3000), '```'] : []),
    ]),
  ].join('\n');
}

/** The once-only messages: the welcome, and the owner's messages and answers. */
export function mailText(o: Orchestrator, manager: ManagerState, mail: ManagerState['mail'][number]): string {
  if (mail.kind === 'owner_message') return ['[harness] MESSAGE from the owner', '', mail.text].join('\n');
  // Written whole when the owner asked: the cards as they were then.
  if (mail.kind === 'order_request') return mail.text;
  if (mail.kind === 'decision') {
    const escalation = o.state.modules[manager.module]?.escalations.find((e) => e.id === mail.requestId);
    const about = escalation?.feature ? o.state.features[escalation.feature] : undefined;
    return [
      `[harness] DECISION from the Architect on your escalation ${mail.requestId}`,
      '',
      `You asked: ${clip(escalation?.question ?? '', 800)}`,
      '',
      `Decision: ${mail.text}`,
      // The feature is out of attempts: this decision is what lets the Manager start one more.
      ...(about && outOfAttempts(o, about)
        ? ['', `${escalation!.feature} is out of attempts. If this decision grants another one, call retry_feature(feature: "${escalation!.feature}", guidance) now, with the Architect's direction in your guidance. If it changes the design instead, do nothing: the feature starts again by itself once the change is merged.`]
        : []),
    ].join('\n');
  }
  if (mail.kind === 'owner_answer') {
    const question = o.state.ownerRequests[mail.requestId ?? '']?.question ?? '';
    return [`[harness] ANSWER from the owner (request ${mail.requestId})`, '', `You asked: ${clip(question, 800)}`, '', `Answer: ${mail.text}`].join('\n');
  }
  const module = o.design.modules.find((m) => m.id === manager.module);
  const features = (p: { features: Array<{ id: string; title: string }> }) => p.features.map((f) => `${f.id} "${f.title}"`).join(', ');
  if (manager.plan) {
    // A plan's Manager, in Swarm (v3 §6.4): its plan, and where the module's other plans stand.
    const mine = module?.plans.find((p) => p.id === manager.plan);
    const others = (module?.plans ?? []).filter((p) => p.id !== manager.plan).map((p) => {
      const status = o.state.plans[`${manager.module}/${p.id}`]?.status;
      const where = status === 'completed' ? 'complete' : status ? `${status.replace(/_/g, ' ')}, with its own Manager` : 'not started';
      return `- ${p.id} "${p.title}": ${where}`;
    });
    return [
      `[harness] WELCOME: you are the Manager of plan ${manager.plan} "${mine?.title ?? ''}" of module "${manager.module}".`,
      '',
      `Its features: ${mine ? features(mine) : '(none)'}.`,
      ...(others.length > 0 ? ['', "The module's other plans, which are not yours:", ...others] : []),
      '',
      `The plan is harness/modules/${manager.module}/plans/${manager.plan}.json in your clone, next to the others. Read it now, with ARCHITECTURE.md and README.md if they exist, so you're ready for questions and reviews. Then reply in one line and wait for the next item.`,
    ].join('\n');
  }
  // Every plan of the module is this Manager's, in both modes: in Swarm, those that depend on no unfinished plan are built at once.
  const plans = (module?.plans ?? []).map((p) => {
    const after = module ? planDependencies(module, p) : [];
    return `- ${p.id} "${p.title}" (${after.length > 0 ? `after ${after.join(', ')}` : 'after no other plan'}): ${features(p)}`;
  });
  return [
    `[harness] WELCOME: you are the Manager of module "${manager.module}".`,
    '',
    'Its plans, all yours. One starts once the plans it comes after are merged, so several may be built at the same time, and their items reach you in turn:',
    ...plans,
    '',
    `The plans are in harness/modules/${manager.module}/plans/ in your clone. Read them now, with ARCHITECTURE.md and README.md if they exist, so you're ready for questions and reviews. Then reply in one line and wait for the next item.`,
  ].join('\n');
}

/** Whether a plan has a Manager of its own still running: one that Swarm started before 0.6.0. */
export function hasOwnManager(o: Orchestrator, module: string, plan: string): boolean {
  const own = o.state.managers[managerKey({ module, plan })];
  return own !== undefined && own.status !== 'stopped';
}

/** Who merges a Fix PR, as the end of "its pull request goes through CI and …". */
export function fixPrMerge(o: Orchestrator): string {
  return o.state.mode === 'swarm' && o.state.fixMerge !== 'owner'
    ? "the reviewers, then the daemon's merge under the same policy as a plan's"
    : "the owner's merge";
}

export function attemptsLeft(o: Orchestrator, feature: FeatureState): number {
  const definition = o.featureDefinition(feature);
  if (!definition) return 0;
  return o.design.config.roles.developer.maxAttempts + feature.extraAttempts - countedAttempts(feature, definitionHash(definition));
}

function questionsAsked(attempt: Attempt): string[] {
  const asked = attempt.questions ?? [];
  if (asked.length === 0) return [];
  return ['', 'Its questions:', ...asked.map((q) => `- ${clip(q.text, 500)} → ${q.answer === undefined ? '(unanswered)' : clip(q.answer, 500)}`)];
}

/**
 * The requests the attempt's sandbox policy refused. A host the feature needs and the
 * policy doesn't allow explains many failures; the Manager resolves it, around the host
 * or with the owner, who alone widens the policy.
 */
function refusedLines(attempt: Attempt, failed: boolean): string[] {
  const refused = attempt.refused ?? [];
  if (refused.length === 0) return [];
  const shown = refused.slice(0, 12);
  return [
    '',
    "Its sandbox's network policy refused:",
    ...shown.map((d) => `- ${d.target} ${d.program ? `from ${d.program}` : '(a DNS query)'}, ${d.count} time${d.count === 1 ? '' : 's'}: ${d.reason.replace(/_/g, ' ')}`),
    ...(refused.length > shown.length ? [`- and ${refused.length - shown.length} more`] : []),
    ...(failed
      ? ["A sandbox reaches only the hosts of network.bundles, network.extraHosts and network.apis in harness/config.json, and the next attempt meets the same policy. If the feature can do without a host, give the way around it in your guidance. If it can't, ask_owner to allow the host, with blocking: true when no attempt can succeed without it: only the owner widens the policy."]
      : []),
  ];
}

function checkLines(results: CheckResult[], withOutput = false): string[] {
  return results.flatMap((r) => {
    const verdict = r.exit === 0 ? 'passed' : r.timedOut ? 'timed out' : `exited ${r.exit}`;
    const line = `- ${r.id}: ${verdict} (${(r.durationMs / 1000).toFixed(1)} s)`;
    return withOutput && r.output.trim() ? [line, '```', tail(r.output.trim(), 1500), '```'] : [line];
  });
}

const short = (sha?: string) => (sha ? sha.slice(0, 8) : '?');
