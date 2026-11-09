import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { copiesSelection, type Key } from '../dashboard/src/keys.ts';

const C = 67;
const V = 86;
const key = (keyCode: number, held: Partial<Omit<Key, 'keyCode'>> = {}): Key => ({ keyCode, ctrlKey: false, altKey: false, metaKey: false, ...held });

describe("a dashboard terminal's copy keys", () => {
  it('copies the selection with Ctrl+C, and with Ctrl+Shift+C, whose event carries the same key code', () => {
    assert.equal(copiesSelection(key(C, { ctrlKey: true }), true, false), true);
  });

  it('leaves Ctrl+C to the program when nothing is selected, so it still interrupts', () => {
    assert.equal(copiesSelection(key(C, { ctrlKey: true }), false, false), false);
  });

  it('leaves other keys to the program, Ctrl+V, Ctrl+Alt+C and a plain C among them', () => {
    assert.equal(copiesSelection(key(V, { ctrlKey: true }), true, false), false);
    assert.equal(copiesSelection(key(C, { ctrlKey: true, altKey: true }), true, false), false);
    assert.equal(copiesSelection(key(C), true, false), false);
  });

  it('changes nothing on a Mac, where Cmd+C copies already and Ctrl+C is the program\'s', () => {
    assert.equal(copiesSelection(key(C, { ctrlKey: true }), true, true), false);
    assert.equal(copiesSelection(key(C, { metaKey: true }), true, true), false);
  });
});
