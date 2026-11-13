import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { architectSettings, claudeJson } from '../agents/claude-code.ts';
import { definitionHash, loadDesign, requiredChecks } from '../design/schemas.ts';
import { ARCHITECT } from '../git/repo.ts';
import type { CheckRun } from '../github/forge.ts';
import type { CiJob } from '../state/events.ts';
import type { ModuleState } from '../state/state.ts';
import { clip, sh } from '../util.ts';
import type { AgentChannel } from './channel.ts';
import { architectRef, lockedRef, submitDesign, submitLockedChange } from './design.ts';
import type { Orchestrator } from './orchestrator.ts';
import { BUNDLE_BYTES } from './refs.ts';

/**
 * The Architects (proposal v2 §7.1, §7.5): one long-lived interactive Claude Code session
 * per module, in a sandbox whose main command is its launcher, so the owner attaches to
 * its terminal with `harness attach`. Each pass delivers its notes, processes a submitted
 * design, and follows the design's pull request until the owner merges it.
 */
export class Architects {
  private readonly o: Orchestrator;
  private readonly channels = new Map<string, AgentChannel>();
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
  async takeDesign(module: ModuleState, what: 'design' | 'locked' = 'design'): Promise<{ head?: string; problem?: string }> {
    const o = this.o;
    const p = o.paths(module.architect.sandbox);
    const result = await o.exec(module.architect.sandbox, [
      `cd ${sh(p.work)} || exit 1`,
      '[ -z "$(git status --porcelain)" ] || { echo "commit everything first: uncommitted changes would be left out" >&2; exit 4; }',
      '[ "$(git rev-list --count main..HEAD)" -gt 0 ] || { echo "there is nothing committed since main" >&2; exit 4; }',
      `mkdir -p ${sh(p.out)} && git bundle create --quiet ${sh(`${p.out}/design.bundle`)} main..HEAD || exit 1`,
      `[ "$(wc -c < ${sh(`${p.out}/design.bundle`)})" -le ${BUNDLE_BYTES} ] || { echo "what you committed since main is more than ${BUNDLE_BYTES / 1024 / 1024} MB: a design is text, and data belongs outside the repository" >&2; exit 4; }`,
    ].join('\n'));
    if (result.code === 4) return { problem: result.stderr.trim() };
    if (result.code !== 0) throw new Error(`could not take the design: ${(result.stderr || result.stdout).trim()}`);
    const local = join(this.localDir(module.module), 'design.bundle');
    await o.driver.download(module.architect.sandbox, `${p.out}/design.bundle`, local);
    return { head: await o.fetchBundle(local, what === 'locked' ? lockedRef(module.module) : architectRef(module.module)) };
  }

  private async syncModule(module: ModuleState): Promise<void> {
    const o = this.o;
    // GitHub first: what the owner merged or closed is seen whatever state the Architect's sandbox is in.
    // A change to locked files has its own PR, which doesn't hold the build (v5).
    if (module.status === 'in_review' && module.design?.pr) await this.followPullRequest(module);
    else if (!module.design && module.closedDesign?.pr) await this.followClosed(module);
    if (module.locked?.pr) await this.followLocked(module);
    if (module.architect.status !== 'starting') {
      const where = await o.driver.status(module.architect.sandbox);
      // Gone, so made again with a new conversation. Recorded first: a start cut short is taken up again.
      if (where === 'missing') o.record({ type: 'ARCHITECT_STARTING', payload: { module: module.module } });
      // What a reboot of the machine leaves: started again, its launcher resumes the conversation.
      else if (where === 'stopped') await o.driver.start(module.architect.sandbox);
    }
    if (module.architect.status === 'starting') {
      await this.start(module);
      return;
    }
    this.attach(module);
    await this.sendNotes(module);
    await o.noteTokens(`architect:${module.module}`, module.architect.sandbox);
    await this.refreshMainIfMoved(module);
    // A submitted design is checked beside the pass: its new checks run once on the unbuilt repository, which takes
    // minutes, and the build of another module must not stand still for it.
    if (module.submission) o.runBeside(`design:${module.module}`, () => this.process(module));
    if (module.lockedSubmission) o.runBeside(`locked:${module.module}`, () => this.processLocked(module));
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
    await o.uploadBundle(sandbox, join(dir, 'main.bundle'), p.harness);
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
    writeFileSync(join(staging('harness'), 'welcome.md'), welcome(module, o.state.ownerHours[module.module] !== undefined));
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
    // A digest line tells what happened to a plan, and asks for nothing: it waits in the inbox for the next prompt.
    // Announcing each would cost a turn of the Architect's model on its whole conversation, several times a plan.
    if (unsent.some((n) => !n.text.startsWith('[digest]'))) o.events.emit('architect-inbox', { module: module.module, sandbox: module.architect.sandbox });
  }

  private async process(module: ModuleState): Promise<void> {
    const o = this.o;
    const submission = module.submission!;
    {
      const outcome = await submitDesign(o, module, submission.summary, submission.head).catch((error: Error) => ({
        ok: false as const,
        problems: [`the harness failed while handling it (${error.message.split('\n')[0]}); submit again`],
      }));
      if (!outcome.ok) {
        o.record({ type: 'DESIGN_REFUSED', payload: { module: module.module, requestId: submission.requestId, problems: outcome.problems } });
        await this.reply(module.module, submission.requestId, false, `Refused:\n${outcome.problems.map((p) => `- ${p}`).join('\n')}`);
        return;
      }
      o.record({ type: 'DESIGN_SUBMITTED', payload: { module: module.module, head: outcome.head, suspect: outcome.suspect, ...(outcome.settings.length > 0 ? { settings: outcome.settings } : {}) } });
      // Also a pull request found open that the state no longer knew, as one the owner closed and opened again: without it nothing follows the design.
      if (outcome.opened || module.design?.pr?.number !== outcome.pr.number) {
        o.record({ type: 'ARCH_PR_OPENED', payload: { module: module.module, number: outcome.pr.number, url: outcome.pr.url } });
      }
      await this.syncBranch(module);
      const checks = outcome.suspect.length
        ? `These checks already pass on the unbuilt repository, so they may be too weak: ${outcome.suspect.join(', ')}. The PR lists them for the owner.`
        : 'Every new check failed on the unbuilt repository, as it should.';
      const settings = outcome.settings.length > 0 ? ` It changes ${outcome.settings.length} setting(s) of harness/config.json, which the PR lists first for the owner.` : '';
      await this.reply(module.module, submission.requestId, true, `Arch PR #${outcome.pr.number}: ${outcome.pr.url}. ${checks}${settings} The owner reviews and merges it.`);
    }
  }

  private async processLocked(module: ModuleState): Promise<void> {
    const o = this.o;
    const submission = module.lockedSubmission!;
    {
      const outcome = await submitLockedChange(o, module, submission.summary, submission.head).catch((error: Error) => ({
        ok: false as const,
        problems: [`the harness failed while handling it (${error.message.split('\n')[0]}); submit again`],
      }));
      if (!outcome.ok) {
        o.record({ type: 'LOCKED_CHANGE_REFUSED', payload: { module: module.module, requestId: submission.requestId, problems: outcome.problems } });
        await this.reply(module.module, submission.requestId, false, `Refused:\n${outcome.problems.map((p) => `- ${p}`).join('\n')}`);
        return;
      }
      o.record({ type: 'LOCKED_CHANGE_SUBMITTED', payload: { module: module.module, head: outcome.head, changes: outcome.changes } });
      if (outcome.opened || module.locked?.pr?.number !== outcome.pr.number) {
        o.record({ type: 'ARCH_PR_OPENED', payload: { module: module.module, number: outcome.pr.number, url: outcome.pr.url, locked: true } });
      }
      await this.syncBranch(module, `locked/${module.module}`);
      await this.reply(
        module.module,
        submission.requestId,
        true,
        `CHANGED_LOCKED_FILES PR #${outcome.pr.number}: ${outcome.pr.url}. It changes ${outcome.changes.map((c) => `${c.plan}/${c.feature}`).join(', ')}, and their pre-merge checks pass. The owner reviews and merges it.`,
      );
    }
  }

  /** Until the owner merges a change to locked files: CI goes to the Architect, and the merge keeps its features accepted (v5). */
  private async followLocked(module: ModuleState): Promise<void> {
    const o = this.o;
    const key = `${module.module}:locked`;
    if (o.now() < (this.nextPoll.get(key) ?? 0)) return;
    this.nextPoll.set(key, o.now() + 60_000);
    const pr = await o.forge.pullRequest(module.locked!.pr!.number);
    if (pr.merged) {
      const commit = pr.mergeCommit ?? '';
      await o.forge.fetchMain(o.repo);
      // Its features stay accepted under the definitions it gave them: nothing was rebuilt.
      const design = await loadDesign(o.repo, commit || 'refs/heads/main');
      const rehash = module.locked!.changes.flatMap((c) => {
        const feature = design.modules.find((m) => m.id === module.module)?.plans.find((p) => p.id === c.plan)?.features.find((f) => f.id === c.feature);
        return feature ? [{ feature: `${module.module}/${c.plan}/${c.feature}`, definitionHash: definitionHash(feature) }] : [];
      });
      o.record({ type: 'LOCKED_CHANGE_MERGED', payload: { module: module.module, commit, rehash } });
      // The Architect's clone gets the new main whenever its sandbox answers (`refreshMainIfMoved`).
      this.mainSent.delete(module.module);
      o.kick();
      return;
    }
    if (pr.state === 'closed') {
      o.record({ type: 'ARCH_PR_CLOSED', payload: { module: module.module, locked: true } });
      return;
    }
    await o.markUnreviewed(pr.head, 'a CHANGED_LOCKED_FILES PR, which the owner reviews and merges');
    if (module.locked!.ciNoted === pr.head) return;
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
    o.record({ type: 'ARCH_CI_DONE', payload: { module: module.module, sha: pr.head, jobs, locked: true } });
  }

  /** The main last given to each Architect's clone. */
  private readonly mainSent = new Map<string, string>();

  /**
   * Main as it moves, plans merged and locked changes too, reaches the Architect's clone,
   * whose branches stay as they are: a branch it starts from main holds the built work (v5).
   */
  private async refreshMainIfMoved(module: ModuleState): Promise<void> {
    if (module.architect.status !== 'running') return;
    const main = await this.o.repo.revParse('refs/heads/main');
    if (!main || this.mainSent.get(module.module) === main) return;
    await this.refreshMain(module);
    this.mainSent.set(module.module, main);
  }

  /**
   * After a locked change merges: the Architect's clone gets the new main, and its branches
   * stay as they are. A `main` it has checked out is left alone, which git refuses to move
   * under a working tree; the next move of main tries again.
   */
  private async refreshMain(module: ModuleState): Promise<void> {
    const o = this.o;
    const p = o.paths(module.architect.sandbox);
    const local = join(this.localDir(module.module), 'main.bundle');
    await o.repo.bundle('refs/heads/main', local);
    await o.uploadBundle(module.architect.sandbox, local, p.harness);
    await o.exec(module.architect.sandbox, `cd ${sh(p.work)} && git fetch --quiet --force ${sh(`${p.harness}/main.bundle`)} refs/heads/main:refs/heads/main`);
  }

  /**
   * The daemon's hash-list commit goes back into the Architect's branch, so its next
   * commits build on it: `arch/<module>` for a design, `locked/<module>` for a change to
   * locked files, whose branch the Architect submitted from.
   */
  private async syncBranch(module: ModuleState, branch = `arch/${module.module}`): Promise<void> {
    const o = this.o;
    const p = o.paths(module.architect.sandbox);
    const local = join(this.localDir(module.module), 'arch.bundle');
    await o.repo.bundle(`refs/heads/${branch}`, local);
    await o.uploadBundle(module.architect.sandbox, local, p.harness);
    const result = await o.exec(module.architect.sandbox, [
      `cd ${sh(p.work)}`,
      `git fetch --quiet --force ${sh(`${p.harness}/arch.bundle`)} ${sh(`refs/heads/${branch}:refs/remotes/harness/arch`)}`,
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
      // The merge is recorded whatever the sandbox does: a clone that can't be refreshed now only keeps its old branch.
      await this.refreshClone(module).catch((error: Error) => o.log(`architect of ${module.module}: its clone was not refreshed after the merge: ${error.message}`));
      o.kick();
      return;
    }
    if (pr.state === 'closed') {
      o.record({ type: 'ARCH_PR_CLOSED', payload: { module: module.module } });
      return;
    }
    // In Swarm, main's rules require the reviewers' statuses: an Arch PR, which the owner reviews, gets them as "not reviewed".
    await o.markUnreviewed(pr.head, 'an Arch PR, which the owner reviews and merges');
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

  /**
   * A pull request the owner closed may be opened again, and merged after that: looked at
   * every five minutes, it is taken up as the design under review again. Without this the
   * module stayed where the close left it, and a merge was never seen.
   */
  private async followClosed(module: ModuleState): Promise<void> {
    const o = this.o;
    const key = `${module.module}:closed`;
    if (o.now() < (this.nextPoll.get(key) ?? 0)) return;
    this.nextPoll.set(key, o.now() + 5 * 60_000);
    const closed = module.closedDesign!;
    const pr = await o.forge.pullRequest(closed.pr!.number);
    if (pr.state !== 'open' && !pr.merged) return;
    o.record({ type: 'DESIGN_SUBMITTED', payload: { module: module.module, head: closed.head, suspect: closed.suspect, summary: closed.summary, ...(closed.settings ? { settings: closed.settings } : {}) } });
    o.record({ type: 'ARCH_PR_OPENED', payload: { module: module.module, number: closed.pr!.number, url: closed.pr!.url } });
    this.nextPoll.delete(module.module);
    o.kick();
  }

  /** After the merge: the Architect's clone gets the new main, and its branch starts from it. */
  private async refreshClone(module: ModuleState): Promise<void> {
    const o = this.o;
    const p = o.paths(module.architect.sandbox);
    await o.forge.fetchMain(o.repo);
    const local = join(this.localDir(module.module), 'main.bundle');
    await o.repo.bundle('refs/heads/main', local);
    await o.uploadBundle(module.architect.sandbox, local, p.harness);
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
function welcome(module: ModuleState, budgeted: boolean): string {
  const latest = module.proposals.at(-1);
  // The owner's time is budgeted: the Architect designs owner actions within it (v3 §4.1).
  const budget = budgeted ? ['The owner set the hours of their time this module may take: call get_owner_time before you propose, and estimate every owner action.'] : [];
  if (!latest) {
    return clip([
      `[harness] You are the Architect of the new module "${module.module}": ${module.title}.`,
      'Read README.md, ARCHITECTURE.md and the other modules\' designs in harness/modules/ first.',
      'Then greet the owner in two lines and wait: they will tell you what this module is for. Then use the grill-me skill.',
      ...budget,
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
    ...budget,
  ].join('\n'), 2000);
}
