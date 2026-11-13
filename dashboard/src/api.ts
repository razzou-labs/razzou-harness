import { shallowReactive } from 'vue';
import type { DashboardState } from '../../src/dashboard/server.ts';
import type { HarnessEvent } from '../../src/state/events.ts';

export type { DashboardState, HarnessEvent };
export type { Attempt, FeatureState, ManagerState, ModuleState, PlanState, State } from '../../src/state/state.ts';
export type { OwnerTime } from '../../src/design/owner-time.ts';
export type { SubscriptionUsage, UsageLimit } from '../../src/anthropic/usage.ts';
export type { Denial, SandboxOverview, SandboxRow, UsageReading } from '../../src/daemon/sandboxes.ts';
export type { SandboxUsage } from '../../src/sandbox/docker.ts';
export type Design = DashboardState['design'];

/** A line of an agent's stream-json, as the daemon relayed it. */
export type TranscriptItem = Record<string, unknown>;

type Listener = { event?: (event: HarnessEvent) => void; transcript?: (agent: string, item: TranscriptItem) => void };
const listeners = new Set<Listener>();

/** Hears what the daemon pushes, until the function it returns is called: a component calls it as it unmounts. */
export function listen(listener: Listener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/**
 * The daemon's state, refreshed after each of its events, when the design on main
 * changed, and each minute anyway: one event stream feeds the whole page. Shallow: each
 * refresh replaces `data` whole.
 */
export const harness = shallowReactive<{ data?: DashboardState; problem?: string; connected: boolean }>({ connected: false });

const NO_TOKEN = 'Open the dashboard with the URL the daemon printed: it holds the token.';
/** What the page says once the daemon answers with another token: only the new link opens it. */
const RESTARTED = 'The daemon restarted: open the link `harness up` printed, which holds its new token. This page still shows what it knew before.';
const NOT_ANSWERING = 'The daemon is not answering. Is `harness up` still running?';

let connected = false;
/** Set once the daemon refused this page's token: nothing the page holds opens it again. */
let refused = false;

const unauthorized = () => {
  refused = true;
  harness.problem = harness.data ? RESTARTED : NO_TOKEN;
};

/** Opens the event stream, once for the page, and again whenever it ends. */
export function connect(): void {
  if (connected) return;
  connected = true;
  let timer: number | undefined;
  const refresh = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
      try {
        const response = await fetch('/api/state');
        if (response.status === 401) return unauthorized();
        if (!response.ok) return void (harness.problem = await response.text());
        harness.problem = undefined;
        harness.data = (await response.json()) as DashboardState;
      } catch {
        harness.problem = NOT_ANSWERING;
      }
    }, 120);
  };
  // The browser gives up for good on a stream that answered with an error, as a restarted
  // daemon's 401 does: the page asks why, and opens a new one unless the token is refused.
  let backoff = 1000;
  const open = () => {
    const source = new EventSource('/api/events');
    source.onopen = () => {
      backoff = 1000;
      harness.connected = true;
      refresh();
    };
    source.onerror = () => {
      harness.connected = false;
      if (source.readyState !== EventSource.CLOSED) return;
      void fetch('/api/state').then((response) => response.status, () => 0).then((status) => {
        if (status === 401) return unauthorized();
        if (status === 0) harness.problem = NOT_ANSWERING;
        window.setTimeout(open, backoff);
        backoff = Math.min(backoff * 2, 30_000);
      });
    };
    source.addEventListener('event', (message) => {
      const event = JSON.parse(message.data) as HarnessEvent;
      listeners.forEach((l) => l.event?.(event));
      refresh();
    });
    // An agent reported the subscription's usage: the meters follow. The design on main changed: the cards follow.
    source.addEventListener('usage', () => refresh());
    source.addEventListener('design', () => refresh());
    source.addEventListener('transcript', (message) => {
      const { agent, item } = JSON.parse(message.data) as { agent: string; item: TranscriptItem };
      listeners.forEach((l) => l.transcript?.(agent, item));
    });
  };
  open();
  refresh();
  // A floor, for what changes without an event, such as the owner's time.
  window.setInterval(() => refused || refresh(), 60_000);
}

/** What an owner action answers: done, or why not; done, with what went wrong beside it. */
export interface Outcome {
  done: boolean;
  error?: string;
  warning?: string;
}

/** An owner action. The page refreshes from the event it records. */
export async function post(path: string, body: object = {}): Promise<Outcome & Record<string, unknown>> {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => undefined);
  if (!response) return { done: false, error: NOT_ANSWERING };
  if (response.status === 401) {
    unauthorized();
    return { done: false, error: RESTARTED };
  }
  if (!response.ok) return { done: false, error: await response.text() };
  return (await response.json()) as Outcome & Record<string, unknown>;
}

export async function getText(path: string): Promise<string> {
  const response = await fetch(path);
  return response.ok ? response.text() : `(${response.status}) ${await response.text()}`;
}

export async function getJson<T>(path: string): Promise<T | undefined> {
  const response = await fetch(path);
  return response.ok ? ((await response.json()) as T) : undefined;
}
