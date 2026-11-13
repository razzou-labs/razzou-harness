import { QBtn, QBtnToggle, QCard, QCardSection, QInput, QLinearProgress, QSeparator, QTable, QTd, QTr, type QTableProps } from 'quasar';
import { defineComponent, onUnmounted, ref, watchEffect, type PropType, type Ref } from 'vue';
import { post, type Attempt, type DashboardState, type FeatureState, type OwnerTime, type PlanState, type State, type SubscriptionUsage, type UsageLimit } from '../api.ts';
import { Dependencies } from '../components/Dependencies.tsx';
import { clock, duration, modelName } from '../format.ts';
import { Action, Badge, Fold, GithubLink, text } from '../ui.tsx';
import { moduleCompleted } from '../../../src/dashboard/needs.ts';
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
          <Budgets state={state} roles={design.roles} tokens={props.data.tokens} ceiling={design.swarm?.usageCeilingPercent ?? null} {...(props.data.ownerTime ? { ownerTime: props.data.ownerTime } : {})} {...(props.data.usage ? { usage: props.data.usage } : {})} />
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
                    {/* The status is the design's, frozen once merged: the build's end is said beside it. */}
                    {moduleCompleted(designed, state) && <Badge status="completed" label="module completed" />}
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
 * nothing. A Manager's and an Architect's is the time it spent on its prompts, as the
 * daemon reads its sandbox: null until a first reading has it (0.5.1).
 */
function activeMs(state: State, now: number): { developers: number; reviewers: number; managers: number | null; architects: number | null } {
  const span = (start: string, end: string | undefined) => {
    const started = Date.parse(start);
    const ended = end ? Date.parse(end) : now;
    return Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : 0;
  };
  let developers = 0;
  let reviewers = 0;
  for (const feature of Object.values(state.features)) for (const attempt of feature.attempts) developers += span(attempt.startedAt, attempt.endedAt);
  for (const plan of Object.values(state.plans)) for (const review of plan.reviews ?? []) if (review.status !== 'starting') reviewers += span(review.startedAt, review.endedAt);
  const agents = Object.entries(state.agentTokens ?? {});
  const read = (prefix: string): number | null => {
    const mine = agents.filter(([agent]) => agent.startsWith(prefix));
    return mine.length > 0 && mine.every(([, tokens]) => tokens.total.activeMs === undefined) ? null : mine.reduce((sum, [, tokens]) => sum + (tokens.total.activeMs ?? 0), 0);
  };
  return { developers, reviewers, managers: read('manager:'), architects: read('architect:') };
}

const inHours = (ms: number) => `${(ms / 3_600_000).toFixed(1)} h`;

/** 1234567 is 1.2 M; 45678 is 46 k. */
function count(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} k`;
  return String(n);
}

const Meter = defineComponent({
  props: { title: { type: String, required: true }, wide: Boolean },
  setup(props, { slots }) {
    return () => (
      <div class={props.wide ? 'col-12 col-lg-6' : 'col-12 col-sm-6 col-lg-3'}>
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
type RoleTokens = DashboardState['tokens'][number];

/** The owner's hours for the whole project (v3 §4), set here and recorded by the daemon, and what the agents used. */
const Budgets = defineComponent({
  props: {
    state: { type: Object as PropType<State>, required: true },
    roles: { type: Object as PropType<Roles>, required: true },
    tokens: { type: Array as PropType<RoleTokens[]>, required: true },
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
              <ClaudeMeter tokens={props.tokens} ceiling={props.ceiling} {...(props.usage ? { usage: props.usage } : {})} />
            </div>
          </QCardSection>
        </QCard>
      );
    };
  },
});

type Columns = NonNullable<QTableProps['columns']>;

/** One row per agent: its model and effort as harness/config.json sets them, and its active hours, or null before the daemon read them. */
const ACTIVE_COLUMNS: Columns = [
  { name: 'agent', label: 'Agent', field: 'agent', align: 'left' },
  { name: 'model', label: 'Model', field: 'model', align: 'left', format: modelName },
  { name: 'effort', label: 'Effort', field: 'effort', align: 'left', format: (effort: string | null) => effort ?? "Claude Code's" },
  { name: 'hours', label: 'Active', field: 'ms', align: 'right', format: (ms: number | null) => (ms === null ? 'not read yet' : inHours(ms)), classes: (row: { ms: number | null }) => (row.ms === null ? 'text-muted' : '') },
];

/** The hours the agents worked, by agent, with the model and effort of each. */
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
        { agent: 'Managers', ...roles.manager, ms: active.managers },
        { agent: 'Architects', ...roles.architect, ms: active.architects },
      ];
      return (
        <Meter title="Active hours">
          <p>
            <b>{inHours(active.developers + active.reviewers + (active.managers ?? 0) + (active.architects ?? 0))}</b>
            <span class="text-muted"> · every agent</span>
          </p>
          <QTable class="active q-mb-sm" flat bordered dense hideBottom rowKey="agent" rows={rows} columns={ACTIVE_COLUMNS} pagination={{ rowsPerPage: 0 }} />
          <p class="text-caption text-muted">
            Each attempt and review from its start to its end; those running count to now. A Manager and an Architect, from each prompt to its last step, as the daemon reads its sandbox every five minutes.
            The model and effort are those of harness/config.json; a running Architect keeps the model it started with until its sandbox is made again.
          </p>
        </Meter>
      );
    };
  },
});

/** The prompt cache's share of what was read where it is known; none where nothing is. */
const share = (tokens: Pick<RoleTokens, 'cacheRead' | 'known'>): string => (tokens.known > 0 ? `${Math.round((100 * tokens.cacheRead) / tokens.known)}%` : '—');

const TOKEN_COLUMNS: Columns = [
  { name: 'role', label: 'Role', field: 'role', align: 'left' },
  { name: 'read', label: 'Read', field: 'read', align: 'right', format: count },
  { name: 'cacheRead', label: 'Of which cache reads', field: 'cacheRead', align: 'right', format: count },
  { name: 'cache', label: 'Cache', field: (row: RoleTokens) => row, align: 'right', format: share },
  { name: 'written', label: 'Written', field: 'written', align: 'right', format: count },
  { name: 'total', label: 'Total', field: (row: RoleTokens) => row.read + row.written, align: 'right', format: count },
];

/**
 * What Claude used and what is left of the subscription, in one card twice as wide as
 * the others: the tokens table needs the width, and the subscription's bars sit under it.
 */
const ClaudeMeter = defineComponent({
  props: {
    tokens: { type: Array as PropType<RoleTokens[]>, required: true },
    ceiling: { type: Number as PropType<number | null>, default: null },
    usage: Object as PropType<{ at: string; usage: SubscriptionUsage }>,
  },
  setup(props) {
    return () => (
      <Meter title="Claude tokens" wide>
        <Tokens tokens={props.tokens} />
        <QSeparator class="q-my-md" />
        <div class="text-subtitle1 text-weight-medium q-mb-xs">Subscription</div>
        <Subscription ceiling={props.ceiling} {...(props.usage ? { usage: props.usage } : {})} />
      </Meter>
    );
  },
});

/** Every token Claude used for the project, read and written, by role, with what the prompt cache served. */
const Tokens = defineComponent({
  props: { tokens: { type: Array as PropType<RoleTokens[]>, required: true } },
  setup(props) {
    return () => {
      const roles = props.tokens;
      const all = roles.reduce((sum, t) => ({ read: sum.read + t.read, cacheRead: sum.cacheRead + t.cacheRead, known: sum.known + t.known, written: sum.written + t.written }), { read: 0, cacheRead: 0, known: 0, written: 0 });
      const unknown = roles.filter((t) => t.read > t.known);
      return (
        <>
          <p>
            <b>{count(all.read + all.written)}</b>
            <span class="text-muted"> · {count(all.read)} read, {share(all)} of it from the cache, {count(all.written)} written</span>
          </p>
          <QTable class="tokens q-mb-sm" flat bordered dense hideBottom rowKey="role" rows={roles} columns={TOKEN_COLUMNS} pagination={{ rowsPerPage: 0 }} />
          <p class="text-caption text-muted">
            Claude Code's own counts: an attempt's and a review's when it ends, a Manager's and an Architect's every five minutes. Each call reads the whole conversation again, mostly from the prompt cache, which costs a tenth of what a fresh read does on the API.
            {unknown.length > 0 && ` Before 0.5.1, cache reads weren't counted apart; for ${unknown.map((t) => `${count(t.read - t.known)} of the ${t.role}' reads`).join(' and ')}, the sandbox or stream that would tell is gone, so the shares are of the rest.`}
          </p>
        </>
      );
    };
  },
});

/**
 * The subscription's windows as bars, as an agent's model call last reported them: a
 * five-hour session and a weekly window, or the weekly one alone on a plan without a
 * session limit. A window that has reset since the report is gone from it: the next
 * report shows it again if the plan still has it. Before any report, it says where they
 * come from.
 */
const Subscription = defineComponent({
  props: {
    ceiling: { type: Number as PropType<number | null>, default: null },
    usage: Object as PropType<{ at: string; usage: SubscriptionUsage }>,
  },
  setup(props) {
    const now = useNow(() => true);
    return () => {
      const { usage, ceiling } = props;
      if (!usage) {
        return <p class="text-muted">No report yet. The Developers, the Manager and the reviewers report your usage with each model call; the bars appear with the first one.</p>;
      }
      const current = usage.usage.limits.filter((limit) => Date.parse(limit.resetsAt) > now.value);
      return (
        <>
          {current.length === 0 && <p class="text-muted">Every window of the last report has reset since; the next model call reports them again.</p>}
          {current.map((limit) => {
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
            Reported by an agent's model call at {clock(usage.at)}. In Swarm no attempt starts at or above {ceiling === null ? 'the ceiling, which is off' : `${ceiling}%`}; the pipeline waits for the window to reset.
          </p>
        </>
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
    const busy = ref(false);
    const start = async () => {
      busy.value = true;
      const result = await post('/api/modules', { id: id.value.trim(), title: title.value }).finally(() => (busy.value = false));
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
            <QBtn label="Start" color="primary" noCaps unelevated loading={busy.value} disable={!id.value.trim()} onClick={() => void start()} />
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
      // Who supersedes each of the plan's features, from the module's later plans (v5).
      const supersededBy = new Map<string, string>();
      for (const later of design.modules.find((m) => m.id === props.module)?.plans ?? []) {
        for (const f of later.features) {
          for (const ref of f.supersedes ?? []) {
            const [planId, featureId] = ref.includes('/') ? ref.split('/') : [later.id, ref];
            if (planId === plan.id && featureId) supersededBy.set(featureId, `${later.id}/${f.id}`);
          }
        }
      }
      const rows = [
        ...plan.features.map((f) => ({ id: f.id, title: f.title, kind: f.kind as string, state: state.features[`${key}/${f.id}`], supersededBy: supersededBy.get(f.id) })),
        ...fixes.map((f) => ({ id: f.feature, title: fixTitle(f.fix!), kind: f.fix!.kind === 'merge' ? 'merge' : 'fix', state: f })),
      ];
      // A merge round under way: a Developer merges main, after a conflict the plan's Manager took.
      const round = planState?.status === 'fixing' ? state.features[`${key}/fix${planState.fixes}`]?.fix?.kind : undefined;
      const merging = round === 'merge';
      // Each plan in a card of its own: its heading, its details and its features' table together.
      return (
        <QCard flat bordered class="plan q-mt-md">
          <QCardSection>
            <div class="text-subtitle1 text-weight-medium row items-center q-gutter-sm">
              <span>{plan.id} · {plan.title}</span>
              <Badge status={planState?.status ?? 'waiting'} />
              {planState?.pr && <GithubLink url={planState.pr.url}>PR #{planState.pr.number}</GithubLink>}
              {planState?.mergedBy === 'daemon' && <span class="text-muted text-caption">merged by the daemon</span>}
              {planState?.ci && <Badge status={planState.ci.status} label={`CI ${planState.ci.status}`} />}
            </div>
            {planState && <PlanDetails plan={planState} merging={merging} mending={round === 'checks'} />}
            <QTable class="features q-mt-sm" flat bordered dense wrapCells hideBottom rowKey="id" rows={rows} columns={FEATURE_COLUMNS} pagination={{ rowsPerPage: 0 }} tableStyle="table-layout: fixed">
              {{
                body: ({ row }: { row: (typeof rows)[number] }) => (
                  <FeatureRow
                    key={row.id} id={row.id} title={row.title} kind={row.kind} max={design.maxAttempts} {...(row.state ? { feature: row.state } : {})}
                    {...('supersededBy' in row && row.supersededBy ? { supersededBy: row.supersededBy, supersededDone: state.features[`${props.module}/${row.supersededBy}`]?.status === 'accepted' } : {})}
                  />
                ),
              }}
            </QTable>
          </QCardSection>
        </QCard>
      );
    };
  },
});

/** A fix work item's title: what it follows, the merge of main after a conflict, or the checks of accepted work made to pass again. */
function fixTitle(fix: NonNullable<FeatureState['fix']>): string {
  if (fix.kind === 'merge') return `Merge of main, round ${fix.round}`;
  if (fix.kind === 'checks') return `Fix of the checks, round ${fix.round}`;
  return `Fix after ${fix.kind === 'ci' ? 'CI' : fix.kind === 'review' ? `the ${fix.role} review` : 'the deploy'}, round ${fix.round}`;
}

const PlanDetails = defineComponent({
  props: {
    plan: { type: Object as PropType<PlanState>, required: true },
    merging: { type: Boolean, default: false },
    /** A Developer is making the checks of accepted work pass again, in a fix round of their own. */
    mending: { type: Boolean, default: false },
  },
  setup(props) {
    return () => {
      const plan = props.plan;
      const failedJobs = plan.ci?.jobs?.filter((j) => j.conclusion !== 'success') ?? [];
      const postDeploy = plan.postDeploy;
      // Accepted work fails its checks on the branch: run once more by the daemon, then the Manager's to have fixed.
      const failing = plan.validation?.status === 'failed' ? (plan.validation.results ?? []).filter((r) => r.exit !== 0) : [];
      const twice = (plan.validation?.runs ?? 0) >= 2;
      return (
        <div class="text-caption q-mt-xs">
          {failing.length > 0 && (
            <Fold
              headerClass="text-warning"
              label={() => `Accepted work fails its checks on the branch (${failing.map((r) => r.id).join(', ')}): ${
                props.mending ? 'a Developer is fixing it, for the Manager to review'
                  : twice ? 'the Manager says what breaks, then a Developer fixes it'
                    : 'the daemon runs them once more before anyone is asked'}. Nothing new starts in this plan meanwhile.`}
            >
              {failing.map((r) => (
                <div key={r.id}>
                  <b class="text-negative">{r.id}</b> <span class="text-muted">{duration(r.durationMs)}</span>
                  <pre>{r.output}</pre>
                </div>
              ))}
            </Fold>
          )}
          {/* Main no longer merges into the branch: nothing new starts in the plan until a merge round lands. */}
          {plan.mainConflict && (
            <p class="q-my-xs text-warning">
              Conflicts with main in {plan.mainConflict.files.join(', ')}: {props.merging ? 'a Developer is merging main in, for its Manager to review' : 'its Manager says how to resolve it, then a Developer merges main in'}.
            </p>
          )}
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
                : r.outcome === 'aborted'
                  ? <span class="text-muted">stopped: {r.reason}</span>
                  : r.status === 'failed'
                    ? <span class="text-negative">failed: {r.reason}</span>
                    : <Badge status={r.status} />}
            </p>
          ))}
          {/* A reviewer the owner switched off, or away from CODE plans: its status says "not reviewed", until a review of the head is posted. */}
          {(['security', 'cost'] as const).flatMap((role) => {
            const said = plan.unreviewed?.findLast((u) => u.role === role && u.head === plan.pushed);
            if (!said || plan.reviews?.some((r) => r.role === role && r.head === said.head && r.posted !== undefined && r.posted.at > said.at)) return [];
            return [(
              <p key={`unreviewed-${role}`} class="q-my-xs">
                {role === 'security' ? 'Security' : 'Cost'} review of {said.head.slice(0, 8)}:{' '}
                <span class="text-muted">not reviewed, {said.why === 'off' ? `${role} reviews being off` : `a CODE plan, with ${role} reviews for infrastructure plans only`}</span>
              </p>
            )];
          })}
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
    /** The later feature, as P6/F11, that supersedes this one, and whether it is accepted (v5). */
    supersededBy: String,
    supersededDone: Boolean,
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
            {props.supersededBy && (
              <div class="text-caption text-muted">superseded by {props.supersededBy}{props.supersededDone ? ': its checks no longer run' : ', once it is accepted'}</div>
            )}
          </QTd>
          <QTd>
            <Badge status={feature?.status ?? 'pending'} />
            {feature?.awaitingGuidanceSince && <div class="text-muted text-caption">waiting for the Manager's guidance</div>}
            {/* Out of attempts: who has it now, the Architect through the Manager, or the owner. */}
            {feature?.status === 'escalated' && feature.escalation && <div class="text-muted text-caption">{feature.escalation}</div>}
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
