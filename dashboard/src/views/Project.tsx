import { QBtn, QBtnToggle, QCard, QCardSection, QInput, QLinearProgress, QTable, QTd, QTr, type QTableProps } from 'quasar';
import { defineComponent, onUnmounted, ref, watchEffect, type PropType, type Ref } from 'vue';
import { post, type Attempt, type DashboardState, type FeatureState, type OwnerTime, type PlanState, type State, type SubscriptionUsage, type UsageLimit } from '../api.ts';
import { Dependencies } from '../components/Dependencies.tsx';
import { duration, modelName } from '../format.ts';
import { Action, Badge, Fold, GithubLink, text } from '../ui.tsx';
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
          <Budgets state={state} roles={design.roles} ceiling={design.swarm?.usageCeilingPercent ?? null} {...(props.data.ownerTime ? { ownerTime: props.data.ownerTime } : {})} {...(props.data.usage ? { usage: props.data.usage } : {})} />
          <NewModule />
          {moduleIds.length === 0 && <p class="text-muted">No module yet.</p>}
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
                    {module && <span class="text-muted text-subtitle1">· {module.title}</span>}
                    {module && <Badge status={module.status} />}
                    {module?.design?.pr && <span class="text-subtitle2">· <GithubLink url={module.design.pr.url}>Arch PR #{module.design.pr.number}</GithubLink></span>}
                  </div>
                  {module && module.proposals.length > 0 && (
                    <div class="row items-center q-gutter-sm q-mt-sm">
                      <span class="text-muted">Proposals:</span>
                      <QBtnToggle
                        class="versions"
                        modelValue={open?.module === id ? open.version : null}
                        {...{ 'onUpdate:modelValue': (version: number | null) => (reading.value = version === null ? undefined : { module: id, version }) }}
                        options={module.proposals.map((p) => ({ label: `v${p.version}${p.acceptedAt ? ' ✓' : ''}`, value: p.version }))}
                        clearable unelevated dense noCaps padding="2px 10px" textColor="primary" toggleColor="primary" toggleTextColor="white"
                      />
                    </div>
                  )}
                  {open?.module === id && <Proposal module={id} version={open.version} />}
                  {designed && plans.length > 0 && <Dependencies module={designed} state={state} />}
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

/**
 * The agents' active time: each Developer's attempt and each reviewer's session, from its
 * start to its end, those running counted to `now`; a review still waiting to start counts
 * nothing. A Manager and an Architect aren't counted: they live for their module, and wait
 * far more than they work.
 */
function activeMs(state: State, now: number): { developers: number; reviewers: number } {
  const span = (start: string, end: string | undefined) => {
    const started = Date.parse(start);
    const ended = end ? Date.parse(end) : now;
    return Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : 0;
  };
  let developers = 0;
  let reviewers = 0;
  for (const feature of Object.values(state.features)) for (const attempt of feature.attempts) developers += span(attempt.startedAt, attempt.endedAt);
  for (const plan of Object.values(state.plans)) for (const review of plan.reviews ?? []) if (review.status !== 'starting') reviewers += span(review.startedAt, review.endedAt);
  return { developers, reviewers };
}

const inHours = (ms: number) => `${(ms / 3_600_000).toFixed(1)} h`;

type Tokens = { input: number; output: number };

/** Claude's tokens by role: a Developer's and a reviewer's from their sessions' end, a Manager's and an Architect's from the daemon's readings of their sandboxes. */
function tokensByRole(state: State): Array<[string, Tokens]> {
  const roles: Record<string, Tokens> = { Developers: { input: 0, output: 0 }, Managers: { input: 0, output: 0 }, Architects: { input: 0, output: 0 }, Reviewers: { input: 0, output: 0 } };
  const add = (role: string, usage?: { inputTokens: number; outputTokens: number }) => {
    if (!usage) return;
    roles[role]!.input += usage.inputTokens;
    roles[role]!.output += usage.outputTokens;
  };
  for (const feature of Object.values(state.features)) for (const attempt of feature.attempts) add('Developers', attempt.usage);
  for (const plan of Object.values(state.plans)) for (const review of plan.reviews ?? []) add('Reviewers', review.usage);
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

type Roles = DashboardState['design']['roles'];

/** The owner's hours for the whole project (v3 §4), set here and recorded by the daemon, and what the agents used. */
const Budgets = defineComponent({
  props: {
    state: { type: Object as PropType<State>, required: true },
    roles: { type: Object as PropType<Roles>, required: true },
    ceiling: { type: Number as PropType<number | null>, default: null },
    ownerTime: Object as PropType<OwnerTime>,
    usage: Object as PropType<{ at: string; usage: SubscriptionUsage }>,
  },
  setup(props) {
    // The active hours move while an attempt or a review runs.
    const now = useNow(() =>
      Object.values(props.state.features).some((f) => f.attempts.some((a) => !a.endedAt)) ||
      Object.values(props.state.plans).some((p) => (p.reviews ?? []).some((r) => r.status === 'running')));
    return () => {
      const { state, ownerTime } = props;
      const budgets = state.budgets ?? {};
      const overPlanned = ownerTime !== undefined && ownerTime.committedHours > ownerTime.plannableHours;
      const overUsed = ownerTime !== undefined && ownerTime.usedHours > ownerTime.hours;
      return (
        <QCard flat bordered>
          <QCardSection>
            <div class="text-h6 q-mb-sm">Budgets</div>
            <div class="row q-col-gutter-md">
              <Meter title="Your time">
                <p>
                  {budgets.ownerHours !== undefined
                    ? <><b>{budgets.ownerHours} h</b> for the whole project{budgets.ownerHoursSetAt && <span class="text-muted">, set {new Date(budgets.ownerHoursSetAt).toLocaleDateString()}</span>}</>
                    : <span class="text-muted">Not set: the Architect designs without a limit on your time.</span>}
                </p>
                {ownerTime && (
                  <p>
                    <b class={overUsed ? 'text-negative' : undefined}>{ownerTime.usedHours} h used</b>
                    {' · '}
                    <span class={overPlanned ? 'text-negative' : undefined}>{ownerTime.committedHours} h planned by the designs</span>
                    {' · '}
                    <span class="text-muted">{ownerTime.plannableHours} h plannable after the {ownerTime.reservePercent}% reserve</span>
                  </p>
                )}
                <HoursForm value={budgets.ownerHours} />
                <p class="text-caption text-muted q-mt-sm">
                  {ownerTime
                    ? "Planned: the estimates of the owner actions in submitted designs, gates and tasks. Used: the actions you marked done. What you read, proposals and pull requests, doesn't count."
                    : 'Once set, the Architect must estimate every owner action and design within your hours; a design over them is refused.'}
                </p>
              </Meter>
              <ActiveMeter state={state} roles={props.roles} now={now.value} />
              <TokensMeter state={state} />
              <SubscriptionMeter ceiling={props.ceiling} {...(props.usage ? { usage: props.usage } : {})} />
            </div>
          </QCardSection>
        </QCard>
      );
    };
  },
});

type Columns = NonNullable<QTableProps['columns']>;

/** One row per agent: its model and effort as harness/config.json sets them, and its active hours, or null where they aren't counted. */
const ACTIVE_COLUMNS: Columns = [
  { name: 'agent', label: 'Agent', field: 'agent', align: 'left' },
  { name: 'model', label: 'Model', field: 'model', align: 'left', format: modelName },
  { name: 'effort', label: 'Effort', field: 'effort', align: 'left', format: (effort: string | null) => effort ?? "Claude Code's" },
  { name: 'hours', label: 'Active', field: 'ms', align: 'right', format: (ms: number | null) => (ms === null ? 'not counted' : inHours(ms)), classes: (row: { ms: number | null }) => (row.ms === null ? 'text-muted' : '') },
];

/** The hours the agents worked: the Developers' and the reviewers', by agent, with the model and effort of each. */
const ActiveMeter = defineComponent({
  props: {
    state: { type: Object as PropType<State>, required: true },
    roles: { type: Object as PropType<Roles>, required: true },
    now: { type: Number, required: true },
  },
  setup(props) {
    return () => {
      const { roles } = props;
      const active = activeMs(props.state, props.now);
      // The reviewers run on the Manager's model and effort.
      const rows = [
        { agent: 'Developers', ...roles.developer, ms: active.developers },
        { agent: 'Reviewers', ...roles.manager, ms: active.reviewers },
        { agent: 'Managers', ...roles.manager, ms: null },
        { agent: 'Architects', ...roles.architect, ms: null },
      ];
      return (
        <Meter title="Active hours">
          <p>
            <b>{inHours(active.developers + active.reviewers)}</b>
            <span class="text-muted"> · the Developers and the reviewers</span>
          </p>
          <QTable class="active q-mb-sm" flat bordered dense hideBottom rowKey="agent" rows={rows} columns={ACTIVE_COLUMNS} pagination={{ rowsPerPage: 0 }} />
          <p class="text-caption text-muted">
            Each attempt and review from its start to its end; those running count to now. Managers and Architects aren't counted: they wait far more than they work.
            The model and effort are those of harness/config.json; a running Architect keeps the model it started with until its sandbox is made again.
          </p>
        </Meter>
      );
    };
  },
});

const TOKEN_COLUMNS: Columns = [
  { name: 'role', label: 'Role', field: 'role', align: 'left' },
  { name: 'written', label: 'Written', field: 'output', align: 'right', format: count },
  { name: 'read', label: 'Read', field: 'input', align: 'right', format: count },
  { name: 'total', label: 'Total', field: 'total', align: 'right', format: count },
];

/** Every token Claude used for the project, written and read, and by role. */
const TokensMeter = defineComponent({
  props: { state: { type: Object as PropType<State>, required: true } },
  setup(props) {
    return () => {
      const roles = tokensByRole(props.state);
      const total = roles.reduce((sum, [, t]) => ({ input: sum.input + t.input, output: sum.output + t.output }), { input: 0, output: 0 });
      const rows = roles.map(([role, t]) => ({ role, input: t.input, output: t.output, total: t.input + t.output }));
      return (
        <Meter title="Claude tokens">
          <p>
            <b>{count(total.input + total.output)}</b>
            <span class="text-muted"> · {count(total.output)} written, {count(total.input)} read, cache included</span>
          </p>
          <QTable class="tokens q-mb-sm" flat bordered dense hideBottom rowKey="role" rows={rows} columns={TOKEN_COLUMNS} pagination={{ rowsPerPage: 0 }} />
          <p class="text-caption text-muted">
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
            <p class="text-muted">No report yet. The Developers, the Manager and the reviewers report your usage with each model call; the bars appear with the first one.</p>
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
                <QLinearProgress value={Math.max(0, Math.min(100, limit.percent)) / 100} color={hot ? 'negative' : 'primary'} rounded size="8px" class="q-my-xs" />
                <div class="text-caption text-muted">resets {resetsIn(limit.resetsAt, now.value)}</div>
              </div>
            );
          })}
          <p class="text-caption text-muted">
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

/** The owner's hours for the whole project, to save, or clear: null clears them on the daemon. */
const HoursForm = defineComponent({
  props: {
    value: Number,
  },
  setup(props) {
    const hours = ref('');
    return () => {
      const n = Number(hours.value);
      const valid = hours.value.trim() !== '' && Number.isFinite(n) && n > 0;
      return (
        <div class="row items-center q-gutter-sm">
          <QInput {...text(hours)} type="number" dense outlined label="hours" style="width: 120px" />
          <Action
            label="Save"
            run={async () => {
              if (!valid) return { done: false, error: 'a positive number of hours' };
              const result = await post('/api/budgets', { ownerHours: n });
              if (result.done) hours.value = '';
              return result;
            }}
          />
          {props.value !== undefined && <Action label="Clear" flat run={() => post('/api/budgets', { ownerHours: null })} />}
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
          <p class="text-caption text-muted q-mt-sm">An Architect starts in its own sandbox; talk to it in the Agents view.</p>
        </QCardSection>
      </QCard>
    );
  },
});

type PlanDesign = DashboardState['design']['modules'][number]['plans'][number];

/** The same widths in every plan's table, laid out fixed: the columns line up from one plan to the next. */
const FEATURE_COLUMNS: Columns = [
  { name: 'feature', label: 'Feature', field: 'id', align: 'left', headerStyle: 'width: 30%' },
  { name: 'status', label: 'Status', field: 'id', align: 'left', headerStyle: 'width: 14%' },
  { name: 'attempts', label: 'Attempts', field: 'id', align: 'left', headerStyle: 'width: 13%' },
  { name: 'last', label: 'Last attempt', field: 'id', align: 'left', headerStyle: 'width: 33%' },
  { name: 'commit', label: 'Commit', field: 'id', align: 'left', headerStyle: 'width: 10%' },
];

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
            {planState?.mergedBy === 'daemon' && <span class="text-muted text-caption">merged by the daemon</span>}
            {planState?.ci && <Badge status={planState.ci.status} label={`CI ${planState.ci.status}`} />}
          </div>
          {planState && <PlanDetails plan={planState} />}
          <QTable class="features q-mt-sm" flat bordered dense wrapCells hideBottom rowKey="id" rows={rows} columns={FEATURE_COLUMNS} pagination={{ rowsPerPage: 0 }} tableStyle="table-layout: fixed">
            {{
              body: ({ row }: { row: (typeof rows)[number] }) => (
                <FeatureRow key={row.id} id={row.id} title={row.title} kind={row.kind} max={design.maxAttempts} {...(row.state ? { feature: row.state } : {})} />
              ),
            }}
          </QTable>
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
      const postDeploy = plan.postDeploy;
      return (
        <div class="text-caption q-mt-xs">
          {failedJobs.map((job) => (
            <Fold key={job.name} headerClass="text-negative" label={() => `CI job ${job.name}: ${job.conclusion}`}>
              <pre>{job.log ?? ''}</pre>
            </Fold>
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
          {postDeploy && (
            <Fold label={() => <>Post-deploy checks: <Badge status={postDeploy.status} /></>}>
              {postDeploy.results.map((r) => (
                <div key={r.id}>
                  <b class={r.exit === 0 ? 'text-positive' : 'text-negative'}>{r.id}</b> <span class="text-muted">{duration(r.durationMs)}</span>
                  <pre>{r.output}</pre>
                </div>
              ))}
            </Fold>
          )}
        </div>
      );
    };
  },
});

/** A text kept to its first line until clicked, when it's long: the table stays easy to read. */
const Folded = defineComponent({
  props: { text: { type: String, required: true } },
  setup(props) {
    return () => {
      const lines = props.text.trim().split('\n');
      const first = lines[0]!;
      if (lines.length === 1 && first.length <= 140) return <div class="text-caption">{first}</div>;
      return (
        <Fold class="text-caption" label={() => (first.length > 100 ? `${first.slice(0, 100)}…` : `${first} …`)}>
          <div class="long-text">{props.text.trim()}</div>
        </Fold>
      );
    };
  },
});

/** What the Developer asked during the attempt, and the answers, folded to a count until clicked. */
const Questions = defineComponent({
  props: { questions: { type: Array as PropType<NonNullable<Attempt['questions']>>, required: true } },
  setup(props) {
    return () => {
      const n = props.questions.length;
      const waiting = props.questions.filter((q) => q.answer === undefined).length;
      const label = `${n} question${n === 1 ? '' : 's'} from the Developer, ${waiting === 0 ? 'answered' : `${waiting} waiting for an answer`}`;
      return (
        <Fold class="text-caption" headerClass="text-muted" label={() => label}>
          {props.questions.map((q) => (
            <div key={q.requestId} class="q-mb-sm">
              <div class="long-text"><b>Q:</b> {q.text}</div>
              {q.answer !== undefined && <div class="long-text q-mt-xs"><b>A:</b> {q.answer}</div>}
            </div>
          ))}
        </Fold>
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
        <QTr>
          <QTd>
            <b>{props.id}</b> {props.title} {props.kind === 'infra' && <span class="text-muted text-caption">infra</span>}
          </QTd>
          <QTd>
            <Badge status={feature?.status ?? 'pending'} />
            {feature?.awaitingGuidanceSince && <div class="text-muted text-caption">waiting for the Manager's guidance</div>}
          </QTd>
          <QTd class="mono">{feature ? `${feature.attempts.length}${counted ? ` (${counted} of ${props.max + feature.extraAttempts} counted)` : ''}` : '0'}</QTd>
          <QTd>
            {last && (
              <>
                {last.status}
                {last.outcome ? ` · ${last.outcome}` : ''} · {duration(ended - Date.parse(last.startedAt))}
                {last.reason && <Folded text={last.reason} />}
                {last.finding && (
                  <Fold class="text-caption" label={() => `Finding: ${last.finding!.category}`}>
                    <p>{last.finding.summary}</p>
                    {last.finding.needs && <p>Needs: {last.finding.needs}</p>}
                  </Fold>
                )}
                {last.questions && last.questions.length > 0 && <Questions questions={last.questions} />}
              </>
            )}
          </QTd>
          <QTd class="mono">{feature?.commit?.slice(0, 8) ?? ''}</QTd>
        </QTr>
      );
    };
  },
});
