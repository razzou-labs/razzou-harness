import { useEffect, useRef, useState } from 'react';
import type { DashboardState } from '../../src/dashboard/server.ts';
import type { HarnessEvent } from '../../src/state/events.ts';

export type { DashboardState };
export type { HarnessEvent };
export type { Attempt, FeatureState, ManagerState, ModuleState, PlanState, State } from '../../src/state/state.ts';
export type Design = DashboardState['design'];

/** A line of an agent's stream-json, as the daemon relayed it. */
export type TranscriptItem = Record<string, unknown>;

type Listener = { event?: (event: HarnessEvent) => void; transcript?: (agent: string, item: TranscriptItem) => void };
const listeners = new Set<Listener>();

/** Runs the latest `listener` for what the daemon pushes, while the component is mounted. */
export function useLive(listener: Listener): void {
  const latest = useRef(listener);
  latest.current = listener;
  useEffect(() => {
    const relay: Listener = {
      event: (event) => latest.current.event?.(event),
      transcript: (agent, item) => latest.current.transcript?.(agent, item),
    };
    listeners.add(relay);
    return () => void listeners.delete(relay);
  }, []);
}

/**
 * The daemon's state, refreshed after each of its events. One event stream feeds the
 * whole page.
 */
export function useHarness(): { data?: DashboardState; problem?: string; connected: boolean } {
  const [data, setData] = useState<DashboardState>();
  const [problem, setProblem] = useState<string>();
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let timer: number | undefined;
    const refresh = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        try {
          const response = await fetch('/api/state');
          if (response.status === 401) return setProblem('Open the dashboard with the URL the daemon printed: it holds the token.');
          if (!response.ok) return setProblem(await response.text());
          setProblem(undefined);
          setData((await response.json()) as DashboardState);
        } catch {
          setProblem('The daemon is not answering. Is `harness up` still running?');
        }
      }, 120);
    };
    const source = new EventSource('/api/events');
    source.onopen = () => {
      setConnected(true);
      refresh();
    };
    source.onerror = () => setConnected(false);
    source.addEventListener('event', (message) => {
      const event = JSON.parse(message.data) as HarnessEvent;
      listeners.forEach((l) => l.event?.(event));
      refresh();
    });
    source.addEventListener('transcript', (message) => {
      const { agent, item } = JSON.parse(message.data) as { agent: string; item: TranscriptItem };
      listeners.forEach((l) => l.transcript?.(agent, item));
    });
    refresh();
    return () => source.close();
  }, []);
  return { data, problem, connected };
}

/** An owner action. The page refreshes from the event it records. */
export async function post(path: string, body: object = {}): Promise<{ done: boolean; error?: string }> {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) return { done: false, error: await response.text() };
  return (await response.json()) as { done: boolean; error?: string };
}

export async function getText(path: string): Promise<string> {
  const response = await fetch(path);
  return response.ok ? response.text() : `(${response.status}) ${await response.text()}`;
}

export async function getJson<T>(path: string): Promise<T | undefined> {
  const response = await fetch(path);
  return response.ok ? ((await response.json()) as T) : undefined;
}
