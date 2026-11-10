import { QCard, QCardSection, QTooltip, QTree } from 'quasar';
import { defineComponent, ref, type PropType } from 'vue';
import type { DashboardState, State } from '../api.ts';

type ModuleDesign = DashboardState['design']['modules'][number];
type PlanDesign = ModuleDesign['plans'][number];
type FeatureDesign = PlanDesign['features'][number];

const LIVE = ['starting', 'running', 'collecting', 'checking', 'reviewing'];

/** A plan's box at the root of its tree, its features below it. */
type TreeNode = { key: string; children: TreeNode[] } & (
  | { kind: 'plan'; plan: PlanDesign }
  /** `also`: what it waits for besides the feature it hangs from, as the design names it. */
  | { kind: 'feature'; feature: FeatureDesign; also: string[]; hangs: boolean; supersededBy?: string }
);

/**
 * A module's features and their dependencies (v3 §6.7), one tree per plan, in order, each in a card. A
 * feature hangs from the feature of its plan it waits for: of several, the one at the end
 * of the longest chain, with the others, and another plan's, named beside it. Green is
 * accepted, blue under way, amber waiting for a decision, red escalated, grey not started;
 * a plan's box says what it waits for, or where its pull request stands.
 */
export const Dependencies = defineComponent({
  props: {
    module: { type: Object as PropType<ModuleDesign>, required: true },
    state: { type: Object as PropType<State>, required: true },
  },
  setup(props) {
    return () => (
      <div class="deps row q-col-gutter-md q-my-sm" role="group" aria-label={`The features of ${props.module.id} and their dependencies`}>
        {props.module.plans.map((plan) => (
          <div key={plan.id} class="col-12 col-md-6 col-xl-4">
            <QCard flat bordered class="full-height">
              <QCardSection class="q-pa-sm">
                <PlanTree module={props.module.id} modulePlans={props.module.plans} plan={plan} state={props.state} />
              </QCardSection>
            </QCard>
          </div>
        ))}
      </div>
    );
  },
});

const PlanTree = defineComponent({
  props: {
    module: { type: String, required: true },
    /** Every plan of the module: a later one may supersede a feature of this one. */
    modulePlans: { type: Array as PropType<PlanDesign[]>, required: true },
    plan: { type: Object as PropType<PlanDesign>, required: true },
    state: { type: Object as PropType<State>, required: true },
  },
  setup(props) {
    // What the owner folded: everything else stays open, features added later included.
    const folded = ref(new Set<string>());
    return () => {
      const { module, plan, state } = props;
      const root: TreeNode = { key: plan.id, kind: 'plan', plan, children: featureTree(plan, supersededIn(props.modulePlans, plan.id)) };
      const parents = branches(root);
      return (
        <QTree
          nodes={[root]}
          nodeKey="key"
          expanded={parents.filter((key) => !folded.value.has(key))}
          {...{ 'onUpdate:expanded': (keys: readonly string[]) => (folded.value = new Set(parents.filter((key) => !keys.includes(key)))) }}
        >
          {{
            'default-header': ({ node }: { node: TreeNode }) => {
              if (node.kind === 'plan') {
                const planState = state.plans[`${module}/${node.plan.id}`];
                return (
                  <div class={`deps-plan ${planTone(planState)}`}>
                    <div class="deps-plan-title">{node.plan.id} · {node.plan.title}</div>
                    <div class="deps-plan-status">{planLabel(planState, node.plan.dependsOn)}</div>
                  </div>
                );
              }
              const feature = state.features[`${module}/${plan.id}/${node.feature.id}`];
              return (
                <div>
                  <span class={`deps-feature ${featureTone(feature)}`}>
                    <span class="deps-feature-label">{node.feature.id} {node.feature.title}</span>
                    <QTooltip>{`${node.feature.id} ${node.feature.title}: ${featureLabel(feature)}`}</QTooltip>
                  </span>
                  {node.also.length > 0 && <span class="deps-also">{node.hangs ? 'also after' : 'after'} {node.also.join(', ')}</span>}
                  {node.supersededBy && <span class="deps-also">superseded by {node.supersededBy}</span>}
                </div>
              );
            },
          }}
        </QTree>
      );
    };
  },
});

/**
 * A plan's features as a tree: each hangs from the deepest of its own plan's features it
 * waits for, the last named on a tie; one that waits for none of them is a root. The
 * design names only earlier features of the plan, so the chains end.
 */
/** Which of a plan's features later plans supersede, and by what, as P6/F11 (v5). */
function supersededIn(plans: PlanDesign[], planId: string): Map<string, string> {
  const by = new Map<string, string>();
  for (const later of plans) {
    for (const f of later.features) {
      for (const ref of f.supersedes ?? []) {
        const [target, feature] = ref.includes('/') ? ref.split('/') : [later.id, ref];
        if (target === planId && feature) by.set(feature, `${later.id}/${f.id}`);
      }
    }
  }
  return by;
}

function featureTree(plan: PlanDesign, supersededBy: Map<string, string> = new Map()): TreeNode[] {
  const own = (dep: string) => (dep.includes('/') ? (dep.startsWith(`${plan.id}/`) ? dep.slice(plan.id.length + 1) : undefined) : dep);
  const ids = new Set(plan.features.map((f) => f.id));
  const depth = new Map<string, number>();
  const parent = new Map<string, string>();
  for (const f of plan.features) {
    let best: string | undefined;
    for (const dep of f.dependsOn.map(own)) {
      if (dep === undefined || !ids.has(dep) || !depth.has(dep)) continue;
      if (best === undefined || depth.get(dep)! >= depth.get(best)!) best = dep;
    }
    depth.set(f.id, best === undefined ? 0 : depth.get(best)! + 1);
    if (best !== undefined) parent.set(f.id, best);
  }
  const nodes = new Map<string, TreeNode>();
  for (const f of plan.features) {
    const hangs = parent.get(f.id);
    const by = supersededBy.get(f.id);
    nodes.set(f.id, {
      key: `${plan.id}/${f.id}`, kind: 'feature', feature: f, also: hangs === undefined ? f.dependsOn : f.dependsOn.filter((dep) => own(dep) !== hangs), hangs: hangs !== undefined, children: [],
      ...(by ? { supersededBy: by } : {}),
    });
  }
  const roots: TreeNode[] = [];
  for (const f of plan.features) {
    const hangs = parent.get(f.id);
    (hangs === undefined ? roots : nodes.get(hangs)!.children).push(nodes.get(f.id)!);
  }
  return roots;
}

/** The keys of the nodes that have children: what can open and fold. */
function branches(node: TreeNode): string[] {
  return node.children.length === 0 ? [] : [node.key, ...node.children.flatMap(branches)];
}

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
