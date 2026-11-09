import { useEffect, useState } from 'react';
import { post, type Attempt, type DashboardState, type FeatureState, type OwnerTime, type PlanState, type State, type SubscriptionUsage, type UsageLimit } from '../api.ts';
import { Graph } from '../components/Graph.tsx';
import { Action, Badge, GithubLink } from '../components/ui.tsx';
import { duration } from '../format.ts';
import { Proposal } from './NeedsYou.tsx';

/** Modules, proposals, plans and features, with CI, deploys and progress (§14.1). */
export function Project({ data }: { data: DashboardState }) {
  const { state, design, progress } = data;
  const [reading, setReading] = useState<{ module: string; version: number }>();
  const moduleIds = [...new Set([...Object.keys(state.modules), ...design.modules.map((m) => m.id)])];
  return (
    <div className="stack">
      <Budgets
        state={state}
        ceiling={design.swarm?.usageCeilingPercent ?? null}
        {...(data.ownerTime ? { ownerTime: data.ownerTime } : {})}
        {...(data.usage ? { usage: data.usage } : {})}
      />
      <NewModule />
      {moduleIds.length === 0 && <p className="muted">No module yet.</p>}
      {moduleIds.map((id) => {
        const module = state.modules[id];
        const designed = design.modules.find((m) => m.id === id);
        const plans = designed?.plans ?? [];
        return (
          <section key={id}>
            <h2>
              {id} {module && <span className="muted">· {module.title}</span>} {module && <Badge status={module.status} />}
              {module?.design?.pr && <> · <GithubLink url={module.design.pr.url}>Arch PR #{module.design.pr.number}</GithubLink></>}
            </h2>
            {module && module.proposals.length > 0 && (
              <div className="row">
                <span className="muted">Proposals:</span>
                {module.proposals.map((p) => (
                  <button key={p.version} className={reading?.module === id && reading.version === p.version ? 'selected' : undefined}
                    onClick={() => setReading(reading?.module === id && reading.version === p.version ? undefined : { module: id, version: p.version })}>
                    v{p.version}{p.acceptedAt ? ' ✓' : ''}
                  </button>
                ))}
              </div>
            )}
            {reading?.module === id && <Proposal module={id} version={reading.version} />}
            {designed && plans.length > 0 && <Graph module={designed} state={state} />}
            {plans.map((plan) => (
              <Plan key={plan.id} data={data} module={id} plan={plan} />
            ))}
          </section>
        );
      })}
      <section>
        <h2>progress.txt</h2>
        <pre>{progress.join('\n') || '(nothing accepted yet)'}</pre>
      </section>
    </div>
  );
}

/** Now, refreshed every `everyMs` while `ticking`: for clocks that must move without an event. */
function useNow(ticking: boolean, everyMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!ticking) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(timer);
  }, [ticking, everyMs]);
  return now;
}

/** The Developers' attempt clocks, summed, running ones counted to `now` (v3 §4.2). */
function agentMs(state: State, now: number): number {
  let total = 0;
  for (const feature of Object.values(state.features)) {
    for (const attempt of feature.attempts) {
      const started = Date.parse(attempt.startedAt);
      const ended = attempt.endedAt ? Date.parse(attempt.endedAt) : now;
      if (Number.isFinite(started) && Number.isFinite(ended)) total += Math.max(0, ended - started);
    }
  }
  return total;
}

type Tokens = { input: number; output: number };

/** Claude's tokens by role: a Developer's and a reviewer's from their sessions' end, a Manager's and an Architect's from the daemon's readings of their sandboxes. */
function tokensByRole(state: State): Array<[string, Tokens]> {
  const roles: Record<string, Tokens> = { Developers: { input: 0, output: 0 }, Managers: { input: 0, output: 0 }, Architects: { input: 0, output: 0 }, reviewers: { input: 0, output: 0 } };
  const add = (role: string, usage?: { inputTokens: number; outputTokens: number }) => {
    if (!usage) return;
    roles[role]!.input += usage.inputTokens;
    roles[role]!.output += usage.outputTokens;
  };
  for (const feature of Object.values(state.features)) for (const attempt of feature.attempts) add('Developers', attempt.usage);
  for (const plan of Object.values(state.plans)) for (const review of plan.reviews ?? []) add('reviewers', review.usage);
  for (const [agent, tokens] of Object.entries(state.agentTokens ?? {})) {
    add(agent.startsWith('manager:') ? 'Managers' : agent.startsWith('architect:') ? 'Architects' : 'Developers', tokens.total);
  }
  return Object.entries(roles);
}

/** 1234567 is 1.2 M; 45678 is 46 k. */
function count(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} k`;
  return String(n);
}

/** The owner's hours for the whole project, and the agent-hours threshold (v3 §4): set here, recorded by the daemon. */
function Budgets({ state, ownerTime, usage, ceiling }: { state: State; ownerTime?: OwnerTime; usage?: { at: string; usage: SubscriptionUsage }; ceiling: number | null }) {
  const budgets = state.budgets ?? {};
  const overPlanned = ownerTime !== undefined && ownerTime.committedHours > ownerTime.plannableHours;
  const overUsed = ownerTime !== undefined && ownerTime.usedHours > ownerTime.hours;
  const running = Object.values(state.features).some((f) => f.attempts.some((a) => !a.endedAt));
  const now = useNow(running);
  const agentHours = agentMs(state, now) / 3_600_000;
  const over = budgets.agentHours !== undefined && agentHours > budgets.agentHours;
  return (
    <section>
      <h2>Budgets</h2>
      <div className="meters">
        <div className="meter">
          <h3>Your time</h3>
          <p>
            {budgets.ownerHours !== undefined
              ? <><b>{budgets.ownerHours} h</b> for the whole project{budgets.ownerHoursSetAt && <span className="muted">, set {new Date(budgets.ownerHoursSetAt).toLocaleDateString()}</span>}</>
              : <span className="muted">Not set: the Architect designs without a limit on your time.</span>}
          </p>
          {ownerTime && (
            <p>
              <b className={overUsed ? 'bad' : undefined}>{ownerTime.usedHours} h used</b>
              {' · '}
              <span className={overPlanned ? 'bad' : undefined}>{ownerTime.committedHours} h planned by the designs</span>
              {' · '}
              <span className="muted">{ownerTime.plannableHours} h plannable after the {ownerTime.reservePercent}% reserve</span>
            </p>
          )}
          <HoursForm field="ownerHours" value={budgets.ownerHours} placeholder="hours" />
          <p className="muted small">
            {ownerTime
              ? 'Planned: the estimates of the owner actions in submitted designs, gates and tasks. Used: the actions you marked done. What you read, proposals and pull requests, doesn\'t count.'
              : 'Once set, the Architect must estimate every owner action and design within your hours; a design over them is refused.'}
          </p>
        </div>
        <div className="meter">
          <h3>Agent hours</h3>
          <p>
            <b className={over ? 'bad' : undefined}>{agentHours.toFixed(1)} h</b>
            {budgets.agentHours !== undefined ? <> of {budgets.agentHours} h</> : <span className="muted"> · no threshold</span>}
            {over && <span className="bad small"> · over the threshold</span>}
          </p>
          <HoursForm field="agentHours" value={budgets.agentHours} placeholder="threshold" />
          <p className="muted small">The Developers' attempt clocks, summed. Over the threshold the number turns red; nothing stops.</p>
        </div>
        <TokensMeter state={state} />
        <SubscriptionMeter {...(usage ? { usage } : {})} ceiling={ceiling} />
      </div>
    </section>
  );
}

/**
 * The subscription's windows as bars: the current session and the weekly limit, as an
 * agent's model call last reported them. Before any report, the box says where they come from.
 */
function SubscriptionMeter({ usage, ceiling }: { usage?: { at: string; usage: SubscriptionUsage }; ceiling: number | null }) {
  const now = useNow(true);
  if (!usage) {
    return (
      <div className="meter">
        <h3>Subscription</h3>
        <p className="muted">No report yet. The Developers, the Manager and the reviewers report your usage with each model call; the bars appear with the first one.</p>
      </div>
    );
  }
  return (
    <div className="meter">
      <h3>Subscription</h3>
      {usage.usage.limits.map((limit) => {
        const hot = ceiling !== null && limit.percent >= ceiling;
        return (
          <div key={`${limit.kind}:${limit.model ?? ''}`} className="usage-bar">
            <div className="usage-label">
              <span>{limitLabel(limit)}</span>
              <b className={hot ? 'bad' : undefined}>{limit.percent}%</b>
            </div>
            <div className="bar"><div className={hot ? 'fill hot' : 'fill'} style={{ width: `${Math.max(0, Math.min(100, limit.percent))}%` }} /></div>
            <div className="muted small">resets {resetsIn(limit.resetsAt, now)}</div>
          </div>
        );
      })}
      <p className="muted small">
        Reported by an agent's model call at {new Date(usage.at).toLocaleTimeString()}. In Swarm no attempt starts at or above {ceiling === null ? 'the ceiling, which is off' : `${ceiling}%`}; the pipeline waits for the window to reset.
      </p>
    </div>
  );
}

function limitLabel(limit: UsageLimit): string {
  switch (limit.kind) {
    case 'session':
      return 'Current session';
    case 'weekly_all':
      return 'Weekly · all models';
    case 'weekly_scoped':
      return `Weekly · ${limit.model ?? 'one model'}`;
    default:
      return limit.kind.replace(/_/g, ' ');
  }
}

/** Within a day, "in 2 h 10 min"; further, the day and the time: "Fri 09:00". */
function resetsIn(at: string, now: number): string {
  const ms = Date.parse(at) - now;
  if (!Number.isFinite(ms)) return 'at a time the endpoint did not give';
  if (ms <= 0) return 'now';
  if (ms < 24 * 3_600_000) {
    const total = Math.ceil(ms / 60_000);
    const hours = Math.floor(total / 60);
    const minutes = total % 60;
    return `in ${hours > 0 ? `${hours} h${minutes > 0 ? ` ${minutes} min` : ''}` : `${minutes} min`}`;
  }
  return new Date(at).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Every token Claude used for the project, written and read, and by role. */
function TokensMeter({ state }: { state: State }) {
  const roles = tokensByRole(state);
  const total = roles.reduce((sum, [, t]) => ({ input: sum.input + t.input, output: sum.output + t.output }), { input: 0, output: 0 });
  return (
    <div className="meter">
      <h3>Claude tokens</h3>
      <p>
        <b>{count(total.input + total.output)}</b>
        <span className="muted"> · {count(total.output)} written, {count(total.input)} read, cache included</span>
      </p>
      <p className="small">{roles.map(([role, t]) => `${role} ${count(t.input + t.output)}`).join(' · ')}</p>
      <p className="muted small">
        Claude Code's own counts: an attempt's and a review's when it ends, a Manager's and an Architect's every five minutes. Most of what is read comes from the prompt cache.
      </p>
    </div>
  );
}

/** A number of hours to save, or clear: null clears it on the daemon. */
function HoursForm({ field, value, placeholder }: { field: 'ownerHours' | 'agentHours'; value?: number; placeholder: string }) {
  const [text, setText] = useState('');
  const hours = Number(text);
  const valid = text.trim() !== '' && Number.isFinite(hours) && hours > 0;
  return (
    <div className="row">
      <input type="number" min={1} step={1} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} />
      <Action
        label="Save"
        onClick={async () => {
          if (!valid) return { done: false, error: 'a positive number of hours' };
          const result = await post('/api/budgets', { [field]: hours });
          if (result.done) setText('');
          return result;
        }}
      />
      {value !== undefined && <Action label="Clear" onClick={() => post('/api/budgets', { [field]: null })} />}
    </div>
  );
}

function NewModule() {
  const [id, setId] = useState('');
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string>();
  return (
    <section>
      <h2>Start a module</h2>
      <div className="row">
        <input value={id} placeholder="id, like orders" size={14} onChange={(e) => setId(e.target.value)} />
        <input value={title} placeholder="what it is for" size={36} onChange={(e) => setTitle(e.target.value)} />
        <button
          disabled={!id.trim()}
          onClick={async () => {
            const result = await post('/api/modules', { id: id.trim(), title });
            setError(result.done ? undefined : result.error);
            if (result.done) {
              setId('');
              setTitle('');
            }
          }}
        >
          Start
        </button>
        {error && <span className="bad small">{error}</span>}
      </div>
      <p className="muted small">An Architect starts in its own sandbox; talk to it in the Agents view.</p>
    </section>
  );
}

type PlanDesign = DashboardState['design']['modules'][number]['plans'][number];

function Plan({ data, module, plan }: { data: DashboardState; module: string; plan: PlanDesign }) {
  const { state, design } = data;
  const key = `${module}/${plan.id}`;
  const planState = state.plans[key];
  const fixes = Object.values(state.features).filter((f) => f.fix && `${f.module}/${f.plan}` === key);
  const rows = [
    ...plan.features.map((f) => ({ id: f.id, title: f.title, kind: f.kind, state: state.features[`${key}/${f.id}`] })),
    ...fixes.map((f) => ({ id: f.feature, title: `Fix after ${f.fix!.kind === 'ci' ? 'CI' : 'the deploy'}, round ${f.fix!.round}`, kind: 'fix', state: f })),
  ];
  return (
    <div className="plan">
      <h3>
        {plan.id} · {plan.title} <Badge status={planState?.status ?? 'waiting'} />
        {planState?.pr && <> <GithubLink url={planState.pr.url}>PR #{planState.pr.number}</GithubLink></>}
        {planState?.mergedBy === 'daemon' && <> <span className="muted small">merged by the daemon</span></>}
        {planState?.ci && <> <Badge status={planState.ci.status} label={`CI ${planState.ci.status}`} /></>}
      </h3>
      {planState && <PlanDetails plan={planState} />}
      <table>
        <thead>
          <tr><th>Feature</th><th>Status</th><th>Attempts</th><th>Last attempt</th><th>Commit</th></tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <FeatureRow key={row.id} id={row.id} title={row.title} kind={row.kind} feature={row.state} max={design.maxAttempts} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PlanDetails({ plan }: { plan: PlanState }) {
  const failedJobs = plan.ci?.jobs?.filter((j) => j.conclusion !== 'success') ?? [];
  return (
    <div className="small">
      {failedJobs.map((job) => (
        <details key={job.name}>
          <summary className="bad">CI job {job.name}: {job.conclusion}</summary>
          <pre>{job.log ?? ''}</pre>
        </details>
      ))}
      {plan.reviews?.filter((r) => r.head === plan.pushed).map((r) => (
        <p key={`${r.role}-${r.head}`}>
          {r.role === 'security' ? 'Security' : 'Cost'} review of {r.head.slice(0, 8)}:{' '}
          {r.status === 'reported'
            ? <><Badge status={r.verdict === 'pass' ? 'passed' : 'failed'} label={r.verdict} /> {r.findings?.filter((f) => f.severity === 'blocking').length ?? 0} blocking, {r.findings?.filter((f) => f.severity === 'advisory').length ?? 0} advisory{r.posted?.problem ? <span className="bad"> · {r.posted.problem}</span> : null}</>
            : r.status === 'failed'
              ? <span className="bad">failed: {r.reason}</span>
              : <Badge status={r.status} />}
        </p>
      ))}
      {plan.deploy && (
        <p>
          Deploy of {plan.deploy.commit.slice(0, 8)}: <Badge status={plan.deploy.status} />
          {plan.deploy.jobs?.filter((j) => j.conclusion !== 'success').map((j) => <GithubLink key={j.name} url={j.url}> {j.name}</GithubLink>)}
        </p>
      )}
      {plan.postDeploy && (
        <details>
          <summary>Post-deploy checks: <Badge status={plan.postDeploy.status} /></summary>
          {plan.postDeploy.results.map((r) => (
            <div key={r.id}>
              <b className={r.exit === 0 ? 'ok' : 'bad'}>{r.id}</b> <span className="muted">{duration(r.durationMs)}</span>
              <pre>{r.output}</pre>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

function FeatureRow({ id, title, kind, feature, max }: { id: string; title: string; kind: string; feature?: FeatureState; max: number }) {
  const last: Attempt | undefined = feature?.attempts.at(-1);
  // As the daemon counts: failures that count, for the feature's current definition.
  const counted = last ? feature!.attempts.filter((a) => a.definitionHash === last.definitionHash && a.counts).length : 0;
  const ended = last?.endedAt ? Date.parse(last.endedAt) : Date.now();
  return (
    <tr>
      <td>
        <b>{id}</b> {title} {kind === 'infra' && <span className="muted small">infra</span>}
      </td>
      <td>
        <Badge status={feature?.status ?? 'pending'} />
        {feature?.awaitingGuidanceSince && <div className="muted small">waiting for the Manager's guidance</div>}
      </td>
      <td className="mono">{feature ? `${feature.attempts.length}${counted ? ` (${counted} of ${max + feature.extraAttempts} counted)` : ''}` : '0'}</td>
      <td>
        {last && (
          <>
            {last.status}
            {last.outcome ? ` · ${last.outcome}` : ''} · {duration(ended - Date.parse(last.startedAt))}
            {last.reason && <div className="small">{last.reason}</div>}
            {last.finding && (
              <details className="small">
                <summary>Finding: {last.finding.category}</summary>
                <p>{last.finding.summary}</p>
                {last.finding.needs && <p>Needs: {last.finding.needs}</p>}
              </details>
            )}
            {last.questions?.map((q) => (
              <div key={q.requestId} className="small muted">Q: {q.text}{q.answer ? ` — A: ${q.answer}` : ''}</div>
            ))}
          </>
        )}
      </td>
      <td className="mono">{feature?.commit?.slice(0, 8) ?? ''}</td>
    </tr>
  );
}
