import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CheckResult } from '../checks/runner.ts';
import type { AttemptOutcome, CiJob, Finding, HarnessEvent, Ref, Usage } from './events.ts';

export type AttemptStatus = 'starting' | 'running' | 'collecting' | 'checking' | 'reviewing' | 'accepted' | 'failed' | 'interrupted';

export interface Question {
  requestId: string;
  text: string;
  askedAt: string;
  answer?: string;
  answeredAt?: string;
}

export interface Attempt {
  n: number;
  status: AttemptStatus;
  sandbox: string;
  base: string;
  sessionId: string;
  definitionHash: string;
  startedAt: string;
  deadline: string;
  /** The guidance it started with, from the Manager or the owner. */
  guidance?: string;
  endedAt?: string;
  outcome?: AttemptOutcome;
  summary?: string;
  notes?: string;
  finding?: Finding;
  usage?: Usage;
  head?: string;
  files?: string[];
  checks?: CheckResult[];
  questions?: Question[];
  reviewSince?: string;
  /** The Manager's verdict after a review. The daemon acts on it in its next step. */
  decision?: { kind: 'accept' | 'reject'; text?: string; requestId: string; at: string };
  /** The Manager asked to stop this attempt. */
  abort?: { reason: string; requestId: string };
  reason?: string;
  counts?: boolean;
  commit?: string;
}

export type FeatureStatus = 'pending' | 'in_progress' | 'accepted' | 'escalated';

export interface FeatureState {
  module: string;
  plan: string;
  feature: string;
  status: FeatureStatus;
  attempts: Attempt[];
  /** Attempts granted by the owner after an escalation. */
  extraAttempts: number;
  escalation?: string;
  commit?: string;
  /** Guidance for the next attempt. A counted failure needs it before another attempt starts. */
  guidance?: string;
  /** Since when the Manager owes guidance, after a counted failure. */
  awaitingGuidanceSince?: string;
  /** Set for a fix, which is built like a feature but isn't in the design: after CI failed, or after the deploy. */
  fix?: { round: number; kind: 'ci' | 'deploy'; failure: string; requestId: string };
}

export interface PlanState {
  module: string;
  plan: string;
  /**
   * In GitHub, after validating: the PR is open, a fix round runs, CI passed, the owner
   * merges; then CI applies the infrastructure and the post-deploy checks run (§7.2).
   */
  status:
    | 'active' | 'validating' | 'pr_open' | 'fixing' | 'ready_to_merge'
    | 'deploying' | 'verifying' | 'deploy_failed' | 'verify_failed' | 'completed';
  branch: string;
  base: string;
  head: string;
  /** The full check run once every feature is accepted. */
  validation?: { status: 'running' | 'passed' | 'failed'; since: string; results?: CheckResult[] };
  /** The Manager's summary when it submitted the plan. */
  summary?: string;
  /** The plan branch's head as last pushed to GitHub. */
  pushed?: string;
  pr?: { number: number; url: string; closed?: boolean };
  /** CI on the pushed head. */
  ci?: { sha: string; status: 'pending' | 'passed' | 'failed'; since: string; jobs?: CiJob[] };
  /** CI fix rounds in the current pull request. */
  fixRounds?: number;
  /** Fix PRs after a failed apply or post-deploy checks. */
  deployFixRounds?: number;
  /** Fix work items of every kind so far: they are named fix1, fix2… */
  fixes?: number;
  mergeCommit?: string;
  mergedAt?: string;
  deploy?: { commit: string; status: 'passed' | 'failed'; jobs?: CiJob[] };
  postDeploy?: { status: 'passed' | 'failed'; results: CheckResult[] };
}

export interface ManagerState {
  module: string;
  sandbox: string;
  sessionId: string;
  status: 'starting' | 'running' | 'exited' | 'stopped';
  /** Claude Code processes started in this sandbox so far; the first uses `--session-id`, later ones `--resume`. */
  launch: number;
  launchedAt?: string;
  /** The size of its output when the current launch started: no growth means Claude never started. */
  launchedOutputBytes?: number;
  /** Recent exits, for the brake on a Manager that keeps stopping. */
  exits: string[];
  lastExit?: { code: number | null; stderr: string; started: boolean };
  /** Items that need a decision, by key: when they were sent in the current launch, and reminded. */
  sent: Record<string, { launch: number; at: string; reminded?: string }>;
  /** Things to deliver once: the owner's messages and answers, the Architect's decisions, and the welcome. */
  mail: Array<{ key: string; kind: 'welcome' | 'owner_message' | 'owner_answer' | 'decision'; text: string; requestId?: string }>;
}

/** A module the owner started with the Architect (§7.1). Modules written by hand on main have none. */
export interface ModuleState {
  module: string;
  title: string;
  status: 'designing' | 'proposed' | 'decomposing' | 'in_review' | 'frozen';
  architect: { sandbox: string; sessionId: string; status: 'starting' | 'running' };
  proposals: Array<{ version: number; sha256: string; submittedAt: string; acceptedAt?: string }>;
  accepted?: number;
  /** A design the daemon is checking before it opens the Arch PR. */
  submission?: { requestId: string; summary: string; head: string; at: string };
  /** The design under review: its branch head with the hash list, and its PR. */
  design?: { head: string; suspect: string[]; summary: string; pr?: { number: number; url: string }; ciNoted?: string };
  frozenCommit?: string;
  /** Messages for the Architect, written into its sandbox once and shown with the owner's next prompt. */
  notes: Array<{ key: string; text: string; sent?: boolean }>;
  escalations: Array<{ id: string; question: string; feature?: string; askedAt: string; decision?: string; decidedAt?: string }>;
}

export interface ActionState {
  status: 'verifying' | 'done' | 'refused';
  at: string;
  note?: string;
  reason?: string;
}

export interface OwnerRequest {
  requestId: string;
  module: string;
  question: string;
  blocking: boolean;
  askedAt: string;
  answer?: string;
  answeredAt?: string;
}

/** The projection of the event log that the daemon and the dashboard read. Never edited by hand. */
export interface State {
  v: 1;
  lastEventId?: string;
  daemon?: { pid: number; version: string; startedAt: string };
  pipeline: { paused?: { reason: string; since: string; until?: string }; consecutiveFailures: number };
  plans: Record<string, PlanState>;
  features: Record<string, FeatureState>;
  managers: Record<string, ManagerState>;
  ownerRequests: Record<string, OwnerRequest>;
  modules: Record<string, ModuleState>;
  /** Owner actions by "module/action". */
  actions: Record<string, ActionState>;
  /** progress.txt lines waiting for the next feature commit, such as satisfied gates. */
  pendingProgress: string[];
}

export const planKey = (ref: Ref) => `${ref.module}/${ref.plan}`;
export const featureKey = (ref: Ref) => `${ref.module}/${ref.plan}/${ref.feature}`;

export function initialState(): State {
  return { v: 1, pipeline: { consecutiveFailures: 0 }, plans: {}, features: {}, managers: {}, ownerRequests: {}, modules: {}, actions: {}, pendingProgress: [] };
}

export function project(events: HarnessEvent[]): State {
  return events.reduce(apply, initialState());
}

/** Applies one event to the state, in place, and returns it. */
export function apply(state: State, event: HarnessEvent): State {
  state.lastEventId = event.id;
  const ref = event.ref;
  switch (event.type) {
    case 'DAEMON_STARTED':
      state.daemon = { pid: event.payload.pid, version: event.payload.version, startedAt: event.ts };
      break;
    case 'DAEMON_STOPPED':
      delete state.daemon;
      break;
    case 'RECOVERED':
      Object.assign(state.plans, event.payload.plans);
      Object.assign(state.features, event.payload.features);
      Object.assign(state.actions, event.payload.actions);
      break;
    case 'PLAN_STARTED':
      state.plans[planKey(ref!)] = {
        module: ref!.module,
        plan: ref!.plan,
        status: 'active',
        branch: event.payload.branch,
        base: event.payload.base,
        head: event.payload.base,
      };
      break;
    case 'PLAN_MAIN_MERGED':
      Object.assign(state.plans[planKey(ref!)]!, { base: event.payload.main, head: event.payload.head });
      break;
    case 'PLAN_VALIDATING':
      Object.assign(state.plans[planKey(ref!)]!, { status: 'validating', head: event.payload.head, validation: { status: 'running', since: event.ts } });
      break;
    case 'PLAN_CHECKS_PASSED':
    case 'PLAN_CHECKS_FAILED':
      state.plans[planKey(ref!)]!.validation = {
        status: event.type === 'PLAN_CHECKS_PASSED' ? 'passed' : 'failed',
        since: event.ts,
        results: event.payload.results,
      };
      break;
    case 'PLAN_SUBMITTED':
      state.plans[planKey(ref!)]!.summary = event.payload.summary;
      break;
    case 'PLAN_PUSHED':
      Object.assign(state.plans[planKey(ref!)]!, { pushed: event.payload.head, ci: { sha: event.payload.head, status: 'pending', since: event.ts } });
      break;
    case 'PR_OPENED':
      Object.assign(state.plans[planKey(ref!)]!, { status: 'pr_open', pr: { number: event.payload.number, url: event.payload.url } });
      break;
    case 'CI_PASSED':
    case 'CI_FAILED': {
      const plan = state.plans[planKey(ref!)]!;
      plan.ci = { sha: event.payload.sha, status: event.type === 'CI_PASSED' ? 'passed' : 'failed', since: event.ts, jobs: event.payload.jobs };
      if (event.type === 'CI_PASSED') plan.status = 'ready_to_merge';
      break;
    }
    case 'PR_MERGED': {
      const plan = state.plans[planKey(ref!)]!;
      Object.assign(plan, { status: event.payload.next, mergeCommit: event.payload.commit, mergedAt: event.ts, head: event.payload.commit });
      delete plan.deploy;
      delete plan.postDeploy;
      if (event.payload.next === 'completed') {
        const manager = state.managers[ref!.module];
        if (manager) manager.sent = {};
      }
      break;
    }
    case 'DEPLOYED':
      Object.assign(state.plans[planKey(ref!)]!, {
        status: event.payload.verify ? 'verifying' : 'completed', deploy: { commit: event.payload.commit, status: 'passed' },
      });
      break;
    case 'DEPLOY_FAILED':
      Object.assign(state.plans[planKey(ref!)]!, { status: 'deploy_failed', deploy: { commit: event.payload.commit, status: 'failed', jobs: event.payload.jobs } });
      break;
    case 'PLAN_VERIFIED': {
      Object.assign(state.plans[planKey(ref!)]!, { status: 'completed', postDeploy: { status: 'passed', results: event.payload.results } });
      const manager = state.managers[ref!.module];
      if (manager) manager.sent = {};
      break;
    }
    case 'POST_DEPLOY_CHECKS_FAILED':
      Object.assign(state.plans[planKey(ref!)]!, { status: 'verify_failed', postDeploy: { status: 'failed', results: event.payload.results } });
      break;
    case 'PR_CLOSED': {
      const plan = state.plans[planKey(ref!)]!;
      if (plan.pr) plan.pr.closed = true;
      break;
    }
    case 'REQUEST_FIX': {
      const plan = state.plans[planKey(ref!)]!;
      const kind = plan.status === 'deploy_failed' || plan.status === 'verify_failed' ? 'deploy' : 'ci';
      let round: number;
      if (kind === 'deploy') {
        // A Fix PR: a new branch from the merge, and a new pull request (§11.3).
        round = (plan.deployFixRounds ?? 0) + 1;
        Object.assign(plan, { deployFixRounds: round, branch: `fix/${plan.module}/${plan.plan}-${round}`, base: plan.mergeCommit, head: plan.mergeCommit, fixRounds: 0 });
        delete plan.pr;
        delete plan.pushed;
        delete plan.ci;
      } else {
        round = (plan.fixRounds ?? 0) + 1;
        plan.fixRounds = round;
      }
      const n = (plan.fixes ?? 0) + 1;
      Object.assign(plan, { status: 'fixing', fixes: n });
      state.features[`${planKey(ref!)}/fix${n}`] = {
        module: plan.module, plan: plan.plan, feature: `fix${n}`, status: 'pending', attempts: [], extraAttempts: 0,
        guidance: event.payload.guidance, fix: { round, kind, failure: event.payload.failure, requestId: event.payload.requestId },
      };
      break;
    }
    case 'PLAN_COMPLETED': {
      const plan = state.plans[planKey(ref!)]!;
      plan.status = 'completed';
      plan.head = event.payload.head;
      const manager = state.managers[ref!.module];
      if (manager) manager.sent = {};
      break;
    }
    case 'ATTEMPT_STARTING': {
      const feature = featureOf(state, ref!);
      feature.status = 'in_progress';
      // An escalated feature starts again after the owner's retry, or a design change.
      delete feature.escalation;
      feature.attempts.push({
        n: ref!.attempt!,
        status: 'starting',
        sandbox: event.payload.sandbox,
        base: event.payload.base,
        sessionId: event.payload.sessionId,
        definitionHash: event.payload.definitionHash,
        startedAt: event.ts,
        deadline: event.payload.deadline,
        ...(feature.guidance ? { guidance: feature.guidance } : {}),
      });
      delete feature.guidance;
      delete feature.awaitingGuidanceSince;
      break;
    }
    case 'ATTEMPT_STARTED':
      attemptOf(state, ref!).status = 'running';
      break;
    case 'BASELINE_FAILED': {
      const attempt = attemptOf(state, ref!);
      attempt.checks = event.payload.results;
      attempt.reason = event.payload.reason;
      break;
    }
    case 'QUESTION': {
      const attempt = attemptOf(state, ref!);
      (attempt.questions ??= []).push({ requestId: event.payload.requestId, text: event.payload.question, askedAt: event.ts });
      break;
    }
    case 'CONTINUE': {
      const question = attemptOf(state, ref!).questions?.find((q) => q.requestId === event.payload.requestId);
      if (question) Object.assign(question, { answer: event.payload.answer, answeredAt: event.ts });
      break;
    }
    case 'ABORT':
      attemptOf(state, ref!).abort = { reason: event.payload.reason, requestId: event.payload.requestId };
      break;
    case 'ATTEMPT_ENDED':
      Object.assign(attemptOf(state, ref!), { status: 'collecting', endedAt: event.ts, ...event.payload });
      break;
    case 'ATTEMPT_INTERRUPTED': {
      const attempt = attemptOf(state, ref!);
      Object.assign(attempt, { status: 'interrupted', reason: event.payload.reason, counts: event.payload.counts });
      attempt.endedAt ??= event.ts;
      const feature = featureOf(state, ref!);
      feature.status = 'pending';
      // An interruption isn't the Developer's doing: the next attempt gets the same guidance.
      if (attempt.guidance && !feature.guidance) feature.guidance = attempt.guidance;
      break;
    }
    case 'CHECKS_STARTED':
      Object.assign(attemptOf(state, ref!), { status: 'checking', head: event.payload.head, files: event.payload.files });
      break;
    case 'CHECKS_FAILED':
      attemptOf(state, ref!).checks = event.payload.results;
      break;
    case 'CHECKS_PASSED':
      Object.assign(attemptOf(state, ref!), { status: 'reviewing', checks: event.payload.results, reviewSince: event.ts });
      break;
    case 'ACCEPT':
    case 'REJECT':
      attemptOf(state, ref!).decision = {
        kind: event.type === 'ACCEPT' ? 'accept' : 'reject',
        text: event.type === 'ACCEPT' ? event.payload.note : event.payload.guidance,
        requestId: event.payload.requestId,
        at: event.ts,
      };
      break;
    case 'FEATURE_ACCEPTED': {
      Object.assign(attemptOf(state, ref!), { status: 'accepted', commit: event.payload.commit });
      const feature = featureOf(state, ref!);
      Object.assign(feature, { status: 'accepted', commit: event.payload.commit });
      const plan = state.plans[planKey(ref!)]!;
      plan.head = event.payload.commit;
      // A fix landed: the PR waits for it to be pushed, and for CI again.
      if (feature.fix) {
        plan.status = 'pr_open';
        delete plan.ci;
      }
      state.pipeline.consecutiveFailures = 0;
      state.pendingProgress = [];
      break;
    }
    case 'ATTEMPT_FAILED': {
      const attempt = attemptOf(state, ref!);
      Object.assign(attempt, { status: 'failed', reason: event.payload.reason, counts: true });
      attempt.endedAt ??= event.ts;
      const feature = featureOf(state, ref!);
      feature.status = 'pending';
      // A rejection carries its guidance. Any other failure waits for the Manager's.
      if (attempt.decision?.kind === 'reject') feature.guidance = attempt.decision.text;
      else feature.awaitingGuidanceSince = event.ts;
      state.pipeline.consecutiveFailures += 1;
      break;
    }
    case 'RETRY': {
      const feature = featureOf(state, ref!);
      feature.guidance = event.payload.guidance;
      delete feature.awaitingGuidanceSince;
      break;
    }
    case 'ESCALATED': {
      const feature = featureOf(state, ref!);
      Object.assign(feature, { status: 'escalated', escalation: event.payload.reason });
      delete feature.awaitingGuidanceSince;
      break;
    }
    case 'OWNER_RETRY': {
      const feature = featureOf(state, ref!);
      feature.extraAttempts += 1;
      feature.status = 'pending';
      delete feature.escalation;
      delete feature.awaitingGuidanceSince;
      if (event.payload.note) feature.guidance = event.payload.note;
      break;
    }
    case 'OWNER_REQUEST':
      state.ownerRequests[event.payload.requestId] = {
        requestId: event.payload.requestId,
        module: event.payload.module,
        question: event.payload.question,
        blocking: event.payload.blocking,
        askedAt: event.ts,
      };
      break;
    case 'OWNER_ANSWER': {
      const request = state.ownerRequests[event.payload.requestId];
      if (request) Object.assign(request, { answer: event.payload.answer, answeredAt: event.ts });
      state.managers[event.payload.module]?.mail.push({
        key: `mail:${event.id}`, kind: 'owner_answer', text: event.payload.answer, requestId: event.payload.requestId,
      });
      break;
    }
    case 'OWNER_MESSAGE':
      state.managers[event.payload.module]?.mail.push({ key: `mail:${event.id}`, kind: 'owner_message', text: event.payload.text });
      break;
    case 'MANAGER_STARTING': {
      const { module, sandbox, sessionId } = event.payload;
      const mail = state.managers[module]?.mail.filter((m) => m.kind !== 'welcome') ?? [];
      state.managers[module] = {
        module, sandbox, sessionId, status: 'starting', launch: 0, exits: [], sent: {},
        mail: [{ key: `mail:${event.id}`, kind: 'welcome', text: '' }, ...mail],
      };
      break;
    }
    case 'MANAGER_LAUNCHED':
      Object.assign(state.managers[event.payload.module]!, {
        status: 'running', launch: event.payload.launch, launchedAt: event.ts, launchedOutputBytes: event.payload.outputBytes,
      });
      break;
    case 'MANAGER_EXITED': {
      const manager = state.managers[event.payload.module]!;
      manager.status = 'exited';
      manager.exits = [...manager.exits, event.ts].slice(-5);
      manager.lastExit = { code: event.payload.code, stderr: event.payload.stderr, started: event.payload.started };
      break;
    }
    case 'MANAGER_ITEM_SENT': {
      const manager = state.managers[event.payload.module]!;
      const { key, launch, reminder } = event.payload;
      if (key.startsWith('mail:')) manager.mail = manager.mail.filter((m) => m.key !== key);
      else if (reminder) manager.sent[key] = { ...manager.sent[key]!, reminded: event.ts };
      else manager.sent[key] = { launch, at: event.ts };
      break;
    }
    case 'MANAGER_STOPPED':
      state.managers[event.payload.module]!.status = 'stopped';
      break;
    case 'PIPELINE_PAUSED':
      state.pipeline.paused = { reason: event.payload.reason, since: event.ts, until: event.payload.until };
      break;
    case 'PIPELINE_RESUMED':
      delete state.pipeline.paused;
      state.pipeline.consecutiveFailures = 0;
      // The owner looked: waiting items start a fresh turn, a failed full check run runs again,
      // and a Manager that kept stopping gets another chance.
      for (const manager of Object.values(state.managers)) Object.assign(manager, { sent: {}, exits: [] });
      for (const plan of Object.values(state.plans)) if (plan.validation?.status === 'failed') delete plan.validation;
      break;
    case 'MODULE_CREATED': {
      const { module, title, sandbox, sessionId } = event.payload;
      state.modules[module] = {
        module, title, status: 'designing', architect: { sandbox, sessionId, status: 'starting' }, proposals: [], notes: [], escalations: [],
      };
      break;
    }
    case 'ARCHITECT_LAUNCHED':
      state.modules[event.payload.module]!.architect.status = 'running';
      break;
    case 'PROPOSAL': {
      const module = state.modules[event.payload.module]!;
      module.proposals.push({ version: event.payload.version, sha256: event.payload.sha256, submittedAt: event.ts });
      if (module.status === 'designing') module.status = 'proposed';
      break;
    }
    case 'ARCHITECTURE_ACCEPTED': {
      const module = state.modules[event.payload.module]!;
      const proposal = module.proposals.find((p) => p.version === event.payload.version);
      if (proposal) proposal.acceptedAt = event.ts;
      Object.assign(module, { status: 'decomposing', accepted: event.payload.version });
      module.notes.push({
        key: `note:${event.id}`,
        text: `The owner accepted proposal v${event.payload.version}. Decompose it now: plans, features and checks, owner actions, and ARCHITECTURE.md. Commit on your branch, then call submit_design.`,
      });
      break;
    }
    case 'DESIGN':
      state.modules[event.payload.module]!.submission = {
        requestId: event.payload.requestId, summary: event.payload.summary, head: event.payload.head, at: event.ts,
      };
      break;
    case 'DESIGN_REFUSED': {
      const module = state.modules[event.payload.module]!;
      delete module.submission;
      module.notes.push({ key: `note:${event.id}`, text: `Your design was refused:\n${event.payload.problems.map((p) => `- ${p}`).join('\n')}\nFix it, commit, and call submit_design again.` });
      break;
    }
    case 'DESIGN_SUBMITTED': {
      const module = state.modules[event.payload.module]!;
      module.design = { head: event.payload.head, suspect: event.payload.suspect, summary: module.submission?.summary ?? '', ...(module.design?.pr ? { pr: module.design.pr } : {}) };
      delete module.submission;
      module.status = 'in_review';
      break;
    }
    case 'ARCH_PR_OPENED': {
      const module = state.modules[event.payload.module]!;
      if (module.design) module.design.pr = { number: event.payload.number, url: event.payload.url };
      module.notes.push({ key: `note:${event.id}`, text: `Your design is in Arch PR #${event.payload.number} (${event.payload.url}). The owner reviews and merges it. If CI or the owner asks for changes, commit them and call submit_design again.` });
      break;
    }
    case 'ARCH_PR_CLOSED': {
      const module = state.modules[event.payload.module]!;
      // A design change that was closed leaves the merged design as it was.
      module.status = module.frozenCommit ? 'frozen' : 'decomposing';
      delete module.design;
      module.notes.push({ key: `note:${event.id}`, text: 'The owner closed your Arch PR without merging it. Ask them why before you submit again.' });
      break;
    }
    case 'ARCH_CI_DONE': {
      const module = state.modules[event.payload.module]!;
      if (module.design) module.design.ciNoted = event.payload.sha;
      const failed = event.payload.jobs.filter((j) => j.conclusion !== 'success');
      module.notes.push({
        key: `note:${event.id}`,
        text: failed.length === 0
          ? 'CI passed on your Arch PR. The owner reviews it.'
          : `CI failed on your Arch PR:\n${failed.map((j) => `- ${j.name}: ${j.conclusion}\n${(j.log ?? '').slice(-2000)}`).join('\n')}\nFix it, commit, and call submit_design again.`,
      });
      break;
    }
    case 'DESIGN_FROZEN': {
      const module = state.modules[event.payload.module]!;
      Object.assign(module, { status: 'frozen', frozenCommit: event.payload.commit });
      delete module.design;
      module.notes.push({
        key: `note:${event.id}`,
        text: 'The owner merged your design: it is frozen, and the build starts. Your branch now starts from the new main. A later design change goes through submit_design again.',
      });
      break;
    }
    case 'ARCHITECT_NOTE_SENT': {
      const note = state.modules[event.payload.module]!.notes.find((n) => n.key === event.payload.key);
      if (note) note.sent = true;
      break;
    }
    case 'ESCALATION': {
      const module = state.modules[event.payload.module];
      if (!module) break;
      module.escalations.push({ id: event.payload.requestId, question: event.payload.question, askedAt: event.ts, ...(event.payload.feature ? { feature: event.payload.feature } : {}) });
      module.notes.push({
        key: `note:${event.id}`,
        text: `The Manager asks (escalation ${event.payload.requestId}${event.payload.feature ? `, about ${event.payload.feature}` : ''}):\n${event.payload.question}\nDecide with the owner if needed, then call reply_to_manager.`,
      });
      break;
    }
    case 'DECISION': {
      const escalation = state.modules[event.payload.module]?.escalations.find((e) => e.id === event.payload.escalationId);
      if (escalation) Object.assign(escalation, { decision: event.payload.decision, decidedAt: event.ts });
      state.managers[event.payload.module]?.mail.push({ key: `mail:${event.id}`, kind: 'decision', text: event.payload.decision, requestId: event.payload.escalationId });
      break;
    }
    case 'OWNER_ACTION_CLAIMED':
      state.actions[`${event.payload.module}/${event.payload.action}`] = { status: 'verifying', at: event.ts, ...(event.payload.note ? { note: event.payload.note } : {}) };
      break;
    case 'OWNER_ACTION_DONE': {
      const key = `${event.payload.module}/${event.payload.action}`;
      state.actions[key] = { ...state.actions[key], status: 'done', at: event.ts };
      if (event.payload.gate) state.pendingProgress.push(`${event.ts} gate.satisfied ${key} by=owner "${event.payload.title.replaceAll('"', "'")}"`);
      break;
    }
    case 'OWNER_ACTION_REFUSED': {
      const key = `${event.payload.module}/${event.payload.action}`;
      state.actions[key] = { ...state.actions[key], status: 'refused', at: event.ts, reason: event.payload.reason };
      break;
    }
    case 'WEB_READ':
      break;
  }
  return state;
}

const ACTIVE: AttemptStatus[] = ['starting', 'running', 'collecting', 'checking', 'reviewing'];

/** The one attempt that hasn't reached a terminal status, if any. There is at most one. */
export function activeAttempt(state: State): { feature: FeatureState; attempt: Attempt } | undefined {
  for (const feature of Object.values(state.features)) {
    const attempt = feature.attempts.at(-1);
    if (attempt && ACTIVE.includes(attempt.status)) return { feature, attempt };
  }
  return undefined;
}

/** Attempts that count against the budget of the feature's current definition. */
export function countedAttempts(feature: FeatureState, definitionHash: string): number {
  return feature.attempts.filter((a) => a.definitionHash === definitionHash && a.counts).length;
}

export function interruptions(feature: FeatureState, definitionHash: string): number {
  return feature.attempts.filter((a) => a.definitionHash === definitionHash && a.status === 'interrupted').length;
}

/** The attempt a Developer sandbox runs, if it is still going. */
export function attemptInSandbox(state: State, sandbox: string): { feature: FeatureState; attempt: Attempt } | undefined {
  const active = activeAttempt(state);
  return active?.attempt.sandbox === sandbox ? active : undefined;
}

export function writeSnapshot(file: string, state: State): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, file);
}

function featureOf(state: State, ref: Ref): FeatureState {
  const key = featureKey(ref);
  state.features[key] ??= {
    module: ref.module,
    plan: ref.plan,
    feature: ref.feature!,
    status: 'pending',
    attempts: [],
    extraAttempts: 0,
  };
  return state.features[key];
}

function attemptOf(state: State, ref: Ref): Attempt {
  const attempt = featureOf(state, ref).attempts.find((a) => a.n === ref.attempt);
  if (!attempt) throw new Error(`no attempt ${ref.attempt} for ${featureKey(ref)}`);
  return attempt;
}
