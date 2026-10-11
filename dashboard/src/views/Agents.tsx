import { useEffect, useState } from 'react';
import { post, type DashboardState } from '../api.ts';
import { Terminal } from '../components/Terminal.tsx';
import { Transcript } from '../components/Transcript.tsx';
import { Badge, Reply } from '../components/ui.tsx';
import { clock, duration } from '../format.ts';
import type { Go } from '../App.tsx';

interface Card {
  id: string;
  role: 'Architect' | 'Manager' | 'Developer';
  title: string;
  status: string;
  detail: string;
  /** Set while the sandbox is there: the owner can open a shell in it. */
  sandbox?: string;
  /** The deadline of a running attempt, against its start. */
  clock?: { start: number; deadline: number };
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
    return (
      <>
        <Transcript agent={card.id} />
        <Reply label="Send to the Manager" placeholder="A message for the Manager" onSend={(text) => post('/api/message', { text })} />
      </>
    );
  }
  return <Transcript agent={card.id} />;
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
    cards.push({
      id: `manager:${manager.module}`,
      role: 'Manager',
      title: manager.module,
      status: manager.status,
      detail: manager.launchedAt ? `launch ${manager.launch}, at ${clock(manager.launchedAt)}` : '',
      ...(manager.status !== 'stopped' ? { sandbox: manager.sandbox } : {}),
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
    cards.push({
      id: `developer:${feature.module}/${feature.plan}/${feature.feature}/a${attempt.n}`,
      role: 'Developer',
      title: `${feature.module}/${feature.plan}/${feature.feature} #${attempt.n}`,
      status: attempt.status,
      detail: live ? '' : `${attempt.outcome ?? ''}${usage}`,
      ...(live ? { sandbox: attempt.sandbox, clock: { start: Date.parse(attempt.startedAt), deadline: Date.parse(attempt.deadline) } } : {}),
    });
  }
  return cards;
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
