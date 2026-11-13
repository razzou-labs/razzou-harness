import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { clock, tone } from '../dashboard/src/format.ts';

describe("the dashboard's words", () => {
  it("colors a reviewer's verdicts, pass and block, apart", () => {
    assert.equal(tone('pass'), 'ok');
    assert.equal(tone('block'), 'bad');
    assert.equal(tone('blocked'), 'warn');
  });

  it('gives a time today alone, and the day with a time on another day', () => {
    const now = new Date(2026, 10, 13, 15, 0, 0).getTime();
    assert.equal(clock(new Date(2026, 10, 13, 9, 1, 0).toISOString(), now), new Date(2026, 10, 13, 9, 1, 0).toLocaleTimeString());
    const reset = clock(new Date(2026, 10, 17, 9, 1, 0).toISOString(), now);
    assert.notEqual(reset, new Date(2026, 10, 17, 9, 1, 0).toLocaleTimeString());
    assert.match(reset, /17/);
  });
});
