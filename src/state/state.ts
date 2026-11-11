import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CheckResult } from '../checks/runner.ts';
import type { ReviewFinding, ReviewerRole } from '../design/schemas.ts';
import type { Denial } from '../sandbox/refusals.ts';
import type { AgentReading, AttemptOutcome, CiJob, Finding, HarnessEvent, Ref, Usage } from './events.ts';

export type AttemptStatus = 'starting' | 'running' | 'collecting' | 'checking' | 'reviewing' | 'accepted' | 'failed' | 'interrupted';

/** Manual: the owner merges every pull request. Swarm: the daemon merges plans under the policy of v3 §3.2. */
export type Mode = 'manual' | 'swarm';

/**
 * Who merges INFRA and MIXED plans in Swarm (v3 D36): `ceiling`, the daemon only with the
 * cost job's estimate under the ceiling, else the owner; `daemon`, the daemon once CI and
 * the reviewers pass, like CODE plans, an estimate over the ceiling still being the owner's.
 */
export type InfraMerge = 'ceiling' | 'daemon';

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
  /** The attempt merged with the plan's head that moved under it, and checked again, ready to land (v3 §6.3). */
  rebased?: { onto: string; commit: string };
  questions?: Question[];
  /** The requests its sandbox's network policy refused, the latest first. */
  refused?: Denial[];
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
  fix?: { round: number; kind: 'ci' | 'deploy' | 'review'; failure: string; requestId: string; role?: ReviewerRole };
  /**
   * The definitions that CHANGED_LOCKED_FILES PRs gave the feature since it was accepted
   * (v5): it stays accepted under each, as nothing was rebuilt.
   */
  lockedHashes?: string[];
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
  /** Who merged the PR: the daemon under the Swarm policy, or the owner. */
  mergedBy?: 'owner' | 'daemon';
  /** In Swarm, the policy left this head's PR to the owner: the reason shows under Needs you. */
  leftToOwner?: { head: string; reason: string; at: string };
  /** Main at `main` conflicts with the plan branch in `files`: tried once per main, and resolved in the PR. */
  mainConflict?: { main: string; files: string[] };
  /** The cost job's estimate of the monthly cost the PR adds, for the head it was computed on (v3 §5.3). */
  costEstimate?: { head: string; monthlyUsd: number };
  /** The reviewers' sessions on the PR's heads (v3 §5), oldest first. */
  reviews?: ReviewState[];
  /** Fix rounds each reviewer asked for on this PR. */
  reviewFixRounds?: Partial<Record<ReviewerRole, number>>;
  deploy?: { commit: string; status: 'passed' | 'failed'; jobs?: CiJob[] };
  /** `checks`: the hash of the post-deploy checks a failure ran, so a change to them on main checks the plan again (v5). */
  postDeploy?: { status: 'passed' | 'failed'; results: CheckResult[]; checks?: string };
  /** For a Fix PR: what failed after the merge, the apply or the post-deploy checks (v5). */
  fixAfter?: 'deploy' | 'verify';
}

/** One reviewer's session on one PR head (v3 §5). */
export interface ReviewState {
  role: ReviewerRole;
  head: string;
  status: 'starting' | 'running' | 'reported' | 'failed';
  sandbox: string;
  sessionId: string;
  startedAt: string;
  deadline: string;
  endedAt?: string;
  /** How the session ended: a usage limit isn't one of the reviewer's failures. */
  outcome?: AttemptOutcome;
  verdict?: 'pass' | 'block';
  summary?: string;
  findings?: ReviewFinding[];
  usage?: Usage;
  /** Why there is no report. */
  reason?: string;
  posted?: { status: 'success' | 'failure' | 'error'; comments: number; at: string; problem?: string };
  /** A fix round was opened for this review's blocking findings. */
  fixRequested?: boolean;
}

export interface ManagerState {
  module: string;
  /** Set for a plan's Manager, in Swarm (v3 §6.4): its scope is that plan, and its key `module/plan`. */
  plan?: string;
  sandbox: string;
  sessionId: string;
  status: 'starting' | 'running' | 'exited' | 'stopped';
  /** Claude Code processes started in this sandbox so far; the first uses `--session-id`, later ones `--resume`. */
  launch: number;
  /** The harness tools its sandbox was made with: one made before a tool existed doesn't have it. Unknown for one made before 0.5.6. */
  tools?: string[];
  launchedAt?: string;
  /** The size of its output when the current launch started: no growth means Claude never started. */
  launchedOutputBytes?: number;
  /** Recent exits, for the brake on a Manager that keeps stopping. */
  exits: string[];
  lastExit?: { code: number | null; stderr: string; started: boolean };
  /** Items that need a decision, by key: when they were sent in the current launch, and reminded. */
  sent: Record<string, { launch: number; at: string; reminded?: string }>;
  /** Things to deliver once: the owner's messages and answers, the Architect's decisions, and the welcome. */
  mail: Array<{ key: string; kind: 'welcome' | 'owner_message' | 'owner_answer' | 'decision' | 'order_request'; text: string; requestId?: string }>;
}

/**
 * A long-lived agent's totals over its sandboxes. Its cache reads and its active time are
 * read since 0.5.1, each reading for its whole sandbox, so the first counts what came
 * before it; only a sandbox gone before then counts none. `splitInputTokens` is the part
 * of `inputTokens` whose cache reads are known.
 */
export interface AgentTotal extends Usage {
  splitInputTokens?: number;
  activeMs?: number;
}

/**
 * What a CHANGED_LOCKED_FILES change does to one built feature (v5): the fields of its
 * spec, the checks, and the scripts they run that change. `expected` is what its checks
 * must still prove, for the owner who reviews it.
 */
export interface LockedChange {
  plan: string;
  feature: string;
  title: string;
  expected: string;
  fields: string[];
  checks: string[];
  scripts: string[];
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
  /** A CHANGED_LOCKED_FILES change the daemon is checking before it opens its PR (v5). */
  lockedSubmission?: { requestId: string; summary: string; head: string; at: string };
  /** A CHANGED_LOCKED_FILES change under review: what it changes in each built feature, and its PR (v5). */
  locked?: { head: string; summary: string; changes: LockedChange[]; pr?: { number: number; url: string }; ciNoted?: string };
  frozenCommit?: string;
  /** Messages for the Architect, written into its sandbox once and shown with the owner's next prompt. */
  notes: Array<{ key: string; text: string; sent?: boolean }>;
  escalations: Array<{ id: string; question: string; feature?: string; manager?: string; askedAt: string; decision?: string; decidedAt?: string }>;
}

export interface ActionState {
  status: 'verifying' | 'done' | 'refused';
  at: string;
  note?: string;
  reason?: string;
  /** The action's estimate when it was done: it still counts once a redesign drops the action. */
  minutes?: number;
}

export interface OwnerRequest {
  requestId: string;
  module: string;
  /** The key of the Manager that asked. */
  manager?: string;
  question: string;
  blocking: boolean;
  askedAt: string;
  answer?: string;
  answeredAt?: string;
}

/** A card under Needs you as an order request names it: its key, its title, and what the daemon knew of it then, which tells whether it changed since. */
export interface OrderCard {
  key: string;
  title: string;
  print: string;
}

/**
 * The owner's latest request for an order of the cards under Needs you, and the Manager's
 * answer once it came. It is advice about the cards as they were: the dashboard shows it
 * while they are the same, less the ones handled since.
 */
export interface OrderState {
  requestId: string;
  module: string;
  /** The key of the Manager that was asked. */
  manager: string;
  askedAt: string;
  /** The cards as they were, in the standard order. */
  cards: OrderCard[];
  /** The cards' keys in the Manager's order, each with why it is there; `call` is the tool call that gave it. */
  suggestion?: { at: string; call: string; order: Array<{ key: string; why: string }>; summary?: string };
}

/** The projection of the event log that the daemon and the dashboard read. Never edited by hand. */
export interface State {
  v: 1;
  lastEventId?: string;
  daemon?: { pid: number; version: string; startedAt: string };
  pipeline: { paused?: { reason: string; since: string; until?: string }; consecutiveFailures: number };
  mode: Mode;
  /** The owner's button for INFRA and MIXED plans in Swarm (v3 D36). */
  infraMerge: InfraMerge;
  /**
   * What the owner set in the dashboard (v3 §4): their hours for the whole project. An
   * older log may hold AGENT_HOURS_SET, the agent-hours threshold before 0.4.22: nothing
   * reads it any more.
   */
  budgets: { ownerHours?: number; ownerHoursSetAt?: string };
  /**
   * The tokens and active time of the Managers and Architects, by agent (`manager:<key>`,
   * `architect:<module>`): the total so far, and the last reading of their sandbox. A
   * Developer's and a reviewer's are on their attempt and review.
   */
  agentTokens?: Record<string, { total: AgentTotal; reading: AgentReading }>;
  /** What each new sandbox may use of the machine, as the owner set it in the dashboard; no cap without one. */
  sandboxLimits?: { cpu?: number; memoryGiB?: number };
  plans: Record<string, PlanState>;
  features: Record<string, FeatureState>;
  managers: Record<string, ManagerState>;
  ownerRequests: Record<string, OwnerRequest>;
  modules: Record<string, ModuleState>;
  /** Owner actions by "module/action". */
  actions: Record<string, ActionState>;
  /** The order the owner last asked a Manager for, of the cards under Needs you. */
  order?: OrderState;
  /** progress.txt lines waiting for the next feature commit, such as satisfied gates. */
  pendingProgress: string[];
}

export const planKey = (ref: Ref) => `${ref.module}/${ref.plan}`;
export const featureKey = (ref: Ref) => `${ref.module}/${ref.plan}/${ref.feature}`;
/** A Manager's key in `state.managers`: its module, or `module/plan` for a plan's Manager (v3 §6.4). */
export const managerKey = (scope: { module: string; plan?: string | undefined }) => (scope.plan ? `${scope.module}/${scope.plan}` : scope.module);

/** The Managers that aren't stopped and whose scope covers the module, or one plan of it: the plan's own, and the module's. */
export function managersOf(state: State, module: string, plan?: string): ManagerState[] {
  return Object.values(state.managers).filter((m) => m.status !== 'stopped' && m.module === module && (m.plan === undefined || plan === undefined || m.plan === plan));
}

/** The plan's code is on main: its pull request merged, or, without GitHub, the plan complete (v3 §6.1). */
export const planMerged = (plan: PlanState | undefined): boolean => plan !== undefined && (plan.mergeCommit !== undefined || plan.status === 'completed');

export function initialState(): State {
  return { v: 1, pipeline: { consecutiveFailures: 0 }, mode: 'manual', infraMerge: 'ceiling', budgets: {}, plans: {}, features: {}, managers: {}, ownerRequests: {}, modules: {}, actions: {}, pendingProgress: [] };
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
    case 'PLAN_MAIN_MERGED': {
      const plan = state.plans[planKey(ref!)]!;
      Object.assign(plan, { base: event.payload.main, head: event.payload.head });
      delete plan.mainConflict;
      // A PR takes main before the daemon merges it (v3 §3.2): its new head is pushed, and CI runs again.
      if (plan.pr && plan.status === 'ready_to_merge') plan.status = 'pr_open';
      break;
    }
    case 'PLAN_MAIN_CONFLICT':
      state.plans[planKey(ref!)]!.mainConflict = { main: event.payload.main, files: event.payload.files };
      break;
    case 'PLAN_HEAD_ADOPTED':
      Object.assign(state.plans[planKey(ref!)]!, {
        status: 'pr_open', head: event.payload.head, pushed: event.payload.head, ci: { sha: event.payload.head, status: 'pending', since: event.ts },
      });
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
      digest(state, event.id, ref!, `Plan ${ref!.plan}'s pull request #${event.payload.number} is open: ${event.payload.url}.`);
      break;
    case 'CI_PASSED':
    case 'CI_FAILED': {
      const plan = state.plans[planKey(ref!)]!;
      plan.ci = { sha: event.payload.sha, status: event.type === 'CI_PASSED' ? 'passed' : 'failed', since: event.ts, jobs: event.payload.jobs };
      if (event.type === 'CI_PASSED') plan.status = 'ready_to_merge';
      break;
    }
    case 'MODE_CHANGED':
      state.mode = event.payload.mode;
      break;
    case 'INFRA_MERGE_SET':
      state.infraMerge = event.payload.by;
      break;
    case 'OWNER_HOURS_SET':
      if (event.payload.hours === null) {
        delete state.budgets.ownerHours;
        delete state.budgets.ownerHoursSetAt;
      } else {
        state.budgets.ownerHours = event.payload.hours;
        state.budgets.ownerHoursSetAt = event.ts;
      }
      // Every Architect learns of it: the budget bounds the owner actions it may design (v3 §4.1).
      for (const module of Object.values(state.modules)) {
        module.notes.push({
          key: `note:${event.id}`,
          text: event.payload.hours === null
            ? 'The owner cleared their time budget: estimatedMinutes on owner actions is welcome, not required.'
            : `The owner set their time budget: ${event.payload.hours} hours for the whole project. Call get_owner_time for what this module may plan; every owner action needs estimatedMinutes, and submit_design refuses a design over the budget.`,
        });
      }
      break;
    case 'AGENT_TOKENS': {
      const { agent, reading } = event.payload;
      const tokens = (state.agentTokens ??= {});
      const known = tokens[agent];
      // A reading below the last is a new sandbox, whose count starts from zero.
      const grew = known !== undefined && reading.inputTokens >= known.reading.inputTokens && reading.outputTokens >= known.reading.outputTokens;
      const base = grew ? known.reading : undefined;
      const total = known?.total ?? { inputTokens: 0, outputTokens: 0 };
      const next: AgentTotal = {
        inputTokens: total.inputTokens + reading.inputTokens - (base?.inputTokens ?? 0),
        outputTokens: total.outputTokens + reading.outputTokens - (base?.outputTokens ?? 0),
      };
      // Cache reads and time, read since 0.5.1: the first reading of a sandbox that has them counts its whole sandbox.
      if (reading.cacheReadTokens !== undefined) {
        const from = base?.cacheReadTokens !== undefined ? base : undefined;
        next.cacheReadTokens = (total.cacheReadTokens ?? 0) + reading.cacheReadTokens - (from?.cacheReadTokens ?? 0);
        next.splitInputTokens = (total.splitInputTokens ?? 0) + reading.inputTokens - (from?.inputTokens ?? 0);
      } else if (total.cacheReadTokens !== undefined) {
        next.cacheReadTokens = total.cacheReadTokens;
        next.splitInputTokens = total.splitInputTokens ?? 0;
      }
      if (reading.activeMs !== undefined) next.activeMs = (total.activeMs ?? 0) + reading.activeMs - (base?.activeMs ?? 0);
      else if (total.activeMs !== undefined) next.activeMs = total.activeMs;
      tokens[agent] = {
        total: next,
        reading: {
          inputTokens: reading.inputTokens,
          outputTokens: reading.outputTokens,
          ...(reading.cacheReadTokens !== undefined ? { cacheReadTokens: reading.cacheReadTokens } : {}),
          ...(reading.activeMs !== undefined ? { activeMs: reading.activeMs } : {}),
        },
      };
      break;
    }
    case 'SANDBOX_LIMITS_SET': {
      const { cpu, memoryGiB } = event.payload;
      if (cpu === null && memoryGiB === null) delete state.sandboxLimits;
      else state.sandboxLimits = { ...(cpu !== null ? { cpu } : {}), ...(memoryGiB !== null ? { memoryGiB } : {}) };
      break;
    }
    case 'PR_LEFT_TO_OWNER':
      state.plans[planKey(ref!)]!.leftToOwner = { head: event.payload.head, reason: event.payload.reason, at: event.ts };
      digest(state, event.id, ref!, `Pull request #${event.payload.number} of plan ${ref!.plan} waits for the owner: ${event.payload.reason}`);
      break;
    case 'PR_MERGED_BY_DAEMON':
      state.plans[planKey(ref!)]!.mergedBy = 'daemon';
      break;
    case 'COST_ESTIMATED':
      state.plans[planKey(ref!)]!.costEstimate = { head: event.payload.head, monthlyUsd: event.payload.monthlyUsd };
      break;
    case 'PR_MERGED': {
      const plan = state.plans[planKey(ref!)]!;
      Object.assign(plan, { status: event.payload.next, mergeCommit: event.payload.commit, mergedAt: event.ts, head: event.payload.commit, mergedBy: plan.mergedBy ?? 'owner' });
      delete plan.leftToOwner;
      delete plan.deploy;
      delete plan.postDeploy;
      if (event.payload.next === 'completed') for (const manager of managersOf(state, ref!.module, ref!.plan)) manager.sent = {};
      digest(state, event.id, ref!, `Plan ${ref!.plan} is merged on main${plan.mergedBy === 'daemon' ? ' by the daemon' : ''}${event.payload.next === 'completed' ? ', and complete' : `: it is ${event.payload.next}`}.`);
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
      for (const manager of managersOf(state, ref!.module, ref!.plan)) manager.sent = {};
      break;
    }
    case 'POST_DEPLOY_CHECKS_FAILED': {
      const { results, checks } = event.payload;
      Object.assign(state.plans[planKey(ref!)]!, { status: 'verify_failed', postDeploy: { status: 'failed', results, ...(checks ? { checks } : {}) } });
      break;
    }
    case 'POST_DEPLOY_RECHECK': {
      const plan = state.plans[planKey(ref!)]!;
      plan.status = 'verifying';
      delete plan.postDeploy;
      break;
    }
    case 'PR_CLOSED': {
      const plan = state.plans[planKey(ref!)]!;
      if (plan.pr) plan.pr.closed = true;
      break;
    }
    case 'REQUEST_FIX': {
      const plan = state.plans[planKey(ref!)]!;
      const kind = event.payload.review ? 'review' : plan.status === 'deploy_failed' || plan.status === 'verify_failed' ? 'deploy' : 'ci';
      let round: number;
      if (kind === 'review') {
        // A reviewer blocked the PR: its own rounds, on the plan branch like a CI fix (v3 §5.4).
        const role = event.payload.review!;
        round = (plan.reviewFixRounds?.[role] ?? 0) + 1;
        plan.reviewFixRounds = { ...plan.reviewFixRounds, [role]: round };
        const review = plan.reviews?.findLast((r) => r.role === role && r.head === plan.head && r.status === 'reported');
        if (review) review.fixRequested = true;
      } else if (kind === 'deploy') {
        // A Fix PR: a new branch from the merge, and a new pull request (§11.3); its title says what failed (v5).
        round = (plan.deployFixRounds ?? 0) + 1;
        Object.assign(plan, {
          deployFixRounds: round, branch: `fix/${plan.module}/${plan.plan}-${round}`, base: plan.mergeCommit, head: plan.mergeCommit, fixRounds: 0,
          fixAfter: plan.status === 'verify_failed' ? 'verify' : 'deploy',
        });
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
        guidance: event.payload.guidance,
        fix: { round, kind, failure: event.payload.failure, requestId: event.payload.requestId, ...(event.payload.review ? { role: event.payload.review } : {}) },
      };
      break;
    }
    case 'REVIEW_STARTING': {
      const plan = state.plans[planKey(ref!)]!;
      const { role, head, sandbox, sessionId, deadline } = event.payload;
      (plan.reviews ??= []).push({ role, head, status: 'starting', sandbox, sessionId, startedAt: event.ts, deadline });
      break;
    }
    case 'REVIEW_STARTED':
      reviewOf(state, ref!, event.payload).status = 'running';
      break;
    case 'REVIEW_ENDED': {
      const review = reviewOf(state, ref!, event.payload);
      const { outcome, verdict, summary, findings, usage, reason } = event.payload;
      review.endedAt = event.ts;
      review.outcome = outcome;
      if (usage) review.usage = usage;
      if (outcome === 'done' && verdict) Object.assign(review, { status: 'reported', verdict, summary, findings: findings ?? [] });
      else Object.assign(review, { status: 'failed', reason: reason ?? outcome });
      break;
    }
    case 'REVIEW_POSTED': {
      const review = reviewOf(state, ref!, event.payload);
      const { status, comments, problem } = event.payload;
      review.posted = { status, comments, at: event.ts, ...(problem ? { problem } : {}) };
      if (review.verdict === 'block') {
        const blocking = (review.findings ?? []).filter((f) => f.severity === 'blocking').map((f) => f.title).join('; ');
        digest(state, event.id, ref!, `The ${review.role} reviewer blocked plan ${ref!.plan}'s pull request at ${review.head.slice(0, 8)}: ${blocking}`);
      }
      break;
    }
    case 'PLAN_COMPLETED': {
      const plan = state.plans[planKey(ref!)]!;
      plan.status = 'completed';
      plan.head = event.payload.head;
      for (const manager of managersOf(state, ref!.module, ref!.plan)) manager.sent = {};
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
    case 'NETWORK_REFUSED':
      attemptOf(state, ref!).refused = event.payload.requests;
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
    case 'ATTEMPT_REBASED':
      attemptOf(state, ref!).rebased = { onto: event.payload.onto, commit: event.payload.commit };
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
        ...(event.payload.manager ? { manager: event.payload.manager } : {}),
        question: event.payload.question,
        blocking: event.payload.blocking,
        askedAt: event.ts,
      };
      break;
    case 'OWNER_ANSWER': {
      const request = state.ownerRequests[event.payload.requestId];
      if (request) Object.assign(request, { answer: event.payload.answer, answeredAt: event.ts });
      for (const manager of mailTargets(state, event.payload.module, request?.manager)) {
        manager.mail.push({ key: `mail:${event.id}`, kind: 'owner_answer', text: event.payload.answer, requestId: event.payload.requestId });
      }
      break;
    }
    case 'OWNER_MESSAGE':
      for (const manager of mailTargets(state, event.payload.module, event.payload.manager)) {
        manager.mail.push({ key: `mail:${event.id}`, kind: 'owner_message', text: event.payload.text });
      }
      break;
    case 'ORDER_REQUESTED': {
      // The latest request is the only one: an answer to an earlier one is refused.
      const { requestId, module, manager, cards, text } = event.payload;
      state.order = { requestId, module, manager, askedAt: event.ts, cards };
      // An earlier request still waiting to be delivered is about cards as they no longer are.
      for (const other of Object.values(state.managers)) other.mail = other.mail.filter((mail) => mail.kind !== 'order_request');
      const asked = state.managers[manager];
      if (asked && asked.status !== 'stopped') asked.mail.push({ key: `mail:${event.id}`, kind: 'order_request', text, requestId });
      break;
    }
    case 'ORDER_SUGGESTED': {
      const { requestId, call, order, summary } = event.payload;
      if (state.order?.requestId === requestId) state.order.suggestion = { at: event.ts, call, order, ...(summary ? { summary } : {}) };
      break;
    }
    case 'MANAGER_STARTING': {
      const { module, plan, sandbox, sessionId } = event.payload;
      const key = managerKey(event.payload);
      const mail = state.managers[key]?.mail.filter((m) => m.kind !== 'welcome') ?? [];
      state.managers[key] = {
        module, ...(plan ? { plan } : {}), sandbox, sessionId, status: 'starting', launch: 0, exits: [], sent: {},
        mail: [{ key: `mail:${event.id}`, kind: 'welcome', text: '' }, ...mail],
      };
      break;
    }
    case 'MANAGER_LAUNCHED':
      Object.assign(state.managers[managerKey(event.payload)]!, {
        status: 'running', launch: event.payload.launch, launchedAt: event.ts, launchedOutputBytes: event.payload.outputBytes,
        ...(event.payload.tools ? { tools: event.payload.tools } : {}),
      });
      break;
    case 'MANAGER_EXITED': {
      const manager = state.managers[managerKey(event.payload)]!;
      manager.status = 'exited';
      manager.exits = [...manager.exits, event.ts].slice(-5);
      manager.lastExit = { code: event.payload.code, stderr: event.payload.stderr, started: event.payload.started };
      break;
    }
    case 'MANAGER_ITEM_SENT': {
      const manager = state.managers[managerKey(event.payload)]!;
      const { key, launch, reminder } = event.payload;
      if (key.startsWith('mail:')) manager.mail = manager.mail.filter((m) => m.key !== key);
      else if (reminder) manager.sent[key] = { ...manager.sent[key]!, reminded: event.ts };
      else manager.sent[key] = { launch, at: event.ts };
      break;
    }
    case 'MANAGER_STOPPED':
      state.managers[managerKey(event.payload)]!.status = 'stopped';
      break;
    case 'PIPELINE_PAUSED':
      state.pipeline.paused = { reason: event.payload.reason, since: event.ts, until: event.payload.until };
      break;
    case 'PIPELINE_RESUMED':
      delete state.pipeline.paused;
      state.pipeline.consecutiveFailures = 0;
      // The owner looked: waiting items start a fresh turn, a failed full check run runs again,
      // a failed deploy is looked at again (the owner may have fixed it, or re-run the apply),
      // and a Manager that kept stopping gets another chance.
      for (const manager of Object.values(state.managers)) Object.assign(manager, { sent: {}, exits: [] });
      for (const plan of Object.values(state.plans)) {
        if (plan.validation?.status === 'failed') delete plan.validation;
        if (plan.status === 'deploy_failed') {
          plan.status = 'deploying';
          delete plan.deploy;
        } else if (plan.status === 'verify_failed') {
          plan.status = 'verifying';
          delete plan.postDeploy;
        }
      }
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
    case 'LOCKED_CHANGE':
      state.modules[event.payload.module]!.lockedSubmission = {
        requestId: event.payload.requestId, summary: event.payload.summary, head: event.payload.head, at: event.ts,
      };
      break;
    case 'LOCKED_CHANGE_REFUSED': {
      const module = state.modules[event.payload.module]!;
      delete module.lockedSubmission;
      module.notes.push({ key: `note:${event.id}`, text: `Your change to locked files was refused:\n${event.payload.problems.map((p) => `- ${p}`).join('\n')}\nFix it, commit, and call submit_locked_change again.` });
      break;
    }
    case 'LOCKED_CHANGE_SUBMITTED': {
      const module = state.modules[event.payload.module]!;
      module.locked = {
        head: event.payload.head, summary: module.lockedSubmission?.summary ?? '', changes: event.payload.changes,
        ...(module.locked?.pr ? { pr: module.locked.pr } : {}),
      };
      delete module.lockedSubmission;
      break;
    }
    case 'LOCKED_CHANGE_MERGED': {
      const module = state.modules[event.payload.module]!;
      delete module.locked;
      for (const { feature, definitionHash } of event.payload.rehash) {
        const changed = state.features[feature];
        if (changed && !changed.lockedHashes?.includes(definitionHash)) changed.lockedHashes = [...(changed.lockedHashes ?? []), definitionHash];
      }
      module.notes.push({
        key: `note:${event.id}`,
        text: 'The owner merged your change to locked files. The features it changed stay accepted, and a plan whose post-deploy checks changed is checked again.',
      });
      break;
    }
    case 'ARCH_PR_OPENED': {
      if (event.payload.locked) {
        const module = state.modules[event.payload.module]!;
        if (module.locked) module.locked.pr = { number: event.payload.number, url: event.payload.url };
        module.notes.push({ key: `note:${event.id}`, text: `Your change to locked files is in PR #${event.payload.number} (${event.payload.url}). The owner reviews and merges it. If CI or the owner asks for changes, commit them on the same branch and call submit_locked_change again.` });
        break;
      }
      const module = state.modules[event.payload.module]!;
      if (module.design) module.design.pr = { number: event.payload.number, url: event.payload.url };
      module.notes.push({ key: `note:${event.id}`, text: `Your design is in Arch PR #${event.payload.number} (${event.payload.url}). The owner reviews and merges it. If CI or the owner asks for changes, commit them and call submit_design again.` });
      break;
    }
    case 'ARCH_PR_CLOSED': {
      if (event.payload.locked) {
        const module = state.modules[event.payload.module]!;
        delete module.locked;
        module.notes.push({ key: `note:${event.id}`, text: 'The owner closed your CHANGED_LOCKED_FILES PR without merging it. Ask them why before you submit again.' });
        break;
      }
      const module = state.modules[event.payload.module]!;
      // A design change that was closed leaves the merged design as it was.
      module.status = module.frozenCommit ? 'frozen' : 'decomposing';
      delete module.design;
      module.notes.push({ key: `note:${event.id}`, text: 'The owner closed your Arch PR without merging it. Ask them why before you submit again.' });
      break;
    }
    case 'ARCH_CI_DONE': {
      const module = state.modules[event.payload.module]!;
      if (event.payload.locked) {
        if (module.locked) module.locked.ciNoted = event.payload.sha;
      } else if (module.design) module.design.ciNoted = event.payload.sha;
      const tool = event.payload.locked ? 'submit_locked_change' : 'submit_design';
      const failed = event.payload.jobs.filter((j) => j.conclusion !== 'success');
      module.notes.push({
        key: `note:${event.id}`,
        text: failed.length === 0
          ? 'CI passed on your Arch PR. The owner reviews it.'
          : `CI failed on your Arch PR:\n${failed.map((j) => `- ${j.name}: ${j.conclusion}\n${(j.log ?? '').slice(-2000)}`).join('\n')}\nFix it, commit, and call ${tool} again.`,
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
      module.escalations.push({
        id: event.payload.requestId, question: event.payload.question, askedAt: event.ts,
        ...(event.payload.feature ? { feature: event.payload.feature } : {}), ...(event.payload.manager ? { manager: event.payload.manager } : {}),
      });
      module.notes.push({
        key: `note:${event.id}`,
        text: `The Manager asks (escalation ${event.payload.requestId}${event.payload.feature ? `, about ${event.payload.feature}` : ''}):\n${event.payload.question}\nDecide with the owner if needed, then call reply_to_manager.`,
      });
      break;
    }
    case 'DECISION': {
      const escalation = state.modules[event.payload.module]?.escalations.find((e) => e.id === event.payload.escalationId);
      if (escalation) Object.assign(escalation, { decision: event.payload.decision, decidedAt: event.ts });
      for (const manager of mailTargets(state, event.payload.module, escalation?.manager)) {
        manager.mail.push({ key: `mail:${event.id}`, kind: 'decision', text: event.payload.decision, requestId: event.payload.escalationId });
      }
      break;
    }
    case 'OWNER_ACTION_CLAIMED':
      state.actions[`${event.payload.module}/${event.payload.action}`] = { status: 'verifying', at: event.ts, ...(event.payload.note ? { note: event.payload.note } : {}) };
      break;
    case 'OWNER_ACTION_DONE': {
      const key = `${event.payload.module}/${event.payload.action}`;
      state.actions[key] = { ...state.actions[key], status: 'done', at: event.ts, ...(event.payload.minutes === undefined ? {} : { minutes: event.payload.minutes }) };
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

/** Every attempt under way, in the features' order: one in Manual, up to `swarm.maxDevelopers` in Swarm (v3 §6.2). */
export function activeAttempts(state: State): Array<{ feature: FeatureState; attempt: Attempt }> {
  const active: Array<{ feature: FeatureState; attempt: Attempt }> = [];
  for (const feature of Object.values(state.features)) {
    const attempt = feature.attempts.at(-1);
    if (attempt && ACTIVE.includes(attempt.status)) active.push({ feature, attempt });
  }
  return active;
}

/** Whether a feature has an attempt under way. */
export function isActive(feature: FeatureState): boolean {
  const attempt = feature.attempts.at(-1);
  return attempt !== undefined && ACTIVE.includes(attempt.status);
}

/** Attempts that count against the budget of the feature's current definition. */
export function countedAttempts(feature: FeatureState, definitionHash: string): number {
  return feature.attempts.filter((a) => a.definitionHash === definitionHash && a.counts).length;
}

export function interruptions(feature: FeatureState, definitionHash: string): number {
  return feature.attempts.filter((a) => a.definitionHash === definitionHash && a.status === 'interrupted').length;
}

/** The attempt a Developer sandbox runs, if it is still going: each attempt has its own sandbox. */
export function attemptInSandbox(state: State, sandbox: string): { feature: FeatureState; attempt: Attempt } | undefined {
  return activeAttempts(state).find((a) => a.attempt.sandbox === sandbox);
}

export function writeSnapshot(file: string, state: State): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, file);
}

/** Who gets a piece of mail: the Manager named, while it runs, or else every Manager of the module. */
function mailTargets(state: State, module: string, manager?: string): ManagerState[] {
  const named = manager ? state.managers[manager] : undefined;
  return named && named.status !== 'stopped' ? [named] : managersOf(state, module);
}

/** One line for the module's Architect, when it has one (v3 §6.5): what happens to its plans, without the detail the owner sees. */
function digest(state: State, eventId: string, ref: Ref, text: string): void {
  const module = state.modules[ref.module];
  if (module) module.notes.push({ key: `note:${eventId}`, text: `[digest] ${text}` });
}

/** The latest session of a reviewer on a head: the one the event is about. */
function reviewOf(state: State, ref: Ref, which: { role: ReviewerRole; head: string }): ReviewState {
  const review = state.plans[planKey(ref)]?.reviews?.findLast((r) => r.role === which.role && r.head === which.head);
  if (!review) throw new Error(`no ${which.role} review of ${planKey(ref)} on ${which.head.slice(0, 8)}`);
  return review;
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
