import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeCode, mcpConfig, readResult, reportJsonSchema, type AgentAdapter, type AgentRun } from '../agents/claude-code.ts';
import { allPassed, initEnvironment, runChecks, type CheckResult, type RunOptions } from '../checks/runner.ts';
import { protectedChanges } from '../ci/harness-ci.ts';
import { definitionHash, loadDesign, requiredChecks, type Check, type Config, type Design, type Feature, type Plan } from '../design/schemas.ts';
import { DEVELOPER, HARNESS, Repo } from '../git/repo.ts';
import { GitHubClient, loadAppCredentials } from '../github/app.ts';
import { GitHubForge, LocalForge, type CheckRun, type Forge } from '../github/forge.ts';
import { toolsManifest, type Role } from '../roles.ts';
import type { ExecResult, Follower, SandboxDriver } from '../sandbox/driver.ts';
import { BUNDLES } from '../sandbox/allowlist.ts';
import { buildPolicy } from '../sandbox/policy.ts';
import { EventStore, type CiJob, type HarnessEvent, type NewEvent, type Ref } from '../state/events.ts';
import {
  activeAttempt, apply, countedAttempts, featureKey, interruptions, planKey, project, writeSnapshot,
  type Attempt, type FeatureState, type PlanState, type State,
} from '../state/state.ts';
import { clip, sh, sleep } from '../util.ts';
import { Architects } from './architects.ts';
import { AgentChannel, type AgentRequest } from './channel.ts';
import { Managers } from './manager.ts';
import { attemptRefName, preMerge, probeScript, refOf, sandboxName, waitForFile } from './refs.ts';
import { handleRequest, type AgentIdentity, type Reply } from './requests.ts';
import { buildTask } from './task.ts';
import { webRead, type WebReadResult } from './web-read.ts';

export interface OrchestratorOptions {
  /** The project's own repository. In M1 and M2 its main branch is the source of truth. */
  projectDir: string;
  /** The project's `.harness/` directory. */
  harnessDir: string;
  driver: SandboxDriver;
  /** The package's root: its `roles/` and `shim/` go into the sandboxes. */
  packageDir: string;
  version: string;
  agent?: AgentAdapter;
  /** Tests replace the web; the daemon reads it. */
  webRead?: (url: string) => Promise<WebReadResult>;
  /** Tests replace GitHub. By default: GitHub through the App when the project names a repository, else the project's own folder. */
  forge?: (config: Config) => Forge;
  now?: () => number;
  log?: (message: string) => void;
}

/** One step either changed something, so the loop runs again at once, or has to wait for the world. */
type Step = 'progress' | 'wait';

/** After this many errors in a row on the same attempt (infrastructure, not the agent), the attempt is interrupted. */
const STEP_ERROR_LIMIT = 5;

/**
 * Runs the loop in code (proposal v2 §7). Each pass looks at the state and takes the
 * next step for the one active attempt, or starts the next piece of work, then brings
 * the Manager up to date. Every step records an event before it moves on, so after a
 * restart the same pass picks up where the previous process stopped.
 */
export class Orchestrator {
  /**
   * For the dashboard: 'event' (a HarnessEvent), 'transcript' ({ agent, line }: a line of
   * an agent's stream-json) and 'architect-inbox' ({ module, sandbox }).
   */
  readonly events = new EventEmitter();
  readonly store: EventStore;
  state: State;
  design!: Design;
  repo!: Repo;
  readonly options: OrchestratorOptions;
  readonly driver: SandboxDriver;
  readonly agent: AgentAdapter;
  readonly managers: Managers;
  readonly architects: Architects;
  readonly now: () => number;
  readonly log: (message: string) => void;
  readonly webRead: (url: string) => Promise<WebReadResult>;
  forge!: Forge;

  private ticking?: Promise<void>;
  /** When each open PR may be polled again. */
  private readonly nextPoll = new Map<string, number>();
  private again = false;
  private stopping = false;
  private stepErrors = { key: '', count: 0 };
  private developer?: { sandbox: string; follower: Follower; channel: AgentChannel };

  constructor(options: OrchestratorOptions) {
    this.options = options;
    this.driver = options.driver;
    this.agent = options.agent ?? claudeCode;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this.webRead = options.webRead ?? ((url) => webRead(url));
    this.store = new EventStore(join(options.harnessDir, 'events.jsonl'));
    this.state = project(this.store.readAll());
    this.managers = new Managers(this);
    this.architects = new Architects(this);
  }

  async start(): Promise<void> {
    this.repo = await Repo.open(join(this.options.harnessDir, 'git', 'repo.git'));
    // The owner's own copy says where the project lives; from then on, main comes from there.
    await this.repo.fetchMain(this.options.projectDir);
    const { config } = await loadDesign(this.repo, 'refs/heads/main');
    this.forge = this.options.forge?.(config) ?? makeForge(config, this.options.projectDir);
    if (this.forge.kind === 'github' && this.forge.bot !== config.project.bot) {
      throw new Error(`harness/config.json says the bot is ${config.project.bot}, but the App here is ${this.forge.bot}`);
    }
    await this.refreshDesign();
    this.record({ type: 'DAEMON_STARTED', payload: { version: this.options.version, pid: process.pid } });
  }

  /**
   * Takes no new step, and waits a little for the one under way. A step cut short is
   * safe: it is taken again from the start after a restart.
   */
  async stop(graceMs = 10_000): Promise<void> {
    this.stopping = true;
    this.stopFollowing();
    this.managers.detach();
    this.architects.detach();
    if (this.ticking) await Promise.race([this.ticking, sleep(graceMs)]);
    this.record({ type: 'DAEMON_STOPPED', payload: {} });
  }

  /** One pass of the loop. If a pass is running, it runs once more when it ends. */
  tick(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.ticking) {
      this.again = true;
      return this.ticking;
    }
    this.ticking = this.pass().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }

  /** Something happened outside the loop (an agent's request, an owner action): look again soon. */
  kick(): void {
    void this.tick();
  }

  private async pass(): Promise<void> {
    do {
      this.again = false;
      try {
        for (let i = 0; i < 50 && !this.stopping && (await this.step()) === 'progress'; i++);
      } catch (error) {
        await this.onStepError(error as Error);
      }
      if (!this.stopping) await this.managers.sync();
      if (!this.stopping) await this.architects.sync();
      if (!this.stopping) await this.verifyActions().catch((error: Error) => this.log(`owner action: ${error.message}`));
    } while (this.again && !this.stopping);
  }

  // ── Owner actions ────────────────────────────────────────────────────────────

  /** The owner pauses the pipeline: what runs goes on, and nothing new starts. */
  pause(): boolean {
    if (this.state.pipeline.paused) return false;
    this.record({ type: 'PIPELINE_PAUSED', payload: { reason: 'the owner paused the pipeline' } });
    return true;
  }

  /** The owner lifts a pause. */
  resume(): boolean {
    if (!this.state.pipeline.paused) return false;
    this.record({ type: 'PIPELINE_RESUMED', payload: {} });
    this.kick();
    return true;
  }

  /** The owner grants one more attempt to an escalated feature (`module/plan/feature`). */
  retry(key: string, note?: string): boolean {
    const feature = this.state.features[key];
    if (feature?.status !== 'escalated') return false;
    this.record({ type: 'OWNER_RETRY', ref: { module: feature.module, plan: feature.plan, feature: feature.feature }, payload: note ? { note } : {} });
    this.kick();
    return true;
  }

  /** The owner writes to the Manager of the module being built. */
  messageManager(text: string): boolean {
    const module = this.currentModule();
    const manager = module ? this.state.managers[module] : undefined;
    if (!module || !manager || manager.status === 'stopped' || text.trim() === '') return false;
    this.record({ type: 'OWNER_MESSAGE', from: 'owner', to: 'manager', payload: { module, text: text.trim() } });
    this.kick();
    return true;
  }

  /** The owner starts a module: its Architect's sandbox and conversation (§7.1). Returns why not, if not. */
  createModule(id: string, title: string): string | undefined {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/.test(id)) return 'a module id uses letters, digits and dashes (at most 40)';
    if (this.state.modules[id] || this.design.modules.some((m) => m.id === id)) return `a module named ${id} already exists`;
    this.record({
      type: 'MODULE_CREATED',
      from: 'owner',
      payload: { module: id, title: title.trim() || id, sandbox: sandboxName('arc', this.design.config.project.name, id), sessionId: randomUUID() },
    });
    this.kick();
    return undefined;
  }

  /** The owner accepts proposal vN: the Architect decomposes it next. */
  acceptProposal(module: string, version: number): boolean {
    const state = this.state.modules[module];
    if (!state || !['designing', 'proposed'].includes(state.status) || !state.proposals.some((p) => p.version === version)) return false;
    this.record({ type: 'ARCHITECTURE_ACCEPTED', from: 'owner', payload: { module, version } });
    this.kick();
    return true;
  }

  /** The owner says an action is done. One with a `verify` command counts once that passes (§8.4). */
  claimAction(module: string, actionId: string, note?: string): boolean {
    const action = this.design.modules.find((m) => m.id === module)?.actions.find((a) => a.id === actionId);
    const current = this.state.actions[`${module}/${actionId}`];
    if (!action || current?.status === 'done' || current?.status === 'verifying') return false;
    this.record({ type: 'OWNER_ACTION_CLAIMED', from: 'owner', payload: { module, action: actionId, ...(note ? { note } : {}) } });
    if (!action.verify) this.record({ type: 'OWNER_ACTION_DONE', payload: { module, action: actionId, title: action.title, gate: action.kind === 'gate' } });
    this.kick();
    return true;
  }

  /** Gates not done yet that hold back a plan, or a feature of it (§8.4). */
  gatesHolding(module: string, plan: string, feature?: Feature): string[] {
    const actions = this.design.modules.find((m) => m.id === module)?.actions ?? [];
    return actions
      .filter((a) => a.kind === 'gate' && this.state.actions[`${module}/${a.id}`]?.status !== 'done')
      .filter((a) => a.blocks.includes(plan) || (feature !== undefined && (a.blocks.includes(`${plan}/${feature.id}`) || feature.gates.includes(a.id))))
      .map((a) => a.id);
  }

  private async verifyActions(): Promise<void> {
    for (const [key, action] of Object.entries(this.state.actions)) {
      if (action.status !== 'verifying') continue;
      const [module, id] = key.split('/') as [string, string];
      const definition = this.design.modules.find((m) => m.id === module)?.actions.find((a) => a.id === id);
      if (!definition) continue;
      const results = definition.verify
        ? await this.runChecksIn(sandboxName('chk', this.design.config.project.name, key, 'act'), 'refs/heads/main', this.moduleDir(module), [
          { id: `${id}-verify`, run: definition.verify.run, phase: 'pre-merge', timeoutSec: definition.verify.timeoutSec, needs: definition.verify.needs },
        ])
        : [];
      const failed = results.find((r) => r.exit !== 0);
      if (failed) {
        this.record({ type: 'OWNER_ACTION_REFUSED', payload: { module, action: id, reason: `its check failed: ${clip(failed.output.trim(), 800)}` } });
      } else {
        this.record({ type: 'OWNER_ACTION_DONE', payload: { module, action: id, title: definition.title, gate: definition.kind === 'gate' } });
      }
    }
  }

  /** The owner answers a Manager's `ask_owner`. */
  answerOwnerRequest(requestId: string, answer: string): boolean {
    const request = this.state.ownerRequests[requestId];
    if (!request || request.answer !== undefined || answer.trim() === '') return false;
    this.record({ type: 'OWNER_ANSWER', from: 'owner', to: 'manager', payload: { module: request.module, requestId, answer: answer.trim() } });
    this.kick();
    return true;
  }

  private async step(): Promise<Step> {
    const paused = this.state.pipeline.paused;
    if (paused?.until && this.now() >= Date.parse(paused.until)) {
      this.record({ type: 'PIPELINE_RESUMED', payload: {} });
      return 'progress';
    }
    const active = activeAttempt(this.state);
    if (active) {
      const { feature, attempt } = active;
      switch (attempt.status) {
        case 'starting':
          return this.prepare(feature, attempt);
        case 'running':
          return this.poll(feature, attempt);
        case 'collecting':
          return this.collect(feature, attempt);
        case 'checking':
          return this.check(feature, attempt);
        default:
          return this.review(feature, attempt);
      }
    }
    if (paused) return 'wait';
    return this.scheduleNext();
  }

  // ── Choosing work ────────────────────────────────────────────────────────────

  /** The first plan, in module order, that isn't complete; in it, the first feature that isn't accepted. */
  private async scheduleNext(): Promise<Step> {
    await this.refreshDesign();
    for (const module of this.design.modules) {
      for (const plan of module.plans) {
        const planRef = { module: module.id, plan: plan.id };
        const planState = this.state.plans[planKey(planRef)];
        if (planState?.status === 'completed') continue;
        if (!planState) return this.gatesHolding(module.id, plan.id).length > 0 ? 'wait' : this.startPlan(planRef);
        switch (planState.status) {
          case 'validating':
            return this.validatePlan(planState);
          case 'pr_open':
            // A Fix PR has no pull request until its fix lands.
            return planState.pr ? this.followPullRequest(planState) : this.openPullRequest(planState);
          case 'ready_to_merge':
            return this.followPullRequest(planState);
          case 'deploying':
            return this.followDeploy(planState);
          case 'verifying':
            return this.verifyDeploy(planState);
          case 'deploy_failed':
          case 'verify_failed':
            return 'wait';
          case 'fixing': {
            const fix = this.state.features[`${planKey(planRef)}/fix${planState.fixes}`]!;
            // A Fix PR's branch starts from the merge.
            if (!(await this.repo.revParse(`refs/heads/${planState.branch}`))) await this.repo.setRef(`refs/heads/${planState.branch}`, planState.base, '');
            return this.scheduleWork({ ...planRef, feature: fix.feature }, this.lookup(fix).feature, fix) ?? 'wait';
          }
        }
        if (await this.mergeMain(planState)) return 'progress';
        for (const feature of plan.features) {
          const ref = { ...planRef, feature: feature.id };
          const step = this.scheduleWork(ref, feature, this.state.features[featureKey(ref)]);
          if (step) return step;
        }
        this.record({ type: 'PLAN_VALIDATING', ref: planRef, payload: { head: planState.head } });
        return 'progress';
      }
    }
    return 'wait';
  }

  /** The next attempt of a feature or a fix round, or why there can't be one yet. Undefined once it is accepted. */
  private scheduleWork(ref: Ref, definition: Feature, state: FeatureState | undefined): Step | undefined {
    if (state?.status === 'accepted') return undefined;
    const hash = definitionHash(definition);
    // The owner decides about an escalated feature, unless a design change redefined it since (§7.1).
    if (state?.status === 'escalated' && state.attempts.at(-1)?.definitionHash === hash) return 'wait';
    const used = state ? countedAttempts(state, hash) : 0;
    const allowed = this.design.config.roles.developer.maxAttempts + (state?.extraAttempts ?? 0);
    if (used >= allowed) {
      this.record({ type: 'ESCALATED', ref, payload: { reason: `${used} attempt(s) failed; the owner decides what happens next` } });
      return 'progress';
    }
    // A second attempt never starts without the Manager's guidance (§7.4).
    if (state?.awaitingGuidanceSince) return 'wait';
    if (this.blockedByOwner(ref.module) || this.designChanging(ref.module) || this.gatesHolding(ref.module, ref.plan, definition).length > 0) return 'wait';
    return this.startAttempt(ref, hash, state);
  }

  /**
   * A design change merged while a plan is built reaches the plan branch before the next
   * attempt: the daemon merges main into it. The branch isn't pushed yet (§11.3).
   */
  private async mergeMain(plan: PlanState): Promise<boolean> {
    const main = (await this.repo.revParse('refs/heads/main'))!;
    if (await this.repo.isAncestor(main, plan.head)) return false;
    const merged = await this.repo.merge({ ours: plan.head, theirs: main, message: `Merge main into ${plan.branch}\n`, committer: HARNESS });
    if ('conflicts' in merged) {
      this.record({ type: 'PIPELINE_PAUSED', payload: { reason: `main changed files that ${plan.branch} changed too, so the daemon can't merge it in: ${merged.conflicts.join(', ')}` } });
      return true;
    }
    await this.repo.setRef(`refs/heads/${plan.branch}`, merged.commit, plan.head);
    this.record({ type: 'PLAN_MAIN_MERGED', ref: { module: plan.module, plan: plan.plan }, payload: { main, head: merged.commit } });
    return true;
  }

  private async startPlan(ref: Ref): Promise<Step> {
    const branch = `plan/${ref.module}/${ref.plan}`;
    const existing = await this.repo.revParse(`refs/heads/${branch}`);
    const base = existing ?? (await this.repo.revParse('refs/heads/main'))!;
    if (!existing) await this.repo.setRef(`refs/heads/${branch}`, base, '');
    this.record({ type: 'PLAN_STARTED', ref, payload: { branch, base } });
    return 'progress';
  }

  private startAttempt(featureRef: Ref, hash: string, state?: FeatureState): Step {
    const ref = { ...featureRef, attempt: (state?.attempts.length ?? 0) + 1 };
    const minutes = this.design.config.roles.developer.attemptTimeoutMinutes;
    this.record({
      type: 'ATTEMPT_STARTING',
      ref,
      payload: {
        sandbox: sandboxName('dev', this.design.config.project.name, featureKey(ref), `a${ref.attempt}`),
        base: this.state.plans[planKey(ref)]!.head,
        sessionId: randomUUID(),
        deadline: new Date(this.now() + minutes * 60_000).toISOString(),
        definitionHash: hash,
      },
    });
    return 'progress';
  }

  // ── The attempt (§7.3) ───────────────────────────────────────────────────────

  /** Steps 3–5: a fresh sandbox with the plan branch, the environment, the baseline, then the Developer. */
  private async prepare(state: FeatureState, attempt: Attempt): Promise<Step> {
    const ref = refOf(state, attempt);
    const { plan, feature } = this.lookup(state);
    const sandbox = attempt.sandbox;
    const p = this.paths(sandbox);
    const dir = this.attemptDir(ref);
    const branch = this.state.plans[planKey(ref)]!.branch;

    await this.driver.remove(sandbox);
    await this.driver.create({
      name: sandbox,
      image: this.design.config.sandbox.image,
      ...this.access({ claude: true, aws: true }),
      command: ['sleep', 'infinity'],
    });

    await this.repo.bundle(`refs/heads/${branch}`, join(dir, 'plan.bundle'));
    const previous = state.attempts.filter((a) => a.n < attempt.n && a.status === 'failed').at(-1);
    const progress = (await this.repo.show(`refs/heads/${branch}`, 'progress.txt')) ?? '';
    writeFileSync(join(dir, 'task.md'), buildTask({
      ref, plan, feature, previous,
      ...(attempt.guidance ? { guidance: attempt.guidance } : {}),
      regressionChecks: this.regressionChecks(),
      progressTail: progress.split('\n').slice(-21).join('\n'),
    }));
    copyFileSync(join(this.options.packageDir, 'roles', 'developer.md'), join(dir, 'developer.md'));
    writeFileSync(join(dir, 'report.schema.json'), reportJsonSchema());
    for (const file of ['plan.bundle', 'task.md', 'developer.md', 'report.schema.json']) {
      await this.driver.upload(sandbox, join(dir, file), p.harness);
    }
    await this.uploadAgentFiles(sandbox, 'developer', dir);

    const clone = await this.exec(sandbox, [
      `git clone --quiet --branch ${sh(branch)} ${sh(`${p.harness}/plan.bundle`)} ${sh(p.work)}`,
      `cd ${sh(p.work)}`,
      `git config user.name ${sh(DEVELOPER.name)}`,
      `git config user.email ${sh(DEVELOPER.email)}`,
      'git checkout --quiet -b attempt',
    ].join(' && '));
    if (clone.code !== 0) return this.interrupt(state, attempt, `could not clone the plan branch: ${clone.stderr.trim()}`);

    const init = await initEnvironment(this.driver, sandbox, p.work);
    if (init && init.exit !== 0) return this.baselineFailed(state, attempt, 'init.sh failed', [init]);
    const regression = await runChecks(this.driver, sandbox, p.work, this.regressionChecks(), this.checkOptions(sandbox));
    if (!allPassed(regression)) {
      return this.baselineFailed(state, attempt, 'checks of accepted work fail before the attempt starts', regression);
    }
    const own = preMerge(feature.checks);
    if (own.length > 0 && allPassed(await runChecks(this.driver, sandbox, p.work, own, this.checkOptions(sandbox)))) {
      this.record({ type: 'ATTEMPT_INTERRUPTED', ref, payload: { reason: "the feature's checks already pass", counts: false } });
      this.record({ type: 'ESCALATED', ref, payload: { reason: 'its checks pass before anything is built: the feature is already done, or its checks are too weak' } });
      await this.driver.remove(sandbox);
      return 'progress';
    }

    // The launch returns at once; wait for the agent's pid file so a slow start isn't mistaken for a dead agent.
    const launch = await this.exec(sandbox, [this.agent.launch(this.agentRun(sandbox, attempt)), waitForFile(p.pid)].join('\n'));
    if (launch.code !== 0) return this.interrupt(state, attempt, `could not start the agent: ${launch.stderr.trim()}`);
    this.record({ type: 'ATTEMPT_STARTED', ref, payload: {} });
    return 'progress';
  }

  /** Step 6: wait for the Developer, within its deadline, and stop it if the Manager asks. */
  private async poll(state: FeatureState, attempt: Attempt): Promise<Step> {
    const ref = refOf(state, attempt);
    const p = this.paths(attempt.sandbox);
    if ((await this.driver.status(attempt.sandbox)) === 'missing') return this.interrupt(state, attempt, 'the sandbox disappeared');
    this.followAttempt(ref, attempt.sandbox);

    const probe = await this.exec(attempt.sandbox, probeScript(p.exit, p.pid));
    const status = probe.stdout.trim();
    if (status === 'running') {
      if (attempt.abort) {
        await this.killAgent(attempt.sandbox);
        this.record({ type: 'ATTEMPT_ENDED', ref, payload: { outcome: 'aborted', summary: attempt.abort.reason } });
        return 'progress';
      }
      if (this.now() < Date.parse(attempt.deadline)) return 'wait';
      await this.killAgent(attempt.sandbox);
      this.record({ type: 'ATTEMPT_ENDED', ref, payload: { outcome: 'timed_out' } });
      return 'progress';
    }
    if (status === 'gone') return this.interrupt(state, attempt, 'the agent stopped without finishing');

    const dir = this.attemptDir(ref);
    const fetch = (from: string, to: string) => this.driver.download(attempt.sandbox, from, join(dir, to)).then(() => readFileSync(join(dir, to), 'utf8'), () => '');
    const stream = await fetch(p.stream, 'stream.jsonl');
    const stderr = await fetch(p.stderr, 'stderr.log');
    if (stream.trim() === '' && status !== '0') return this.agentDidNotStart(state, attempt, stderr);
    const result = readResult(stream, Number(status), stderr);
    this.record({
      type: 'ATTEMPT_ENDED',
      ref,
      payload: {
        outcome: result.outcome,
        ...(result.summary ? { summary: result.summary } : result.detail ? { summary: result.detail } : {}),
        ...(result.notes ? { notes: result.notes } : {}),
        ...(result.finding ? { finding: result.finding } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
      },
    });
    return 'progress';
  }

  /** Step 7: take the Developer's commits out as a bundle, whatever the outcome, and refuse changes to protected files. */
  private async collect(state: FeatureState, attempt: Attempt): Promise<Step> {
    this.stopFollowing();
    const ref = refOf(state, attempt);
    if (attempt.outcome === 'usage_limit') {
      this.record({ type: 'ATTEMPT_INTERRUPTED', ref, payload: { reason: 'the subscription usage limit was reached', counts: false } });
      this.record({ type: 'PIPELINE_PAUSED', payload: { reason: 'usage limit reached', until: new Date(this.now() + 3_600_000).toISOString() } });
      await this.driver.remove(attempt.sandbox);
      return 'progress';
    }
    // Even a failed attempt's commits are kept, for the Manager and the owner to look at.
    const head = await this.takeCommits(ref, attempt);
    if (attempt.outcome !== 'done') return this.fail(state, attempt, outcomeReason(attempt));
    if (!head) return this.fail(state, attempt, 'the Developer reported done but committed nothing');

    const files = await this.repo.changedFiles(attempt.base, head);
    const touched = await protectedChanges(this.repo.treeReader(attempt.base), this.repo.treeReader(head), files, { progress: 'frozen' });
    if (touched.length > 0) return this.fail(state, attempt, `changed protected files: ${touched.join(', ')}`);
    this.record({ type: 'CHECKS_STARTED', ref, payload: { head, files } });
    await this.driver.remove(attempt.sandbox);
    return 'progress';
  }

  /** Step 8: every check in a fresh sandbox. If they pass, the attempt waits for the Manager's review. */
  private async check(state: FeatureState, attempt: Attempt): Promise<Step> {
    const ref = refOf(state, attempt);
    const { feature } = this.lookup(state);
    await this.driver.remove(attempt.sandbox);
    const results = await this.runChecksIn(
      sandboxName('chk', this.design.config.project.name, featureKey(ref), `a${ref.attempt}`),
      attemptRefName(ref),
      this.attemptDir(ref),
      [...this.regressionChecks(), ...preMerge(feature.checks)],
    );
    if (!allPassed(results)) {
      this.record({ type: 'CHECKS_FAILED', ref, payload: { results } });
      return this.fail(state, attempt, `checks failed: ${results.filter((r) => r.exit !== 0).map((r) => r.id).join(', ')}`);
    }
    this.record({ type: 'CHECKS_PASSED', ref, payload: { results } });
    return 'progress';
  }

  /** Steps 9–10: the Manager's verdict. Accepted, the feature lands on the plan branch as one commit. */
  private async review(state: FeatureState, attempt: Attempt): Promise<Step> {
    const decision = attempt.decision;
    if (!decision) return 'wait';
    if (decision.kind === 'reject') return this.fail(state, attempt, `rejected by the Manager: ${clip(decision.text ?? '', 300)}`);

    const ref = refOf(state, attempt);
    const { feature } = this.lookup(state);
    const branch = this.state.plans[planKey(ref)]!.branch;
    const landed = await this.alreadyLanded(branch, attempt, ref);
    const commit = landed ?? (await this.repo.commitFeature({
      base: attempt.base,
      head: attempt.head!,
      progressLine: this.progressLine(ref, attempt, state.fix),
      message: commitMessage(ref, feature, attempt, attempt.checks ?? [], state.fix),
      author: DEVELOPER,
      committer: HARNESS,
    }));
    if (!landed) await this.repo.setRef(`refs/heads/${branch}`, commit, attempt.base);
    this.record({ type: 'FEATURE_ACCEPTED', ref, payload: { commit } });
    return 'progress';
  }

  // ── The plan (§7.2) ──────────────────────────────────────────────────────────

  /** Every feature is accepted: run all the checks once more on the plan branch, then wait for the Manager to submit it. */
  private async validatePlan(plan: PlanState): Promise<Step> {
    const ref = { module: plan.module, plan: plan.plan };
    const validation = plan.validation;
    if (!validation || validation.status === 'running') {
      const results = await this.runChecksIn(
        sandboxName('chk', this.design.config.project.name, planKey(ref), 'plan'),
        `refs/heads/${plan.branch}`,
        this.planDir(ref),
        this.regressionChecks(),
      );
      this.record({ type: allPassed(results) ? 'PLAN_CHECKS_PASSED' : 'PLAN_CHECKS_FAILED', ref, payload: { results } });
      return 'progress';
    }
    if (validation.status === 'failed') {
      const failing = (validation.results ?? []).filter((r) => r.exit !== 0).map((r) => r.id).join(', ');
      if (!this.state.pipeline.paused) this.record({ type: 'PIPELINE_PAUSED', payload: { reason: `the full check run of ${planKey(ref)} failed: ${failing}` } });
      return 'wait';
    }
    if (plan.summary === undefined) return 'wait';
    if (this.forge.kind === 'local') {
      this.record({ type: 'PLAN_COMPLETED', ref, payload: { head: plan.head } });
      return 'progress';
    }
    return this.openPullRequest(plan);
  }

  // ── The pull request (§11.3, §11.7) ──────────────────────────────────────────

  /** Pushes the plan branch and opens its one PR. A PR a previous process opened is found again, not duplicated. */
  private async openPullRequest(plan: PlanState): Promise<Step> {
    const ref = { module: plan.module, plan: plan.plan };
    if (plan.pushed !== plan.head) {
      const refused = await this.refusePush(plan);
      if (refused) return refused;
      await this.forge.push(this.repo, plan.branch);
      this.record({ type: 'PLAN_PUSHED', ref, payload: { head: plan.head } });
    }
    const pr = (await this.forge.findPullRequest(plan.branch))
      ?? (await this.forge.openPullRequest({ branch: plan.branch, title: this.prTitle(plan), body: this.prBody(plan) }));
    this.record({ type: 'PR_OPENED', ref, payload: pr });
    this.nextPoll.delete(planKey(plan));
    return 'progress';
  }

  /** Follows an open PR: pushes a landed fix, reads CI once it finished, and notices the owner's merge. */
  private async followPullRequest(plan: PlanState): Promise<Step> {
    const ref = { module: plan.module, plan: plan.plan };
    const key = planKey(plan);
    const pause = (reason: string): Step => {
      if (!this.state.pipeline.paused) this.record({ type: 'PIPELINE_PAUSED', payload: { reason } });
      return 'wait';
    };
    if (plan.pushed !== plan.head) {
      const refused = await this.refusePush(plan);
      if (refused) return refused;
      await this.forge.push(this.repo, plan.branch);
      this.record({ type: 'PLAN_PUSHED', ref, payload: { head: plan.head } });
      this.nextPoll.delete(key);
      return 'progress';
    }
    if (this.now() < (this.nextPoll.get(key) ?? 0)) return 'wait';
    const pr = await this.forge.pullRequest(plan.pr!.number);
    if (pr.merged) {
      this.record({ type: 'PR_MERGED', ref, payload: { commit: pr.mergeCommit ?? '', next: await this.afterMerge(plan, pr.mergeCommit) } });
      this.nextPoll.delete(key);
      return 'progress';
    }
    if (pr.state === 'closed') {
      if (!plan.pr!.closed) this.record({ type: 'PR_CLOSED', ref, payload: {} });
      return pause(`PR #${pr.number} of ${key} was closed without being merged. Reopen it to go on.`);
    }
    if (pr.head !== plan.pushed) return pause(`the branch of PR #${pr.number} moved to ${pr.head.slice(0, 8)}, which the harness didn't push`);
    if (plan.ci?.status === 'pending') {
      const step = await this.readCi(plan);
      if (step) return step;
    }
    const quiet = plan.ci ? this.now() - Date.parse(plan.ci.since) : 0;
    this.nextPoll.set(key, this.now() + (plan.ci?.status === 'pending' ? 30_000 : quiet < 600_000 ? 60_000 : 300_000));
    return 'wait';
  }

  /** After a merge: CI applies the infrastructure it changed, then the plan's post-deploy checks run (§12.6). */
  private async afterMerge(plan: PlanState, commit: string | undefined): Promise<'deploying' | 'verifying' | 'completed'> {
    const terraform = this.design.config.terraform;
    let deploys = false;
    if (terraform && commit) {
      await this.forge.fetchMain(this.repo);
      const parent = await this.repo.revParse(`${commit}^1`);
      deploys = parent !== undefined && (await this.repo.changedFiles(parent, commit)).some((file) => file.startsWith(`${terraform.dir}/`));
    }
    if (deploys) return 'deploying';
    return this.postDeployChecks(plan).length > 0 ? 'verifying' : 'completed';
  }

  /** Waits for the apply job on the merge commit. */
  private async followDeploy(plan: PlanState): Promise<Step> {
    const ref = { module: plan.module, plan: plan.plan };
    const key = planKey(plan);
    if (this.now() < (this.nextPoll.get(key) ?? 0)) return 'wait';
    this.nextPoll.set(key, this.now() + 30_000);
    const commit = plan.mergeCommit!;
    const name = this.design.config.github.applyJob;
    const apply = (await this.forge.checkRuns(commit)).filter((r) => r.name === name).sort((a, b) => b.id - a.id)[0];
    if (!apply) {
      if (this.now() - Date.parse(plan.mergedAt!) > 15 * 60_000 && !this.state.pipeline.paused) {
        this.record({ type: 'PIPELINE_PAUSED', payload: { reason: `no ${name} job ran on main for ${commit.slice(0, 8)} within 15 minutes: is the harness workflow up to date?` } });
      }
      return 'wait';
    }
    if (apply.status !== 'completed') return 'wait';
    if (apply.conclusion === 'success') {
      this.record({ type: 'DEPLOYED', ref, payload: { commit, verify: this.postDeployChecks(plan).length > 0 } });
      return 'progress';
    }
    this.record({ type: 'DEPLOY_FAILED', ref, payload: { commit, jobs: [{ name, conclusion: apply.conclusion ?? 'unknown', ...(apply.url ? { url: apply.url } : {}), log: await this.forge.jobLog(apply) }] } });
    this.pauseIfOutOfDeployRounds(plan);
    return 'progress';
  }

  /** The plan's post-deploy checks, on main, with the view-only role (§12.6). */
  private async verifyDeploy(plan: PlanState): Promise<Step> {
    const ref = { module: plan.module, plan: plan.plan };
    const results = await this.runChecksIn(
      sandboxName('chk', this.design.config.project.name, planKey(plan), 'post'),
      'refs/heads/main',
      this.planDir(ref),
      this.postDeployChecks(plan),
    );
    if (allPassed(results)) {
      this.record({ type: 'PLAN_VERIFIED', ref, payload: { results } });
      return 'progress';
    }
    this.record({ type: 'POST_DEPLOY_CHECKS_FAILED', ref, payload: { results } });
    this.pauseIfOutOfDeployRounds(plan);
    return 'progress';
  }

  private pauseIfOutOfDeployRounds(plan: PlanState): void {
    const limit = this.design.config.brakes.deployFixRounds;
    if ((plan.deployFixRounds ?? 0) >= limit && !this.state.pipeline.paused) {
      this.record({ type: 'PIPELINE_PAUSED', payload: { reason: `the deploy of ${planKey(plan)} still fails after ${limit} Fix PR(s): the owner decides` } });
    }
  }

  postDeployChecks(plan: { module: string; plan: string }): Check[] {
    const definition = this.design.modules.find((m) => m.id === plan.module)?.plans.find((p) => p.id === plan.plan);
    return (definition?.features ?? []).flatMap((f) => f.checks.filter((c) => c.phase === 'post-deploy'));
  }

  /** CI on the pushed head, recorded once every required job has finished. Undefined while it runs. */
  private async readCi(plan: PlanState): Promise<Step | undefined> {
    const ref = { module: plan.module, plan: plan.plan };
    const ci = plan.ci!;
    const required = requiredChecks(this.design.config);
    const latest = new Map<string, CheckRun>();
    for (const run of await this.forge.checkRuns(ci.sha)) {
      if (required.includes(run.name) && run.id >= (latest.get(run.name)?.id ?? 0)) latest.set(run.name, run);
    }
    if (latest.size === 0 && this.now() - Date.parse(ci.since) > 10 * 60_000) {
      if (!this.state.pipeline.paused) {
        this.record({ type: 'PIPELINE_PAUSED', payload: { reason: `no CI ran on PR #${plan.pr!.number} within 10 minutes: is the harness workflow on main?` } });
      }
      return 'wait';
    }
    if (latest.size < required.length || [...latest.values()].some((r) => r.status !== 'completed')) return undefined;
    const jobs: CiJob[] = [];
    for (const name of required) {
      const run = latest.get(name)!;
      const conclusion = run.conclusion ?? 'unknown';
      jobs.push({ name, conclusion, ...(run.url ? { url: run.url } : {}), ...(conclusion === 'success' ? {} : { log: await this.forge.jobLog(run) }) });
    }
    if (jobs.every((j) => j.conclusion === 'success')) {
      this.record({ type: 'CI_PASSED', ref, payload: { sha: ci.sha, jobs } });
      return 'progress';
    }
    this.record({ type: 'CI_FAILED', ref, payload: { sha: ci.sha, jobs } });
    const limit = this.design.config.brakes.ciFixRounds;
    if ((plan.fixRounds ?? 0) >= limit && !this.state.pipeline.paused) {
      this.record({ type: 'PIPELINE_PAUSED', payload: { reason: `CI failed on PR #${plan.pr!.number} of ${planKey(plan)} after ${limit} fix round(s): the owner decides` } });
    }
    return 'progress';
  }

  /** The daemon's own check before anything leaves the machine: nothing protected changed since main (§8.7). */
  private async refusePush(plan: PlanState): Promise<Step | undefined> {
    const base = await this.repo.mergeBase('refs/heads/main', plan.head);
    const changed = await this.repo.changedFiles(base, plan.head);
    const problems = await protectedChanges(this.repo.treeReader(base), this.repo.treeReader(plan.head), changed, { progress: 'append' });
    if (problems.length === 0) return undefined;
    if (!this.state.pipeline.paused) {
      this.record({ type: 'PIPELINE_PAUSED', payload: { reason: `refusing to push ${plan.branch}: it changes protected files: ${problems.join(', ')}` } });
    }
    return 'wait';
  }

  private prTitle(plan: PlanState): string {
    if (plan.branch.startsWith('fix/')) return `Fix: ${planKey(plan)} — after the deploy, round ${plan.deployFixRounds}`;
    const definition = this.design.modules.find((m) => m.id === plan.module)?.plans.find((p) => p.id === plan.plan);
    return `Plan: ${planKey(plan)} — ${definition?.title ?? plan.plan}`;
  }

  private prBody(plan: PlanState): string {
    if (plan.branch.startsWith('fix/')) {
      const fix = this.state.features[`${planKey(plan)}/fix${plan.fixes}`];
      return [
        `A fix for ${planKey(plan)}, after its deploy failed.`,
        '',
        '## What failed',
        '',
        fix?.fix?.failure ?? '',
        '',
        "## The Manager's diagnosis",
        '',
        fix?.attempts.at(-1)?.guidance ?? '',
        '',
        '## The fix',
        '',
        fix?.attempts.find((a) => a.status === 'accepted')?.summary ?? '',
        '',
        `<!-- harness: fix ${planKey(plan)} -->`,
      ].join('\n');
    }
    const definition = this.design.modules.find((m) => m.id === plan.module)?.plans.find((p) => p.id === plan.plan);
    const features = (definition?.features ?? []).map((f) => {
      const state = this.state.features[`${planKey(plan)}/${f.id}`];
      const accepted = state?.attempts.find((a) => a.status === 'accepted');
      return `- **${f.id}** ${f.title}: attempt ${accepted?.n ?? '?'}, commit ${state?.commit?.slice(0, 8) ?? '?'}`;
    });
    return [
      plan.summary ?? '',
      '',
      '## Features',
      '',
      ...features,
      '',
      'Merge with a merge commit, so that each feature keeps its own commit on main.',
      '',
      `<!-- harness: plan ${planKey(plan)} -->`,
    ].join('\n');
  }

  /** Runs checks on a commit of the daemon's repository, in a fresh sandbox with no agent and no credentials. */
  async runChecksIn(name: string, gitRef: string, dir: string, checks: Check[]): Promise<CheckResult[]> {
    const p = this.paths(name);
    await this.driver.remove(name);
    await this.driver.create({
      name,
      image: this.design.config.sandbox.image,
      ...this.access({ claude: false, aws: checks.some((c) => c.needs.length > 0) }),
      command: ['sleep', 'infinity'],
    });
    try {
      await this.repo.bundle(gitRef, join(dir, 'candidate.bundle'));
      await this.driver.upload(name, join(dir, 'candidate.bundle'), p.harness);
      const fetch = await this.exec(name, [
        `git init --quiet ${sh(p.work)}`,
        `cd ${sh(p.work)}`,
        `git fetch --quiet ${sh(`${p.harness}/candidate.bundle`)} ${sh(`${gitRef}:refs/heads/candidate`)}`,
        'git checkout --quiet candidate',
      ].join(' && '));
      if (fetch.code !== 0) throw new Error(`could not check out the candidate: ${fetch.stderr.trim()}`);
      const init = await initEnvironment(this.driver, name, p.work);
      if (init && init.exit !== 0) return [init];
      return await runChecks(this.driver, name, p.work, checks, this.checkOptions(name));
    } finally {
      await this.driver.remove(name);
    }
  }

  // ── Outcomes and brakes (§7.4) ───────────────────────────────────────────────

  /** The attempt counts. Unless it was a rejection, which carries guidance, the next one waits for the Manager's. */
  private async fail(state: FeatureState, attempt: Attempt, reason: string): Promise<Step> {
    this.record({ type: 'ATTEMPT_FAILED', ref: refOf(state, attempt), payload: { reason } });
    await this.driver.remove(attempt.sandbox);
    const limit = this.design.config.brakes.consecutiveFailures;
    if (this.state.pipeline.consecutiveFailures >= limit && !this.state.pipeline.paused) {
      this.record({ type: 'PIPELINE_PAUSED', payload: { reason: `${limit} attempts failed in a row` } });
    }
    return 'progress';
  }

  /** Not the Developer's fault: doesn't count, except from the third interruption of the same feature. */
  private async interrupt(state: FeatureState, attempt: Attempt, reason: string): Promise<Step> {
    const counts = interruptions(state, attempt.definitionHash) >= 2;
    this.record({ type: 'ATTEMPT_INTERRUPTED', ref: refOf(state, attempt), payload: { reason, counts } });
    await this.driver.remove(attempt.sandbox);
    return 'progress';
  }

  /** Claude Code exited before writing anything: a flag, the token or the image is wrong, and retrying can't help. */
  private async agentDidNotStart(state: FeatureState, attempt: Attempt, stderr: string): Promise<Step> {
    const reason = `Claude Code did not start: ${clip(stderr.trim().replace(/\s+/g, ' ') || 'it wrote nothing', 400)}`;
    this.record({ type: 'ATTEMPT_INTERRUPTED', ref: refOf(state, attempt), payload: { reason, counts: false } });
    this.record({ type: 'PIPELINE_PAUSED', payload: { reason: `environment: ${reason}` } });
    await this.driver.remove(attempt.sandbox);
    return 'progress';
  }

  private async baselineFailed(state: FeatureState, attempt: Attempt, reason: string, results: CheckResult[]): Promise<Step> {
    const ref = refOf(state, attempt);
    this.record({ type: 'BASELINE_FAILED', ref, payload: { reason, results } });
    this.record({ type: 'ATTEMPT_INTERRUPTED', ref, payload: { reason, counts: false } });
    this.record({ type: 'PIPELINE_PAUSED', payload: { reason: `environment: ${reason}` } });
    await this.driver.remove(attempt.sandbox);
    return 'progress';
  }

  private async onStepError(error: Error): Promise<void> {
    const active = activeAttempt(this.state);
    const key = active ? `${featureKey(refOf(active.feature, active.attempt))}#${active.attempt.n}:${active.attempt.status}` : 'idle';
    this.stepErrors = { key, count: this.stepErrors.key === key ? this.stepErrors.count + 1 : 1 };
    this.log(`step failed (${key}, ${this.stepErrors.count}/${STEP_ERROR_LIMIT}): ${error.message}`);
    if (active && this.stepErrors.count >= STEP_ERROR_LIMIT) {
      this.stepErrors = { key: '', count: 0 };
      await this.interrupt(active.feature, active.attempt, `infrastructure error: ${error.message}`).catch(() => {});
    }
  }

  // ── Agents' requests ─────────────────────────────────────────────────────────

  /** A channel to an agent sandbox. Its requests go to the tool handlers, and the replies back. */
  channel(agent: AgentIdentity, repliedFile: string): AgentChannel {
    const p = this.paths(agent.sandbox);
    const channel = new AgentChannel({
      driver: this.driver,
      sandbox: agent.sandbox,
      outbox: p.outbox,
      inbox: p.inbox,
      repliedFile,
      onRequest: (request) => void this.onRequest(agent, channel, request),
      onInvalid: (reason) => this.log(`${agent.sandbox} sent ${reason}`),
    });
    channel.start();
    return channel;
  }

  private async onRequest(agent: AgentIdentity, channel: AgentChannel, request: AgentRequest): Promise<void> {
    let reply: Reply | undefined;
    try {
      reply = await handleRequest(this, agent, request);
    } catch (error) {
      this.log(`${request.tool} from ${agent.sandbox} failed: ${(error as Error).message}`);
      reply = { ok: false, text: `The harness could not do this: ${(error as Error).message}` };
    }
    if (reply) await channel.reply(request.id, reply.ok, reply.text).catch((error: Error) => this.log(error.message));
  }

  /** Gives the Developer the Manager's answer, as the result of its `ask_manager` call. */
  async replyToDeveloper(sandbox: string, requestId: string, text: string): Promise<boolean> {
    if (this.developer?.sandbox !== sandbox) return false;
    await this.developer.channel.reply(requestId, true, text);
    return true;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  /** Appends to the log, applies to the state, saves the state, and tells the dashboard. */
  record(event: NewEvent): HarnessEvent {
    const stamped = this.store.append(event);
    apply(this.state, stamped);
    writeSnapshot(join(this.options.harnessDir, 'state.json'), this.state);
    this.events.emit('event', stamped);
    return stamped;
  }

  /** The module being built: the first, in design order, with a plan that isn't complete. */
  currentModule(): string | undefined {
    return this.design.modules.find((m) => m.plans.some((p) => this.state.plans[`${m.id}/${p.id}`]?.status !== 'completed'))?.id;
  }

  /** A blocking question to the owner holds back new attempts in its module. */
  blockedByOwner(module: string): boolean {
    return Object.values(this.state.ownerRequests).some((r) => r.module === module && r.blocking && r.answer === undefined);
  }

  /** So does a design change, until the owner merges or closes its Arch PR: it may redefine the work. */
  designChanging(module: string): boolean {
    const state = this.state.modules[module];
    return state !== undefined && (state.status === 'in_review' || state.submission !== undefined);
  }

  lookup(state: { module: string; plan: string; feature: string }): { plan: Plan; feature: Feature } {
    const plan = this.design.modules.find((m) => m.id === state.module)?.plans.find((p) => p.id === state.plan);
    const fix = this.state.features[`${state.module}/${state.plan}/${state.feature}`]?.fix;
    if (plan && fix) return { plan, feature: fixDefinition(state.feature, `${state.module}/${state.plan}`, fix) };
    const feature = plan?.features.find((f) => f.id === state.feature);
    if (!plan || !feature) throw new Error(`${state.module}/${state.plan}/${state.feature} is no longer in the design`);
    return { plan, feature };
  }

  /** The project's own pre-merge checks, then those of every accepted feature. They must keep passing. */
  regressionChecks(): Check[] {
    const accepted = Object.values(this.state.features)
      .filter((f) => f.status === 'accepted')
      .flatMap((f) => preMerge(this.lookup(f).feature.checks));
    return [...preMerge(this.design.config.checks), ...accepted];
  }

  exec(sandbox: string, script: string, input?: string): Promise<ExecResult> {
    return this.driver.exec(sandbox, script, { timeoutSec: 600, ...(input === undefined ? {} : { input }) });
  }

  paths(sandbox: string) {
    const root = this.driver.rootOf(sandbox);
    const harness = `${root}/.harness`;
    return {
      root,
      harness,
      work: `${root}/work`,
      out: `${harness}/out`,
      stream: `${harness}/stream.jsonl`,
      stderr: `${harness}/stderr.log`,
      exit: `${harness}/exit_code`,
      pid: `${harness}/agent.pid`,
      outbox: `${harness}/outbox.jsonl`,
      inbox: `${harness}/inbox.jsonl`,
      mcpConfig: `${harness}/mcp.json`,
    };
  }

  /** The shim and the role's tools, so the agent can reach the daemon. */
  async uploadAgentFiles(sandbox: string, role: Role, localDir: string): Promise<void> {
    const p = this.paths(sandbox);
    writeFileSync(join(localDir, 'tools.json'), toolsManifest(role));
    writeFileSync(join(localDir, 'mcp.json'), mcpConfig(p.harness));
    await this.driver.upload(sandbox, join(this.options.packageDir, 'shim', 'harness-mcp.mjs'), p.harness);
    await this.driver.upload(sandbox, join(localDir, 'tools.json'), p.harness);
    await this.driver.upload(sandbox, join(localDir, 'mcp.json'), p.harness);
  }

  attemptDir(ref: Ref): string {
    return ensureDir(join(this.options.harnessDir, 'modules', ref.module, 'attempts', `${ref.plan}-${ref.feature}-a${ref.attempt}`));
  }

  planDir(ref: Ref): string {
    return ensureDir(join(this.options.harnessDir, 'modules', ref.module, 'plans', ref.plan));
  }

  moduleDir(module: string): string {
    return ensureDir(join(this.options.harnessDir, 'modules', module));
  }

  /** The sandbox policy: the project's network bundles, or every bundle for the Architect (§13), and signed AWS endpoints. */
  policyFile(options: { allBundles?: boolean; aws?: boolean } = {}): string {
    const config = this.design.config;
    const network = options.allBundles ? { ...config.network, bundles: Object.keys(BUNDLES) } : config.network;
    const aws = options.aws && config.aws ? { aws: config.aws } : {};
    const name = `sandbox-policy${options.allBundles ? '-all' : ''}${aws.aws ? '-aws' : ''}.yaml`;
    const file = join(ensureDir(join(this.options.harnessDir, 'tmp')), name);
    writeFileSync(file, `${JSON.stringify(buildPolicy({ ...network, ...aws }), null, 2)}\n`);
    return file;
  }

  /**
   * A sandbox's providers, policy and settings. Agents get Claude; with AWS in the
   * project, they and the checks that need it also get the view role, which OpenShell
   * holds and signs with (§12.1). A provider is only attached where its endpoints are.
   */
  access(options: { claude: boolean; aws: boolean; allBundles?: boolean }): { providers: string[]; policyFile: string; env: Record<string, string> } {
    const aws = options.aws ? this.design.config.aws : undefined;
    return {
      providers: [...(options.claude ? [this.design.config.sandbox.claudeProvider] : []), ...(aws ? [aws.provider] : [])],
      policyFile: this.policyFile({ allBundles: options.allBundles ?? false, aws: aws !== undefined }),
      env: this.sandboxEnv(),
    };
  }

  /** What checks need to plan with Terraform in a sandbox. */
  checkOptions(sandbox: string): RunOptions {
    const terraform = this.design.config.terraform;
    return { ...(terraform ? { terraform } : {}), scratchDir: this.paths(sandbox).harness };
  }

  /** OpenShell ignores an image's ENV (spike 2), so every setting travels with `--env`. */
  sandboxEnv(): Record<string, string> {
    return {
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CHECKPOINT_DISABLE: '1',
      // ask_manager may wait 15 minutes for the Manager.
      MCP_TOOL_TIMEOUT: '1000000',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      // Without a region, the AWS CLI calls global endpoints the policy doesn't list (spike 2).
      ...(this.design.config.aws ? {
        AWS_REGION: this.design.config.aws.region,
        AWS_DEFAULT_REGION: this.design.config.aws.region,
        AWS_STS_REGIONAL_ENDPOINTS: 'regional',
        AWS_EC2_METADATA_DISABLED: 'true',
        AWS_PAGER: '',
      } : {}),
      ...this.design.config.sandbox.env,
    };
  }

  private async refreshDesign(): Promise<void> {
    await this.forge.fetchMain(this.repo);
    this.design = await loadDesign(this.repo, 'refs/heads/main');
  }

  /** Bundles the attempt's commits into `refs/attempts/...`. Undefined when it committed nothing. */
  private async takeCommits(ref: Ref, attempt: Attempt): Promise<string | undefined> {
    const p = this.paths(attempt.sandbox);
    const bundle = await this.exec(attempt.sandbox, [
      `cd ${sh(p.work)} || exit 1`,
      `[ "$(git rev-list --count ${sh(attempt.base)}..HEAD)" -gt 0 ] || exit 3`,
      `mkdir -p ${sh(p.out)} && git bundle create --quiet ${sh(`${p.out}/result.bundle`)} ${sh(attempt.base)}..HEAD`,
    ].join('\n'));
    if (bundle.code === 3) return undefined;
    if (bundle.code !== 0) throw new Error(`could not bundle the attempt's commits: ${(bundle.stderr || bundle.stdout).trim()}`);
    const local = join(this.attemptDir(ref), 'result.bundle');
    await this.driver.download(attempt.sandbox, `${p.out}/result.bundle`, local);
    return this.repo.fetchBundle(local, attemptRefName(ref));
  }

  private async killAgent(sandbox: string): Promise<void> {
    const p = this.paths(sandbox);
    await this.exec(sandbox, `pid="$(cat ${sh(p.pid)})"; kill -TERM -- "-$pid" 2>/dev/null; sleep 5; kill -KILL -- "-$pid" 2>/dev/null; true`);
  }

  /** The plan branch may already hold this attempt's commit if the previous process stopped right after writing it. */
  private async alreadyLanded(branch: string, attempt: Attempt, ref: Ref): Promise<string | undefined> {
    const head = await this.repo.revParse(`refs/heads/${branch}`);
    if (!head || head === attempt.base) return undefined;
    const info = await this.repo.commitInfo(head);
    const mine = info.parents.length === 1 && info.parents[0] === attempt.base
      && info.message.includes(`Feature: ${featureKey(ref)}\n`) && info.message.includes(`Attempt: ${ref.attempt}\n`);
    return mine ? head : undefined;
  }

  private followAttempt(ref: Ref, sandbox: string): void {
    if (this.developer?.sandbox === sandbox) return;
    this.stopFollowing();
    const agent = `developer:${featureKey(ref)}/a${ref.attempt}`;
    const follower = this.driver.follow(sandbox, this.paths(sandbox).stream, 1, (line) => this.events.emit('transcript', { agent, line }));
    const channel = this.channel({ role: 'developer', sandbox }, join(this.attemptDir(ref), 'replied.txt'));
    this.developer = { sandbox, follower, channel };
  }

  private stopFollowing(): void {
    this.developer?.follower.stop();
    this.developer?.channel.stop();
    this.developer = undefined;
  }

  private agentRun(sandbox: string, attempt: Attempt): AgentRun {
    const p = this.paths(sandbox);
    const developer = this.design.config.roles.developer;
    return {
      workDir: p.work,
      promptFile: `${p.harness}/developer.md`,
      taskFile: `${p.harness}/task.md`,
      schemaFile: `${p.harness}/report.schema.json`,
      mcpConfigFile: p.mcpConfig,
      streamFile: p.stream,
      stderrFile: p.stderr,
      exitFile: p.exit,
      pidFile: p.pid,
      sessionId: attempt.sessionId,
      model: developer.model,
      ...(developer.effort ? { effort: developer.effort } : {}),
    };
  }

  /** This attempt's line, after any waiting for a commit, such as satisfied gates (§8.5). */
  private progressLine(ref: Ref, attempt: Attempt, fix?: FeatureState['fix']): string {
    const summary = clip((attempt.summary ?? '').replace(/\s+/g, ' ').replaceAll('"', "'"), 160);
    const what = fix ? `fix.accepted ${ref.module}/${ref.plan} round=${fix.round}` : `feature.accepted ${featureKey(ref)}`;
    return [...this.state.pendingProgress, `${new Date(this.now()).toISOString()} ${what} attempt=${ref.attempt} "${summary}"`].join('\n');
  }
}

/** GitHub through the App when the project names a repository, the owner's local repository otherwise. */
export function makeForge(config: Config, projectDir: string): Forge {
  return config.project.repo ? new GitHubForge(new GitHubClient(loadAppCredentials(), config.project.repo)) : new LocalForge(projectDir);
}

/** A fix round, described as a feature so that it runs like one. It has no checks of its own: CI is its check. */
function fixDefinition(id: string, plan: string, fix: { round: number; kind: 'ci' | 'deploy'; failure: string }): Feature {
  const what = fix.kind === 'ci' ? `CI failed on the pull request of plan ${plan}` : `After plan ${plan} was merged, its deploy failed`;
  return {
    id,
    title: fix.kind === 'ci' ? `Fix CI, round ${fix.round}` : `Fix the deploy, round ${fix.round}`,
    kind: fix.kind === 'ci' ? 'app' : 'infra',
    description: `${what}. Find the cause and fix it, without touching protected files.\n\n${fix.failure}`,
    expected: 'Every CI job passes, and every check listed below still passes.',
    dependsOn: [],
    gates: [],
    resources: [],
    checks: [],
  };
}

function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

function outcomeReason(attempt: Attempt): string {
  switch (attempt.outcome) {
    case 'blocked': return `blocked: ${attempt.finding?.summary ?? attempt.summary ?? 'no finding given'}`;
    case 'timed_out': return 'the attempt ran out of time';
    case 'aborted': return `stopped by the Manager: ${attempt.summary ?? 'no reason given'}`;
    case 'no_report': return `the Developer ended without a report${attempt.summary ? `: ${attempt.summary}` : ''}`;
    default: return `the Developer's session failed${attempt.summary ? `: ${attempt.summary}` : ''}`;
  }
}

function commitMessage(ref: Ref, feature: Feature, attempt: Attempt, results: CheckResult[], fix?: FeatureState['fix']): string {
  return [
    fix ? `fix(${ref.module}/${ref.plan}): ${fix.kind === 'ci' ? 'CI' : 'the deploy'}, round ${fix.round}` : `feat(${featureKey(ref)}): ${feature.title}`,
    ...(fix ? [] : ['', feature.description]),
    ...(attempt.summary ? ['', attempt.summary] : []),
    '',
    `Feature: ${featureKey(ref)}`,
    `Attempt: ${ref.attempt}`,
    `Checks: ${results.map((r) => r.id).join(', ')}`,
    '',
  ].join('\n');
}
