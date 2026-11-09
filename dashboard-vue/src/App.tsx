import { matPause, matPlayArrow, matSwapHoriz } from '@quasar/extras/material-icons';
import { QBadge, QBanner, QBtn, QHeader, QLayout, QPage, QPageContainer, QTab, QTabs, QToolbar, QToolbarTitle } from 'quasar';
import { defineComponent, onUnmounted, ref } from 'vue';
import { connect, harness, post, type DashboardState, type Outcome } from './api.ts';
import { Action, Badge, Command, confirm } from './ui.tsx';
import { Agents } from './views/Agents.tsx';
import { Events } from './views/Events.tsx';
import { collectNeeds, NeedsYou } from './views/NeedsYou.tsx';
import { Project } from './views/Project.tsx';
import { Sandboxes } from './views/Sandboxes.tsx';

export type View = 'needs' | 'project' | 'agents' | 'sandboxes' | 'events';
/** Opens a view, and what to select in it, through the URL: a reload keeps it, and so does a switch of dashboard. */
export type Go = (view: View, detail?: string) => void;

const TABS: Array<[View, string]> = [['needs', 'Needs you'], ['project', 'Project'], ['agents', 'Agents'], ['sandboxes', 'Sandboxes'], ['events', 'Events']];

function route(hash: string): { view: View; detail?: string } {
  const [view, ...rest] = hash.replace(/^#/, '').split('/');
  const known = TABS.some(([v]) => v === view) ? (view as View) : 'needs';
  return rest.length ? { view: known, detail: decodeURIComponent(rest.join('/')) } : { view: known };
}

/** Which dashboard opens: the choice stays in this browser, and the first dashboard reads it too. */
export const DASHBOARD_CHOICE = 'harness-dashboard';

/** Back to the first dashboard, on the same view; it opens from now on. */
function toClassic(): void {
  localStorage.setItem(DASHBOARD_CHOICE, 'classic');
  location.href = `/${location.hash}`;
}

/**
 * The second dashboard, in Vue and Quasar (§14): the same views, from the same daemon,
 * while the owner compares it with the first.
 */
export const App = defineComponent({
  setup() {
    connect();
    const current = ref(route(location.hash));
    const onHash = () => (current.value = route(location.hash));
    window.addEventListener('hashchange', onHash);
    onUnmounted(() => window.removeEventListener('hashchange', onHash));
    const go: Go = (view, detail) => {
      location.hash = detail ? `${view}/${encodeURIComponent(detail)}` : view;
    };
    return () => {
      const data = harness.data;
      if (!data) return <div class="q-pa-lg text-body1">{harness.problem ?? 'Connecting to the daemon…'}</div>;
      const needs = collectNeeds(data, go).length;
      const { view, detail } = current.value;
      return (
        <QLayout view="hHh lpR fFf">
          <QHeader bordered class="harness-header">
            <Toolbar data={data} />
            <QTabs modelValue={view} {...{ 'onUpdate:modelValue': (next: View) => go(next) }} align="left" dense noCaps inlineLabel activeColor="primary" indicatorColor="primary">
              {TABS.map(([name, label]) => (
                <QTab key={name} name={name} label={label}>
                  {name === 'needs' && needs > 0 && <QBadge color="warning" floating label={String(needs)} />}
                </QTab>
              ))}
            </QTabs>
          </QHeader>
          <QPageContainer>
            <QPage padding class="harness-page">
              {harness.problem && <QBanner class="bg-negative text-white q-mb-md" rounded>{harness.problem}</QBanner>}
              <SwarmNote data={data} />
              {view === 'needs' && <NeedsYou data={data} go={go} />}
              {view === 'project' && <Project data={data} />}
              {view === 'agents' && <Agents data={data} go={go} {...(detail ? { selected: detail } : {})} />}
              {view === 'sandboxes' && <Sandboxes go={go} {...(detail ? { selected: detail } : {})} />}
              {view === 'events' && <Events />}
            </QPage>
          </QPageContainer>
        </QLayout>
      );
    };
  },
});

/** The project, the pipeline's pause, the mode and the infra merges, and the way back to the first dashboard. */
const Toolbar = defineComponent({
  props: { data: { type: Object as () => DashboardState, required: true } },
  setup(props) {
    // The switch takes effect at item boundaries; the daemon records it, and applies main's rules with the owner's gh, as `harness mode` does (v3 §2.1).
    const switchMode = async (swarm: boolean): Promise<Outcome> => {
      const question = swarm
        ? 'In Manual you review and merge every pull request yourself. Switch to Manual?'
        : 'In Swarm the daemon merges plans that pass CI and the reviewers, without your review. Switch to Swarm?';
      if (!(await confirm(question))) return { done: true };
      const result = await post('/api/mode', { mode: swarm ? 'manual' : 'swarm' });
      return typeof result.problem === 'string' ? { ...result, warning: `GitHub's rules on main were not changed: ${result.problem}` } : result;
    };
    // The owner's button for INFRA and MIXED plans (v3 D36): the reviewers and CI as the gate, the cost ceiling still holding.
    const switchInfra = async (byDaemon: boolean): Promise<Outcome> => {
      const question = byDaemon
        ? "INFRA and MIXED plans will wait for you again, unless the cost job's estimate is under the ceiling. Keep their merges for you?"
        : 'INFRA and MIXED plans will merge themselves once CI, the security reviewer and the cost reviewer pass, like CODE plans. An estimate over the ceiling still waits for you. Let the daemon merge infra?';
      return (await confirm(question)) ? post('/api/infra-merge', { by: byDaemon ? 'ceiling' : 'daemon' }) : { done: true };
    };
    return () => {
      const { state, design } = props.data;
      const paused = state.pipeline.paused;
      const swarm = (state.mode ?? 'manual') === 'swarm';
      const infraByDaemon = (state.infraMerge ?? 'ceiling') === 'daemon';
      return (
        <QToolbar class="q-gutter-x-sm wrap">
          <QToolbarTitle shrink class="text-weight-medium">harness · {design.project}</QToolbarTitle>
          <Badge status={paused ? 'paused' : 'running'} />
          {paused
            ? <Action label="Resume" icon={matPlayArrow} toast run={() => post('/api/resume')} />
            : <Action label="Pause" icon={matPause} toast run={() => post('/api/pause')} />}
          <Badge status={swarm ? 'swarm' : 'manual'} label={swarm ? 'Swarm' : 'Manual'} />
          <Action label={swarm ? 'Switch to Manual' : 'Switch to Swarm'} toast run={() => switchMode(swarm)} />
          {swarm && <Badge status={infraByDaemon ? 'swarm' : 'waiting'} label={infraByDaemon ? 'Infra: the daemon merges' : 'Infra: yours'} />}
          {swarm && <Action label={infraByDaemon ? 'Keep infra merges for me' : 'Let the daemon merge infra'} toast run={() => switchInfra(infraByDaemon)} />}
          <span class="text-caption text-grey-7">
            {!harness.connected ? 'reconnecting…' : state.daemon ? `daemon ${state.daemon.version}, pid ${state.daemon.pid}` : 'daemon stopped'}
          </span>
          <div class="col" />
          <QBtn flat dense noCaps icon={matSwapHoriz} label="Classic dashboard" onClick={toClassic} />
        </QToolbar>
      );
    };
  },
});

/**
 * What only the owner can do before Swarm merges anything (v3 §2.1, §3.4), with the
 * commands ready to copy: the steps the daemon sees undone (v4 §6), or both while it
 * can't tell. Nothing once every step is done.
 */
const SwarmNote = defineComponent({
  props: { data: { type: Object as () => DashboardState, required: true } },
  setup(props) {
    return () => {
      const { state, design, setup } = props.data;
      if ((state.mode ?? 'manual') !== 'swarm') return null;
      if (!design.repo) {
        return <QBanner class="bg-blue-1 text-dark q-mb-md" rounded>Swarm: this project has no GitHub repository, so there is nothing to merge; plans complete locally.</QBanner>;
      }
      const rules = setup?.rules;
      const steps = [
        ...(!rules || !rules.ok ? [(
          <li key="rules">
            Apply the mode's rules on GitHub, with your own <code>gh</code>: <Command text={`harness github-setup --repo ${design.repo}`} />
            {rules && rules.problems.length > 0 && <span class="text-grey-7"> · now: {rules.problems.join('; ')}</span>}
          </li>
        )] : []),
        ...(setup?.statusesWritable === false || !setup ? [(
          <li key="statuses">
            Give the App <b>Commit statuses: write</b> on GitHub, and accept the new permission on its installation.
            {setup ? ' The daemon could only get a read token.' : ' An App created with this version has it already.'} Without it the reviewers' verdicts can't be posted, and pull requests wait for you with the reason.
          </li>
        )] : []),
      ];
      if (steps.length === 0) return null;
      return (
        <QBanner class="bg-amber-1 text-dark q-mb-md" rounded>
          <b>Before you use Swarm</b>{setup ? `, ${steps.length === 1 ? 'one step' : `${steps.length} steps`} left` : ', two steps, once'}. Swarm merges only once GitHub's rules match the mode; <code>harness doctor</code> checks all of it.
          <ol class="q-my-xs">{steps}</ol>
        </QBanner>
      );
    };
  },
});
