import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, truncateSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CheckResult } from '../checks/runner.ts';
import type { Party, Role } from '../roles.ts';
import type { ActionState, FeatureState, PlanState } from './state.ts';

/** What an event is about. Ids repeat across modules, so a feature is always addressed with its module and plan. */
export interface Ref {
  module: string;
  plan: string;
  feature?: string;
  attempt?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export interface Finding {
  category: string;
  summary: string;
  tried?: string[];
  needs?: string;
}

export type AttemptOutcome = 'done' | 'blocked' | 'timed_out' | 'no_report' | 'error' | 'usage_limit' | 'aborted';

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
  PLAN_COMPLETED: { head: string };
  ATTEMPT_STARTING: { sandbox: string; base: string; sessionId: string; deadline: string; definitionHash: string };
  ATTEMPT_STARTED: Record<string, never>;
  BASELINE_FAILED: { reason: string; results: CheckResult[] };
  ATTEMPT_ENDED: { outcome: AttemptOutcome; summary?: string; notes?: string; finding?: Finding; usage?: Usage };
  ATTEMPT_INTERRUPTED: { reason: string; counts: boolean };
  CHECKS_STARTED: { head: string; files: string[] };
  CHECKS_PASSED: { results: CheckResult[] };
  CHECKS_FAILED: { results: CheckResult[] };
  FEATURE_ACCEPTED: { commit: string };
  ATTEMPT_FAILED: { reason: string };
  ESCALATED: { reason: string };
  OWNER_RETRY: { note?: string };
  PIPELINE_PAUSED: { reason: string; until?: string };
  PIPELINE_RESUMED: Record<string, never>;
  PLAN_VALIDATING: { head: string };
  PLAN_CHECKS_PASSED: { results: CheckResult[] };
  PLAN_CHECKS_FAILED: { results: CheckResult[] };
  MANAGER_STARTING: { module: string; sandbox: string; sessionId: string };
  MANAGER_LAUNCHED: { module: string; launch: number; outputBytes: number };
  MANAGER_EXITED: { module: string; launch: number; code: number | null; stderr: string; started: boolean };
  MANAGER_ITEM_SENT: { module: string; key: string; launch: number; reminder: boolean };
  MANAGER_STOPPED: { module: string; reason: string };
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
  POST_DEPLOY_CHECKS_FAILED: { results: CheckResult[] };
  PR_CLOSED: Record<string, never>;
  MODULE_CREATED: { module: string; title: string; sandbox: string; sessionId: string };
  ARCHITECT_LAUNCHED: { module: string };
  ARCHITECTURE_ACCEPTED: { module: string; version: number };
  DESIGN_REFUSED: { module: string; requestId: string; problems: string[] };
  DESIGN_SUBMITTED: { module: string; head: string; suspect: string[] };
  ARCH_PR_OPENED: { module: string; number: number; url: string };
  ARCH_PR_CLOSED: { module: string };
  ARCH_CI_DONE: { module: string; sha: string; jobs: CiJob[] };
  DESIGN_FROZEN: { module: string; commit: string };
  ARCHITECT_NOTE_SENT: { module: string; key: string };
  OWNER_ACTION_CLAIMED: { module: string; action: string; note?: string };
  OWNER_ACTION_DONE: { module: string; action: string; title: string; gate: boolean };
  OWNER_ACTION_REFUSED: { module: string; action: string; reason: string };

  // Messages.
  QUESTION: { requestId: string; question: string };
  CONTINUE: { requestId: string; answer: string };
  ACCEPT: { requestId: string; note?: string };
  REJECT: { requestId: string; guidance: string };
  RETRY: { requestId: string; guidance: string };
  ABORT: { requestId: string; reason: string };
  OWNER_REQUEST: { module: string; requestId: string; question: string; blocking: boolean };
  OWNER_ANSWER: { module: string; requestId: string; answer: string };
  OWNER_MESSAGE: { module: string; text: string };
  PLAN_SUBMITTED: { requestId: string; summary: string };
  /** The Manager asks for a fix round after CI failed; `failure` is what CI reported. */
  REQUEST_FIX: { requestId: string; guidance: string; failure: string };
  PROPOSAL: { module: string; requestId: string; version: number; sha256: string };
  /** The Architect submits its design; `head` is its commit, now in the daemon's repository. */
  DESIGN: { module: string; requestId: string; summary: string; head: string };
  ESCALATION: { module: string; requestId: string; question: string; feature?: string };
  DECISION: { module: string; requestId: string; escalationId: string; decision: string };
}

export type EventType = keyof Payloads;

const MESSAGES: ReadonlySet<EventType> = new Set<EventType>([
  'QUESTION', 'CONTINUE', 'ACCEPT', 'REJECT', 'RETRY', 'ABORT', 'OWNER_REQUEST', 'OWNER_ANSWER', 'OWNER_MESSAGE', 'PLAN_SUBMITTED', 'REQUEST_FIX',
  'PROPOSAL', 'DESIGN', 'ESCALATION', 'DECISION',
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
  private seq = 0;

  constructor(file: string) {
    this.file = file;
    mkdirSync(dirname(file), { recursive: true });
    this.dropTornLastLine();
  }

  readAll(): HarnessEvent[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line, i) => {
        try {
          return JSON.parse(line) as HarnessEvent;
        } catch {
          throw new Error(`${this.file}: line ${i + 1} is not valid JSON`);
        }
      });
  }

  append(event: NewEvent): HarnessEvent {
    const kind = MESSAGES.has(event.type) ? 'message' : 'event';
    const stamped = { v: 1, kind, id: this.nextId(), ts: new Date().toISOString(), ...event } as HarnessEvent;
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
  private dropTornLastLine(): void {
    if (!existsSync(this.file)) return;
    const text = readFileSync(this.file, 'utf8');
    if (text === '' || text.endsWith('\n')) return;
    const lastNewline = text.lastIndexOf('\n');
    try {
      JSON.parse(text.slice(lastNewline + 1));
      const fd = openSync(this.file, 'a');
      writeSync(fd, '\n');
      closeSync(fd);
    } catch {
      truncateSync(this.file, Buffer.byteLength(text.slice(0, lastNewline + 1)));
    }
  }

  private nextId(): string {
    const time = Date.now().toString(36).padStart(9, '0');
    const counter = (this.seq++ % 36 ** 4).toString(36).padStart(4, '0');
    return `e${time}${counter}`;
  }
}
