import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { run } from '../src/util.ts';

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
