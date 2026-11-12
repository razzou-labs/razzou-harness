import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { arrivals, heldBack, listNeeds, moduleCompleted, needPrint, needTitle, orderCards, orderNeeds, QUIET_MS, upstream, waitText, type Need } from '../src/dashboard/needs.ts';
import type { DashboardState } from '../src/dashboard/server.ts';
import type { ModuleState, OrderState, PlanState, State } from '../src/state/state.ts';

type ModuleDesign = DashboardState['design']['modules'][number];
type PlanDesign = ModuleDesign['plans'][number];
type FeatureDesign = PlanDesign['features'][number];

const feature = (id: string, more: Partial<FeatureDesign> = {}): FeatureDesign => ({
  id, title: id, kind: 'app', dependsOn: [], supersedes: [], gates: [], checks: [{ id: `${id}-check`, phase: 'pre-merge', needs: [] }], ...more,
});
const plan = (id: string, dependsOn: string[], features: FeatureDesign[]): PlanDesign => ({ id, title: id, goal: id, dependsOn, features });
const action = (id: string, kind: 'gate' | 'task', more: Partial<ModuleDesign['actions'][number]> = {}): ModuleDesign['actions'][number] => ({
  id, kind, title: id, when: 'anytime', blocks: [], instructions: 'Do it.', verify: false, estimatedMinutes: 1, ...more,
});
const built = (module: string, id: string, status: PlanState['status'], more: Partial<PlanState> = {}): PlanState => ({
  module, plan: id, status, branch: `plan/${module}/${id}`, base: 'a', head: 'b', ...more,
});
const architect = (module: string, status: ModuleState['status'], more: Partial<ModuleState> = {}): ModuleState => ({
  module, title: module, status, architect: { sandbox: `arc-${module}`, sessionId: 's', status: 'running' }, proposals: [], notes: [], escalations: [], ...more,
});

function data(modules: ModuleDesign[], state: Partial<State>): Pick<DashboardState, 'state' | 'design'> {
  return {
    design: { modules } as DashboardState['design'],
    state: { pipeline: { consecutiveFailures: 0 }, plans: {}, features: {}, ownerRequests: {}, modules: {}, actions: {}, ...state } as State,
  };
}

/** A module like the one that asked for the order: a teardown plan behind a gate, on a plan whose post-deploy checks failed. */
const teardown: ModuleDesign = {
  id: 'web',
  plans: [
    plan('P1', [], [feature('F01')]),
    plan('P2', ['P1'], [feature('F04')]),
    plan('P3', ['P1'], [feature('F07', { checks: [{ id: 'F07-plan', phase: 'pre-merge', needs: [] }, { id: 'F07-deploy', phase: 'post-deploy', needs: ['aws'] }] })]),
    plan('P4', ['P1'], [feature('F08')]),
    plan('P5', ['P2', 'P3', 'P4'], [feature('F10', { gates: ['G2'] })]),
  ],
  actions: [
    action('G1', 'gate', { blocks: ['P2', 'P3', 'P4'] }),
    action('G2', 'gate', { when: "after P3's deploy, once its post-deploy checks passed" }),
  ],
};
const plansOf = (p3: PlanState['status']): State['plans'] => ({
  'web/P1': built('web', 'P1', 'completed'),
  'web/P2': built('web', 'P2', 'completed'),
  'web/P3': built('web', 'P3', p3),
  'web/P4': built('web', 'P4', 'completed'),
  'web/P5': built('web', 'P5', 'active'),
});

describe('a module', () => {
  it('is complete once every plan the design has for it is, and not before it has one', () => {
    assert.equal(moduleCompleted(teardown, { plans: plansOf('completed') }), false, 'P5 is still being built');
    const all = { ...plansOf('completed'), 'web/P5': built('web', 'P5', 'completed') };
    assert.equal(moduleCompleted(teardown, { plans: all }), true);
    assert.equal(moduleCompleted(teardown, { plans: { ...all, 'web/P3': built('web', 'P3', 'verify_failed') } }), false);
    // A design change that adds a plan gives it one to build again.
    assert.equal(moduleCompleted({ ...teardown, plans: [...teardown.plans, plan('P6', ['P5'], [feature('F11')])] }, { plans: all }), false);
    // Designed and not started, without a plan yet, or not designed at all.
    assert.equal(moduleCompleted(teardown, { plans: {} }), false);
    assert.equal(moduleCompleted({ id: 'web', plans: [] }, { plans: all }), false);
    assert.equal(moduleCompleted(undefined, { plans: all }), false);
  });
});

describe('needs you', () => {
  it('lists what waits for the owner in the order to handle it: what changes the work first, what starts new work last', () => {
    const modules: ModuleDesign[] = [{
      id: 'web',
      plans: [plan('P1', [], [feature('F01')]), plan('P2', [], [feature('F02')]), plan('P3', ['P2'], [feature('F03')])],
      // The gate comes first in the file, and its work builds on a plan that isn't merged: the task goes before it.
      actions: [action('G1', 'gate', { blocks: ['P3'] }), action('T1', 'task'), action('T2', 'task')],
    }];
    const needs = listNeeds(data(modules, {
      pipeline: { consecutiveFailures: 3, paused: { reason: 'three attempts failed in a row', since: '2026-11-10T08:00:00.000Z' } },
      modules: {
        web: architect('web', 'in_review', {
          frozenCommit: 'c0ffee',
          design: { head: 'd', suspect: [], summary: 'A new plan.', pr: { number: 8, url: 'https://github.com/acme/toy/pull/8' } },
          locked: { head: 'l', summary: 'A fixed check.', changes: [], pr: { number: 7, url: 'https://github.com/acme/toy/pull/7' } },
          escalations: [
            { id: 'e1', question: 'Decided already.', askedAt: '2026-11-10T08:00:00.000Z', decision: 'no' },
            { id: 'e2', question: 'Should F02 change?', askedAt: '2026-11-10T09:00:00.000Z' },
          ],
        }),
        api: architect('api', 'proposed', { proposals: [{ version: 2, sha256: 'x', submittedAt: '2026-11-10T09:00:00.000Z' }] }),
      },
      ownerRequests: {
        r1: { requestId: 'r1', module: 'web', question: 'A comma or none?', blocking: false, askedAt: '2026-11-10T09:00:00.000Z' },
        r2: { requestId: 'r2', module: 'web', question: 'Answered.', blocking: true, askedAt: '2026-11-10T09:30:00.000Z', answer: 'yes' },
        r3: { requestId: 'r3', module: 'web', question: 'Which region?', blocking: true, askedAt: '2026-11-10T10:00:00.000Z' },
        r4: { requestId: 'r4', module: 'web', question: 'Older, and it holds nothing back.', blocking: false, askedAt: '2026-11-10T08:00:00.000Z' },
      },
      plans: {
        // Started out of the design's order, as Swarm may: the cards follow the design.
        'web/P2': built('web', 'P2', 'ready_to_merge', { pr: { number: 4, url: 'https://github.com/acme/toy/pull/4' } }),
        'web/P1': built('web', 'P1', 'pr_open', { pr: { number: 3, url: 'https://github.com/acme/toy/pull/3' }, leftToOwner: { head: 'b', reason: 'an INFRA plan', at: '2026-11-10T09:00:00.000Z' } }),
      },
      features: {
        // Out of attempts in a module with an Architect: its Manager takes it there, and the owner has no card for it.
        'web/P2/F02': { module: 'web', plan: 'P2', feature: 'F02', status: 'escalated', attempts: [] } as unknown as State['features'][string],
        // In a module designed by hand, with no Architect, the owner decides.
        'ops/P1/F09': { module: 'ops', plan: 'P1', feature: 'F09', status: 'escalated', attempts: [] } as unknown as State['features'][string],
      },
      actions: { 'web/T2': { status: 'done', at: '2026-11-10T09:00:00.000Z' } },
    }));
    assert.deepEqual(needs.map((n) => n.key), [
      'paused',
      'locked:web', 'design:web', 'escalation:e2', 'proposal:api',
      'request:r3', 'request:r4', 'request:r1',
      'left:web/P1', 'merge:web/P2',
      'escalated:ops/P1/F09',
      'action:web/T1', 'action:web/G1',
    ]);
  });

  it("says what a gate holds back and what that work builds on, until it is complete", () => {
    const gate = (needs: Need[], id: string) => needs.find((n): n is Extract<Need, { kind: 'action' }> => n.kind === 'action' && n.action.id === id)!;

    // P5 can start, since P3 is merged: only G2 holds F10 back, and P3's post-deploy checks failed.
    const failed = listNeeds(data([teardown], { plans: plansOf('verify_failed'), actions: { 'web/G1': { status: 'done', at: '2026-11-09T21:00:00.000Z' } } }));
    const g2 = gate(failed, 'G2');
    assert.deepEqual(g2.holds, ['P5/F10']);
    assert.deepEqual(g2.waits, [{ plan: 'P3', status: 'verify_failed', failed: true, holds: ['P5'] }]);
    assert.equal(waitText(g2.waits[0]!), 'P5 builds on P3, whose post-deploy checks failed. Marking this done lets P5 start all the same.');

    // Checked again and passed: nothing more to say, and the gate is what the work waits for.
    assert.deepEqual(gate(listNeeds(data([teardown], { plans: plansOf('completed') })), 'G2').waits, []);
    assert.equal(waitText({ plan: 'P3', status: 'verifying', failed: false, holds: ['P5'] }), 'P5 builds on P3, whose post-deploy checks are running.');

    // Before anything is merged: several plans held back on one that is being built, and one that hasn't started.
    const early = listNeeds(data([teardown], { plans: { 'web/P1': built('web', 'P1', 'active') } }));
    assert.deepEqual(gate(early, 'G1').waits, [{ plan: 'P1', status: 'active', failed: false, holds: ['P2', 'P3', 'P4'] }]);
    assert.equal(waitText(gate(early, 'G1').waits[0]!), 'P2, P3 and P4 build on P1, which is being built.');
    assert.deepEqual(gate(early, 'G2').waits.map((w) => `${w.plan} ${w.status}`), ['P2 waiting', 'P3 waiting', 'P4 waiting']);
  });

  it("reads a gate's work from what it blocks and from the features that name it; a task holds nothing back", () => {
    const module: ModuleDesign = {
      id: 'web',
      plans: [
        plan('P1', [], [feature('F01')]),
        plan('P2', [], [feature('F02'), feature('F03', { dependsOn: ['F02', 'P1/F01'], gates: ['G1', 'G2'] })]),
      ],
      actions: [action('G1', 'gate', { blocks: ['P2'] }), action('G2', 'gate'), action('T1', 'task')],
    };
    const [g1, g2, t1] = module.actions as [ModuleDesign['actions'][number], ModuleDesign['actions'][number], ModuleDesign['actions'][number]];
    // A feature of a plan held back whole isn't said twice.
    assert.deepEqual(heldBack(module, g1), ['P2']);
    assert.deepEqual(heldBack(module, g2), ['P2/F03']);
    assert.deepEqual(heldBack(module, t1), []);
    // P2 depends on no plan, but its F03 on a feature of P1: P1 is what it builds on.
    assert.deepEqual(upstream(module, { plans: { 'web/P1': built('web', 'P1', 'deploying') } }, ['P2/F03']), [{ plan: 'P1', status: 'deploying', failed: false, holds: ['P2'] }]);
    // A fix round counts as a failure only after the merge: before it, CI or a reviewer asked for it, and nothing builds on the plan yet.
    assert.deepEqual(upstream(module, { plans: { 'web/P1': built('web', 'P1', 'fixing') } }, ['P2/F03']).map((w) => w.failed), [false]);
    assert.deepEqual(upstream(module, { plans: { 'web/P1': built('web', 'P1', 'fixing', { mergeCommit: 'm' }) } }, ['P2/F03']).map((w) => w.failed), [true]);
    assert.deepEqual(upstream(module, { plans: { 'web/P1': built('web', 'P1', 'completed') } }, ['P2']), []);
  });

  it('names the plans whose failed post-deploy checks a change to locked files touches', () => {
    const locked = (checks: string[]): Partial<State> => ({
      modules: {
        web: architect('web', 'frozen', {
          frozenCommit: 'c0ffee',
          locked: {
            head: 'l', summary: 'A fixed check.', pr: { number: 7, url: 'https://github.com/acme/toy/pull/7' },
            changes: [{ plan: 'P3', feature: 'F07', title: 'The function', expected: 'It ran.', fields: [], checks, scripts: [] }],
          },
        }),
      },
    });
    const rechecks = (state: Partial<State>) => {
      const need = listNeeds(data([teardown], state)).find((n) => n.kind === 'locked');
      return need?.kind === 'locked' ? need.rechecks : undefined;
    };
    assert.deepEqual(rechecks({ ...locked(['F07-deploy']), plans: plansOf('verify_failed') }), ['P3']);
    assert.deepEqual(rechecks({ ...locked(['F07-deploy (removed)']), plans: plansOf('verify_failed') }), ['P3']);
    // A pre-merge check alone leaves the plan's post-deploy checks as they failed; a check it adds isn't on main yet.
    assert.deepEqual(rechecks({ ...locked(['F07-plan', 'F07-smoke (added)']), plans: plansOf('verify_failed') }), []);
    assert.deepEqual(rechecks({ ...locked(['F07-deploy']), plans: plansOf('completed') }), []);
  });

  it("shows the Manager's order while the cards are as it saw them, less the ones handled since", () => {
    const question = { requestId: 'r1', module: 'web', question: 'Commit the fix by hand?', blocking: false, askedAt: '2026-11-10T10:49:00.000Z' };
    const state = (p3: PlanState['status'], more: Partial<State> = {}): Partial<State> => ({
      plans: plansOf(p3), actions: { 'web/G1': { status: 'done', at: '2026-11-09T21:00:00.000Z' } }, ownerRequests: { r1: question },
      modules: { web: architect('web', 'frozen', { frozenCommit: 'c0ffee', locked: { head: 'l1', summary: 'A fixed check.', changes: [{ plan: 'P3', feature: 'F07', title: 'The function', expected: 'It ran.', fields: [], checks: ['F07-deploy'], scripts: [] }], pr: { number: 7, url: 'https://github.com/acme/toy/pull/7' } } }) },
      ...more,
    });
    const before = listNeeds(data([teardown], state('verify_failed')));
    assert.deepEqual(before.map((n) => n.key), ['locked:web', 'request:r1', 'action:web/G2']);
    assert.deepEqual(before.map(needTitle), ['[CHANGED_LOCKED_FILES] The Architect of web asks to change locked files', 'The Manager of web asks you', 'Gate web/G2: G2']);
    const asked: OrderState = { requestId: 'o1', module: 'web', manager: 'web', askedAt: '2026-11-11T13:00:00.000Z', cards: orderCards(before) };

    // Not asked, then asked and no answer yet: the standard order.
    assert.deepEqual(orderNeeds(before, undefined), { needs: before, by: 'standard', why: {}, waiting: false });
    assert.deepEqual(orderNeeds(before, asked), { needs: before, by: 'standard', why: {}, waiting: true });

    // Its answer: the gate last and the question after the pull request, with a card it left out put last by the daemon.
    const given: OrderState = {
      ...asked,
      suggestion: { at: '2026-11-11T13:01:00.000Z', call: 'c1', order: [{ key: 'locked:web', why: 'It fixes the check P3 failed.' }, { key: 'action:web/G2', why: 'Only once P3 is complete.' }, { key: 'request:r1', why: '' }] },
    };
    const ordered = orderNeeds(before, given);
    assert.equal(ordered.by, 'manager');
    assert.deepEqual(ordered.needs.map((n) => n.key), ['locked:web', 'action:web/G2', 'request:r1']);
    assert.deepEqual(ordered.why, { 'locked:web': 'It fixes the check P3 failed.', 'action:web/G2': 'Only once P3 is complete.', 'request:r1': '' });

    // The question answered: the rest keeps the Manager's order.
    const answered = listNeeds(data([teardown], state('verify_failed', { ownerRequests: { r1: { ...question, answer: 'no' } } })));
    assert.deepEqual(orderNeeds(answered, given).needs.map((n) => n.key), ['locked:web', 'action:web/G2']);
    assert.equal(orderNeeds(answered, given).by, 'manager');

    // The pull request merged and P3 checked again: the gate isn't the card the Manager saw.
    const rechecking = listNeeds(data([teardown], state('verifying', { modules: { web: architect('web', 'frozen', { frozenCommit: 'c0ffee' }) } })));
    assert.notEqual(needPrint(rechecking.at(-1)!), needPrint(before.at(-1)!));
    assert.deepEqual(orderNeeds(rechecking, given), {
      needs: rechecking, by: 'standard', why: {}, waiting: false, outdated: { added: [], changed: ['Gate web/G2: G2'] },
    });
    // A new commit on the pull request, and a card that came since.
    const pushed = listNeeds(data([teardown], state('verify_failed', {
      pipeline: { consecutiveFailures: 0, paused: { reason: 'the owner paused the pipeline', since: '2026-11-11T13:05:00.000Z' } },
      modules: { web: architect('web', 'frozen', { frozenCommit: 'c0ffee', locked: { head: 'l2', summary: 'A fixed check.', changes: [], pr: { number: 7, url: 'https://github.com/acme/toy/pull/7' } } }) },
    })));
    assert.deepEqual(orderNeeds(pushed, given).outdated, { added: ['The pipeline is paused'], changed: ['[CHANGED_LOCKED_FILES] The Architect of web asks to change locked files'] });

    // Every card of the request handled: nothing is left of it, whatever waits now.
    const later = listNeeds(data([teardown], { plans: plansOf('completed'), actions: { 'web/G1': { status: 'done', at: '2026-11-09T21:00:00.000Z' }, 'web/G2': { status: 'done', at: '2026-11-11T14:00:00.000Z' } }, pipeline: { consecutiveFailures: 0, paused: { reason: 'the owner paused the pipeline', since: '2026-11-11T14:05:00.000Z' } } }));
    assert.deepEqual(orderNeeds(later, given), { needs: later, by: 'standard', why: {}, waiting: false });
  });
});

describe('notifications', () => {
  const paused = (reason: string): Need => ({ kind: 'paused', key: 'paused', paused: { reason, since: '2026-11-12T10:00:00.000Z' } });
  const request = (id: string): Need => ({ kind: 'request', key: `request:${id}`, request: { requestId: id, module: 'web', question: 'Which region?', blocking: false, askedAt: '2026-11-12T10:00:00.000Z' } });
  const keys = (needs: Need[]) => needs.map((need) => need.key);

  it('announces a card that arrives, and neither what waited when the page loaded nor one that stays', () => {
    const first = arrivals([request('r1')], undefined, 0);
    assert.deepEqual(keys(first.fresh), [], 'what already waits is not news');
    const second = arrivals([request('r1'), request('r2')], first.told, 60_000);
    assert.deepEqual(keys(second.fresh), ['request:r2']);
    const third = arrivals([request('r1'), request('r2')], second.told, 120_000);
    assert.deepEqual(keys(third.fresh), []);
  });

  it("announces once an hour at most a card that goes and comes back, as the pause that waits to look again does every ten minutes", () => {
    let told = arrivals([], undefined, 0).told;
    const announced: number[] = [];
    // The card comes, lifts ten minutes later, and comes back at once, for two hours.
    for (let minute = 0; minute <= 120; minute += 10) {
      const now = minute * 60_000;
      const there = arrivals([paused('GitHub does not answer')], told, now);
      if (there.fresh.length > 0) announced.push(minute);
      told = arrivals([], there.told, now + 1_000).told;
    }
    assert.deepEqual(announced, [0, 60, 120]);
    assert.equal(QUIET_MS, 60 * 60_000);
  });
});
