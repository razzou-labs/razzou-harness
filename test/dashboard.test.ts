import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { tone } from '../dashboard/src/format.ts';

describe("the dashboard's words", () => {
  it("colors a reviewer's verdicts, pass and block, apart", () => {
    assert.equal(tone('pass'), 'ok');
    assert.equal(tone('block'), 'bad');
    assert.equal(tone('blocked'), 'warn');
  });
});
