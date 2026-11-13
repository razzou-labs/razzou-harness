import { closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { dirname } from 'node:path';
import type { CheckResult } from '../checks/runner.ts';
import type { ReviewFinding, ReviewerRole } from '../design/schemas.ts';
import type { Party, Role } from '../roles.ts';
import type { Denial } from '../sandbox/refusals.ts';
import type { ActionState, FeatureState, FixMerge, InfraMerge, LockedChange, Mode, OrderCard, PlanState, ReviewScope } from './state.ts';

/** What an event is about. Ids repeat across modules, so a feature is always addressed with its module and plan. */
export interface Ref {
  module: string;
  plan: string;
  feature?: string;
  attempt?: number;
}

export interface Usage {
  /** Every token read, the prompt cache's included. */
  inputTokens: number;
  outputTokens: number;
  /** Of `inputTokens`, what the prompt cache served; unknown in what was recorded before 0.5.1. */
  cacheReadTokens?: number;
  costUsd?: number;
}

/** What the daemon reads of a long-lived agent's sandbox: its tokens, and the time it spent on its prompts (0.5.1). */
export interface AgentReading extends Usage {
  activeMs?: number;
}

export interface Finding {
  category: string;
  summary: string;
  tried?: string[];
  needs?: string;
}

/** `usage_limit` and `api_error` are nobody's failure: the subscription's limit was reached, or the model's API failed. */
export type AttemptOutcome = 'done' | 'blocked' | 'timed_out' | 'no_report' | 'error' | 'usage_limit' | 'api_error' | 'aborted';

/** One required CI job, as the daemon saw it. */
export interface CiJob {
  name: string;
  conclusion: string;
  url?: string;
  /** The end of its log, when it failed. */
  log?: string;
}

/**
 * Everything in the log. Events are facts only the daemon establishes. Messages are what
 * an agent or the owner said, recorded once the daemon has checked them; their `from` is
 * the sandbox they came from, never what they claim.
 */
interface Payloads {
  DAEMON_STARTED: { version: string; pid: number };
  /** `harness recover` rebuilt what git and GitHub still know, after `.harness/` was lost (§15.2). */
  RECOVERED: { plans: Record<string, PlanState>; features: Record<string, FeatureState>; actions: Record<string, ActionState>; notes: string[] };
  DAEMON_STOPPED: Record<string, never>;
  PLAN_STARTED: { branch: string; base: string };
  /** Main moved while the plan was built, as a design change makes it: merged into the plan branch. */
  PLAN_MAIN_MERGED: { main: string; head: string };
  /**
   * Main moved, but its changes conflict with the plan branch's in `files`: nothing new
   * starts in the plan until its Manager has the conflict resolved in a merge round.
   */
  PLAN_MAIN_CONFLICT: { main: string; files: string[] };
  /** The owner pushed to the plan's PR branch on GitHub, on top of what the harness pushed: the daemon builds on the new head. */
  PLAN_HEAD_ADOPTED: { head: string };
  PLAN_COMPLETED: { head: string };
  ATTEMPT_STARTING: { sandbox: string; base: string; sessionId: string; deadline: string; definitionHash: string };
  ATTEMPT_STARTED: Record<string, never>;
  BASELINE_FAILED: { reason: string; results: CheckResult[] };
  ATTEMPT_ENDED: { outcome: AttemptOutcome; summary?: string; notes?: string; finding?: Finding; usage?: Usage };
  /** What the attempt's sandbox policy refused, read from OpenShell's log before the sandbox went: for the Manager and the owner. */
  NETWORK_REFUSED: { requests: Denial[] };
  ATTEMPT_INTERRUPTED: { reason: string; counts: boolean };
  CHECKS_STARTED: { head: string; files: string[] };
  /** Another feature landed first (v3 §6.3): the plan's head was merged into the attempt, and the checks passed again on the result. */
  ATTEMPT_REBASED: { onto: string; commit: string; results: CheckResult[] };
  CHECKS_PASSED: { results: CheckResult[] };
  CHECKS_FAILED: { results: CheckResult[] };
  FEATURE_ACCEPTED: { commit: string };
  ATTEMPT_FAILED: { reason: string };
  ESCALATED: { reason: string };
  OWNER_RETRY: { note?: string };
  /**
   * `until`: the daemon lifts the pause itself then. `retry`: it only waits to look again,
   * after something outside the build didn't answer, such as GitHub; nobody is asked.
   */
  PIPELINE_PAUSED: { reason: string; until?: string; retry?: boolean };
  /** `auto`: the daemon lifted a timed pause, not the owner. */
  PIPELINE_RESUMED: { auto?: boolean };
  PLAN_VALIDATING: { head: string };
  /**
   * The checks of the work accepted on a plan's branch, run at `head`: the full run once
   * every feature is accepted, the one before an attempt starts, or either run again.
   */
  PLAN_CHECKS_PASSED: { results: CheckResult[]; head?: string };
  PLAN_CHECKS_FAILED: { results: CheckResult[]; head?: string };
  /** A Manager's scope is its module, or one plan of it in Swarm (v3 §6.4): `plan` names it. */
  MANAGER_STARTING: { module: string; plan?: string; sandbox: string; sessionId: string };
  /** `tools`: the harness tools of a sandbox just made, which it keeps for its life; absent on a relaunch in the same sandbox. */
  MANAGER_LAUNCHED: { module: string; plan?: string; launch: number; outputBytes: number; tools?: string[] };
  MANAGER_EXITED: { module: string; plan?: string; launch: number; code: number | null; stderr: string; started: boolean };
  MANAGER_ITEM_SENT: { module: string; plan?: string; key: string; launch: number; reminder: boolean };
  MANAGER_STOPPED: { module: string; plan?: string; reason: string };
  /**
   * A turn of the Manager ended on the model's API failing: what it was sent is sent
   * again, once `until` has passed, since a failing API is tried no faster than that.
   */
  MANAGER_TURN_FAILED: { module: string; plan?: string; reason: string; until: string };
  WEB_READ: { role: Role; sandbox: string; url: string; finalUrl?: string; status?: number; bytes: number; ok: boolean };
  PLAN_PUSHED: { head: string };
  PR_OPENED: { number: number; url: string };
  CI_PASSED: { sha: string; jobs: CiJob[] };
  CI_FAILED: { sha: string; jobs: CiJob[] };
  /** `next`: what the merge leads to, from what it changed and which checks the plan has. */
  PR_MERGED: { commit: string; next: 'deploying' | 'verifying' | 'completed' };
  DEPLOYED: { commit: string; verify: boolean };
  DEPLOY_FAILED: { commit: string; jobs: CiJob[] };
  PLAN_VERIFIED: { results: CheckResult[] };
  /** `checks`: the hash of the post-deploy checks that ran, which a change on main is told apart from (v5). */
  POST_DEPLOY_CHECKS_FAILED: { results: CheckResult[]; checks?: string };
  /** A plan whose post-deploy checks failed is checked again: its checks changed on main since (v5). */
  POST_DEPLOY_RECHECK: { reason: string };
  PR_CLOSED: Record<string, never>;
  MODULE_CREATED: { module: string; title: string; sandbox: string; sessionId: string };
  /** The Architect's sandbox is gone, and is made again: a new conversation, which starts from what the state knows. */
  ARCHITECT_STARTING: { module: string };
  ARCHITECT_LAUNCHED: { module: string };
  ARCHITECTURE_ACCEPTED: { module: string; version: number };
  DESIGN_REFUSED: { module: string; requestId: string; problems: string[] };
  /** `summary`: for a design taken up again from a pull request the owner closed, then opened again. */
  DESIGN_SUBMITTED: { module: string; head: string; suspect: string[]; summary?: string; settings?: string[] };
  /** `locked`: the PR of a CHANGED_LOCKED_FILES change, not of a design (v5). */
  ARCH_PR_OPENED: { module: string; number: number; url: string; locked?: boolean };
  ARCH_PR_CLOSED: { module: string; locked?: boolean };
  ARCH_CI_DONE: { module: string; sha: string; jobs: CiJob[]; locked?: boolean };
  DESIGN_FROZEN: { module: string; commit: string };
  LOCKED_CHANGE_REFUSED: { module: string; requestId: string; problems: string[] };
  /** A change to built features' definitions, ready for the owner: `changes` says what changes in each. */
  LOCKED_CHANGE_SUBMITTED: { module: string; head: string; changes: LockedChange[] };
  /** The owner merged it: each changed feature stays accepted under its new definition's hash. */
  LOCKED_CHANGE_MERGED: { module: string; commit: string; rehash: Array<{ feature: string; definitionHash: string }> };
  ARCHITECT_NOTE_SENT: { module: string; key: string };
  OWNER_ACTION_CLAIMED: { module: string; action: string; note?: string };
  /** `minutes`: the action's estimate when it was done, so the owner's time used survives a redesign that drops it. */
  OWNER_ACTION_DONE: { module: string; action: string; title: string; gate: boolean; minutes?: number };
  OWNER_ACTION_REFUSED: { module: string; action: string; reason: string };
  /** The owner switched the mode (v3 §2.1); it takes effect at item boundaries. */
  MODE_CHANGED: { mode: Mode };
  /** The owner's button (v3 D36): the daemon merges INFRA and MIXED plans like CODE ones, or only under the cost ceiling. */
  INFRA_MERGE_SET: { by: InfraMerge };
  /** The owner's switch for Fix PRs in Swarm: the daemon merges them under the plans' policy, or they wait for the owner. */
  FIX_MERGE_SET: { by: FixMerge };
  /** The owner switched a reviewer: every plan's pull request, those of infrastructure plans only, or none. */
  REVIEWS_SET: { role: ReviewerRole; scope: ReviewScope };
  /** The owner set, or cleared with null, the hours a module may take of their time: each module has its own. */
  OWNER_HOURS_SET: { module: string; hours: number | null };
  /**
   * What a long-lived agent, a Manager or an Architect, has used of Claude, read from the
   * conversations saved in its sandbox: a running count, which a new sandbox starts again.
   */
  AGENT_TOKENS: { agent: string; reading: AgentReading };
  /** The owner capped what each new sandbox may use of the machine, CPUs and memory; null lifts a cap. */
  SANDBOX_LIMITS_SET: { cpu: number | null; memoryGiB: number | null };
  /** In Swarm, the merge policy left a plan's PR to the owner, and why (v3 §3.2). */
  PR_LEFT_TO_OWNER: { number: number; head: string; reason: string };
  /** The cost job's estimate of the monthly cost the PR's head adds, read from its artifact (v3 §5.3); `source` names the field it came from. */
  COST_ESTIMATED: { head: string; monthlyUsd: number; source: string };
  /** The daemon merged a plan's PR under the Swarm policy (v3 §3.2); PR_MERGED follows. */
  PR_MERGED_BY_DAEMON: { number: number; head: string; commit: string };
  /** A reviewer's session on a PR head (v3 §5): starting, started, and ended with its report or why there is none. */
  REVIEW_STARTING: { role: ReviewerRole; head: string; sandbox: string; sessionId: string; deadline: string };
  /** `deadline`: its clock starts once its session does. */
  REVIEW_STARTED: { role: ReviewerRole; head: string; deadline?: string };
  REVIEW_ENDED: {
    role: ReviewerRole; head: string; outcome: AttemptOutcome;
    verdict?: 'pass' | 'block'; summary?: string; findings?: ReviewFinding[]; usage?: Usage; reason?: string;
  };
  /** A reviewer the owner switched off, or away from CODE plans, didn't read this head: in Swarm its status is set as passed, saying so. */
  REVIEW_SKIPPED: { role: ReviewerRole; head: string; why: 'off' | 'code' };
  /** The review posted on the PR as comments, and the commit status set, or what went wrong. */
  /** `retry`: what went wrong may pass, as a server error does, so the post is made again. */
  REVIEW_POSTED: { role: ReviewerRole; head: string; status: 'success' | 'failure' | 'error'; comments: number; problem?: string; retry?: boolean };

  // Messages.
  QUESTION: { requestId: string; question: string };
  CONTINUE: { requestId: string; answer: string };
  ACCEPT: { requestId: string; note?: string };
  REJECT: { requestId: string; guidance: string };
  /** `granted`: what gave a feature out of attempts one more, the Architect's decision (`escalation:<id>`) or the owner's answer (`request:<id>`). */
  RETRY: { requestId: string; guidance: string; granted?: string };
  ABORT: { requestId: string; reason: string };
  /** `manager` is the key of the Manager that asked, so the answer reaches it when several manage the module (v3 §6.4). */
  OWNER_REQUEST: { module: string; requestId: string; question: string; blocking: boolean; manager?: string };
  OWNER_ANSWER: { module: string; requestId: string; answer: string };
  /** `manager` names one Manager by key; without it, every Manager of the module hears it. */
  OWNER_MESSAGE: { module: string; text: string; manager?: string };
  /**
   * The owner asks a Manager in which order to handle the cards under Needs you: the cards
   * as they are, and the request as the Manager reads it, with what handling each sets off.
   */
  ORDER_REQUESTED: { module: string; requestId: string; manager: string; cards: OrderCard[]; text: string };
  /** The Manager's answer: the request's cards in its order, each with why; `call` is its tool call. It changes nothing else. */
  ORDER_SUGGESTED: { module: string; requestId: string; call: string; order: Array<{ key: string; why: string }>; summary?: string };
  PLAN_SUBMITTED: { requestId: string; summary: string };
  /**
   * The Manager asks for a fix round after CI failed, or the daemon after a reviewer
   * blocked (`review`); `failure` is what was reported. With `merge`, the round merges
   * main at that commit into the plan branch, which conflicts with it in `files`. With
   * `checks`, it makes the work accepted on the plan branch pass its checks again.
   */
  REQUEST_FIX: { requestId: string; guidance: string; failure: string; review?: ReviewerRole; merge?: { main: string; files: string[] }; checks?: boolean };
  PROPOSAL: { module: string; requestId: string; version: number; sha256: string };
  /** The Architect submits its design; `head` is its commit, now in the daemon's repository. */
  DESIGN: { module: string; requestId: string; summary: string; head: string };
  /** The Architect submits a change to built features' definitions (v5); `head` is its commit. */
  LOCKED_CHANGE: { module: string; requestId: string; summary: string; head: string };
  ESCALATION: { module: string; requestId: string; question: string; feature?: string; manager?: string };
  DECISION: { module: string; requestId: string; escalationId: string; decision: string };
}

export type EventType = keyof Payloads;

const MESSAGES: ReadonlySet<EventType> = new Set<EventType>([
  'QUESTION', 'CONTINUE', 'ACCEPT', 'REJECT', 'RETRY', 'ABORT', 'OWNER_REQUEST', 'OWNER_ANSWER', 'OWNER_MESSAGE', 'ORDER_REQUESTED', 'ORDER_SUGGESTED',
  'PLAN_SUBMITTED', 'REQUEST_FIX',
  'PROPOSAL', 'DESIGN', 'LOCKED_CHANGE', 'ESCALATION', 'DECISION',
]);

export type HarnessEvent = {
  [T in EventType]: {
    v: 1;
    kind: 'event' | 'message';
    id: string;
    ts: string;
    type: T;
    ref?: Ref;
    from?: Party;
    to?: Party;
    payload: Payloads[T];
  };
}[EventType];

export type NewEvent = { [T in EventType]: { type: T; ref?: Ref; from?: Party; to?: Party; payload: Payloads[T] } }[EventType];

/**
 * The append-only log in `.harness/events.jsonl`. Every line is one event or message,
 * written and fsynced before the step it records goes on. State is a projection of this
 * file.
 */
export class EventStore {
  readonly file: string;
  private readonly now: () => number;
  private seq = 0;

  /** `now` stamps the events: the daemon's clock, so that what it compares them with reads the same time. */
  constructor(file: string, now: () => number = Date.now) {
    this.file = file;
    this.now = now;
    mkdirSync(dirname(file), { recursive: true });
    this.dropTornLastLine();
  }

  /** Every event, read a piece of the file at a time: a log of months is larger than the longest string Node can hold. */
  readAll(): HarnessEvent[] {
    if (!existsSync(this.file)) return [];
    const events: HarnessEvent[] = [];
    const fd = openSync(this.file, 'r');
    try {
      const decoder = new StringDecoder('utf8');
      const buffer = Buffer.alloc(1024 * 1024);
      let rest = '';
      let n = 0;
      const take = (line: string) => {
        n += 1;
        if (line.trim() === '') return;
        try {
          events.push(JSON.parse(line) as HarnessEvent);
        } catch {
          throw new Error(`${this.file}: line ${n} is not valid JSON`);
        }
      };
      for (let read = readSync(fd, buffer); read > 0; read = readSync(fd, buffer)) {
        const lines = (rest + decoder.write(buffer.subarray(0, read))).split('\n');
        rest = lines.pop()!;
        lines.forEach(take);
      }
      rest += decoder.end();
      if (rest !== '') take(rest);
    } finally {
      closeSync(fd);
    }
    return events;
  }

  append(event: NewEvent): HarnessEvent {
    const kind = MESSAGES.has(event.type) ? 'message' : 'event';
    const stamped = { v: 1, kind, id: this.nextId(), ts: new Date(this.now()).toISOString(), ...event } as HarnessEvent;
    const fd = openSync(this.file, 'a');
    try {
      writeSync(fd, `${JSON.stringify(stamped)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return stamped;
  }

  /** A crash can leave half a line at the end of the log; drop it so the next append starts clean. */
  /**
   * A last line without its newline is what a crash mid-write leaves: kept with a newline
   * when it is a whole event, dropped otherwise. Only the last line is read, found by
   * looking back from the end a piece at a time: one event may be larger than any piece.
   */
  private dropTornLastLine(): void {
    if (!existsSync(this.file)) return;
    const fd = openSync(this.file, 'r+');
    try {
      const size = fstatSync(fd).size;
      if (size === 0) return;
      const end = Buffer.alloc(1);
      readSync(fd, end, 0, 1, size - 1);
      if (end[0] === 0x0a) return;
      let start = 0;
      const piece = Buffer.alloc(1024 * 1024);
      for (let to = size; to > 0;) {
        const from = Math.max(0, to - piece.length);
        const read = readSync(fd, piece, 0, to - from, from);
        const newline = piece.subarray(0, read).lastIndexOf(0x0a);
        if (newline >= 0) {
          start = from + newline + 1;
          break;
        }
        to = from;
      }
      const line = Buffer.alloc(size - start);
      readSync(fd, line, 0, line.length, start);
      try {
        JSON.parse(line.toString('utf8'));
        writeSync(fd, '\n', size);
      } catch {
        ftruncateSync(fd, start);
      }
    } finally {
      closeSync(fd);
    }
  }

  private nextId(): string {
    const time = Date.now().toString(36).padStart(9, '0');
    const counter = (this.seq++ % 36 ** 4).toString(36).padStart(4, '0');
    return `e${time}${counter}`;
  }
}
