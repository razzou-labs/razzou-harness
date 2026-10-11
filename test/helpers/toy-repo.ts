import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runOk } from '../../src/util.ts';

export const SOLUTIONS = {
  F01: { 'src/greet.sh': 'echo hello\n' },
  F02: { 'src/add.sh': 'echo $(( $1 + $2 ))\n' },
};

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `harness-test-${prefix}-`));
}

/** The toy plan of a module: two features whose checks are plain bash. */
export function toyDesign(module: string): Record<string, string> {
  return {
    [`harness/modules/${module}/plans/P1.json`]: JSON.stringify({
      id: 'P1',
      module,
      title: 'Greeting and adding',
      goal: 'Two tiny scripts.',
      features: [
        {
          id: 'F01',
          title: 'Greet',
          description: 'src/greet.sh prints hello.',
          expected: '`bash src/greet.sh` prints hello.',
          checks: [{ id: 'F01-greet', run: `bash harness/modules/${module}/checks/F01.sh`, phase: 'pre-merge', timeoutSec: 30 }],
        },
        {
          id: 'F02',
          title: 'Add',
          description: 'src/add.sh prints the sum of its two arguments.',
          expected: '`bash src/add.sh 2 3` prints 5.',
          dependsOn: ['F01'],
          checks: [{ id: 'F02-add', run: `bash harness/modules/${module}/checks/F02.sh`, phase: 'pre-merge', timeoutSec: 30 }],
        },
      ],
    }, null, 2),
    [`harness/modules/${module}/checks/F01.sh`]: 'test "$(bash src/greet.sh)" = hello\n',
    [`harness/modules/${module}/checks/F02.sh`]: 'test "$(bash src/add.sh 2 3)" = 5\n',
  };
}

/** A small project; by default with the toy plan as module "demo", or with no design at all. */
export async function createToyRepo(dir: string, configOverrides: Record<string, unknown> = {}, options: { design?: boolean } = {}): Promise<void> {
  const files: Record<string, string> = {
    'README.md': '# toy\n',
    'harness/config.json': JSON.stringify({
      harnessVersion: '0.1.0',
      project: { name: 'toy' },
      roles: { developer: { maxAttempts: 2, attemptTimeoutMinutes: 5 } },
      sandbox: { image: 'test-image' },
      network: { bundles: ['core'] },
      brakes: { consecutiveFailures: 3 },
      ...configOverrides,
    }, null, 2),
    ...(options.design === false ? {} : toyDesign('demo')),
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  await runOk('git', ['init', '--quiet', '--initial-branch=main', dir]);
  await runOk('git', ['-C', dir, 'add', '-A']);
  await runOk('git', ['-C', dir, '-c', 'user.name=owner', '-c', 'user.email=owner@test.invalid', 'commit', '--quiet', '-m', 'design']);
}
