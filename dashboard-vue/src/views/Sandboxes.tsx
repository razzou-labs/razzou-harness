import { matRefresh } from '@quasar/extras/material-icons';
import { QBtn, QCard, QCardSection, QInput, QMarkupTable } from 'quasar';
import { defineComponent, onMounted, onUnmounted, ref, watch, type PropType } from 'vue';
import { getJson, post, type Denial, type Outcome, type SandboxOverview, type SandboxRow, type SandboxUsage, type UsageReading } from '../api.ts';
import { DenialTable } from '../components/Denials.tsx';
import { cpus, duration, size } from '../format.ts';
import { Action, Badge, Command, confirm, text } from '../ui.tsx';
import type { Go } from '../App.tsx';

/**
 * The sandboxes on the OpenShell gateway: this project's, with what each is for and uses
 * of the machine, those left over to delete, and the network requests a sandbox's policy
 * refused; then the other projects'. Above them, the owner's caps on each new sandbox.
 * Read from OpenShell, and from Docker for the use, while the view is open.
 */
export const Sandboxes = defineComponent({
  props: {
    go: { type: Function as PropType<Go>, required: true },
    selected: String,
  },
  setup(props) {
    const overview = ref<SandboxOverview>();
    const failed = ref(false);
    const usage = ref<UsageReading>();
    const refresh = async () => {
      const next = await getJson<SandboxOverview>('/api/sandboxes').catch(() => undefined);
      failed.value = next === undefined;
      if (next) overview.value = next;
    };
    // What Docker says the sandboxes use, read again every five seconds while the view is open.
    let stopped = false;
    let usageTimer: number | undefined;
    const readUsage = async () => {
      const next = await getJson<UsageReading>('/api/sandboxes/usage').catch(() => undefined);
      if (stopped) return;
      if (next) usage.value = next;
      usageTimer = window.setTimeout(() => void readUsage(), 5000);
    };
    let timer: number | undefined;
    onMounted(() => {
      void refresh();
      void readUsage();
      timer = window.setInterval(() => void refresh(), 10_000);
    });
    onUnmounted(() => {
      stopped = true;
      window.clearInterval(timer);
      window.clearTimeout(usageTimer);
    });
    const remove = async (sandbox: SandboxRow): Promise<Outcome> => {
      if (!(await confirm(`Delete ${sandbox.name}? Nothing of this project uses it any more.`, 'Delete'))) return { done: true };
      const result = await post('/api/sandboxes/remove', { name: sandbox.name });
      await refresh();
      return result;
    };
    return () => {
      const data = overview.value;
      if (!data) return <p class="text-grey-7">{failed.value ? 'The daemon could not read the sandboxes.' : 'Reading the sandboxes from OpenShell…'}</p>;
      const { gateway, machine } = data;
      const ours = data.sandboxes.filter((s) => s.use !== 'other');
      const others = data.sandboxes.filter((s) => s.use === 'other');
      const current = ours.find((s) => s.name === props.selected);
      const leftOver = ours.filter((s) => s.use === 'left over').length;
      const reading = usage.value;
      const used = (sandbox: SandboxRow) => reading?.sandboxes[sandbox.name];
      return (
        <div class="column q-gutter-md">
          <div class="row items-center q-gutter-sm">
            <b>OpenShell</b>
            <Badge status={gateway.status === 'connected' ? 'running' : 'failed'} label={gateway.status} />
            {gateway.version && <span class="text-caption text-grey-7">{gateway.version}</span>}
            <span class="text-caption text-grey-7">
              {data.sandboxes.length} sandbox{data.sandboxes.length === 1 ? '' : 'es'} on the gateway, {ours.length} of this project{leftOver > 0 ? `, ${leftOver} left over` : ''}
            </span>
            <QBtn flat dense noCaps color="primary" icon={matRefresh} label="Refresh" onClick={() => void refresh()} />
          </div>
          {gateway.problem && <p class="text-caption text-negative">{gateway.problem}</p>}
          {data.problem && <p class="text-caption text-negative">{data.problem}</p>}
          <p class="text-body2">
            {!reading ? <span class="text-grey-7">Reading what the sandboxes use from Docker…</span> : (
              <>
                Every OpenShell sandbox on this machine uses <b>{cpus(reading.total.cpu)}</b> of its {machine.cpus} CPUs and <b>{size(reading.total.memoryBytes)}</b> of its {machine.memoryGiB} GiB
                <span class="text-grey-7">, OpenShell's supervisors included · docker stats, every 5 s</span>
              </>
            )}
          </p>
          {reading?.problem && <p class="text-caption text-negative">{reading.problem}</p>}

          <Limits key={`${data.limits.cpu ?? ''}/${data.limits.memoryGiB ?? ''}`} limits={data.limits} machine={machine} onSaved={refresh} />

          <QCard flat bordered>
            <QCardSection>
              <div class="text-h6 q-mb-sm">This project's</div>
              {ours.length === 0 ? <p class="text-grey-7">None on the gateway now.</p> : (
                <QMarkupTable flat bordered dense wrapCells>
                  <thead><tr><th class="text-left">Sandbox</th><th class="text-left">For</th><th class="text-left">OpenShell</th><th class="text-left">Age</th><th class="text-left">CPU</th><th class="text-left">Memory</th><th class="text-left">Use</th><th /></tr></thead>
                  <tbody>
                    {ours.map((sandbox) => (
                      <tr key={sandbox.name} class={sandbox.name === current?.name ? 'cursor-pointer row-selected' : 'cursor-pointer'} onClick={() => props.go('sandboxes', sandbox.name)}>
                        <td class="mono">{sandbox.name}</td>
                        <td>{sandbox.role ?? 'unknown'}{sandbox.title ? ` · ${sandbox.title}` : ''}</td>
                        <td><Badge status={sandbox.phase === 'Ready' ? 'running' : sandbox.phase.toLowerCase()} label={sandbox.phase} /></td>
                        <td class="text-grey-7">{age(sandbox)}</td>
                        <Use usage={used(sandbox)} />
                        <td><Badge status={sandbox.use === 'in use' ? 'running' : 'waiting'} label={sandbox.use} /></td>
                        <td onClick={(e: Event) => e.stopPropagation()}>
                          {sandbox.agent && <QBtn flat dense noCaps color="primary" label="Agent" onClick={() => props.go('agents', sandbox.agent)} />}
                          {sandbox.use === 'left over' && <Action label="Delete" danger run={() => remove(sandbox)} />}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </QMarkupTable>
              )}
              {leftOver > 0 && <p class="text-caption text-grey-7 q-mt-sm">A left-over sandbox is this project's, but nothing uses it any more: a crash or a failed delete left it. The daemon deletes them when it starts and every hour, except an Architect's, which holds your conversation with it; Delete removes one now.</p>}
            </QCardSection>
          </QCard>

          {current && <Refused key={current.name} name={current.name} />}

          {others.length > 0 && (
            <QCard flat bordered>
              <QCardSection>
                <div class="text-h6 q-mb-sm">Other sandboxes on this gateway</div>
                <QMarkupTable flat bordered dense wrapCells>
                  <thead><tr><th class="text-left">Sandbox</th><th class="text-left">Project</th><th class="text-left">OpenShell</th><th class="text-left">Age</th><th class="text-left">CPU</th><th class="text-left">Memory</th></tr></thead>
                  <tbody>
                    {others.map((sandbox) => (
                      <tr key={sandbox.name}>
                        <td class="mono">{sandbox.name}</td>
                        <td class="text-grey-7">{sandbox.project ?? 'no label'}</td>
                        <td><Badge status={sandbox.phase === 'Ready' ? 'running' : sandbox.phase.toLowerCase()} label={sandbox.phase} /></td>
                        <td class="text-grey-7">{age(sandbox)}</td>
                        <Use usage={used(sandbox)} />
                      </tr>
                    ))}
                  </tbody>
                </QMarkupTable>
                <p class="text-caption text-grey-7 q-mt-sm">
                  Another project's, a probe of <code>harness doctor</code>, or one made by 0.3.0 or earlier, which didn't label sandboxes. The dashboard deletes none of them; in a terminal: <Command text={`openshell sandbox delete ${others[0]!.name}`} />
                </p>
              </QCardSection>
            </QCard>
          )}
        </div>
      );
    };
  },
});

/** A sandbox's CPUs and memory in use, against its caps; near a cap, in color. */
const Use = defineComponent({
  props: { usage: Object as PropType<SandboxUsage> },
  setup(props) {
    return () => {
      const usage = props.usage;
      if (!usage) return <><td /><td /></>;
      const near = (value: number, cap?: number) => (cap !== undefined && value >= 0.9 * cap ? 'text-negative' : undefined);
      return (
        <>
          <td class={near(usage.cpu, usage.cpuLimit)}>{cpus(usage.cpu)}{usage.cpuLimit !== undefined && <span class="text-grey-7"> of {usage.cpuLimit}</span>}</td>
          <td class={near(usage.memoryBytes, usage.memoryLimitBytes)}>{size(usage.memoryBytes)}{usage.memoryLimitBytes !== undefined && <span class="text-grey-7"> of {size(usage.memoryLimitBytes)}</span>}</td>
        </>
      );
    };
  },
});

/** The owner's caps on each new sandbox, CPUs and GiB of memory; an empty field lifts its cap. */
const Limits = defineComponent({
  props: {
    limits: { type: Object as PropType<SandboxOverview['limits']>, required: true },
    machine: { type: Object as PropType<SandboxOverview['machine']>, required: true },
    onSaved: { type: Function as PropType<() => Promise<void>>, required: true },
  },
  setup(props) {
    const cpu = ref(props.limits.cpu?.toString() ?? '');
    const memory = ref(props.limits.memoryGiB?.toString() ?? '');
    const value = (field: string) => (field.trim() === '' ? null : Number(field));
    return () => {
      const { limits, machine } = props;
      const capped = limits.cpu !== undefined || limits.memoryGiB !== undefined;
      const now = [limits.cpu !== undefined ? `${limits.cpu} CPU${limits.cpu === 1 ? '' : 's'}` : 'any CPUs', limits.memoryGiB !== undefined ? `${limits.memoryGiB} GiB` : 'any memory'].join(' and ');
      return (
        <QCard flat bordered>
          <QCardSection>
            <div class="text-h6 q-mb-sm">Caps on each new sandbox</div>
            <div class="row items-center q-gutter-sm">
              <QInput {...text(cpu)} type="number" dense outlined label="CPUs, or no cap" style="width: 150px" />
              <QInput {...text(memory)} type="number" dense outlined label="Memory GiB, or no cap" style="width: 190px" />
              <Action
                label="Save"
                run={async () => {
                  const result = await post('/api/sandboxes/limits', { cpu: value(cpu.value), memoryGiB: value(memory.value) });
                  if (result.done) await props.onSaved();
                  return result;
                }}
              />
            </div>
            <p class="text-caption text-grey-7 q-mt-sm">
              {capped ? `Now ${now} for each sandbox. ` : `No cap now: each sandbox may use all of this machine's ${machine.cpus} CPUs and ${machine.memoryGiB} GiB. `}
              The caps hold for the sandboxes made from now on, for each attempt, check run, reviewer and Manager; those already there, like an Architect's, keep theirs.
              Past its memory cap, a sandbox may swap up to as much again; then the process that asks for more is killed, with exit code 137, and the sandbox stays.
            </p>
          </QCardSection>
        </QCard>
      );
    };
  },
});

/** The network requests the sandbox's policy refused, from its recent log. */
const Refused = defineComponent({
  props: { name: { type: String, required: true } },
  setup(props) {
    const denials = ref<Denial[]>();
    let timer: number | undefined;
    const load = () => {
      const name = props.name;
      void getJson<Denial[]>(`/api/sandboxes/denials?name=${encodeURIComponent(name)}`).then(
        (list) => { if (name === props.name) denials.value = list ?? []; },
        () => { if (name === props.name) denials.value = []; },
      );
    };
    onMounted(() => {
      load();
      timer = window.setInterval(load, 15_000);
    });
    watch(() => props.name, () => {
      denials.value = undefined;
      load();
    });
    onUnmounted(() => window.clearInterval(timer));
    return () => (
      <QCard flat bordered>
        <QCardSection>
          <div class="text-h6 q-mb-sm">Refused by its network policy · {props.name}</div>
          {denials.value === undefined ? <p class="text-grey-7">Reading its log…</p> : denials.value.length === 0 ? (
            <p class="text-grey-7">Nothing refused in its recent log.</p>
          ) : <DenialTable denials={denials.value} />}
        </QCardSection>
      </QCard>
    );
  },
});

function age(sandbox: SandboxRow): string {
  return sandbox.createdAt ? duration(Date.now() - Date.parse(sandbox.createdAt)) : '';
}
