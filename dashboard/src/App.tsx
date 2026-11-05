import { useEffect, useState } from 'react';
import { post, useHarness } from './api.ts';
import { Action, Badge } from './components/ui.tsx';
import { Agents } from './views/Agents.tsx';
import { Events } from './views/Events.tsx';
import { collectNeeds, NeedsYou } from './views/NeedsYou.tsx';
import { Project } from './views/Project.tsx';

export type View = 'needs' | 'project' | 'agents' | 'events';
/** Opens a view, and what to select in it, through the URL: a reload keeps it. */
export type Go = (view: View, detail?: string) => void;

const TABS: Array<[View, string]> = [['needs', 'Needs you'], ['project', 'Project'], ['agents', 'Agents'], ['events', 'Events']];

function route(hash: string): { view: View; detail?: string } {
  const [view, ...rest] = hash.replace(/^#/, '').split('/');
  const known = TABS.some(([v]) => v === view) ? (view as View) : 'needs';
  return rest.length ? { view: known, detail: decodeURIComponent(rest.join('/')) } : { view: known };
}

export function App() {
  const { data, problem, connected } = useHarness();
  const [current, setCurrent] = useState(() => route(location.hash));
  useEffect(() => {
    const onChange = () => setCurrent(route(location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const go: Go = (view, detail) => {
    location.hash = detail ? `${view}/${encodeURIComponent(detail)}` : view;
  };
  if (!data) return <div className="boot">{problem ?? 'Connecting to the daemon…'}</div>;
  const needs = collectNeeds(data, go).length;
  const paused = data.state.pipeline.paused;
  const swarm = (data.state.mode ?? 'manual') === 'swarm';
  // The switch takes effect at item boundaries; the daemon records it (v3 §2.1).
  const switchMode = () => {
    const question = swarm
      ? 'In Manual you review and merge every pull request yourself. Switch to Manual?'
      : 'In Swarm the daemon merges plans that pass CI and the reviewers, without your review. Switch to Swarm?';
    return window.confirm(question) ? post('/api/mode', { mode: swarm ? 'manual' : 'swarm' }) : Promise.resolve({ done: true });
  };
  return (
    <>
      <header>
        <h1>harness · {data.design.project}</h1>
        <Badge status={paused ? 'paused' : 'running'} />
        {paused ? <Action label="Resume" onClick={() => post('/api/resume')} /> : <Action label="Pause" onClick={() => post('/api/pause')} />}
        <Badge status={swarm ? 'swarm' : 'manual'} label={swarm ? 'Swarm' : 'Manual'} />
        <Action label={swarm ? 'Switch to Manual' : 'Switch to Swarm'} onClick={switchMode} />
        <span className="muted small">
          {!connected ? 'reconnecting…' : data.state.daemon ? `daemon ${data.state.daemon.version}, pid ${data.state.daemon.pid}` : 'daemon stopped'}
        </span>
        <nav>
          {TABS.map(([view, label]) => (
            <a key={view} href={`#${view}`} className={current.view === view ? 'active' : undefined}>
              {label}
              {view === 'needs' && needs > 0 && <span className="count">{needs}</span>}
            </a>
          ))}
        </nav>
      </header>
      {problem && <div className="banner">{problem}</div>}
      {swarm && (
        <div className="note">
          {data.design.repo
            ? <>Swarm: after a switch, run <code>harness github-setup --repo {data.design.repo}</code> once so GitHub's rules match; until then nothing merges.</>
            : 'Swarm: this project has no GitHub repository, so there is nothing to merge; plans complete locally.'}
        </div>
      )}
      <main>
        {current.view === 'needs' && <NeedsYou data={data} go={go} />}
        {current.view === 'project' && <Project data={data} />}
        {current.view === 'agents' && <Agents data={data} go={go} {...(current.detail ? { selected: current.detail } : {})} />}
        {current.view === 'events' && <Events />}
      </main>
    </>
  );
}
