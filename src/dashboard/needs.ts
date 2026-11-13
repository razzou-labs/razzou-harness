import type { ActionState, FeatureState, ModuleState, OrderCard, OrderState, OwnerRequest, PlanState, State } from '../state/state.ts';
import type { DesignView } from './design-view.ts';

type Design = Pick<DesignView, 'modules'>;
type ModuleDesign = Design['modules'][number];
export type OwnerAction = ModuleDesign['actions'][number];

/** A plan that held-back work builds on and that isn't complete, with the held-back plans that build on it. */
export interface Upstream {
  plan: string;
  /** 'waiting' before the plan starts. */
  status: PlanState['status'] | 'waiting';
  /** Its deploy or its post-deploy checks failed: it is merged, so the work that builds on it can start all the same. */
  failed: boolean;
  holds: string[];
}

/** One thing waiting for the owner: a card of Needs you. */
export type Need =
  | { kind: 'paused'; key: string; paused: NonNullable<State['pipeline']['paused']> }
  | { kind: 'locked'; key: string; module: ModuleState; rechecks: string[] }
  | { kind: 'design'; key: string; module: ModuleState }
  | { kind: 'proposal'; key: string; module: ModuleState; version: number }
  | { kind: 'escalation'; key: string; module: ModuleState; escalation: ModuleState['escalations'][number] }
  | { kind: 'request'; key: string; request: OwnerRequest }
  | { kind: 'left' | 'merge'; key: string; plan: PlanState }
  | { kind: 'escalated'; key: string; feature: FeatureState }
  | { kind: 'action'; key: string; module: string; action: OwnerAction; status?: ActionState; holds: string[]; waits: Upstream[] };

/**
 * Everything waiting for the owner, in the order to handle it: what changes the work
 * first, what starts new work last.
 *
 * 1. A paused pipeline: nothing new starts until it is resumed.
 * 2. Each module's cards from its Architect: a change to locked files, a design, a
 *    proposal, a Manager's question to it. They may redefine what the cards below are
 *    about, a gate's check among them.
 * 3. The build's own: the Managers' questions, the blocking ones first, then the oldest;
 *    the plans' pull requests, in the design's order; the escalated features of a module
 *    without an Architect.
 * 4. Gates and tasks, since marking one done starts the work it held back: those whose
 *    work builds on nothing unfinished first.
 *
 * The daemon holds back whatever isn't ready, so most cards can't be handled too early.
 * A gate can: its `when` is a sentence for the owner, which the daemon can't check.
 */
export function listNeeds({ state, design }: { state: State; design: Design }): Need[] {
  const needs: Need[] = [];
  const paused = state.pipeline.paused;
  if (paused) needs.push({ kind: 'paused', key: 'paused', paused });

  for (const module of Object.values(state.modules)) {
    const id = module.module;
    if (module.locked?.pr) needs.push({ kind: 'locked', key: `locked:${id}`, module, rechecks: rechecks(design, state, module) });
    if (module.status === 'in_review' && module.design?.pr) needs.push({ kind: 'design', key: `design:${id}`, module });
    const latest = module.proposals.at(-1);
    if (module.status === 'proposed' && latest && !latest.acceptedAt) needs.push({ kind: 'proposal', key: `proposal:${id}`, module, version: latest.version });
    for (const escalation of module.escalations) {
      if (escalation.decision === undefined) needs.push({ kind: 'escalation', key: `escalation:${escalation.id}`, module, escalation });
    }
  }

  const requests = Object.values(state.ownerRequests)
    .filter((r) => r.answer === undefined)
    .sort((a, b) => Number(b.blocking) - Number(a.blocking) || a.askedAt.localeCompare(b.askedAt));
  for (const request of requests) needs.push({ kind: 'request', key: `request:${request.requestId}`, request });

  const order = new Map(design.modules.flatMap((m) => m.plans.map((p) => `${m.id}/${p.id}`)).map((key, index) => [key, index]));
  const position = (plan: PlanState) => order.get(`${plan.module}/${plan.plan}`) ?? order.size;
  const open = Object.values(state.plans)
    .filter((p) => p.pr && (p.status === 'ready_to_merge' || p.status === 'pr_open'))
    .sort((a, b) => position(a) - position(b));
  for (const plan of open) {
    // Main conflicts with the branch: GitHub can't merge the PR, and the plan's Manager has the conflict resolved first.
    if (plan.mainConflict) continue;
    // In Swarm, the merge policy may leave a PR to the owner, with its reason (v3 §3.2): for the head it was left at.
    // A head pushed since is the policy's to look at again.
    if (plan.leftToOwner && plan.leftToOwner.head !== (plan.pushed ?? plan.head)) continue;
    if (plan.leftToOwner) needs.push({ kind: 'left', key: `left:${plan.module}/${plan.plan}`, plan });
    else if (plan.status === 'ready_to_merge') needs.push({ kind: 'merge', key: `merge:${plan.module}/${plan.plan}`, plan });
  }

  for (const feature of Object.values(state.features)) {
    // Out of attempts in a module with an Architect, a feature is its Manager's to take there: the owner sees the
    // question to the Architect, and a design change if one comes. Without an Architect, the owner decides.
    if (feature.status === 'escalated' && !state.modules[feature.module]) needs.push({ kind: 'escalated', key: `escalated:${feature.module}/${feature.plan}/${feature.feature}`, feature });
  }

  const actions: Array<Extract<Need, { kind: 'action' }>> = [];
  for (const module of design.modules) {
    for (const action of module.actions) {
      const status = state.actions[`${module.id}/${action.id}`];
      if (status?.status === 'done') continue;
      const holds = heldBack(module, action);
      actions.push({
        kind: 'action', key: `action:${module.id}/${action.id}`, module: module.id, action,
        ...(status ? { status } : {}), holds, waits: upstream(module, state, holds),
      });
    }
  }
  needs.push(...actions.filter((a) => a.waits.length === 0), ...actions.filter((a) => a.waits.length > 0));
  return needs;
}

/**
 * A module is complete once every plan the design has for it is: nothing of it is left
 * to build, which is how the daemon picks the module to build. A design change that
 * adds a plan gives it one to build again.
 */
export function moduleCompleted(module: Pick<ModuleDesign, 'id' | 'plans'> | undefined, state: Pick<State, 'plans'>): boolean {
  return module !== undefined && module.plans.length > 0 && module.plans.every((plan) => state.plans[`${module.id}/${plan.id}`]?.status === 'completed');
}

/** What a gate holds back: the plans and features it blocks, and the features that name it. A task holds nothing back. */
export function heldBack(module: ModuleDesign, action: OwnerAction): string[] {
  if (action.kind !== 'gate') return [];
  const named = module.plans.flatMap((p) => p.features.filter((f) => f.gates.includes(action.id)).map((f) => `${p.id}/${f.id}`));
  // A feature of a plan held back whole is already said.
  return [...new Set([...action.blocks, ...named.filter((ref) => !action.blocks.includes(ref.split('/')[0]!))])];
}

/**
 * The plans that held-back work builds on and that aren't complete: those its plan
 * depends on, and those of the other plans' features it depends on. The daemon starts
 * the work once they are merged; until they are complete, their deploy or their
 * post-deploy checks may still fail, or already have.
 */
export function upstream(module: ModuleDesign, state: Pick<State, 'plans'>, holds: string[]): Upstream[] {
  const found = new Map<string, Upstream>();
  for (const held of holds) {
    const [planId, featureId] = held.split('/') as [string, string | undefined];
    const plan = module.plans.find((p) => p.id === planId);
    if (!plan) continue;
    const features = featureId ? plan.features.filter((f) => f.id === featureId) : plan.features;
    const across = features.flatMap((f) => f.dependsOn.filter((d) => d.includes('/')).map((d) => d.split('/')[0]!));
    for (const id of new Set([...plan.dependsOn, ...across])) {
      const built = state.plans[`${module.id}/${id}`];
      const status = built?.status ?? 'waiting';
      if (id === planId || status === 'completed') continue;
      // A fix round before the merge is CI's or a reviewer's: nothing builds on the plan yet.
      const failed = status === 'deploy_failed' || status === 'verify_failed' || (status === 'fixing' && built?.mergeCommit !== undefined);
      const entry = found.get(id) ?? { plan: id, status, failed, holds: [] };
      if (!entry.holds.includes(planId)) entry.holds.push(planId);
      found.set(id, entry);
    }
  }
  return module.plans.flatMap((p) => found.get(p.id) ?? []);
}

/**
 * The plans whose failed post-deploy checks a change to locked files touches: the daemon
 * runs them again once the change is on main. A check the change adds isn't on main yet,
 * so its phase isn't known here: it names no plan.
 */
function rechecks(design: Design, state: State, module: ModuleState): string[] {
  const plans = design.modules.find((m) => m.id === module.module)?.plans ?? [];
  const out: string[] = [];
  for (const change of module.locked?.changes ?? []) {
    if (out.includes(change.plan) || state.plans[`${module.module}/${change.plan}`]?.status !== 'verify_failed') continue;
    const feature = plans.find((p) => p.id === change.plan)?.features.find((f) => f.id === change.feature);
    const postDeploy = new Set(feature?.checks.filter((c) => c.phase === 'post-deploy').map((c) => c.id));
    if (change.checks.some((id) => postDeploy.has(id.replace(/ \((?:added|removed)\)$/, '')))) out.push(change.plan);
  }
  return out;
}

/** How a plan that isn't complete stands, as the end of "P5 builds on P3, …". */
const STANDING: Record<Upstream['status'], string> = {
  waiting: "which hasn't started",
  active: 'which is being built',
  validating: 'whose full check run is under way',
  pr_open: 'whose pull request is open',
  fixing: 'which is being fixed',
  ready_to_merge: 'whose pull request waits to be merged',
  deploying: 'which is deploying',
  verifying: 'whose post-deploy checks are running',
  deploy_failed: 'whose deploy failed',
  verify_failed: 'whose post-deploy checks failed',
  completed: 'which is complete',
};

/**
 * "P5 builds on P3, which is deploying.", and for a plan that failed, what the gate would
 * let through: the daemon starts work once what it builds on is merged, failed or not.
 */
export function waitText(wait: Upstream): string {
  const held = list(wait.holds);
  const standing = `${held} ${wait.holds.length === 1 ? 'builds' : 'build'} on ${wait.plan}, ${STANDING[wait.status]}.`;
  return wait.failed ? `${standing} Marking this done lets ${held} start all the same.` : standing;
}

/** A card's title, as the dashboard heads it and an order request names it. */
export function needTitle(need: Need): string {
  switch (need.kind) {
    case 'paused': return 'The pipeline is paused';
    case 'locked': return `[CHANGED_LOCKED_FILES] The Architect of ${need.module.module} asks to change locked files`;
    case 'design':
      return need.module.frozenCommit
        ? `[DESIGN_MODIFY] A change to the design of ${need.module.module} is ready for review`
        : `[DESIGN] The design of ${need.module.module} is ready for review`;
    case 'proposal': return `The Architect of ${need.module.module} proposes v${need.version}`;
    case 'escalation': return `The Manager asks the Architect of ${need.module.module}${need.escalation.feature ? ` about ${need.escalation.feature}` : ''}`;
    case 'request': return `The Manager of ${need.request.module} asks you`;
    case 'left': return `PR #${need.plan.pr?.number ?? '?'} of ${need.plan.module}/${need.plan.plan} waits for you`;
    case 'merge': return `${need.plan.module}/${need.plan.plan} passed CI`;
    case 'escalated': return `${need.feature.module}/${need.feature.plan}/${need.feature.feature} is escalated`;
    case 'action': return `${need.action.kind === 'gate' ? 'Gate' : 'Task'} ${need.module}/${need.action.id}: ${need.action.title}`;
  }
}

/**
 * What the daemon knows of a card that advice about it rests on: a later print that
 * differs means the card isn't what it was. A card's own text is one with its key, so it
 * isn't repeated here; what moves under a card is: a pull request's head, a gate's
 * status and its text on main, the plans its work builds on that failed.
 */
export function needPrint(need: Need): string {
  const facts = (): unknown => {
    switch (need.kind) {
      case 'paused': return [need.paused.reason, need.paused.until ?? null];
      case 'locked': return [need.module.locked?.head ?? null, need.rechecks];
      case 'design': return [need.module.design?.head ?? null];
      case 'proposal': return [need.version];
      case 'escalation': return [];
      case 'request': return [need.request.blocking];
      case 'left': return [need.plan.leftToOwner?.head ?? null, need.plan.leftToOwner?.reason ?? null];
      case 'merge': return [need.plan.pushed ?? need.plan.head];
      case 'escalated': return [need.feature.attempts.length, need.feature.escalation ?? null];
      // A gate's check running is no change to the card; a gate rewritten on main is. A plan it builds on
      // matters once it failed: until then, its way to complete is no news.
      case 'action': return [
        need.status?.status === 'verifying' ? 'pending' : need.status?.status ?? 'pending', need.status?.reason ?? null,
        hash(JSON.stringify([need.action.when, need.action.instructions, need.action.verify])), need.holds, need.waits.filter((w) => w.failed).map((w) => w.plan),
      ];
    }
  };
  return JSON.stringify(facts());
}

/** FNV-1a, 32 bits, in hex: short, and the same in the browser and in the daemon. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * What the page already told the owner of: the cards that were there at its last look,
 * and the last pause that only waits to look again it showed a notification for.
 */
export interface Told {
  present: Set<string>;
  retry?: { reason: string; at: number };
}

/** A pause that only waits to look again, for the same reason, isn't announced again within this long: its card comes back every ten minutes. */
export const QUIET_MS = 3_600_000;

/** What makes a card new: its key, and for a pause its reason and whether it only waits, as every pause has the key `paused`. */
const arrival = (need: Need): string => (need.kind === 'paused' ? `paused\n${need.paused.reason}\n${need.paused.retry === true}` : need.key);

/**
 * The cards that arrived since the page's last look, for its notifications, and what it
 * has told by now. The first look announces nothing: what already waits isn't news. A
 * pause that only waits to look again, with the reason of the last one announced, waits
 * out the quiet hour; any other pause is news. `shown` says whether the page shows the
 * notifications: only one shown starts the quiet hour.
 */
export function arrivals(needs: Need[], told: Told | undefined, now: number, shown = true): { fresh: Need[]; told: Told } {
  const present = new Set(needs.map(arrival));
  if (!told) return { fresh: [], told: { present } };
  const quiet = (need: Need) =>
    need.kind === 'paused' && need.paused.retry === true && told.retry?.reason === need.paused.reason && now - told.retry.at < QUIET_MS;
  const fresh = needs.filter((need) => !told.present.has(arrival(need)) && !quiet(need));
  const retry = shown ? fresh.find((need) => need.kind === 'paused' && need.paused.retry === true) : undefined;
  const last = retry?.kind === 'paused' ? { reason: retry.paused.reason, at: now } : told.retry;
  return { fresh, told: { present, ...(last ? { retry: last } : {}) } };
}

/** The cards as an order request records them. */
export const orderCards = (needs: Need[]): OrderCard[] => needs.map((need) => ({ key: need.key, title: needTitle(need), print: needPrint(need) }));

/** Needs you, in the order to show it: the standard one, or the Manager's while it holds. */
export interface Ordered {
  needs: Need[];
  by: 'standard' | 'manager';
  /** Why each card is where the Manager put it; empty for one it left out, which the daemon put last. */
  why: Record<string, string>;
  /** The owner asked, and the Manager hasn't answered. */
  waiting: boolean;
  /** The Manager's order no longer holds: the titles of the cards that came since, and of those that changed. */
  outdated?: { added: string[]; changed: string[] };
}

/**
 * The cards in the Manager's order, while its advice is about the cards as they are: a
 * card handled since leaves the rest in their order, but a card it never saw, or one that
 * changed under it, makes the whole order one of another moment. Then, and before any
 * answer, the standard order shows.
 */
export function orderNeeds(needs: Need[], order: OrderState | undefined): Ordered {
  const standard: Ordered = { needs, by: 'standard', why: {}, waiting: false };
  if (!order) return standard;
  const asked = new Map(order.cards.map((card) => [card.key, card.print]));
  // Every card of the request handled since: nothing is left of it to show.
  if (!needs.some((need) => asked.has(need.key))) return standard;
  if (!order.suggestion) return { ...standard, waiting: true };
  const added = needs.filter((need) => !asked.has(need.key));
  const changed = needs.filter((need) => asked.has(need.key) && asked.get(need.key) !== needPrint(need));
  if (added.length > 0 || changed.length > 0) return { ...standard, outdated: { added: added.map(needTitle), changed: changed.map(needTitle) } };
  const place = new Map(order.suggestion.order.map(({ key }, index) => [key, index]));
  const position = (need: Need) => place.get(need.key) ?? place.size;
  return {
    needs: [...needs].sort((a, b) => position(a) - position(b)),
    by: 'manager',
    why: Object.fromEntries(order.suggestion.order.map(({ key, why }) => [key, why])),
    waiting: false,
  };
}

/** "P2", "P2 and P3", "P2, P3 and P4". */
export function list(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)!}`;
}
