import { useEffect, useState } from 'react';
import { getJson, post, type Denial, type SandboxOverview, type SandboxRow, type SandboxUsage, type UsageReading } from '../api.ts';
import { DenialTable } from '../components/Denials.tsx';
import { Action, Badge, Command } from '../components/ui.tsx';
import { cpus, duration, size } from '../format.ts';
import type { Go } from '../App.tsx';

/**
 * The sandboxes on the OpenShell gateway: this project's, with what each is for and uses
 * of the machine, those left over to delete, and the network requests a sandbox's policy
 * refused; then the other projects'. Above them, the owner's caps on each new sandbox.
 * Read from OpenShell, and from Docker for the use, while the view is open.
 */
export function Sandboxes({ go, selected }: { go: Go; selected?: string }) {
  const [overview, setOverview] = useState<SandboxOverview>();
  const [failed, setFailed] = useState(false);
  const usage = useUsage();
  const refresh = async () => {
    const next = await getJson<SandboxOverview>('/api/sandboxes').catch(() => undefined);
    setFailed(next === undefined);
    if (next) setOverview(next);
  };
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  if (!overview) return <p className="muted">{failed ? 'The daemon could not read the sandboxes.' : 'Reading the sandboxes from OpenShell…'}</p>;
  const { gateway, machine } = overview;
  const ours = overview.sandboxes.filter((s) => s.use !== 'other');
  const others = overview.sandboxes.filter((s) => s.use === 'other');
  const current = ours.find((s) => s.name === selected);
  const leftOver = ours.filter((s) => s.use === 'left over').length;
  const used = (sandbox: SandboxRow) => usage?.sandboxes[sandbox.name];
  const remove = async (sandbox: SandboxRow) => {
    if (!window.confirm(`Delete ${sandbox.name}? Nothing of this project uses it any more.`)) return { done: true };
    const result = await post('/api/sandboxes/remove', { name: sandbox.name });
    await refresh();
    return result;
  };
  return (
    <div className="stack">
      <div className="row">
        <b>OpenShell</b>
        <Badge status={gateway.status === 'connected' ? 'running' : 'failed'} label={gateway.status} />
        {gateway.version && <span className="muted small">{gateway.version}</span>}
        <span className="muted small">
          {overview.sandboxes.length} sandbox{overview.sandboxes.length === 1 ? '' : 'es'} on the gateway, {ours.length} of this project{leftOver > 0 ? `, ${leftOver} left over` : ''}
        </span>
        <button onClick={() => void refresh()}>Refresh</button>
      </div>
      {gateway.problem && <p className="bad small">{gateway.problem}</p>}
      {overview.problem && <p className="bad small">{overview.problem}</p>}
      <p className="small">
        {!usage ? <span className="muted">Reading what the sandboxes use from Docker…</span> : (
          <>
            Every OpenShell sandbox on this machine uses <b>{cpus(usage.total.cpu)}</b> of its {machine.cpus} CPUs and <b>{size(usage.total.memoryBytes)}</b> of its {machine.memoryGiB} GiB
            <span className="muted">, OpenShell's supervisors included · docker stats, every 5 s</span>
          </>
        )}
      </p>
      {usage?.problem && <p className="bad small">{usage.problem}</p>}

      <Limits key={`${overview.limits.cpu ?? ''}/${overview.limits.memoryGiB ?? ''}`} limits={overview.limits} machine={machine} onSaved={refresh} />

      <section>
        <h2>This project's</h2>
        {ours.length === 0 ? <p className="muted">None on the gateway now.</p> : (
          <table>
            <thead><tr><th>Sandbox</th><th>For</th><th>OpenShell</th><th>Age</th><th>CPU</th><th>Memory</th><th>Use</th><th /></tr></thead>
            <tbody>
              {ours.map((sandbox) => (
                <tr key={sandbox.name} className={sandbox.name === current?.name ? 'clickable selected' : 'clickable'} onClick={() => go('sandboxes', sandbox.name)}>
                  <td className="mono">{sandbox.name}</td>
                  <td>{sandbox.role ?? 'unknown'}{sandbox.title ? ` · ${sandbox.title}` : ''}</td>
                  <td><Badge status={sandbox.phase === 'Ready' ? 'running' : sandbox.phase.toLowerCase()} label={sandbox.phase} /></td>
                  <td className="muted">{age(sandbox)}</td>
                  <Use usage={used(sandbox)} />
                  <td><Badge status={sandbox.use === 'in use' ? 'running' : 'waiting'} label={sandbox.use} /></td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {sandbox.agent && <button onClick={() => go('agents', sandbox.agent)}>Agent</button>}
                    {sandbox.use === 'left over' && <Action label="Delete" danger onClick={() => remove(sandbox)} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {leftOver > 0 && <p className="muted small">A left-over sandbox is this project's, but nothing uses it any more: a crash or a failed delete left it. It still holds its container until deleted.</p>}
      </section>

      {current && <Refused sandbox={current} />}

      {others.length > 0 && (
        <section>
          <h2>Other sandboxes on this gateway</h2>
          <table>
            <thead><tr><th>Sandbox</th><th>Project</th><th>OpenShell</th><th>Age</th><th>CPU</th><th>Memory</th></tr></thead>
            <tbody>
              {others.map((sandbox) => (
                <tr key={sandbox.name}>
                  <td className="mono">{sandbox.name}</td>
                  <td className="muted">{sandbox.project ?? 'no label'}</td>
                  <td><Badge status={sandbox.phase === 'Ready' ? 'running' : sandbox.phase.toLowerCase()} label={sandbox.phase} /></td>
                  <td className="muted">{age(sandbox)}</td>
                  <Use usage={used(sandbox)} />
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">
            Another project's, a probe of <code>harness doctor</code>, or one made by 0.3.0 or earlier, which didn't label sandboxes. The dashboard deletes none of them; in a terminal: <Command text={`openshell sandbox delete ${others[0]!.name}`} />
          </p>
        </section>
      )}
    </div>
  );
}

/** What Docker says the sandboxes use, read again every five seconds while the view is open. */
function useUsage(): UsageReading | undefined {
  const [usage, setUsage] = useState<UsageReading>();
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const read = async () => {
      const next = await getJson<UsageReading>('/api/sandboxes/usage').catch(() => undefined);
      if (stopped) return;
      if (next) setUsage(next);
      timer = window.setTimeout(() => void read(), 5000);
    };
    void read();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, []);
  return usage;
}

/** A sandbox's CPUs and memory in use, against its caps; near a cap, in color. */
function Use({ usage }: { usage?: SandboxUsage | undefined }) {
  if (!usage) return <><td /><td /></>;
  const near = (used: number, cap?: number) => (cap !== undefined && used >= 0.9 * cap ? 'bad' : undefined);
  return (
    <>
      <td className={near(usage.cpu, usage.cpuLimit)}>{cpus(usage.cpu)}{usage.cpuLimit !== undefined && <span className="muted"> of {usage.cpuLimit}</span>}</td>
      <td className={near(usage.memoryBytes, usage.memoryLimitBytes)}>{size(usage.memoryBytes)}{usage.memoryLimitBytes !== undefined && <span className="muted"> of {size(usage.memoryLimitBytes)}</span>}</td>
    </>
  );
}

/** The owner's caps on each new sandbox, CPUs and GiB of memory; an empty field lifts its cap. */
function Limits({ limits, machine, onSaved }: { limits: SandboxOverview['limits']; machine: SandboxOverview['machine']; onSaved: () => Promise<void> }) {
  const [cpu, setCpu] = useState(limits.cpu?.toString() ?? '');
  const [memory, setMemory] = useState(limits.memoryGiB?.toString() ?? '');
  const value = (text: string) => (text.trim() === '' ? null : Number(text));
  const capped = limits.cpu !== undefined || limits.memoryGiB !== undefined;
  const now = [limits.cpu !== undefined ? `${limits.cpu} CPU${limits.cpu === 1 ? '' : 's'}` : 'any CPUs', limits.memoryGiB !== undefined ? `${limits.memoryGiB} GiB` : 'any memory'].join(' and ');
  return (
    <section>
      <h2>Caps on each new sandbox</h2>
      <div className="row">
        <label>CPUs <input type="number" min={0.5} max={machine.cpus} step={0.5} value={cpu} placeholder="no cap" onChange={(e) => setCpu(e.target.value)} /></label>
        <label>Memory <input type="number" min={1} max={Math.floor(machine.memoryGiB)} step={1} value={memory} placeholder="no cap" onChange={(e) => setMemory(e.target.value)} /> GiB</label>
        <Action
          label="Save"
          onClick={async () => {
            const result = await post('/api/sandboxes/limits', { cpu: value(cpu), memoryGiB: value(memory) });
            if (result.done) await onSaved();
            return result;
          }}
        />
      </div>
      <p className="muted small">
        {capped ? `Now ${now} for each sandbox. ` : `No cap now: each sandbox may use all of this machine's ${machine.cpus} CPUs and ${machine.memoryGiB} GiB. `}
        The caps hold for the sandboxes made from now on, for each attempt, check run, reviewer and Manager; those already there, like an Architect's, keep theirs.
        Past its memory cap, a sandbox may swap up to as much again; then the process that asks for more is killed, with exit code 137, and the sandbox stays.
      </p>
    </section>
  );
}

/** The network requests the sandbox's policy refused, from its recent log. */
function Refused({ sandbox }: { sandbox: SandboxRow }) {
  const [denials, setDenials] = useState<Denial[]>();
  useEffect(() => {
    setDenials(undefined);
    let current = true;
    const load = () => void getJson<Denial[]>(`/api/sandboxes/denials?name=${encodeURIComponent(sandbox.name)}`).then((list) => current && setDenials(list ?? []), () => current && setDenials([]));
    load();
    const timer = window.setInterval(load, 15_000);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [sandbox.name]);
  return (
    <section>
      <h2>Refused by its network policy · {sandbox.name}</h2>
      {denials === undefined ? <p className="muted">Reading its log…</p> : denials.length === 0 ? (
        <p className="muted">Nothing refused in its recent log.</p>
      ) : <DenialTable denials={denials} />}
    </section>
  );
}

function age(sandbox: SandboxRow): string {
  return sandbox.createdAt ? duration(Date.now() - Date.parse(sandbox.createdAt)) : '';
}
