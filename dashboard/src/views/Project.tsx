import { useState } from 'react';
import { post, type Attempt, type DashboardState, type FeatureState, type PlanState } from '../api.ts';
import { Badge, GithubLink } from '../components/ui.tsx';
import { duration } from '../format.ts';
import { Proposal } from './NeedsYou.tsx';

/** Modules, proposals, plans and features, with CI, deploys and progress (§14.1). */
export function Project({ data }: { data: DashboardState }) {
  const { state, design, progress } = data;
  const [reading, setReading] = useState<{ module: string; version: number }>();
  const moduleIds = [...new Set([...Object.keys(state.modules), ...design.modules.map((m) => m.id)])];
  return (
    <div className="stack">
      <NewModule />
      {moduleIds.length === 0 && <p className="muted">No module yet.</p>}
      {moduleIds.map((id) => {
        const module = state.modules[id];
        const plans = design.modules.find((m) => m.id === id)?.plans ?? [];
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
