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
    assert.equal(ownerTime(config, design, state(), () => 0), undefined);
    assert.deepEqual(ownerTimeProblems(undefined, moduleOwnerTime(config, module('shop', [action('T1')]), state(), 0)), []);
    assert.match(describeOwnerTime(undefined, 'shop', 0, config), /hasn't set a time budget/);
  });

  it('keeps a reserve, counts committed designs and proposals read, and reports what a module may plan', () => {
    const s = state(10);
    // shop's design is on main (no module state): committed. billing is still being designed: not committed.
    s.modules.billing = { module: 'billing', title: 'Billing', status: 'decomposing', architect: { sandbox: 'arch-billing', sessionId: 's', status: 'running' }, proposals: [{ version: 1, sha256: 'x', submittedAt: 't', acceptedAt: 't' }], accepted: 1, notes: [], escalations: [] };
    s.actions['shop/T1'] = { status: 'done', at: 't' };
    const time = ownerTime(config, design, s, (m, v) => (m === 'billing' && v === 1 ? 500 : 0))!;
    assert.equal(time.plannableHours, 8);
    assert.equal(time.committedHours, 1.5);
    // T1 is done (1 h), and billing's accepted proposal was read (500 lines at 1000 an hour).
    assert.equal(time.usedHours, 1.5);
    assert.deepEqual(time.modules.map((m) => [m.module, m.committed, m.readingMinutes]), [['shop', true, 0], ['billing', false, 30]]);
    assert.equal(availableHours(time, 'billing'), 6.5);
    // A module's own commitment doesn't count against it: a design change replaces it.
    assert.equal(availableHours(time, 'shop'), 8);
    assert.match(describeOwnerTime(time, 'billing', 500, config), /Other modules committed 1\.5 h\. Available to billing: 6\.5 h\./);
    assert.match(describeOwnerTime(time, 'billing', 500, config), /Reading your accepted proposal takes 0\.5 h \(500 lines/);
  });

  it('refuses a design with an unestimated action, or one over what is available', () => {
    const s = state(10);
    const time = ownerTime(config, design, s, () => 0)!;
    assert.deepEqual(ownerTimeProblems(time, moduleOwnerTime(config, module('billing', [action('G1'), action('G2', 5)]), s, 0)), [
      'owner-actions.json: G1 needs estimatedMinutes, how long it takes the owner: their time is budgeted (get_owner_time)',
    ]);
    const over = ownerTimeProblems(time, moduleOwnerTime(config, module('billing', [action('G1', 400)]), s, 100));
    assert.equal(over.length, 1);
    assert.match(over[0]!, /^the design takes 6\.77 h of the owner's time \(6\.67 h of owner actions, 0\.1 h to read the proposal\), but 6\.5 h are available: 10 h for the project, minus the 20% reserve/);
    assert.deepEqual(ownerTimeProblems(time, moduleOwnerTime(config, module('billing', [action('G1', 380)]), s, 100)), []);
  });
});
