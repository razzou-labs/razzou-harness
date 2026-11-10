import { matRefresh } from '@quasar/extras/material-icons';
import { QBadge, QBtn, QCard, QCardSection, QInput, QTable, QTd, QTr, type QTableProps } from 'quasar';
import { computed, defineComponent, onMounted, ref, type PropType } from 'vue';
import type { ConfigFact, ConfigSetting, ConfigView } from '../../../src/dashboard/config-view.ts';
import { getJson } from '../api.ts';
import { Loading, text } from '../ui.tsx';

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
  setup() {
    const view = ref<ConfigView>();
    const failed = ref(false);
    const filter = ref('');
    const load = async () => {
      const next = await getJson<ConfigView>('/api/config').catch(() => undefined);
      failed.value = next === undefined;
      if (next) view.value = next;
    };
    onMounted(() => void load());
    const settings = computed(() => {
      const words = filter.value.toLowerCase().split(/\s+/).filter(Boolean);
      return (view.value?.settings ?? []).filter((s) => words.every((word) => `${s.path} ${written(s.value)}`.toLowerCase().includes(word)));
    });
    return () => {
      const data = view.value;
      if (!data) return failed.value ? <p class="text-muted">The daemon could not read its configuration.</p> : <Loading text="Reading the configuration…" />;
      const set = data.settings.filter((s) => s.set && !s.required).length;
      return (
        <div class="column q-gutter-md">
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
