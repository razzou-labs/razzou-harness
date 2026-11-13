import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { noMentions, run } from '../src/util.ts';
import { settingChanges } from '../src/daemon/design.ts';

describe('canonical JSON', () => {
  it('sorts keys in the same order whatever the machine\'s locale, so hashes stay the same', async () => {
    // In Czech, "ch" is a letter of its own, after "h".
    const util = new URL('../src/util.ts', import.meta.url).href;
    const script = `const { canonicalJson } = await import(${JSON.stringify(util)}); console.log(canonicalJson({ i: 1, h: { ch: 2, cz: 3, a: 4 }, ch: 5 }));`;
    for (const locale of ['en_US.UTF-8', 'cs_CZ.UTF-8', 'C']) {
      const result = await run(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, LC_ALL: locale, LANG: locale } });
      assert.equal(result.stdout.trim(), '{"ch":5,"h":{"a":4,"ch":2,"cz":3},"i":1}', `${locale}: ${result.stderr}`);
    }
  });
});

describe('text an agent wrote, posted on GitHub', () => {
  it('mentions nobody, and leaves code and e-mail addresses as they are', () => {
    const text = '@alice, see (@acme/core) and `@types/node`:\n```\nnpm i @scope/pkg\n```\nwrite to a@b.example or @bob';
    assert.equal(noMentions(text), '@\u200balice, see (@\u200bacme/core) and `@types/node`:\n```\nnpm i @scope/pkg\n```\nwrite to a@b.example or @\u200bbob');
  });
});

describe("the settings a design changes", () => {
  it('lists each changed setting with its values, sorted, and not the version', () => {
    const before = JSON.stringify({ harnessVersion: '0.6.0', swarm: { merge: { infraMonthlyUsdCeiling: 50 } }, network: { extraHosts: [] } });
    const after = JSON.stringify({ harnessVersion: '0.7.0', swarm: { merge: { infraMonthlyUsdCeiling: 500 }, maxPlans: 3 }, network: { extraHosts: ['docs.example.com'] } });
    assert.deepEqual(settingChanges(before, after), [
      '`network.extraHosts`: `[]` → `["docs.example.com"]`',
      '`swarm.maxPlans`: unset → `3`',
      '`swarm.merge.infraMonthlyUsdCeiling`: `50` → `500`',
    ]);
    assert.deepEqual(settingChanges(before, before), []);
  });
});
