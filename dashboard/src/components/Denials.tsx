import type { Denial } from '../api.ts';
import { clock } from '../format.ts';

/** The requests a sandbox's network policy refused, and how to allow a host. */
export function DenialTable({ denials }: { denials: Denial[] }) {
  return (
    <>
      <table>
        <thead><tr><th>Program</th><th>Host</th><th>Why</th><th>Times</th><th>Last</th></tr></thead>
        <tbody>
          {denials.map((denial) => (
            <tr key={`${denial.program ?? ''} ${denial.target} ${denial.reason}`}>
              <td className="mono">{denial.program ?? <span className="muted">DNS query</span>}</td>
              <td className="mono">{denial.target}</td>
              <td className="muted small">{denial.reason.replace(/_/g, ' ')}</td>
              <td>{denial.count}</td>
              <td className="muted">{clock(denial.last)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">
        An agent's sandbox reaches only the hosts of its bundles and <code>network.extraHosts</code> in <code>harness/config.json</code>. To allow one, add it there, in an <code>Arch:</code> pull request or a commit of your own on <code>main</code>.
      </p>
    </>
  );
}
