import { useEffect, useState, type ReactNode } from 'react';
import { getText, post, type DashboardState, type FeatureState } from '../api.ts';
import { Markdown } from '../components/Markdown.tsx';
import { Action, GithubLink, Reply } from '../components/ui.tsx';
import { clock } from '../format.ts';
import type { Go } from '../App.tsx';

interface Need {
  key: string;
  title: string;
  body: ReactNode;
}

/** Everything waiting for the owner, most urgent first (§14.1). */
export function collectNeeds({ state, design }: DashboardState, go: Go): Need[] {
  const needs: Need[] = [];
  const paused = state.pipeline.paused;
  if (paused) {
    needs.push({
      key: 'paused',
      title: 'The pipeline is paused',
      body: (
        <>
          <p>{paused.reason}{paused.until ? ` (until ${clock(paused.until)})` : ''}</p>
          <Action label="Resume" onClick={() => post('/api/resume')} />
        </>
      ),
    });
  }
  for (const request of Object.values(state.ownerRequests).filter((r) => r.answer === undefined)) {
    needs.push({
      key: `request:${request.requestId}`,
      title: `The Manager of ${request.module} asks you`,
      body: (
        <>
          <Markdown text={request.question} />
          {request.blocking && <p className="muted small">No new attempt starts until you answer.</p>}
          <Reply label="Answer" placeholder="Your answer" onSend={(text) => post('/api/answer', { id: request.requestId, text })} />
        </>
      ),
    });
  }
  for (const module of Object.values(state.modules)) {
    const latest = module.proposals.at(-1);
    if (module.status === 'proposed' && latest && !latest.acceptedAt) {
      needs.push({
        key: `proposal:${module.module}`,
        title: `The Architect of ${module.module} proposes v${latest.version}`,
        body: (
          <>
            <Proposal module={module.module} version={latest.version} />
            <div className="row">
              <Action label={`Accept v${latest.version}`} onClick={() => post('/api/accept', { module: module.module, version: latest.version })} />
              <button onClick={() => go('agents', `architect:${module.module}`)}>Ask for changes in its terminal</button>
            </div>
          </>
        ),
      });
    }
    if (module.status === 'in_review' && module.design?.pr) {
      needs.push({
        key: `design:${module.module}`,
        title: module.frozenCommit ? `A change to the design of ${module.module} is ready for review` : `The design of ${module.module} is ready for review`,
        body: (
          <>
            {module.frozenCommit && <p>{module.design.summary}</p>}
            <p>
              Review and merge <GithubLink url={module.design.pr.url}>Arch PR #{module.design.pr.number}</GithubLink> on GitHub, with a merge commit.
              Comments go to the Architect, in its terminal.
              {module.frozenCommit && ' No new attempt starts in this module until you merge or close it.'}
            </p>
            {module.design.suspect.length > 0 && (
              <p className="warn small">These checks already pass before anything is built, so they may test nothing: {module.design.suspect.join(', ')}</p>
            )}
          </>
        ),
      });
    }
    for (const escalation of module.escalations.filter((e) => e.decision === undefined)) {
      needs.push({
        key: `escalation:${escalation.id}`,
        title: `The Manager asks the Architect of ${module.module}${escalation.feature ? ` about ${escalation.feature}` : ''}`,
        body: (
          <>
            <Markdown text={escalation.question} />
            <p className="muted small">The Architect decides. You can weigh in at its terminal.</p>
            <button onClick={() => go('agents', `architect:${module.module}`)}>Open its terminal</button>
          </>
        ),
      });
    }
  }
  for (const plan of Object.values(state.plans).filter((p) => p.status === 'ready_to_merge' && p.pr)) {
    needs.push({
      key: `merge:${plan.module}/${plan.plan}`,
      title: `${plan.module}/${plan.plan} passed CI`,
      body: <p>Review and merge <GithubLink url={plan.pr!.url}>PR #{plan.pr!.number}</GithubLink> on GitHub, with a merge commit.</p>,
    });
  }
  for (const feature of Object.values(state.features).filter((f) => f.status === 'escalated')) {
    needs.push({ key: `escalated:${key(feature)}`, title: `${key(feature)} is escalated`, body: <Escalated feature={feature} /> });
  }
  for (const module of design.modules) {
    for (const action of module.actions) {
      const status = state.actions[`${module.id}/${action.id}`];
      if (status?.status === 'done') continue;
      needs.push({
        key: `action:${module.id}/${action.id}`,
        title: `${action.kind === 'gate' ? 'Gate' : 'Task'} ${module.id}/${action.id}: ${action.title}`,
        body: (
          <>
            {action.blocks.length > 0 && <p className="muted small">Holds back {action.blocks.join(', ')} until it's done.</p>}
            <Markdown text={action.instructions} />
            {status?.status === 'verifying' && <p className="run small">Its check is running.</p>}
            {status?.status === 'refused' && <p className="bad small">Its check failed: {status.reason}</p>}
            <Reply
              label={action.verify ? 'Done: run its check' : 'Mark done'}
              placeholder="A note (optional)"
              optional
              onSend={(note) => post('/api/actions/done', { module: module.id, action: action.id, ...(note ? { note } : {}) })}
            />
          </>
        ),
      });
    }
  }
  return needs;
}

export function NeedsYou({ data, go }: { data: DashboardState; go: Go }) {
  const needs = collectNeeds(data, go);
  if (needs.length === 0) return <p className="muted">Nothing needs you.</p>;
  return (
    <div className="stack">
      {needs.map((need) => (
        <section key={need.key} className="need">
          <h3>{need.title}</h3>
          {need.body}
        </section>
      ))}
    </div>
  );
}

/** One more attempt with guidance, the question to the Architect, or a pause (§14.2). */
function Escalated({ feature }: { feature: FeatureState }) {
  const [note, setNote] = useState('');
  return (
    <>
      <p>{feature.escalation}</p>
      <textarea rows={2} value={note} placeholder="Guidance for one more attempt, or a note for the Architect" onChange={(e) => setNote(e.target.value)} />
      <div className="row">
        <Action label="One more attempt" onClick={() => post('/api/retry', { feature: key(feature), ...(note.trim() ? { note } : {}) })} />
        <Action
          label="Send it to the Architect"
          onClick={() =>
            post('/api/architect', {
              module: feature.module,
              text: `[owner] ${key(feature)} is escalated: ${feature.escalation ?? ''} ${note.trim() ? `My note: ${note.trim()}` : ''} Should the design change?`,
            })
          }
        />
        <Action label="Pause the pipeline" onClick={() => post('/api/pause')} />
      </div>
    </>
  );
}

export function Proposal({ module, version }: { module: string; version: number }) {
  const [text, setText] = useState<string>();
  useEffect(() => {
    void getText(`/api/proposal?module=${encodeURIComponent(module)}&version=${version}`).then(setText);
  }, [module, version]);
  return <div className="document">{text === undefined ? <p className="muted">Loading…</p> : <Markdown text={text} />}</div>;
}

const key = (f: FeatureState) => `${f.module}/${f.plan}/${f.feature}`;
