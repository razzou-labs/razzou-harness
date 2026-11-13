import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { describeOwnerTime, moduleOwnerTime, ownerTimeProblems } from '../src/design/owner-time.ts';
import { ConfigSchema, type ModuleDesign, type OwnerAction } from '../src/design/schemas.ts';
import { initialState, type State } from '../src/state/state.ts';

const config = ConfigSchema.parse({ harnessVersion: '0.1.0', project: { name: 'toy' } });

function action(id: string, estimatedMinutes?: number): OwnerAction {
  return { id, kind: 'task', title: id, when: 'anytime', blocks: [], instructions: 'Do it.', verify: null, ...(estimatedMinutes === undefined ? {} : { estimatedMinutes }) };
}

function module(id: string, actions: OwnerAction[]): ModuleDesign {
  return { id, plans: [], actions };
}

/** A project in which the owner set hours for some modules. */
function state(hours: Record<string, number> = {}): State {
  const s = initialState();
  for (const [id, h] of Object.entries(hours)) s.ownerHours[id] = { hours: h, setAt: 't' };
  return s;
}

describe("the owner's time", () => {
  const shop = module('shop', [action('T1', 60), action('T2', 30)]);
  const billing = module('billing', [action('G1', 90)]);

  it('asks nothing of a module the owner set no hours for', () => {
    const time = moduleOwnerTime(config, module('shop', [action('T1')]), state());
    assert.equal(time.hours, undefined);
    assert.deepEqual(ownerTimeProblems(time), []);
    assert.match(describeOwnerTime(time), /^The owner set no hours for shop: estimatedMinutes on owner actions is welcome, not required\.$/);
  });

  it("gives each module its own hours: what another module plans takes nothing from them", () => {
    const s = state({ shop: 2, billing: 10 });
    const [mine, other] = [moduleOwnerTime(config, shop, s), moduleOwnerTime(config, billing, s)];
    // Two hours, a 20% reserve: shop may plan 1.6 h, whatever billing plans of its own ten.
    assert.deepEqual([mine.hours, mine.plannableHours, mine.plannedMinutes], [2, 1.6, 90]);
    assert.deepEqual([other.hours, other.plannableHours, other.plannedMinutes], [10, 8, 90]);
    assert.deepEqual(ownerTimeProblems(mine), []);
    assert.match(describeOwnerTime(mine), /^The owner set 2 h of their time for shop, this module alone: what other modules plan takes nothing from it\. A 20% reserve \(0\.4 h\) stays out of the design/);
    assert.match(describeOwnerTime(mine), /Your design may plan 1\.6 h in owner actions; it plans 1\.5 h on main now\./);
    // A module with hours beside one without: only the first is held to anything.
    assert.equal(moduleOwnerTime(config, billing, state({ shop: 2 })).hours, undefined);
  });

  it('refuses a design with an unestimated action, or one over what the module may plan', () => {
    const s = state({ billing: 8 });
    assert.deepEqual(ownerTimeProblems(moduleOwnerTime(config, module('billing', [action('G1'), action('G2', 5)]), s)), [
      'owner-actions.json: G1 needs estimatedMinutes, how long it takes the owner: their time for this module is set (get_owner_time)',
    ]);
    const over = ownerTimeProblems(moduleOwnerTime(config, module('billing', [action('G1', 400)]), s));
    assert.equal(over.length, 1);
    assert.match(over[0]!, /^the design takes 6\.67 h of the owner's time in owner actions, but this module may plan 6\.4 h: 8 h set by the owner, minus the 20% reserve\./);
    assert.deepEqual(ownerTimeProblems(moduleOwnerTime(config, module('billing', [action('G1', 384)]), s)), []);
    // A design that asks nothing of the owner always fits.
    assert.deepEqual(ownerTimeProblems(moduleOwnerTime(config, module('billing', []), state({ billing: 0.1 }))), []);
  });

  it('keeps the time of an action done after a redesign dropped it, and counts it against what may still be planned', () => {
    const s = state({ shop: 10 });
    s.actions['shop/T1'] = { status: 'done', at: 't', minutes: 60 };
    s.actions['shop/T9'] = { status: 'done', at: 't', minutes: 240 };
    s.actions['shop/T8'] = { status: 'verifying', at: 't', minutes: 20 };
    // T9 left the design of shop, and T8 was never done: T1 counts its current estimate, T9 the one it had.
    const time = moduleOwnerTime(config, shop, s);
    assert.deepEqual([time.usedMinutes, time.droppedMinutes], [300, 240]);
    assert.equal(moduleOwnerTime(config, billing, s).usedMinutes, 0, "billing doesn't take shop's actions");
    // Ten hours, eight plannable, four already spent on T9: a redesign may plan four more, not eight.
    assert.deepEqual(ownerTimeProblems(moduleOwnerTime(config, module('shop', [action('T1', 60), action('T2', 180)]), s)), []);
    const over = ownerTimeProblems(moduleOwnerTime(config, module('shop', [action('T1', 60), action('T2', 240)]), s));
    assert.match(over[0]!, /^the design takes 5 h of the owner's time in owner actions, after 4 h of actions already done that it drops, but this module may plan 8 h/);
    assert.match(describeOwnerTime(time), /Your design may plan 4 h in owner actions \(4 h went to actions done and since dropped\)/);
  });
});
