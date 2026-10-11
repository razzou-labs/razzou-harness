import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { managerSettings, userMessage, type ManagerRun } from '../agents/claude-code.ts';
import type { Follower } from '../sandbox/driver.ts';
import type { ManagerState } from '../state/state.ts';
import { clip, sh } from '../util.ts';
import type { AgentChannel } from './channel.ts';
import { mailText, pendingItems, type Item } from './items.ts';
import type { Orchestrator } from './orchestrator.ts';
import { attemptRefName, probeScript, sandboxName, waitForFile } from './refs.ts';

/** After this many failed passes in a row, the Manager's sandbox is considered broken and the pipeline pauses. */
const ERROR_LIMIT = 5;
const HOUR = 3_600_000;

/**
 * The Managers (proposal v2 §7.5): one long-lived Claude Code session per module, in its
 * own sandbox, fed from a file so that it outlives the daemon. On each pass the daemon
 * starts or relaunches the one for the module being built, keeps its channel and
 * transcript attached, and delivers what waits for it.
 */
export class Managers {
  private readonly o: Orchestrator;
  private attached?: { sandbox: string; sessionId: string; channel: AgentChannel; transcript: Follower };
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
      if (this.errors >= ERROR_LIMIT && !this.o.state.pipeline.paused) {
        this.errors = 0;
        this.o.record({ type: 'PIPELINE_PAUSED', payload: { reason: `the Manager's sandbox keeps failing: ${clip(message, 300)}` } });
      }
    }
  }

  /** Stops following the Manager's files; the Manager itself keeps running. */
  detach(): void {
    this.attached?.transcript.stop();
    this.attached?.channel.stop();
    this.attached = undefined;
  }

  private async syncOnce(): Promise<void> {
    const o = this.o;
    for (const manager of Object.values(o.state.managers)) {
      if (manager.status !== 'stopped' && this.done(manager.module)) await this.stop(manager, 'every plan of its module is complete');
    }
    const module = o.currentModule();
    if (!module) return;
    const manager = o.state.managers[module];
    if (!manager || manager.status === 'stopped') return this.start(module);
    if (manager.status === 'starting') return this.start(module, manager);
    if ((await o.driver.status(manager.sandbox)) === 'missing') return this.start(module);
    if (manager.status === 'running' && (await this.alive(manager))) {
      this.attach(manager);
      return this.deliver(manager);
    }
    return this.relaunch(o.state.managers[module]!);
  }

  /** A fresh sandbox and conversation. `existing` resumes a start that was cut short. */
  private async start(module: string, existing?: ManagerState): Promise<void> {
    const o = this.o;
    if (!existing) {
      const sandbox = sandboxName('mgr', o.design.config.project.name, module);
      o.record({ type: 'MANAGER_STARTING', payload: { module, sandbox, sessionId: randomUUID() } });
    }
    const manager = o.state.managers[module]!;
    this.detach();
    const p = this.paths(manager);
    const dir = this.localDir(module);
    await o.driver.remove(manager.sandbox);
    await o.driver.create({
      name: manager.sandbox,
      image: o.design.config.sandbox.image,
      ...o.access({ claude: true, aws: true }),
      command: ['sleep', 'infinity'],
    });

    const branch = this.branch(module);
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
    o.record({ type: 'MANAGER_LAUNCHED', payload: { module: manager.module, launch: n, outputBytes: Number(size.stdout.trim()) || 0 } });
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
        module: manager.module,
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
      o.record({ type: 'PIPELINE_PAUSED', payload: { reason: `environment: the Manager ${why}: ${detail}` } });
      return;
    }
    await this.launch(manager, manager.launch + 1);
    o.kick();
  }

  private attach(manager: ManagerState): void {
    if (this.attached?.sandbox === manager.sandbox && this.attached.sessionId === manager.sessionId) return;
    this.detach();
    const o = this.o;
    const agent = `manager:${manager.module}`;
    const transcript = o.driver.follow(manager.sandbox, this.paths(manager).output, 1, (line) => o.events.emit('transcript', { agent, line }));
    const channel = o.channel(
      { role: 'manager', sandbox: manager.sandbox, module: manager.module },
      join(this.localDir(manager.module), `replied-${manager.sessionId}.txt`),
    );
    this.attached = { sandbox: manager.sandbox, sessionId: manager.sessionId, channel, transcript };
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
      o.record({ type: 'MANAGER_ITEM_SENT', payload: { module: manager.module, key: mail.key, launch: manager.launch, reminder: false } });
    }
    const turnMs = o.design.config.brakes.managerTurnMinutes * 60_000;
    const waitingForOwner = Object.values(o.state.ownerRequests).some((r) => r.module === manager.module && r.answer === undefined);
    for (const item of pendingItems(o, manager.module)) {
      const sent = manager.sent[item.key];
      if (!sent || sent.launch !== manager.launch) {
        if (item.show) await this.show(manager, item);
        await this.send(manager, await item.text());
        o.record({ type: 'MANAGER_ITEM_SENT', payload: { module: manager.module, key: item.key, launch: manager.launch, reminder: false } });
      } else if (waitingForOwner) {
        continue;
      } else if (!sent.reminded && o.now() - Date.parse(sent.at) >= turnMs) {
        await this.send(manager, `[harness] REMINDER: ${item.title} is still waiting for you. ${item.ask}`);
        o.record({ type: 'MANAGER_ITEM_SENT', payload: { module: manager.module, key: item.key, launch: manager.launch, reminder: true } });
      } else if (sent.reminded && o.now() - Date.parse(sent.reminded) >= turnMs && !o.state.pipeline.paused) {
        const minutes = o.design.config.brakes.managerTurnMinutes * 2;
        o.record({ type: 'PIPELINE_PAUSED', payload: { reason: `the Manager has not acted on ${item.title} for ${minutes} minutes` } });
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
    const local = join(this.localDir(manager.module), 'review.bundle');
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
    if (this.attached?.sandbox === manager.sandbox) this.detach();
    const backup = join(this.localDir(manager.module), `transcript-${manager.sessionId}.jsonl`);
    await o.driver.download(manager.sandbox, this.paths(manager).output, backup).catch(() => {});
    await o.driver.remove(manager.sandbox);
    o.record({ type: 'MANAGER_STOPPED', payload: { module: manager.module, reason } });
  }

  private done(module: string): boolean {
    const design = this.o.design.modules.find((m) => m.id === module);
    return !design || design.plans.every((p) => this.o.state.plans[`${module}/${p.id}`]?.status === 'completed');
  }

  /** The branch the Manager's clone starts from: its module's plan under way, or main. */
  private branch(module: string): string {
    return Object.values(this.o.state.plans).find((p) => p.module === module && p.status !== 'completed')?.branch ?? 'main';
  }

  private localDir(module: string): string {
    const dir = join(this.o.moduleDir(module), 'manager');
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
