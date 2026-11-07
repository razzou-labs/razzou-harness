import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { availableHours, describeOwnerTime, moduleOwnerTime, ownerTime, ownerTimeProblems } from '../src/design/owner-time.ts';
import { ConfigSchema, type Design, type ModuleDesign, type OwnerAction } from '../src/design/schemas.ts';
import { initialState, type State } from '../src/state/state.ts';

const config = ConfigSchema.parse({ harnessVersion: '0.1.0', project: { name: 'toy' } });

function action(id: string, estimatedMinutes?: number): OwnerAction {
  return { id, kind: 'task', title: id, when: 'anytime', blocks: [], instructions: 'Do it.', verify: null, ...(estimatedMinutes === undefined ? {} : { estimatedMinutes }) };
}

function module(id: string, actions: OwnerAction[]): ModuleDesign {
  return { id, plans: [], actions };
}

/** A project with the owner's hours set, and `shop` designed by hand on main. */
function state(hours?: number): State {
  const s = initialState();
  if (hours !== undefined) s.budgets.ownerHours = hours;
  return s;
}

describe('the owner\'s time', () => {
  const design: Design = { config, modules: [module('shop', [action('T1', 60), action('T2', 30)]), module('billing', [action('G1', 90)])] };

  it('is unconstrained until the owner sets their hours', () => {
    assert.equal(ownerTime(config, design, state()), undefined);
    assert.deepEqual(ownerTimeProblems(undefined, moduleOwnerTime(module('shop', [action('T1')]), state())), []);
    assert.match(describeOwnerTime(undefined, 'shop'), /hasn't set a time budget/);
  });

  it('keeps a reserve, counts the owner actions of committed designs, and reports what a module may plan', () => {
    const s = state(10);
    // shop's design is on main (no module state): committed. billing is still being designed: not committed.
    s.modules.billing = { module: 'billing', title: 'Billing', status: 'decomposing', architect: { sandbox: 'arch-billing', sessionId: 's', status: 'running' }, proposals: [{ version: 1, sha256: 'x', submittedAt: 't', acceptedAt: 't' }], accepted: 1, notes: [], escalations: [] };
    s.actions['shop/T1'] = { status: 'done', at: 't' };
    const time = ownerTime(config, design, s)!;
    assert.equal(time.plannableHours, 8);
    assert.equal(time.committedHours, 1.5);
    // T1 is done: 1 h. The accepted proposal of billing counts for nothing: only owner actions do.
    assert.equal(time.usedHours, 1);
    assert.deepEqual(time.modules.map((m) => [m.module, m.committed, m.plannedMinutes]), [['shop', true, 90], ['billing', false, 90]]);
    assert.equal(availableHours(time, 'billing'), 6.5);
    // A module's own commitment doesn't count against it: a design change replaces it.
    assert.equal(availableHours(time, 'shop'), 8);
    assert.match(describeOwnerTime(time, 'billing'), /Other modules committed 1\.5 h\. Available to billing: 6\.5 h\./);
    assert.match(describeOwnerTime(time, 'billing'), /Only owner actions count: give every gate and task an estimatedMinutes/);
  });

  it('refuses a design with an unestimated action, or one over what is available', () => {
    const s = state(10);
    const time = ownerTime(config, design, s)!;
    assert.deepEqual(ownerTimeProblems(time, moduleOwnerTime(module('billing', [action('G1'), action('G2', 5)]), s)), [
      'owner-actions.json: G1 needs estimatedMinutes, how long it takes the owner: their time is budgeted (get_owner_time)',
    ]);
    const over = ownerTimeProblems(time, moduleOwnerTime(module('billing', [action('G1', 400)]), s));
    assert.equal(over.length, 1);
    assert.match(over[0]!, /^the design takes 6\.67 h of the owner's time in owner actions, but 6\.5 h are available: 10 h for the project, minus the 20% reserve/);
    assert.deepEqual(ownerTimeProblems(time, moduleOwnerTime(module('billing', [action('G1', 390)]), s)), []);
  });

  it('lets a design without owner actions through, even once others committed more than is plannable', () => {
    const s = state(1);
    const time = ownerTime(config, design, s)!;
    // shop committed 1.5 h of the 0.8 h plannable: billing has -0.7 h.
    assert.equal(availableHours(time, 'billing'), -0.7);
    assert.deepEqual(ownerTimeProblems(time, moduleOwnerTime(module('billing', []), s)), []);
    assert.equal(ownerTimeProblems(time, moduleOwnerTime(module('billing', [action('G1', 5)]), s)).length, 1);
  });

  it('keeps the time of an action done, after a redesign dropped it', () => {
    const s = state(10);
    s.actions['shop/T1'] = { status: 'done', at: 't', minutes: 60 };
    s.actions['shop/T9'] = { status: 'done', at: 't', minutes: 45 };
    s.actions['shop/T8'] = { status: 'verifying', at: 't', minutes: 20 };
    // T9 left the design of shop, and T8 was never done: T1 counts its current estimate, T9 the one it had.
    assert.equal(moduleOwnerTime(design.modules[0]!, s).usedMinutes, 105);
    assert.equal(moduleOwnerTime(design.modules[1]!, s).usedMinutes, 0, "billing doesn't take shop's actions");
    assert.equal(ownerTime(config, design, s)!.usedHours, 1.75);
  });
});
