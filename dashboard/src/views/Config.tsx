import { matRefresh } from '@quasar/extras/material-icons';
import { Notify, QBadge, QBtn, QBtnToggle, QCard, QCardSection, QInput, QItem, QItemLabel, QItemSection, QList, QTable, QTd, QTr, type QTableProps } from 'quasar';
import { computed, defineComponent, onMounted, ref, watch, type PropType } from 'vue';
import type { ConfigFact, ConfigSetting, ConfigView } from '../../../src/dashboard/config-view.ts';
import { getJson, post, type DashboardState, type Outcome } from '../api.ts';
import { confirm, Loading, text } from '../ui.tsx';

type Columns = NonNullable<QTableProps['columns']>;

const SETTING_COLUMNS: Columns = [
  { name: 'path', label: 'Setting', field: 'path', align: 'left', headerStyle: 'width: 32%' },
  { name: 'value', label: 'Value', field: 'value', align: 'left', headerStyle: 'width: 40%' },
  { name: 'source', label: 'From', field: 'set', align: 'left', headerStyle: 'width: 12%' },
  { name: 'default', label: 'Default', field: 'default', align: 'left', headerStyle: 'width: 16%' },
];

/** Without a header, the cells carry the width: both tables line up. */
const FACT_COLUMNS: Columns = [
  { name: 'name', label: 'Setting', field: 'name', align: 'left', style: 'width: 32%' },
  { name: 'value', label: 'Value', field: 'value', align: 'left' },
];

/** A value as the file holds it: text as it is, anything else as JSON. */
const written = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));

/**
 * Every setting of the harness (§14.1): harness/config.json on main with its defaults,
 * what the owner set through the dashboard or the CLI, and this machine's tools and App.
 */
export const Config = defineComponent({
  props: { data: { type: Object as PropType<DashboardState>, required: true } },
  setup(props) {
    const view = ref<ConfigView>();
    const failed = ref(false);
    const filter = ref('');
    // Only the latest read lands: an older answer never covers a newer one.
    let reads = 0;
    const load = async () => {
      const read = ++reads;
      const next = await getJson<ConfigView>('/api/config').catch(() => undefined);
      if (read !== reads) return;
      failed.value = next === undefined;
      if (next) view.value = next;
    };
    onMounted(() => void load());
    // What the owner set through the CLI, or a new configuration on main, comes with a new state.
    watch(() => props.data, () => void load());
    const settings = computed(() => {
      const words = filter.value.toLowerCase().split(/\s+/).filter(Boolean);
      return (view.value?.settings ?? []).filter((s) => words.every((word) => `${s.path} ${written(s.value)}`.toLowerCase().includes(word)));
    });
    return () => {
      const data = view.value;
      // The switches come with the page's state, at once; the rest is read on demand.
      if (!data) {
        return (
          <div class="column q-gutter-md">
            <ModeAndReviews data={props.data} />
            {failed.value ? <p class="text-muted">The daemon could not read its configuration.</p> : <Loading text="Reading the configuration…" />}
          </div>
        );
      }
      const set = data.settings.filter((s) => s.set && !s.required).length;
      return (
        <div class="column q-gutter-md">
          <ModeAndReviews data={props.data} />
          <QCard flat bordered>
            <QCardSection>
              <div class="row items-center q-gutter-sm q-mb-sm">
                <div class="text-h6">harness/config.json</div>
                <span class="text-caption text-muted">on main · {data.settings.length} settings: {set} set in the file, the others defaults</span>
                <div class="col" />
                <QInput {...text(filter)} dense outlined clearable label="Filter: a setting or a value" style="min-width: 280px" />
                <QBtn flat dense noCaps color="primary" icon={matRefresh} label="Refresh" onClick={() => void load()} />
              </div>
              <QTable class="config" flat bordered dense wrapCells hideBottom rowKey="path" rows={settings.value} columns={SETTING_COLUMNS} pagination={{ rowsPerPage: 0 }} tableStyle="table-layout: fixed">
                {{
                  body: ({ row }: { row: ConfigSetting }) => (
                    <QTr>
                      <QTd class="mono">{row.path}</QTd>
                      <QTd class="mono">{written(row.value)}</QTd>
                      <QTd>{row.required ? <span class="text-muted">required</span> : row.set ? <QBadge color="primary" label="the file" /> : <span class="text-muted">default</span>}</QTd>
                      <QTd class="mono text-muted">{row.default !== undefined ? written(row.default) : ''}</QTd>
                    </QTr>
                  ),
                }}
              </QTable>
              <p class="text-caption text-muted q-mt-sm">
                What the daemon runs with: harness/config.json on <code>main</code>, and the defaults for what it doesn't set; the default column shows what a value set in the file replaces.
                The file is protected: change it in an <code>Arch:</code> pull request, or a commit of yours on <code>main</code>. The daemon reads <code>main</code> again on every pass, every 15 seconds or so.
              </p>
            </QCardSection>
          </QCard>
          <Facts title="The daemon" note="What you set in the dashboard or with the harness command, kept in the daemon's state." facts={data.daemon} />
          <Facts title="This machine" note="The tools, the OpenShell providers and the GitHub App the harness uses here. No key or token is shown." facts={data.machine} />
        </div>
      );
    };
  },
});

type Reviewer = 'security' | 'cost';
type Scope = 'on' | 'infra' | 'off';

/**
 * The owner's switches, each a line with its toggle: the mode, who merges infrastructure
 * and Fix PRs in Swarm, and which reviewers read the plans' pull requests. The daemon records each
 * choice in its state, and harness/config.json isn't written. A switch that hands merges
 * to the daemon, or takes a review away, asks first; its toggle moves once the daemon
 * has recorded it.
 */
const ModeAndReviews = defineComponent({
  props: { data: { type: Object as PropType<DashboardState>, required: true } },
  setup(props) {
    // The line whose switch is on its way to the daemon: the toggles wait for it.
    const busy = ref<string>();
    const change = async (line: string, question: string | undefined, send: () => Promise<Outcome>) => {
      if (question && !(await confirm(question))) return;
      busy.value = line;
      let result: Outcome;
      try {
        result = await send();
      } catch (error) {
        result = { done: false, error: (error as Error).message };
      } finally {
        busy.value = undefined;
      }
      const problem = result.done ? result.warning : result.error ?? 'refused';
      if (problem) Notify.create({ type: result.done ? 'warning' : 'negative', message: problem, timeout: 8000 });
    };
    return () => {
      const { state, design } = props.data;
      const swarm = (state.mode ?? 'manual') === 'swarm';
      const infra = state.infraMerge ?? 'ceiling';
      const fixes = state.fixMerge ?? 'daemon';
      const scope = (role: Reviewer): Scope => state.reviews?.[role] ?? 'on';
      // The configuration decides where a reviewer can run at all: the switches narrow it.
      const required = (role: Reviewer) => design.swarm.requiredStatuses.includes(`harness/${role}`);
      const comments = design.swarm.reviewersInManual;
      // The reviewers that read anything in Swarm: which plans each reads is its own line's to say.
      const reviewing = (['security', 'cost'] as const).filter((role) => required(role) && scope(role) !== 'off');

      const setMode = (mode: 'manual' | 'swarm') => change(
        'mode',
        mode === 'manual'
          ? 'In Manual you review and merge every pull request yourself. Switch to Manual?'
          : reviewing.length > 0
            ? 'In Swarm the daemon merges plans that pass CI and the reviews switched on, without your review. Switch to Swarm?'
            : 'In Swarm the daemon merges plans that pass CI, without your review, and no review is switched on. Switch to Swarm?',
        async () => {
          // The daemon records the switch, and applies main's rules with the owner's gh, as `harness mode` does (v3 §2.1).
          const result = await post('/api/mode', { mode });
          return typeof result.problem === 'string' ? { ...result, warning: `GitHub's rules on main were not changed: ${result.problem}` } : result;
        },
      );
      const setInfra = (by: 'ceiling' | 'daemon') => change(
        'infra',
        by === 'daemon'
          ? `INFRA and MIXED_INFRA_AND_CODE plans will merge themselves once they pass CI${reviewing.length > 0 ? ' and the reviews switched on' : ', with no review switched on'}, like CODE plans. An estimate over the ceiling still waits for you. Let the daemon merge infra?`
          : "INFRA and MIXED_INFRA_AND_CODE plans will wait for you again, unless the cost job's estimate is under the ceiling. Keep their merges for you?",
        () => post('/api/infra-merge', { by }),
      );
      const setFixes = (by: 'owner' | 'daemon') => change(
        'fixes',
        by === 'daemon'
          ? `After a failed deploy, the Fix PR will merge itself once it passes CI${reviewing.length > 0 ? ' and the reviews switched on' : ', with no review switched on'}, under the same policy as its plan's pull request, and the deploy runs again without you. Let the daemon merge Fix PRs?`
          : undefined,
        () => post('/api/fix-merge', { by }),
      );
      // Only a switch that takes a review away asks first.
      const less: Record<Scope, number> = { on: 2, infra: 1, off: 0 };
      const setReviews = (role: Reviewer, next: Scope) => {
        const none = reviewing.every((other) => other === role) ? ' No review will be left: plans merge on CI alone.' : '';
        const estimate = role === 'cost' ? ' The cost estimate in CI and its ceiling stay.' : '';
        const question = less[next] >= less[scope(role)]
          ? undefined
          : next === 'off'
            ? `No ${role} reviewer will read the plans' pull requests: in Swarm they get its status as "not reviewed", the open ones too, and the daemon merges them without a ${role} review.${none}${estimate} Switch ${role} reviews off?`
            : `The cost reviewer will read the pull requests of INFRA and MIXED_INFRA_AND_CODE plans only: in Swarm a CODE plan's gets its status as "not reviewed", the open ones too.${estimate} Keep cost reviews for infrastructure plans only?`;
        return change(role, question, () => post('/api/reviews', { role, scope: next }));
      };

      const reviewNote = (role: Reviewer): string => {
        if (swarm && !required(role)) return `Not running: swarm.requiredStatuses in harness/config.json leaves harness/${role} out.`;
        if (!swarm && !comments) return 'Not running in Manual: the reviewers comment there only with swarm.reviewersInManual in harness/config.json. Your choice counts in Swarm.';
        const estimate = role === 'cost' ? " The cost estimate in CI and its ceiling don't depend on it." : '';
        if (scope(role) === 'off') return swarm ? `No ${role} review: a plan's pull request gets its status as "not reviewed", and merges without it.${estimate}` : `No ${role} review.${estimate}`;
        const reads = scope(role) === 'infra' ? 'the pull requests of INFRA and MIXED_INFRA_AND_CODE plans' : "every plan's pull request";
        if (!swarm) return `In Manual, the ${role} reviewer comments on ${reads}, and blocks nothing.`;
        return scope(role) === 'infra'
          ? `The cost reviewer reads ${reads}. A CODE plan's gets its status as "not reviewed".${estimate}`
          : `The ${role} reviewer reads ${reads}, and the daemon merges one only once it passes.`;
      };

      const line = <T extends string>(o: { key: string; title: string; note: string; value: T; choices: Array<{ label: string; value: T }>; disable?: boolean; set: (next: T) => unknown }) => (
        <QItem key={o.key} class="q-px-none">
          <QItemSection>
            <QItemLabel>{o.title}</QItemLabel>
            <QItemLabel caption>{o.note}</QItemLabel>
          </QItemSection>
          <QItemSection side>
            <QBtnToggle
              class="choice"
              modelValue={o.value}
              {...{ 'onUpdate:modelValue': (next: T) => void (next !== o.value && o.set(next)) }}
              options={o.choices}
              disable={o.disable === true || busy.value !== undefined}
              unelevated dense noCaps padding="2px 12px" textColor="primary" toggleColor="primary" toggleTextColor="white"
            />
          </QItemSection>
        </QItem>
      );
      const onOff: Array<{ label: string; value: Scope }> = [{ label: 'On', value: 'on' }, { label: 'Off', value: 'off' }];
      return (
        <QCard flat bordered>
          <QCardSection>
            <div class="text-h6">Mode and reviews</div>
            <QList separator>
              {line({
                key: 'mode', title: 'Mode', value: swarm ? 'swarm' : 'manual', set: setMode,
                choices: [{ label: 'Manual', value: 'manual' }, { label: 'Swarm', value: 'swarm' }],
                note: !swarm
                  ? 'You review and merge every pull request.'
                  : reviewing.length > 0
                    ? 'The daemon merges the plans that pass CI and the reviews switched on below. The others wait for you, under Needs you.'
                    : 'The daemon merges the plans that pass CI: no review is switched on. The others wait for you, under Needs you.',
              })}
              {line({
                key: 'infra', title: 'Infra merges', value: infra, set: setInfra, disable: !swarm,
                choices: [{ label: 'Yours', value: 'ceiling' }, { label: "The daemon's", value: 'daemon' }],
                note: !swarm
                  ? 'In Swarm only: in Manual, every merge is yours.'
                  : infra === 'daemon'
                    ? `INFRA and MIXED_INFRA_AND_CODE plans merge like CODE plans, once they pass CI${reviewing.length > 0 ? ' and the reviews switched on below' : ''}. An estimate over the ceiling still waits for you.`
                    : "INFRA and MIXED_INFRA_AND_CODE plans wait for you, unless the cost job's estimate is under the ceiling.",
              })}
              {line({
                key: 'fixes', title: 'Fix PR merges', value: fixes, set: setFixes, disable: !swarm,
                choices: [{ label: 'Yours', value: 'owner' }, { label: "The daemon's", value: 'daemon' }],
                note: !swarm
                  ? 'In Swarm only: in Manual, every merge is yours.'
                  : fixes === 'daemon'
                    ? `After a failed deploy, the Manager's Fix PR merges like its plan's pull request, once it passes CI${reviewing.length > 0 ? ' and the reviews switched on below' : ''}, and the deploy runs again. What the policy holds back for a plan, such as an estimate over the ceiling, it holds back here too.`
                    : "After a failed deploy, the Manager's Fix PR waits for you, under Needs you.",
              })}
              {line({
                key: 'security', title: 'Security reviews', value: scope('security'), set: (next) => setReviews('security', next), disable: swarm && !required('security'),
                choices: onOff, note: reviewNote('security'),
              })}
              {line({
                key: 'cost', title: 'Cost reviews', value: scope('cost'), set: (next) => setReviews('cost', next), disable: swarm && !required('cost'),
                choices: [onOff[0]!, { label: 'Infra plans only', value: 'infra' }, onOff[1]!], note: reviewNote('cost'),
              })}
            </QList>
            <p class="text-caption text-muted q-mt-sm q-mb-none">What you switch here, the daemon keeps in its state and records in the event log: harness/config.json isn't written.</p>
          </QCardSection>
        </QCard>
      );
    };
  },
});

const Facts = defineComponent({
  props: {
    title: { type: String, required: true },
    note: { type: String, required: true },
    facts: { type: Array as PropType<ConfigFact[]>, required: true },
  },
  setup(props) {
    return () => (
      <QCard flat bordered>
        <QCardSection>
          <div class="text-h6 q-mb-sm">{props.title}</div>
          <QTable flat bordered dense wrapCells hideBottom hideHeader rowKey="name" rows={props.facts} columns={FACT_COLUMNS} pagination={{ rowsPerPage: 0 }} tableStyle="table-layout: fixed" />
          <p class="text-caption text-muted q-mt-sm">{props.note}</p>
        </QCardSection>
      </QCard>
    );
  },
});
