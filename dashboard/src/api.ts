import { shallowReactive } from 'vue';
import type { DashboardState } from '../../src/dashboard/server.ts';
import type { HarnessEvent } from '../../src/state/events.ts';

export type { DashboardState, HarnessEvent };
export type { Attempt, FeatureState, ManagerState, ModuleState, PlanState, State } from '../../src/state/state.ts';
export type { ModuleOwnerTime } from '../../src/design/owner-time.ts';
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
 * The daemon's state, refreshed after each of its events: one event stream feeds the
 * whole page. Shallow: each refresh replaces `data` whole.
 */
export const harness = shallowReactive<{ data?: DashboardState; problem?: string; connected: boolean }>({ connected: false });

let connected = false;

/** Opens the event stream, once for the page. */
export function connect(): void {
  if (connected) return;
  connected = true;
  let timer: number | undefined;
  const refresh = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
      try {
        const response = await fetch('/api/state');
        if (response.status === 401) return void (harness.problem = 'Open the dashboard with the URL the daemon printed: it holds the token.');
        if (!response.ok) return void (harness.problem = await response.text());
        harness.problem = undefined;
        harness.data = (await response.json()) as DashboardState;
      } catch {
        harness.problem = 'The daemon is not answering. Is `harness up` still running?';
      }
    }, 120);
  };
  const source = new EventSource('/api/events');
  source.onopen = () => {
    harness.connected = true;
    refresh();
  };
  source.onerror = () => {
    harness.connected = false;
  };
  source.addEventListener('event', (message) => {
    const event = JSON.parse(message.data) as HarnessEvent;
    listeners.forEach((l) => l.event?.(event));
    refresh();
  });
  // An agent reported the subscription's usage: the meters follow.
  source.addEventListener('usage', () => refresh());
  source.addEventListener('transcript', (message) => {
    const { agent, item } = JSON.parse(message.data) as { agent: string; item: TranscriptItem };
    listeners.forEach((l) => l.transcript?.(agent, item));
  });
  refresh();
}

/** What an owner action answers: done, or why not; done, with what went wrong beside it. */
export interface Outcome {
  done: boolean;
  error?: string;
  warning?: string;
}

/** An owner action. The page refreshes from the event it records. */
export async function post(path: string, body: object = {}): Promise<Outcome & Record<string, unknown>> {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
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
