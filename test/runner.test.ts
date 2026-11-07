import { strict as assert } from 'node:assert';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runChecks } from '../src/checks/runner.ts';
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
