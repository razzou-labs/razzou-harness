import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { managerSettings, userMessage, type ManagerRun } from '../agents/claude-code.ts';
import type { Follower } from '../sandbox/driver.ts';
import { managerKey, type ManagerState } from '../state/state.ts';
import { clip, sh } from '../util.ts';
import type { AgentChannel } from './channel.ts';
import { mailText, pendingItems, type Item } from './items.ts';
import type { Orchestrator } from './orchestrator.ts';
import { attemptRefName, probeScript, sandboxName, waitForFile } from './refs.ts';

/** After this many failed passes in a row, a Manager's sandbox is considered broken and the pipeline pauses. */
const ERROR_LIMIT = 5;
const HOUR = 3_600_000;

/** What a Manager is in charge of: a module, or one plan of it in Swarm (v3 §6.4). */
export interface ManagerScope {
  module: string;
  plan?: string;
}

/**
 * The Managers (proposal v2 §7.5, v3 §6.4): long-lived Claude Code sessions, each in its
 * own sandbox, fed from a file so that they outlive the daemon. In Manual there is one
 * per module being built; in Swarm one per plan in flight. On each pass the daemon
 * starts or relaunches the ones wanted, keeps their channels and transcripts attached,
 * and delivers what waits for each.
 */
export class Managers {
  private readonly o: Orchestrator;
  private readonly attached = new Map<string, { sandbox: string; sessionId: string; channel: AgentChannel; transcript: Follower }>();
  private errors = 0;

  constructor(o: Orchestrator) {
    this.o = o;
  }

  async sync(): Promise<void> {
    try {
      await this.syncOnce();
      this.errors = 0;
    } catch (error) {
      this.errors += 1;
      const message = (error as Error).message;
      this.o.log(`manager: ${message} (${this.errors}/${ERROR_LIMIT})`);
      if (this.errors >= ERROR_LIMIT) {
        this.errors = 0;
        this.o.pausePipeline(`a Manager's sandbox keeps failing: ${clip(message, 300)}`);
      }
    }
  }

  /** Stops following the Managers' files; the Managers themselves keep running. */
  detach(): void {
    for (const key of [...this.attached.keys()]) this.detachOne(key);
  }

  private detachOne(key: string): void {
    const attached = this.attached.get(key);
    attached?.transcript.stop();
    attached?.channel.stop();
    this.attached.delete(key);
  }

  private async syncOnce(): Promise<void> {
    const o = this.o;
    const current = o.currentModule();
    for (const manager of Object.values(o.state.managers)) {
      if (manager.status === 'stopped') continue;
      if (this.done(manager)) await this.stop(manager, manager.plan ? 'its plan is complete' : 'every plan of its module is complete');
      // Only state left by 0.2.0 has one: Managers work on the module being built alone (v2 §12.8).
      else if (manager.module !== current) await this.stop(manager, 'another module is being built');
    }
    for (const scope of this.wanted()) {
      const key = managerKey(scope);
      const manager = o.state.managers[key];
      if (!manager || manager.status === 'stopped') {
        await this.start(scope);
      } else if (manager.status === 'starting') {
        await this.start(scope, manager);
      } else if ((await o.driver.status(manager.sandbox)) === 'missing') {
        await this.start(scope);
      } else if (manager.status === 'running' && (await this.alive(manager))) {
        this.attach(manager);
        await this.deliver(manager);
      } else {
        await this.relaunch(o.state.managers[key]!);
      }
    }
  }

  /**
   * Who should be running, all in the module being built: in Manual, one Manager for the
   * module, as in v2; in Swarm, one per plan in flight (v3 §6.4). A Manager started under
   * the other mode keeps its scope until it stops, so no item is ever delivered twice: a
   * module's Manager serves every plan of its module, and a plan's Manager its plan.
   */
  private wanted(): ManagerScope[] {
    const o = this.o;
    const module = o.currentModule();
    if (!module) return [];
    const alive = (key: string) => o.state.managers[key] !== undefined && o.state.managers[key]!.status !== 'stopped';
    const scopes = new Map<string, ManagerScope>();
    const inFlight = Object.values(o.state.plans).filter((p) => p.module === module && o.inFlight(p));
    if (o.state.mode === 'swarm') {
      for (const plan of inFlight) {
        const scope: ManagerScope = alive(module) ? { module } : { module, plan: plan.plan };
        scopes.set(managerKey(scope), scope);
      }
    } else {
      const ofPlans = inFlight.filter((p) => alive(managerKey(p))).map((p): ManagerScope => ({ module, plan: p.plan }));
      for (const scope of ofPlans.length > 0 ? ofPlans : [{ module }]) scopes.set(managerKey(scope), scope);
    }
    return [...scopes.values()];
  }

  /** A fresh sandbox and conversation. `existing` resumes a start that was cut short. */
  private async start(scope: ManagerScope, existing?: ManagerState): Promise<void> {
    const o = this.o;
    const key = managerKey(scope);
    if (!existing) {
      const sandbox = sandboxName('mgr', o.design.config.project.name, key);
      o.record({ type: 'MANAGER_STARTING', payload: { ...identity(scope), sandbox, sessionId: randomUUID() } });
    }
    const manager = o.state.managers[key]!;
    this.detachOne(key);
    const p = this.paths(manager);
    const dir = this.localDir(manager);
    await o.driver.remove(manager.sandbox);
    await o.driver.create({
      name: manager.sandbox,
      image: o.design.config.sandbox.image,
      ...o.access({ claude: true, aws: true }),
      command: ['sleep', 'infinity'],
    });

    const branch = this.branch(manager);
    await o.repo.bundle(`refs/heads/${branch}`, join(dir, 'clone.bundle'));
    copyFileSync(join(o.options.packageDir, 'roles', 'manager.md'), join(dir, 'manager.md'));
    writeFileSync(join(dir, 'settings.json'), managerSettings());
    for (const file of ['clone.bundle', 'manager.md', 'settings.json']) await o.driver.upload(manager.sandbox, join(dir, file), p.harness);
    await o.uploadAgentFiles(manager.sandbox, 'manager', dir);
    const clone = await o.exec(manager.sandbox, `git clone --quiet --branch ${sh(branch)} ${sh(`${p.harness}/clone.bundle`)} ${sh(p.work)}`);
    if (clone.code !== 0) throw new Error(`could not clone the plan branch for the Manager: ${clone.stderr.trim()}`);
    await this.launch(manager, 1);
    o.kick();
  }

  private async launch(manager: ManagerState, n: number): Promise<void> {
    const o = this.o;
    const run = this.run(manager, n);
    const p = this.paths(manager);
    const size = await o.exec(manager.sandbox,
      `mkdir -p ${sh(run.inputFile.replace(/\/[^/]+$/, ''))} && : > ${sh(run.inputFile)} && { { wc -c < ${sh(p.output)}; } 2>/dev/null || echo 0; }`);
    if (size.code !== 0) throw new Error(`could not prepare the Manager's launch: ${size.stderr.trim()}`);
    const result = await o.exec(manager.sandbox, [o.agent.launchManager(run), waitForFile(run.pidFile)].join('\n'));
    if (result.code !== 0) throw new Error(`could not start the Manager: ${(result.stderr || result.stdout).trim()}`);
    o.record({ type: 'MANAGER_LAUNCHED', payload: { ...identity(manager), launch: n, outputBytes: Number(size.stdout.trim()) || 0 } });
  }

  /** Whether the current launch still runs. If not, its exit is recorded. */
  private async alive(manager: ManagerState): Promise<boolean> {
    const o = this.o;
    const run = this.run(manager, manager.launch);
    const probe = await o.exec(manager.sandbox, probeScript(run.exitFile, run.pidFile));
    const status = probe.stdout.trim();
    if (status === 'running') return true;
    const after = await o.exec(manager.sandbox,
      `{ { wc -c < ${sh(this.paths(manager).output)}; } 2>/dev/null || echo 0; }; tail -c 2000 ${sh(run.stderrFile)} 2>/dev/null`);
    const [bytes = '0', ...stderr] = after.stdout.split('\n');
    o.record({
      type: 'MANAGER_EXITED',
      payload: {
        ...identity(manager),
        launch: manager.launch,
        code: status === 'gone' ? null : Number(status),
        stderr: stderr.join('\n').trim(),
        started: (Number(bytes) || 0) > (manager.launchedOutputBytes ?? 0),
      },
    });
    return false;
  }

  /**
   * Starts Claude again in the same sandbox, resuming the conversation. A Manager that
   * never started, or keeps stopping, pauses the pipeline instead: retrying can't help.
   */
  private async relaunch(manager: ManagerState): Promise<void> {
    const o = this.o;
    if (o.state.pipeline.paused) return;
    const recent = manager.exits.filter((t) => o.now() - Date.parse(t) < HOUR).length;
    if (manager.lastExit && (!manager.lastExit.started || recent >= 3)) {
      const why = manager.lastExit.started ? `stopped ${recent} times within an hour` : 'did not start';
      const detail = clip(manager.lastExit.stderr.replace(/\s+/g, ' ') || 'it wrote nothing', 400);
      o.pausePipeline(`environment: the Manager of ${managerKey(manager)} ${why}: ${detail}`);
      return;
    }
    await this.launch(manager, manager.launch + 1);
    o.kick();
  }

  private attach(manager: ManagerState): void {
    const key = managerKey(manager);
    const current = this.attached.get(key);
    if (current?.sandbox === manager.sandbox && current.sessionId === manager.sessionId) return;
    this.detachOne(key);
    const o = this.o;
    const agent = `manager:${key}`;
    const transcript = o.driver.follow(manager.sandbox, this.paths(manager).output, 1, (line) => o.events.emit('transcript', { agent, line }));
    const channel = o.channel(
      { role: 'manager', sandbox: manager.sandbox, ...identity(manager) },
      join(this.localDir(manager), `replied-${manager.sessionId}.txt`),
    );
    this.attached.set(key, { sandbox: manager.sandbox, sessionId: manager.sessionId, channel, transcript });
  }

  /**
   * Sends what waits for the Manager: mail once, and each pending item once per launch.
   * An item left without a decision for a turn gets a reminder; after another turn the
   * pipeline pauses (§7.4), unless the Manager is waiting for the owner.
   */
  private async deliver(manager: ManagerState): Promise<void> {
    const o = this.o;
    for (const mail of [...manager.mail]) {
      await this.send(manager, mailText(o, manager, mail));
      o.record({ type: 'MANAGER_ITEM_SENT', payload: { ...identity(manager), key: mail.key, launch: manager.launch, reminder: false } });
    }
    const turnMs = o.design.config.brakes.managerTurnMinutes * 60_000;
    const waitingForOwner = Object.values(o.state.ownerRequests).some((r) => r.module === manager.module && r.answer === undefined);
    for (const item of pendingItems(o, manager)) {
      const sent = manager.sent[item.key];
      if (!sent || sent.launch !== manager.launch) {
        if (item.show) await this.show(manager, item);
        await this.send(manager, await item.text());
        o.record({ type: 'MANAGER_ITEM_SENT', payload: { ...identity(manager), key: item.key, launch: manager.launch, reminder: false } });
      } else if (waitingForOwner) {
        continue;
      } else if (!sent.reminded && o.now() - Date.parse(sent.at) >= turnMs) {
        await this.send(manager, `[harness] REMINDER: ${item.title} is still waiting for you. ${item.ask}`);
        o.record({ type: 'MANAGER_ITEM_SENT', payload: { ...identity(manager), key: item.key, launch: manager.launch, reminder: true } });
      } else if (sent.reminded && o.now() - Date.parse(sent.reminded) >= turnMs) {
        const minutes = o.design.config.brakes.managerTurnMinutes * 2;
        o.pausePipeline(`the Manager has not acted on ${item.title} for ${minutes} minutes`);
      }
    }
  }

  private async send(manager: ManagerState, text: string): Promise<void> {
    const run = this.run(manager, manager.launch);
    const result = await this.o.exec(manager.sandbox, `cat >> ${sh(run.inputFile)}`, `${userMessage(text)}\n`);
    if (result.code !== 0) throw new Error(`could not write to the Manager: ${(result.stderr || result.stdout).trim()}`);
  }

  /** Checks out an attempt in the Manager's clone, so it reviews the real files with git. */
  private async show(manager: ManagerState, item: Item): Promise<void> {
    const o = this.o;
    const { attempt, branch } = item.show!;
    const attemptRef = attempt ? attemptRefName(attempt) : undefined;
    const head = attemptRef ? await o.repo.revParse(attemptRef) : undefined;
    const local = join(this.localDir(manager), 'review.bundle');
    await o.repo.bundle([`refs/heads/${branch}`, ...(head && attemptRef ? [attemptRef] : [])], local);
    const p = this.paths(manager);
    await o.driver.upload(manager.sandbox, local, p.harness);
    const result = await o.exec(manager.sandbox, [
      `cd ${sh(p.work)}`,
      `git fetch --quiet --force ${sh(`${p.harness}/review.bundle`)} '+refs/heads/*:refs/remotes/harness/*' '+refs/attempts/*:refs/remotes/harness/attempts/*'`,
      `git checkout --quiet --detach ${sh(head ?? `refs/remotes/harness/${branch}`)}`,
    ].join(' && '));
    if (result.code !== 0) throw new Error(`could not show the attempt to the Manager: ${result.stderr.trim()}`);
  }

  private async stop(manager: ManagerState, reason: string): Promise<void> {
    const o = this.o;
    this.detachOne(managerKey(manager));
    const backup = join(this.localDir(manager), `transcript-${manager.sessionId}.jsonl`);
    await o.driver.download(manager.sandbox, this.paths(manager).output, backup).catch(() => {});
    await o.driver.remove(manager.sandbox);
    o.record({ type: 'MANAGER_STOPPED', payload: { ...identity(manager), reason } });
  }

  /** A plan's Manager is done with its plan complete, or gone from the design; a module's, with every plan of the module complete. */
  private done(manager: ManagerState): boolean {
    const design = this.o.design.modules.find((m) => m.id === manager.module);
    if (manager.plan) return !design?.plans.some((p) => p.id === manager.plan) || this.o.state.plans[managerKey(manager)]?.status === 'completed';
    return !design || design.plans.every((p) => this.o.state.plans[`${manager.module}/${p.id}`]?.status === 'completed');
  }

  /** The branch the Manager's clone starts from: its plan's, or its module's plan under way, or main. */
  private branch(manager: ManagerState): string {
    if (manager.plan) return this.o.state.plans[managerKey(manager)]?.branch ?? 'main';
    return Object.values(this.o.state.plans).find((p) => p.module === manager.module && this.o.inFlight(p))?.branch ?? 'main';
  }

  /** The daemon's files for a Manager, where the dashboard also finds its transcripts after it stops. */
  private localDir(manager: ManagerState): string {
    const dir = manager.plan ? join(this.o.planDir({ module: manager.module, plan: manager.plan }), 'manager') : join(this.o.moduleDir(manager.module), 'manager');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private paths(manager: ManagerState) {
    const p = this.o.paths(manager.sandbox);
    return { ...p, output: `${p.harness}/manager/out.jsonl` };
  }

  private run(manager: ManagerState, n: number): ManagerRun {
    const p = this.paths(manager);
    const dir = `${p.harness}/manager/launch-${n}`;
    const role = this.o.design.config.roles.manager;
    return {
      workDir: p.work,
      promptFile: `${p.harness}/manager.md`,
      mcpConfigFile: p.mcpConfig,
      settingsFile: `${p.harness}/settings.json`,
      inputFile: `${dir}/in.jsonl`,
      outputFile: p.output,
      stderrFile: `${dir}/stderr.log`,
      exitFile: `${dir}/exit_code`,
      pidFile: `${dir}/pid`,
      tailPidFile: `${dir}/tail.pid`,
      sessionId: manager.sessionId,
      model: role.model,
      ...(role.effort ? { effort: role.effort } : {}),
    };
  }
}

/** A Manager's scope, as events carry it. */
const identity = (scope: ManagerScope): { module: string; plan?: string } => ({ module: scope.module, ...(scope.plan ? { plan: scope.plan } : {}) });
