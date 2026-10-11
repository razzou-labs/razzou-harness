import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { architectSettings, claudeJson } from '../agents/claude-code.ts';
import { requiredChecks } from '../design/schemas.ts';
import { ARCHITECT } from '../git/repo.ts';
import type { CheckRun } from '../github/forge.ts';
import type { CiJob } from '../state/events.ts';
import type { ModuleState } from '../state/state.ts';
import { clip, sh } from '../util.ts';
import type { AgentChannel } from './channel.ts';
import { submitDesign } from './design.ts';
import type { Orchestrator } from './orchestrator.ts';

/**
 * The Architects (proposal v2 §7.1, §7.5): one long-lived interactive Claude Code session
 * per module, in a sandbox whose main command is its launcher, so the owner attaches to
 * its terminal with `harness attach`. Each pass delivers its notes, processes a submitted
 * design, and follows the design's pull request until the owner merges it.
 */
export class Architects {
  private readonly o: Orchestrator;
  private readonly channels = new Map<string, AgentChannel>();
  private readonly busy = new Set<string>();
  private readonly nextPoll = new Map<string, number>();

  constructor(o: Orchestrator) {
    this.o = o;
  }

  async sync(): Promise<void> {
    for (const module of Object.values(this.o.state.modules)) {
      try {
        await this.syncModule(module);
      } catch (error) {
        this.o.log(`architect of ${module.module}: ${(error as Error).message}`);
      }
    }
  }

  /** Stops following the Architects' outboxes; the Architects keep running. */
  detach(): void {
    for (const channel of this.channels.values()) channel.stop();
    this.channels.clear();
  }

  /** Answers the Architect's `submit_design` once the daemon has dealt with it. */
  reply(module: string, requestId: string, ok: boolean, text: string): Promise<void> {
    const channel = this.channels.get(module);
    return channel ? channel.reply(requestId, ok, text) : Promise.resolve();
  }

  /** Takes the Architect's committed design out of its sandbox into `refs/architect/<module>`. */
  async takeDesign(module: ModuleState): Promise<{ head?: string; problem?: string }> {
    const o = this.o;
    const p = o.paths(module.architect.sandbox);
    const result = await o.exec(module.architect.sandbox, [
      `cd ${sh(p.work)} || exit 1`,
      '[ -z "$(git status --porcelain)" ] || { echo "commit everything first: uncommitted changes would be left out" >&2; exit 4; }',
      '[ "$(git rev-list --count main..HEAD)" -gt 0 ] || { echo "there is nothing committed since main" >&2; exit 4; }',
      `mkdir -p ${sh(p.out)} && git bundle create --quiet ${sh(`${p.out}/design.bundle`)} main..HEAD`,
    ].join('\n'));
    if (result.code === 4) return { problem: result.stderr.trim() };
    if (result.code !== 0) throw new Error(`could not take the design: ${(result.stderr || result.stdout).trim()}`);
    const local = join(this.localDir(module.module), 'design.bundle');
    await o.driver.download(module.architect.sandbox, `${p.out}/design.bundle`, local);
    return { head: await o.repo.fetchBundle(local, `refs/architect/${module.module}`) };
  }

  private async syncModule(module: ModuleState): Promise<void> {
    const o = this.o;
    if (module.architect.status === 'starting' || (await o.driver.status(module.architect.sandbox)) === 'missing') {
      await this.start(module);
      return;
    }
    this.attach(module);
    await this.sendNotes(module);
    if (module.submission && !this.busy.has(module.module)) await this.process(module);
    if (module.status === 'in_review' && module.design?.pr) await this.followPullRequest(module);
  }

  /** A sandbox whose main command waits for the launcher; the launcher, uploaded last, starts Claude. */
  private async start(module: ModuleState): Promise<void> {
    const o = this.o;
    const sandbox = module.architect.sandbox;
    const p = o.paths(sandbox);
    const dir = this.localDir(module.module);
    const launcher = `${p.harness}/architect/launch.sh`;
    this.channels.get(module.module)?.stop();
    this.channels.delete(module.module);
    await o.driver.remove(sandbox);
    await o.driver.create({
      name: sandbox,
      image: o.design.config.sandbox.image,
      ...o.access({ claude: true, aws: true, allBundles: true }),
      env: { ...o.sandboxEnv(), HARNESS_ROLE: 'architect', MCP_TOOL_TIMEOUT: '1900000' },
      command: ['bash', '-c', `until [ -x ${sh(launcher)} ]; do sleep 1; done; exec ${sh(launcher)}`],
      tty: true,
    });

    // A design under review goes on from its branch; anything else starts from main.
    const branch = `arch/${module.module}`;
    const reviewing = module.status === 'in_review' && (await o.repo.revParse(`refs/heads/${branch}`)) !== undefined;
    await o.repo.bundle(reviewing ? ['refs/heads/main', `refs/heads/${branch}`] : 'refs/heads/main', join(dir, 'main.bundle'));
    await o.driver.upload(sandbox, join(dir, 'main.bundle'), p.harness);
    const clone = await o.exec(sandbox, [
      `git clone --quiet --branch main ${sh(`${p.harness}/main.bundle`)} ${sh(p.work)}`,
      `cd ${sh(p.work)}`,
      reviewing ? `git checkout --quiet -b ${sh(branch)} ${sh(`origin/${branch}`)}` : `git checkout --quiet -b ${sh(branch)}`,
      `git config user.name ${sh(ARCHITECT.name)}`,
      `git config user.email ${sh(ARCHITECT.email)}`,
    ].join(' && '));
    if (clone.code !== 0) throw new Error(`could not clone main for the Architect: ${clone.stderr.trim()}`);
    // A new session in a recreated sandbox gets its proposals back; the design commits them.
    const proposals = join(o.moduleDir(module.module), 'proposals');
    for (const proposal of module.proposals) {
      const file = join(proposals, `v${proposal.version}.md`);
      if (existsSync(file)) await o.driver.upload(sandbox, file, `${p.work}/harness/modules/${module.module}/proposals`);
    }

    const staging = (name: string) => {
      const folder = join(dir, 'upload', name);
      mkdirSync(folder, { recursive: true });
      return folder;
    };
    copyFileSync(join(o.options.packageDir, 'roles', 'architect.md'), join(staging('harness'), 'architect.md'));
    writeFileSync(join(staging('harness'), 'welcome.md'), welcome(module));
    for (const file of ['architect.md', 'welcome.md']) await o.driver.upload(sandbox, join(staging('harness'), file), p.harness);
    await o.uploadAgentFiles(sandbox, 'architect', dir);
    writeFileSync(join(staging('home'), '.claude.json'), claudeJson(p.work));
    await o.driver.upload(sandbox, join(staging('home'), '.claude.json'), p.root);
    writeFileSync(join(staging('claude'), 'settings.json'), architectSettings(p.harness));
    await o.driver.upload(sandbox, join(staging('claude'), 'settings.json'), `${p.root}/.claude`);
    await o.driver.upload(sandbox, join(o.options.packageDir, 'skills', 'grill-me', 'SKILL.md'), `${p.root}/.claude/skills/grill-me`);

    const role = o.design.config.roles.architect;
    writeFileSync(join(staging('launcher'), 'launch.sh'), o.agent.architectLauncher({
      workDir: p.work,
      promptFile: `${p.harness}/architect.md`,
      mcpConfigFile: p.mcpConfig,
      welcomeFile: `${p.harness}/welcome.md`,
      sessionId: module.architect.sessionId,
      model: role.model,
      ...(role.effort ? { effort: role.effort } : {}),
    }));
    await o.driver.upload(sandbox, join(staging('launcher'), 'launch.sh'), `${p.harness}/architect`);
    const ready = await o.exec(sandbox, `chmod 0755 ${sh(launcher)}`);
    if (ready.code !== 0) throw new Error(`could not install the Architect's launcher: ${ready.stderr.trim()}`);
    o.record({ type: 'ARCHITECT_LAUNCHED', payload: { module: module.module } });
    this.attach(module);
  }

  private attach(module: ModuleState): void {
    if (this.channels.has(module.module)) return;
    const channel = this.o.channel(
      { role: 'architect', sandbox: module.architect.sandbox, module: module.module },
      join(this.localDir(module.module), `replied-${module.architect.sessionId}.txt`),
    );
    this.channels.set(module.module, channel);
  }

  /**
   * Notes go to the Architect's inbox file; its prompt hook shows them with the next
   * prompt. The dashboard types one when the owner isn't at the terminal ('architect-inbox').
   */
  private async sendNotes(module: ModuleState): Promise<void> {
    const o = this.o;
    const inbox = `${o.paths(module.architect.sandbox).harness}/architect-inbox.jsonl`;
    const unsent = module.notes.filter((n) => !n.sent);
    for (const note of unsent) {
      const line = `${JSON.stringify({ key: note.key, text: note.text, ts: new Date(o.now()).toISOString() })}\n`;
      const result = await o.exec(module.architect.sandbox, `cat >> ${sh(inbox)}`, line);
      if (result.code !== 0) throw new Error(`could not write to the Architect's inbox: ${result.stderr.trim()}`);
      o.record({ type: 'ARCHITECT_NOTE_SENT', payload: { module: module.module, key: note.key } });
    }
    if (unsent.length > 0) o.events.emit('architect-inbox', { module: module.module, sandbox: module.architect.sandbox });
  }

  private async process(module: ModuleState): Promise<void> {
    const o = this.o;
    const submission = module.submission!;
    this.busy.add(module.module);
    try {
      const outcome = await submitDesign(o, module, submission.summary, submission.head).catch((error: Error) => ({
        ok: false as const,
        problems: [`the harness failed while handling it (${error.message.split('\n')[0]}); submit again`],
      }));
      if (!outcome.ok) {
        o.record({ type: 'DESIGN_REFUSED', payload: { module: module.module, requestId: submission.requestId, problems: outcome.problems } });
        await this.reply(module.module, submission.requestId, false, `Refused:\n${outcome.problems.map((p) => `- ${p}`).join('\n')}`);
        return;
      }
      o.record({ type: 'DESIGN_SUBMITTED', payload: { module: module.module, head: outcome.head, suspect: outcome.suspect } });
      if (outcome.opened) o.record({ type: 'ARCH_PR_OPENED', payload: { module: module.module, number: outcome.pr.number, url: outcome.pr.url } });
      await this.syncBranch(module);
      const checks = outcome.suspect.length
        ? `These checks already pass on the unbuilt repository, so they may be too weak: ${outcome.suspect.join(', ')}. The PR lists them for the owner.`
        : 'Every new check failed on the unbuilt repository, as it should.';
      await this.reply(module.module, submission.requestId, true, `Arch PR #${outcome.pr.number}: ${outcome.pr.url}. ${checks} The owner reviews and merges it.`);
    } finally {
      this.busy.delete(module.module);
    }
  }

  /** The daemon's hash-list commit goes back into the Architect's branch, so its next commits build on it. */
  private async syncBranch(module: ModuleState): Promise<void> {
    const o = this.o;
    const p = o.paths(module.architect.sandbox);
    const local = join(this.localDir(module.module), 'arch.bundle');
    await o.repo.bundle(`refs/heads/arch/${module.module}`, local);
    await o.driver.upload(module.architect.sandbox, local, p.harness);
    const result = await o.exec(module.architect.sandbox, [
      `cd ${sh(p.work)}`,
      `git fetch --quiet --force ${sh(`${p.harness}/arch.bundle`)} ${sh(`refs/heads/arch/${module.module}:refs/remotes/harness/arch`)}`,
      'git merge --quiet --ff-only refs/remotes/harness/arch',
    ].join(' && '));
    if (result.code !== 0) {
      o.log(`architect of ${module.module}: its branch moved on since the submission; it needs to rebase onto refs/remotes/harness/arch`);
    }
  }

  /** Until the owner merges: CI failures go to the Architect, and a merge freezes the design. */
  private async followPullRequest(module: ModuleState): Promise<void> {
    const o = this.o;
    if (o.now() < (this.nextPoll.get(module.module) ?? 0)) return;
    this.nextPoll.set(module.module, o.now() + 60_000);
    const pr = await o.forge.pullRequest(module.design!.pr!.number);
    if (pr.merged) {
      o.record({ type: 'DESIGN_FROZEN', payload: { module: module.module, commit: pr.mergeCommit ?? '' } });
      await this.refreshClone(module);
      o.kick();
      return;
    }
    if (pr.state === 'closed') {
      o.record({ type: 'ARCH_PR_CLOSED', payload: { module: module.module } });
      return;
    }
    if (module.design!.ciNoted === pr.head) return;
    const required = requiredChecks(o.design.config);
    const latest = new Map<string, CheckRun>();
    for (const run of await o.forge.checkRuns(pr.head)) {
      if (required.includes(run.name) && run.id >= (latest.get(run.name)?.id ?? 0)) latest.set(run.name, run);
    }
    if (latest.size < required.length || [...latest.values()].some((r) => r.status !== 'completed')) return;
    const jobs: CiJob[] = [];
    for (const run of latest.values()) {
      const conclusion = run.conclusion ?? 'unknown';
      jobs.push({ name: run.name, conclusion, ...(conclusion === 'success' ? {} : { log: await o.forge.jobLog(run) }) });
    }
    o.record({ type: 'ARCH_CI_DONE', payload: { module: module.module, sha: pr.head, jobs } });
  }

  /** After the merge: the Architect's clone gets the new main, and its branch starts from it. */
  private async refreshClone(module: ModuleState): Promise<void> {
    const o = this.o;
    const p = o.paths(module.architect.sandbox);
    await o.forge.fetchMain(o.repo);
    const local = join(this.localDir(module.module), 'main.bundle');
    await o.repo.bundle('refs/heads/main', local);
    await o.driver.upload(module.architect.sandbox, local, p.harness);
    await o.exec(module.architect.sandbox, [
      `cd ${sh(p.work)}`,
      `git fetch --quiet --force ${sh(`${p.harness}/main.bundle`)} refs/heads/main:refs/heads/main`,
      `if [ -z "$(git status --porcelain)" ]; then git checkout --quiet -B ${sh(`arch/${module.module}`)} main; fi`,
    ].join(' && '));
  }

  private localDir(module: string): string {
    const dir = join(this.o.moduleDir(module), 'architect');
    mkdirSync(dir, { recursive: true });
    return dir;
  }
}

/** The first prompt of a session: a new module, or one whose sandbox was recreated without its conversation. */
function welcome(module: ModuleState): string {
  const latest = module.proposals.at(-1);
  if (!latest) {
    return clip([
      `[harness] You are the Architect of the new module "${module.module}": ${module.title}.`,
      'Read README.md, ARCHITECTURE.md and the other modules\' designs in harness/modules/ first.',
      'Then greet the owner in two lines and wait: they will tell you what this module is for. Then use the grill-me skill.',
    ].join('\n'), 2000);
  }
  const where = {
    designing: `The owner hasn't accepted proposal v${latest.version}: they may want changes.`,
    proposed: `Proposal v${latest.version} waits for the owner's decision.`,
    decomposing: `The owner accepted proposal v${module.accepted}: decompose it, and submit the design.`,
    in_review: `Your design is in Arch PR #${module.design?.pr?.number ?? '?'}, on this branch; the owner reviews it.`,
    frozen: 'Your design is merged on main, and Developers build it. The Manager may ask you questions.',
  }[module.status];
  return clip([
    `[harness] You are the Architect of the module "${module.module}": ${module.title}.`,
    'Your sandbox was recreated, and your earlier conversation is gone.',
    `Your proposals are in harness/modules/${module.module}/proposals/. ${where}`,
    'Read them, README.md and ARCHITECTURE.md, then greet the owner in two lines and wait.',
  ].join('\n'), 2000);
}
