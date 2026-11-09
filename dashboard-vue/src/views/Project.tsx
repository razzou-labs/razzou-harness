import { QBtn, QCard, QCardSection, QInput, QLinearProgress, QMarkupTable } from 'quasar';
import { defineComponent, onUnmounted, ref, watchEffect, type PropType, type Ref } from 'vue';
import { post, type Attempt, type DashboardState, type FeatureState, type OwnerTime, type PlanState, type State, type SubscriptionUsage, type UsageLimit } from '../api.ts';
import { Graph } from '../components/Graph.tsx';
import { duration } from '../format.ts';
import { Action, Badge, GithubLink, text } from '../ui.tsx';
import { Proposal } from './NeedsYou.tsx';

/** Modules, proposals, plans and features, with CI, deploys and progress (§14.1). */
export const Project = defineComponent({
  props: { data: { type: Object as PropType<DashboardState>, required: true } },
  setup(props) {
    const reading = ref<{ module: string; version: number }>();
    return () => {
      const { state, design, progress } = props.data;
      const moduleIds = [...new Set([...Object.keys(state.modules), ...design.modules.map((m) => m.id)])];
      return (
        <div class="column q-gutter-md">
          <Budgets state={state} ceiling={design.swarm?.usageCeilingPercent ?? null} {...(props.data.ownerTime ? { ownerTime: props.data.ownerTime } : {})} {...(props.data.usage ? { usage: props.data.usage } : {})} />
          <NewModule />
          {moduleIds.length === 0 && <p class="text-grey-7">No module yet.</p>}
          {moduleIds.map((id) => {
            const module = state.modules[id];
            const designed = design.modules.find((m) => m.id === id);
            const plans = designed?.plans ?? [];
            const open = reading.value;
            return (
              <QCard key={id} flat bordered>
                <QCardSection>
                  <div class="text-h6 row items-center q-gutter-sm">
                    <span>{id}</span>
                    {module && <span class="text-grey-7 text-subtitle1">· {module.title}</span>}
                    {module && <Badge status={module.status} />}
                    {module?.design?.pr && <span class="text-subtitle2">· <GithubLink url={module.design.pr.url}>Arch PR #{module.design.pr.number}</GithubLink></span>}
                  </div>
                  {module && module.proposals.length > 0 && (
                    <div class="row items-center q-gutter-xs q-mt-sm">
                      <span class="text-grey-7 q-mr-xs">Proposals:</span>
                      {module.proposals.map((p) => {
                        const selected = open?.module === id && open.version === p.version;
                        return (
                          <QBtn key={p.version} dense noCaps padding="2px 10px" outline={!selected} unelevated={selected} color="primary"
                            label={`v${p.version}${p.acceptedAt ? ' ✓' : ''}`}
                            onClick={() => (reading.value = selected ? undefined : { module: id, version: p.version })} />
                        );
                      })}
                    </div>
                  )}
                  {open?.module === id && <Proposal module={id} version={open.version} />}
                  {designed && plans.length > 0 && <Graph module={designed} state={state} />}
                  {plans.map((plan) => <Plan key={plan.id} data={props.data} module={id} plan={plan} />)}
                </QCardSection>
              </QCard>
            );
          })}
          <QCard flat bordered>
            <QCardSection>
              <div class="text-h6">progress.txt</div>
              <pre>{progress.join('\n') || '(nothing accepted yet)'}</pre>
            </QCardSection>
          </QCard>
        </div>
      );
    };
  },
});

/** Now, refreshed every `everyMs` while `ticking()`: for clocks that must move without an event. */
function useNow(ticking: () => boolean, everyMs = 60_000): Ref<number> {
  const now = ref(Date.now());
  let timer: number | undefined;
  watchEffect(() => {
    window.clearInterval(timer);
    now.value = Date.now();
    if (ticking()) timer = window.setInterval(() => (now.value = Date.now()), everyMs);
  });
  onUnmounted(() => window.clearInterval(timer));
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

const Meter = defineComponent({
  props: { title: { type: String, required: true } },
  setup(props, { slots }) {
    return () => (
      <div class="col-12 col-sm-6 col-lg-3">
        <QCard flat bordered class="meter full-height">
          <QCardSection>
            <div class="text-subtitle1 text-weight-medium q-mb-xs">{props.title}</div>
            {slots.default?.()}
          </QCardSection>
        </QCard>
      </div>
    );
  },
});

/** The owner's hours for the whole project, and the agent-hours threshold (v3 §4): set here, recorded by the daemon. */
const Budgets = defineComponent({
  props: {
    state: { type: Object as PropType<State>, required: true },
    ceiling: { type: Number as PropType<number | null>, default: null },
    ownerTime: Object as PropType<OwnerTime>,
    usage: Object as PropType<{ at: string; usage: SubscriptionUsage }>,
  },
  setup(props) {
    const now = useNow(() => Object.values(props.state.features).some((f) => f.attempts.some((a) => !a.endedAt)));
    return () => {
      const { state, ownerTime } = props;
      const budgets = state.budgets ?? {};
      const overPlanned = ownerTime !== undefined && ownerTime.committedHours > ownerTime.plannableHours;
      const overUsed = ownerTime !== undefined && ownerTime.usedHours > ownerTime.hours;
      const agentHours = agentMs(state, now.value) / 3_600_000;
      const over = budgets.agentHours !== undefined && agentHours > budgets.agentHours;
      return (
        <QCard flat bordered>
          <QCardSection>
            <div class="text-h6 q-mb-sm">Budgets</div>
            <div class="row q-col-gutter-md">
              <Meter title="Your time">
                <p>
                  {budgets.ownerHours !== undefined
                    ? <><b>{budgets.ownerHours} h</b> for the whole project{budgets.ownerHoursSetAt && <span class="text-grey-7">, set {new Date(budgets.ownerHoursSetAt).toLocaleDateString()}</span>}</>
                    : <span class="text-grey-7">Not set: the Architect designs without a limit on your time.</span>}
                </p>
                {ownerTime && (
                  <p>
                    <b class={overUsed ? 'text-negative' : undefined}>{ownerTime.usedHours} h used</b>
                    {' · '}
                    <span class={overPlanned ? 'text-negative' : undefined}>{ownerTime.committedHours} h planned by the designs</span>
                    {' · '}
                    <span class="text-grey-7">{ownerTime.plannableHours} h plannable after the {ownerTime.reservePercent}% reserve</span>
                  </p>
                )}
                <HoursForm field="ownerHours" value={budgets.ownerHours} placeholder="hours" />
                <p class="text-caption text-grey-7 q-mt-sm">
                  {ownerTime
                    ? "Planned: the estimates of the owner actions in submitted designs, gates and tasks. Used: the actions you marked done. What you read, proposals and pull requests, doesn't count."
                    : 'Once set, the Architect must estimate every owner action and design within your hours; a design over them is refused.'}
                </p>
              </Meter>
              <Meter title="Agent hours">
                <p>
                  <b class={over ? 'text-negative' : undefined}>{agentHours.toFixed(1)} h</b>
                  {budgets.agentHours !== undefined ? <> of {budgets.agentHours} h</> : <span class="text-grey-7"> · no threshold</span>}
                  {over && <span class="text-negative text-caption"> · over the threshold</span>}
                </p>
                <HoursForm field="agentHours" value={budgets.agentHours} placeholder="threshold" />
                <p class="text-caption text-grey-7 q-mt-sm">The Developers' attempt clocks, summed. Over the threshold the number turns red; nothing stops.</p>
              </Meter>
              <TokensMeter state={state} />
              <SubscriptionMeter ceiling={props.ceiling} {...(props.usage ? { usage: props.usage } : {})} />
            </div>
          </QCardSection>
        </QCard>
      );
    };
  },
});

/** Every token Claude used for the project, written and read, and by role. */
const TokensMeter = defineComponent({
  props: { state: { type: Object as PropType<State>, required: true } },
  setup(props) {
    return () => {
      const roles = tokensByRole(props.state);
      const total = roles.reduce((sum, [, t]) => ({ input: sum.input + t.input, output: sum.output + t.output }), { input: 0, output: 0 });
      return (
        <Meter title="Claude tokens">
          <p>
            <b>{count(total.input + total.output)}</b>
            <span class="text-grey-7"> · {count(total.output)} written, {count(total.input)} read, cache included</span>
          </p>
          <p class="text-caption">{roles.map(([role, t]) => `${role} ${count(t.input + t.output)}`).join(' · ')}</p>
          <p class="text-caption text-grey-7">
            Claude Code's own counts: an attempt's and a review's when it ends, a Manager's and an Architect's every five minutes. Most of what is read comes from the prompt cache.
          </p>
        </Meter>
      );
    };
  },
});

/**
 * The subscription's windows as bars: the current session and the weekly limit, as an
 * agent's model call last reported them. Before any report, the box says where they come from.
 */
const SubscriptionMeter = defineComponent({
  props: {
    ceiling: { type: Number as PropType<number | null>, default: null },
    usage: Object as PropType<{ at: string; usage: SubscriptionUsage }>,
  },
  setup(props) {
    const now = useNow(() => true);
    return () => {
      const { usage, ceiling } = props;
      if (!usage) {
        return (
          <Meter title="Subscription">
            <p class="text-grey-7">No report yet. The Developers, the Manager and the reviewers report your usage with each model call; the bars appear with the first one.</p>
          </Meter>
        );
      }
      return (
        <Meter title="Subscription">
          {usage.usage.limits.map((limit) => {
            const hot = ceiling !== null && limit.percent >= ceiling;
            return (
              <div key={`${limit.kind}:${limit.model ?? ''}`} class="q-mb-sm">
                <div class="row justify-between">
                  <span>{limitLabel(limit)}</span>
                  <b class={hot ? 'text-negative' : undefined}>{limit.percent}%</b>
                </div>
                <QLinearProgress value={Math.max(0, Math.min(100, limit.percent)) / 100} color={hot ? 'negative' : 'primary'} trackColor="grey-4" rounded size="8px" class="q-my-xs" />
                <div class="text-caption text-grey-7">resets {resetsIn(limit.resetsAt, now.value)}</div>
              </div>
            );
          })}
          <p class="text-caption text-grey-7">
            Reported by an agent's model call at {new Date(usage.at).toLocaleTimeString()}. In Swarm no attempt starts at or above {ceiling === null ? 'the ceiling, which is off' : `${ceiling}%`}; the pipeline waits for the window to reset.
          </p>
        </Meter>
      );
    };
  },
});

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

/** A number of hours to save, or clear: null clears it on the daemon. */
const HoursForm = defineComponent({
  props: {
    field: { type: String as PropType<'ownerHours' | 'agentHours'>, required: true },
    value: Number,
    placeholder: { type: String, required: true },
  },
  setup(props) {
    const hours = ref('');
    return () => {
      const n = Number(hours.value);
      const valid = hours.value.trim() !== '' && Number.isFinite(n) && n > 0;
      return (
        <div class="row items-center q-gutter-sm">
          <QInput {...text(hours)} type="number" dense outlined label={props.placeholder} style="width: 120px" />
          <Action
            label="Save"
            run={async () => {
              if (!valid) return { done: false, error: 'a positive number of hours' };
              const result = await post('/api/budgets', { [props.field]: n });
              if (result.done) hours.value = '';
              return result;
            }}
          />
          {props.value !== undefined && <Action label="Clear" flat run={() => post('/api/budgets', { [props.field]: null })} />}
        </div>
      );
    };
  },
});

const NewModule = defineComponent({
  setup() {
    const id = ref('');
    const title = ref('');
    const error = ref<string>();
    const start = async () => {
      const result = await post('/api/modules', { id: id.value.trim(), title: title.value });
      error.value = result.done ? undefined : result.error;
      if (result.done) {
        id.value = '';
        title.value = '';
      }
    };
    return () => (
      <QCard flat bordered>
        <QCardSection>
          <div class="text-h6 q-mb-sm">Start a module</div>
          <div class="row items-center q-gutter-sm">
            <QInput {...text(id)} dense outlined label="id, like orders" style="width: 180px" />
            <QInput {...text(title)} dense outlined label="what it is for" class="col" style="min-width: 240px; max-width: 480px" />
            <QBtn label="Start" color="primary" noCaps unelevated disable={!id.value.trim()} onClick={() => void start()} />
            {error.value && <span class="text-negative text-caption">{error.value}</span>}
          </div>
          <p class="text-caption text-grey-7 q-mt-sm">An Architect starts in its own sandbox; talk to it in the Agents view.</p>
        </QCardSection>
      </QCard>
    );
  },
});

type PlanDesign = DashboardState['design']['modules'][number]['plans'][number];

const Plan = defineComponent({
  props: {
    data: { type: Object as PropType<DashboardState>, required: true },
    module: { type: String, required: true },
    plan: { type: Object as PropType<PlanDesign>, required: true },
  },
  setup(props) {
    return () => {
      const { state, design } = props.data;
      const plan = props.plan;
      const key = `${props.module}/${plan.id}`;
      const planState = state.plans[key];
      const fixes = Object.values(state.features).filter((f) => f.fix && `${f.module}/${f.plan}` === key);
      const rows = [
        ...plan.features.map((f) => ({ id: f.id, title: f.title, kind: f.kind as string, state: state.features[`${key}/${f.id}`] })),
        ...fixes.map((f) => ({ id: f.feature, title: `Fix after ${f.fix!.kind === 'ci' ? 'CI' : 'the deploy'}, round ${f.fix!.round}`, kind: 'fix', state: f })),
      ];
      return (
        <div class="plan q-mt-md">
          <div class="text-subtitle1 text-weight-medium row items-center q-gutter-sm">
            <span>{plan.id} · {plan.title}</span>
            <Badge status={planState?.status ?? 'waiting'} />
            {planState?.pr && <GithubLink url={planState.pr.url}>PR #{planState.pr.number}</GithubLink>}
            {planState?.mergedBy === 'daemon' && <span class="text-grey-7 text-caption">merged by the daemon</span>}
            {planState?.ci && <Badge status={planState.ci.status} label={`CI ${planState.ci.status}`} />}
          </div>
          {planState && <PlanDetails plan={planState} />}
          <QMarkupTable flat bordered dense wrapCells class="q-mt-sm">
            <thead>
              <tr><th class="text-left">Feature</th><th class="text-left">Status</th><th class="text-left">Attempts</th><th class="text-left">Last attempt</th><th class="text-left">Commit</th></tr>
            </thead>
            <tbody>
              {rows.map((row) => <FeatureRow key={row.id} id={row.id} title={row.title} kind={row.kind} max={design.maxAttempts} {...(row.state ? { feature: row.state } : {})} />)}
            </tbody>
          </QMarkupTable>
        </div>
      );
    };
  },
});

const PlanDetails = defineComponent({
  props: { plan: { type: Object as PropType<PlanState>, required: true } },
  setup(props) {
    return () => {
      const plan = props.plan;
      const failedJobs = plan.ci?.jobs?.filter((j) => j.conclusion !== 'success') ?? [];
      return (
        <div class="text-caption q-mt-xs">
          {failedJobs.map((job) => (
            <details key={job.name}>
              <summary class="text-negative">CI job {job.name}: {job.conclusion}</summary>
              <pre>{job.log ?? ''}</pre>
            </details>
          ))}
          {plan.reviews?.filter((r) => r.head === plan.pushed).map((r) => (
            <p key={`${r.role}-${r.head}`} class="q-my-xs">
              {r.role === 'security' ? 'Security' : 'Cost'} review of {r.head.slice(0, 8)}:{' '}
              {r.status === 'reported'
                ? <><Badge status={r.verdict === 'pass' ? 'passed' : 'failed'} label={r.verdict ?? 'reported'} /> {r.findings?.filter((f) => f.severity === 'blocking').length ?? 0} blocking, {r.findings?.filter((f) => f.severity === 'advisory').length ?? 0} advisory{r.posted?.problem ? <span class="text-negative"> · {r.posted.problem}</span> : null}</>
                : r.status === 'failed'
                  ? <span class="text-negative">failed: {r.reason}</span>
                  : <Badge status={r.status} />}
            </p>
          ))}
          {plan.deploy && (
            <p class="q-my-xs">
              Deploy of {plan.deploy.commit.slice(0, 8)}: <Badge status={plan.deploy.status} />
              {plan.deploy.jobs?.filter((j) => j.conclusion !== 'success').map((j) => <GithubLink key={j.name} url={j.url}> {j.name}</GithubLink>)}
            </p>
          )}
          {plan.postDeploy && (
            <details>
              <summary>Post-deploy checks: <Badge status={plan.postDeploy.status} /></summary>
              {plan.postDeploy.results.map((r) => (
                <div key={r.id}>
                  <b class={r.exit === 0 ? 'text-positive' : 'text-negative'}>{r.id}</b> <span class="text-grey-7">{duration(r.durationMs)}</span>
                  <pre>{r.output}</pre>
                </div>
              ))}
            </details>
          )}
        </div>
      );
    };
  },
});

const FeatureRow = defineComponent({
  props: {
    id: { type: String, required: true },
    title: { type: String, required: true },
    kind: { type: String, required: true },
    max: { type: Number, required: true },
    feature: Object as PropType<FeatureState>,
  },
  setup(props) {
    return () => {
      const feature = props.feature;
      const last: Attempt | undefined = feature?.attempts.at(-1);
      // As the daemon counts: failures that count, for the feature's current definition.
      const counted = last ? feature!.attempts.filter((a) => a.definitionHash === last.definitionHash && a.counts).length : 0;
      const ended = last?.endedAt ? Date.parse(last.endedAt) : Date.now();
      return (
        <tr>
          <td>
            <b>{props.id}</b> {props.title} {props.kind === 'infra' && <span class="text-grey-7 text-caption">infra</span>}
          </td>
          <td>
            <Badge status={feature?.status ?? 'pending'} />
            {feature?.awaitingGuidanceSince && <div class="text-grey-7 text-caption">waiting for the Manager's guidance</div>}
          </td>
          <td class="mono">{feature ? `${feature.attempts.length}${counted ? ` (${counted} of ${props.max + feature.extraAttempts} counted)` : ''}` : '0'}</td>
          <td>
            {last && (
              <>
                {last.status}
                {last.outcome ? ` · ${last.outcome}` : ''} · {duration(ended - Date.parse(last.startedAt))}
                {last.reason && <div class="text-caption">{last.reason}</div>}
                {last.finding && (
                  <details class="text-caption">
                    <summary>Finding: {last.finding.category}</summary>
                    <p>{last.finding.summary}</p>
                    {last.finding.needs && <p>Needs: {last.finding.needs}</p>}
                  </details>
                )}
                {last.questions?.map((q) => (
                  <div key={q.requestId} class="text-caption text-grey-7">Q: {q.text}{q.answer ? ` — A: ${q.answer}` : ''}</div>
                ))}
              </>
            )}
          </td>
          <td class="mono">{feature?.commit?.slice(0, 8) ?? ''}</td>
        </tr>
      );
    };
  },
});
