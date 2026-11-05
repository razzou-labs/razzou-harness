import { strict as assert } from 'node:assert';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import type { SubscriptionUsage } from '../src/anthropic/usage.ts';
import { Orchestrator } from '../src/daemon/orchestrator.ts';
import { handleRequest } from '../src/daemon/requests.ts';
import { startDashboard } from '../src/dashboard/server.ts';
import { Terminals, type Pty } from '../src/dashboard/terminals.ts';
import { recover } from '../src/setup/recover.ts';
import { runOk, sleep } from '../src/util.ts';
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

interface SetupOptions {
  config?: Record<string, unknown>;
  manager?: ManagerBehavior;
  prepare?: (projectDir: string) => Promise<void>;
  now?: () => number;
  /** Plays the project on a fake GitHub, with pull requests and CI. */
  github?: boolean;
  /** Replaces the subscription's usage endpoint (v3 §4.3). */
  usage?: () => Promise<SubscriptionUsage | undefined>;
  /** What the stub reviewers answer (v3 §5); every review passes by default. */
  review?: ReviewBehavior;
  /** Starts with no design: an Architect writes it. */
  design?: boolean;
  architect?: ArchitectBehavior;
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
    const made = new Orchestrator({
      projectDir,
      harnessDir,
      driver,
      packageDir,
      version: 'test',
      agent: stubAgent(decide, options.manager, options.architect, options.review),
      webRead: async (url) => ({ ok: true, text: `the page at ${url}`, bytes: 20 }),
      // HARNESS_TEST_LOG=1 prints the daemon's log, for a step that fails silently.
      ...(process.env.HARNESS_TEST_LOG ? { log: (message: string) => console.error(`[daemon] ${message}`) } : {}),
      ...(options.usage ? { usage: options.usage } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(fake ? { forge: () => fake } : {}),
    });
    cleanup.push(() => made.stop(0));
    return made;
  };
  cleanup.push(() => driver.removeAll());
  const orchestrator = make();
  await orchestrator.start();
  return { harnessDir, orchestrator, make, driver, fake: fake! };
}

/** Ticks until `done` holds, giving the detached stubs time to work. */
async function until(o: Orchestrator, done: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out; last events: ${o.store.readAll().slice(-8).map((e) => e.type).join(', ')}`);
    }
    await o.tick();
    await sleep(100);
  }
}

const solved = (feature: string): StubBehavior => ({ files: SOLUTIONS[feature as keyof typeof SOLUTIONS] });
const feature = (o: Orchestrator, id: string) => o.state.features[`demo/P1/${id}`];
const completed = (o: Orchestrator) => () => o.state.plans['demo/P1']?.status === 'completed';

describe('orchestrator', () => {
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

  it('pauses the pipeline when it never starts', async () => {
    const { orchestrator: o } = await setup((f) => solved(f), { manager: { failStart: true } });
    await until(o, () => o.state.pipeline.paused !== undefined);
    assert.match(o.state.pipeline.paused!.reason, /^environment: the Manager did not start: Error: unknown option --stub-bad-flag/);
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

describe('pull requests', () => {
  const plan = (o: Orchestrator) => o.state.plans['demo/P1'];
  const ready = (o: Orchestrator) => () => plan(o)?.status === 'ready_to_merge';

  it('opens one pull request for the plan, waits for CI and the owner, and completes on merge', async () => {
    let skew = 0;
    const { orchestrator: o, fake } = await setup((f) => solved(f), { github: true, now: () => Date.now() + skew });
    await until(o, ready(o));

    assert.equal(fake.prs.length, 1);
    const pr = fake.prs[0]!;
    assert.equal(pr.title, 'Plan: demo/P1 -CODE- Greeting and adding');
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

    assert.equal(fake.prs[0]!.title, 'Plan: demo/P1 -CODE- Greeting and adding');
    assert.equal(plan(o)!.mergedBy, 'daemon');
    assert.equal(plan(o)!.leftToOwner, undefined);
    const main = (await runOk('git', ['--git-dir', fake.remote, 'rev-parse', 'refs/heads/main'])).trim();
    assert.equal(plan(o)!.mergeCommit, main);
    const merged = o.store.readAll().find((e) => e.type === 'PR_MERGED_BY_DAEMON');
    assert.ok(merged && merged.type === 'PR_MERGED_BY_DAEMON' && merged.payload.commit === main);
    assert.equal(o.state.managers.demo!.status, 'stopped');
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

  it('in Swarm, an INFRA plan waits for the owner without a cost estimate, and in Manual every plan does', async () => {
    let skew = 0;
    const infra = async (dir: string) => {
      const file = join(dir, 'harness/modules/demo/plans/P1.json');
      const design = JSON.parse(readFileSync(file, 'utf8')) as { features: Array<Record<string, unknown>> };
      for (const feature of design.features) feature.kind = 'infra';
      writeFileSync(file, JSON.stringify(design, null, 2));
      await runOk('git', ['-C', dir, '-c', 'user.name=o', '-c', 'user.email=o@test.invalid', 'commit', '--quiet', '-am', 'infra plan']);
    };
    const { orchestrator: o, fake } = await setup((f) => solved(f), { github: true, prepare: infra, now: () => Date.now() + skew });
    o.setMode('swarm');
    fake.statuses = () => ({ 'harness/security': 'success', 'harness/cost': 'success' });
    await until(o, () => plan(o)?.leftToOwner !== undefined);
    assert.equal(fake.prs[0]!.title, 'Plan: demo/P1 -INFRA- Greeting and adding');
    assert.match(plan(o)!.leftToOwner!.reason, /a INFRA plan merges itself only with the cost job's estimate/);

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

  it('in Swarm, starts no attempt at or above the usage ceiling, and goes on once the window resets', async () => {
    let skew = 0;
    let percent = 85;
    let reads = 0;
    // Ten minutes away: past the reading's five-minute cache, and well under the Manager's turn, which event times would trip.
    const resetsAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const usage = async () => {
      reads++;
      return { percent, resetsAt, limits: [{ kind: 'session', percent: 20, resetsAt }, { kind: 'weekly_all', percent, resetsAt }] };
    };
    const { orchestrator: o } = await setup((f) => solved(f), { usage, now: () => Date.now() + skew });
    o.setMode('swarm');
    await until(o, () => o.state.pipeline.paused !== undefined);
    assert.equal(o.state.pipeline.paused!.reason, "the subscription's usage is at 85% (weekly_all), at or above the 80% ceiling (swarm.usageCeilingPercent)");
    assert.equal(o.state.pipeline.paused!.until, resetsAt);
    assert.equal(Object.keys(o.state.features).length, 0);
    assert.equal(o.usage!.usage.percent, 85);

    // The window resets: the pause lifts, the usage is read again (the reading is older than five minutes), and the build goes on.
    percent = 30;
    skew += 10 * 60_000 + 1000;
    await until(o, completed(o));
    assert.ok(reads >= 2, `read ${reads} times`);
    assert.equal(o.usage!.usage.percent, 30);
  });

  it('in Manual, never reads the usage', async () => {
    let reads = 0;
    const { orchestrator: o } = await setup((f) => solved(f), {
      usage: async () => {
        reads++;
        return { percent: 99, resetsAt: new Date().toISOString(), limits: [] };
      },
    });
    await until(o, completed(o));
    assert.equal(reads, 0);
  });

  it('in Swarm, both reviewers read the head, their verdicts are posted and set as statuses, and the plan merges itself', async () => {
    const { orchestrator: o, fake } = await setup((f) => solved(f), { github: true });
    o.setMode('swarm');
    await until(o, completed(o));

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
    assert.equal(o.state.pipeline.paused!.reason, 'CI failed on PR #1 of demo/P1 after 1 fix round(s): the owner decides');
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
    assert.equal(fake.prs[1]!.title, 'Fix: demo/P1 — after the deploy, round 1');
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
    assert.equal(pr.title, 'Arch: shop — Greeting and adding');
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
    assert.equal(fake.prs[1]!.title, 'Plan: shop/P1 -CODE- Greeting and adding');

    // The Manager asks the Architect, and the decision comes back to it.
    const asked = await handleRequest(o, { role: 'manager', sandbox: 'mgr-x', module: 'shop' }, {
      v: 1, id: 'esc-1', tool: 'escalate_to_architect', args: { question: 'One script or two?' },
    });
    assert.equal(asked!.ok, true);
    await until(o, () => module(o)?.escalations[0]?.decision !== undefined);
    assert.equal(module(o)!.escalations[0]!.decision, 'Use two scripts.');
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
    // The stub's proposal is two lines: reading it rounds to nothing.
    assert.match(problems[1]!, /^the design takes 10 h of the owner's time \(10 h of owner actions, 0 h to read the proposal\), but 8 h are available/);
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
  async function dashboard(terminals = new Terminals(undefined)) {
    const { orchestrator: o } = await setup((f) => solved(f));
    const webRoot = tempDir('web');
    writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>harness</title>');
    mkdirSync(join(webRoot, 'assets'));
    writeFileSync(join(webRoot, 'assets', 'app.js'), 'console.log("app")');
    const server = await startDashboard({ orchestrator: o, port: 0, token, webRoot, terminals });
    cleanup.push(async () => void server.close());
    const port = (server.address() as AddressInfo).port;
    const host = `127.0.0.1:${port}`;
    return { o, port, host, bearer: { host, authorization: `Bearer ${token}` } };
  }

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
    const login = await call(port, `/?token=${token}`, { host });
    assert.equal(login.status, 303);
    assert.match(String(login.headers['set-cookie']), /^harness_token=[0-9a-f]+; HttpOnly; SameSite=Strict/);
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

  it('pauses and resumes for the owner, and shows the agents\' transcripts', async () => {
    const { o, port, bearer } = await dashboard();
    const post = async (path: string, body: object) => JSON.parse((await callWith(port, path, bearer, body)).body) as { done: boolean };
    assert.equal((await post('/api/pause', {})).done, true);
    assert.equal(o.state.pipeline.paused?.reason, 'the owner paused the pipeline');
    assert.equal((await post('/api/resume', {})).done, true);

    o.events.emit('transcript', { agent: 'manager:demo', line: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(5000) }] } }) });
    o.events.emit('transcript', { agent: 'manager:demo', line: 'not json' });
    const items = JSON.parse((await call(port, '/api/transcript?agent=manager:demo', bearer)).body) as Array<{ message: { content: Array<{ text: string }> } }>;
    assert.equal(items.length, 1);
    assert.match(items[0]!.message.content[0]!.text, /^x{4000}… \(1000 more characters\)$/);
    assert.equal((await call(port, '/api/transcript?agent=developer:../../etc/a1', bearer)).status, 404);
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
    const cookie = `harness_token=${token}`;
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
