import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeCode, mcpConfig, readResult, reportJsonSchema, type AgentAdapter, type AgentRun } from '../agents/claude-code.ts';
import { loadClaudeToken, readUsage, type SubscriptionUsage } from '../anthropic/usage.ts';
import { allPassed, initEnvironment, runChecks, type CheckResult, type RunOptions } from '../checks/runner.ts';
import { protectedChanges } from '../ci/harness-ci.ts';
import { ownerTime, type OwnerTime } from '../design/owner-time.ts';
import {
  definitionHash, featureDependency, loadDesign, planDependencies, planKind, requiredChecks, REVIEWER_ROLES, statusContext,
  type Check, type Config, type Design, type Feature, type ModuleDesign, type Plan,
} from '../design/schemas.ts';
import { DEVELOPER, HARNESS, Repo } from '../git/repo.ts';
import { GitHubClient, loadAppCredentials } from '../github/app.ts';
import { GitHubForge, LocalForge, type CheckRun, type Forge, type PullRequest } from '../github/forge.ts';
import { rulesProblems } from '../github/setup.ts';
import { toolsManifest, type Role } from '../roles.ts';
import { PROJECT_LABEL, type ExecResult, type Follower, type SandboxDriver, type SandboxSpec } from '../sandbox/driver.ts';
import { BUNDLES } from '../sandbox/allowlist.ts';
import { apiProviderName, buildPolicy } from '../sandbox/policy.ts';
import { Denials, LOG_LINES } from '../sandbox/refusals.ts';
import { EventStore, type CiJob, type HarnessEvent, type NewEvent, type Ref } from '../state/events.ts';
import {
  activeAttempts, apply, countedAttempts, featureKey, interruptions, isActive, managersOf, planKey, planMerged, project, writeSnapshot,
  type Attempt, type FeatureState, type InfraMerge, type ManagerState, type Mode, type PlanState, type ReviewState, type State,
} from '../state/state.ts';
import { clip, machineSize, sh, sleep } from '../util.ts';
import { Architects } from './architects.ts';
import { AgentChannel, type AgentRequest } from './channel.ts';
import { architectRef } from './design.ts';
import { parseCostEstimate } from '../review/cost-estimate.ts';
import { activeReview, reviewStep, stepReview } from './review.ts';
import { Managers } from './manager.ts';
import { sweepLeftOvers } from './sandboxes.ts';
import { readTokens } from './tokens.ts';
import { attemptRefName, preMerge, probeScript, refOf, sandboxName, waitForFile } from './refs.ts';
import { handleRequest, type AgentIdentity, type Reply } from './requests.ts';
import { buildTask } from './task.ts';
import { webRead, type WebReadResult } from './web-read.ts';

export interface OrchestratorOptions {
  /** Whether the usage probe's token is stored; by default, the token file (v3 §4.3). */
  tokenStored?: () => boolean;
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
  /** Tests replace the subscription's usage endpoint (v3 §4.3). By default: the endpoint, with the token the doctor stored; undefined without one. */
  usage?: () => Promise<SubscriptionUsage | undefined>;
  /** Tests replace GitHub. By default: GitHub through the App when the project names a repository, else the project's own folder. */
  forge?: (config: Config) => Forge;
  now?: () => number;
  log?: (message: string) => void;
}

/** One step either changed something, so the loop runs again at once, or has to wait for the world. */
type Step = 'progress' | 'wait';

/** After this many errors in a row on the same attempt or plan (infrastructure, not the agent), the attempt is interrupted, or the pipeline pauses. */
const STEP_ERROR_LIMIT = 5;

/** How often the daemon deletes this project's left-over sandboxes, besides when it starts. */
const SWEEP_EVERY_MS = 3_600_000;

/** Where the Swarm setup stands, for the dashboard's note (v4 §6): read through the App, at most every five minutes. */
export interface SetupStatus {
  at: string;
  /** Whether main's rules match the mode, and what they lack; undefined when the project has no repository. */
  rules?: { ok: boolean; problems: string[] };
  /** False when the App can't write commit statuses; undefined until a token said so. */
  statusesWritable?: boolean;
  /** The token the usage probe reads is stored on this machine. */
  tokenStored: boolean;
}

/**
 * Runs the loop in code (proposal v2 §7). Each pass looks at the state and takes the
 * next step for each attempt under way, or starts the next piece of work, then brings
 * the Managers up to date. Every step records an event before it moves on, so after a
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
  /** The check sandboxes in use, with the ref each checks: the state doesn't name them. */
  readonly checking = new Map<string, string>();
  readonly agent: AgentAdapter;
  readonly managers: Managers;
  readonly architects: Architects;
  readonly now: () => number;
  readonly log: (message: string) => void;
  readonly webRead: (url: string) => Promise<WebReadResult>;
  private readonly readUsage: () => Promise<SubscriptionUsage | undefined>;
  /** The last reading of the subscription's usage, for the dashboard; not state. */
  usage?: { at: string; usage: SubscriptionUsage };
  forge!: Forge;
  private readonly tokenStored: () => boolean;
  private setup?: { at: number; mode: Mode; status: SetupStatus };

  private ticking?: Promise<void>;
  /** When each open PR may be polled again. */
  private readonly nextPoll = new Map<string, number>();
  private again = false;
  private stopping = false;
  private stepErrors = { key: '', count: 0 };
  /** When the left-over sandboxes are next deleted: at the first pass, then every hour. */
  private nextSweep = 0;
  /** When each long-lived agent's tokens were last read, by agent. */
  private readonly tokensReadAt = new Map<string, number>();
  /** The gateway's providers, read at most once a minute, for the keys of the project's APIs. */
  private providerNames?: { at: number; names: string[] };
  /** Errors in a row of each plan's step, and when it is tried again: one plan that keeps failing never stops the others. */
  private readonly planErrors = new Map<string, { count: number; retryAt: number }>();
  /** The heads of Arch and Fix PRs already given the reviewers' statuses as "not reviewed". */
  private readonly unreviewed = new Set<string>();
  /** The Developers under way, by sandbox: their transcripts for the dashboard, and their channels for the harness tools. */
  private readonly developers = new Map<string, { follower: Follower; channel: AgentChannel }>();
  /** The reviewers under way, by sandbox: plans in parallel can be reviewed at once. */
  private readonly reviewers = new Map<string, { follower: Follower; channel: AgentChannel }>();
  /** What the policy refused the attempts under way, by sandbox, added up from their logs every minute. */
  private readonly refusals = new Map<string, { denials: Denials; readAt: number }>();

  constructor(options: OrchestratorOptions) {
    this.options = options;
    this.driver = options.driver;
    this.agent = options.agent ?? claudeCode;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this.webRead = options.webRead ?? ((url) => webRead(url));
    this.readUsage = options.usage ?? (async () => {
      const token = loadClaudeToken();
      return token ? readUsage(token) : undefined;
    });
    this.tokenStored = options.tokenStored ?? (() => loadClaudeToken() !== undefined);
    this.store = new EventStore(join(options.harnessDir, 'events.jsonl'), this.now);
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
    this.deleteOldBundles();
    this.record({ type: 'DAEMON_STARTED', payload: { version: this.options.version, pid: process.pid } });
    this.takePendingSetup();
  }

  /**
   * The git bundles earlier versions kept in `.harness/modules/`: a copy of the plan
   * branch's history for each attempt and each review, though each was read once, by the
   * sandbox. Nothing uses one before the first pass, so all of them go.
   */
  private deleteOldBundles(): void {
    const modules = join(this.options.harnessDir, 'modules');
    if (!existsSync(modules)) return;
    let count = 0;
    let bytes = 0;
    for (const file of readdirSync(modules, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.bundle'))) {
      const path = join(modules, file);
      const stat = statSync(path, { throwIfNoEntry: false });
      if (!stat?.isFile()) continue;
      rmSync(path, { force: true });
      bytes += stat.size;
      count += 1;
    }
    if (count > 0) this.log(`deleted ${count} git bundle${count === 1 ? '' : 's'} left in .harness/modules, ${(bytes / 1024 ** 2).toFixed(1)} MiB`);
  }

  /**
   * What `harness setup`, `harness budget` or `harness mode` left for the daemon while it
   * was down (v4 §5), taken once: the owner's hours, which setup only offers, so they don't
   * replace hours already set while budget's do, and the mode.
   */
  private takePendingSetup(): void {
    const file = join(this.options.harnessDir, 'setup.json');
    if (!existsSync(file)) return;
    try {
      const { ownerHours, ownerHoursFrom, mode } = JSON.parse(readFileSync(file, 'utf8')) as { ownerHours?: unknown; ownerHoursFrom?: unknown; mode?: unknown };
      if (typeof ownerHours === 'number' && ownerHours > 0 && (ownerHoursFrom === 'budget' || this.state.budgets.ownerHours === undefined)) this.setBudgets({ ownerHours });
      if (mode === 'manual' || mode === 'swarm') this.setMode(mode);
    } catch (error) {
      this.log(`setup.json: ${(error as Error).message}`);
    }
    rmSync(file, { force: true });
  }

  /**
   * Where the Swarm setup stands (v4 §6): main's rules against the mode, read through
   * the App's metadata permission at most every five minutes, whether the App may write
   * statuses, and whether the usage probe's token is stored.
   */
  async setupStatus(): Promise<SetupStatus> {
    const mode = this.state.mode;
    if (this.setup && this.setup.mode === mode && this.now() - this.setup.at < 5 * 60_000) return this.setup.status;
    const config = this.design.config;
    let rules: SetupStatus['rules'];
    if (config.project.repo) {
      let inEffect;
      try {
        inEffect = await this.forge.branchRules('main');
      } catch (error) {
        this.log(`main's rules could not be read: ${(error as Error).message}`);
      }
      const problems = rulesProblems(inEffect, {
        mode, requiredChecks: requiredChecks(config), statuses: mode === 'swarm' ? config.swarm.requiredStatuses : [], ...(this.forge.appId !== undefined ? { appId: this.forge.appId } : {}),
      });
      rules = { ok: problems.length === 0, problems };
    }
    const writable = this.forge.statusesWritable();
    const status: SetupStatus = { at: new Date(this.now()).toISOString(), ...(rules ? { rules } : {}), ...(writable === undefined ? {} : { statusesWritable: writable }), tokenStored: this.tokenStored() };
    this.setup = { at: this.now(), mode, status };
    return status;
  }

  /**
   * Takes no new step, and waits a little for the one under way. A step cut short is
   * safe: it is taken again from the start after a restart.
   */
  async stop(graceMs = 10_000): Promise<void> {
    this.stopping = true;
    for (const sandbox of [...this.developers.keys()]) this.stopFollowing(sandbox);
    this.stopFollowingReview();
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
      // The design on main, read once per pass: every step of it sees the same (§7.1).
      await this.refreshDesign().catch((error: Error) => this.onStepError(error));
      try {
        for (let i = 0; i < 50 && !this.stopping && (await this.step()) === 'progress'; i++);
      } catch (error) {
        await this.onStepError(error as Error);
      }
      if (!this.stopping) await this.managers.sync();
      if (!this.stopping) await this.architects.sync();
      if (!this.stopping) await this.verifyActions().catch((error: Error) => this.log(`owner action: ${error.message}`));
      if (!this.stopping && this.now() >= this.nextSweep) {
        this.nextSweep = this.now() + SWEEP_EVERY_MS;
        await sweepLeftOvers(this).catch((error: Error) => this.log(`left-over sandboxes: ${error.message}`));
      }
    } while (this.again && !this.stopping);
  }

  // ── Owner actions ────────────────────────────────────────────────────────────

  /** The owner pauses the pipeline: what runs goes on, and nothing new starts. */
  pause(): boolean {
    return this.pausePipeline('the owner paused the pipeline');
  }

  /**
   * Pauses the pipeline, unless a pause that holds at least as long is there. A pause
   * without `until` (the owner's, a brake's) holds until the owner lifts it, so a timed
   * one never replaces it; a timed one gives way to an untimed one, or to a later `until`.
   */
  pausePipeline(reason: string, until?: string): boolean {
    const current = this.state.pipeline.paused;
    if (current && (current.until === undefined || (until !== undefined && Date.parse(until) <= Date.parse(current.until)))) return false;
    this.record({ type: 'PIPELINE_PAUSED', payload: { reason, ...(until ? { until } : {}) } });
    return true;
  }

  /** The owner lifts a pause. An API key stored meanwhile counts at once. */
  resume(): boolean {
    if (!this.state.pipeline.paused) return false;
    this.providerNames = undefined;
    this.record({ type: 'PIPELINE_RESUMED', payload: {} });
    this.kick();
    return true;
  }

  /** The owner switches between Manual and Swarm (v3 §2.1). Running attempts finish under the rules they started with. */
  setMode(mode: Mode): boolean {
    if (this.state.mode === mode) return false;
    this.record({ type: 'MODE_CHANGED', payload: { mode } });
    this.kick();
    return true;
  }

  /** The owner lets the daemon merge INFRA and MIXED plans like CODE ones, or takes them back (v3 D36). Open PRs are looked at again at once. */
  setInfraMerge(by: InfraMerge): boolean {
    if (this.state.infraMerge === by) return false;
    this.record({ type: 'INFRA_MERGE_SET', payload: { by } });
    this.nextPoll.clear();
    this.kick();
    return true;
  }

  /** The owner sets their hours for the whole project, or the agent-hours threshold (v3 §4); null clears one. */
  setBudgets(budgets: { ownerHours?: number | null | undefined; agentHours?: number | null | undefined }): boolean {
    let changed = false;
    if (budgets.ownerHours !== undefined && budgets.ownerHours !== (this.state.budgets.ownerHours ?? null)) {
      this.record({ type: 'OWNER_HOURS_SET', payload: { hours: budgets.ownerHours } });
      changed = true;
    }
    if (budgets.agentHours !== undefined && budgets.agentHours !== (this.state.budgets.agentHours ?? null)) {
      this.record({ type: 'AGENT_HOURS_SET', payload: { hours: budgets.agentHours } });
      changed = true;
    }
    return changed;
  }

  /**
   * The owner caps what each new sandbox may use of the machine, CPUs and memory; null
   * lifts a cap. The sandboxes already there keep theirs. Returns why not, if not.
   */
  setSandboxLimits(limits: { cpu: number | null; memoryGiB: number | null }): string | undefined {
    const { cpu, memoryGiB } = limits;
    const machine = machineSize();
    if (cpu !== null && !(Number.isFinite(cpu) && cpu >= 0.5 && cpu <= machine.cpus)) return `CPUs: from 0.5 to ${machine.cpus}, this machine's`;
    if (memoryGiB !== null && !(Number.isFinite(memoryGiB) && memoryGiB >= 1 && memoryGiB <= machine.memoryGiB)) return `memory: from 1 to ${Math.floor(machine.memoryGiB)} GiB, this machine's`;
    const current = this.state.sandboxLimits;
    if ((current?.cpu ?? null) !== cpu || (current?.memoryGiB ?? null) !== memoryGiB) this.record({ type: 'SANDBOX_LIMITS_SET', payload: { cpu, memoryGiB } });
    return undefined;
  }

  /** The owner grants one more attempt to an escalated feature (`module/plan/feature`). */
  retry(key: string, note?: string): boolean {
    const feature = this.state.features[key];
    if (feature?.status !== 'escalated') return false;
    this.record({ type: 'OWNER_RETRY', ref: { module: feature.module, plan: feature.plan, feature: feature.feature }, payload: note ? { note } : {} });
    this.kick();
    return true;
  }

  /** The owner writes to a Manager: the one named by its key, or else those of the module being built. */
  messageManager(text: string, manager?: string): boolean {
    const named = manager ? this.state.managers[manager] : undefined;
    const module = manager ? named?.module : this.currentModule();
    const targets: ManagerState[] = manager ? (named && named.status !== 'stopped' ? [named] : []) : module ? managersOf(this.state, module) : [];
    if (!module || targets.length === 0 || text.trim() === '') return false;
    this.record({ type: 'OWNER_MESSAGE', from: 'owner', to: 'manager', payload: { module, text: text.trim(), ...(manager ? { manager } : {}) } });
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
    if (!action.verify) this.record({ type: 'OWNER_ACTION_DONE', payload: { module, action: actionId, title: action.title, gate: action.kind === 'gate', ...minutesOf(action) } });
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
        this.record({ type: 'OWNER_ACTION_DONE', payload: { module, action: id, title: definition.title, gate: definition.kind === 'gate', ...minutesOf(definition) } });
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
    // A design change merged meanwhile stops the attempts whose features it redefined, in both
    // modes (v3 §6.6), and only the module being built has attempts.
    if (await this.abortStale()) return 'progress';
    const active = activeAttempts(this.state);
    let progressed = false;
    for (const { feature, attempt } of active) {
      if ((await this.stepAttempt(feature, attempt)) === 'progress') progressed = true;
    }
    if (progressed) return 'progress';
    if (paused) return 'wait';
    if (await this.apiKeysMissing()) return 'wait';
    // Manual builds one feature at a time, and looks at nothing else while it runs. Swarm starts
    // more while others run, up to its limit, and follows its other plans meanwhile (v3 §6.2).
    const swarm = this.state.mode === 'swarm';
    const limit = swarm ? this.design.config.swarm.maxDevelopers : 1;
    if (active.length >= limit && !swarm) return 'wait';
    return this.scheduleNext(active.length, limit);
  }

  /**
   * An API of the design whose key isn't stored on this machine pauses the pipeline, with
   * what to do: every new sandbox carries the API's provider, and OpenShell refuses one
   * that doesn't exist. A design change that adds an API leads here.
   */
  private async apiKeysMissing(): Promise<boolean> {
    const keyed = this.design.config.network.apis.filter((api) => api.key);
    if (keyed.length === 0) return false;
    if (!this.providerNames || this.now() - this.providerNames.at >= 60_000) {
      try {
        this.providerNames = { at: this.now(), names: await this.driver.providers() };
      } catch (error) {
        // The gateway's trouble shows elsewhere; this check doesn't hold the pipeline for it.
        this.log(`the providers could not be listed: ${(error as Error).message}`);
        return false;
      }
    }
    const project = this.design.config.project.name;
    const missing = keyed.filter((api) => !this.providerNames!.names.includes(apiProviderName(project, api.host)));
    if (missing.length === 0) return false;
    this.pausePipeline(`no key stored on this machine for ${missing.map((api) => api.host).join(', ')}: run \`harness doctor\` in a terminal, which asks for it, then resume`);
    return true;
  }

  /** One attempt's next step. An error counts against this attempt alone, and interrupts it past the limit. */
  private async stepAttempt(feature: FeatureState, attempt: Attempt): Promise<Step> {
    try {
      switch (attempt.status) {
        case 'starting':
          return await this.prepare(feature, attempt);
        case 'running':
          return await this.poll(feature, attempt);
        case 'collecting':
          return await this.collect(feature, attempt);
        case 'checking':
          return await this.check(feature, attempt);
        default:
          return await this.review(feature, attempt);
      }
    } catch (error) {
      await this.onAttemptError(feature, attempt, error as Error);
      return 'wait';
    }
  }

  // ── Choosing work ────────────────────────────────────────────────────────────

  /**
   * What to do besides the attempts under way (v3 §6.2), all of it in the module being
   * built, since modules are built one after another (v2 §12.8). Every plan of it past
   * its build gets its step: the full check run, the pull request, the deploy. Then,
   * while fewer than `limit` attempts run, one starts in a plan of it being built, in plan
   * order then file order; then a plan of it whose dependencies are merged starts, while
   * fewer than `swarm.maxPlans` are in flight. Manual keeps v2's order: only the module's
   * first plan that isn't complete, one feature at a time.
   */
  private async scheduleNext(running = 0, limit = 1): Promise<Step> {
    const swarm = this.state.mode === 'swarm';
    const current = this.currentModule();
    const inFlight = Object.values(this.state.plans).filter((p) => p.module === current && this.inFlight(p));
    for (const planState of inFlight) {
      if ((await this.isolated(planState, () => this.planStep(planState))) === 'progress') return 'progress';
    }
    if (running >= limit) return 'wait';
    const module = this.design.modules.find((m) => m.id === current);
    if (!module) return 'wait';
    const first = swarm ? undefined : module.plans.find((p) => this.state.plans[`${module.id}/${p.id}`]?.status !== 'completed');
    const plans = first ? [first] : module.plans;
    for (const plan of plans) {
      const planState = this.state.plans[`${module.id}/${plan.id}`];
      if (planState?.status !== 'active') continue;
      if ((await this.isolated(planState, () => this.buildStep(module, plan, planState, running, limit))) === 'progress') return 'progress';
    }
    if (inFlight.length >= (swarm ? this.design.config.swarm.maxPlans : 1)) return 'wait';
    for (const plan of plans) {
      const planRef = { module: module.id, plan: plan.id };
      if (this.state.plans[planKey(planRef)] || !this.planCanStart(module, plan)) continue;
      return this.startPlan(planRef);
    }
    return 'wait';
  }

  /** A plan being built: main's changes reach its branch first (§6.3), then an attempt starts, or the full check run once every feature is accepted. */
  private async buildStep(module: ModuleDesign, plan: Plan, planState: PlanState, running: number, limit: number): Promise<Step> {
    const planRef = { module: module.id, plan: plan.id };
    if (await this.mergeMain(planState)) return 'progress';
    if (this.state.mode === 'swarm') {
      const own = activeAttempts(this.state).filter(({ feature }) => feature.module === module.id && feature.plan === plan.id).length;
      return this.scheduleParallel(planRef, plan, planState, own, running, limit);
    }
    for (const feature of plan.features) {
      const ref = { ...planRef, feature: feature.id };
      const step = await this.scheduleWork(ref, feature, this.state.features[featureKey(ref)]);
      if (step) return step;
    }
    this.record({ type: 'PLAN_VALIDATING', ref: planRef, payload: { head: planState.head } });
    return 'progress';
  }

  /**
   * A plan's step, its errors counted for that plan alone: a plan that keeps failing is
   * left alone for a while so the others go on, and past the limit the pipeline pauses
   * with the error, where the owner sees it.
   */
  private async isolated(plan: PlanState, step: () => Promise<Step>): Promise<Step> {
    const key = planKey(plan);
    const errors = this.planErrors.get(key);
    if (errors && this.now() < errors.retryAt) return 'wait';
    try {
      const result = await step();
      this.planErrors.delete(key);
      return result;
    } catch (error) {
      const count = (errors?.count ?? 0) + 1;
      const message = (error as Error).message;
      this.log(`step of ${key} failed (${count}/${STEP_ERROR_LIMIT}): ${message}`);
      if (count < STEP_ERROR_LIMIT) {
        this.planErrors.set(key, { count, retryAt: this.now() + 30_000 });
      } else {
        this.planErrors.delete(key);
        this.pausePipeline(`${key} keeps failing: ${clip(message.replace(/\s+/g, ' '), 300)}`);
      }
      return 'wait';
    }
  }

  /** A plan starts once every plan it depends on is merged, and no gate holds it (v3 §6.1). */
  private planCanStart(module: ModuleDesign, plan: Plan): boolean {
    if (this.gatesHolding(module.id, plan.id).length > 0) return false;
    return planDependencies(module, plan).every((id) => planMerged(this.state.plans[`${module.id}/${id}`]));
  }

  /** A plan's step past its build; 'wait' while it is being built, or needs the owner or the Manager. */
  private async planStep(plan: PlanState): Promise<Step> {
    const planRef = { module: plan.module, plan: plan.plan };
    switch (plan.status) {
      case 'validating':
        return this.validatePlan(plan);
      case 'pr_open':
        // A Fix PR has no pull request until its fix lands.
        return plan.pr ? this.followPullRequest(plan) : this.openPullRequest(plan);
      case 'ready_to_merge':
        return this.followPullRequest(plan);
      case 'deploying':
        return this.followDeploy(plan);
      case 'verifying':
        return this.verifyDeploy(plan);
      case 'fixing': {
        const fix = this.state.features[`${planKey(planRef)}/fix${plan.fixes}`]!;
        // A Fix PR's branch starts from the merge.
        if (!(await this.repo.revParse(`refs/heads/${plan.branch}`))) await this.repo.setRef(`refs/heads/${plan.branch}`, plan.base, '');
        return (await this.scheduleWork({ ...planRef, feature: fix.feature }, this.lookup(fix).feature, fix)) ?? 'wait';
      }
      default:
        return 'wait';
    }
  }

  /**
   * Swarm's scheduler within a plan (v3 §6.2): starts the next feature whose dependencies
   * are met, while fewer than `limit` attempts run in all. A feature that can't start, for
   * guidance, a gate or an escalation, doesn't hold the independent ones back. The plan
   * validates once every feature is accepted and none of its attempts runs.
   */
  private async scheduleParallel(planRef: Ref, plan: Plan, planState: PlanState, own: number, running: number, limit: number): Promise<Step> {
    for (const feature of plan.features) {
      const ref = { ...planRef, feature: feature.id };
      const state = this.state.features[featureKey(ref)];
      if (acceptedAsDefined(state, feature) || (state && isActive(state))) continue;
      if (!this.dependenciesMet(planRef, plan, feature)) continue;
      if (running >= limit) break;
      const step = await this.scheduleWork(ref, feature, state);
      if (step === 'progress') return 'progress';
    }
    const done = plan.features.every((f) => acceptedAsDefined(this.state.features[featureKey({ ...planRef, feature: f.id })], f));
    if (done && own === 0) {
      this.record({ type: 'PLAN_VALIDATING', ref: planRef, payload: { head: planState.head } });
      return 'progress';
    }
    return 'wait';
  }

  /** Interrupts an attempt that mustn't go on (see `whyStop`). True when there was one. */
  private async abortStale(): Promise<boolean> {
    const current = this.currentModule();
    for (const { feature, attempt } of activeAttempts(this.state)) {
      const reason = this.whyStop(feature, attempt, current);
      if (!reason) continue;
      if (attempt.status === 'running') await this.killAgent(attempt.sandbox).catch(() => {});
      this.stopFollowing(attempt.sandbox);
      await this.interrupt(feature, attempt, reason);
      return true;
    }
    return false;
  }

  /**
   * Why an attempt under way must stop, if it must. A design change merged meanwhile
   * (v3 §6.6) dropped or redefined its feature: the next attempt builds the new
   * definition, since the old one's interruptions don't count against it. Fix rounds have
   * no definition on main, so they go on. Or its module isn't the one being built, which
   * only state left by 0.2.0 can show: it starts again in its module's turn.
   */
  private whyStop(feature: FeatureState, attempt: Attempt, current: string | undefined): string | undefined {
    if (!feature.fix) {
      let hash: string | undefined;
      try {
        hash = definitionHash(this.lookup(feature).feature);
      } catch {
        hash = undefined;
      }
      if (hash === undefined) return 'the design no longer has this feature: the attempt stops';
      if (hash !== attempt.definitionHash) return 'the design changed this feature while it was built: the next attempt builds the new definition';
    }
    if (feature.module !== current) return 'another module is being built: this one goes on once that one is complete';
    return undefined;
  }

  /**
   * Every feature this one depends on is accepted; one of an earlier plan counts once that
   * plan is merged, so that its code is on main and reaches this plan's branch (v3 §6.1).
   */
  private dependenciesMet(planRef: Ref, plan: Plan, feature: Feature): boolean {
    return feature.dependsOn.every((dep) => {
      const target = featureDependency(planRef.plan, dep);
      if (target.plan === planRef.plan) {
        const definition = plan.features.find((f) => f.id === target.feature);
        return definition !== undefined && acceptedAsDefined(this.state.features[featureKey({ ...planRef, feature: target.feature })], definition);
      }
      return planMerged(this.state.plans[`${planRef.module}/${target.plan}`]);
    });
  }

  /**
   * The next attempt of a feature or a fix round, or why there can't be one yet. Undefined
   * once it is accepted as the design defines it now: a design change that redefined an
   * accepted feature while its plan is built gives it a fresh attempt.
   */
  private async scheduleWork(ref: Ref, definition: Feature, state: FeatureState | undefined): Promise<Step | undefined> {
    if (acceptedAsDefined(state, definition)) return undefined;
    if (state && isActive(state)) return 'wait';
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
    if (await this.usagePauses()) return 'progress';
    return this.startAttempt(ref, hash, state);
  }

  /**
   * In Swarm, no attempt starts at or above the usage ceiling (v3 §4.3): the pipeline
   * pauses until the binding window resets, and the existing rule lifts the pause then.
   * Without a token, or when the endpoint fails, nothing is checked: the pause after a
   * limit is hit remains the brake.
   */
  private async usagePauses(): Promise<boolean> {
    const ceiling = this.design.config.swarm.usageCeilingPercent;
    if (this.state.mode !== 'swarm' || ceiling === null) return false;
    const usage = await this.subscriptionUsage();
    if (!usage || usage.percent < ceiling) return false;
    const binding = usage.limits.find((l) => l.percent === usage.percent);
    const reset = Date.parse(usage.resetsAt);
    const until = Number.isFinite(reset) && reset > this.now() ? usage.resetsAt : new Date(this.now() + 60 * 60_000).toISOString();
    this.pausePipeline(`the subscription's usage is at ${usage.percent}%${binding ? ` (${binding.kind})` : ''}, at or above the ${ceiling}% ceiling (swarm.usageCeilingPercent)`, until);
    return true;
  }

  /** The subscription's usage, read at most every five minutes. */
  private async subscriptionUsage(): Promise<SubscriptionUsage | undefined> {
    if (this.usage && this.now() - Date.parse(this.usage.at) < 5 * 60_000) return this.usage.usage;
    try {
      const usage = await this.readUsage();
      if (usage) this.usage = { at: new Date(this.now()).toISOString(), usage };
      return usage;
    } catch (error) {
      this.log(`the subscription's usage could not be read: ${(error as Error).message}`);
      return undefined;
    }
  }

  /**
   * Main moved while a plan is built, as a design change or another plan's merge moves it:
   * the daemon merges it into the plan branch before the next attempt, progress.txt taking
   * both sides' lines (§11.3). When other files conflict, the plan goes on from its base and
   * the conflict is resolved in its pull request, unless main changed this module's design
   * or the config, which the next attempt must see: then the pipeline pauses.
   */
  private async mergeMain(plan: PlanState): Promise<boolean> {
    const main = (await this.repo.revParse('refs/heads/main'))!;
    if (plan.mainConflict?.main === main || (await this.repo.isAncestor(main, plan.head))) return false;
    const merged = await this.mergeMainInto(plan.head, plan.branch);
    if ('conflicts' in merged) {
      const changed = await this.repo.changedFiles(await this.repo.mergeBase(main, plan.head), main);
      if (changed.some((file) => file === 'harness/config.json' || file.startsWith(`harness/modules/${plan.module}/`))) {
        this.pausePipeline(`main changed the design of ${plan.module}, and files that ${plan.branch} changed too, so the daemon can't merge it in: ${merged.conflicts.join(', ')}`);
        return true;
      }
      this.record({ type: 'PLAN_MAIN_CONFLICT', ref: { module: plan.module, plan: plan.plan }, payload: { main, files: merged.conflicts } });
      return true;
    }
    this.record({ type: 'PLAN_MAIN_MERGED', ref: { module: plan.module, plan: plan.plan }, payload: { main, head: merged.commit } });
    return true;
  }

  /** Main merged into a plan branch at `head`, the branch moved to the result; progress.txt takes main's lines, then the plan's. */
  private async mergeMainInto(head: string, branch: string): Promise<{ commit: string } | { conflicts: string[] }> {
    const main = (await this.repo.revParse('refs/heads/main'))!;
    const merged = await this.repo.merge({ ours: head, theirs: main, message: `Merge main into ${branch}\n`, committer: HARNESS, union: ['progress.txt'] });
    if (!('conflicts' in merged)) await this.repo.setRef(`refs/heads/${branch}`, merged.commit, head);
    return merged;
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
    const mustKeep = await this.regressionChecks(attempt.base);
    writeFileSync(join(dir, 'task.md'), buildTask({
      ref, plan, feature, previous,
      ...(attempt.guidance ? { guidance: attempt.guidance } : {}),
      regressionChecks: mustKeep,
      progressTail: progress.split('\n').slice(-21).join('\n'),
    }));
    copyFileSync(join(this.options.packageDir, 'roles', 'developer.md'), join(dir, 'developer.md'));
    writeFileSync(join(dir, 'report.schema.json'), reportJsonSchema());
    await this.uploadBundle(sandbox, join(dir, 'plan.bundle'), p.harness);
    for (const file of ['task.md', 'developer.md', 'report.schema.json']) {
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
    const regression = await runChecks(this.driver, sandbox, p.work, mustKeep, this.checkOptions(sandbox));
    if (!allPassed(regression)) {
      return this.baselineFailed(state, attempt, 'checks of accepted work fail before the attempt starts', regression);
    }
    const own = preMerge(feature.checks);
    // A feature built again after a design change redefined it has its earlier work in place: its checks may pass already.
    const rebuilding = state.attempts.some((a) => a.status === 'accepted');
    if (!rebuilding && own.length > 0 && allPassed(await runChecks(this.driver, sandbox, p.work, own, this.checkOptions(sandbox)))) {
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
      if (this.now() < Date.parse(attempt.deadline)) {
        await this.readRefusals(attempt.sandbox);
        return 'wait';
      }
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
    this.stopFollowing(attempt.sandbox);
    await this.keepRefusals(state, attempt);
    const ref = refOf(state, attempt);
    if (attempt.outcome === 'usage_limit') {
      // Not the Developer's doing, but the sandbox writes the stream it is read from: like any
      // interruption, it counts from the third one of the same definition, so it can't buy attempts.
      const counts = interruptions(state, attempt.definitionHash) >= 2;
      this.record({ type: 'ATTEMPT_INTERRUPTED', ref, payload: { reason: 'the subscription usage limit was reached', counts } });
      this.pausePipeline('usage limit reached', new Date(this.now() + 3_600_000).toISOString());
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
    await this.driver.remove(attempt.sandbox);
    return this.checkMerged(state, attempt, `a${ref.attempt}`);
  }

  /**
   * The checks, on the attempt as it would land: when another feature landed meanwhile
   * (v3 §6.3), the plan's head is merged in first, so the checks of accepted work see
   * that work, and the attempt lands on the head. A conflict interrupts the attempt.
   */
  private async checkMerged(state: FeatureState, attempt: Attempt, suffix: string): Promise<Step> {
    const ref = refOf(state, attempt);
    const { feature } = this.lookup(state);
    const branch = this.state.plans[planKey(ref)]!.branch;
    const merged = await this.mergeWithHead(ref, attempt, branch);
    if (merged && 'conflicts' in merged) {
      return this.interrupt(state, attempt, `conflicts with work landed on ${branch} meanwhile, in ${merged.conflicts.join(', ')}: the next attempt starts from the new head`);
    }
    const checkRef = merged ? `${attemptRefName(ref)}-rebased` : attemptRefName(ref);
    if (merged) await this.repo.setRef(checkRef, merged.commit);
    const results = await this.runChecksIn(
      sandboxName('chk', this.design.config.project.name, featureKey(ref), suffix),
      checkRef,
      this.attemptDir(ref),
      [...(await this.regressionChecks(checkRef)), ...preMerge(feature.checks)],
    );
    if (!allPassed(results)) {
      this.record({ type: 'CHECKS_FAILED', ref, payload: { results } });
      const failing = results.filter((r) => r.exit !== 0).map((r) => r.id).join(', ');
      return this.fail(state, attempt, `checks failed${merged ? ` once merged with ${branch}'s new head` : ''}: ${failing}`);
    }
    if (merged) this.record({ type: 'ATTEMPT_REBASED', ref, payload: { onto: merged.onto, commit: merged.commit, results } });
    if (attempt.status === 'checking') this.record({ type: 'CHECKS_PASSED', ref, payload: { results } });
    return 'progress';
  }

  /** The plan's head merged into the attempt's work, when the head moved since the attempt's base and the last merge. */
  private async mergeWithHead(ref: Ref, attempt: Attempt, branch: string): Promise<{ onto: string; commit: string } | { conflicts: string[] } | undefined> {
    const planHead = (await this.repo.revParse(`refs/heads/${branch}`))!;
    if (planHead === attempt.base || attempt.rebased?.onto === planHead) return undefined;
    const merged = await this.repo.merge({ ours: planHead, theirs: attempt.head!, message: `Merge ${branch} into ${featureKey(ref)} attempt ${ref.attempt}\n`, committer: HARNESS });
    return 'conflicts' in merged ? merged : { onto: planHead, commit: merged.commit };
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
    let base = attempt.base;
    let head = attempt.head!;
    const planHead = (await this.repo.revParse(`refs/heads/${branch}`))!;
    if (!landed && planHead !== attempt.base) {
      // The head moved again since the checks, as a third feature landing does: merge and check once more before landing (v3 §6.3).
      if (attempt.rebased?.onto !== planHead) {
        const step = await this.checkMerged(state, attempt, `a${ref.attempt}r`);
        if (attempt.rebased?.onto !== planHead) return step;
      }
      // The merge is checked and recorded on the attempt: it lands as one commit on the head.
      base = planHead;
      head = attempt.rebased!.commit;
    }
    const commit = landed ?? (await this.repo.commitFeature({
      base,
      head,
      progressLine: this.progressLine(ref, attempt, state.fix),
      message: commitMessage(ref, feature, attempt, attempt.checks ?? [], state.fix),
      author: DEVELOPER,
      committer: HARNESS,
    }));
    if (!landed) await this.repo.setRef(`refs/heads/${branch}`, commit, base);
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
        await this.regressionChecks(`refs/heads/${plan.branch}`),
      );
      this.record({ type: allPassed(results) ? 'PLAN_CHECKS_PASSED' : 'PLAN_CHECKS_FAILED', ref, payload: { results } });
      return 'progress';
    }
    if (validation.status === 'failed') {
      const failing = (validation.results ?? []).filter((r) => r.exit !== 0).map((r) => r.id).join(', ');
      this.pausePipeline(`the full check run of ${planKey(ref)} failed: ${failing}`);
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

  /** Follows an open PR: pushes a landed fix, reads CI once it finished, takes the owner's pushes, and notices the owner's merge. */
  private async followPullRequest(plan: PlanState): Promise<Step> {
    const ref = { module: plan.module, plan: plan.plan };
    const key = planKey(plan);
    const pause = (reason: string): Step => {
      this.pausePipeline(reason);
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
    // A reviewer's session on the pushed head is stepped without reading GitHub (v3 §5).
    const review = activeReview(plan);
    if (review) return stepReview(this, plan, review);
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
    if (pr.head !== plan.pushed) {
      // The owner pushed to the branch, as GitHub's conflict editor does: the daemon builds on it, unless history was rewritten.
      const head = await this.forge.fetchBranch(this.repo, plan.branch);
      if (head !== pr.head || !(await this.repo.isAncestor(plan.pushed!, head))) {
        // The fetch moved the daemon's branch: it stays where the harness had it.
        await this.repo.setRef(`refs/heads/${plan.branch}`, plan.head);
        return pause(`the branch of PR #${pr.number} moved to ${pr.head.slice(0, 8)}, which doesn't build on what the harness pushed`);
      }
      this.record({ type: 'PLAN_HEAD_ADOPTED', ref, payload: { head } });
      this.nextPoll.delete(key);
      return 'progress';
    }
    // CI is read until it passed: a run the owner starts again on GitHub counts too.
    if (plan.ci?.status === 'pending' || plan.ci?.status === 'failed') {
      const step = await this.readCi(plan);
      if (step) return step;
    }
    if (plan.ci?.status === 'passed' && plan.branch.startsWith('fix/')) {
      await this.markUnreviewed(pr.head, 'a Fix PR, which the owner merges');
    } else if (plan.ci?.status === 'passed') {
      // The cost job's estimate (v3 §5.3), then the reviewers (v3 §5), then the merge policy (v3 §3.2).
      if (await this.readCostEstimate(plan, pr)) {
        this.nextPoll.delete(key);
        return 'progress';
      }
      const reviewed = await reviewStep(this, plan, pr);
      if (reviewed === 'progress') {
        this.nextPoll.delete(key);
        return 'progress';
      }
      if (reviewed === 'busy') return 'wait';
      if (reviewed === 'ready' && this.state.mode === 'swarm' && (await this.mergeUnderPolicy(plan, pr))) {
        this.nextPoll.delete(key);
        return 'progress';
      }
    }
    const quiet = plan.ci ? this.now() - Date.parse(plan.ci.since) : 0;
    this.nextPoll.set(key, this.now() + (plan.ci?.status === 'pending' ? 30_000 : quiet < 600_000 ? 60_000 : 300_000));
    return 'wait';
  }

  /**
   * Swarm's merge policy (v3 §3.2): the daemon merges a plan's PR once CI passed, when
   * every clause holds; otherwise the PR is left to the owner, with the reason, once per
   * head and reason. Fix PRs never come here: a failed deploy is the owner's to look at.
   */
  private async mergeUnderPolicy(plan: PlanState, pr: PullRequest): Promise<boolean> {
    const ref = { module: plan.module, plan: plan.plan };
    const policy = this.design.config.swarm;
    const definition = this.definitionOf(plan);
    const kind = definition ? planKind(definition) : 'MIXED';
    const leave = (reason: string): false => {
      if (plan.leftToOwner?.head !== pr.head || plan.leftToOwner.reason !== reason) {
        this.record({ type: 'PR_LEFT_TO_OWNER', ref, payload: { number: pr.number, head: pr.head, reason } });
      }
      return false;
    };
    if (kind === 'CODE' && policy.merge.code !== 'daemon') return leave('CODE plans are the owner\'s to merge (swarm.merge.code)');
    if (kind !== 'CODE') {
      const ceiling = policy.merge.infraMonthlyUsdCeiling;
      // Only an estimate of this very head counts: a fix round's head may add what the earlier one didn't.
      const estimate = plan.costEstimate?.head === pr.head ? plan.costEstimate : undefined;
      if (ceiling !== null && estimate !== undefined && estimate.monthlyUsd > ceiling) {
        return leave(`the PR adds an estimated ${estimate.monthlyUsd} USD a month, over the ceiling of ${ceiling} (swarm.merge.infraMonthlyUsdCeiling)`);
      }
      // Without the owner's button (v3 D36), an estimate under the ceiling is the only way in.
      if (this.state.infraMerge !== 'daemon') {
        const button = "the dashboard's button lets the daemon merge infra once CI and the reviewers pass";
        if (ceiling === null) return leave(`${kind} plans are the owner's to merge (swarm.merge.infraMonthlyUsdCeiling is null); ${button}`);
        if (estimate === undefined) {
          return leave(`${kind === 'INFRA' ? 'an' : 'a'} ${kind} plan merges itself only with the cost job's estimate of the monthly cost it adds, and none was produced: the cost job needs iac/ and the INFRACOST_API_KEY secret; ${button}`);
        }
      }
    }
    // Main moved since CI ran: merge it in first, so CI and the reviewers judge what main gets.
    // The new head is pushed, and everything runs again on it.
    const main = (await this.repo.revParse('refs/heads/main'))!;
    if (!(await this.repo.isAncestor(main, pr.head))) {
      const merged = await this.mergeMainInto(pr.head, plan.branch);
      if ('conflicts' in merged) return leave(`it conflicts with main in ${merged.conflicts.join(', ')}: resolve them on GitHub, and the daemon takes your push`);
      this.record({ type: 'PLAN_MAIN_MERGED', ref, payload: { main, head: merged.commit } });
      return true;
    }
    const statuses = await this.forge.commitStatuses(pr.head);
    const missing = policy.requiredStatuses.filter((context) => statuses.find((s) => s.context === context)?.state !== 'success');
    if (missing.length > 0) {
      // A reviewer that passed but whose status the App couldn't set says why, instead of a wait that never ends.
      const unposted = (plan.reviews ?? []).find((r) => r.head === pr.head && r.posted?.status === 'error' && r.posted.problem);
      if (unposted) return leave(`${unposted.posted!.problem}`);
      return leave(`waiting for ${missing.join(', ')} to pass on ${pr.head.slice(0, 8)} (swarm.requiredStatuses)`);
    }
    let commit: string;
    try {
      ({ commit } = await this.forge.mergePullRequest(pr.number, pr.head));
    } catch (error) {
      const repo = this.design.config.project.repo ?? '<owner/repo>';
      return leave(`GitHub refused the merge: ${(error as Error).message}. If main's rules are still the Manual ones, run \`harness github-setup --repo ${repo}\``);
    }
    this.record({ type: 'PR_MERGED_BY_DAEMON', ref, payload: { number: pr.number, head: pr.head, commit } });
    this.record({ type: 'PR_MERGED', ref, payload: { commit, next: await this.afterMerge(plan, commit) } });
    return true;
  }

  /**
   * The cost job's estimate of the monthly cost an INFRA or MIXED PR adds (v3 §5.3, §5.5):
   * the `cost` artifact of the head's workflow run, read once per head. The job isn't a
   * required check, so it may finish after CI passed: the daemon looks for twenty minutes.
   * Without an estimate the policy leaves the PR to the owner, with the reason.
   */
  private async readCostEstimate(plan: PlanState, pr: PullRequest): Promise<boolean> {
    const definition = this.definitionOf(plan);
    if (!definition || planKind(definition) === 'CODE' || plan.costEstimate?.head === pr.head) return false;
    if (!plan.ci || this.now() - Date.parse(plan.ci.since) > 20 * 60_000) return false;
    // The artifact counts only once the cost job itself succeeded: other jobs of the run execute the PR's code.
    const job = (await this.forge.checkRuns(pr.head)).filter((r) => r.name === 'cost').sort((a, b) => b.id - a.id)[0];
    if (job?.status !== 'completed' || job.conclusion !== 'success') return false;
    let text: string | undefined;
    try {
      text = await this.forge.artifactFile(pr.head, 'cost', 'cost.json');
    } catch (error) {
      this.log(`the cost estimate of ${pr.head.slice(0, 8)} could not be read: ${(error as Error).message}`);
      return false;
    }
    if (text === undefined) return false;
    const estimate = parseCostEstimate(text);
    if (!estimate) {
      this.log(`the cost artifact of ${pr.head.slice(0, 8)} holds no monthly cost: is it Infracost's JSON?`);
      return false;
    }
    this.record({ type: 'COST_ESTIMATED', ref: { module: plan.module, plan: plan.plan }, payload: { head: pr.head, ...estimate } });
    return true;
  }

  private definitionOf(plan: PlanState): Plan | undefined {
    return this.design.modules.find((m) => m.id === plan.module)?.plans.find((p) => p.id === plan.plan);
  }

  /** After a merge: CI applies the infrastructure it changed, then the plan's post-deploy checks run (§12.6). */
  private async afterMerge(plan: PlanState, commit: string | undefined): Promise<'deploying' | 'verifying' | 'completed'> {
    const terraform = this.design.config.terraform;
    // Main as it is now, for the rest of the pass: the plans that wait for this merge start from it.
    await this.forge.fetchMain(this.repo);
    let deploys = false;
    if (terraform && commit) {
      const parent = await this.repo.revParse(`${commit}^1`);
      deploys = parent !== undefined && (await this.repo.changedFiles(parent, commit)).some((file) => file.startsWith(`${terraform.dir}/`));
    }
    if (deploys) return 'deploying';
    return this.postDeployChecks(plan).length > 0 ? 'verifying' : 'completed';
  }

  /**
   * Waits for the apply job on the merge commit. A later apply on main covers it too:
   * GitHub cancels a pending run when a newer one queues, and the owner may have fixed a
   * failed deploy on main, then resumed.
   */
  private async followDeploy(plan: PlanState): Promise<Step> {
    const ref = { module: plan.module, plan: plan.plan };
    const key = planKey(plan);
    if (this.now() < (this.nextPoll.get(key) ?? 0)) return 'wait';
    this.nextPoll.set(key, this.now() + 30_000);
    const commit = plan.mergeCommit!;
    const name = this.design.config.github.applyJob;
    const latestApply = async (sha: string) => (await this.forge.checkRuns(sha)).filter((r) => r.name === name).sort((a, b) => b.id - a.id)[0];
    const apply = await latestApply(commit);
    const main = await this.repo.revParse('refs/heads/main');
    const later = main && main !== commit && (await this.repo.isAncestor(commit, main)) ? await latestApply(main) : undefined;
    if ([apply, later].some((r) => r?.status === 'completed' && r.conclusion === 'success')) {
      this.record({ type: 'DEPLOYED', ref, payload: { commit, verify: this.postDeployChecks(plan).length > 0 } });
      return 'progress';
    }
    if (apply?.status === 'completed' && apply.conclusion !== 'cancelled') {
      const log = await this.forge.jobLog(apply).catch(() => '');
      this.record({ type: 'DEPLOY_FAILED', ref, payload: { commit, jobs: [{ name, conclusion: apply.conclusion ?? 'unknown', ...(apply.url ? { url: apply.url } : {}), log }] } });
      this.pauseIfOutOfDeployRounds(plan);
      return 'progress';
    }
    const running = [apply, later].some((r) => r !== undefined && r.status !== 'completed');
    if (!running && this.now() - Date.parse(plan.mergedAt!) > 15 * 60_000) {
      this.pausePipeline(`no ${name} job ran on main for ${commit.slice(0, 8)} within 15 minutes: is the harness workflow up to date?`);
    }
    return 'wait';
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
    if ((plan.deployFixRounds ?? 0) >= limit) {
      this.pausePipeline(`the deploy of ${planKey(plan)} still fails after ${limit} Fix PR(s): fix it on main, or re-run the apply, then resume, and the daemon looks again`);
    }
  }

  postDeployChecks(plan: { module: string; plan: string }): Check[] {
    const definition = this.design.modules.find((m) => m.id === plan.module)?.plans.find((p) => p.id === plan.plan);
    return (definition?.features ?? []).flatMap((f) => f.checks.filter((c) => c.phase === 'post-deploy'));
  }

  /**
   * CI on the pushed head, recorded once every required job has finished; undefined while
   * it runs. After a failure it is still read: a re-run that passes, which the owner starts
   * on GitHub once they fixed the cause, is CI passing.
   */
  private async readCi(plan: PlanState): Promise<Step | undefined> {
    const ref = { module: plan.module, plan: plan.plan };
    const ci = plan.ci!;
    const required = requiredChecks(this.design.config);
    const latest = new Map<string, CheckRun>();
    for (const run of await this.forge.checkRuns(ci.sha)) {
      if (required.includes(run.name) && run.id >= (latest.get(run.name)?.id ?? 0)) latest.set(run.name, run);
    }
    if (ci.status === 'pending' && latest.size === 0 && this.now() - Date.parse(ci.since) > 10 * 60_000) {
      this.pausePipeline(`no CI ran on PR #${plan.pr!.number} within 10 minutes: is the harness workflow on main?`);
      return 'wait';
    }
    if (latest.size < required.length || [...latest.values()].some((r) => r.status !== 'completed')) return undefined;
    const passed = required.every((name) => latest.get(name)!.conclusion === 'success');
    // A re-run that fails again changes nothing.
    if (!passed && ci.status === 'failed') return undefined;
    const jobs: CiJob[] = [];
    for (const name of required) {
      const run = latest.get(name)!;
      const conclusion = run.conclusion ?? 'unknown';
      const log = conclusion === 'success' ? undefined : await this.forge.jobLog(run).catch(() => '(the log could not be read)');
      jobs.push({ name, conclusion, ...(run.url ? { url: run.url } : {}), ...(log === undefined ? {} : { log }) });
    }
    if (passed) {
      this.record({ type: 'CI_PASSED', ref, payload: { sha: ci.sha, jobs } });
      return 'progress';
    }
    this.record({ type: 'CI_FAILED', ref, payload: { sha: ci.sha, jobs } });
    const limit = this.design.config.brakes.ciFixRounds;
    if ((plan.fixRounds ?? 0) >= limit) {
      this.pausePipeline(`CI failed on PR #${plan.pr!.number} of ${planKey(plan)} after ${limit} fix round(s): fix it on the PR's branch, or fix the cause and re-run CI, then resume`);
    }
    return 'progress';
  }

  /** The daemon's own check before anything leaves the machine: nothing protected changed since main (§8.7). */
  private async refusePush(plan: PlanState): Promise<Step | undefined> {
    const base = await this.repo.mergeBase('refs/heads/main', plan.head);
    const changed = await this.repo.changedFiles(base, plan.head);
    const problems = await protectedChanges(this.repo.treeReader(base), this.repo.treeReader(plan.head), changed, { progress: 'append' });
    if (problems.length === 0) return undefined;
    this.pausePipeline(`refusing to push ${plan.branch}: it changes protected files: ${problems.join(', ')}`);
    return 'wait';
  }

  private prTitle(plan: PlanState): string {
    if (plan.branch.startsWith('fix/')) return `Fix: ${planKey(plan)} — after the deploy, round ${plan.deployFixRounds}`;
    const definition = this.definitionOf(plan);
    // The kind's tag is for the owner and the reviewers; CI derives the kind from the design and grants nothing on the tag (v3 §3.1).
    return `Plan: ${planKey(plan)} -${definition ? planKind(definition) : 'MIXED'}- ${definition?.title ?? plan.plan}`;
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
    // In use from before its creation to after its removal, so the dashboard never offers to delete it.
    this.checking.set(name, gitRef.replace(/^refs\/(heads\/)?/, ''));
    try {
      await this.driver.remove(name);
      await this.driver.create({
        name,
        image: this.design.config.sandbox.image,
        ...this.access({ claude: false, aws: checks.some((c) => c.needs.length > 0) }),
        command: ['sleep', 'infinity'],
      });
      try {
        await this.repo.bundle(gitRef, join(dir, 'candidate.bundle'));
        await this.uploadBundle(name, join(dir, 'candidate.bundle'), p.harness);
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
    } finally {
      this.checking.delete(name);
    }
  }

  // ── Outcomes and brakes (§7.4) ───────────────────────────────────────────────

  /** The attempt counts. Unless it was a rejection, which carries guidance, the next one waits for the Manager's. */
  private async fail(state: FeatureState, attempt: Attempt, reason: string): Promise<Step> {
    this.record({ type: 'ATTEMPT_FAILED', ref: refOf(state, attempt), payload: { reason } });
    this.stopFollowing(attempt.sandbox);
    await this.driver.remove(attempt.sandbox);
    const limit = this.design.config.brakes.consecutiveFailures;
    if (this.state.pipeline.consecutiveFailures >= limit) this.pausePipeline(`${limit} attempts failed in a row`);
    return 'progress';
  }

  /** Not the Developer's fault: doesn't count, except from the third interruption of the same feature. */
  private async interrupt(state: FeatureState, attempt: Attempt, reason: string): Promise<Step> {
    await this.keepRefusals(state, attempt);
    const counts = interruptions(state, attempt.definitionHash) >= 2;
    this.record({ type: 'ATTEMPT_INTERRUPTED', ref: refOf(state, attempt), payload: { reason, counts } });
    // Followers start again when their stream ends: one left on a removed sandbox would go on trying.
    this.stopFollowing(attempt.sandbox);
    await this.driver.remove(attempt.sandbox);
    return 'progress';
  }

  /** Claude Code exited before writing anything: a flag, the token or the image is wrong, and retrying can't help. */
  private async agentDidNotStart(state: FeatureState, attempt: Attempt, stderr: string): Promise<Step> {
    await this.keepRefusals(state, attempt);
    const reason = `Claude Code did not start: ${clip(stderr.trim().replace(/\s+/g, ' ') || 'it wrote nothing', 400)}`;
    this.record({ type: 'ATTEMPT_INTERRUPTED', ref: refOf(state, attempt), payload: { reason, counts: false } });
    this.pausePipeline(`environment: ${reason}`);
    this.stopFollowing(attempt.sandbox);
    await this.driver.remove(attempt.sandbox);
    return 'progress';
  }

  private async baselineFailed(state: FeatureState, attempt: Attempt, reason: string, results: CheckResult[]): Promise<Step> {
    // init.sh runs in the attempt's sandbox: a dependency it couldn't fetch shows here.
    await this.keepRefusals(state, attempt);
    const ref = refOf(state, attempt);
    this.record({ type: 'BASELINE_FAILED', ref, payload: { reason, results } });
    this.record({ type: 'ATTEMPT_INTERRUPTED', ref, payload: { reason, counts: false } });
    this.pausePipeline(`environment: ${reason}`);
    this.stopFollowing(attempt.sandbox);
    await this.driver.remove(attempt.sandbox);
    return 'progress';
  }

  /**
   * Reads the sandbox's log for the requests its policy refused, at most once a minute
   * unless `now`: OpenShell keeps only a sandbox's last lines, which a long attempt
   * outgrows. Never throws; what was read before stays.
   */
  private async readRefusals(sandbox: string, now = false): Promise<Denials> {
    const known = this.refusals.get(sandbox) ?? { denials: new Denials(), readAt: 0 };
    this.refusals.set(sandbox, known);
    if (!now && this.now() - known.readAt < 60_000) return known.denials;
    known.readAt = this.now();
    try {
      known.denials.add(await this.driver.logs(sandbox, LOG_LINES));
    } catch (error) {
      this.log(`the log of ${sandbox} could not be read: ${(error as Error).message}`);
    }
    return known.denials;
  }

  /**
   * Before the attempt's sandbox goes, what its policy refused is recorded with the
   * attempt: the Manager sees it with a failure, the owner on the attempt's card. Only
   * while the sandbox is there, before its checks start; once per attempt.
   */
  private async keepRefusals(state: FeatureState, attempt: Attempt): Promise<void> {
    if (attempt.refused || !['starting', 'running', 'collecting'].includes(attempt.status)) return;
    const requests = (await this.readRefusals(attempt.sandbox, true)).list();
    this.refusals.delete(attempt.sandbox);
    if (requests.length > 0) this.record({ type: 'NETWORK_REFUSED', ref: refOf(state, attempt), payload: { requests } });
  }

  /**
   * Records what a long-lived agent, a Manager (`manager:<key>`) or an Architect
   * (`architect:<module>`), has used of Claude, read from its sandbox at most every five
   * minutes unless `now`: before a sandbox goes. Only a reading that changed is recorded.
   */
  async noteTokens(agent: string, sandbox: string, now = false): Promise<void> {
    if (!now && this.now() - (this.tokensReadAt.get(agent) ?? -Infinity) < 5 * 60_000) return;
    this.tokensReadAt.set(agent, this.now());
    const reading = await readTokens(this, sandbox);
    if (!reading) return;
    const last = this.state.agentTokens?.[agent]?.reading ?? { inputTokens: 0, outputTokens: 0 };
    if (last.inputTokens === reading.inputTokens && last.outputTokens === reading.outputTokens) return;
    this.record({ type: 'AGENT_TOKENS', payload: { agent, reading } });
  }

  /** An error outside any attempt: logged, and the loop goes on. */
  private async onStepError(error: Error): Promise<void> {
    this.stepErrors = { key: 'idle', count: this.stepErrors.key === 'idle' ? this.stepErrors.count + 1 : 1 };
    this.log(`step failed (idle, ${this.stepErrors.count}): ${error.message}`);
  }

  /** An error in one attempt's step: counted for that attempt and its status, and past the limit the attempt is interrupted. */
  private async onAttemptError(feature: FeatureState, attempt: Attempt, error: Error): Promise<void> {
    const key = `${featureKey(refOf(feature, attempt))}#${attempt.n}:${attempt.status}`;
    this.stepErrors = { key, count: this.stepErrors.key === key ? this.stepErrors.count + 1 : 1 };
    this.log(`step failed (${key}, ${this.stepErrors.count}/${STEP_ERROR_LIMIT}): ${error.message}`);
    if (this.stepErrors.count >= STEP_ERROR_LIMIT) {
      this.stepErrors = { key: '', count: 0 };
      await this.interrupt(feature, attempt, `infrastructure error: ${error.message}`).catch(() => {});
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
    const developer = this.developers.get(sandbox);
    if (!developer) return false;
    await developer.channel.reply(requestId, true, text);
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

  /**
   * The module being built, the only one with Developers, Managers and reviewers: modules
   * are built one after another (v2 §12.8), and only Architects work on the others
   * meanwhile. It is the module of the oldest plan in flight; with none in flight, the
   * module of the plan started last while it has a plan to build, such as one a gate
   * holds; then the first, in design order, with a plan to build. Only state left by
   * 0.2.0 has plans of two modules in flight: the older module is finished first.
   */
  currentModule(): string | undefined {
    const plans = Object.values(this.state.plans);
    const inFlight = plans.find((p) => this.inFlight(p));
    if (inFlight) return inFlight.module;
    const toBuild = (id: string) => this.design.modules.find((m) => m.id === id)?.plans.some((p) => this.state.plans[`${id}/${p.id}`]?.status !== 'completed') ?? false;
    const last = plans.at(-1)?.module;
    if (last !== undefined && toBuild(last)) return last;
    return this.design.modules.find((m) => toBuild(m.id))?.id;
  }

  /** A plan under way: not complete, and still in the design while it is built, since a design change may drop a plan before its build ends. */
  inFlight(plan: PlanState): boolean {
    if (plan.status === 'completed') return false;
    return plan.status !== 'active' || this.design.modules.some((m) => m.id === plan.module && m.plans.some((p) => p.id === plan.plan));
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

  /** The feature's definition in the design now, or undefined once a design change dropped it. */
  featureDefinition(state: { module: string; plan: string; feature: string }): Feature | undefined {
    try {
      return this.lookup(state).feature;
    } catch {
      return undefined;
    }
  }

  lookup(state: { module: string; plan: string; feature: string }): { plan: Plan; feature: Feature } {
    const plan = this.design.modules.find((m) => m.id === state.module)?.plans.find((p) => p.id === state.plan);
    const fix = this.state.features[`${state.module}/${state.plan}/${state.feature}`]?.fix;
    if (plan && fix) return { plan, feature: fixDefinition(state.feature, `${state.module}/${state.plan}`, fix) };
    const feature = plan?.features.find((f) => f.id === state.feature);
    if (!plan || !feature) throw new Error(`${state.module}/${state.plan}/${state.feature} is no longer in the design`);
    return { plan, feature };
  }

  /**
   * The project's own pre-merge checks, then those of every accepted feature whose
   * commit `commit` contains: they must keep passing. Work landed on another plan's
   * branch, or merged on main after this branch last took it, isn't in `commit`, so its
   * checks aren't asked of it (v3 §6.2). Nor are those of a feature the design dropped,
   * or redefined since: it is built again, and its new checks are its attempt's.
   */
  async regressionChecks(commit: string): Promise<Check[]> {
    const accepted: Check[] = [];
    for (const feature of Object.values(this.state.features)) {
      if (feature.status !== 'accepted' || !feature.commit) continue;
      const definition = this.featureDefinition(feature);
      if (!definition || !acceptedAsDefined(feature, definition) || !(await this.repo.isAncestor(feature.commit, commit))) continue;
      accepted.push(...preMerge(definition.checks));
    }
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

  /**
   * Uploads a git bundle the daemon wrote for a sandbox, then deletes it here: the
   * sandbox clones or fetches from its own copy, and the daemon's repository has the
   * history. Kept, they would grow without end, a copy per attempt and per review.
   */
  async uploadBundle(sandbox: string, file: string, remoteDir: string): Promise<void> {
    try {
      await this.driver.upload(sandbox, file, remoteDir);
    } finally {
      rmSync(file, { force: true });
    }
  }

  /** Fetches a bundle a sandbox made into `ref`, then deletes it: the ref holds its commits. */
  async fetchBundle(file: string, ref: string): Promise<string> {
    try {
      return await this.repo.fetchBundle(file, ref);
    } finally {
      rmSync(file, { force: true });
    }
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

  /**
   * The owner's time, planned and used, or undefined while the owner hasn't set their
   * hours. A design in review counts as submitted: it is read from the Architect's ref,
   * not from main, where it isn't yet.
   */
  async ownerTime(): Promise<OwnerTime | undefined> {
    if (this.state.budgets.ownerHours === undefined) return undefined;
    const modules = [...this.design.modules];
    for (const module of Object.values(this.state.modules).filter((m) => m.status === 'in_review')) {
      const submitted = (await loadDesign(this.repo, architectRef(module.module)).catch(() => undefined))?.modules.find((m) => m.id === module.module);
      if (!submitted) continue;
      const current = modules.findIndex((m) => m.id === module.module);
      if (current === -1) modules.push(submitted);
      else modules[current] = submitted;
    }
    return ownerTime(this.design.config, { config: this.design.config, modules }, this.state);
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
   * Every sandbox gets the keys of the project's APIs, for the code it runs.
   */
  access(options: { claude: boolean; aws: boolean; allBundles?: boolean }): Pick<SandboxSpec, 'providers' | 'env' | 'labels' | 'cpu' | 'memory'> & { policyFile: string } {
    const aws = options.aws ? this.design.config.aws : undefined;
    const limits = this.state.sandboxLimits;
    const project = this.design.config.project.name;
    // The keys of the project's APIs, which OpenShell adds on requests to their hosts alone.
    const apiKeys = this.design.config.network.apis.flatMap((api) => (api.key ? [apiProviderName(project, api.host)] : []));
    return {
      providers: [...(options.claude ? [this.design.config.sandbox.claudeProvider] : []), ...(aws ? [aws.provider] : []), ...apiKeys],
      policyFile: this.policyFile({ allBundles: options.allBundles ?? false, aws: aws !== undefined }),
      env: this.sandboxEnv(),
      // Every sandbox the daemon makes says whose it is: the dashboard tells them from other projects'.
      labels: { [PROJECT_LABEL]: this.design.config.project.name },
      // The owner's caps, so that agents and checks in parallel leave the machine usable.
      ...(limits?.cpu !== undefined ? { cpu: `${Math.round(limits.cpu * 1000)}m` } : {}),
      ...(limits?.memoryGiB !== undefined ? { memory: `${Math.round(limits.memoryGiB * 1024)}Mi` } : {}),
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
    try {
      this.design = await loadDesign(this.repo, 'refs/heads/main');
    } catch (error) {
      // What runs goes on under the last valid design, and nothing new starts until main is fixed.
      this.pausePipeline(`the design on main is invalid: ${clip((error as Error).message.replace(/\s+/g, ' '), 400)}`);
      throw error;
    }
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
    return this.fetchBundle(local, attemptRefName(ref));
  }

  async killAgent(sandbox: string): Promise<void> {
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
    if (this.developers.has(sandbox)) return;
    const agent = `developer:${featureKey(ref)}/a${ref.attempt}`;
    const follower = this.driver.follow(sandbox, this.paths(sandbox).stream, 1, (line) => this.events.emit('transcript', { agent, line }));
    const channel = this.channel({ role: 'developer', sandbox }, join(this.attemptDir(ref), 'replied.txt'));
    this.developers.set(sandbox, { follower, channel });
  }

  private stopFollowing(sandbox: string): void {
    const developer = this.developers.get(sandbox);
    developer?.follower.stop();
    developer?.channel.stop();
    this.developers.delete(sandbox);
  }

  /** A reviewer's transcript for the dashboard, and its channel for `web_read` (v3 §5.1), once per sandbox: plans in parallel may be reviewed at once. */
  followReview(review: ReviewState): void {
    if (this.reviewers.has(review.sandbox)) return;
    const agent = `${review.role}:${review.head.slice(0, 8)}`;
    const follower = this.driver.follow(review.sandbox, this.paths(review.sandbox).stream, 1, (line) => this.events.emit('transcript', { agent, line }));
    const channel = this.channel({ role: 'reviewer', sandbox: review.sandbox }, join(this.options.harnessDir, 'reviews', `${review.sandbox}.replied.txt`));
    this.reviewers.set(review.sandbox, { follower, channel });
  }

  /** Stops following one reviewer's sandbox, or every one. */
  stopFollowingReview(sandbox?: string): void {
    for (const [name, reviewer] of [...this.reviewers]) {
      if (sandbox !== undefined && name !== sandbox) continue;
      reviewer.follower.stop();
      reviewer.channel.stop();
      this.reviewers.delete(name);
    }
  }

  /**
   * In Swarm, main's rules require the reviewers' statuses on every PR (v3 §3.3), but only
   * plan PRs are reviewed: an Arch or Fix PR, which the owner merges, gets them as "not
   * reviewed", once per head, so the owner merges it without bypassing the rules, and CI
   * still gates it.
   */
  async markUnreviewed(head: string, what: string): Promise<void> {
    if (this.state.mode !== 'swarm' || this.unreviewed.has(head)) return;
    const contexts = this.design.config.swarm.requiredStatuses.filter((context) => REVIEWER_ROLES.some((role) => statusContext(role) === context));
    try {
      for (const context of contexts) await this.forge.setCommitStatus(head, { context, state: 'success', description: `not reviewed: ${what}` });
      this.unreviewed.add(head);
    } catch (error) {
      // Without "Commit statuses: write" the owner merges it with the bypass, as before.
      this.log(`the reviewers' statuses on ${head.slice(0, 8)} could not be set: ${(error as Error).message}`);
    }
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

/** A fix round, described as a feature so that it runs like one. It has no checks of its own: CI, or the reviewer, is its check. */
function fixDefinition(id: string, plan: string, fix: NonNullable<FeatureState['fix']>): Feature {
  if (fix.kind === 'review') {
    return {
      id,
      title: `Fix the ${fix.role} review, round ${fix.round}`,
      kind: 'app',
      description: `The ${fix.role} reviewer blocked the pull request of plan ${plan}. Fix every blocking finding below, without touching protected files. Advisory findings are yours to judge.\n\n${fix.failure}`,
      expected: 'The reviewer passes the next head of the pull request, and every check listed below still passes.',
      dependsOn: [],
      gates: [],
      resources: [],
      checks: [],
    };
  }
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

/**
 * Accepted, as the design defines the feature now: one redefined since is built again
 * while its plan is. A feature recovered from git has no attempts to compare with.
 */
function acceptedAsDefined(state: FeatureState | undefined, definition: Feature): boolean {
  if (state?.status !== 'accepted') return false;
  const accepted = state.attempts.findLast((a) => a.status === 'accepted');
  return accepted === undefined || accepted.definitionHash === definitionHash(definition);
}

/** An owner action's estimate, carried by its OWNER_ACTION_DONE so the time used survives a redesign. */
function minutesOf(action: { estimatedMinutes?: number | undefined }): { minutes?: number } {
  return action.estimatedMinutes === undefined ? {} : { minutes: action.estimatedMinutes };
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
    fix ? `fix(${ref.module}/${ref.plan}): ${fix.kind === 'ci' ? 'CI' : fix.kind === 'review' ? `the ${fix.role} review` : 'the deploy'}, round ${fix.round}` : `feat(${featureKey(ref)}): ${feature.title}`,
    ...(fix ? [] : ['', feature.description]),
    ...(attempt.summary ? ['', attempt.summary] : []),
    '',
    `Feature: ${featureKey(ref)}`,
    `Attempt: ${ref.attempt}`,
    `Checks: ${results.map((r) => r.id).join(', ')}`,
    '',
  ].join('\n');
}
