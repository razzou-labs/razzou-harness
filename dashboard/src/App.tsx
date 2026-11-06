import { useEffect, useState } from 'react';
import { post, useHarness } from './api.ts';
import { Action, Badge, Command } from './components/ui.tsx';
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

/** What only the owner can do before Swarm merges anything (v3 §2.1, §3.4, §4.3), with the commands ready to copy. */
function SwarmSetup({ repo }: { repo: string }) {
  return (
    <>
      <b>Before you use Swarm</b>, three steps, once. Swarm merges only once GitHub's rules match the mode; <code>harness doctor</code> checks all three.
      <ol>
        <li>Apply the mode's rules on GitHub, with your own <code>gh</code>: <Command text={`harness github-setup --repo ${repo}`} /></li>
        <li>Give the App <b>Commit statuses: write</b> on GitHub, and accept the new permission on its installation. An App created with this version has it already; without it the daemon falls back to read, and pull requests wait for you with the reason.</li>
        <li>Store the token the usage probe reads, in a terminal: <Command text="harness doctor" /> asks for the one from <code>claude setup-token</code>. Without it the daemon learns of a limit only when an attempt hits it.</li>
      </ol>
    </>
  );
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
          {data.design.repo ? <SwarmSetup repo={data.design.repo} /> : 'Swarm: this project has no GitHub repository, so there is nothing to merge; plans complete locally.'}
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
