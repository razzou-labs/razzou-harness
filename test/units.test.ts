import { strict as assert } from 'node:assert';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { claudeCode, readResult, reportJsonSchema } from '../src/agents/claude-code.ts';
import { runChecks } from '../src/checks/runner.ts';
import { LocalDriver } from './helpers/local-driver.ts';
import { ConfigSchema, definitionHash, loadDesign, PlanSchema, requiredChecks } from '../src/design/schemas.ts';
import { DEVELOPER, HARNESS, Repo } from '../src/git/repo.ts';
import { checkHost } from '../src/sandbox/allowlist.ts';
import { githubRepo, init } from '../src/setup/init.ts';
import { buildPolicy } from '../src/sandbox/policy.ts';
import { EventStore } from '../src/state/events.ts';
import { activeAttempt, countedAttempts, project } from '../src/state/state.ts';
import { clip, runOk } from '../src/util.ts';
import { createToyRepo, tempDir } from './helpers/toy-repo.ts';

const ref = { module: 'demo', plan: 'P1', feature: 'F01', attempt: 1 };

describe('event store', () => {
  it('appends and reads back, and drops a torn last line', () => {
    const file = join(tempDir('events'), 'events.jsonl');
    const store = new EventStore(file);
    store.append({ type: 'PIPELINE_RESUMED', payload: {} });
    appendFileSync(file, '{"v":1,"kind":"event","type":"PIPE');
    const reopened = new EventStore(file);
    reopened.append({ type: 'PIPELINE_RESUMED', payload: {} });
    assert.equal(reopened.readAll().length, 2);
    assert.ok(readFileSync(file, 'utf8').endsWith('}\n'));
  });
});

describe('state projection', () => {
  it('follows an attempt from start to acceptance', () => {
    const store = new EventStore(join(tempDir('state'), 'events.jsonl'));
    store.append({ type: 'PLAN_STARTED', ref, payload: { branch: 'plan/demo/P1', base: 'b0' } });
    store.append({ type: 'ATTEMPT_STARTING', ref, payload: { sandbox: 's', base: 'b0', sessionId: 'x', deadline: '2030-01-01T00:00:00Z', definitionHash: 'h' } });
    store.append({ type: 'ATTEMPT_STARTED', ref, payload: {} });
    let state = project(store.readAll());
    assert.equal(activeAttempt(state)?.attempt.status, 'running');

    store.append({ type: 'ATTEMPT_ENDED', ref, payload: { outcome: 'done', summary: 'ok' } });
    store.append({ type: 'CHECKS_STARTED', ref, payload: { head: 'h1', files: ['a'] } });
    store.append({ type: 'FEATURE_ACCEPTED', ref, payload: { commit: 'c1' } });
    state = project(store.readAll());
    assert.equal(activeAttempt(state), undefined);
    assert.equal(state.features['demo/P1/F01']!.status, 'accepted');
    assert.equal(state.plans['demo/P1']!.head, 'c1');
  });

  it('counts failures against the current definition only', () => {
    const store = new EventStore(join(tempDir('state'), 'events.jsonl'));
    store.append({ type: 'PLAN_STARTED', ref, payload: { branch: 'plan/demo/P1', base: 'b0' } });
    for (const [n, hash] of [[1, 'old'], [2, 'new']] as const) {
      const r = { ...ref, attempt: n };
      store.append({ type: 'ATTEMPT_STARTING', ref: r, payload: { sandbox: 's', base: 'b0', sessionId: 'x', deadline: 'd', definitionHash: hash } });
      store.append({ type: 'ATTEMPT_FAILED', ref: r, payload: { reason: 'no' } });
    }
    const state = project(store.readAll());
    assert.equal(countedAttempts(state.features['demo/P1/F01']!, 'new'), 1);
    assert.equal(state.pipeline.consecutiveFailures, 2);
  });

  it('keeps a frozen design when the owner closes a design change', () => {
    const store = new EventStore(join(tempDir('state'), 'events.jsonl'));
    const module = 'shop';
    const review = () => {
      store.append({ type: 'DESIGN_SUBMITTED', payload: { module, head: 'a1', suspect: [] } });
      store.append({ type: 'ARCH_PR_OPENED', payload: { module, number: 1, url: 'u' } });
    };
    store.append({ type: 'MODULE_CREATED', payload: { module, title: 'Shop', sandbox: 's', sessionId: 'x' } });
    review();
    store.append({ type: 'ARCH_PR_CLOSED', payload: { module } });
    assert.equal(project(store.readAll()).modules.shop!.status, 'decomposing', 'a first design that was closed is decomposed again');
    review();
    store.append({ type: 'DESIGN_FROZEN', payload: { module, commit: 'm1' } });
    review();
    store.append({ type: 'ARCH_PR_CLOSED', payload: { module } });
    assert.equal(project(store.readAll()).modules.shop!.status, 'frozen');
  });
});

describe('design', () => {
  it('loads config and plans from a commit', async () => {
    const dir = tempDir('design');
    await createToyRepo(dir);
    const repo = await Repo.open(join(dir, '.bare'));
    await repo.fetchMain(dir);
    const design = await loadDesign(repo, 'refs/heads/main');
    assert.equal(design.config.roles.developer.model, 'claude-opus-5-5');
    assert.equal(design.config.sandbox.claudeProvider, 'claude-sub');
    assert.deepEqual(design.modules[0]!.plans[0]!.features.map((f) => f.id), ['F01', 'F02']);
  });

  it('hashes a feature with the check scripts it runs', async () => {
    const dir = tempDir('hash');
    await createToyRepo(dir);
    const repo = await Repo.open(join(dir, '.bare'));
    const hashes = async () => {
      await repo.fetchMain(dir);
      return (await loadDesign(repo, 'refs/heads/main')).modules[0]!.plans[0]!.features.map(definitionHash);
    };
    const before = await hashes();
    writeFileSync(join(dir, 'harness/modules/demo/checks/F01.sh'), 'test "$(bash src/greet.sh)" = hello # fixed\n');
    await runOk('git', ['-C', dir, '-c', 'user.name=o', '-c', 'user.email=o@test.invalid', 'commit', '--quiet', '-am', 'fix a check']);
    const after = await hashes();
    assert.notEqual(after[0], before[0], 'F01 runs the changed script');
    assert.equal(after[1], before[1], 'F02 does not');
  });

  it('rejects a dependency on a later feature', () => {
    const feature = (id: string, dependsOn: string[]) => ({
      id, title: id, description: 'd', expected: 'e', dependsOn,
      checks: [{ id: `${id}-c`, run: 'true', phase: 'pre-merge' }],
    });
    const result = PlanSchema.safeParse({ id: 'P1', module: 'm', title: 't', goal: 'g', features: [feature('A', ['B']), feature('B', [])] });
    assert.equal(result.success, false);
  });

  it('requires the plan job when the project has Terraform', () => {
    const config = (extra: object) => ConfigSchema.parse({ harnessVersion: '0.1.0', project: { name: 'p' }, ...extra });
    assert.deepEqual(requiredChecks(config({})), ['verify', 'checks']);
    assert.deepEqual(requiredChecks(config({ terraform: {} })), ['verify', 'checks', 'tf-plan']);
  });
});

describe('init', () => {
  it('scaffolds a project once, and keeps what exists', async () => {
    const dir = tempDir('init');
    await runOk('git', ['init', '--quiet', dir]);
    await runOk('git', ['-C', dir, 'remote', 'add', 'origin', 'https://github.com/acme/shop.git']);
    writeFileSync(join(dir, 'README.md'), '# Shop\n');
    // No GitHub App on this machine, as far as this test knows.
    const config = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tempDir('config');
    after(() => (config === undefined ? delete process.env.XDG_CONFIG_HOME : (process.env.XDG_CONFIG_HOME = config)));
    const first = await init({ projectDir: dir, packageDir: join(import.meta.dirname, '..'), version: '9.9.9', owner: 'boss' });
    assert.deepEqual(first.kept, ['README.md']);
    assert.ok(['harness/config.json', '.github/workflows/harness.yml', '.github/CODEOWNERS', 'init.sh', '.gitignore', 'harness/lock.json'].every((p) => first.wrote.includes(p)));
    assert.match(first.notes[0]!, /No GitHub App on this machine yet/);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'harness/config.json'), 'utf8')).project, { name: dir.split('/').at(-1)!.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') });
    assert.match(readFileSync(join(dir, '.github/CODEOWNERS'), 'utf8'), /^\/harness\/ @boss$/m);
    const second = await init({ projectDir: dir, packageDir: join(import.meta.dirname, '..'), version: '9.9.9', owner: 'boss' });
    assert.deepEqual(second.wrote, ['harness/lock.json']);
    assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), '.harness/\n');
  });

  it('reads a GitHub repository from a remote URL', () => {
    assert.equal(githubRepo('git@github.com:acme/shop.git'), 'acme/shop');
    assert.equal(githubRepo('https://github.com/acme/shop'), 'acme/shop');
    assert.equal(githubRepo('https://gitlab.com/acme/shop.git'), undefined);
  });
});

describe('git', () => {
  it('lands a feature as one commit on top of its base, with a progress line', async () => {
    const dir = tempDir('git');
    await createToyRepo(dir);
    await runOk('git', ['-C', dir, 'checkout', '--quiet', '-b', 'work']);
    for (const name of ['one', 'two']) {
      await runOk('bash', ['-c', `echo ${name} > ${dir}/${name}.txt`]);
      await runOk('git', ['-C', dir, 'add', '-A']);
      await runOk('git', ['-C', dir, '-c', 'user.name=d', '-c', 'user.email=d@test.invalid', 'commit', '--quiet', '-m', name]);
    }
    const repo = await Repo.open(join(dir, '.bare'));
    const base = await repo.fetchMain(dir);
    const bundle = join(dir, 'work.bundle');
    await runOk('git', ['-C', dir, 'bundle', 'create', '--quiet', bundle, 'main..work']);
    const head = await repo.fetchBundle(bundle, 'refs/attempts/demo/P1/F01/a1');

    const commit = await repo.commitFeature({ base, head, progressLine: 'line one', message: 'feat: x\n', author: DEVELOPER, committer: HARNESS });
    const info = await repo.commitInfo(commit);
    assert.deepEqual(info.parents, [base]);
    assert.equal(await repo.show(commit, 'progress.txt'), 'line one\n');
    assert.equal(await repo.show(commit, 'two.txt'), 'two\n');
    assert.deepEqual(await repo.changedFiles(base, commit), ['one.txt', 'progress.txt', 'two.txt']);
  });

  it('merges main into a branch with nothing checked out, or names the files that conflict', async () => {
    const dir = tempDir('merge');
    await createToyRepo(dir);
    const commit = async (branch: string, file: string, text: string) => {
      await runOk('git', ['-C', dir, 'checkout', '--quiet', branch]);
      writeFileSync(join(dir, file), text);
      await runOk('git', ['-C', dir, 'add', '-A']);
      await runOk('git', ['-C', dir, '-c', 'user.name=d', '-c', 'user.email=d@test.invalid', 'commit', '--quiet', '-m', file]);
      return (await runOk('git', ['-C', dir, 'rev-parse', 'HEAD'])).trim();
    };
    await runOk('git', ['-C', dir, 'branch', 'plan']);
    const start = (await runOk('git', ['-C', dir, 'rev-parse', 'plan'])).trim();
    const plan = await commit('plan', 'src.txt', 'built\n');
    const main = await commit('main', 'README.md', '# toy, redesigned\n');
    const repo = await Repo.open(join(dir, '.bare'));
    await repo.fetchMain(dir);
    await repo.fetchBranch(dir, 'plan');
    assert.equal(await repo.isAncestor(main, plan), false);

    const merged = await repo.merge({ ours: plan, theirs: main, message: 'Merge main\n', committer: HARNESS });
    assert.ok('commit' in merged);
    assert.deepEqual((await repo.commitInfo(merged.commit)).parents, [plan, main]);
    assert.equal(await repo.show(merged.commit, 'README.md'), '# toy, redesigned\n');
    assert.equal(await repo.show(merged.commit, 'src.txt'), 'built\n');
    assert.equal(await repo.isAncestor(main, merged.commit), true);
    // A branch with nothing of its own just moves to main.
    assert.deepEqual(await repo.merge({ ours: start, theirs: main, message: 'Merge main\n', committer: HARNESS }), { commit: main });

    const clash = await commit('main', 'src.txt', 'not the same\n');
    await repo.fetchMain(dir);
    assert.deepEqual(await repo.merge({ ours: merged.commit, theirs: clash, message: 'Merge main\n', committer: HARNESS }), { conflicts: ['src.txt'] });
  });
});

describe('checks', () => {
  /** A stand-in for terraform: `plan` fails when FAIL_PLAN is set. */
  function fakeTerraform(): string {
    const bin = tempDir('bin');
    writeFileSync(join(bin, 'terraform'), [
      '#!/bin/bash',
      'case "$1" in',
      '  init) echo initialized ;;',
      '  plan) [ -n "$FAIL_PLAN" ] && { echo "Error: AccessDenied" >&2; exit 1; }',
      '        for a in "$@"; do case "$a" in -out=*) echo binary > "${a#-out=}" ;; esac; done',
      '        echo "Plan: 1 to add, 0 to change, 0 to destroy." ;;',
      '  show) echo \'{"resource_changes":[{"type":"aws_s3_bucket","change":{"actions":["create"]}}]}\' ;;',
      'esac',
      '',
    ].join('\n'));
    chmodSync(join(bin, 'terraform'), 0o755);
    return bin;
  }

  it('make one Terraform plan for the checks that assert on it, and hand it to them', async () => {
    const driver = new LocalDriver(tempDir('sandboxes'));
    const bin = fakeTerraform();
    const checks = [
      { id: 'F01-plan', run: 'grep -q aws_s3_bucket "$HARNESS_PLAN_JSON"', phase: 'pre-merge' as const, needs: ['tfplan' as const], timeoutSec: 30 },
      { id: 'unit', run: 'true', phase: 'pre-merge' as const, needs: [], timeoutSec: 30 },
    ];
    const terraform = { dir: 'iac', backendConfig: 'backend-configs/staging.hcl', varFile: 'env/staging.tfvars' };
    for (const [name, env] of [['chk-good', {}], ['chk-bad', { FAIL_PLAN: '1' }]] as const) {
      await driver.create({ name, image: 'x', providers: [], env: { PATH: `${bin}:${process.env.PATH}`, ...env } });
      mkdirSync(join(driver.rootOf(name), 'work', 'iac'), { recursive: true });
    }
    const options = (name: string) => ({ terraform, scratchDir: join(driver.rootOf(name), '.harness') });

    const good = await runChecks(driver, 'chk-good', join(driver.rootOf('chk-good'), 'work'), checks, options('chk-good'));
    assert.deepEqual(good.map((r) => [r.id, r.exit]), [['F01-plan', 0], ['unit', 0]]);

    const bad = await runChecks(driver, 'chk-bad', join(driver.rootOf('chk-bad'), 'work'), checks, options('chk-bad'));
    assert.deepEqual(bad.map((r) => [r.id, r.exit]), [['terraform-plan', 1], ['F01-plan', 1], ['unit', 0]]);
    assert.match(bad[0]!.output, /AccessDenied/);
    await driver.removeAll();
  });
});

describe('sandbox policy', () => {
  it('allows reads and git fetch, never push', () => {
    const policy = JSON.stringify(buildPolicy({ bundles: ['core', 'node'], extraHosts: ['docs.example.com'] }));
    assert.match(policy, /"host":"registry.npmjs.org"[^}]*"access":"read-only"[^}]*"allow_encoded_slash":true/);
    assert.match(policy, /git-upload-pack/);
    assert.doesNotMatch(policy, /receive-pack/);
    assert.match(policy, /docs.example.com/);
  });

  it('signs AWS requests with the view role, IAM for us-east-1', () => {
    const policy = buildPolicy({ bundles: ['core'], extraHosts: [], aws: { region: 'ap-southeast-2', provider: 'aws-view-shop', services: ['sts', 's3', 'iam'] } }) as {
      network_policies: { aws_view: { endpoints: Array<Record<string, unknown>> } };
    };
    const endpoints = policy.network_policies.aws_view.endpoints;
    assert.deepEqual(endpoints.map((e) => e.host), ['sts.ap-southeast-2.amazonaws.com', 's3.ap-southeast-2.amazonaws.com', '*.s3.ap-southeast-2.amazonaws.com', 'iam.amazonaws.com']);
    for (const endpoint of endpoints) {
      assert.deepEqual(endpoint.credential_binding, { provider: 'aws-view-shop' });
      assert.equal(endpoint.credential_signing, 'sigv4');
    }
    assert.equal(endpoints[3]!.signing_region, 'us-east-1');
    assert.equal((buildPolicy({ bundles: ['core'], extraHosts: [] }) as { network_policies: Record<string, unknown> }).network_policies.aws_view, undefined);
  });

  it('rejects hosts OpenShell would reject', () => {
    assert.throws(() => checkHost('**.com'));
    assert.throws(() => checkHost('docs.**.example.com'));
    assert.doesNotThrow(() => checkHost('**.github.io'));
    assert.throws(() => buildPolicy({ bundles: ['nope'], extraHosts: [] }));
  });
});

describe('util', () => {
  it('clips text at a word boundary', () => {
    assert.equal(clip('short', 10), 'short');
    assert.equal(clip('created src/sum.js that sums numbers', 20), 'created src/sum.js…');
    assert.equal(clip('a'.repeat(30), 10), `${'a'.repeat(9)}…`);
  });
});

describe('claude code adapter', () => {
  it('appends the role to the system prompt and never replaces it', () => {
    const script = claudeCode.launch({
      workDir: '/w', promptFile: '/h/developer.md', taskFile: '/h/task.md', schemaFile: '/h/s.json', mcpConfigFile: '/h/mcp.json', streamFile: '/h/s.jsonl',
      stderrFile: '/h/e', exitFile: '/h/x', pidFile: '/h/p', sessionId: 'id', model: 'claude-opus-5-5', effort: 'xhigh',
    });
    assert.match(script, /--append-system-prompt-file/);
    assert.doesNotMatch(script, /--system-prompt |--agent /);
    assert.match(script, /--strict-mcp-config/);
    assert.match(script, /^cd '\/w' \|\| exit 1\nsetsid nohup bash -c .* &$/s);
  });

  it('reads the structured report, a usage limit, and a missing report', () => {
    const report = { type: 'result', is_error: false, result: 'x', structured_output: { outcome: 'done', summary: 'built it' }, usage: { input_tokens: 3, cache_read_input_tokens: 7, output_tokens: 2 } };
    const done = readResult(`{"type":"system"}\n${JSON.stringify(report)}\n`, 0);
    assert.equal(done.outcome, 'done');
    assert.deepEqual(done.usage, { inputTokens: 10, outputTokens: 2 });

    const limited = readResult(JSON.stringify({ type: 'result', is_error: true, result: 'Claude usage limit reached' }), 1);
    assert.equal(limited.outcome, 'usage_limit');
    assert.equal(readResult('', 0).outcome, 'no_report');
    const crashed = readResult('', 1, 'Error: --json-schema is not a valid JSON Schema\n');
    assert.equal(crashed.outcome, 'error');
    assert.match(crashed.detail!, /without a result: Error: --json-schema is not a valid JSON Schema$/);
  });

  it('gives Claude Code a report schema without a meta-schema it cannot resolve', () => {
    const schema = JSON.parse(reportJsonSchema()) as Record<string, unknown>;
    assert.equal(schema.$schema, undefined);
    assert.deepEqual(schema.required, ['outcome', 'summary']);
  });

});
