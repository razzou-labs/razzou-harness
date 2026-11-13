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
import { apiProfile, apiProviderName, buildPolicy } from '../src/sandbox/policy.ts';
import type { Orchestrator } from '../src/daemon/orchestrator.ts';
import { readTokens } from '../src/daemon/tokens.ts';
import { tokensByRole } from '../src/dashboard/tokens.ts';
import { EventStore, type HarnessEvent } from '../src/state/events.ts';
import { activeAttempts, attemptInSandbox, countedAttempts, project } from '../src/state/state.ts';
import { modelName } from '../dashboard/src/format.ts';
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
    assert.equal(activeAttempts(state)[0]?.attempt.status, 'running');
    assert.equal(attemptInSandbox(state, 's')?.attempt.n, 1);

    store.append({ type: 'ATTEMPT_ENDED', ref, payload: { outcome: 'done', summary: 'ok' } });
    store.append({ type: 'CHECKS_STARTED', ref, payload: { head: 'h1', files: ['a'] } });
    store.append({ type: 'FEATURE_ACCEPTED', ref, payload: { commit: 'c1' } });
    state = project(store.readAll());
    assert.deepEqual(activeAttempts(state), []);
    assert.equal(state.features['demo/P1/F01']!.status, 'accepted');
    assert.equal(state.plans['demo/P1']!.head, 'c1');
  });

  it("starts nothing afresh when the daemon lifts a pause that only waited to look again, as it does after the owner's resume", () => {
    const store = new EventStore(join(tempDir('state'), 'events.jsonl'));
    const plan = { module: 'demo', plan: 'P1' };
    store.append({ type: 'PLAN_STARTED', ref: plan, payload: { branch: 'plan/demo/P1', base: 'b0' } });
    store.append({ type: 'PLAN_CHECKS_FAILED', ref: plan, payload: { results: [], head: 'b0' } });
    store.append({ type: 'MANAGER_STARTING', payload: { module: 'demo', sandbox: 'mgr', sessionId: 'x' } });
    store.append({ type: 'MANAGER_LAUNCHED', payload: { module: 'demo', launch: 1, outputBytes: 0 } });
    store.append({ type: 'MANAGER_ITEM_SENT', payload: { module: 'demo', key: 'review:demo/P1/F01#1', launch: 1, reminder: false } });
    const sentAndFailing = (state: ReturnType<typeof project>) => [Object.keys(state.managers.demo!.sent), state.plans['demo/P1']!.validation?.status, state.pipeline.paused?.retry];

    // GitHub didn't answer: the daemon waits, then looks again. Nobody looked, so what waits goes on waiting.
    store.append({ type: 'PIPELINE_PAUSED', payload: { reason: 'demo/P1 keeps failing', until: '2030-01-01T00:10:00Z', retry: true } });
    assert.deepEqual(sentAndFailing(project(store.readAll())), [['review:demo/P1/F01#1'], 'failed', true]);
    store.append({ type: 'PIPELINE_RESUMED', payload: { auto: true } });
    assert.deepEqual(sentAndFailing(project(store.readAll())), [['review:demo/P1/F01#1'], 'failed', undefined]);

    // The owner lifts the same kind of pause themselves: they looked, so the Manager's turn and the failed checks start afresh.
    store.append({ type: 'PIPELINE_PAUSED', payload: { reason: 'demo/P1 keeps failing', until: '2030-01-01T00:20:00Z', retry: true } });
    store.append({ type: 'PIPELINE_RESUMED', payload: {} });
    assert.deepEqual(sentAndFailing(project(store.readAll())), [[], undefined, undefined]);
  });

  it('runs failing checks twice on a commit before they are anybody\'s, and sends a plan whose full run failed twice back to its build', () => {
    const store = new EventStore(join(tempDir('state'), 'events.jsonl'));
    const plan = { module: 'demo', plan: 'P1' };
    const validation = () => project(store.readAll()).plans['demo/P1']!;
    store.append({ type: 'PLAN_STARTED', ref: plan, payload: { branch: 'plan/demo/P1', base: 'b0' } });
    store.append({ type: 'PLAN_VALIDATING', ref: plan, payload: { head: 'h1' } });
    store.append({ type: 'PLAN_CHECKS_FAILED', ref: plan, payload: { results: [], head: 'h1' } });
    assert.deepEqual([validation().status, validation().validation?.runs], ['validating', 1]);
    store.append({ type: 'PLAN_CHECKS_FAILED', ref: plan, payload: { results: [], head: 'h1' } });
    assert.deepEqual([validation().status, validation().validation?.runs, validation().validation?.head], ['active', 2, 'h1']);
    // Another commit is counted afresh, and a run that passes ends the count.
    store.append({ type: 'PLAN_CHECKS_FAILED', ref: plan, payload: { results: [], head: 'h2' } });
    assert.equal(validation().validation?.runs, 1);
    store.append({ type: 'PLAN_CHECKS_PASSED', ref: plan, payload: { results: [], head: 'h2' } });
    assert.deepEqual([validation().validation?.status, validation().validation?.runs], ['passed', undefined]);
  });

  it("keeps the owner's latest order request alone, with the answer to it, and a Manager's tools from when its sandbox was made", () => {
    const store = new EventStore(join(tempDir('state'), 'events.jsonl'));
    const cards = [{ key: 'action:demo/T1', title: 'Task demo/T1: Read', print: '[]' }, { key: 'action:demo/T2', title: 'Task demo/T2: Copy', print: '[]' }];
    store.append({ type: 'MANAGER_STARTING', payload: { module: 'demo', sandbox: 'mgr-1', sessionId: 's' } });
    store.append({ type: 'ORDER_REQUESTED', from: 'owner', to: 'manager', payload: { module: 'demo', requestId: 'o1', manager: 'demo', cards, text: 'first' } });
    let state = project(store.readAll());
    assert.equal(state.managers.demo!.tools, undefined, 'unknown until its sandbox is made');
    assert.deepEqual(state.managers.demo!.mail.map((m) => `${m.kind} ${m.text}`), ['welcome ', 'order_request first']);

    // Asked again before the first request was delivered: the Manager reads the second alone.
    store.append({ type: 'ORDER_REQUESTED', from: 'owner', to: 'manager', payload: { module: 'demo', requestId: 'o2', manager: 'demo', cards, text: 'second' } });
    store.append({ type: 'MANAGER_LAUNCHED', payload: { module: 'demo', launch: 1, outputBytes: 0, tools: ['ask_owner', 'suggest_order'] } });
    store.append({ type: 'MANAGER_LAUNCHED', payload: { module: 'demo', launch: 2, outputBytes: 10 } });
    store.append({ type: 'ORDER_SUGGESTED', from: 'manager', to: 'owner', payload: { module: 'demo', requestId: 'o1', call: 'c1', order: [{ key: 'action:demo/T1', why: 'late' }] } });
    state = project(store.readAll());
    assert.deepEqual(state.managers.demo!.mail.map((m) => `${m.kind} ${m.text}`), ['welcome ', 'order_request second']);
    assert.deepEqual(state.managers.demo!.tools, ['ask_owner', 'suggest_order'], 'a relaunch in the same sandbox keeps them');
    assert.equal(state.order!.requestId, 'o2');
    assert.equal(state.order!.suggestion, undefined, 'an answer to the request it replaced is not its answer');

    store.append({ type: 'ORDER_SUGGESTED', from: 'manager', to: 'owner', payload: { module: 'demo', requestId: 'o2', call: 'c2', order: [{ key: 'action:demo/T2', why: 'first' }, { key: 'action:demo/T1', why: '' }], summary: 'T2 first.' } });
    state = project(store.readAll());
    assert.deepEqual(state.order!.suggestion!.order.map((c) => c.key), ['action:demo/T2', 'action:demo/T1']);
    assert.equal(state.order!.suggestion!.summary, 'T2 first.');
    assert.deepEqual(store.readAll().filter((e) => e.type.startsWith('ORDER_')).map((e) => e.kind), ['message', 'message', 'message', 'message']);
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
    const { architect, manager, developer } = design.config.roles;
    assert.deepEqual([architect.model, architect.effort], ['claude-fable-5-2', 'max']);
    assert.deepEqual([manager.model, manager.effort], ['claude-opus-5-5', 'max']);
    assert.deepEqual([developer.model, developer.effort], ['claude-opus-5-5', 'max']);
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

describe('agent tokens', () => {
  it("adds up a long-lived agent's readings, a new sandbox counting again from zero", () => {
    let id = 0;
    const event = (reading: { inputTokens: number; outputTokens: number }, agent = 'manager:demo') =>
      ({ v: 1, id: `e${++id}`, ts: '2026-11-08T00:00:00Z', type: 'AGENT_TOKENS', payload: { agent, reading } }) as unknown as HarnessEvent;
    const state = project([
      event({ inputTokens: 1000, outputTokens: 100 }),
      event({ inputTokens: 1500, outputTokens: 180 }),
      event({ inputTokens: 200, outputTokens: 20 }),
      event({ inputTokens: 300, outputTokens: 30 }),
      event({ inputTokens: 50, outputTokens: 5 }, 'architect:demo'),
    ]);
    assert.deepEqual(state.agentTokens!['manager:demo'], { total: { inputTokens: 1800, outputTokens: 210 }, reading: { inputTokens: 300, outputTokens: 30 } });
    assert.deepEqual(state.agentTokens!['architect:demo']!.total, { inputTokens: 50, outputTokens: 5 });
  });

  it('counts the cache reads and the time of a whole sandbox from its first reading that has them, and only grows after', () => {
    let id = 0;
    const event = (reading: object, agent = 'architect:demo') =>
      ({ v: 1, id: `e${++id}`, ts: '2026-11-10T00:00:00Z', type: 'AGENT_TOKENS', payload: { agent, reading } }) as unknown as HarnessEvent;
    const state = project([
      // A sandbox read before 0.5.1, then gone: its cache reads and time stay unknown.
      event({ inputTokens: 1000, outputTokens: 100 }),
      // A new sandbox, read before 0.5.1, then since: its first reading with them counts all of it.
      event({ inputTokens: 200, outputTokens: 20 }),
      event({ inputTokens: 300, outputTokens: 30, cacheReadTokens: 270, activeMs: 60_000 }),
      event({ inputTokens: 500, outputTokens: 40, cacheReadTokens: 460, activeMs: 90_000 }),
    ]);
    assert.deepEqual(state.agentTokens!['architect:demo'], {
      total: { inputTokens: 1500, outputTokens: 140, cacheReadTokens: 460, splitInputTokens: 500, activeMs: 90_000 },
      reading: { inputTokens: 500, outputTokens: 40, cacheReadTokens: 460, activeMs: 90_000 },
    });
  });

  it('ignores the agent-hours threshold an older log may hold', () => {
    const event = (type: string, payload: object, ts: string) => ({ v: 1, id: `e-${type}`, ts, type, payload }) as unknown as HarnessEvent;
    const state = project([event('AGENT_HOURS_SET', { hours: 40 }, '2026-11-01T00:00:00Z'), event('OWNER_HOURS_SET', { hours: 12 }, '2026-11-02T00:00:00Z')]);
    assert.deepEqual(state.budgets, { ownerHours: 12, ownerHoursSetAt: '2026-11-02T00:00:00Z' });
  });

  it('names a model as people do: Fable 5.2, Sonnet 4.5, Opus 5.5 (1M), and anything else as it is', () => {
    assert.deepEqual(['claude-fable-5-2', 'claude-sonnet-4-5-20250929', 'claude-opus-5-5[1m]', 'claude-fable-5', 'opus', 'claude-3-7-sonnet-latest'].map(modelName), [
      'Fable 5.2', 'Sonnet 4.5', 'Opus 5.5 (1M)', 'Fable 5', 'opus', 'claude-3-7-sonnet-latest',
    ]);
  });

  it("counts every reply of a sandbox's saved conversations once, at its final count", async () => {
    const driver = new LocalDriver(tempDir('tokens'));
    await driver.create({ name: 'mgr-tokens', image: 'x', providers: [], env: {} });
    const dir = join(driver.rootOf('mgr-tokens'), '.claude', 'projects', '-sandbox-work');
    mkdirSync(join(dir, 'subagents'), { recursive: true });
    const reply = (id: string, output: number, input = 10) => JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: input, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: output } } });
    writeFileSync(join(dir, 'session.jsonl'), [
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      reply('msg_1', 5), reply('msg_1', 40),
      reply('msg_2', 7),
      '{"type":"assistant","message":{"id":"msg_3","usa',
    ].join('\n'));
    writeFileSync(join(dir, 'subagents', 'agent-a.jsonl'), `${reply('msg_4', 3, 1)}\n`);
    const o = { exec: (sandbox: string, script: string) => driver.exec(sandbox, script) } as unknown as Orchestrator;
    assert.deepEqual(await readTokens(o, 'mgr-tokens'), { inputTokens: 2 * 1110 + 1101, outputTokens: 40 + 7 + 3, cacheReadTokens: 3 * 1000, activeMs: 0 });
    assert.equal(await readTokens(o, 'no-such-sandbox'), undefined);
    await driver.removeAll();
  });

  it("times an agent's turns, from each prompt to its last step, once even where a resumed conversation repeats them", async () => {
    const driver = new LocalDriver(tempDir('turns'));
    await driver.create({ name: 'arc-turns', image: 'x', providers: [], env: {} });
    const dir = join(driver.rootOf('arc-turns'), '.claude', 'projects', '-sandbox-work');
    mkdirSync(join(dir, 'subagents'), { recursive: true });
    const at = (seconds: number) => new Date(Date.UTC(2026, 10, 10, 12, 0, seconds)).toISOString();
    const prompt = (seconds: number, extra: object = {}) => JSON.stringify({ type: 'user', timestamp: at(seconds), message: { role: 'user', content: 'work' }, ...extra });
    const result = (seconds: number) => JSON.stringify({ type: 'user', timestamp: at(seconds), message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } });
    const reply = (seconds: number, extra: object = {}) => JSON.stringify({ type: 'assistant', timestamp: at(seconds), message: { id: `msg_${seconds}`, usage: { input_tokens: 1, output_tokens: 1 } }, ...extra });
    const first = [prompt(0), reply(5), result(10), reply(20)];
    writeFileSync(join(dir, 'one.jsonl'), [
      ...first,
      // What Claude Code adds itself starts no turn, nor does a subagent's work, which ends with its caller's tool result.
      prompt(25, { isMeta: true }), prompt(26, { isSidechain: true }), reply(27, { isSidechain: true }), result(28),
      prompt(60), reply(65),
      // Claude Code's line for the next message, queued long after the turn ended.
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: at(95) }),
    ].join('\n'));
    // A conversation resumed in a new file repeats the first turn: it counts once.
    writeFileSync(join(dir, 'two.jsonl'), [...first, prompt(100), reply(130)].join('\n'));
    writeFileSync(join(dir, 'subagents', 'agent-a.jsonl'), [prompt(30), reply(50)].join('\n'));
    const o = { exec: (sandbox: string, script: string) => driver.exec(sandbox, script) } as unknown as Orchestrator;
    // 0 to 28, the subagent's result; 60 to 65; 100 to 130.
    assert.equal((await readTokens(o, 'arc-turns'))!.activeMs, (28 + 5 + 30) * 1000);
    await driver.removeAll();
  });

  it('finds the cache reads of sessions recorded before 0.5.1 in their saved streams, when they are the streams that gave them', () => {
    const harnessDir = tempDir('tokens-dashboard');
    const stream = (dir: string, usage: object) => {
      mkdirSync(join(harnessDir, 'modules', 'demo', dir), { recursive: true });
      writeFileSync(join(harnessDir, 'modules', 'demo', dir, 'stream.jsonl'), `{"type":"system"}\n${JSON.stringify({ type: 'result', usage })}\n`);
    };
    stream('attempts/P1-F01-a1', { input_tokens: 10, cache_creation_input_tokens: 90, cache_read_input_tokens: 900, output_tokens: 50 });
    // A review run again on the same head wrote over its stream: another session's totals.
    stream('reviews/P1-security-abcdef12', { input_tokens: 1, cache_read_input_tokens: 99, output_tokens: 5 });
    const state = project([]);
    state.features['demo/P1/F01'] = {
      module: 'demo', plan: 'P1', feature: 'F01', status: 'accepted',
      attempts: [
        { n: 1, usage: { inputTokens: 1000, outputTokens: 50 } },
        { n: 2, usage: { inputTokens: 400, outputTokens: 20, cacheReadTokens: 300 } },
        { n: 3, usage: { inputTokens: 100, outputTokens: 10 } },
      ],
    } as never;
    state.plans['demo/P1'] = { module: 'demo', plan: 'P1', reviews: [{ role: 'security', head: 'abcdef1234', usage: { inputTokens: 500, outputTokens: 7 } }] } as never;
    state.agentTokens = { 'architect:demo': { total: { inputTokens: 2000, outputTokens: 30, cacheReadTokens: 900, splitInputTokens: 1000 }, reading: { inputTokens: 1000, outputTokens: 10 } } };
    assert.deepEqual(tokensByRole(state, harnessDir), [
      // Attempt 1 from its stream, attempt 2 as recorded; attempt 3 has no stream.
      { role: 'Developers', read: 1500, cacheRead: 1200, known: 1400, written: 80 },
      { role: 'Managers', read: 0, cacheRead: 0, known: 0, written: 0 },
      { role: 'Architects', read: 2000, cacheRead: 900, known: 1000, written: 30 },
      { role: 'Reviewers', read: 500, cacheRead: 0, known: 0, written: 7 },
    ]);
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
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'harness/config.json'), 'utf8')).network, { bundles: ['all'] }, 'every bundle, with no question');
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
    assert.match(policy, /docs\.example\.com/);
  });

  it('signs AWS requests with the view role, IAM for us-east-1', () => {
    const policy = buildPolicy({ bundles: ['core'], extraHosts: [], aws: { region: 'ap-southeast-2', provider: 'aws-view-shop', services: ['sts', 's3', 'iam'] } }) as {
      network_policies: { aws_view: { endpoints: Array<Record<string, unknown>> } };
    };
    const endpoints = policy.network_policies.aws_view.endpoints;
    assert.deepEqual(endpoints.map((e) => e.host), ['sts.ap-southeast-2.amazonaws.com', 's3.ap-southeast-2.amazonaws.com', '*.s3.ap-southeast-2.amazonaws.com', 'iam.amazonaws.com']);
    for (const endpoint of endpoints) {
      assert.deepEqual(endpoint.credential_binding, { provider: 'aws-view-shop' });
      // S3 signs as its SDK says; every other service, a GET included, with the hash of its body (NVIDIA/OpenShell#5375).
      assert.equal(endpoint.credential_signing, String(endpoint.host).includes('.s3.') || String(endpoint.host).startsWith('s3.') ? 'sigv4' : 'sigv4:body', String(endpoint.host));
    }
    assert.equal(endpoints[3]!.signing_region, 'us-east-1');
    assert.equal((buildPolicy({ bundles: ['core'], extraHosts: [] }) as { network_policies: Record<string, unknown> }).network_policies.aws_view, undefined);
  });

  it('signs every AWS service for all, each with its own signing name, the global ones for their region', () => {
    type Endpoint = { host: string; signing_service: string; signing_region?: string; credential_binding: { provider: string } };
    const endpoints = (services: string[]) => (buildPolicy({ bundles: ['core'], extraHosts: [], aws: { region: 'eu-west-1', provider: 'aws-view-shop', services } }) as {
      network_policies: { aws_view: { endpoints: Endpoint[] } };
    }).network_policies.aws_view.endpoints;
    const all = endpoints(['all']);
    const find = (host: string) => all.find((e) => e.host === host);
    assert.ok(all.length > 400, `${all.length} endpoints`);
    assert.equal(new Set(all.map((e) => e.host)).size, all.length, 'one rule per host');
    all.forEach((e) => checkHost(e.host));
    assert.ok(all.every((e) => e.credential_binding.provider === 'aws-view-shop'));
    assert.deepEqual([find('lambda.eu-west-1.amazonaws.com')?.signing_service, find('api.ecr.eu-west-1.amazonaws.com')?.signing_service, find('bedrock-runtime.eu-west-1.amazonaws.com')?.signing_service, find('monitoring.eu-west-1.amazonaws.com')?.signing_service], ['lambda', 'ecr', 'bedrock', 'monitoring']);
    assert.deepEqual([find('iam.amazonaws.com')?.signing_region, find('route53.amazonaws.com')?.signing_region, find('lambda.eu-west-1.amazonaws.com')?.signing_region], ['us-east-1', 'us-east-1', undefined]);
    assert.ok(find('*.s3.eu-west-1.amazonaws.com') && find('*.s3-control.eu-west-1.amazonaws.com'), "buckets' and accounts' hosts");
    const signing = (host: string) => (find(host) as { credential_signing?: string } | undefined)?.credential_signing;
    assert.deepEqual([signing('lambda.eu-west-1.amazonaws.com'), signing('route53.amazonaws.com'), signing('s3.eu-west-1.amazonaws.com'), signing('*.s3-control.eu-west-1.amazonaws.com')], ['sigv4:body', 'sigv4:body', 'sigv4', 'sigv4']);
    const mixed = endpoints(['all', 'cloudwatch', 'newservice']);
    assert.equal(mixed.length, all.length + 1, 'a named service the table lacks is added, and one it has is not repeated');
    assert.equal(mixed.find((e) => e.host === 'newservice.eu-west-1.amazonaws.com')?.signing_service, 'newservice');
    assert.deepEqual(endpoints(['sts']).map((e) => e.host), ['sts.eu-west-1.amazonaws.com'], 'a list without all names only its services');
  });

  it("signs DynamoDB's account endpoint, which SDKs and Terraform call by default, for all and for dynamodb", () => {
    type Endpoint = { host: string; signing_service: string; credential_signing: string };
    const endpoints = (services: string[]) => (buildPolicy({ bundles: ['core'], extraHosts: [], aws: { region: 'eu-west-1', provider: 'aws-view-shop', services } }) as {
      network_policies: { aws_view: { endpoints: Endpoint[] } };
    }).network_policies.aws_view.endpoints;
    for (const services of [['all'], ['dynamodb']]) {
      const account = endpoints(services).find((e) => e.host === '*.ddb.eu-west-1.amazonaws.com');
      assert.deepEqual([account?.signing_service, account?.credential_signing], ['dynamodb', 'sigv4:body'], services.join());
      assert.ok(endpoints(services).some((e) => e.host === 'dynamodb.eu-west-1.amazonaws.com'), services.join());
    }
  });

  it('rejects hosts OpenShell would reject', () => {
    assert.throws(() => checkHost('**.com'));
    assert.throws(() => checkHost('docs.**.example.com'));
    assert.doesNotThrow(() => checkHost('**.github.io'));
    assert.throws(() => buildPolicy({ bundles: ['nope'], extraHosts: [] }));
  });

  it('reads all as every bundle, and opens an API to every method, over a bundle\'s read-only rule', () => {
    type Policy = { network_policies: Record<string, { endpoints: Array<Record<string, unknown>> }> };
    const hosts = (policy: Policy) => Object.values(policy.network_policies).flatMap((p) => p.endpoints.map((e) => e.host));
    const all = buildPolicy({ bundles: ['all'], extraHosts: [] }) as Policy;
    for (const host of ['registry.npmjs.org', 'pypi.org', 'registry.terraform.io', 'proxy.golang.org', 'index.crates.io', 'repo1.maven.org', 'registry.opentofu.org', 'cdn.playwright.dev']) {
      assert.ok(hosts(all).includes(host), `${host} is in every bundle's list`);
    }
    const policy = buildPolicy({ bundles: ['core'], extraHosts: [], apis: [{ host: 'api.github.com' }, { host: 'api.example.com' }, { host: 'api.stripe.com', key: 'STRIPE_API_KEY' }] }) as Policy;
    assert.deepEqual(policy.network_policies.third_party_apis!.endpoints, [
      { host: 'api.github.com', port: 443, protocol: 'rest', enforcement: 'enforce', access: 'full' },
      { host: 'api.example.com', port: 443, protocol: 'rest', enforcement: 'enforce', access: 'full' },
    ]);
    assert.equal(hosts(policy).filter((host) => host === 'api.github.com').length, 1, "the API's rule replaces core's read-only one");
    assert.equal(hosts(policy).filter((host) => host === 'api.stripe.com').length, 0, 'an API with a key is opened by its provider\'s profile');
    assert.equal((buildPolicy({ bundles: ['core'], extraHosts: [] }) as Policy).network_policies.third_party_apis, undefined);
  });

  it("writes an API key's provider profile: the variable, the host alone, every method", () => {
    assert.equal(apiProviderName('People Infra', 'api.stripe.com'), 'api-people-infra-api-stripe-com');
    assert.deepEqual(apiProfile('shop', { host: 'api.stripe.com', key: 'STRIPE_API_KEY' }), {
      id: 'api-shop-api-stripe-com',
      display_name: 'api.stripe.com for shop',
      description: "The key of api.stripe.com that the harness's sandboxes of shop use, as STRIPE_API_KEY",
      category: 'other',
      credentials: [{ name: 'key', description: 'The key of api.stripe.com', env_vars: ['STRIPE_API_KEY'], required: true, auth_style: 'bearer', header_name: 'authorization' }],
      endpoints: [{ host: 'api.stripe.com', port: 443, protocol: 'rest', access: 'full', enforcement: 'enforce' }],
      binaries: ['/usr/local/bin/claude', '/usr/bin/bash', '/usr/bin/dash'],
    });
  });

  it('takes every bundle by default, and checks bundles and APIs when the config is read', () => {
    const parse = (network: object) => ConfigSchema.safeParse({ harnessVersion: '0.4.1', project: { name: 'p' }, network });
    assert.deepEqual(ConfigSchema.parse({ harnessVersion: '0.4.1', project: { name: 'p' } }).network, { bundles: ['all'], extraHosts: [], apis: [] });
    assert.equal(parse({ bundles: ['core', 'node'] }).success, true);
    assert.equal(parse({ bundles: ['All'] }).success, false, 'an unknown bundle fails when the config is read, not when a sandbox is made');
    assert.equal(parse({ apis: [{ host: 'api.stripe.com', key: 'STRIPE_API_KEY' }, { host: 'httpbin.org' }] }).success, true);
    for (const apis of [
      [{ host: '*.stripe.com' }],
      [{ host: 'https://api.stripe.com' }],
      [{ host: 'api.stripe.com', key: 'stripe_key' }],
      [{ host: 'api.stripe.com', key: 'AWS_SECRET_ACCESS_KEY' }],
      [{ host: 'api.stripe.com', key: 'PATH' }],
      [{ host: 'api.stripe.com', secret: 'sk_test_123' }],
      [{ host: 'api.stripe.com' }, { host: 'api.stripe.com' }],
      [{ host: 'a.example.com', key: 'K' }, { host: 'b.example.com', key: 'K' }],
    ]) {
      assert.equal(parse({ apis }).success, false, JSON.stringify(apis));
    }
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
    assert.deepEqual(done.usage, { inputTokens: 10, outputTokens: 2, cacheReadTokens: 7 });

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
