import { strict as assert } from 'node:assert';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runChecks, runGuarded } from '../src/checks/runner.ts';
import { LocalDriver } from './helpers/local-driver.ts';
import { tempDir } from './helpers/toy-repo.ts';

describe('the Terraform plan of the checks', () => {
  it('fails with terraform\'s error when the plan can\'t be shown as JSON, and the checks on it are not run', async () => {
    const bin = tempDir('bin');
    writeFileSync(join(bin, 'terraform'), [
      '#!/bin/bash',
      'case "$1" in',
      '  init) echo initialized ;;',
      '  plan) for a in "$@"; do case "$a" in -out=*) echo binary > "${a#-out=}" ;; esac; done',
      '        echo "Plan: 1 to add, 0 to change, 0 to destroy." ;;',
      '  show) echo "Error: Failed to read the given file as a state or plan file" >&2; exit 1 ;;',
      'esac',
      '',
    ].join('\n'));
    chmodSync(join(bin, 'terraform'), 0o755);
    const driver = new LocalDriver(tempDir('sandboxes'));
    await driver.create({ name: 'chk-show', image: 'x', providers: [], env: { PATH: `${bin}:${process.env.PATH}` } });
    mkdirSync(join(driver.rootOf('chk-show'), 'work', 'iac'), { recursive: true });
    const checks = [{ id: 'F01-plan', run: 'test -s "$HARNESS_PLAN_JSON"', phase: 'pre-merge' as const, needs: ['tfplan' as const], timeoutSec: 30 }];
    const results = await runChecks(driver, 'chk-show', join(driver.rootOf('chk-show'), 'work'), checks, {
      terraform: { dir: 'iac', backendConfig: 'backend-configs/staging.hcl', varFile: 'env/staging.tfvars' },
      scratchDir: join(driver.rootOf('chk-show'), '.harness'),
    });
    assert.deepEqual(results.map((r) => [r.id, r.exit]), [['terraform-plan', 1], ['F01-plan', 1]]);
    assert.match(results[0]!.output, /Failed to read the given file as a state or plan file/);
    assert.match(results[1]!.output, /^not run: the Terraform plan failed/);
    await driver.removeAll();
  });
});

describe('the tripwire of the checks', () => {
  /** A sandbox with a checkout of `files`, and the tree they came from. */
  async function sandbox(name: string, files: Record<string, string>) {
    const driver = new LocalDriver(tempDir('sandboxes'));
    await driver.create({ name, image: 'x', providers: [], env: { PATH: process.env.PATH! } });
    const work = join(driver.rootOf(name), 'work');
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(work, path, '..'), { recursive: true });
      writeFileSync(join(work, path), content);
    }
    // The commit under test, as the daemon reads it: here, the checkout before anything ran.
    const contents = new Map(Object.entries(files));
    const guard = { read: async (path: string) => contents.get(path), list: async () => [...contents.keys()] };
    return { driver, work, guard };
  }
  const check = (id: string, run: string) => ({ id, run, phase: 'pre-merge' as const, needs: [], timeoutSec: 30 });
  const files = {
    'harness/config.json': JSON.stringify({ project: { name: 'x' } }),
    'harness/modules/m/checks/F01.sh': 'exit 1\n',
    'package.json': JSON.stringify({ name: 'x', scripts: { prepare: 'node p.js' } }, null, 2),
    'pyproject.toml': '[tool.pytest.ini_options]\naddopts = "-q"\n',
  };

  it('fails the run once init.sh or a check changes, adds or removes a protected file, and runs no check after', async () => {
    const init = await sandbox('chk-init', { ...files, 'init.sh': 'echo "exit 0" > harness/modules/m/checks/F01.sh\n' });
    const tripped = await runGuarded(init.driver, 'chk-init', init.work, [check('F01', 'bash harness/modules/m/checks/F01.sh')], { guard: init.guard });
    assert.deepEqual(tripped.map((r) => [r.id, r.exit]), [['protected-files', 1]]);
    assert.equal(tripped[0]!.output, 'the code under test changed protected files while the checks ran: harness/modules/m/checks/F01.sh');
    await init.driver.removeAll();

    const later = await sandbox('chk-later', files);
    const checks = [check('a', 'true'), check('b', 'mkdir -p web && touch web/vitest.config.ts && rm pyproject.toml'), check('c', 'true')];
    const results = await runGuarded(later.driver, 'chk-later', later.work, checks, { guard: later.guard });
    assert.deepEqual(results.map((r) => [r.id, r.exit]), [['a', 0], ['b', 0], ['protected-files', 1]]);
    assert.match(results[2]!.output, /: pyproject\.toml, web\/vitest\.config\.ts$/);
    await later.driver.removeAll();
  });

  it("lets the checks change what isn't protected, a protected file's other fields, and what installing writes", async () => {
    const quiet = await sandbox('chk-quiet', {
      ...files,
      'init.sh': [
        'mkdir -p node_modules/a dist .venv/lib',
        'echo "{}" > node_modules/a/package.json; echo "{}" > dist/package.json; touch .venv/pyvenv.cfg .venv/lib/conftest.py',
        // Another field of package.json, and another table of pyproject.toml.
        `printf '%s' '${JSON.stringify({ name: 'y', scripts: { prepare: 'node p.js' } })}' > package.json`,
        "printf '[tool.ruff]\\nline-length = 1\\n' >> pyproject.toml",
        '',
      ].join('\n'),
    });
    const results = await runGuarded(quiet.driver, 'chk-quiet', quiet.work, [check('a', 'echo x > src.js')], { guard: quiet.guard });
    assert.deepEqual(results.map((r) => [r.id, r.exit]), [['a', 0]]);
    await quiet.driver.removeAll();
  });
});
