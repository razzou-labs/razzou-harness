import { useEffect, useState } from 'react';
import { post, useHarness, type DashboardState } from './api.ts';
import { Action, Badge, Command } from './components/ui.tsx';
import { Agents } from './views/Agents.tsx';
import { Events } from './views/Events.tsx';
import { collectNeeds, NeedsYou } from './views/NeedsYou.tsx';
import { Project } from './views/Project.tsx';
import { Sandboxes } from './views/Sandboxes.tsx';

export type View = 'needs' | 'project' | 'agents' | 'sandboxes' | 'events';
/** Opens a view, and what to select in it, through the URL: a reload keeps it. */
export type Go = (view: View, detail?: string) => void;

const TABS: Array<[View, string]> = [['needs', 'Needs you'], ['project', 'Project'], ['agents', 'Agents'], ['sandboxes', 'Sandboxes'], ['events', 'Events']];

function route(hash: string): { view: View; detail?: string } {
  const [view, ...rest] = hash.replace(/^#/, '').split('/');
  const known = TABS.some(([v]) => v === view) ? (view as View) : 'needs';
  return rest.length ? { view: known, detail: decodeURIComponent(rest.join('/')) } : { view: known };
}

/**
 * What only the owner can do before Swarm merges anything (v3 §2.1, §3.4, §4.3), with the
 * commands ready to copy: the steps the daemon sees undone (v4 §6), or all three while it
 * can't tell. Nothing once every step is done.
 */
function SwarmSetup({ repo, setup }: { repo: string; setup?: DashboardState['setup'] }) {
  const rules = setup?.rules;
  const steps = [
    ...(!rules || !rules.ok ? [(
      <li key="rules">
        Apply the mode's rules on GitHub, with your own <code>gh</code>: <Command text={`harness github-setup --repo ${repo}`} />
        {rules && rules.problems.length > 0 && <span className="muted"> · now: {rules.problems.join('; ')}</span>}
      </li>
    )] : []),
    ...(setup?.statusesWritable === false || !setup ? [(
      <li key="statuses">
        Give the App <b>Commit statuses: write</b> on GitHub, and accept the new permission on its installation.
        {setup ? ' The daemon could only get a read token.' : ' An App created with this version has it already.'} Without it the reviewers' verdicts can't be posted, and pull requests wait for you with the reason.
      </li>
    )] : []),
    ...(!setup?.tokenStored ? [(
      <li key="token">
        Store the token the usage probe reads, in a terminal: <Command text="harness doctor" /> asks for the one from <code>claude setup-token</code>. Without it the daemon learns of a limit only when an attempt hits it.
      </li>
    )] : []),
  ];
  if (steps.length === 0) return null;
  return (
    <div className="note">
      <b>Before you use Swarm</b>{setup ? `, ${steps.length === 1 ? 'one step' : `${steps.length} steps`} left` : ', three steps, once'}. Swarm merges only once GitHub's rules match the mode; <code>harness doctor</code> checks all of it.
      <ol>{steps}</ol>
    </div>
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
  const infraByDaemon = (data.state.infraMerge ?? 'ceiling') === 'daemon';
  // The owner's button for INFRA and MIXED plans (v3 D36): the reviewers and CI as the gate, the cost ceiling still holding.
  const switchInfra = () => {
    const question = infraByDaemon
      ? 'INFRA and MIXED plans will wait for you again, unless the cost job\'s estimate is under the ceiling. Keep their merges for you?'
      : 'INFRA and MIXED plans will merge themselves once CI, the security reviewer and the cost reviewer pass, like CODE plans. An estimate over the ceiling still waits for you. Let the daemon merge infra?';
    return window.confirm(question) ? post('/api/infra-merge', { by: infraByDaemon ? 'ceiling' : 'daemon' }) : Promise.resolve({ done: true });
  };
  // The switch takes effect at item boundaries; the daemon records it, and applies main's rules with the owner's gh, as `harness mode` does (v3 §2.1).
  const switchMode = async () => {
    const question = swarm
      ? 'In Manual you review and merge every pull request yourself. Switch to Manual?'
      : 'In Swarm the daemon merges plans that pass CI and the reviewers, without your review. Switch to Swarm?';
    if (!window.confirm(question)) return { done: true };
    const result = (await post('/api/mode', { mode: swarm ? 'manual' : 'swarm' })) as { done: boolean; error?: string; problem?: string };
    return result.problem ? { ...result, warning: `GitHub's rules on main were not changed: ${result.problem}` } : result;
  };
  return (
    <>
      <header>
        <h1>harness · {data.design.project}</h1>
        <Badge status={paused ? 'paused' : 'running'} />
        {paused ? <Action label="Resume" onClick={() => post('/api/resume')} /> : <Action label="Pause" onClick={() => post('/api/pause')} />}
        <Badge status={swarm ? 'swarm' : 'manual'} label={swarm ? 'Swarm' : 'Manual'} />
        <Action label={swarm ? 'Switch to Manual' : 'Switch to Swarm'} onClick={switchMode} />
        {swarm && <Badge status={infraByDaemon ? 'swarm' : 'waiting'} label={infraByDaemon ? 'Infra: the daemon merges' : 'Infra: yours'} />}
        {swarm && <Action label={infraByDaemon ? 'Keep infra merges for me' : 'Let the daemon merge infra'} onClick={switchInfra} />}
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
      {swarm && (data.design.repo
        ? <SwarmSetup repo={data.design.repo} {...(data.setup ? { setup: data.setup } : {})} />
        : <div className="note">Swarm: this project has no GitHub repository, so there is nothing to merge; plans complete locally.</div>)}
      <main>
        {current.view === 'needs' && <NeedsYou data={data} go={go} />}
        {current.view === 'project' && <Project data={data} />}
        {current.view === 'agents' && <Agents data={data} go={go} {...(current.detail ? { selected: current.detail } : {})} />}
        {current.view === 'sandboxes' && <Sandboxes go={go} {...(current.detail ? { selected: current.detail } : {})} />}
        {current.view === 'events' && <Events />}
      </main>
    </>
  );
}
