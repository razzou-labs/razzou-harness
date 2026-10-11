import type { CheckResult } from '../checks/runner.ts';
import { definitionHash } from '../design/schemas.ts';
import type { Ref } from '../state/events.ts';
import { countedAttempts, featureKey, planKey, type Attempt, type FeatureState, type ManagerState, type PlanState } from '../state/state.ts';
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
  /** What to check out in the Manager's clone first: an attempt's commits, or else the branch. */
  show?: { attempt?: Ref; branch: string };
  text: () => Promise<string>;
}

export function pendingItems(o: Orchestrator, module: string): Item[] {
  const questions: Item[] = [];
  const others: Item[] = [];
  for (const feature of Object.values(o.state.features).filter((f) => f.module === module)) {
    const last = feature.attempts.at(-1);
    if (!last) continue;
    if (last.status === 'running') {
      for (const question of (last.questions ?? []).filter((q) => q.answer === undefined)) {
        questions.push(questionItem(feature, last, question.requestId, question.text));
      }
    }
    if (last.status === 'reviewing' && !last.decision) others.push(reviewItem(o, feature, last));
    if (feature.awaitingGuidanceSince && feature.status !== 'escalated' && attemptsLeft(o, feature) > 0) {
      others.push(failureItem(o, feature, last));
    }
  }
  const rounds = o.design.config.brakes.ciFixRounds;
  const deployRounds = o.design.config.brakes.deployFixRounds;
  for (const plan of Object.values(o.state.plans).filter((p) => p.module === module)) {
    if ((plan.status === 'deploy_failed' || plan.status === 'verify_failed') && (plan.deployFixRounds ?? 0) < deployRounds) {
      const key = planKey(plan);
      const what = plan.status === 'deploy_failed' ? 'DEPLOY FAILED' : 'POST-DEPLOY CHECKS FAILED';
      others.push({
        key: `${plan.status}:${key}@${plan.mergeCommit}`,
        title: `the failed deploy of ${key}`,
        ask: `Call request_fix(plan: "${key}", guidance) to start a Fix PR, or ask_owner if it can't be fixed in code.`,
        show: { branch: 'main' },
        text: async () => [
          `[harness] ${what} ${key} (merged as ${short(plan.mergeCommit)}, ${plan.deployFixRounds ?? 0} of ${deployRounds} Fix PRs used)`,
          '',
          deployReport(plan),
          '',
          'Your clone has main checked out. Diagnose the failure, then call',
          `request_fix(plan: "${key}", guidance): a Developer fixes it on a new fix branch, and it goes through review, CI and the owner's merge again. If the cause isn't in the code (a missing permission, a quota, an account setting), use ask_owner instead.`,
        ].join('\n'),
      });
    }
    if (plan.status === 'pr_open' && plan.ci?.status === 'failed' && (plan.fixRounds ?? 0) < rounds) {
      const key = planKey(plan);
      others.push({
        key: `ci:${key}@${plan.ci.sha}`,
        title: `the failed CI of ${key}`,
        ask: `Call request_fix(plan: "${key}", guidance), or ask_owner if it can't be fixed in code.`,
        show: { branch: plan.branch },
        text: async () => [
          `[harness] CI FAILED ${key} (PR #${plan.pr?.number}, ${plan.fixRounds ?? 0} of ${rounds} fix rounds used)`,
          '',
          ciReport(plan),
          '',
          'Your clone has the plan branch checked out. Diagnose the failure from the code and the logs, then call',
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
  return {
    key: `review:${key}#${attempt.n}`,
    title: `the review of ${key} attempt ${attempt.n}`,
    ask: `Call accept_feature or reject_feature for ${key} attempt ${attempt.n}.`,
    show: { attempt: ref, branch },
    text: async () => {
      const { feature: definition } = o.lookup(feature);
      return [
        `[harness] REVIEW ${key} attempt ${attempt.n}`,
        '',
        `Feature "${definition.title}": ${definition.description}`,
        `Expected: ${definition.expected}`,
        '',
        `The Developer reports done: ${attempt.summary ?? '(no summary)'}`,
        ...(attempt.notes ? ['', `Its notes: ${attempt.notes}`] : []),
        ...questionsAsked(attempt),
        '',
        'Every check passed in a fresh sandbox:',
        ...checkLines(attempt.checks ?? []),
        '',
        `Changed files: ${(attempt.files ?? []).join(', ') || '(none)'}`,
        `Your clone has the attempt checked out. HEAD is ${short(attempt.head)}, on top of the plan branch at ${short(attempt.base)}: see \`git diff ${short(attempt.base)} HEAD\` and \`git log ${short(attempt.base)}..HEAD\`.`,
        '',
        `Review it against the feature and the design, then call accept_feature or reject_feature (feature: "${key}", attempt: ${attempt.n}).`,
      ].join('\n');
    },
  };
}

function failureItem(o: Orchestrator, feature: FeatureState, attempt: Attempt): Item {
  const key = featureKey(feature);
  const ref = refOf(feature, attempt);
  const branch = o.state.plans[planKey(ref)]!.branch;
  const left = attemptsLeft(o, feature);
  return {
    key: `guidance:${key}#${attempt.n}`,
    title: `the guidance for ${key} after attempt ${attempt.n}`,
    ask: `Call retry_feature(feature: "${key}", guidance), or ask_owner if only the owner can unblock it.`,
    show: { attempt: ref, branch },
    text: async () => {
      const { feature: definition } = o.lookup(feature);
      const head = await o.repo.revParse(attemptRefName(ref));
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
        ...(failing.length ? ['', 'Failing checks:', ...checkLines(failing, true)] : []),
        '',
        head
          ? `Your clone has its commits checked out (HEAD ${short(head)}, on top of ${short(attempt.base)}).`
          : 'It committed nothing; your clone shows the plan branch.',
        '',
        `${left} attempt${left === 1 ? '' : 's'} left. The next Developer starts fresh: it sees the feature, why this attempt failed, and your guidance. Call retry_feature(feature: "${key}", guidance) with what would have prevented this failure. If only the owner can unblock it, use ask_owner, then retry_feature once you have the answer.`,
      ].join('\n');
    },
  };
}

/** What went wrong after a merge: the apply job's log, or the post-deploy checks' output. */
export function deployReport(plan: PlanState): string {
  if (plan.deploy?.status === 'failed') {
    return (plan.deploy.jobs ?? []).map((job) => [`- ${job.name}: ${job.conclusion}${job.url ? ` (${job.url})` : ''}`, '```', tail((job.log ?? '').trim(), 3000), '```'].join('\n')).join('\n');
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
  if (mail.kind === 'decision') {
    const question = o.state.modules[manager.module]?.escalations.find((e) => e.id === mail.requestId)?.question ?? '';
    return [`[harness] DECISION from the Architect on your escalation ${mail.requestId}`, '', `You asked: ${clip(question, 800)}`, '', `Decision: ${mail.text}`].join('\n');
  }
  if (mail.kind === 'owner_answer') {
    const question = o.state.ownerRequests[mail.requestId ?? '']?.question ?? '';
    return [`[harness] ANSWER from the owner (request ${mail.requestId})`, '', `You asked: ${clip(question, 800)}`, '', `Answer: ${mail.text}`].join('\n');
  }
  const module = o.design.modules.find((m) => m.id === manager.module);
  const plans = (module?.plans ?? []).map((p) => `- ${p.id} "${p.title}": ${p.features.map((f) => `${f.id} "${f.title}"`).join(', ')}`);
  return [
    `[harness] WELCOME: you are the Manager of module "${manager.module}".`,
    '',
    'Its plans, built in this order:',
    ...plans,
    '',
    `The plans are in harness/modules/${manager.module}/plans/ in your clone. Read them now, with ARCHITECTURE.md and README.md if they exist, so you're ready for questions and reviews. Then reply in one line and wait for the next item.`,
  ].join('\n');
}

export function attemptsLeft(o: Orchestrator, feature: FeatureState): number {
  const hash = definitionHash(o.lookup(feature).feature);
  return o.design.config.roles.developer.maxAttempts + feature.extraAttempts - countedAttempts(feature, hash);
}

function questionsAsked(attempt: Attempt): string[] {
  const asked = attempt.questions ?? [];
  if (asked.length === 0) return [];
  return ['', 'Its questions:', ...asked.map((q) => `- ${clip(q.text, 500)} → ${q.answer === undefined ? '(unanswered)' : clip(q.answer, 500)}`)];
}

function checkLines(results: CheckResult[], withOutput = false): string[] {
  return results.flatMap((r) => {
    const verdict = r.exit === 0 ? 'passed' : r.timedOut ? 'timed out' : `exited ${r.exit}`;
    const line = `- ${r.id}: ${verdict} (${(r.durationMs / 1000).toFixed(1)} s)`;
    return withOutput && r.output.trim() ? [line, '```', tail(r.output.trim(), 1500), '```'] : [line];
  });
}

const short = (sha?: string) => (sha ? sha.slice(0, 8) : '?');
