import { defineComponent, type PropType } from 'vue';
import type { DashboardState, State } from '../api.ts';

type ModuleDesign = DashboardState['design']['modules'][number];

const COL = 230;
const GAP = 28;
const ROW = 34;
const PAD = 10;
const HEAD = 42;
const NODE_H = 26;
const LIVE = ['starting', 'running', 'collecting', 'checking', 'reviewing'];

/**
 * A module's features as a graph (v3 §6.7): one box per plan, in order, its features
 * stacked inside, and an edge for every dependency. Green is accepted, blue under way,
 * amber waiting for a decision, red escalated, grey not started; a plan's box says what
 * it waits for, or where its pull request stands.
 */
export const Graph = defineComponent({
  props: {
    module: { type: Object as PropType<ModuleDesign>, required: true },
    state: { type: Object as PropType<State>, required: true },
  },
  setup(props) {
    return () => {
      const { module, state } = props;
      const columns = module.plans.map((plan, i) => ({ plan, x: i * (COL + GAP) }));
      const rows = Math.max(1, ...module.plans.map((p) => p.features.length));
      const height = HEAD + rows * ROW + PAD;
      const width = Math.max(1, columns.length * (COL + GAP) - GAP);
      const at = new Map<string, { x: number; y: number }>();
      for (const { plan, x } of columns) plan.features.forEach((f, row) => at.set(`${plan.id}/${f.id}`, { x: x + PAD, y: HEAD + row * ROW }));
      const edges = module.plans.flatMap((plan) => plan.features.flatMap((f) => f.dependsOn.map((dep) => ({
        from: dep.includes('/') ? dep : `${plan.id}/${dep}`,
        to: `${plan.id}/${f.id}`,
      }))));
      return (
        <div class="graph-wrap">
          <svg class="graph" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`The features of ${module.id} and their dependencies`}>
            <defs>
              <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 8 4 L 0 8 z" />
              </marker>
            </defs>
            {columns.map(({ plan, x }) => {
              const planState = state.plans[`${module.id}/${plan.id}`];
              return (
                <g key={plan.id} class={`plan-box ${planTone(planState)}`}>
                  <rect x={x} y={0} width={COL} height={height} rx={8} />
                  <text x={x + PAD} y={17} class="plan-title">{cut(`${plan.id} · ${plan.title}`, 30)}</text>
                  <text x={x + PAD} y={32} class="plan-status">{planLabel(planState, plan.dependsOn)}</text>
                  {plan.features.map((f) => {
                    const pos = at.get(`${plan.id}/${f.id}`)!;
                    const feature = state.features[`${module.id}/${plan.id}/${f.id}`];
                    return (
                      <g key={f.id} class={`node ${featureTone(feature)}`}>
                        <title>{`${f.id} ${f.title}: ${featureLabel(feature)}`}</title>
                        <rect x={pos.x} y={pos.y} width={COL - 2 * PAD} height={NODE_H} rx={5} />
                        <text x={pos.x + 8} y={pos.y + 17}>{cut(`${f.id} ${f.title}`, 28)}</text>
                      </g>
                    );
                  })}
                </g>
              );
            })}
            {edges.map(({ from, to }) => {
              const a = at.get(from);
              const b = at.get(to);
              if (!a || !b) return null;
              const w = COL - 2 * PAD;
              const path = a.x === b.x
                // Within a plan: out of the right side and back in, below.
                ? `M ${a.x + w} ${a.y + NODE_H / 2} C ${a.x + w + 16} ${a.y + NODE_H / 2}, ${b.x + w + 16} ${b.y + NODE_H / 2}, ${b.x + w} ${b.y + NODE_H / 2}`
                : `M ${a.x + w} ${a.y + NODE_H / 2} C ${a.x + w + GAP} ${a.y + NODE_H / 2}, ${b.x - GAP} ${b.y + NODE_H / 2}, ${b.x} ${b.y + NODE_H / 2}`;
              return <path key={`${from}>${to}`} d={path} class="edge" marker-end="url(#arrow)" />;
            })}
          </svg>
        </div>
      );
    };
  },
});

function featureTone(feature: State['features'][string] | undefined): string {
  if (!feature) return 'muted';
  if (feature.status === 'accepted') return 'ok';
  if (feature.status === 'escalated') return 'bad';
  const last = feature.attempts.at(-1);
  if (last && LIVE.includes(last.status)) return 'run';
  return feature.attempts.length > 0 ? 'warn' : 'muted';
}

function featureLabel(feature: State['features'][string] | undefined): string {
  if (!feature) return 'not started';
  const last = feature.attempts.at(-1);
  return `${feature.status.replace(/_/g, ' ')}${last ? `, attempt ${last.n} ${last.status}` : ''}`;
}

function planTone(plan: State['plans'][string] | undefined): string {
  if (!plan) return 'muted';
  if (plan.status === 'completed') return 'ok';
  if (plan.mergeCommit) return 'ok';
  if (plan.leftToOwner || plan.status === 'ready_to_merge' || plan.status === 'deploy_failed' || plan.status === 'verify_failed') return 'warn';
  return 'run';
}

function planLabel(plan: State['plans'][string] | undefined, dependsOn: string[]): string {
  if (!plan) return dependsOn.length > 0 ? `after ${dependsOn.join(', ')}` : 'not started';
  const where = plan.status === 'completed' ? 'complete' : plan.mergeCommit ? `merged, ${plan.status}` : plan.status.replace(/_/g, ' ');
  return `${where}${plan.pr ? ` · PR #${plan.pr.number}` : ''}${plan.mergedBy === 'daemon' ? ' · by the daemon' : ''}`;
}

const cut = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
