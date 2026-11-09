import { QMarkupTable } from 'quasar';
import { defineComponent, type PropType } from 'vue';
import type { Denial } from '../api.ts';
import { clock } from '../format.ts';

/** The requests a sandbox's network policy refused, and how to allow a host. */
export const DenialTable = defineComponent({
  props: { denials: { type: Array as PropType<Denial[]>, required: true } },
  setup(props) {
    return () => (
      <>
        <QMarkupTable flat bordered dense wrapCells>
          <thead><tr><th class="text-left">Program</th><th class="text-left">Host</th><th class="text-left">Why</th><th class="text-right">Times</th><th class="text-left">Last</th></tr></thead>
          <tbody>
            {props.denials.map((denial) => (
              <tr key={`${denial.program ?? ''} ${denial.target} ${denial.reason}`}>
                <td class="mono">{denial.program ?? <span class="text-grey-7">DNS query</span>}</td>
                <td class="mono">{denial.target}</td>
                <td class="text-caption text-grey-7">{denial.reason.replace(/_/g, ' ')}</td>
                <td class="text-right">{denial.count}</td>
                <td class="text-grey-7">{clock(denial.last)}</td>
              </tr>
            ))}
          </tbody>
        </QMarkupTable>
        <p class="text-caption text-grey-7 q-mt-sm">
          An agent's sandbox reaches only the hosts of its bundles, <code>network.extraHosts</code> and <code>network.apis</code> in <code>harness/config.json</code>. To allow one, add it there, in an <code>Arch:</code> pull request or a commit of your own on <code>main</code>.
        </p>
      </>
    );
  },
});
