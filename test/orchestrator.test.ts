import { strict as assert } from 'node:assert';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { detach, type AgentAdapter, type AgentRun } from '../src/agents/claude-code.ts';
import type { SubscriptionUsage } from '../src/anthropic/usage.ts';
import { submitLockedChange } from '../src/daemon/design.ts';
import { Orchestrator } from '../src/daemon/orchestrator.ts';
import { handleRequest } from '../src/daemon/requests.ts';
import type { SandboxOverview, UsageReading } from '../src/daemon/sandboxes.ts';
import type { ConfigView } from '../src/dashboard/config-view.ts';
import { startDashboard, type DashboardState } from '../src/dashboard/server.ts';
import { Terminals, type Pty } from '../src/dashboard/terminals.ts';
import { recover } from '../src/setup/recover.ts';
import type { Config } from '../src/design/schemas.ts';
import { activeAttempts, type Mode } from '../src/state/state.ts';
import { HARNESS } from '../src/git/repo.ts';
import { runOk, sh, sleep } from '../src/util.ts';
import { FAKE_BOT, FakeForge } from './helpers/fake-forge.ts';
import { LocalDriver } from './helpers/local-driver.ts';
import { stubAgent, type ReviewBehavior, type StubBehavior } from './helpers/stub-agent.ts';
import type { ArchitectBehavior } from './helpers/stub-architect.ts';
import type { ManagerBehavior } from './helpers/stub-manager.ts';
import { createToyRepo, SOLUTIONS, tempDir, toyDesign } from './helpers/toy-repo.ts';

const packageDir = join(import.meta.dirname, '..');
const cleanup: Array<() => Promise<void>> = [];
// Stop every daemon, so its followers end, and every agent the tests started.
after(async () => {
  for (const step of cleanup) await step().catch(() => {});
});

type Decide = (feature: string, attempt: number) => StubBehavior;

/** The daemon's last log lines per orchestrator: a step that fails silently shows up when a wait times out. */
const daemonLogs = new WeakMap<Orchestrator, string[]>();

interface SetupOptions {
  config?: Record<string, unknown>;
  manager?: ManagerBehavior;
  prepare?: (projectDir: string) => Promise<void>;
  now?: () => number;
  /** Plays the project on a fake GitHub, with pull requests and CI. */
  github?: boolean;
  /** What the stub reviewers answer (v3 §5); every review passes by default. */
  review?: ReviewBehavior;
  /** Starts with no design: an Architect writes it. */
  design?: boolean;
  architect?: ArchitectBehavior;
  /** Applies main's rules on a switch; never the machine's real gh. */
  applyRules?: (config: Config, repo: string, mode: Mode) => Promise<string[]>;
  /** Wraps the stub agent, to make some of its sessions end otherwise. */
  agent?: (stub: AgentAdapter) => AgentAdapter;
}

async function setup(decide: Decide, options: SetupOptions = {}) {
  const projectDir = tempDir('project');
  const github = options.github ? { project: { name: 'toy', repo: 'acme/toy', bot: FAKE_BOT } } : {};
  await createToyRepo(projectDir, { ...github, ...options.config }, { design: options.design ?? true });
  if (options.prepare) await options.prepare(projectDir);
  const fake = options.github ? await FakeForge.create(projectDir) : undefined;
  const harnessDir = join(projectDir, '.harness');
  const driver = new LocalDriver(tempDir('sandboxes'));
  const make = () => {
    const logs: string[] = [];
    const made = new Orchestrator({
      projectDir,
      harnessDir,
      driver,
      packageDir,
      version: 'test',
      agent: (options.agent ?? ((stub) => stub))(stubAgent(decide, options.manager, options.architect, options.review)),
      webRead: async (url) => ({ ok: true, text: `the page at ${url}`, bytes: 20 }),
      // The log is kept for the timeout message; HARNESS_TEST_LOG=1 prints it as it comes.
      log: (message: string) => {
        logs.push(message);
        if (logs.length > 30) logs.shift();
        if (process.env.HARNESS_TEST_LOG) console.error(`[daemon] ${message}`);
      },
      applyRules: options.applyRules ?? (async () => []),
      ...(options.now ? { now: options.now } : {}),
      ...(fake ? { forge: () => fake } : {}),
    });
    daemonLogs.set(made, logs);
    cleanup.push(() => made.stop(0));
    return made;
  };
  cleanup.push(() => driver.removeAll());
  const orchestrator = make();
  await orchestrator.start();
  return { harnessDir, orchestrator, make, driver, fake: fake! };
}

/** A `rate_limit_event` line, as an agent's Claude Code writes one after a model call. */
function rateLimitEvent(utilization: { five_hour: number; seven_day: number }, resetsAt: number): string {
  const window = (u: number) => ({ utilization: u, resetsAt, status: 'allowed' });
  return JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: window(utilization.five_hour), seven_day: window(utilization.seven_day) } } });
}

/** Ticks until `done` holds, giving the detached stubs time to work. */
async function until(o: Orchestrator, done: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) {
      const log = (daemonLogs.get(o) ?? []).slice(-6).map((l) => `\n  ${l.slice(0, 300)}`).join('');
      throw new Error(`timed out; last events: ${o.store.readAll().slice(-8).map((e) => e.type).join(', ')}; daemon log:${log || ' (empty)'}`);
    }
    await o.tick();
    await sleep(100);
  }
  // A pass that an agent's request kicked off may still run: it finishes here, so that what
  // the test does next, a merge or a jump of the clock, doesn't land in the middle of it.
  await o.tick();
}

const solved = (feature: string): StubBehavior => ({ files: SOLUTIONS[feature as keyof typeof SOLUTIONS] });

/** The owner commits a file on a branch of the fake GitHub, as with GitHub's editor, and gets the new head. */
async function ownerCommit(remote: string, branch: string, path: string, content: string): Promise<string> {
  const dir = tempDir('owner');
  await runOk('git', ['clone', '--quiet', '--branch', branch, remote, dir]);
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), content);
  await runOk('git', ['-C', dir, 'add', '-A']);
  await runOk('git', ['-C', dir, '-c', 'user.name=o', '-c', 'user.email=o@test.invalid', 'commit', '--quiet', '-m', "the owner's change"]);
  await runOk('git', ['-C', dir, 'push', '--quiet', 'origin', branch]);
  return (await runOk('git', ['-C', dir, 'rev-parse', 'HEAD'])).trim();
}

/** The owner commits on the project's main, which the daemon reads without GitHub. */
async function commitOnMain(projectDir: string, files: Record<string, string>, message: string): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(projectDir, path, '..'), { recursive: true });
    writeFileSync(join(projectDir, path), content);
  }
  await runOk('git', ['-C', projectDir, 'add', '-A']);
  await runOk('git', ['-C', projectDir, '-c', 'user.name=o', '-c', 'user.email=o@test.invalid', 'commit', '--quiet', '-m', message]);
}

/** A second module, "alpha", which sorts before "demo": one feature, A01. */
const alphaDesign: Record<string, string> = {
  'harness/modules/alpha/plans/P1.json': JSON.stringify({
    id: 'P1', module: 'alpha', title: 'Alpha', goal: 'A file.',
    features: [{ id: 'A01', title: 'File', description: 'src/alpha.txt exists.', expected: 'It exists.', checks: [{ id: 'A01-file', run: 'test -f src/alpha.txt', phase: 'pre-merge', timeoutSec: 30 }] }],
  }, null, 2),
};
const alphaOrSolved = (f: string): StubBehavior => (f === 'A01' ? { files: { 'src/alpha.txt': '1\n' } } : solved(f));

/**
 * The stub, except that the listed attempts of a feature end on a usage limit, as Claude
 * Code reports one: by default in a newer version's words, whose "resets 3pm" is the
 * sandbox's clock and gives no Unix time.
 */
const usageLimitOn = (feature: string, attempts: number[], message = "You've hit your 5-hour limit · resets 3pm") => (stub: AgentAdapter): AgentAdapter => ({
  ...stub,
  launch(run: AgentRun) {
    const task = readFileSync(run.taskFile, 'utf8');
    const which = /^# Feature [^/]+\/[^/]+\/([^:]+):/m.exec(task)?.[1];
    const attempt = Number(/This is attempt (\d+)\./.exec(task)?.[1] ?? 0);
    if (which !== feature || !attempts.includes(attempt)) return stub.launch(run);
    const result = { type: 'result', subtype: 'error_during_execution', is_error: true, result: message };
    return detach(run.workDir, [`echo $$ > ${sh(run.pidFile)}`, 'sleep 1', `printf '%s\\n' ${sh(JSON.stringify(result))} > ${sh(run.streamFile)}`, `echo 1 > ${sh(run.exitFile)}`].join('\n'));
  },
});
const feature = (o: Orchestrator, id: string) => o.state.features[`demo/P1/${id}`];
/** The git bundles left in `.harness/modules/`: each sandbox has its own copy, so none should be. */
const bundlesIn = (harnessDir: string) => (existsSync(join(harnessDir, 'modules')) ? readdirSync(join(harnessDir, 'modules'), { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.bundle')) : []);
const completed = (o: Orchestrator) => () => o.state.plans['demo/P1']?.status === 'completed';

describe('orchestrator', () => {
  it('takes the owner hours left for it by harness budget when it starts, once', async () => {
    const pending = async (dir: string) => {
      mkdirSync(join(dir, '.harness'), { recursive: true });
      writeFileSync(join(dir, '.harness', 'setup.json'), JSON.stringify({ ownerHours: 12 }));
    };
    const { orchestrator: o, harnessDir, make } = await setup((f) => solved(f), { prepare: pending });
    assert.equal(o.state.budgets.ownerHours, 12);
    assert.equal(existsSync(join(harnessDir, 'setup.json')), false);
    // Set again by hand later, the file left behind doesn't override the owner.
    o.setBudgets({ ownerHours: 20 });
    writeFileSync(join(harnessDir, 'setup.json'), JSON.stringify({ ownerHours: 5 }));
    await o.stop(0);
    const again = make();
    await again.start();
    assert.equal(again.state.budgets.ownerHours, 20);
    assert.equal(existsSync(join(harnessDir, 'setup.json')), false);
  });

  it('lands each accepted feature as one commit with its progress line', async () => {
    const { orchestrator: o } = await setup((f) => solved(f));
    await until(o, completed(o));

    const plan = o.state.plans['demo/P1']!;
    const log = await runOk('git', ['--git-dir', o.repo.dir, 'log', '--format=%an|%cn|%s', `${plan.base}..${plan.head}`]);
    assert.deepEqual(log.trim().split('\n'), [
      'Developer (harness)|harness|feat(demo/P1/F02): Add',
      'Developer (harness)|harness|feat(demo/P1/F01): Greet',
    ]);
    const progress = (await o.repo.show(plan.head, 'progress.txt'))!;
    assert.match(progress, /feature\.accepted demo\/P1\/F01 attempt=1 "stub implemented F01"/);
    assert.match(progress, /feature\.accepted demo\/P1\/F02 attempt=1/);
    assert.equal(await o.repo.show(plan.head, 'src/add.sh'), SOLUTIONS.F02['src/add.sh']);
    assert.equal(plan.summary, 'Stub summary of the plan.');
    assert.equal(o.state.managers.demo!.status, 'stopped');
  });

  it("retries a failed attempt with the Manager's guidance and the failure", async () => {
    const { orchestrator: o, harnessDir } = await setup((f, attempt) =>
      f === 'F01' && attempt === 1 ? { files: { 'src/greet.sh': 'echo hi\n' } } : solved(f));
    await until(o, () => feature(o, 'F01')?.status === 'accepted');

    assert.deepEqual(feature(o, 'F01')!.attempts.map((a) => a.status), ['failed', 'accepted']);
    assert.match(feature(o, 'F01')!.attempts[0]!.reason!, /checks failed: F01-greet/);
    const task = readFileSync(join(harnessDir, 'modules/demo/attempts/P1-F01-a2/task.md'), 'utf8');
    assert.match(task, /## The previous attempt/);
    assert.match(task, /`F01-greet` exited 1/);
    assert.match(task, /## Guidance for this attempt\n\nStub guidance after attempt 1: read the failing check first\./);
  });

  it('completes a plan with one rejected attempt and one answered question', async () => {
    const { orchestrator: o, harnessDir } = await setup(
      (f) => (f === 'F01' ? { ...solved(f), ask: 'Which greeting word should I use?' } : solved(f)),
      { manager: { reject: ['demo/P1/F02#1'], answer: 'Use hello, in lower case.' } },
    );
    await until(o, completed(o));

    const f01 = feature(o, 'F01')!;
    assert.deepEqual(f01.attempts[0]!.questions!.map((q) => [q.text, q.answer]), [['Which greeting word should I use?', 'Use hello, in lower case.']]);
    assert.equal(await o.repo.show(f01.commit!, 'answer.txt'), 'Use hello, in lower case.');

    const f02 = feature(o, 'F02')!;
    assert.deepEqual(f02.attempts.map((a) => a.status), ['failed', 'accepted']);
    assert.match(f02.attempts[0]!.reason!, /^rejected by the Manager: Stub guidance: redo demo\/P1\/F02#1/);
    assert.equal(f02.attempts[1]!.guidance, 'Stub guidance: redo demo/P1/F02#1 properly this time.');
    assert.match(readFileSync(join(harnessDir, 'modules/demo/attempts/P1-F02-a2/task.md'), 'utf8'), /## Guidance for this attempt/);

    const messages = o.store.readAll().filter((e) => e.kind === 'message').map((e) => `${e.type} ${e.from}→${e.to}`);
    assert.deepEqual(messages, [
      'QUESTION developer→manager', 'CONTINUE manager→developer', 'ACCEPT manager→daemon',
      'REJECT manager→daemon', 'ACCEPT manager→daemon', 'PLAN_SUBMITTED manager→daemon',
    ]);
  });

  it('asks the owner, holds new attempts until the answer, and passes it on', async () => {
    const { orchestrator: o } = await setup((f, attempt) => (f === 'F01' && attempt === 1 ? { files: { 'src/greet.sh': 'echo hi\n' } } : solved(f)), {
      manager: { askOwner: true },
    });
    await until(o, () => Object.keys(o.state.ownerRequests).length === 1);
    const [requestId, asked] = Object.entries(o.state.ownerRequests)[0]!;
    assert.equal(asked.question, 'How should demo/P1/F01 be done?');
    assert.equal(asked.blocking, true);
    for (let i = 0; i < 5; i++) await o.tick();
    assert.equal(feature(o, 'F01')!.attempts.length, 1, 'no new attempt while the owner has not answered');

    assert.equal(o.answerOwnerRequest(requestId, 'Print hello.'), true);
    await until(o, () => feature(o, 'F01')?.status === 'accepted');
    assert.equal(feature(o, 'F01')!.attempts[1]!.guidance, 'The owner says: Print hello.');
  });

  it('escalates after two failed attempts, and the owner can grant one more', async () => {
    let fixed = false;
    const { orchestrator: o } = await setup((f) => (f === 'F01' && !fixed ? { files: { 'src/greet.sh': 'echo nope\n' } } : solved(f)));
    await until(o, () => feature(o, 'F01')?.status === 'escalated');
    assert.equal(feature(o, 'F01')!.attempts.length, 2);

    fixed = true;
    assert.equal(o.retry('demo/P1/F01', 'Print exactly hello.'), true);
    await until(o, () => feature(o, 'F01')?.status === 'accepted');
    assert.equal(feature(o, 'F01')!.attempts.length, 3);
    assert.equal(feature(o, 'F01')!.attempts[2]!.guidance, 'Print exactly hello.');
  });

  it('pauses the pipeline after too many failures in a row', async () => {
    const { orchestrator: o } = await setup(() => ({ files: { 'src/greet.sh': 'echo nope\n' } }), { config: { brakes: { consecutiveFailures: 2 } } });
    await until(o, () => o.state.pipeline.paused !== undefined);
    assert.equal(o.state.pipeline.paused!.reason, '2 attempts failed in a row');
    assert.equal(feature(o, 'F01')!.attempts.length, 2);

    assert.equal(o.resume(), true);
    await until(o, () => feature(o, 'F01')?.status === 'escalated');
  });

  it('pauses, without counting the attempt, when Claude Code does not start', async () => {
    const { orchestrator: o } = await setup((f, attempt) => (f === 'F01' && attempt === 1 ? { crashAtStart: true } : solved(f)));
    await until(o, () => o.state.pipeline.paused !== undefined);
    assert.match(o.state.pipeline.paused!.reason, /^environment: Claude Code did not start: Error: unknown option --stub-bad-flag/);
    assert.equal(feature(o, 'F01')!.attempts[0]!.status, 'interrupted');
    assert.equal(feature(o, 'F01')!.attempts[0]!.counts, false);

    o.resume();
    await until(o, completed(o));
  });

  it('fails an attempt that changes a protected file', async () => {
    const { orchestrator: o } = await setup((f, attempt) =>
      attempt === 1 ? { files: { ...SOLUTIONS.F01, 'harness/modules/demo/checks/F01.sh': 'true\n' } } : solved(f));
    await until(o, () => feature(o, 'F01')?.status === 'accepted');
    assert.equal(feature(o, 'F01')!.attempts[0]!.reason, 'changed protected files: harness/modules/demo/checks/F01.sh');
  });

  it('records a blocked report as a failed attempt carrying its finding', async () => {
    const { orchestrator: o } = await setup((f, attempt) => (attempt === 1 ? { outcome: 'blocked', commit: false } : solved(f)));
    await until(o, () => feature(o, 'F01')?.status === 'accepted');
    assert.equal(feature(o, 'F01')!.attempts[0]!.reason, 'blocked: stub cannot proceed');
  });

  it("keeps what an attempt's sandbox policy refused, for its card and the Manager's guidance", async () => {
    const refused = ['pypi.org:443', 'pypi.org:443', 'example.com:443'];
    const { orchestrator: o } = await setup((f, attempt) => (f === 'F01' && attempt === 1 ? { outcome: 'blocked', commit: false, refused } : solved(f)));
    const sent: string[] = [];
    o.events.on('transcript', ({ agent, line }: { agent: string; line: string }) => {
      try {
        const item = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
        if (agent === 'manager:demo' && item.type === 'user' && typeof item.message?.content === 'string') sent.push(item.message.content);
      } catch {
        // Not a line of JSON.
      }
    });
    await until(o, () => feature(o, 'F01')?.status === 'accepted');
    const [first, second] = feature(o, 'F01')!.attempts;
    const kept = first!.refused!.map((d) => [d.program, d.target, d.count]).sort((a, b) => String(a[1]).localeCompare(String(b[1])));
    assert.deepEqual(kept, [['/usr/bin/node', 'example.com:443', 1], ['/usr/bin/node', 'pypi.org:443', 2]]);
    assert.equal(second!.refused, undefined, 'nothing refused, nothing kept');
    const failed = sent.find((text) => text.startsWith('[harness] ATTEMPT FAILED demo/P1/F01 attempt 1'));
    assert.ok(failed, `the Manager was sent the failure; it got: ${sent.map((t) => t.split('\n')[0]).join(' | ')}`);
    assert.match(failed, /\nIts sandbox's network policy refused:\n/);
    assert.match(failed, /\n- pypi\.org:443 from \/usr\/bin\/node, 2 times: transparent tcp policy denied\n/);
    assert.match(failed, /\n- example\.com:443 from \/usr\/bin\/node, 1 time: transparent tcp policy denied\n/);
    assert.match(failed, /If it can't, ask_owner to allow the host, with blocking: true when no attempt can succeed without it: only the owner widens the policy\.$/m);
    assert.doesNotMatch(failed, /escalate_to_architect/);
  });

  it('keeps no git bundle once a sandbox has its copy, and deletes those earlier versions left when it starts', async () => {
    const old = ['demo/attempts/P1-F01-a1/plan.bundle', 'demo/attempts/P1-F01-a1/candidate.bundle', 'demo/reviews/P1-security-0123abcd/plan.bundle'];
    const { orchestrator: o, harnessDir } = await setup((f) => solved(f), {
      prepare: async (dir) => {
        for (const file of old) {
          mkdirSync(join(dir, '.harness', 'modules', file, '..'), { recursive: true });
          writeFileSync(join(dir, '.harness', 'modules', file), 'a bundle an earlier version kept');
        }
        writeFileSync(join(dir, '.harness', 'modules', 'demo', 'attempts', 'P1-F01-a1', 'stream.jsonl'), '{}\n');
      },
    });
    assert.deepEqual(bundlesIn(harnessDir), []);
    assert.ok(existsSync(join(harnessDir, 'modules', 'demo', 'attempts', 'P1-F01-a1', 'stream.jsonl')), 'only bundles go');
    await until(o, completed(o));
    assert.deepEqual(bundlesIn(harnessDir), []);
    assert.equal(o.state.features['demo/P1/F02']!.status, 'accepted', 'the commits came back through their bundles');
  });

  it("deletes its left-over sandboxes when it starts and every hour, never an Architect's or another project's", async () => {
    let skew = 0;
    const { orchestrator: o, driver } = await setup((f) => solved(f), { now: () => Date.now() + skew });
    const spec = (name: string, project?: string) => ({ name, image: 'x', providers: [], env: {}, ...(project ? { labels: { 'harness.project': project } } : {}) });
    for (const [name, project] of [['dev-0000aaaa-a9', 'toy'], ['arc-0000bbbb', 'toy'], ['dev-1111cccc-a1', 'elsewhere'], ['prb-12345678', undefined]] as const) await driver.create(spec(name, project));
    await o.tick();
    const status = async (names: string[]) => Promise.all(names.map(async (name) => [name, await driver.status(name)]));
    assert.deepEqual(await status(['dev-0000aaaa-a9', 'arc-0000bbbb', 'dev-1111cccc-a1', 'prb-12345678']), [
      ['dev-0000aaaa-a9', 'missing'], ['arc-0000bbbb', 'ready'], ['dev-1111cccc-a1', 'ready'], ['prb-12345678', 'ready'],
    ]);
    // One left within the hour waits for the next sweep.
    await driver.create(spec('chk-2222dddd-a1', 'toy'));
    await o.tick();
    assert.equal(await driver.status('chk-2222dddd-a1'), 'ready');
    skew += 61 * 60_000;
    await o.tick();
    assert.equal(await driver.status('chk-2222dddd-a1'), 'missing');
    await until(o, completed(o));
  });

  it("opens the project's APIs, carries their keys to every sandbox, and pauses while a key isn't stored", async () => {
    const apis = [{ host: 'api.stripe.com', key: 'STRIPE_API_KEY' }, { host: 'postman-echo.com' }];
    const { orchestrator: o, driver, harnessDir } = await setup((f) => solved(f), { config: { network: { bundles: ['all'], apis } } });
    await o.tick();
    assert.match(o.state.pipeline.paused?.reason ?? '', /^no key stored on this machine for api\.stripe\.com: run `harness doctor` in a terminal, which asks for it, then resume$/);
    assert.equal(driver.created.filter((spec) => spec.name.startsWith('dev-')).length, 0, 'no attempt starts without the key');

    driver.providerNames.push('api-toy-api-stripe-com');
    assert.equal(o.resume(), true);
    await until(o, completed(o));
    const made = driver.created.filter((spec) => !spec.name.startsWith('arc-'));
    assert.ok(made.length > 0 && made.every((spec) => spec.providers.includes('api-toy-api-stripe-com')), 'every sandbox carries the key');
    const policy = JSON.parse(readFileSync(join(harnessDir, 'tmp', 'sandbox-policy.yaml'), 'utf8')) as { network_policies: Record<string, { endpoints: Array<{ host: string; access?: string }> }> };
    assert.deepEqual(policy.network_policies.third_party_apis!.endpoints.map((e) => [e.host, e.access]), [['postman-echo.com', 'full']]);
    assert.ok(policy.network_policies.read_only_web!.endpoints.some((e) => e.host === 'pypi.org'), 'every bundle');
  });

  it('escalates a feature whose checks pass before anything is built', async () => {
    const { orchestrator: o } = await setup((f) => solved(f), {
      prepare: async (dir) => {
        writeFileSync(join(dir, 'harness/modules/demo/checks/F01.sh'), 'true\n');
        await runOk('git', ['-C', dir, '-c', 'user.name=o', '-c', 'user.email=o@test.invalid', 'commit', '--quiet', '-am', 'weak check']);
      },
    });
    await until(o, () => feature(o, 'F01')?.status === 'escalated');
    assert.match(feature(o, 'F01')!.escalation!, /checks pass before anything is built/);
    assert.equal(feature(o, 'F01')!.attempts[0]!.counts, false);
  });

  it('picks up a running attempt after the daemon restarts', async () => {
    const { orchestrator: first, make } = await setup((f) => ({ ...solved(f), sleepSec: 2 }));
    await until(first, () => feature(first, 'F01')?.attempts[0]?.status === 'running');
    await first.stop();

    const second = make();
    await second.start();
    assert.equal(feature(second, 'F01')!.attempts[0]!.status, 'running');
    await until(second, completed(second));
    assert.equal(feature(second, 'F01')!.attempts.length, 1);
    assert.equal(second.store.readAll().filter((e) => e.type === 'DAEMON_STARTED').length, 2);
    assert.equal(second.state.managers.demo!.launch, 1, 'the Manager kept running through the restart');
  });
});

describe('manager', () => {
  it('is relaunched in the same conversation when it exits', async () => {
    const { orchestrator: o } = await setup((f) => solved(f), { manager: { exitAfter: 1 } });
    await until(o, completed(o));
    const launches = o.store.readAll().filter((e) => e.type === 'MANAGER_LAUNCHED').length;
    assert.equal(launches, 2);
    assert.equal(o.state.managers.demo!.exits.length, 1);
  });

  it("records its tokens from the conversations in its sandbox, at the latest before the sandbox goes", async () => {
    const { orchestrator: o, driver } = await setup((f) => solved(f));
    await until(o, () => o.state.managers.demo !== undefined && existsSync(driver.rootOf(o.state.managers.demo.sandbox)));
    const dir = join(driver.rootOf(o.state.managers.demo!.sandbox), '.claude', 'projects', '-sandbox-work');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session.jsonl'), `${JSON.stringify({ type: 'assistant', message: { id: 'msg_1', usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 95, output_tokens: 12 } } })}\n`);
    await until(o, completed(o));
    assert.equal(o.state.managers.demo!.status, 'stopped');
    assert.deepEqual(o.state.agentTokens?.['manager:demo']?.total, { inputTokens: 100, outputTokens: 12, cacheReadTokens: 95, splitInputTokens: 100, activeMs: 0 });
  });

  it('pauses the pipeline when it never starts', async () => {
    const { orchestrator: o } = await setup((f) => solved(f), { manager: { failStart: true } });
    await until(o, () => o.state.pipeline.paused !== undefined);
    assert.match(o.state.pipeline.paused!.reason, /^environment: the Manager of demo did not start: Error: unknown option --stub-bad-flag/);
  });

  it('gets a reminder after a turn without a decision, then the pipeline pauses', async () => {
    let skew = 0;
    const { orchestrator: o } = await setup((f) => solved(f), { manager: { ignore: ['REVIEW', 'REMINDER'] }, now: () => Date.now() + skew });
    await until(o, () => o.state.managers.demo?.sent['review:demo/P1/F01#1'] !== undefined);

    // The default turn is 90 minutes (v3 §4.4): a reminder after one, a pause after two.
    skew = 91 * 60_000;
    await until(o, () => o.state.managers.demo?.sent['review:demo/P1/F01#1']?.reminded !== undefined);
    assert.equal(o.state.pipeline.paused, undefined);
    skew = 182 * 60_000;
    await until(o, () => o.state.pipeline.paused !== undefined);
    assert.equal(o.state.pipeline.paused!.reason, 'the Manager has not acted on the review of demo/P1/F01 attempt 1 for 180 minutes');
  });

  it('refuses tool calls that break the rules, and says why', async () => {
    const { orchestrator: o } = await setup((f) => ({ ...solved(f), sleepSec: 30 }));
    await until(o, () => feature(o, 'F01')?.attempts[0]?.status === 'running');
    const manager = { role: 'manager' as const, sandbox: 'mgr-x', module: 'demo' };
    const call = (tool: string, args: Record<string, unknown>, agent: { role: 'developer' | 'manager'; sandbox: string; module?: string } = manager) =>
      handleRequest(o, agent, { v: 1, id: `r-${Math.random().toString(36).slice(2)}`, tool, args });

    assert.match((await call('accept_feature', { feature: 'demo/P1/F01', attempt: 1 }))!.text, /is running, not waiting for a review/);
    assert.match((await call('accept_feature', { feature: 'other/P1/F01', attempt: 1 }))!.text, /has no attempt 1 in your module/);
    assert.match((await call('reject_feature', { feature: 'demo/P1/F01', attempt: 1, guidance: 'no' }))!.text, /Invalid arguments/);
    assert.match((await call('retry_feature', { feature: 'demo/P1/F01', guidance: 'Read the check before you start writing.' }))!.text, /not waiting for guidance/);
    assert.match((await call('submit_plan', { plan: 'demo/P1', summary: 'x' }))!.text, /Submit it once every feature is accepted/);
    assert.match((await call('accept_feature', { feature: 'demo/P1/F01', attempt: 1 }, { role: 'developer', sandbox: 'dev-x' }))!.text, /not one of your tools/);
    assert.match((await call('ask_manager', { question: 'May I?' }, { role: 'developer', sandbox: 'dev-not-this-one' }))!.text, /no longer running/);

    const read = (await call('web_read', { url: 'https://example.com/docs' }))!;
    assert.equal(read.text, 'the page at https://example.com/docs');
    assert.equal(o.store.readAll().filter((e) => e.type === 'WEB_READ').length, 1);

    const aborted = (await call('abort_attempt', { feature: 'demo/P1/F01', attempt: 1, reason: 'It cannot work.' }))!;
    assert.equal(aborted.ok, true);
    await until(o, () => feature(o, 'F01')?.attempts[0]?.status === 'failed');
    assert.equal(feature(o, 'F01')!.attempts[0]!.reason, 'stopped by the Manager: It cannot work.');
  });
});

describe('parallel features', () => {
  /** The toy plan with F02 independent of F01, and with a third feature when asked. */
  const independent = (third = false) => async (dir: string) => {
    const file = join(dir, 'harness/modules/demo/plans/P1.json');
    const design = JSON.parse(readFileSync(file, 'utf8')) as { features: Array<Record<string, unknown>> };
    for (const feature of design.features) delete feature.dependsOn;
    if (third) {
      design.features.push({
        id: 'F03', title: 'Three', description: 'src/three.txt exists.', expected: 'The file exists.',
        checks: [{ id: 'F03-file', run: 'test -f src/three.txt', phase: 'pre-merge', timeoutSec: 30 }],
      });
    }
    writeFileSync(file, JSON.stringify(design, null, 2));
    await runOk('git', ['-C', dir, '-c', 'user.name=o', '-c', 'user.email=o@test.invalid', 'commit', '--quiet', '-am', 'independent features']);
  };
  const files = (feature: string): Record<string, string> => (feature === 'F03' ? { 'src/three.txt': '3\n' } : SOLUTIONS[feature as keyof typeof SOLUTIONS]);

  /** Ticks until `done`, and reports the most attempts seen under way at once. */
  async function untilMax(o: Orchestrator, done: () => boolean): Promise<number> {
    let max = 0;
    const deadline = Date.now() + 60_000;
    while (!done()) {
      if (Date.now() > deadline) throw new Error(`timed out; last events: ${o.store.readAll().slice(-8).map((e) => e.type).join(', ')}`);
      await o.tick();
      max = Math.max(max, activeAttempts(o.state).length);
      await sleep(100);
    }
    await o.tick();
    return max;
  }

  it('in Swarm, independent features build at once, and the later one lands on the new head once its checks ran again', async () => {
    const { orchestrator: o } = await setup((f) => ({ files: files(f), sleepSec: f === 'F01' ? 3 : 0 }), { prepare: independent() });
    o.setMode('swarm');
    const max = await untilMax(o, completed(o));
    assert.equal(max, 2);

    const f01 = feature(o, 'F01')!;
    const f02 = feature(o, 'F02')!;
    assert.equal(f02.status, 'accepted');
    assert.equal(f01.status, 'accepted');
    // F02 landed first; F01 was merged with the new head, checked again, and landed as one commit on it.
    assert.ok(f01.attempts[0]!.rebased, 'F01 was rebased');
    assert.equal(f01.attempts[0]!.rebased!.onto, f02.commit);
    assert.deepEqual(o.store.readAll().filter((e) => e.type === 'ATTEMPT_REBASED').map((e) => e.ref!.feature), ['F01']);
    const head = o.state.plans['demo/P1']!.head;
    assert.equal((await o.repo.commitInfo(head)).parents.length, 1);
    assert.equal(head, f01.commit);
    const progress = (await o.repo.show(head, 'progress.txt'))!;
    assert.match(progress, /feature\.accepted demo\/P1\/F02 .*\n.*feature\.accepted demo\/P1\/F01 /);
    assert.equal(await o.repo.show(head, 'src/greet.sh'), SOLUTIONS.F01['src/greet.sh']);
    assert.equal(await o.repo.show(head, 'src/add.sh'), SOLUTIONS.F02['src/add.sh']);
  });

  it('in Swarm, an attempt that conflicts with work landed meanwhile is interrupted, and the next starts from the new head', async () => {
    const decide = (f: string): StubBehavior => (f === 'F01'
      ? { files: { ...files('F01'), 'src/shared.txt': 'one\n' }, sleepSec: 3 }
      : { files: { ...files('F02'), 'src/shared.txt': 'two\n' } });
    const { orchestrator: o } = await setup(decide, { prepare: independent() });
    o.setMode('swarm');
    await until(o, completed(o), 60_000);

    const f01 = feature(o, 'F01')!;
    assert.equal(f01.attempts.length, 2);
    assert.equal(f01.attempts[0]!.status, 'interrupted');
    assert.equal(f01.attempts[0]!.counts, false);
    assert.match(f01.attempts[0]!.reason!, /^conflicts with work landed on plan\/demo\/P1 meanwhile, in src\/shared\.txt: the next attempt starts from the new head$/);
    assert.equal(f01.attempts[1]!.status, 'accepted');
    assert.equal(f01.attempts[1]!.base, feature(o, 'F02')!.commit);
    assert.equal(await o.repo.show(o.state.plans['demo/P1']!.head, 'src/shared.txt'), 'one\n');
  });

  it('in Manual, features build one at a time even without dependencies', async () => {
    const { orchestrator: o } = await setup((f) => ({ files: files(f), sleepSec: 1 }), { prepare: independent() });
    const max = await untilMax(o, completed(o));
    assert.equal(max, 1);
    assert.equal(o.store.readAll().some((e) => e.type === 'ATTEMPT_REBASED'), false);
  });

  it('in Swarm, a design change that redefines a feature under way interrupts its attempt, and the next builds the new definition', async () => {
    const { orchestrator: o, harnessDir } = await setup((f) => ({ files: files(f), sleepSec: f === 'F01' ? 6 : 0 }), { prepare: independent() });
    const projectDir = join(harnessDir, '..');
    o.setMode('swarm');
    await untilMax(o, () => activeAttempts(o.state).length === 2);
    const first = feature(o, 'F01')!.attempts[0]!;

    // The owner commits a design change on main while F01 is built: F01's definition changes, F02's doesn't.
    const file = join(projectDir, 'harness/modules/demo/plans/P1.json');
    const design = JSON.parse(readFileSync(file, 'utf8')) as { features: Array<Record<string, unknown>> };
    design.features[0]!.description = 'src/greet.sh prints hello, politely.';
    writeFileSync(file, JSON.stringify(design, null, 2));
    await runOk('git', ['-C', projectDir, '-c', 'user.name=o', '-c', 'user.email=o@test.invalid', 'commit', '--quiet', '-am', 'redefine F01']);
    await until(o, completed(o), 60_000);

    const f01 = feature(o, 'F01')!;
    assert.equal(f01.attempts.length, 2);
    assert.equal(f01.attempts[0]!.status, 'interrupted');
    assert.equal(f01.attempts[0]!.counts, false);
    assert.equal(f01.attempts[0]!.reason, 'the design changed this feature while it was built: the next attempt builds the new definition');
    assert.notEqual(f01.attempts[1]!.definitionHash, first.definitionHash);
    assert.equal(f01.attempts[1]!.status, 'accepted');
    assert.equal(feature(o, 'F02')!.attempts.length, 1);
    assert.ok(o.store.readAll().some((e) => e.type === 'PLAN_MAIN_MERGED'));
  });

  it('in Swarm, swarm.maxDevelopers caps the attempts under way', async () => {
    const { orchestrator: o } = await setup((f) => ({ files: files(f), sleepSec: 2 }), { prepare: independent(true), config: { swarm: { maxDevelopers: 2 } } });
    o.setMode('swarm');
    const max = await untilMax(o, completed(o));
    assert.equal(max, 2);
    assert.deepEqual(['F01', 'F02', 'F03'].map((f) => feature(o, f)!.status), ['accepted', 'accepted', 'accepted']);
  });
});

describe('parallel plans', () => {
  /** The toy design split in two plans, P1 greets and P2 adds, and a third when asked; `p2` sets P2's dependencies. */
  const split = (p2: { dependsOn?: string[]; featureDependsOn?: string[] } = {}, third = false) => async (dir: string) => {
    const plans = join(dir, 'harness/modules/demo/plans');
    const file = join(plans, 'P1.json');
    const design = JSON.parse(readFileSync(file, 'utf8')) as { features: Array<Record<string, unknown>>; [key: string]: unknown };
    const [f01, f02] = design.features as [Record<string, unknown>, Record<string, unknown>];
    delete f02.dependsOn;
    if (p2.featureDependsOn) f02.dependsOn = p2.featureDependsOn;
    writeFileSync(file, JSON.stringify({ ...design, features: [f01] }, null, 2));
    writeFileSync(join(plans, 'P2.json'), JSON.stringify({ ...design, id: 'P2', title: 'Adding', ...(p2.dependsOn ? { dependsOn: p2.dependsOn } : {}), features: [f02] }, null, 2));
    if (third) {
      const f03 = { id: 'F03', title: 'Three', description: 'src/three.txt exists.', expected: 'The file exists.', checks: [{ id: 'F03-file', run: 'test -f src/three.txt', phase: 'pre-merge', timeoutSec: 30 }] };
      writeFileSync(join(plans, 'P3.json'), JSON.stringify({ ...design, id: 'P3', title: 'Three', dependsOn: [], features: [f03] }, null, 2));
    }
    await runOk('git', ['-C', dir, 'add', '-A']);
    await runOk('git', ['-C', dir, '-c', 'user.name=o', '-c', 'user.email=o@test.invalid', 'commit', '--quiet', '-m', 'plans']);
  };
  const files = (feature: string): Record<string, string> => (feature === 'F03' ? { 'src/three.txt': '3\n' } : SOLUTIONS[feature as keyof typeof SOLUTIONS]);
  const allComplete = (o: Orchestrator, plans: string[]) => () => plans.every((p) => o.state.plans[`demo/${p}`]?.status === 'completed');

  /** Ticks until `done`, and reports the most plans seen in flight at once. */
  async function untilMaxPlans(o: Orchestrator, done: () => boolean, timeoutMs = 60_000): Promise<number> {
    let max = 0;
    const deadline = Date.now() + timeoutMs;
    while (!done()) {
      if (Date.now() > deadline) throw new Error(`timed out; last events: ${o.store.readAll().slice(-8).map((e) => e.type).join(', ')}`);
      await o.tick();
      max = Math.max(max, Object.values(o.state.plans).filter((p) => p.status !== 'completed').length);
      await sleep(100);
    }
    await o.tick();
    return max;
  }
  const index = (o: Orchestrator, type: string, plan: string) => o.store.readAll().findIndex((e) => e.type === type && e.ref?.plan === plan);

  it('in Swarm, independent plans build at once, each with its own Manager', async () => {
    const { orchestrator: o } = await setup((f) => ({ files: files(f), sleepSec: f === 'F01' ? 3 : 0 }), { prepare: split({ dependsOn: [] }) });
    o.setMode('swarm');
    const max = await untilMaxPlans(o, allComplete(o, ['P1', 'P2']));
    assert.equal(max, 2);
    assert.ok(index(o, 'PLAN_STARTED', 'P2') < index(o, 'PLAN_COMPLETED', 'P1'), 'P2 started before P1 was complete');
    assert.deepEqual(Object.values(o.state.managers).map((m) => [m.module, m.plan, m.status]).sort(), [['demo', 'P1', 'stopped'], ['demo', 'P2', 'stopped']]);
    assert.deepEqual(Object.keys(o.state.managers).sort(), ['demo/P1', 'demo/P2']);
  });

  it('in Swarm, a plan waits for the plan it depends on to merge, and starts from the main that holds it', async () => {
    const { orchestrator: o, fake } = await setup((f) => solved(f), { github: true, prepare: split(), config: { swarm: { requiredStatuses: [] } } });
    o.setMode('swarm');
    const max = await untilMaxPlans(o, allComplete(o, ['P1', 'P2']), 90_000);
    assert.equal(max, 1);
    const merged = index(o, 'PR_MERGED', 'P1');
    assert.ok(merged !== -1 && merged < index(o, 'PLAN_STARTED', 'P2'), 'P2 started after P1 merged');
    assert.equal(o.state.plans['demo/P2']!.base, o.state.plans['demo/P1']!.mergeCommit);
    assert.equal(fake.prs.length, 2);
    assert.equal(o.state.plans['demo/P2']!.mergedBy, 'daemon');
  });

  it("in Swarm, a feature that depends on an earlier plan's feature waits for that plan to merge, and builds on it", async () => {
    const { orchestrator: o } = await setup((f) => ({ files: files(f), sleepSec: f === 'F01' ? 2 : 0 }), {
      github: true, prepare: split({ dependsOn: [], featureDependsOn: ['P1/F01'] }), config: { swarm: { requiredStatuses: [] } },
    });
    o.setMode('swarm');
    const max = await untilMaxPlans(o, allComplete(o, ['P1', 'P2']), 90_000);
    assert.equal(max, 2, 'P2 started alongside P1');
    const merged = index(o, 'PR_MERGED', 'P1');
    assert.ok(merged !== -1 && merged < index(o, 'ATTEMPT_STARTING', 'P2'), 'F02 started after P1 merged');
    assert.ok(merged < index(o, 'PLAN_MAIN_MERGED', 'P2'), 'main was merged into P2 after the merge of P1');
    const f02 = o.state.features['demo/P2/F02']!;
    assert.equal(await o.repo.show(f02.attempts[0]!.base, 'src/greet.sh'), SOLUTIONS.F01['src/greet.sh']);
  });

  it('in Swarm, swarm.maxPlans caps the plans in flight', async () => {
    const { orchestrator: o } = await setup((f) => ({ files: files(f), sleepSec: 1 }), { prepare: split({ dependsOn: [] }, true), config: { swarm: { maxPlans: 2 } } });
    o.setMode('swarm');
    const max = await untilMaxPlans(o, allComplete(o, ['P1', 'P2', 'P3']), 90_000);
    assert.equal(max, 2);
  });

  it('in Manual, independent plans still build one after the other, with one Manager for the module', async () => {
    const { orchestrator: o } = await setup((f) => ({ files: files(f) }), { prepare: split({ dependsOn: [] }) });
    const max = await untilMaxPlans(o, allComplete(o, ['P1', 'P2']));
    assert.equal(max, 1);
    assert.deepEqual(Object.keys(o.state.managers), ['demo']);
    assert.equal(o.state.managers.demo!.status, 'stopped');
  });
});

describe('pull requests', () => {
  const plan = (o: Orchestrator) => o.state.plans['demo/P1'];
  const ready = (o: Orchestrator) => () => plan(o)?.status === 'ready_to_merge';

  it('opens one pull request for the plan, waits for CI and the owner, and completes on merge', async () => {
    let skew = 0;
    const { orchestrator: o, fake } = await setup((f) => solved(f), { github: true, now: () => Date.now() + skew });
    await until(o, ready(o));

    assert.equal(fake.prs.length, 1);
    const pr = fake.prs[0]!;
    assert.equal(pr.title, 'Plan: [CODE] [demo/P1] Greeting and adding');
    assert.equal(pr.branch, 'plan/demo/P1');
    assert.match(pr.body, /^Stub summary of the plan\.\n\n## Features\n\n- \*\*F01\*\* Greet: attempt 1, commit [0-9a-f]{8}\n- \*\*F02\*\* Add/);
    const pushed = (await runOk('git', ['--git-dir', fake.remote, 'rev-parse', 'refs/heads/plan/demo/P1'])).trim();
    assert.equal(pushed, plan(o)!.head);
    assert.deepEqual(plan(o)!.ci!.jobs!.map((j) => [j.name, j.conclusion]), [['verify', 'success'], ['checks', 'success']]);

    const merged = await fake.merge(1);
    skew += 120_000;
    await until(o, completed(o));
    assert.equal(plan(o)!.mergeCommit, merged);
    assert.equal(o.state.managers.demo!.status, 'stopped');
  });

  it('in Swarm, merges a CODE plan itself once CI and the required statuses pass', async () => {
    let skew = 0;
    const { orchestrator: o, fake } = await setup((f) => solved(f), { github: true, now: () => Date.now() + skew });
    assert.equal(o.setMode('swarm'), true);
    assert.equal(o.setMode('swarm'), false);
    fake.statuses = () => ({ 'harness/security': 'success', 'harness/cost': 'success' });
    await until(o, completed(o));

    assert.equal(fake.prs[0]!.title, 'Plan: [CODE] [demo/P1] Greeting and adding');
    assert.equal(plan(o)!.mergedBy, 'daemon');
    assert.equal(plan(o)!.leftToOwner, undefined);
    const main = (await runOk('git', ['--git-dir', fake.remote, 'rev-parse', 'refs/heads/main'])).trim();
    assert.equal(plan(o)!.mergeCommit, main);
    const merged = o.store.readAll().find((e) => e.type === 'PR_MERGED_BY_DAEMON');
    assert.ok(merged && merged.type === 'PR_MERGED_BY_DAEMON' && merged.payload.commit === main);
    // Switched before the plan started, so its Manager is the plan's (v3 §6.4).
    assert.equal(o.state.managers['demo/P1']!.status, 'stopped');
  });

  it('in Swarm, leaves the PR to the owner while a required status is missing, and merges once it passes', async () => {
    // A status no reviewer of the harness posts, such as an external scanner's: the daemon can only wait for it.
    let skew = 0;
    const { orchestrator: o, fake } = await setup((f) => solved(f), {
      github: true, config: { swarm: { requiredStatuses: ['harness/security', 'external/scan'] } }, now: () => Date.now() + skew,
    });
    o.setMode('swarm');
    await until(o, () => plan(o)?.leftToOwner !== undefined);
    assert.equal(plan(o)!.status, 'ready_to_merge');
    assert.match(plan(o)!.leftToOwner!.reason, /^waiting for external\/scan to pass on [0-9a-f]{8}/);
    assert.deepEqual(plan(o)!.reviews!.map((r) => [r.role, r.verdict]), [['security', 'pass']]);
    assert.equal(fake.prs[0]!.state, 'open');

    fake.statuses = () => ({ 'external/scan': 'success' });
    skew += 61_000;
    await until(o, completed(o));
    assert.equal(plan(o)!.mergedBy, 'daemon');
    assert.equal(plan(o)!.leftToOwner, undefined);
    assert.equal(o.store.readAll().filter((e) => e.type === 'PR_LEFT_TO_OWNER').length, 1);
  });

  it('in Swarm, a merge GitHub refuses is left to the owner with the setup command, and the owner can still merge', async () => {
    let skew = 0;
    const { orchestrator: o, fake } = await setup((f) => solved(f), { github: true, config: { swarm: { requiredStatuses: [] } }, now: () => Date.now() + skew });
    o.setMode('swarm');
    fake.refuseMerge = 'At least 1 approving review is required by reviewers with write access.';
    await until(o, () => plan(o)?.leftToOwner !== undefined);
    assert.match(plan(o)!.leftToOwner!.reason, /GitHub refused the merge: At least 1 approving review.*harness github-setup --repo acme\/toy/);

    await fake.merge(1);
    skew += 120_000;
    await until(o, completed(o));
    assert.equal(plan(o)!.mergedBy, 'owner');
  });

  /** The toy plan with both features `infra`: an INFRA plan. */
  const infraPlan = async (dir: string) => {
    const file = join(dir, 'harness/modules/demo/plans/P1.json');
    const design = JSON.parse(readFileSync(file, 'utf8')) as { features: Array<Record<string, unknown>> };
    for (const feature of design.features) feature.kind = 'infra';
    writeFileSync(file, JSON.stringify(design, null, 2));
    await runOk('git', ['-C', dir, '-c', 'user.name=o', '-c', 'user.email=o@test.invalid', 'commit', '--quiet', '-am', 'infra plan']);
  };

  it('in Swarm, an INFRA plan waits for the owner without a cost estimate, and in Manual every plan does', async () => {
    let skew = 0;
    const { orchestrator: o, fake } = await setup((f) => solved(f), { github: true, prepare: infraPlan, now: () => Date.now() + skew });
    o.setMode('swarm');
    fake.statuses = () => ({ 'harness/security': 'success', 'harness/cost': 'success' });
    await until(o, () => plan(o)?.leftToOwner !== undefined);
    assert.equal(fake.prs[0]!.title, 'Plan: [INFRA] [demo/P1] Greeting and adding');
    assert.match(plan(o)!.leftToOwner!.reason, /^an INFRA plan merges itself only with the cost job's estimate .* none was produced: the cost job needs iac\/ and the INFRACOST_API_KEY secret; the dashboard's button lets the daemon merge infra once CI and the reviewers pass$/);

    o.setMode('manual');
    skew += 61_000;
    await until(o, () => o.state.mode === 'manual');
    await o.tick();
    assert.equal(fake.prs[0]!.state, 'open');
    await fake.merge(1);
    skew += 120_000;
    await until(o, completed(o));
    assert.equal(plan(o)!.mergedBy, 'owner');
  });

  it("in Swarm, an INFRA plan merges itself under the ceiling with the cost job's estimate, and waits for the owner over it", async () => {
    const costJob = (monthly: string) => () => ({ cost: { 'cost.json': JSON.stringify({ totalMonthlyCost: '212.4', diffTotalMonthlyCost: monthly }) } });
    const over = await setup((f) => solved(f), { github: true, prepare: infraPlan });
    over.orchestrator.setMode('swarm');
    over.fake.statuses = () => ({ 'harness/security': 'success', 'harness/cost': 'success' });
    over.fake.artifacts = costJob('80.25');
    await until(over.orchestrator, () => plan(over.orchestrator)?.leftToOwner !== undefined);
    assert.deepEqual(plan(over.orchestrator)!.costEstimate, { head: plan(over.orchestrator)!.pushed, monthlyUsd: 80.25 });
    assert.equal(plan(over.orchestrator)!.leftToOwner!.reason, 'the PR adds an estimated 80.25 USD a month, over the ceiling of 50 (swarm.merge.infraMonthlyUsdCeiling)');

    const under = await setup((f) => solved(f), { github: true, prepare: infraPlan });
    under.orchestrator.setMode('swarm');
    under.fake.statuses = () => ({ 'harness/security': 'success', 'harness/cost': 'success' });
    under.fake.artifacts = costJob('12.5');
    await until(under.orchestrator, completed(under.orchestrator));
    const merged = plan(under.orchestrator)!;
    assert.equal(merged.mergedBy, 'daemon');
    assert.equal(merged.costEstimate!.monthlyUsd, 12.5);
    // The cost reviewer read the estimate in its brief.
    const brief = readFileSync(join(under.harnessDir, 'modules', 'demo', 'reviews', `P1-cost-${merged.pushed!.slice(0, 8)}`, 'brief.md'), 'utf8');
    assert.match(brief, /Infracost estimates that the change adds 12\.5 USD a month in AWS resources; the merge policy's ceiling is 50 USD/);
  });

  it("in Swarm, the owner's button lets an INFRA plan merge itself without an estimate, and an estimate over the ceiling still waits", async () => {
    const without = await setup((f) => solved(f), { github: true, prepare: infraPlan });
    without.orchestrator.setMode('swarm');
    assert.equal(without.orchestrator.setInfraMerge('daemon'), true);
    assert.equal(without.orchestrator.setInfraMerge('daemon'), false);
    without.fake.statuses = () => ({ 'harness/security': 'success', 'harness/cost': 'success' });
    await until(without.orchestrator, completed(without.orchestrator));
    assert.equal(plan(without.orchestrator)!.mergedBy, 'daemon');
    assert.equal(plan(without.orchestrator)!.costEstimate, undefined);

    const over = await setup((f) => solved(f), { github: true, prepare: infraPlan });
    over.orchestrator.setMode('swarm');
    over.orchestrator.setInfraMerge('daemon');
    over.fake.statuses = () => ({ 'harness/security': 'success', 'harness/cost': 'success' });
    over.fake.artifacts = () => ({ cost: { 'cost.json': JSON.stringify({ diffTotalMonthlyCost: '99' }) } });
    await until(over.orchestrator, () => plan(over.orchestrator)?.leftToOwner !== undefined);
    assert.equal(plan(over.orchestrator)!.leftToOwner!.reason, 'the PR adds an estimated 99 USD a month, over the ceiling of 50 (swarm.merge.infraMonthlyUsdCeiling)');
    // Taking the merges back lets the plan wait for the owner for the usual reason once the estimate is under the ceiling, too.
    over.orchestrator.setInfraMerge('ceiling');
    assert.equal(over.orchestrator.state.infraMerge, 'ceiling');
  });

  it('in Swarm, starts no attempt at or above the usage ceiling an agent reported, and goes on once the window resets', async () => {
    let skew = 0;
    // Ten minutes away: well under the Manager's turn, which event times would trip.
    const resetsAt = Math.floor((Date.now() + 10 * 60_000) / 1000);
    const { orchestrator: o } = await setup((f) => solved(f), { now: () => Date.now() + skew });
    // A model call of the Manager's reported 85% of the week.
    o.events.emit('transcript', { agent: 'manager:demo', line: rateLimitEvent({ five_hour: 0.2, seven_day: 0.85 }, resetsAt) });
    o.setMode('swarm');
    await until(o, () => o.state.pipeline.paused !== undefined);
    assert.equal(o.state.pipeline.paused!.reason, "the subscription's usage is at 85% in the weekly window, at or above the 80% ceiling (swarm.usageCeilingPercent)");
    assert.equal(o.state.pipeline.paused!.until, new Date(resetsAt * 1000 + 60_000).toISOString(), 'a minute past the reset, for a clock a little ahead');
    assert.equal(Object.keys(o.state.features).length, 0);

    // At the reset itself, the window still binds: the laptop's clock may be ahead of Anthropic's.
    skew += 10 * 60_000 + 1000;
    for (let i = 0; i < 3; i++) await o.tick();
    assert.equal(Object.keys(o.state.features).length, 0);
    // A minute later the report no longer binds, the pause lifts, and the build goes on, with no new report.
    skew += 60_000;
    await until(o, completed(o));
  });

  it("takes the usage from the agents' reports in either mode, ignores other lines, and keeps it across a restart", async () => {
    const { orchestrator: o, make } = await setup((f) => solved(f));
    let announced = 0;
    o.events.on('usage', () => announced++);
    const resetsAt = Math.floor((Date.now() + 3 * 3_600_000) / 1000);
    o.events.emit('transcript', { agent: 'developer:demo/P1/F01/a1', line: JSON.stringify({ type: 'assistant', message: { content: [] } }) });
    o.events.emit('transcript', { agent: 'developer:demo/P1/F01/a1', line: 'not json, with "rate_limit_event" in it' });
    assert.equal(o.usage, undefined);
    o.events.emit('transcript', { agent: 'cost:abcd1234', line: rateLimitEvent({ five_hour: 0.42, seven_day: 0.57 }, resetsAt) });
    assert.deepEqual(o.usage!.usage.limits.map((l) => [l.kind, l.percent]), [['session', 42], ['weekly_all', 57]]);
    assert.equal(announced, 1, 'the pages hear of it');
    await o.stop(0);
    const restarted = make();
    assert.deepEqual(restarted.usage, o.usage, 'a restart shows the last report at once');
  });

  it("takes no report from the lines a stream held before the daemon followed it, as after a restart, but the next", async () => {
    const { orchestrator: o, driver } = await setup((f) => solved(f));
    const resetsAt = Math.floor((Date.now() + 3 * 3_600_000) / 1000);
    await driver.create({ name: 'mgr-replay', image: 'x', providers: [], env: {} });
    const file = join(driver.rootOf('mgr-replay'), 'out.jsonl');
    // Written before the restart: a session window the plan no longer has.
    writeFileSync(file, `${rateLimitEvent({ five_hour: 0.95, seven_day: 0.3 }, resetsAt)}\n`);
    const lines: Array<{ line: string; replay?: boolean }> = [];
    o.events.on('transcript', (event: { line: string; replay?: boolean }) => lines.push(event));
    const settle = async (done: () => boolean) => {
      for (let i = 0; i < 200 && !done(); i++) await sleep(25);
      assert.ok(done());
    };
    const follower = o.followStream('mgr-replay', file, 'manager:replay');
    await settle(() => lines.length === 1);
    assert.equal(lines[0]!.replay, true, 'the transcript still gets it');
    assert.equal(o.usage, undefined);
    // Written after: a plan without a session limit, the weekly window alone.
    appendFileSync(file, `${JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.31, resetsAt, status: 'allowed' } } } })}\n`);
    await settle(() => o.usage !== undefined);
    assert.deepEqual(o.usage!.usage.limits.map((l) => [l.kind, l.percent]), [['weekly_all', 31]]);
    follower.stop();
    await follower.done;
  });

  it('in Swarm, both reviewers read the head, their verdicts are posted and set as statuses, and the plan merges itself', async () => {
    const { orchestrator: o, fake, harnessDir } = await setup((f) => solved(f), { github: true });
    o.setMode('swarm');
    await until(o, completed(o));
    assert.deepEqual(bundlesIn(harnessDir), [], "the reviewers' and the Managers' bundles are gone too");

    const head = plan(o)!.pushed!;
    assert.deepEqual(plan(o)!.reviews!.map((r) => [r.role, r.head === head, r.status, r.verdict, r.posted?.status]), [
      ['security', true, 'reported', 'pass', 'success'],
      ['cost', true, 'reported', 'pass', 'success'],
    ]);
    assert.deepEqual(fake.reviews.map((r) => [r.number, r.body.split('\n')[0], r.comments.length]), [
      [1, `## Security review of ${head.slice(0, 8)}: pass`, 0],
      [1, `## Cost review of ${head.slice(0, 8)}: pass`, 0],
    ]);
    assert.deepEqual(fake.statusesSet.map((s) => [s.sha === head, s.context, s.state, s.description]), [
      [true, 'harness/security', 'success', 'passed'],
      [true, 'harness/cost', 'success', 'passed'],
    ]);
    assert.equal(plan(o)!.mergedBy, 'daemon');
  });

  it('in Swarm, a blocking review opens a fix round with the findings, and the next head passes and merges', async () => {
    const finding = { file: 'src/greet.sh', line: 1, severity: 'blocking' as const, title: 'Shell injection', detail: 'Quote the argument before it reaches the shell.' };
    const review: ReviewBehavior = (role, rounds) => (role === 'security' && rounds === 0
      ? { verdict: 'block', summary: 'One injection.', findings: [finding, { severity: 'advisory', title: 'No tests', detail: 'Add one.' }] }
      : { verdict: 'pass', summary: 'Fixed.', findings: [] });
    const { orchestrator: o, fake } = await setup((f) => (f === 'fix1' ? { files: { 'src/greet.sh': 'echo "hello"\n' } } : solved(f)), { github: true, review });
    o.setMode('swarm');
    await until(o, completed(o));

    const fix = o.state.features['demo/P1/fix1']!;
    assert.deepEqual([fix.fix!.kind, fix.fix!.role, fix.fix!.round, fix.status], ['review', 'security', 1, 'accepted']);
    assert.match(fix.attempts[0]!.guidance!, /^- Shell injection \(src\/greet\.sh:1\): Quote the argument/);
    assert.match(fix.fix!.failure, /^The security reviewer blocked PR #1 \(https:\/\/github\.test\/pull\/1\) at [0-9a-f]{8}: One injection\./);
    assert.deepEqual(plan(o)!.reviewFixRounds, { security: 1 });

    const first = fake.reviews[0]!;
    assert.match(first.body, /^## Security review of [0-9a-f]{8}: block\n\nOne injection\.\n\n- \*\*\[advisory\] No tests\*\*: Add one\./);
    assert.deepEqual(first.comments, [{ path: 'src/greet.sh', line: 1, body: '**[blocking] Shell injection**\n\nQuote the argument before it reaches the shell.' }]);
    assert.deepEqual(fake.statusesSet.map((s) => [s.context, s.state, s.description]), [
      ['harness/security', 'failure', '1 blocking finding'],
      ['harness/security', 'success', 'passed'],
      ['harness/cost', 'success', 'passed'],
    ]);
    const heads = [...new Set(plan(o)!.reviews!.map((r) => r.head))];
    assert.equal(heads.length, 2);
    const log = await runOk('git', ['--git-dir', fake.remote, 'log', '--format=%s', 'main']);
    assert.match(log, /fix\(demo\/P1\): the security review, round 1/);
    assert.equal(plan(o)!.mergedBy, 'daemon');
  });

  it('in Swarm, a reviewer that keeps blocking leaves the PR to the owner once its rounds are spent', async () => {
    const review: ReviewBehavior = (role) => (role === 'security'
      ? { verdict: 'block', summary: 'Still bad.', findings: [{ severity: 'blocking', title: 'Injection', detail: 'Quote it.' }] }
      : { verdict: 'pass', summary: 'Fine.', findings: [] });
    const { orchestrator: o, fake } = await setup((f) => (f.startsWith('fix') ? { files: { 'src/note.txt': f } } : solved(f)), {
      github: true, review, config: { swarm: { securityFixRounds: 1 } },
    });
    o.setMode('swarm');
    await until(o, () => plan(o)?.leftToOwner !== undefined);
    assert.equal(plan(o)!.leftToOwner!.reason, 'the security reviewer still blocks PR #1 after 1 fix round(s): the owner decides');
    assert.match(o.state.pipeline.paused!.reason, /still blocks PR #1 after 1 fix round/);
    assert.deepEqual(plan(o)!.reviewFixRounds, { security: 1 });
    assert.equal(fake.prs[0]!.state, 'open');
  });

  it('in Manual with reviewersInManual, the reviewers comment and gate nothing', async () => {
    let skew = 0;
    const review: ReviewBehavior = (role) => (role === 'cost'
      ? { verdict: 'block', summary: 'A loop around Bedrock.', findings: [{ severity: 'blocking', title: 'Unbounded calls', detail: 'Cap it.' }] }
      : { verdict: 'pass', summary: 'Fine.', findings: [] });
    const { orchestrator: o, fake } = await setup((f) => solved(f), { github: true, review, config: { swarm: { reviewersInManual: true } }, now: () => Date.now() + skew });
    await until(o, () => plan(o)?.reviews?.filter((r) => r.posted).length === 2);
    assert.equal(plan(o)!.status, 'ready_to_merge');
    assert.equal(plan(o)!.reviewFixRounds, undefined);
    assert.deepEqual(fake.statusesSet.map((s) => [s.context, s.state]), [['harness/security', 'success'], ['harness/cost', 'failure']]);
    await fake.merge(1);
    skew += 120_000;
    await until(o, completed(o));
    assert.equal(plan(o)!.mergedBy, 'owner');
  });

  it('in Swarm, a status the App cannot set leaves the PR to the owner with the reason', async () => {
    const { orchestrator: o, fake } = await setup((f) => solved(f), { github: true });
    o.setMode('swarm');
    fake.refuseStatus = 'Resource not accessible by integration';
    await until(o, () => plan(o)?.leftToOwner !== undefined);
    assert.match(plan(o)!.leftToOwner!.reason, /^could not set harness\/security: Resource not accessible by integration/);
    assert.equal(fake.reviews.length >= 1, true);
    assert.equal(plan(o)!.reviews![0]!.posted!.status, 'error');
  });

  it('runs a fix round when CI fails, and the PR passes on the next run', async () => {
    const { orchestrator: o, fake, harnessDir } = await setup((f) => (f === 'fix1' ? { files: { 'ci-fix.txt': 'fixed\n' } } : solved(f)), { github: true });
    let first: string | undefined;
    fake.ci = (sha) => {
      first ??= sha;
      return sha === first ? { verify: 'success', checks: 'failure' } : { verify: 'success', checks: 'success' };
    };
    await until(o, ready(o));

    assert.equal(fake.prs.length, 1);
    assert.equal(plan(o)!.fixRounds, 1);
    const fix = feature(o, 'fix1')!;
    assert.equal(fix.status, 'accepted');
    assert.equal(fix.attempts[0]!.guidance, 'Stub diagnosis: the checks job fails; make it pass.');
    const task = readFileSync(join(harnessDir, 'modules/demo/attempts/P1-fix1-a1/task.md'), 'utf8');
    assert.match(task, /# Feature demo\/P1\/fix1: Fix CI, round 1/);
    assert.match(task, /- checks: failure\n```\nthe checks job failed: expected 5, got 4\n```/);
    const log = await runOk('git', ['--git-dir', o.repo.dir, 'log', '--format=%s', `${plan(o)!.base}..${plan(o)!.head}`]);
    assert.deepEqual(log.trim().split('\n'), ['fix(demo/P1): CI, round 1', 'feat(demo/P1/F02): Add', 'feat(demo/P1/F01): Greet']);
    assert.match((await o.repo.show(plan(o)!.head, 'progress.txt'))!, /fix\.accepted demo\/P1 round=1 attempt=1/);
  });

  it('pauses when CI still fails after the last fix round', async () => {
    const { orchestrator: o, fake } = await setup((f) => (f.startsWith('fix') ? { files: { 'ci-fix.txt': 'tried\n' } } : solved(f)), {
      github: true,
      config: { brakes: { ciFixRounds: 1 } },
    });
    fake.ci = () => ({ verify: 'success', checks: 'failure' });
    await until(o, () => o.state.pipeline.paused !== undefined);
    assert.equal(o.state.pipeline.paused!.reason, "CI failed on PR #1 of demo/P1 after 1 fix round(s): fix it on the PR's branch, or fix the cause and re-run CI, then resume");
    assert.equal(plan(o)!.fixRounds, 1);
  });

  it('pauses when the owner closes the pull request', async () => {
    let skew = 0;
    const { orchestrator: o, fake } = await setup((f) => solved(f), { github: true, now: () => Date.now() + skew });
    await until(o, ready(o));
    fake.close(1);
    skew += 120_000;
    await until(o, () => o.state.pipeline.paused !== undefined);
    assert.equal(o.state.pipeline.paused!.reason, 'PR #1 of demo/P1 was closed without being merged. Reopen it to go on.');
  });
});

describe('deploys', () => {
  /** The toy plan, with infrastructure in F02 and a check of the deployed result. */
  const withPostDeploy = (run: string) => async (dir: string) => {
    const file = join(dir, 'harness/modules/demo/plans/P1.json');
    const plan = JSON.parse(readFileSync(file, 'utf8')) as { features: Array<{ checks: object[] }> };
    plan.features[1]!.checks.push({ id: 'F02-live', run, phase: 'post-deploy', needs: ['aws'] });
    writeFileSync(file, JSON.stringify(plan));
    await runOk('git', ['-C', dir, '-c', 'user.name=o', '-c', 'user.email=o@test.invalid', 'commit', '--quiet', '-am', 'a post-deploy check']);
  };
  const infra = (f: string): StubBehavior => (f === 'F02' ? { files: { ...SOLUTIONS.F02, 'iac/main.tf': '# a bucket\n' } } : f.startsWith('fix') ? { files: { 'iac/fixed.tf': '# the fix\n' } } : solved(f));
  const allGreen = () => ({ verify: 'success', 'tf-plan': 'success', checks: 'success', 'tf-apply': 'success' });

  it('waits for the apply after the merge, then verifies the deploy', async () => {
    let skew = 0;
    const { orchestrator: o, fake } = await setup(infra, {
      github: true, config: { terraform: {} }, prepare: withPostDeploy('test -f src/add.sh'), now: () => Date.now() + skew,
    });
    fake.ci = allGreen;
    await until(o, () => o.state.plans['demo/P1']?.status === 'ready_to_merge');
    await fake.merge(1);
    skew += 120_000;
    await until(o, completed(o));

    const types = o.store.readAll().map((e) => e.type);
    assert.deepEqual(types.filter((t) => ['PR_MERGED', 'DEPLOYED', 'PLAN_VERIFIED'].includes(t)), ['PR_MERGED', 'DEPLOYED', 'PLAN_VERIFIED']);
    assert.deepEqual(o.state.plans['demo/P1']!.postDeploy!.results.map((r) => [r.id, r.exit]), [['F02-live', 0]]);
  });

  it('opens a Fix PR when the post-deploy checks fail, and verifies again after its merge', async () => {
    let skew = 0;
    const { orchestrator: o, fake } = await setup(infra, {
      github: true, config: { terraform: {} }, prepare: withPostDeploy('test -f iac/fixed.tf'), now: () => Date.now() + skew,
    });
    fake.ci = allGreen;
    await until(o, () => o.state.plans['demo/P1']?.status === 'ready_to_merge');
    await fake.merge(1);
    skew += 120_000;
    await until(o, () => o.state.plans['demo/P1']?.status === 'ready_to_merge' && o.state.plans['demo/P1']?.pr?.number === 2);

    const plan = o.state.plans['demo/P1']!;
    assert.equal(plan.branch, 'fix/demo/P1-1');
    assert.equal(fake.prs[1]!.title, 'Fix: [VERIFY_FAILED] [demo/P1] round 1 after the deploy');
    assert.equal(fake.prs[1]!.branch, 'fix/demo/P1-1');
    assert.match(fake.prs[1]!.body, /The post-deploy checks, run with the view-only role:\n- F02-live: exited 1/);
    const fix = feature(o, 'fix1')!;
    assert.equal(fix.fix!.kind, 'deploy');
    assert.equal(fix.attempts[0]!.guidance, 'Stub diagnosis: the deployed infrastructure is incomplete; add what the check looks for.');

    await fake.merge(2);
    skew += 120_000;
    await until(o, completed(o));
    assert.equal(o.state.plans['demo/P1']!.postDeploy!.status, 'passed');
    assert.equal(o.state.plans['demo/P1']!.deployFixRounds, 1);
  });

  it('checks a plan again by itself once its post-deploy checks change on main, without a resume', async () => {
    let skew = 0;
    const { orchestrator: o, fake } = await setup(infra, {
      github: true, config: { terraform: {} }, prepare: withPostDeploy('test -f iac/never.tf'), manager: { ignore: ['POST'] }, now: () => Date.now() + skew,
    });
    fake.ci = allGreen;
    await until(o, () => o.state.plans['demo/P1']?.status === 'ready_to_merge');
    await fake.merge(1);
    skew += 120_000;
    await until(o, () => o.state.plans['demo/P1']?.status === 'verify_failed');
    assert.ok(o.state.plans['demo/P1']!.postDeploy!.checks, 'the failure says which checks it ran');
    // Nothing changed on main: no new run.
    for (let i = 0; i < 3; i++) {
      skew += 30_000;
      await o.tick();
    }
    assert.equal(o.state.plans['demo/P1']!.status, 'verify_failed');
    assert.equal(o.state.pipeline.paused, undefined);

    // The owner fixes the check on main: the daemon sees the change, and runs the checks again by itself.
    const path = 'harness/modules/demo/plans/P1.json';
    const design = JSON.parse((await o.repo.show('refs/heads/main', path))!) as { features: Array<{ checks: Array<{ id: string; run: string }> }> };
    design.features[1]!.checks.find((c) => c.id === 'F02-live')!.run = 'test -f iac/main.tf';
    await ownerCommit(fake.remote, 'main', path, JSON.stringify(design));
    skew += 120_000;
    await until(o, completed(o));
    assert.equal(o.state.plans['demo/P1']!.postDeploy!.status, 'passed');
    assert.ok(o.store.readAll().some((e) => e.type === 'POST_DEPLOY_RECHECK'));
  });
});

describe('architect', () => {
  const shop = (behavior: Partial<ArchitectBehavior> = {}): ArchitectBehavior => ({ module: 'shop', design: toyDesign('shop'), summary: 'Greeting and adding', ...behavior });
  const module = (o: Orchestrator) => o.state.modules.shop;

  it('takes a module from its proposal to a merged Arch PR, then builds it', async () => {
    let skew = 0;
    const { orchestrator: o, fake, harnessDir } = await setup((f) => solved(f), {
      github: true, design: false, architect: shop({ decision: 'Use two scripts.' }), now: () => Date.now() + skew,
    });
    assert.equal(o.createModule('shop', 'A tiny shop'), undefined);
    assert.match(o.createModule('shop', 'again') ?? '', /already exists/);
    await until(o, () => module(o)?.status === 'proposed');
    assert.equal(readFileSync(join(harnessDir, 'modules/shop/proposals/v1.md'), 'utf8'), '# shop v1\n\nA small design.\n');

    assert.equal(o.acceptProposal('shop', 1), true);
    await until(o, () => module(o)?.status === 'in_review');
    const pr = fake.prs[0]!;
    assert.equal(pr.branch, 'arch/shop');
    assert.equal(pr.title, 'Arch: [DESIGN] [shop] Greeting and adding');
    assert.match(pr.body, /## Plans\n\n- \*\*P1\*\* Greeting and adding: F01 Greet; F02 Add/);
    assert.match(pr.body, /Every new check failed on the unbuilt repository/);
    const head = await runOk('git', ['--git-dir', fake.remote, 'log', '-1', '--format=%an|%s', 'refs/heads/arch/shop']);
    assert.equal(head.trim(), 'harness|chore(harness): hash the protected files of the shop design');
    const lock = JSON.parse(await runOk('git', ['--git-dir', fake.remote, 'show', 'refs/heads/arch/shop:harness/lock.json'])) as { entries: Array<{ path: string }> };
    assert.ok(lock.entries.some((e) => e.path === 'harness/modules/shop/plans/P1.json'));

    await fake.merge(1);
    skew += 120_000;
    await until(o, () => module(o)?.status === 'frozen');
    await until(o, () => o.state.plans['shop/P1']?.status === 'ready_to_merge');
    assert.equal(fake.prs[1]!.title, 'Plan: [CODE] [shop/P1] Greeting and adding');
    // The Architect hears of its plan's pull request in one line (v3 §6.5).
    assert.ok(module(o)!.notes.some((n) => n.text === "[digest] Plan P1's pull request #2 is open: https://github.test/pull/2."));

    // The Manager asks the Architect, and the decision comes back to it.
    const asked = await handleRequest(o, { role: 'manager', sandbox: 'mgr-x', module: 'shop' }, {
      v: 1, id: 'esc-1', tool: 'escalate_to_architect', args: { question: 'One script or two?' },
    });
    assert.equal(asked!.ok, true);
    await until(o, () => module(o)?.escalations[0]?.decision !== undefined);
    assert.equal(module(o)!.escalations[0]!.decision, 'Use two scripts.');
    assert.deepEqual(bundlesIn(harnessDir), [], "the Architect's bundles are gone too");
  });

  it('builds on a design change: the plan branch takes it, and the work it redefines starts afresh', async () => {
    const check = 'harness/modules/shop/checks/F02.sh';
    const broken = { ...toyDesign('shop'), [check]: 'test "$(bash src/add.sh 2 3)" = 6\n' };
    let skew = 0;
    const { orchestrator: o, fake } = await setup((f) => solved(f), {
      github: true, design: false, now: () => Date.now() + skew, manager: { escalate: true },
      architect: shop({ design: broken, change: { [check]: toyDesign('shop')[check]! }, decision: 'The check was wrong; Arch PR #2 fixes it.' }),
    });
    o.createModule('shop', 'A tiny shop');
    await until(o, () => module(o)?.status === 'proposed');
    o.acceptProposal('shop', 1);
    await until(o, () => module(o)?.status === 'in_review');
    await fake.merge(1);
    skew += 120_000;

    // F01 lands, and the broken check fails F02's first attempt. The Manager asks the Architect,
    // which fixes the check in a design change, and the next attempt waits for the owner's merge.
    const f02 = () => o.state.features['shop/P1/F02']!;
    await until(o, () => module(o)?.design?.pr?.number === 2 && f02().guidance !== undefined);
    assert.match(f02().attempts[0]!.reason!, /checks failed: F02-add/);
    for (let i = 0; i < 5; i++) await o.tick();
    assert.equal(f02().attempts.length, 1, 'no new attempt while the design change is in review');

    const main = await fake.merge(2);
    skew += 120_000;
    await until(o, () => f02().status === 'accepted');
    const merged = o.store.readAll().find((e) => e.type === 'PLAN_MAIN_MERGED');
    assert.ok(merged && merged.type === 'PLAN_MAIN_MERGED');
    const [first, second] = f02().attempts;
    assert.equal(second!.base, merged.payload.head);
    assert.deepEqual((await o.repo.commitInfo(second!.base)).parents, [first!.base, main]);
    assert.equal(await o.repo.show(second!.base, 'src/greet.sh'), SOLUTIONS.F01['src/greet.sh'], 'F01 stays on the plan branch');
    assert.equal(await o.repo.show(second!.base, check), toyDesign('shop')[check]);
    assert.notEqual(second!.definitionHash, first!.definitionHash, 'the fixed check redefines F02, with a fresh budget');
    assert.equal(second!.guidance, 'The Architect says: The check was wrong; Arch PR #2 fixes it.');
    await until(o, () => o.state.plans['shop/P1']?.status === 'ready_to_merge');
  });

  it('refuses a design over the owner\'s time once they budget it, and takes one that fits', async () => {
    const actions = (estimatedMinutes?: number) => ({
      'harness/modules/shop/owner-actions.json': JSON.stringify([
        { id: 'T1', kind: 'task', title: 'Create the account', when: 'anytime', blocks: [], instructions: 'Sign up.', verify: null, ...(estimatedMinutes === undefined ? {} : { estimatedMinutes }) },
      ]),
    });
    // Ten hours, a 20% reserve: 8 h are available. An unestimated action is refused, then 600 minutes are too many.
    const { orchestrator: o } = await setup((f) => solved(f), {
      github: true, design: false, architect: shop({ design: { ...toyDesign('shop'), ...actions() }, fix: actions(600) }),
    });
    o.createModule('shop', 'A tiny shop');
    await until(o, () => module(o)?.status === 'proposed');
    // Set once the Architect exists: it hears of the budget in its inbox (a new Architect hears of it in its welcome).
    assert.equal(o.setBudgets({ ownerHours: 10 }), true);
    o.acceptProposal('shop', 1);
    await until(o, () => o.store.readAll().filter((e) => e.type === 'DESIGN_REFUSED').length === 2);
    const problems = o.store.readAll().flatMap((e) => (e.type === 'DESIGN_REFUSED' ? e.payload.problems : []));
    assert.equal(problems[0], 'owner-actions.json: T1 needs estimatedMinutes, how long it takes the owner: their time is budgeted (get_owner_time)');
    assert.match(problems[1]!, /^the design takes 10 h of the owner's time in owner actions, but 8 h are available/);
    assert.equal(module(o)!.status, 'decomposing');
    assert.ok(module(o)!.notes.some((n) => n.text.startsWith('The owner set their time budget: 10 hours')));

    // Within the budget: the design is submitted, and the numbers are the Architect's to read.
    const { orchestrator: p, fake } = await setup((f) => solved(f), {
      github: true, design: false, architect: shop({ design: { ...toyDesign('shop'), ...actions(60) } }),
    });
    p.setBudgets({ ownerHours: 10 });
    p.createModule('shop', 'A tiny shop');
    await until(p, () => p.state.modules.shop?.status === 'proposed');
    p.acceptProposal('shop', 1);
    await until(p, () => p.state.modules.shop?.status === 'in_review');
    assert.equal(fake.prs.length, 1);
    const time = (await p.ownerTime())!;
    assert.equal(time.plannableHours, 8);
    assert.ok(time.committedHours >= 1 && time.committedHours < 1.1, `committed ${time.committedHours}`);
    const told = await handleRequest(p, { role: 'architect', sandbox: p.state.modules.shop!.architect.sandbox, module: 'shop' }, { v: 1, id: 'r-time', tool: 'get_owner_time', args: {} });
    assert.match(told!.text, /^The owner set 10 h for the whole project\. A 20% reserve \(2 h\) stays out of designs/);
    assert.match(told!.text, /Available to shop: 8 h\./);
  });

  it('refuses a design whose checks run a missing script, and takes the fix', async () => {
    const broken = toyDesign('shop');
    const plan = JSON.parse(broken['harness/modules/shop/plans/P1.json']!) as { features: Array<{ checks: Array<{ run: string }> }> };
    plan.features[0]!.checks[0]!.run = 'bash harness/modules/shop/checks/missing.sh';
    broken['harness/modules/shop/plans/P1.json'] = JSON.stringify(plan);
    const { orchestrator: o, fake } = await setup((f) => solved(f), {
      github: true, design: false, architect: shop({ design: broken, fix: { 'harness/modules/shop/checks/missing.sh': 'test "$(bash src/greet.sh)" = hello\n' } }),
    });
    o.createModule('shop', 'A tiny shop');
    await until(o, () => module(o)?.status === 'proposed');
    o.acceptProposal('shop', 1);
    await until(o, () => module(o)?.status === 'in_review');

    const refused = o.store.readAll().find((e) => e.type === 'DESIGN_REFUSED');
    assert.ok(refused && refused.type === 'DESIGN_REFUSED');
    assert.deepEqual(refused.payload.problems, ['P1/F01: check F01-greet runs harness/modules/shop/checks/missing.sh, which isn\'t in the design']);

    // A check that only works where harness sandboxes keep the repository is refused too.
    const pinned = toyDesign('shop');
    pinned['harness/modules/shop/checks/F01.sh'] = 'test "$(bash /sandbox/work/src/greet.sh)" = hello\n';
    const { orchestrator: p } = await setup((f) => solved(f), { github: true, design: false, architect: shop({ design: pinned }) });
    p.createModule('shop', 'A tiny shop');
    await until(p, () => p.state.modules.shop?.status === 'proposed');
    p.acceptProposal('shop', 1);
    await until(p, () => p.store.readAll().some((e) => e.type === 'DESIGN_REFUSED'));
    const why = p.store.readAll().find((e) => e.type === 'DESIGN_REFUSED');
    assert.ok(why && why.type === 'DESIGN_REFUSED');
    assert.match(why.payload.problems[0]!, /^P1\/F01: check F01-greet uses a \/sandbox\/ path/);
    assert.equal(fake.prs.length, 1);
  });

  it('holds back the work a gate blocks until the owner marks it done', async () => {
    const gate = [{ id: 'G1', kind: 'gate', title: 'Approve the scripts', blocks: ['P1'], instructions: 'Say yes.', verify: null }];
    const { orchestrator: o } = await setup((f) => solved(f), {
      prepare: async (dir) => {
        writeFileSync(join(dir, 'harness/modules/demo/owner-actions.json'), JSON.stringify(gate));
        await runOk('git', ['-C', dir, 'add', '-A']);
        await runOk('git', ['-C', dir, '-c', 'user.name=o', '-c', 'user.email=o@test.invalid', 'commit', '--quiet', '-m', 'gate']);
      },
    });
    for (let i = 0; i < 5; i++) await o.tick();
    assert.equal(o.state.plans['demo/P1'], undefined, 'the gate holds back P1');
    assert.equal(o.gatesHolding('demo', 'P1').join(), 'G1');

    assert.equal(o.claimAction('demo', 'G1'), true);
    await until(o, completed(o));
    const progress = (await o.repo.show(o.state.plans['demo/P1']!.head, 'progress.txt'))!;
    assert.match(progress, /^\S+ gate\.satisfied demo\/G1 by=owner "Approve the scripts"\n\S+ feature\.accepted demo\/P1\/F01/);
  });
});

describe('recover', () => {
  const ready = (o: Orchestrator) => () => o.state.plans['demo/P1']?.status === 'ready_to_merge';

  it('rebuilds a lost .harness from main and GitHub, and builds nothing twice', async () => {
    let skew = 0;
    const { orchestrator: o, fake, harnessDir, make } = await setup((f) => solved(f), { github: true, now: () => Date.now() + skew });
    await until(o, ready(o));
    // A full stop: a step still under way would write into the folder being removed.
    await o.stop();
    rmSync(harnessDir, { recursive: true, force: true });

    const projectDir = join(harnessDir, '..');
    const notes = await recover({ projectDir, harnessDir, forge: fake });
    assert.match(notes[0]!, /^demo\/P1: PR #1 is open; its CI is read again$/);
    await assert.rejects(recover({ projectDir, harnessDir, forge: fake }), /nothing to recover/);

    const again = make();
    await again.start();
    assert.equal(again.state.plans['demo/P1']!.status, 'pr_open');
    assert.deepEqual(['F01', 'F02'].map((f) => again.state.features[`demo/P1/${f}`]!.status), ['accepted', 'accepted']);
    await until(again, ready(again));
    await fake.merge(1);
    skew += 120_000;
    await until(again, completed(again));
    // No attempt ran after the recovery: the features came back accepted.
    assert.deepEqual(Object.values(again.state.features).map((f) => f.attempts.length), [0, 0]);

    await again.stop();
    rmSync(harnessDir, { recursive: true, force: true });
    assert.deepEqual(await recover({ projectDir, harnessDir, forge: fake }).then((n) => n[0]), 'demo/P1: completed, PR #1 merged');
  });
});

describe('dashboard', () => {
  /** Plain node:http, because fetch won't send a forged Host header. */
  const call = (port: number, path: string, headers: Record<string, string>, method = 'GET') =>
    new Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      });
      req.on('error', reject);
      req.end();
    });

  const token = 'ab'.repeat(16);
  async function dashboard(terminals = new Terminals(undefined), usage?: () => Promise<UsageReading>) {
    const { orchestrator: o, driver } = await setup((f) => solved(f));
    const webRoot = tempDir('web');
    writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>harness</title>');
    mkdirSync(join(webRoot, 'assets'));
    writeFileSync(join(webRoot, 'assets', 'app.js'), 'console.log("app")');
    const server = await startDashboard({ orchestrator: o, port: 0, token, webRoot, terminals, ...(usage ? { usage } : {}) });
    cleanup.push(async () => void server.close());
    const port = (server.address() as AddressInfo).port;
    const host = `127.0.0.1:${port}`;
    return { o, driver, port, host, webRoot, bearer: { host, authorization: `Bearer ${token}` } };
  }

  it("shows every setting of harness/config.json, the file's or the default, the daemon's and the machine's, and no key", async () => {
    const xdg = tempDir('xdg');
    mkdirSync(join(xdg, 'harness'));
    writeFileSync(join(xdg, 'harness', 'app.json'), JSON.stringify({ appId: 42, name: 'acme-harness', slug: 'acme-harness', owner: 'acme', htmlUrl: 'https://github.com/apps/acme-harness' }));
    writeFileSync(join(xdg, 'harness', 'app.pem'), '-----BEGIN RSA PRIVATE KEY-----\nnot a real key\n-----END RSA PRIVATE KEY-----\n');
    const before = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
    cleanup.push(async () => {
      if (before === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = before;
    });
    const { port, bearer } = await dashboard();
    const view = JSON.parse((await call(port, '/api/config', bearer)).body) as ConfigView;
    const setting = (path: string) => view.settings.find((s) => s.path === path);
    // The toy's config sets an attempt's deadline: the default it replaces shows beside it.
    assert.deepEqual(setting('roles.developer.attemptTimeoutMinutes'), { path: 'roles.developer.attemptTimeoutMinutes', value: 5, set: true, default: 180 });
    // It sets nothing for the Architect: the default model, Fable 5.2.
    assert.deepEqual(setting('roles.architect.model'), { path: 'roles.architect.model', value: 'claude-fable-5-2', set: false });
    assert.deepEqual(setting('swarm.usageCeilingPercent'), { path: 'swarm.usageCeilingPercent', value: 80, set: false });
    assert.equal(setting('project.name')!.required, true);
    // Every section of the file, the toy having neither AWS nor Terraform.
    assert.deepEqual([...new Set(view.settings.map((s) => s.path.split('.')[0]))], ['harnessVersion', 'project', 'roles', 'sandbox', 'network', 'checks', 'protect', 'github', 'brakes', 'ownerTime', 'swarm', 'dashboard']);
    const fact = (facts: Array<{ name: string; value: string }>, name: string) => facts.find((f) => f.name === name)?.value;
    assert.match(fact(view.daemon, 'Mode')!, /^Manual/);
    assert.equal(fact(view.daemon, 'Your hours'), 'not set');
    assert.equal(fact(view.machine, 'Node.js'), process.version);
    assert.equal(fact(view.machine, 'GitHub App'), 'acme-harness (acme-harness, id 42), owned by acme; its private key is on this machine');
    assert.doesNotMatch(JSON.stringify(view), /PRIVATE KEY|not a real key/);
  });

  it('sets and clears only the hours of your time: the agent-hours threshold is gone', async () => {
    const { o, port, bearer } = await dashboard();
    const post = async (body: object) => JSON.parse((await callWith(port, '/api/budgets', bearer, body)).body) as { done: boolean };
    assert.equal((await post({ agentHours: 40 })).done, false);
    assert.equal((await post({ ownerHours: 12, agentHours: 40 })).done, true);
    assert.deepEqual(Object.keys(o.state.budgets).sort(), ['ownerHours', 'ownerHoursSetAt']);
    assert.equal((await post({ ownerHours: null })).done, true);
    assert.deepEqual(o.state.budgets, {});
  });

  it("lists the gateway's sandboxes, labels its own, shows what a policy refused, and deletes only a left-over one", async () => {
    const { o, driver, port, bearer } = await dashboard();
    await until(o, completed(o), 60_000);
    assert.ok(driver.created.length > 0 && driver.created.every((spec) => spec.labels?.['harness.project'] === 'toy'), 'every sandbox the daemon made says whose it is');
    const spec = (name: string, project: string) => ({ name, image: 'x', providers: [], env: {}, labels: { 'harness.project': project } });
    await driver.create(spec('dev-0000aaaa-a9', 'toy'));
    await driver.create(spec('dev-1111bbbb-a1', 'elsewhere'));
    await driver.create(spec('chk-2222cccc-plan', 'toy'));
    o.checking.set('chk-2222cccc-plan', 'plan/demo/P1');
    mkdirSync(join(driver.base, 'prb-12345678'));
    writeFileSync(join(driver.rootOf('dev-0000aaaa-a9'), '.harness', 'openshell.log'), '[1794077355.601] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/node(7) -> pypi.org:443 [reason:transparent_tcp_policy_denied]\n');

    const overview = JSON.parse((await call(port, '/api/sandboxes', bearer)).body) as { gateway: { status: string }; sandboxes: Array<{ name: string; use: string; role?: string; title?: string; project?: string }> };
    assert.equal(overview.gateway.status, 'connected');
    assert.deepEqual(overview.sandboxes.map((s) => [s.name, s.use, s.role ?? s.project ?? '']), [
      ['chk-2222cccc-plan', 'in use', 'Checks'],
      ['dev-0000aaaa-a9', 'left over', 'Developer'],
      ['dev-1111bbbb-a1', 'other', 'elsewhere'],
      ['prb-12345678', 'other', ''],
    ]);

    const denials = await call(port, '/api/sandboxes/denials?name=dev-0000aaaa-a9', bearer);
    assert.deepEqual(JSON.parse(denials.body).map((d: { program: string; target: string; count: number }) => [d.program, d.target, d.count]), [['/usr/bin/node', 'pypi.org:443', 1]]);
    assert.equal((await call(port, '/api/sandboxes/denials?name=dev-1111bbbb-a1', bearer)).status, 404);

    const remove = async (name: string) => JSON.parse((await callWith(port, '/api/sandboxes/remove', bearer, { name })).body) as { done: boolean; error?: string };
    assert.deepEqual(await remove('chk-2222cccc-plan'), { done: false, error: 'it is in use' });
    assert.deepEqual(await remove('dev-1111bbbb-a1'), { done: false, error: "it isn't this project's" });
    assert.deepEqual(await remove('prb-12345678'), { done: false, error: "it isn't this project's" });
    assert.deepEqual(await remove('dev-0000aaaa-a9'), { done: true });
    assert.equal(await driver.status('dev-0000aaaa-a9'), 'missing');
    assert.deepEqual(await remove('dev-0000aaaa-a9'), { done: false, error: 'the gateway has no such sandbox' });
  });

  it("caps each new sandbox as the owner sets it, within the machine, and relays Docker's reading of what they use", async () => {
    let reads = 0;
    const reading: UsageReading = {
      at: new Date().toISOString(),
      sandboxes: { 'dev-0000aaaa-a1': { cpu: 1.2, memoryBytes: 812 * 1024 ** 2, cpuLimit: 1.5, memoryLimitBytes: 2 * 1024 ** 3 } },
      total: { cpu: 1.3, memoryBytes: 850 * 1024 ** 2 },
    };
    const { o, driver, port, bearer } = await dashboard(undefined, async () => {
      reads += 1;
      return reading;
    });
    const limits = async (body: object) => JSON.parse((await callWith(port, '/api/sandboxes/limits', bearer, body)).body) as { done: boolean; error?: string };
    const overview = async () => JSON.parse((await call(port, '/api/sandboxes', bearer)).body) as SandboxOverview;

    const { machine } = await overview();
    assert.ok(machine.cpus >= 1 && machine.memoryGiB > 0);
    assert.deepEqual((await overview()).limits, {});
    assert.match((await limits({ cpu: 0.2, memoryGiB: 2 })).error!, /^CPUs: from 0\.5 to \d+, this machine's$/);
    assert.match((await limits({ cpu: 1, memoryGiB: machine.memoryGiB + 1 })).error!, /^memory: from 1 to \d+ GiB, this machine's$/);
    assert.deepEqual(await limits({ cpu: 1 }), { done: false, error: 'cpu and memoryGiB: a number, or null for no cap' });
    assert.equal(o.state.sandboxLimits, undefined, 'a refused cap changes nothing');

    assert.deepEqual(await limits({ cpu: 0.5, memoryGiB: 2 }), { done: true });
    assert.deepEqual((await overview()).limits, { cpu: 0.5, memoryGiB: 2 });
    const before = driver.created.length;
    await until(o, completed(o), 60_000);
    const made = driver.created.slice(before);
    assert.ok(made.length > 0 && made.every((spec) => spec.cpu === '500m' && spec.memory === '2048Mi'), 'every sandbox made after the change is capped');

    assert.deepEqual(await limits({ cpu: null, memoryGiB: 2 }), { done: true });
    assert.deepEqual(o.state.sandboxLimits, { memoryGiB: 2 });
    assert.deepEqual(await limits({ cpu: null, memoryGiB: null }), { done: true });
    assert.equal(o.state.sandboxLimits, undefined);
    assert.equal(o.store.readAll().filter((e) => e.type === 'SANDBOX_LIMITS_SET').length, 3);
    assert.deepEqual(await limits({ cpu: null, memoryGiB: null }), { done: true });
    assert.equal(o.store.readAll().filter((e) => e.type === 'SANDBOX_LIMITS_SET').length, 3, 'the same caps again record nothing');

    // Two dashboards asking at once share one reading.
    const [one, two] = await Promise.all([call(port, '/api/sandboxes/usage', bearer), call(port, '/api/sandboxes/usage', bearer)]);
    assert.deepEqual(JSON.parse(one.body), reading);
    assert.deepEqual(JSON.parse(two.body), reading);
    assert.equal(reads, 1);
  });

  it('in Swarm, says which setup steps are left, reads them again every 30 seconds until none is, then every five minutes', async () => {
    let skew = 0;
    const { orchestrator: o, fake } = await setup((f) => solved(f), { github: true, now: () => Date.now() + skew });
    const server = await startDashboard({ orchestrator: o, port: 0, token, webRoot: tempDir('web'), terminals: new Terminals(undefined) });
    cleanup.push(async () => void server.close());
    const port = (server.address() as AddressInfo).port;
    const bearer = { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` };
    const read = async () => (JSON.parse((await call(port, '/api/state', bearer)).body) as DashboardState).setup;
    assert.equal(await read(), undefined, 'Manual has no Swarm setup');

    o.setMode('swarm');
    const manual = (await read())!;
    assert.equal(manual.rules!.ok, false);
    assert.deepEqual(manual.rules!.problems, ["1 approval is required, which the daemon can't give", "the harness/security status isn't required", "the harness/cost status isn't required"]);
    assert.equal(manual.statusesWritable, undefined);

    // With steps left, it is read again after 30 seconds: now the rules are Swarm's, and the App can't write statuses.
    fake.rules = { approvals: 0, codeOwners: false, checks: [...fake.rules!.checks, { context: 'harness/security', integrationId: 4242 }, { context: 'harness/cost', integrationId: 4242 }] };
    fake.writable = false;
    skew += 31_000;
    const swarm = (await read())!;
    assert.deepEqual(swarm.rules, { ok: true, problems: [] });
    assert.equal(swarm.statusesWritable, false);

    // With none left, it is kept for five minutes.
    fake.writable = true;
    skew += 31_000;
    const done = (await read())!;
    assert.deepEqual([done.rules!.ok, done.statusesWritable], [true, true]);
    fake.rules = { ...fake.rules, approvals: 1 };
    skew += 60_000;
    assert.equal((await read())!.rules!.ok, true, 'a finished list is kept');
    skew += 5 * 60_000;
    assert.equal((await read())!.rules!.ok, false, 'then read again');
  });

  it("switches with main's rules, as harness mode does: Swarm's before the daemon enters Swarm, Manual's once it left", async () => {
    const order: string[] = [];
    let refuse = false;
    const { orchestrator: o } = await setup((f) => solved(f), {
      github: true,
      applyRules: async (_config, repo, mode) => {
        order.push(`${mode}'s rules on ${repo}, the daemon in ${o.state.mode}`);
        if (refuse) throw new Error('gh: not an admin of acme/toy');
        return [`ruleset "harness: main" (${mode})`];
      },
    });
    const server = await startDashboard({ orchestrator: o, port: 0, token, webRoot: tempDir('web'), terminals: new Terminals(undefined) });
    cleanup.push(async () => void server.close());
    const port = (server.address() as AddressInfo).port;
    const bearer = { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` };
    const switchTo = async (mode: string) => JSON.parse((await callWith(port, '/api/mode', bearer, { mode })).body) as unknown;

    assert.deepEqual(await switchTo('swarm'), { done: true, rules: ['ruleset "harness: main" (swarm)'] });
    refuse = true;
    assert.deepEqual(await switchTo('manual'), { done: true, rules: [], problem: 'gh: not an admin of acme/toy' });
    assert.equal(o.state.mode, 'manual', "a ruleset gh couldn't apply doesn't stop the switch");
    assert.deepEqual(order, ["swarm's rules on acme/toy, the daemon in manual", "manual's rules on acme/toy, the daemon in manual"]);
  });

  it('serves only the token holder on localhost, and survives a malformed request', async () => {
    const { port, host, bearer } = await dashboard();
    assert.equal((await call(port, '/api/state', { host })).status, 401);
    assert.equal((await call(port, '/api/state', { host, authorization: `Bearer ${'cd'.repeat(16)}` })).status, 401);
    assert.equal((await call(port, '/api/state', { ...bearer, host: 'attacker.example' })).status, 421);
    assert.equal((await call(port, '/api/state', { ...bearer, host: 'a b' })).status, 421);
    assert.equal((await call(port, '/api/resume', { ...bearer, origin: 'http://attacker.example' }, 'POST')).status, 403);
    assert.equal((await call(port, '/api/%E0%A4%A', bearer)).status, 404);

    const state = await call(port, '/api/state', bearer);
    assert.equal(state.status, 200);
    assert.equal(JSON.parse(state.body).design.project, 'toy');
    // The gates a feature names go to the page, which says what each gate holds back.
    assert.deepEqual((JSON.parse(state.body) as DashboardState).design.modules[0]!.plans[0]!.features.map((f) => f.gates), [[], []]);
    const login = await call(port, `/?token=${token}`, { host });
    assert.equal(login.status, 303);
    assert.match(String(login.headers['set-cookie']), new RegExp(`^harness_token_${port}=[0-9a-f]+; HttpOnly; SameSite=Strict`));
  });

  it('serves the built front end under a content security policy, and nothing outside it', async () => {
    const { port, bearer } = await dashboard();
    const page = await call(port, '/', bearer);
    assert.equal(page.body, '<!doctype html><title>harness</title>');
    assert.match(String(page.headers['content-security-policy']), /script-src 'self';.*connect-src 'self' ws:\/\/127\.0\.0\.1:/);
    assert.equal((await call(port, '/assets/app.js', bearer)).body, 'console.log("app")');
    // A view's path, and a way out of the folder, both get the page.
    assert.equal((await call(port, '/agents', bearer)).body, page.body);
    assert.equal((await call(port, '/assets/../../../../etc/passwd', bearer)).body, page.body);
    assert.equal((await call(port, '/%2e%2e/%2e%2e/package.json', bearer)).body, page.body);
  });

  it('serves the dashboard at /next/ too, where 0.4.17 served the Vue one: a tab left open there still loads', async () => {
    const { port, bearer } = await dashboard();
    const page = (await call(port, '/', bearer)).body;
    for (const path of ['/next', '/next/']) assert.equal((await call(port, path, bearer)).body, page, path);
  });

  it('pauses and resumes for the owner, and shows the agents\' transcripts', async () => {
    const { o, port, bearer } = await dashboard();
    const post = async (path: string, body: object) => JSON.parse((await callWith(port, path, bearer, body)).body) as { done: boolean };
    assert.equal((await post('/api/pause', {})).done, true);
    assert.equal(o.state.pipeline.paused?.reason, 'the owner paused the pipeline');
    assert.equal((await post('/api/resume', {})).done, true);
    assert.equal((await post('/api/infra-merge', { by: 'daemon' })).done, true);
    assert.equal(o.state.infraMerge, 'daemon');
    assert.equal((await post('/api/infra-merge', { by: 'elsewhere' })).done, false);

    o.events.emit('transcript', { agent: 'manager:demo', line: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(5000) }] } }) });
    o.events.emit('transcript', { agent: 'manager:demo', line: 'not json' });
    const items = JSON.parse((await call(port, '/api/transcript?agent=manager:demo', bearer)).body) as Array<{ message: { content: Array<{ text: string }> } }>;
    assert.equal(items.length, 1);
    assert.match(items[0]!.message.content[0]!.text, /^x{4000}… \(1000 more characters\)$/);
    assert.equal((await call(port, '/api/transcript?agent=developer:../../etc/a1', bearer)).status, 404);
  });

  it("opens a Developer's transcript with its task, which Claude Code's stream doesn't repeat, live too", async () => {
    const { o, port, bearer } = await dashboard();
    await until(o, completed(o), 60_000);
    const agent = 'developer:demo/P1/F01/a1';
    const items = JSON.parse((await call(port, `/api/transcript?agent=${encodeURIComponent(agent)}`, bearer)).body) as Array<{ type: string; text?: string }>;
    assert.equal(items[0]!.type, 'prompt');
    assert.match(items[0]!.text ?? '', /^# Feature demo\/P1\/F01: /);

    // A page watching a session from its first line gets the task before it.
    const web = tempDir('web');
    writeFileSync(join(web, 'index.html'), '');
    const fresh = await startDashboard({ orchestrator: o, port: 0, token, webRoot: web, terminals: new Terminals(undefined) });
    cleanup.push(async () => void fresh.close());
    const freshPort = (fresh.address() as AddressInfo).port;
    const live: Array<{ agent: string; item: { type: string } }> = [];
    const watching = request({ host: '127.0.0.1', port: freshPort, path: '/api/events', headers: { host: `127.0.0.1:${freshPort}`, authorization: `Bearer ${token}` } }, (res) => {
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (block.startsWith('event: transcript\n')) live.push(JSON.parse(block.slice(block.indexOf('data: ') + 6)));
        }
      });
    });
    watching.end();
    cleanup.push(async () => void watching.destroy());
    await sleep(200);
    o.events.emit('transcript', { agent, line: JSON.stringify({ type: 'system', subtype: 'init', model: 'm' }) });
    o.events.emit('transcript', { agent, line: JSON.stringify({ type: 'assistant', message: { content: [] } }) });
    await until(o, () => live.length >= 3, 5_000);
    assert.deepEqual(live.map((event) => [event.agent, event.item.type]), [[agent, 'prompt'], [agent, 'system'], [agent, 'assistant']]);
  });

  it('opens terminals over a WebSocket only for the token holder, from the dashboard', async () => {
    const { port, host } = await dashboard(new Terminals(() => fakePty().pty));
    const open = (headers: Record<string, string>, query: string) =>
      new Promise<string>((resolve) => {
        const socket = new WebSocket(`ws://${host}/api/terminal?${query}`, { headers });
        socket.on('unexpected-response', (_req, res) => resolve(`refused ${res.statusCode}`));
        socket.on('close', (code, reason) => resolve(`closed ${code} ${String(reason)}`));
        socket.on('error', () => {});
      });
    const cookie = `harness_token_${port}=${token}`;
    assert.equal(await open({ cookie }, 'module=demo'), 'refused 403');
    assert.equal(await open({ cookie, origin: 'http://attacker.example' }, 'module=demo'), 'refused 403');
    assert.equal(await open({ origin: `http://${host}` }, 'module=demo'), 'refused 403');
    assert.equal(await open({ cookie, origin: `http://${host}` }, 'module=demo'), 'closed 1008 no Architect for demo');
    assert.equal(await open({ cookie, origin: `http://${host}` }, 'sandbox=anything'), 'closed 1008 no such sandbox');
  });

  it('shares an Architect\'s terminal between viewers, and types the daemon\'s prompts into it', async () => {
    const ptys: Array<ReturnType<typeof fakePty>> = [];
    const terminals = new Terminals((file, args) => {
      const fake = fakePty([file, ...args]);
      ptys.push(fake);
      return fake.pty;
    });
    const first: string[] = [];
    const second: string[] = [];
    const one = terminals.attach('arc-1', { send: (d) => first.push(d), close: () => {} }, { cols: 80, rows: 24 });
    ptys[0]!.emit('hello');
    const two = terminals.attach('arc-1', { send: (d) => second.push(d), close: () => {} }, { cols: 100, rows: 30 });
    assert.deepEqual(ptys.map((p) => p.command), [['openshell', 'sandbox', 'connect', 'arc-1']]);
    assert.deepEqual([first, second], [['hello'], ['hello']]);
    one.input('ls\r');
    assert.equal(ptys[0]!.writes.at(-1), 'ls\r');
    assert.equal(terminals.watched('arc-1'), true);
    one.detach();
    two.detach();
    // The last viewer gone, the connection detaches: the Architect keeps running.
    assert.equal(ptys[0]!.writes.at(-1), '\x10\x11');
    assert.equal(terminals.watched('arc-1'), false);

    const typed = terminals.prompt('arc-1', 'news');
    ptys[1]!.emit('ready');
    await typed;
    assert.deepEqual(ptys[1]!.writes, ['news', '\r', '\x10\x11']);
  });
});

/** Posts JSON with the given headers. */
function callWith(port: number, path: string, headers: Record<string, string>, body: object) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)) } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

/** A terminal that records what is written to it, and emits what the test says. */
function fakePty(command: string[] = []) {
  const listeners: Array<(data: string) => void> = [];
  const writes: string[] = [];
  const pty: Pty = {
    onData: (listener) => void listeners.push(listener),
    onExit: () => {},
    write: (data) => void writes.push(data),
    resize: () => {},
    kill: () => {},
  };
  return { pty, command, writes, emit: (data: string) => listeners.forEach((listener) => listener(data)) };
}

describe('supersedes', () => {
  it("drops a feature's checks once a feature that supersedes it is being built, or accepted in what is checked", async () => {
    const { orchestrator: o } = await setup((f) => solved(f));
    await until(o, completed(o));
    // A later plan whose F03 supersedes F01, read from the design as the daemon has it.
    const demo = o.design.modules.find((m) => m.id === 'demo')!;
    const p1 = demo.plans[0]!;
    demo.plans.push({ ...p1, id: 'P2', features: [{ ...p1.features[0]!, id: 'F03', supersedes: ['P1/F01'] }] });
    const head = `refs/heads/${o.state.plans['demo/P1']!.branch}`;
    const ids = async (building?: { module: string; plan: string; feature: string }) => (await o.regressionChecks(head, building)).map((c) => c.id);
    assert.ok((await ids()).includes('F01-greet'), 'F03 is neither accepted nor being built');
    assert.ok(!(await ids({ module: 'demo', plan: 'P2', feature: 'F03' })).includes('F01-greet'), "F03's attempt doesn't keep the check it replaces");
    assert.ok((await ids({ module: 'demo', plan: 'P2', feature: 'F03' })).includes('F02-add'));
  });
});

describe('pauses', () => {
  it("keeps the owner's pause when an attempt then hits a usage limit, past the limit's hour", async () => {
    let skew = 0;
    const { orchestrator: o } = await setup((f) => solved(f), { agent: usageLimitOn('F01', [1]), now: () => Date.now() + skew });
    await until(o, () => feature(o, 'F01')?.attempts[0]?.status === 'running');
    assert.equal(o.pause(), true);
    await until(o, () => feature(o, 'F01')?.attempts[0]?.status === 'interrupted');
    assert.deepEqual(o.state.pipeline.paused, { reason: 'the owner paused the pipeline', since: o.state.pipeline.paused!.since, until: undefined });
    skew += 61 * 60_000;
    for (let i = 0; i < 3; i++) await o.tick();
    assert.equal(o.state.pipeline.paused?.reason, 'the owner paused the pipeline');
    assert.equal(feature(o, 'F01')!.attempts.length, 1);
  });

  it('counts a usage limit from the third one of the same feature, since an attempt writes its own stream', async () => {
    let skew = 0;
    const { orchestrator: o } = await setup((f) => solved(f), { agent: usageLimitOn('F01', [1, 2, 3]), now: () => Date.now() + skew });
    for (let n = 1; n <= 3; n++) {
      await until(o, () => feature(o, 'F01')?.attempts[n - 1]?.status === 'interrupted');
      assert.equal(o.state.pipeline.paused?.reason, 'usage limit reached');
      // No Unix time anywhere: an hour, whatever "resets 3pm" says.
      assert.ok(Math.abs(Date.parse(o.state.pipeline.paused!.until!) - (Date.now() + skew + 3_600_000)) < 10_000);
      skew += 61 * 60_000;
    }
    assert.deepEqual(feature(o, 'F01')!.attempts.map((a) => a.counts), [false, false, true]);
  });

  it("waits after a usage limit until a minute past the reset of the window an agent's latest report shows full", async () => {
    let skew = 0;
    const { orchestrator: o } = await setup((f) => solved(f), { agent: usageLimitOn('F01', [1]), now: () => Date.now() + skew });
    // A Unix time in the report, whatever the laptop's timezone: 20 minutes from now.
    const resetsAt = Math.floor((Date.now() + 20 * 60_000) / 1000);
    o.events.emit('transcript', { agent: 'manager:demo', line: rateLimitEvent({ five_hour: 1, seven_day: 0.4 }, resetsAt) });
    await until(o, () => feature(o, 'F01')?.attempts[0]?.status === 'interrupted');
    assert.equal(o.state.pipeline.paused?.until, new Date(resetsAt * 1000 + 60_000).toISOString());
    skew += 21 * 60_000 + 1000;
    await until(o, completed(o));
    assert.equal(feature(o, 'F01')!.attempts.length, 2);
  });

  it('reads the Unix time an older Claude Code writes after its usage limit message', async () => {
    const epoch = Math.floor((Date.now() + 30 * 60_000) / 1000);
    const { orchestrator: o } = await setup((f) => solved(f), { agent: usageLimitOn('F01', [1], `Claude AI usage limit reached|${epoch}`) });
    await until(o, () => feature(o, 'F01')?.attempts[0]?.status === 'interrupted');
    assert.equal(o.state.pipeline.paused?.until, new Date(epoch * 1000 + 60_000).toISOString());
  });

  it('follows a reviewer already running while paused, so a usage limit it hits counts at once, and starts none', async () => {
    let gate = '';
    const epoch = Math.floor((Date.now() + 20 * 60_000) / 1000);
    // The security reviewer runs until the test lets it end, then reports a usage limit.
    const held = (stub: AgentAdapter): AgentAdapter => ({
      ...stub,
      launchReviewer(run: AgentRun) {
        if (!/as the security reviewer/.test(readFileSync(run.taskFile, 'utf8'))) return stub.launchReviewer(run);
        gate = join(run.workDir, 'gate');
        const result = { type: 'result', subtype: 'error_during_execution', is_error: true, result: `Claude AI usage limit reached|${epoch}` };
        return detach(run.workDir, [`echo $$ > ${sh(run.pidFile)}`, `while [ ! -f ${sh(gate)} ]; do sleep 0.1; done`, `printf '%s\\n' ${sh(JSON.stringify(result))} > ${sh(run.streamFile)}`, `echo 1 > ${sh(run.exitFile)}`].join('\n'));
      },
    });
    const { orchestrator: o } = await setup((f) => solved(f), { github: true, agent: held });
    o.setMode('swarm');
    const plan = () => o.state.plans['demo/P1'];
    const security = () => plan()?.reviews?.find((r) => r.role === 'security');
    await until(o, () => security()?.status === 'running');
    assert.equal(o.pause(), true);
    const starting = plan()!.reviews!.filter((r) => r.status === 'starting').map((r) => r.sandbox);
    writeFileSync(gate, '');
    await until(o, () => security()?.status !== 'running');
    assert.equal(security()!.outcome, 'usage_limit');
    assert.equal(o.state.pipeline.paused?.reason, 'the owner paused the pipeline', "the owner's pause holds: a timed one never replaces it");
    // Paused, a reviewer still starting got no sandbox.
    for (const name of starting) assert.equal(await o.driver.status(name), 'missing', name);
  });

  it('takes the hours harness budget left while it was down over earlier ones, and the mode harness mode left', async () => {
    const { orchestrator: o, harnessDir, make } = await setup((f) => solved(f));
    o.setBudgets({ ownerHours: 20 });
    await o.stop(0);
    writeFileSync(join(harnessDir, 'setup.json'), JSON.stringify({ ownerHours: 40, ownerHoursFrom: 'budget', mode: 'swarm' }));
    const again = make();
    await again.start();
    assert.equal(again.state.budgets.ownerHours, 40);
    assert.equal(again.state.mode, 'swarm');
    assert.equal(existsSync(join(harnessDir, 'setup.json')), false);
  });
});

describe('modules in order', () => {
  it('in Manual, builds a module whose design lands later only once the one under way is complete, and follows its PR meanwhile', async () => {
    let skew = 0;
    const { orchestrator: o, fake, harnessDir } = await setup(alphaOrSolved, { github: true, now: () => Date.now() + skew });
    await until(o, () => o.state.plans['demo/P1']?.status === 'ready_to_merge');
    const projectDir = join(harnessDir, '..');
    await commitOnMain(projectDir, alphaDesign, 'the alpha design');
    await runOk('git', ['-C', projectDir, 'push', '--quiet', fake.remote, 'main:main']);
    for (let i = 0; i < 5; i++) await o.tick();
    assert.equal(o.state.plans['alpha/P1'], undefined, 'alpha waits for demo');
    await fake.merge(1);
    skew += 120_000;
    await until(o, () => o.state.plans['demo/P1']?.status === 'completed' && o.state.plans['alpha/P1'] !== undefined);
  });

  it('in Swarm, builds the modules one after another', async () => {
    const { orchestrator: o } = await setup(alphaOrSolved, { prepare: (dir) => commitOnMain(dir, alphaDesign, 'the alpha design') });
    o.setMode('swarm');
    let together = false;
    await until(o, () => {
      together ||= new Set(Object.values(o.state.plans).filter((p) => p.status !== 'completed').map((p) => p.module)).size > 1;
      return ['alpha/P1', 'demo/P1'].every((key) => o.state.plans[key]?.status === 'completed');
    }, 60_000);
    assert.equal(together, false);
    assert.ok(o.store.readAll().findIndex((e) => e.type === 'PLAN_STARTED' && e.ref?.module === 'demo') > o.store.readAll().findIndex((e) => e.type === 'PLAN_COMPLETED' && e.ref?.module === 'alpha'));
  });
});

describe('parallel work, continued', () => {
  /** The toy plan with F02 independent of F01. */
  const independent = async (dir: string) => {
    const file = join(dir, 'harness/modules/demo/plans/P1.json');
    const design = JSON.parse(readFileSync(file, 'utf8')) as { features: Array<Record<string, unknown>> };
    for (const f of design.features) delete f.dependsOn;
    await commitOnMain(dir, { 'harness/modules/demo/plans/P1.json': JSON.stringify(design, null, 2) }, 'independent features');
  };
  /** The toy design split in two independent plans: P1 greets; P2 adds, then writes a third file (F03, after F02). */
  const twoPlans = async (dir: string) => {
    const file = join(dir, 'harness/modules/demo/plans/P1.json');
    const design = JSON.parse(readFileSync(file, 'utf8')) as { features: Array<Record<string, unknown>> };
    const [f01, f02] = design.features as [Record<string, unknown>, Record<string, unknown>];
    delete f02.dependsOn;
    const f03 = { id: 'F03', title: 'Three', description: 'src/three.txt exists.', expected: 'It exists.', dependsOn: ['F02'], checks: [{ id: 'F03-file', run: 'test -f src/three.txt', phase: 'pre-merge', timeoutSec: 30 }] };
    await commitOnMain(dir, {
      'harness/modules/demo/plans/P1.json': JSON.stringify({ ...design, features: [f01] }, null, 2),
      'harness/modules/demo/plans/P2.json': JSON.stringify({ ...design, id: 'P2', title: 'Adding', dependsOn: [], features: [f02, f03] }, null, 2),
    }, 'two plans');
  };
  const files = (f: string): Record<string, string> => (f === 'F03' ? { 'src/three.txt': '3\n' } : SOLUTIONS[f as keyof typeof SOLUTIONS]);

  it('in Swarm, every Developer under way reaches the Manager', async () => {
    const decide = (f: string): StubBehavior => (f === 'F01' ? { files: files('F01'), sleepSec: 5 } : { files: files('F02'), ask: 'Which shell should add.sh use?' });
    const { orchestrator: o } = await setup(decide, { prepare: independent });
    o.setMode('swarm');
    await until(o, completed(o), 60_000);
    assert.equal(await o.repo.show(o.state.plans['demo/P1']!.head, 'answer.txt'), 'Use the simplest option.');
    assert.equal(o.store.readAll().filter((e) => e.type === 'QUESTION').length, 1);
  });

  it("in Swarm, parallel plans take each other's progress lines, and both merge", async () => {
    const { orchestrator: o, fake } = await setup((f) => ({ files: files(f), sleepSec: f === 'F03' ? 4 : 0 }), {
      github: true, prepare: twoPlans, config: { swarm: { requiredStatuses: [] } },
    });
    o.setMode('swarm');
    await until(o, () => ['demo/P1', 'demo/P2'].every((key) => o.state.plans[key]?.status === 'completed'), 60_000);
    assert.equal(o.state.pipeline.paused, undefined);
    const progress = await runOk('git', ['--git-dir', fake.remote, 'show', 'refs/heads/main:progress.txt']);
    for (const key of ['demo/P1/F01', 'demo/P2/F02', 'demo/P2/F03']) assert.match(progress, new RegExp(`feature\\.accepted ${key} `));
  });

  it('in Swarm, a plan whose step keeps failing leaves the other going, then pauses with its error', async () => {
    let skew = 0;
    const { orchestrator: o, fake } = await setup((f) => ({ files: files(f) }), {
      github: true, prepare: twoPlans, config: { swarm: { requiredStatuses: [] } }, now: () => Date.now() + skew,
    });
    const push = fake.push.bind(fake);
    fake.push = async (repo, branch) => {
      if (branch === 'plan/demo/P1') throw new Error('remote rejected: refusing to update plan/demo/P1');
      return push(repo, branch);
    };
    o.setMode('swarm');
    await until(o, () => o.state.plans['demo/P2']?.status === 'completed', 60_000);
    for (let i = 0; i < 8 && !o.state.pipeline.paused; i++) {
      skew += 31_000;
      await o.tick();
    }
    assert.match(o.state.pipeline.paused?.reason ?? '', /^demo\/P1 keeps failing: remote rejected/);
  });
});

describe('pull requests, continued', () => {
  const plan = (o: Orchestrator) => o.state.plans['demo/P1'];
  const infraPlan = async (dir: string) => {
    const file = join(dir, 'harness/modules/demo/plans/P1.json');
    const design = JSON.parse(readFileSync(file, 'utf8')) as { features: Array<Record<string, unknown>> };
    for (const f of design.features) f.kind = 'infra';
    await commitOnMain(dir, { 'harness/modules/demo/plans/P1.json': JSON.stringify(design, null, 2) }, 'infra plan');
  };
  const fixGreet = (f: string): StubBehavior => (f.startsWith('fix') ? { files: { 'src/greet.sh': 'echo "hello"\n' } } : solved(f));

  it("in Swarm, an earlier head's cost estimate doesn't let a later head merge itself", async () => {
    let first: string | undefined;
    const review: ReviewBehavior = (role, rounds) => (role === 'security' && rounds === 0
      ? { verdict: 'block', summary: 'One problem.', findings: [{ severity: 'blocking', title: 'Fix me', detail: 'Do it.' }] }
      : { verdict: 'pass', summary: 'Fine.', findings: [] });
    const { orchestrator: o, fake } = await setup(fixGreet, { github: true, prepare: infraPlan, review });
    o.setMode('swarm');
    // The cost job uploads an estimate for the first head only, as when it fails on the next one.
    fake.artifacts = (sha): Record<string, Record<string, string>> => {
      first ??= sha;
      return sha === first ? { cost: { 'cost.json': JSON.stringify({ diffTotalMonthlyCost: '12.5' }) } } : {};
    };
    await until(o, () => plan(o)?.leftToOwner !== undefined && plan(o)?.leftToOwner?.head !== first, 60_000);
    assert.match(plan(o)!.leftToOwner!.reason, /none was produced/);
    assert.equal(plan(o)!.costEstimate!.head, first);
    assert.equal(fake.prs[0]!.state, 'open');
  });

  it('in Swarm, reads no cost artifact unless the cost job itself succeeded', async () => {
    const { orchestrator: o, fake } = await setup((f) => solved(f), { github: true, prepare: infraPlan });
    o.setMode('swarm');
    fake.ci = () => ({ verify: 'success', checks: 'success', cost: 'failure' });
    fake.artifacts = () => ({ cost: { 'cost.json': JSON.stringify({ diffTotalMonthlyCost: '1' }) } });
    await until(o, () => plan(o)?.leftToOwner !== undefined);
    assert.equal(plan(o)!.costEstimate, undefined);
    assert.match(plan(o)!.leftToOwner!.reason, /none was produced/);
  });

  it('waits for GitHub to show its push on the pull request, rather than taking the lag for a moved branch', async () => {
    let skew = 0;
    const { orchestrator: o, fake } = await setup((f) => solved(f), { github: true, now: () => Date.now() + skew });
    // GitHub a moment after a push: the branch holds the new commit, and the pull request still shows the one before it.
    let lagging = true;
    const read = fake.pullRequest.bind(fake);
    fake.pullRequest = async (number: number) => {
      const pr = await read(number);
      return lagging ? { ...pr, head: (await runOk('git', ['--git-dir', fake.remote, 'rev-parse', `${pr.head}^`])).trim() } : pr;
    };
    await until(o, () => plan(o)?.pr !== undefined);
    for (let i = 0; i < 5; i++) {
      skew += 60_000;
      await o.tick();
    }
    assert.equal(o.state.pipeline.paused, undefined, 'no pause while GitHub catches up');
    assert.notEqual(plan(o)!.status, 'ready_to_merge', 'nor a CI read on a head GitHub has yet to show');
    lagging = false;
    skew += 60_000;
    await until(o, () => plan(o)?.status === 'ready_to_merge');
    assert.equal(o.state.pipeline.paused, undefined);
  });

  it("takes the owner's push to a plan's branch, and runs CI on it", async () => {
    let skew = 0;
    const { orchestrator: o, fake } = await setup((f) => solved(f), { github: true, now: () => Date.now() + skew });
    await until(o, () => plan(o)?.status === 'ready_to_merge');
    const pushed = plan(o)!.pushed!;
    const head = await ownerCommit(fake.remote, 'plan/demo/P1', 'NOTES.md', 'by the owner\n');
    skew += 120_000;
    await until(o, () => plan(o)?.pushed === head && plan(o)?.status === 'ready_to_merge');
    assert.equal(o.state.pipeline.paused, undefined);
    assert.ok(await o.repo.isAncestor(pushed, plan(o)!.head));
    assert.ok(o.store.readAll().some((e) => e.type === 'PLAN_HEAD_ADOPTED'));
  });

  it('counts a CI run the owner starts again on GitHub, once it passes', async () => {
    let skew = 0;
    const { orchestrator: o, fake } = await setup((f) => solved(f), { github: true, config: { brakes: { ciFixRounds: 0 } }, now: () => Date.now() + skew });
    fake.ci = () => ({ verify: 'success', checks: 'failure' });
    await until(o, () => o.state.pipeline.paused !== undefined);
    assert.match(o.state.pipeline.paused!.reason, /^CI failed on PR #1 of demo\/P1 after 0 fix round\(s\)/);
    await fake.rerun(plan(o)!.pushed!, { checks: 'success' });
    assert.equal(o.resume(), true);
    skew += 120_000;
    await until(o, () => plan(o)?.status === 'ready_to_merge');
  });

  it('in Swarm, a review that passes with a blocking finding blocks', async () => {
    const review: ReviewBehavior = (role, rounds) => (role === 'security' && rounds === 0
      ? { verdict: 'pass', summary: 'Looks fine.', findings: [{ severity: 'blocking', title: 'Injection', detail: 'Quote it.' }] }
      : { verdict: 'pass', summary: 'Fine.', findings: [] });
    const { orchestrator: o, fake } = await setup(fixGreet, { github: true, review });
    o.setMode('swarm');
    await until(o, completed(o), 60_000);
    assert.deepEqual(fake.statusesSet[0] && [fake.statusesSet[0].context, fake.statusesSet[0].state], ['harness/security', 'failure']);
    assert.equal(o.state.features['demo/P1/fix1']!.fix!.kind, 'review');
  });
});

describe('deploys, continued', () => {
  const infra = (f: string): StubBehavior => (f === 'F02' ? { files: { ...SOLUTIONS.F02, 'iac/main.tf': '# a bucket\n' } } : solved(f));

  it('after a failed apply with no Fix PR left, looks again on resume, and a later apply on main counts', async () => {
    let skew = 0;
    let merge: string | undefined;
    const { orchestrator: o, fake } = await setup(infra, { github: true, config: { terraform: {}, brakes: { deployFixRounds: 0 } }, now: () => Date.now() + skew });
    fake.ci = (sha) => ({ verify: 'success', 'tf-plan': 'success', checks: 'success', 'tf-apply': sha === merge ? 'failure' : 'success' });
    await until(o, () => o.state.plans['demo/P1']?.status === 'ready_to_merge');
    merge = await fake.merge(1);
    skew += 120_000;
    await until(o, () => o.state.plans['demo/P1']?.status === 'deploy_failed' && o.state.pipeline.paused !== undefined);
    assert.match(o.state.pipeline.paused!.reason, /still fails after 0 Fix PR\(s\)/);
    // The owner fixes it on main; its apply succeeds.
    await ownerCommit(fake.remote, 'main', 'iac/fixed.tf', '# fixed\n');
    assert.equal(o.resume(), true);
    skew += 120_000;
    await until(o, completed(o));
    assert.equal(o.state.plans['demo/P1']!.deploy!.status, 'passed');
  });
});

describe('design changes', () => {
  const redefine = async (projectDir: string, id: string, description: string) => {
    const file = join(projectDir, 'harness/modules/demo/plans/P1.json');
    const design = JSON.parse(readFileSync(file, 'utf8')) as { features: Array<Record<string, unknown>> };
    design.features.find((f) => f.id === id)!.description = description;
    await commitOnMain(projectDir, { 'harness/modules/demo/plans/P1.json': JSON.stringify(design, null, 2) }, `redefine ${id}`);
  };

  it('in Manual, a design change that redefines the feature under way interrupts its attempt, and the next builds the new definition', async () => {
    const { orchestrator: o, harnessDir } = await setup((f) => ({ ...solved(f), sleepSec: f === 'F01' ? 6 : 0 }));
    await until(o, () => feature(o, 'F01')?.attempts[0]?.status === 'running');
    await redefine(join(harnessDir, '..'), 'F01', 'src/greet.sh prints hello, politely.');
    await until(o, completed(o), 60_000);
    const f01 = feature(o, 'F01')!;
    assert.equal(f01.attempts[0]!.status, 'interrupted');
    assert.equal(f01.attempts[0]!.reason, 'the design changed this feature while it was built: the next attempt builds the new definition');
    assert.equal(f01.attempts.at(-1)!.status, 'accepted');
  });

  it('builds again an accepted feature that a design change redefined while its plan is built', async () => {
    const { orchestrator: o, harnessDir } = await setup((f) => ({ ...solved(f), sleepSec: f === 'F02' ? 6 : 0 }));
    await until(o, () => feature(o, 'F01')?.status === 'accepted' && feature(o, 'F02')?.attempts[0]?.status === 'running');
    await redefine(join(harnessDir, '..'), 'F01', 'src/greet.sh prints hello, politely.');
    await until(o, completed(o), 60_000);
    const f01 = feature(o, 'F01')!;
    assert.equal(f01.attempts.length, 2);
    assert.notEqual(f01.attempts[1]!.definitionHash, f01.attempts[0]!.definitionHash);
    assert.equal(f01.attempts[1]!.status, 'accepted');
  });

  it('drops a feature waiting for guidance that a design change removed, and the Manager carries on', async () => {
    const { orchestrator: o, harnessDir } = await setup((f) => (f === 'F02' ? { outcome: 'blocked' } : solved(f)), { manager: { ignore: ['ATTEMPT'] } });
    await until(o, () => feature(o, 'F02')?.awaitingGuidanceSince !== undefined);
    const projectDir = join(harnessDir, '..');
    const file = join(projectDir, 'harness/modules/demo/plans/P1.json');
    const design = JSON.parse(readFileSync(file, 'utf8')) as { features: Array<{ id: string }> };
    design.features = design.features.filter((f) => f.id !== 'F02');
    await commitOnMain(projectDir, { 'harness/modules/demo/plans/P1.json': JSON.stringify(design, null, 2) }, 'drop F02');
    await until(o, completed(o));
    assert.equal(o.state.pipeline.paused, undefined);
  });
});

describe('architect, continued', () => {
  const shop = (behavior: Partial<ArchitectBehavior> = {}): ArchitectBehavior => ({ module: 'shop', design: toyDesign('shop'), summary: 'Greeting and adding', ...behavior });
  const module = (o: Orchestrator) => o.state.modules.shop;

  it("in Swarm, gives an Arch PR the reviewers' statuses as not reviewed, so the owner merges it without a bypass", async () => {
    const { orchestrator: o, fake } = await setup((f) => solved(f), { github: true, design: false, architect: shop() });
    o.setMode('swarm');
    o.createModule('shop', 'A tiny shop');
    await until(o, () => module(o)?.status === 'proposed');
    o.acceptProposal('shop', 1);
    await until(o, () => module(o)?.status === 'in_review' && fake.statusesSet.length >= 2);
    const head = (await runOk('git', ['--git-dir', fake.remote, 'rev-parse', 'refs/heads/arch/shop'])).trim();
    assert.deepEqual(fake.statusesSet.map((s) => [s.sha === head, s.context, s.state, s.description]), [
      [true, 'harness/security', 'success', 'not reviewed: an Arch PR, which the owner reviews and merges'],
      [true, 'harness/cost', 'success', 'not reviewed: an Arch PR, which the owner reviews and merges'],
    ]);
  });

  it('refuses a design change to a feature of a plan past its build', async () => {
    let skew = 0;
    const plan = JSON.parse(toyDesign('shop')['harness/modules/shop/plans/P1.json']!) as { features: Array<{ description: string }> };
    plan.features[0]!.description = 'src/greet.sh prints hello, politely.';
    const { orchestrator: o, fake } = await setup((f) => solved(f), {
      github: true, design: false, now: () => Date.now() + skew,
      architect: shop({ change: { 'harness/modules/shop/plans/P1.json': JSON.stringify(plan, null, 2) }, decision: 'Changed F01.' }),
    });
    o.createModule('shop', 'A tiny shop');
    await until(o, () => module(o)?.status === 'proposed');
    o.acceptProposal('shop', 1);
    await until(o, () => module(o)?.status === 'in_review');
    await fake.merge(1);
    skew += 120_000;
    await until(o, () => o.state.plans['shop/P1']?.status === 'ready_to_merge', 60_000);
    await fake.merge(2);
    skew += 120_000;
    await until(o, () => o.state.plans['shop/P1']?.status === 'completed');
    await handleRequest(o, { role: 'manager', sandbox: 'mgr-x', module: 'shop' }, { v: 1, id: 'esc-1', tool: 'escalate_to_architect', args: { question: 'Should F01 be polite?' } });
    await until(o, () => o.store.readAll().some((e) => e.type === 'DESIGN_REFUSED'));
    const refused = o.store.readAll().find((e) => e.type === 'DESIGN_REFUSED');
    assert.ok(refused && refused.type === 'DESIGN_REFUSED');
    assert.ok(refused.payload.problems.some((p) => /^P1\/F01: plan P1 is past its build \(completed\), so this feature is locked\. Fix a wrong definition with submit_locked_change, a CHANGED_LOCKED_FILES PR of its own; for new behavior, add a plan whose feature supersedes P1\/F01$/.test(p)), refused.payload.problems.join('\n'));
  });

  it("turns a change to a built feature's definition into a CHANGED_LOCKED_FILES PR, and keeps the feature accepted once it merges", async () => {
    let skew = 0;
    const plan = JSON.parse(toyDesign('shop')['harness/modules/shop/plans/P1.json']!) as { title: string; features: Array<{ expected: string }> };
    plan.features[0]!.expected = '`bash src/greet.sh` prints hello, and nothing else.';
    const { orchestrator: o, fake } = await setup((f) => solved(f), {
      github: true, design: false, now: () => Date.now() + skew,
      architect: shop({ locked: { 'harness/modules/shop/plans/P1.json': JSON.stringify(plan, null, 2) }, decision: "F01's expected result says more." }),
    });
    o.createModule('shop', 'A tiny shop');
    await until(o, () => module(o)?.status === 'proposed');
    o.acceptProposal('shop', 1);
    await until(o, () => module(o)?.status === 'in_review');
    await fake.merge(1);
    skew += 120_000;
    await until(o, () => o.state.plans['shop/P1']?.status === 'ready_to_merge', 60_000);
    await fake.merge(2);
    skew += 120_000;
    await until(o, () => o.state.plans['shop/P1']?.status === 'completed');

    // What a change to locked files can't do.
    const main = (await o.repo.revParse('refs/heads/main'))!;
    const refused = async (files: Record<string, string>) => {
      const head = await o.repo.commitTree({ parent: main, tree: main, files, message: 'a try\n', author: HARNESS, committer: HARNESS });
      const outcome = await submitLockedChange(o, module(o)!, 'A try', head);
      assert.equal(outcome.ok, false, JSON.stringify(files));
      return outcome.ok ? '' : outcome.problems.join('\n');
    };
    assert.match(await refused({ 'src/greet.sh': 'echo goodbye\n' }), /^src\/greet\.sh: a change to locked files changes only built features' definitions/);
    assert.match(await refused({ 'harness/modules/shop/plans/P1.json': JSON.stringify({ ...plan, title: 'Renamed' }) }), /^P1: the plan's own fields changed/);
    assert.match(await refused({ 'harness/modules/shop/checks/F01.sh': 'false\n' }), /^F01-greet fails on the change, though its feature is built: it must pass/);
    assert.match(await refused({ 'README.md': '# toy\n' }), /no built feature's definition changes/);

    // The Architect's own: on its first escalation, a branch from main with F01's new expected result.
    await handleRequest(o, { role: 'manager', sandbox: 'mgr-x', module: 'shop' }, { v: 1, id: 'esc-1', tool: 'escalate_to_architect', args: { question: "Is F01's expected result complete?" } });
    await until(o, () => module(o)?.locked?.pr !== undefined, 60_000);
    const pr = fake.prs.at(-1)!;
    assert.equal(pr.title, "Arch: [CHANGED_LOCKED_FILES] [shop] Fix F01's definition");
    assert.equal(pr.branch, 'locked/shop');
    assert.match(pr.body, /> \[!CAUTION\]\n> Changing locked files can make a broken feature look like it works/);
    assert.deepEqual(module(o)!.locked!.changes, [{ plan: 'P1', feature: 'F01', title: 'Greet', expected: plan.features[0]!.expected, fields: ['expected'], checks: [], scripts: [] }]);
    assert.equal(module(o)!.status, 'frozen', "it doesn't hold the build as a design change does");

    await fake.merge(pr.number);
    skew += 120_000;
    await until(o, () => module(o)?.locked === undefined);
    assert.equal(o.state.features['shop/P1/F01']!.lockedHashes?.length, 1);
    // Still accepted under its new definition: later work keeps passing its check.
    assert.ok((await o.regressionChecks('refs/heads/main')).some((c) => c.id === 'F01-greet'));
  });
});

describe('one module at a time', () => {
  /** The toy design in two plans, P1 greets and P2 adds; P2 waits for P1 unless `independent`. */
  const twoPlans = (independent: boolean) => async (dir: string) => {
    const file = join(dir, 'harness/modules/demo/plans/P1.json');
    const design = JSON.parse(readFileSync(file, 'utf8')) as { features: Array<Record<string, unknown>> };
    const [f01, f02] = design.features as [Record<string, unknown>, Record<string, unknown>];
    delete f02.dependsOn;
    await commitOnMain(dir, {
      'harness/modules/demo/plans/P1.json': JSON.stringify({ ...design, features: [f01] }, null, 2),
      'harness/modules/demo/plans/P2.json': JSON.stringify({ ...design, id: 'P2', title: 'Adding', ...(independent ? { dependsOn: [] } : {}), features: [f02] }, null, 2),
    }, 'two plans');
  };
  const dropP1 = async (projectDir: string) => {
    rmSync(join(projectDir, 'harness/modules/demo/plans/P1.json'));
    await commitOnMain(projectDir, {}, 'drop P1');
  };
  const slowF01 = (f: string): StubBehavior => ({ ...solved(f), sleepSec: f === 'F01' ? 6 : 0 });
  const dropped = 'the design no longer has this feature: the attempt stops';

  it('in Manual, a design change that drops the plan under way stops its attempt, and the next plan builds', async () => {
    const { orchestrator: o, harnessDir } = await setup(slowF01, { prepare: twoPlans(false) });
    await until(o, () => o.state.features['demo/P1/F01']?.attempts[0]?.status === 'running');
    await dropP1(join(harnessDir, '..'));
    await until(o, () => o.state.plans['demo/P2']?.status === 'completed', 60_000);
    assert.equal(o.state.features['demo/P1/F01']!.attempts[0]!.reason, dropped);
  });

  it('in Swarm, a plan dropped while it is built leaves its place under swarm.maxPlans, and its Manager stays stopped', async () => {
    const { orchestrator: o, harnessDir } = await setup(slowF01, { prepare: twoPlans(true), config: { swarm: { maxPlans: 1 } } });
    o.setMode('swarm');
    await until(o, () => o.state.features['demo/P1/F01']?.attempts[0]?.status === 'running' && o.state.managers['demo/P1']?.status === 'running');
    await dropP1(join(harnessDir, '..'));
    await until(o, () => o.state.plans['demo/P2']?.status === 'completed', 60_000);
    assert.equal(o.state.features['demo/P1/F01']!.attempts[0]!.reason, dropped);
    const starts = o.store.readAll().filter((e) => e.type === 'MANAGER_STARTING' && e.payload.plan === 'P1');
    assert.equal(starts.length, 1);
    assert.equal(o.state.managers['demo/P1']!.status, 'stopped');
  });

  it('in Swarm, with two modules under way, as 0.2.0 could leave them, only the older one has Developers and Managers until it is complete', async () => {
    const decide = (f: string): StubBehavior => (f === 'A01' ? { files: { 'src/alpha.txt': '1\n' }, sleepSec: 6 } : solved(f));
    const { orchestrator: o } = await setup(decide, { prepare: (dir) => commitOnMain(dir, alphaDesign, 'the alpha design') });
    o.setMode('swarm');
    await until(o, () => o.state.features['alpha/P1/A01']?.attempts[0]?.status === 'running');
    // What 0.2.0 did: demo's first plan started alongside alpha's, with an attempt and a Manager.
    const internals = o as unknown as { startPlan(ref: object): Promise<unknown>; scheduleWork(ref: object, definition: object, state: undefined): Promise<unknown> };
    await internals.startPlan({ module: 'demo', plan: 'P1' });
    await internals.scheduleWork({ module: 'demo', plan: 'P1', feature: 'F01' }, o.design.modules.find((m) => m.id === 'demo')!.plans[0]!.features[0]!, undefined);
    o.record({ type: 'MANAGER_STARTING', payload: { module: 'demo', plan: 'P1', sandbox: 'mgr-toy-demo-p1', sessionId: 'session' } });
    const forced = o.store.readAll().length;
    await until(o, () => o.state.plans['demo/P1']?.status === 'completed', 90_000);

    const events = o.store.readAll();
    const alphaDone = events.findIndex((e) => e.type === 'PLAN_COMPLETED' && e.ref?.module === 'alpha');
    assert.ok(alphaDone > forced, 'alpha completed after the forced start');
    const meanwhile = events.slice(forced, alphaDone);
    assert.ok(!meanwhile.some((e) => (e.type === 'ATTEMPT_STARTING' || e.type === 'MANAGER_STARTING') && (e.ref?.module ?? (e.payload as { module?: string }).module) === 'demo'), 'nothing of demo started before alpha was complete');
    const stopped = meanwhile.find((e) => e.type === 'MANAGER_STOPPED' && e.payload.module === 'demo');
    assert.ok(stopped && stopped.type === 'MANAGER_STOPPED');
    assert.equal(stopped.payload.reason, 'another module is being built');
    const f01 = o.state.features['demo/P1/F01']!;
    assert.equal(f01.attempts[0]!.status, 'interrupted');
    assert.equal(f01.attempts[0]!.reason, 'another module is being built: this one goes on once that one is complete');
    assert.equal(f01.attempts.at(-1)!.status, 'accepted');
  });
});
