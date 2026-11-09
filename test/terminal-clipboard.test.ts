import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { copiedText, copiesSelection, type Key } from '../dashboard/src/clipboard.ts';

const C = 67;
const V = 86;
const key = (keyCode: number, held: Partial<Omit<Key, 'keyCode'>> = {}): Key => ({ keyCode, ctrlKey: false, altKey: false, metaKey: false, ...held });
const base64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

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

describe('what a program copies with OSC 52', () => {
  it('is the UTF-8 text its base64 payload holds, as Claude Code sends it for a selection', () => {
    assert.equal(copiedText(`c;${base64('G1 asks for lambda:GetFunction — on people-*')}`), 'G1 asks for lambda:GetFunction — on people-*');
  });

  it('reads the payload after the targets, which may be empty', () => {
    assert.equal(copiedText(`;${base64('hi')}`), 'hi');
    assert.equal(copiedText(`s0;${base64('line one\nline two')}`), 'line one\nline two');
  });

  it("is nothing for a query, so no program learns what the owner's clipboard holds", () => {
    assert.equal(copiedText('c;?'), undefined);
  });

  it('is nothing for an empty payload, which would clear the clipboard, or one that is not base64 of UTF-8 text', () => {
    assert.equal(copiedText('c;'), undefined);
    assert.equal(copiedText('c;not base64!'), undefined);
    assert.equal(copiedText(`c;${Buffer.from([0xff, 0xfe]).toString('base64')}`), undefined);
  });
});
