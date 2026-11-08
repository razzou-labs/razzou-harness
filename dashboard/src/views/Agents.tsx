import { useEffect, useState } from 'react';
import { post, type DashboardState, type Denial } from '../api.ts';
import { DenialTable } from '../components/Denials.tsx';
import { Terminal } from '../components/Terminal.tsx';
import { Transcript } from '../components/Transcript.tsx';
import { Badge, Reply } from '../components/ui.tsx';
import { clock, duration } from '../format.ts';
import type { Go } from '../App.tsx';

interface Card {
  id: string;
  role: 'Architect' | 'Manager' | 'Developer' | 'Reviewer';
  title: string;
  status: string;
  detail: string;
  /** Set while the sandbox is there: the owner can open a shell in it. */
  sandbox?: string;
  /** The deadline of a running attempt, against its start. */
  clock?: { start: number; deadline: number };
  /** What an attempt's sandbox policy refused, kept when its sandbox went. */
  refused?: Denial[];
}

const LIVE = ['starting', 'running', 'collecting', 'checking', 'reviewing'];

/** One card per agent, and the selected one's terminal, transcript or shell (§14.1, §14.3). */
export function Agents({ data, selected, go }: { data: DashboardState; selected?: string; go: Go }) {
  const now = useNow();
  const cards = agentCards(data);
  const current = cards.find((c) => c.id === selected) ?? cards[0];
  const [shell, setShell] = useState(false);
  useEffect(() => setShell(false), [current?.id]);
  if (!current) return <p className="muted">No agent yet: start a module in the Project view.</p>;
  return (
    <div className="agents">
      <div className="cards">
        {cards.map((card) => (
          <button key={card.id} className={card.id === current.id ? 'card selected' : 'card'} onClick={() => go('agents', card.id)}>
            <div><b>{card.role}</b> · {card.title}</div>
            <div><Badge status={card.status} /> <span className="muted small">{card.detail}</span></div>
            {card.clock && <Deadline now={now} {...card.clock} />}
          </button>
        ))}
      </div>
      <div className="panel">
        <div className="row">
          <h2>{current.role} · {current.title}</h2>
          {current.sandbox && data.terminals && (
            <button onClick={() => setShell(!shell)}>{shell ? 'Back' : `Shell in ${current.sandbox}`}</button>
          )}
          {current.sandbox && <button onClick={() => go('sandboxes', current.sandbox)}>Its sandbox</button>}
        </div>
        {shell && current.sandbox ? <Terminal sandbox={current.sandbox} /> : <AgentView card={current} data={data} />}
      </div>
    </div>
  );
}

function AgentView({ card, data }: { card: Card; data: DashboardState }) {
  if (card.role === 'Architect') {
    const module = card.id.slice('architect:'.length);
    if (!data.terminals) return <p>The dashboard has no terminals here: node-pty didn't install. Use <code>harness attach {module}</code>.</p>;
    return (
      <>
        <Terminal module={module} />
        <p className="muted small">The Architect's own terminal, shared with <code>harness attach {module}</code>. It keeps running when you leave.</p>
      </>
    );
  }
  if (card.role === 'Manager') {
    // The message goes to this Manager: in Swarm each plan in flight has its own (v3 §6.4).
    const manager = card.id.slice('manager:'.length);
    return (
      <>
        <Transcript agent={card.id} />
        <Reply label="Send to the Manager" placeholder="A message for the Manager" onSend={(text) => post('/api/message', { text, manager })} />
      </>
    );
  }
  return (
    <>
      {card.refused && card.refused.length > 0 && (
        <details className="refused">
          <summary>Its sandbox's network policy refused {refusedHosts(card.refused)}</summary>
          <DenialTable denials={card.refused} />
        </details>
      )}
      <Transcript agent={card.id} />
    </>
  );
}

function agentCards({ state }: DashboardState): Card[] {
  const cards: Card[] = [];
  for (const module of Object.values(state.modules)) {
    cards.push({
      id: `architect:${module.module}`,
      role: 'Architect',
      title: module.module,
      status: module.architect.status,
      detail: `module ${module.status.replace(/_/g, ' ')}`,
      sandbox: module.architect.sandbox,
    });
  }
  for (const manager of Object.values(state.managers)) {
    const key = manager.plan ? `${manager.module}/${manager.plan}` : manager.module;
    cards.push({
      id: `manager:${key}`,
      role: 'Manager',
      title: key,
      status: manager.status,
      detail: manager.launchedAt ? `launch ${manager.launch}, at ${clock(manager.launchedAt)}` : '',
      ...(manager.status !== 'stopped' ? { sandbox: manager.sandbox } : {}),
    });
  }
  // The reviewers' sessions on the plans' pull requests (v3 §5), newest first.
  const reviews = Object.values(state.plans)
    .flatMap((plan) => (plan.reviews ?? []).map((review) => ({ plan, review })))
    .sort((a, b) => Date.parse(b.review.startedAt) - Date.parse(a.review.startedAt))
    .slice(0, 6);
  for (const { plan, review } of reviews) {
    const live = review.status === 'starting' || review.status === 'running';
    const blocking = review.findings?.filter((f) => f.severity === 'blocking').length ?? 0;
    cards.push({
      id: `${review.role}:${review.head.slice(0, 8)}`,
      role: 'Reviewer',
      title: `${plan.module}/${plan.plan} · ${review.role} · ${review.head.slice(0, 8)}`,
      status: review.status === 'reported' ? review.verdict ?? 'reported' : review.status,
      detail: review.status === 'reported' ? `${blocking} blocking` : review.status === 'failed' ? review.reason ?? '' : '',
      ...(live ? { sandbox: review.sandbox, clock: { start: Date.parse(review.startedAt), deadline: Date.parse(review.deadline) } } : {}),
    });
  }
  // The running attempt first, then the last few that ended.
  const attempts = Object.values(state.features)
    .flatMap((feature) => feature.attempts.map((attempt) => ({ feature, attempt })))
    .sort((a, b) => Date.parse(b.attempt.startedAt) - Date.parse(a.attempt.startedAt))
    .slice(0, 8);
  for (const { feature, attempt } of attempts) {
    const live = LIVE.includes(attempt.status);
    const usage = attempt.usage ? ` · ${attempt.usage.outputTokens.toLocaleString()} tokens written` : '';
    const refused = attempt.refused?.length ? ` · refused ${refusedHosts(attempt.refused)}` : '';
    cards.push({
      id: `developer:${feature.module}/${feature.plan}/${feature.feature}/a${attempt.n}`,
      role: 'Developer',
      title: `${feature.module}/${feature.plan}/${feature.feature} #${attempt.n}`,
      status: attempt.status,
      detail: live ? refused.slice(3) : `${attempt.outcome ?? ''}${usage}${refused}`,
      ...(live ? { sandbox: attempt.sandbox, clock: { start: Date.parse(attempt.startedAt), deadline: Date.parse(attempt.deadline) } } : {}),
      ...(attempt.refused ? { refused: attempt.refused } : {}),
    });
  }
  return cards;
}

/** `pypi.org:443`, or `pypi.org:443 and 2 more`: the hosts refused, the latest first. */
function refusedHosts(denials: Denial[]): string {
  const targets = [...new Set(denials.map((d) => d.target))];
  return targets.length > 1 ? `${targets[0]} and ${targets.length - 1} more` : targets[0] ?? '';
}

function Deadline({ now, start, deadline }: { now: number; start: number; deadline: number }) {
  const share = Math.min(1, (now - start) / Math.max(1, deadline - start));
  return (
    <div className="deadline" title={`deadline ${new Date(deadline).toLocaleTimeString()}`}>
      <div style={{ width: `${share * 100}%` }} className={share > 0.8 ? 'late' : undefined} />
      <span className="small muted">{duration(now - start)} of {duration(deadline - start)}</span>
    </div>
  );
}

function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}
