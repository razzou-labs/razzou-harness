import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { designView } from '../dashboard/design-view.ts';
import { list, listNeeds, needTitle, waitText, type Need } from '../dashboard/needs.ts';
import { managerKey, managersOf, type ManagerState, type PlanState } from '../state/state.ts';
import { clip } from '../util.ts';
import type { Orchestrator } from './orchestrator.ts';

/** The cards under Needs you now, as the dashboard lists them, in its standard order. */
export const needsNow = (o: Orchestrator): Need[] => listNeeds({ state: o.state, design: designView(o.design) });

/** A Manager whose sandbox was made with the tool to answer an order request: one made before 0.5.6 has none. */
export const canOrder = (manager: ManagerState): boolean => manager.tools?.includes('suggest_order') ?? false;

/**
 * The Manager an order is asked of, among those of the module being built that can
 * answer: the module's own, or in Swarm the first of its plans'. The request carries
 * every card, so any of them can answer it. Or why none can.
 */
export function orderManager(o: Orchestrator): ManagerState | string {
  const module = o.currentModule();
  const running = module ? managersOf(o.state, module) : [];
  if (running.length === 0) return 'no Manager is running: one starts with the build of a module';
  const able = running.filter(canOrder);
  // Its tools are known once its sandbox is made.
  if (able.length === 0 && running.some((m) => m.status === 'starting')) return 'a Manager is starting: ask again in a moment';
  if (able.length === 0) {
    return `the Manager's sandbox was made before it had the tool to answer: run \`openshell sandbox delete ${running[0]!.sandbox}\`, and the daemon starts a new one`;
  }
  return able.find((m) => m.plan === undefined) ?? able[0]!;
}

/**
 * What handling each kind of card sets off in the daemon. A Manager can't read the
 * daemon's rules, and the right order follows from them: its request says them, for the
 * kinds of card it holds.
 */
const SETS_OFF: Record<Need['kind'], string> = {
  paused: 'A paused pipeline: nothing new starts until the owner resumes it. Resuming fixes nothing by itself: while what the reason names is still there, the pipeline pauses again.',
  locked:
    "A change to locked files, a CHANGED_LOCKED_FILES pull request of an Architect: the owner merges it on GitHub. It changes the definitions or the check scripts of features already built, and rebuilds nothing. Once it is on main, the daemon runs again, by itself, the post-deploy checks of a plan that failed them, when the change touches those checks.",
  design:
    'A design, or a change to one, an Arch pull request: the owner merges it on GitHub. Until they merge or close a change to a design, no new attempt starts in its module. After the merge, the features it redefined are built as redefined, and gates and tasks are read from the new design: their instructions, and the scripts that verify them.',
  proposal: "A proposal: accepting it makes the module's Architect write the design. Nothing is built from a proposal.",
  escalation: "A Manager's question to an Architect: the Architect decides, and the owner may weigh in at its terminal. Nothing waits for the owner.",
  request:
    "A Manager's question to the owner: the answer goes to the Manager that asked. A blocking one holds every new attempt in its module until it is answered. A question stays until the owner answers it, even when something that happened since made it pointless: say so if one is.",
  left: "A plan's pull request left to the owner: they merge it on GitHub. Plans that depend on it can start once it is merged. If it holds infrastructure, CI applies it after the merge, then its post-deploy checks run.",
  merge: "A plan's pull request that passed CI: the owner merges it on GitHub. Plans that depend on it can start once it is merged. If it holds infrastructure, CI applies it after the merge, then its post-deploy checks run.",
  escalated: 'An escalated feature: it used its attempts. The owner gives it one more, sends it to the Architect, or pauses the pipeline.',
  action:
    'A gate or a task: something only the owner can do, which they then mark done. A gate holds back the plans or features it blocks, and the features that name it; a task holds nothing back. If it has a verify command, the daemon runs it first, from main. Once a gate is done, the work it held back starts as soon as the plans that work depends on are merged, whether or not their deploy or their post-deploy checks passed, and marking it done can\'t be undone. Its "when" is the Architect\'s sentence for the owner: the daemon doesn\'t check it.',
};

/** Where a plan stands, for a reader who doesn't know the daemon's status words. */
const STANDS: Record<PlanState['status'], string> = {
  active: 'being built',
  validating: 'built, its full check run under way',
  pr_open: 'its pull request is open',
  fixing: 'being fixed',
  ready_to_merge: 'its pull request passed CI and is not merged',
  deploying: 'merged, and deploying',
  verifying: 'merged and deployed, its post-deploy checks running',
  deploy_failed: 'merged, and its deploy failed',
  verify_failed: 'merged and deployed, and its post-deploy checks failed',
  completed: 'complete',
};

/**
 * The order request as a Manager reads it: what is asked and what isn't, what handling
 * each kind of card sets off, where the plans stand, and every card with its text and
 * what the daemon knows of it. It is written when the owner asks, and kept in the log:
 * the Manager's order is advice about these cards as they were.
 */
export function orderRequest(o: Orchestrator, requestId: string, needs: Need[], manager: ManagerState): string {
  const kinds = [...new Set(needs.map((need) => need.kind))];
  const plans = o.design.modules.flatMap((module) => module.plans.map((plan) => {
    const state = o.state.plans[`${module.id}/${plan.id}`];
    return `- ${module.id}/${plan.id} "${plan.title}": ${state ? STANDS[state.status] : 'not started'}`;
  }));
  return [
    `[harness] ORDER REQUEST from the owner (request ${requestId})`,
    '',
    `The owner has ${needs.length} cards waiting under "Needs you" in the dashboard, and asks you in which order to handle them. The dashboard lists them by kind and can't read their text: some may depend on others, or be pointless by now, and only their text says so.`,
    '',
    'This request changes nothing. Because of it, start no fix, ask the owner or the Architect nothing, and accept, reject or retry nothing. Read the cards, then call suggest_order once, with:',
    `- request_id: "${requestId}"`,
    '- order: every card below, by its key, in the order the owner should handle them. Each has `why`: one or two sentences for the owner on why it comes there, what must be true before they handle it, or that it can wait or is pointless by now.',
    '- summary: optional, a few sentences on what matters most.',
    'If the order below is right, give it back with your reasons. Where you can\'t tell, say so: the owner decides. If you have no suggest_order tool, your sandbox was made before the harness had it: say so in one line, and do nothing else.',
    '',
    '## What handling a card sets off',
    '',
    ...kinds.map((kind) => `- ${SETS_OFF[kind]}`),
    '',
    '## Where things stand',
    '',
    `It is ${new Date(o.now()).toISOString()}. ${o.state.mode === 'swarm' ? "The mode is Swarm: the daemon merges a plan's pull request itself when its policy allows, and leaves the others to the owner." : 'The mode is Manual: the owner merges every pull request.'}`,
    ...plans,
    '',
    "## The cards, in the dashboard's order",
    ...needs.flatMap((need, index) => ['', `### ${index + 1}. key: ${need.key}`, needTitle(need), ...describe(o, need, manager)]),
    '',
    `Now call suggest_order(request_id: "${requestId}", order: [{ card: "<key>", why: "..." }, ...]) with all ${needs.length} cards.`,
  ].join('\n');
}

/** A card's text, and what the daemon knows of it beyond its text. */
function describe(o: Orchestrator, need: Need, manager: ManagerState): string[] {
  switch (need.kind) {
    case 'paused':
      return [`Paused since ${need.paused.since}${need.paused.until ? `, until ${need.paused.until}` : ''}. Reason: ${need.paused.reason}`];
    case 'locked': {
      const locked = need.module.locked!;
      return [
        `Pull request #${locked.pr?.number}: ${locked.pr?.url}`,
        ...locked.changes.map((c) => `It changes ${c.plan}/${c.feature} "${c.title}"${c.checks.length > 0 ? `, checks ${c.checks.join(', ')}` : ''}${c.scripts.length > 0 ? `, scripts ${c.scripts.join(', ')}` : ''}.`),
        ...(need.rechecks.length > 0 ? [`The post-deploy checks of ${list(need.rechecks)} failed: they run again once this is merged.`] : []),
        `The Architect's summary: ${clip(locked.summary, 3000)}`,
      ];
    }
    case 'design': {
      const design = need.module.design!;
      return [
        `Arch pull request #${design.pr?.number}: ${design.pr?.url}`,
        need.module.frozenCommit ? "A change to the module's design, which is merged and being built." : "The module's first design: nothing of it is built yet.",
        ...(design.suspect.length > 0 ? [`Checks that already pass before anything is built: ${design.suspect.join(', ')}.`] : []),
        `The Architect's summary: ${clip(design.summary, 3000)}`,
      ];
    }
    case 'proposal': {
      const file = join(o.options.harnessDir, 'modules', need.module.module, 'proposals', `v${need.version}.md`);
      return [`It begins: ${existsSync(file) ? clip(readFileSync(file, 'utf8').trim(), 1500) : '(its text could not be read)'}`];
    }
    case 'escalation':
      return [`Asked ${need.escalation.askedAt}. The question: ${clip(need.escalation.question, 2000)}`];
    case 'request': {
      const mine = need.request.manager === managerKey(manager);
      return [
        `Asked ${need.request.askedAt}${mine ? ', by you' : need.request.manager ? `, by the Manager of ${need.request.manager}` : ''}. ${need.request.blocking ? 'Blocking: no new attempt starts in its module until the owner answers.' : 'Not blocking.'}`,
        `The question: ${clip(need.request.question, 4000)}`,
      ];
    }
    case 'left':
      return [`Pull request #${need.plan.pr?.number}: ${need.plan.pr?.url}`, `Why the daemon left it to the owner: ${need.plan.leftToOwner?.reason}`];
    case 'merge':
      return [`Pull request #${need.plan.pr?.number}: ${need.plan.pr?.url}`];
    case 'escalated':
      return [`Why: ${need.feature.escalation ?? 'its attempts are used'}`];
    case 'action': {
      const { action, status, holds, waits } = need;
      return [
        `When, in the Architect's words: ${action.when}`,
        holds.length > 0 ? `It holds back ${list(holds)} until it is done.` : action.kind === 'gate' ? 'It holds back nothing the design names.' : 'A task: it holds nothing back.',
        ...waits.map(waitText),
        `${action.verify ? 'It has a verify command, which runs when the owner marks it done.' : 'It has no verify command.'}${status?.status === 'verifying' ? ' Its check is running.' : status?.status === 'refused' ? ` Its check failed: ${clip(status.reason ?? '', 500)}` : ''}`,
        `Its instructions for the owner: ${clip(action.instructions, 3000)}`,
      ];
    }
  }
}
