/** Network requests a sandbox's policy refused, counted, as OpenShell logs them. */
export interface Denial {
  /** The program that asked, when the log names it. */
  program?: string;
  /** Host and port, or the host of a refused DNS query. */
  target: string;
  /** OpenShell's reason, like `transparent_tcp_policy_denied`. */
  reason: string;
  count: number;
  /** When it was last refused. */
  last: string;
}

/** OpenShell keeps the last 2000 lines of a sandbox's log, and returns no more. */
export const LOG_LINES = 2000;

/** At most this many kinds of refusal are counted: the agent chooses the hosts, and could otherwise grow the list without end. */
const MAX_KINDS = 100;

/**
 * Adds up the requests a sandbox's policy refused, from readings of its log. OpenShell
 * keeps only a sandbox's last lines, so the log of a long attempt is read every minute:
 * readings overlap, and each counts only the refusals after the last one counted, which
 * their times tell. OpenShell's supervisor writes one OCSF line per decision, such as
 * `[1794077355.601] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/curl(0) ->
 * example.com:443 [reason:transparent_tcp_policy_denied]`, and one for the DNS query
 * before it, which only counts when no connection to the host was logged. Read with
 * string operations: the agent chooses the hosts in these lines.
 */
export class Denials {
  private readonly counted = new Map<string, Denial>();
  /** The time of the last refusal counted, in ms, and how many refusals at that time were. */
  private mark = { at: -1, seen: 0 };

  add(log: string): this {
    const mark = this.mark;
    // The refusals at the mark's time met in this reading, and the latest time met with its own count.
    let atMark = 0;
    let latest = mark.at;
    let atLatest = 0;
    for (const line of log.split('\n')) {
      const refusal = parseLine(line);
      if (!refusal) continue;
      const { time, ...what } = refusal;
      if (time === mark.at) atMark++;
      if (time > latest) [latest, atLatest] = [time, 0];
      if (time === latest && time > mark.at) atLatest++;
      // Counted by an earlier reading: before the mark, or among the refusals at its time already seen.
      if (time < mark.at || (time === mark.at && atMark <= mark.seen)) continue;
      const key = `${what.program ?? ''}\u0000${what.target}\u0000${what.reason}`;
      const denial = this.counted.get(key);
      const last = new Date(time).toISOString();
      if (denial) Object.assign(denial, { count: denial.count + 1, last: last > denial.last ? last : denial.last });
      else if (this.counted.size < MAX_KINDS) this.counted.set(key, { ...what, count: 1, last });
    }
    this.mark = latest > mark.at ? { at: latest, seen: atLatest } : { at: mark.at, seen: Math.max(mark.seen, atMark) };
    return this;
  }

  /** The refusals counted, the latest first. */
  list(): Denial[] {
    const all = [...this.counted.values()];
    const connected = new Set(all.filter((d) => d.program).map((d) => hostOf(d.target)));
    return all
      .filter((d) => d.program || !connected.has(d.target))
      .map((d) => ({ ...d }))
      .sort((a, b) => b.last.localeCompare(a.last, 'en'));
  }
}

/** The refusals in one reading of a log. */
export function parseDenials(log: string): Denial[] {
  return new Denials().add(log).list();
}

/** A refusal's line, or undefined for any other line, or one without its time. */
function parseLine(line: string): (Omit<Denial, 'count' | 'last'> & { time: number }) | undefined {
  const at = line.indexOf(' DENIED ');
  if (at < 0 || !line.startsWith('[') || !line.includes('[ocsf]')) return undefined;
  const seconds = Number(line.slice(1, line.indexOf(']')));
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  const rest = line.slice(at + ' DENIED '.length);
  const reasonAt = rest.lastIndexOf(' [reason:');
  const body = (reasonAt >= 0 ? rest.slice(0, reasonAt) : rest).trim();
  const reason = reasonAt >= 0 ? rest.slice(reasonAt + ' [reason:'.length).split(']')[0]! : 'refused';
  const arrow = body.indexOf(' -> ');
  const program = arrow >= 0 ? withoutPid(body.slice(0, arrow)) : undefined;
  const target = arrow >= 0 ? body.slice(arrow + ' -> '.length) : body;
  if (!target) return undefined;
  return { ...(program ? { program: program.slice(0, 300) } : {}), target: target.slice(0, 300), reason: reason.slice(0, 100), time: Math.round(seconds * 1000) };
}

/** `/usr/bin/curl(0)` is `/usr/bin/curl`. */
function withoutPid(program: string): string {
  const open = program.lastIndexOf('(');
  return open > 0 && program.endsWith(')') && /^\d+$/.test(program.slice(open + 1, -1)) ? program.slice(0, open) : program;
}

/** `example.com:443` is `example.com`; `[::1]:443` is `[::1]`. */
function hostOf(target: string): string {
  const colon = target.lastIndexOf(':');
  return colon > 0 && /^\d+$/.test(target.slice(colon + 1)) ? target.slice(0, colon) : target;
}
