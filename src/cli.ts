#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { computeLock, directoryReader } from './ci/harness-ci.ts';
import { isRunning, lockHolder, packageRoot, runDaemon, runningDaemon, STOP_GRACE_MS, version } from './daemon/main.ts';
import { ConfigSchema } from './design/schemas.ts';
import { applyModeRules, checkApp, ciFiles, createApp, installCi, rulesNotChanged } from './github/setup.ts';
import { configDir } from './github/app.ts';
import { askSecret, doctor, projectMode } from './setup/doctor.ts';
import { CHECKLIST, init } from './setup/init.ts';
import { recover } from './setup/recover.ts';
import { setup } from './setup/setup.ts';
import { upgrade } from './setup/upgrade.ts';
import type { Mode, State } from './state/state.ts';
import { sleep } from './util.ts';

const HELP = `harness ${version}

Usage: harness <command> [--dir <project>]

  setup [--repo <owner/name>] [--owner <login>]
                     Set up this machine and the project: every step the harness can do, asking only for
                     what is yours (a login, a token, a click on GitHub); run it again any time
  init [--repo <owner/name>] [--owner <login>]
                     Write the harness's files into this repository, and print the setup checklist
  up                 Run the daemon for the project (foreground) and open the dashboard
  down               Stop the running daemon; sandboxes keep their state
  status             Show plans, features and the pipeline
  resume             Lift a pause of the pipeline
  mode [manual|swarm]
                     Show the mode, or switch it and apply the mode's rules on main with your gh:
                     in Swarm the daemon merges plans
  budget --module <id> --owner-hours <n> | --clear
                     Set the hours of your time for one module, or clear them
  retry <m/p/f>      Grant one more attempt to an escalated feature (--note: guidance)
  module new <id> <title> [--owner-hours <n>]
                     Start a module: its Architect's sandbox and conversation, and the hours of your
                     time for it
  attach <module>    Open the Architect's terminal (detach with Ctrl-P Ctrl-Q)
  accept <module> <vN>
                     Accept the Architect's proposal vN
  actions            List the owner actions of every module
  done <module>/<id> [--note <text>]
                     Mark an owner action done (gates let the work they block start)
  message <text>     Write to the Manager of the module being built
  answer <id> <text> Answer a Manager's question (its request id is in status)
  github-app create --org <org> [--name <name>]
                     Create the harness's GitHub App from its manifest (one click on GitHub)
  github-app check --repo <owner/repo>
                     Check that the App is installed on the repository and can get a token
  install-ci [--owner <login>]
                     Write the harness workflow, its CI script and CODEOWNERS into the project
  github-setup --repo <owner/repo> [--mode manual|swarm]
                     Apply merge settings and the main ruleset of the mode (the daemon's, by default), with your own gh login
  lock               Write harness/lock.json, the hashes of every protected file and field
  doctor [--probe] [--build-images]
                     Check this machine and the project, and set up the providers;
                     --probe tries everything an agent must not do
  recover            Rebuild a lost .harness/ from git and GitHub
  upgrade [<version>]
                     Install the latest harness from npm, or the version named, build the agents' image
                     for it, and start the project's daemon again here if one was running
  version            Print the version

--dir defaults to the current directory.`;

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      dir: { type: 'string' },
      note: { type: 'string' },
      org: { type: 'string' },
      name: { type: 'string' },
      repo: { type: 'string' },
      owner: { type: 'string' },
      mode: { type: 'string' },
      'owner-hours': { type: 'string' },
      module: { type: 'string' },
      clear: { type: 'boolean' },
      probe: { type: 'boolean' },
      'build-images': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, argument] = positionals;
  const projectDir = resolve(values.dir ?? process.cwd());
  const harnessDir = join(projectDir, '.harness');
  if (!values.help && command !== undefined && command in FLAGS) {
    const stray = Object.keys(values).filter((flag) => flag !== 'dir' && !FLAGS[command]!.includes(flag));
    if (stray.length > 0) throw new Error(`${stray.map((flag) => `--${flag}`).join(', ')}: not a flag of \`harness ${command}\`. \`harness --help\` lists each command's`);
    // A folder that isn't a project would get a .harness/ of its own, or a confusing error later.
    if (PROJECT_COMMANDS.includes(command) && !existsSync(join(projectDir, 'harness', 'config.json'))) {
      throw new Error(`${projectDir} holds no harness/config.json: run the command in the project's folder, or name it with --dir. \`harness setup\` sets a project up`);
    }
  }

  switch (values.help ? 'help' : command) {
    case 'up':
      await runDaemon(projectDir);
      process.exit(0);
    case 'down':
      return void (await down(harnessDir));
    case 'status':
      return status(harnessDir);
    case 'resume':
      return void await ownerAction(harnessDir, '/api/resume', {});
    case 'mode': {
      if (!argument) {
        const file = join(harnessDir, 'state.json');
        const state = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as State) : undefined;
        const pendingFile = join(harnessDir, 'setup.json');
        const pending = existsSync(pendingFile) ? (JSON.parse(readFileSync(pendingFile, 'utf8')) as { mode?: string }).mode : undefined;
        console.log(`${state?.mode ?? 'manual'}${pending && pending !== (state?.mode ?? 'manual') ? `, and ${pending} once the daemon starts` : ''}`);
        return;
      }
      if (argument !== 'manual' && argument !== 'swarm') throw new Error('usage: harness mode [manual|swarm]');
      // GitHub's rules on main differ per mode, and only the owner's gh may change them (v3 §2.1). A running daemon
      // switches and applies them itself, as the dashboard's switch does, in the order that never leaves it merging
      // against the other mode's rules.
      const repo = projectConfig(projectDir)?.project.repo;
      if (runningDaemon(harnessDir)) {
        const result = (await ownerAction(harnessDir, '/api/mode', { mode: argument }, `already ${argument}`)) as ModeSwitch;
        for (const line of result.rules ?? []) console.log(`set: ${line}`);
        if (result.problem && repo) console.log(rulesHint(result.problem, repo, argument));
        return;
      }
      // The daemon is down, so it merges nothing: the rules change now, and the switch waits for it in .harness/setup.json (v4 §5).
      if (repo) {
        try {
          await applyRules(projectDir, repo, argument);
        } catch (error) {
          console.log(rulesHint((error as Error).message, repo, argument));
        }
      }
      recordForDaemon(harnessDir, { mode: argument });
      console.log(`${argument}: the daemon switches when it starts (harness up).`);
      return;
    }
    case 'budget': {
      const module = values.module;
      const hours = ownerHours(values['owner-hours']);
      if (!module || (hours === undefined) === (values.clear !== true)) throw new Error('usage: harness budget --module <id> --owner-hours <n>, or --module <id> --clear');
      const value = hours ?? null;
      if (runningDaemon(harnessDir)) return void (await ownerAction(harnessDir, '/api/owner-hours', { module, hours: value }, 'already so'));
      // The daemon is down: the hours wait for it in .harness/setup.json (v4 §5), beside those of other modules and the mode.
      const pending = readPending(harnessDir).ownerHours;
      recordForDaemon(harnessDir, { ownerHours: { ...(typeof pending === 'object' && pending !== null ? pending : {}), [module]: value } });
      console.log(value === null
        ? `${module}: your hours are cleared, recorded for when the daemon starts (harness up).`
        : `${value} hours of your time for ${module}: recorded for when the daemon starts (harness up).`);
      return;
    }
    case 'retry':
      if (!argument) throw new Error('usage: harness retry <module/plan/feature>');
      return void await ownerAction(harnessDir, '/api/retry', { feature: argument, note: values.note });
    case 'message':
      if (!argument) throw new Error('usage: harness message <text>');
      return void await ownerAction(harnessDir, '/api/message', { text: positionals.slice(1).join(' ') });
    case 'answer':
      if (!argument || positionals.length < 3) throw new Error('usage: harness answer <request-id> <text>');
      return void await ownerAction(harnessDir, '/api/answer', { id: argument, text: positionals.slice(2).join(' ') });
    case 'module': {
      const [, id, ...title] = positionals.slice(1);
      const hours = ownerHours(values['owner-hours']);
      if (argument !== 'new' || !id) throw new Error('usage: harness module new <id> <title> [--owner-hours <n>]');
      return void await ownerAction(harnessDir, '/api/modules', { id, title: title.join(' '), ...(hours !== undefined ? { ownerHours: hours } : {}) });
    }
    case 'attach':
      process.exitCode = await attach(harnessDir, argument);
      return;
    case 'accept': {
      const version = Number((positionals[2] ?? '').replace(/^v/, ''));
      if (!argument || !Number.isInteger(version) || version < 1) throw new Error('usage: harness accept <module> <vN>');
      return void await ownerAction(harnessDir, '/api/accept', { module: argument, version });
    }
    case 'actions':
      return listActions(harnessDir);
    case 'done': {
      const [module, action, ...rest] = (argument ?? '').split('/');
      if (!module || !action || rest.length > 0) throw new Error('usage: harness done <module>/<action> [--note <text>]');
      return void await ownerAction(harnessDir, '/api/actions/done', { module, action, note: values.note });
    }
    case 'github-app':
      return githubApp(argument, values);
    case 'install-ci': {
      const written = installCi(projectDir, packageRoot, values.owner);
      for (const path of written) console.log(`wrote ${path}`);
      // The lock hashes .github/**: one written before these files would fail CI's check of it.
      const lock = await writeLock(projectDir);
      console.log(`wrote harness/lock.json: ${lock} entries`);
      console.log(`Commit ${[...written, 'harness/lock.json'].join(', ')} and push them to main yourself: the App may not change workflows.`);
      return;
    }
    case 'github-setup': {
      if (!values.repo) throw new Error('usage: harness github-setup --repo <owner/repo> [--mode manual|swarm]');
      if (values.mode !== undefined && values.mode !== 'manual' && values.mode !== 'swarm') throw new Error('--mode is manual or swarm');
      return applyRules(projectDir, values.repo, values.mode);
    }
    case 'setup': {
      if (process.stdin.isTTY !== true) throw new Error('harness setup needs a terminal: it asks for what only you can give. `harness doctor` lists what is missing.');
      if (!(await setup({
        projectDir,
        packageDir: packageRoot,
        version,
        ...(values.repo ? { repo: values.repo } : {}),
        ...(values.owner ? { owner: values.owner } : {}),
        say: (line) => console.log(line),
        ask: (question) => ask(question),
        askSecret: (question) => askSecret(question),
        open: (url) => spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(),
        interactive: (file, args) => spawnSync(file, args, { stdio: 'inherit' }).status ?? 1,
        up: async () => {
          await runDaemon(projectDir);
          process.exit(0);
        },
      }))) process.exitCode = 1;
      return;
    }
    case 'doctor':
      return runDoctor(projectDir, values);
    case 'recover':
      for (const note of await recover({ projectDir, harnessDir })) console.log(note);
      console.log('Recovered. Start the daemon with `harness up`.');
      return;
    case 'init': {
      const result = await init({ projectDir, packageDir: packageRoot, version, ...(values.repo ? { repo: values.repo } : {}), ...(values.owner ? { owner: values.owner } : {}) });
      for (const path of result.wrote) console.log(`wrote ${path}`);
      for (const path of result.kept) console.log(`kept  ${path} (it exists)`);
      for (const note of result.notes) console.log(`\n${note}`);
      console.log(`\n${CHECKLIST}`);
      return;
    }
    case 'lock':
      console.log(`wrote harness/lock.json: ${await writeLock(projectDir)} entries`);
      return;
    case 'upgrade': {
      const cli = join(packageRoot, 'dist', 'cli.js');
      process.exitCode = await upgrade({
        version,
        packageDir: packageRoot,
        ...(argument ? { target: argument } : {}),
        project: existsSync(join(projectDir, 'harness', 'config.json')),
        say: (line) => console.log(line),
        run: attached,
        capture: async (file, args) => {
          const result = spawnSync(file, args, { encoding: 'utf8' });
          return result.status === 0 ? result.stdout : undefined;
        },
        // The package's own entry, at the path npm installs every version to: after the install, it is the new one.
        harness: (args) => attached(process.execPath, [cli, ...args, '--dir', projectDir]),
        daemon: () => (runningDaemon(harnessDir) ?? lockHolder(harnessDir))?.pid,
        stop: () => down(harnessDir),
        installed: () => {
          try {
            return (JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version?: string }).version;
          } catch {
            return undefined;
          }
        },
        // The files as the version now in packageRoot writes them; CODEOWNERS follows the owner, not the version.
        staleCi: () => ciFiles(packageRoot).filter(([path, content]) => !existsSync(join(projectDir, path)) || readFileSync(join(projectDir, path), 'utf8') !== content).map(([path]) => path),
      });
      return;
    }
    case 'version':
      console.log(version);
      return;
    case 'help':
    case undefined:
      console.log(HELP);
      return;
    default:
      console.error(`unknown command: ${command}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

/**
 * Runs a command in this terminal and gives its exit code. Ctrl-C reaches it directly,
 * as it shares the terminal, and this process waits for it to end: a daemon started here
 * stops in its own time. The other signals that stop a daemon are passed on.
 */
function attached(file: string, args: string[]): Promise<number> {
  return new Promise((done, failed) => {
    const child = spawn(file, args, { stdio: 'inherit' });
    const wait = () => {};
    const pass = (signal: NodeJS.Signals) => () => void child.kill(signal);
    const passed = { SIGTERM: pass('SIGTERM'), SIGHUP: pass('SIGHUP') };
    process.on('SIGINT', wait);
    for (const [signal, handler] of Object.entries(passed)) process.on(signal, handler);
    const end = () => {
      process.off('SIGINT', wait);
      for (const [signal, handler] of Object.entries(passed)) process.off(signal, handler);
    };
    child.on('error', (error) => {
      end();
      failed(error);
    });
    child.on('exit', (code) => {
      end();
      done(code ?? 1);
    });
  });
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** The flags of each command, besides --dir and --help: any other is refused, rather than ignored. */
const FLAGS: Record<string, string[]> = {
  setup: ['repo', 'owner'], init: ['repo', 'owner'], up: [], down: [], status: [], resume: [], mode: [], budget: ['module', 'owner-hours', 'clear'],
  retry: ['note'], module: ['owner-hours'], attach: [], accept: [], actions: [], done: ['note'], message: [], answer: [],
  'github-app': ['org', 'name', 'repo'], 'install-ci': ['owner'], 'github-setup': ['repo', 'mode'], lock: [], doctor: ['probe', 'build-images'],
  recover: [], upgrade: [], version: [], help: [],
};

/** The commands that act on a project: in a folder without harness/config.json they fail, and create nothing. */
const PROJECT_COMMANDS = ['up', 'down', 'status', 'resume', 'mode', 'budget', 'retry', 'module', 'attach', 'accept', 'actions', 'done', 'message', 'answer', 'install-ci', 'lock', 'recover'];

/** --owner-hours, a positive number, when given. */
function ownerHours(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) throw new Error(`--owner-hours ${value}: a positive number of hours`);
  return hours;
}

/** Writes harness/lock.json, the hashes of every protected file and field, and gives its count. */
async function writeLock(projectDir: string): Promise<number> {
  const lock = await computeLock(directoryReader(projectDir));
  writeFileSync(join(projectDir, 'harness', 'lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  return lock.entries.length;
}

/** What waits in .harness/setup.json for the daemon. */
function readPending(harnessDir: string): Record<string, unknown> {
  const file = join(harnessDir, 'setup.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
}

/** Records what the daemon takes from .harness/setup.json when it starts, while it is down (v4 §5). */
function recordForDaemon(harnessDir: string, values: Record<string, unknown>): void {
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(join(harnessDir, 'setup.json'), `${JSON.stringify({ ...readPending(harnessDir), ...values }, null, 2)}\n`);
}

/** The hint after rules that couldn't be applied, naming the mode: later, the daemon's mode may be the other one. */
function rulesHint(problem: string, repo: string, mode: Mode): string {
  return rulesNotChanged(problem, repo).replace(`--repo ${repo}\``, `--repo ${repo} --mode ${mode}\``);
}

/** The project's configuration, when the directory has one. */
function projectConfig(projectDir: string) {
  const configFile = join(projectDir, 'harness', 'config.json');
  return existsSync(configFile) ? ConfigSchema.parse(JSON.parse(readFileSync(configFile, 'utf8'))) : undefined;
}

/**
 * Merge settings and the ruleset of the mode on main, with the owner's own gh: the mode
 * `harness mode` recorded for the daemon, or else the daemon's, unless `mode` says otherwise (v3 §2.1).
 */
async function applyRules(projectDir: string, repo: string, mode?: Mode): Promise<void> {
  for (const line of await applyModeRules(projectConfig(projectDir), repo, mode ?? projectMode(projectDir))) console.log(`set: ${line}`);
}

/** The daemon's answer to a switch: whether the mode changed, the rules it applied on main, or why it couldn't. */
interface ModeSwitch {
  done: boolean;
  error?: string;
  rules?: string[];
  problem?: string;
}

async function githubApp(action: string | undefined, values: { org?: string; name?: string; repo?: string }): Promise<void> {
  if (action === 'create') {
    if (!values.org) throw new Error('usage: harness github-app create --org <org> [--name <name>]');
    const app = await createApp({
      org: values.org,
      name: values.name ?? `${values.org}-harness`,
      onReady: (url) => {
        console.log(`Open ${url} in your browser, review the App on GitHub, and click "Create GitHub App".`);
        spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
      },
    });
    console.log(`Created ${app.name} (id ${app.appId}). Its key is in ${join(configDir(), 'app.pem')}.`);
    console.log(`Install it on your project repository only: https://github.com/apps/${app.slug}/installations/new`);
    return;
  }
  if (action === 'check') {
    if (!values.repo) throw new Error('usage: harness github-app check --repo <owner/repo>');
    for (const line of await checkApp(values.repo)) console.log(line);
    return;
  }
  throw new Error('usage: harness github-app create|check');
}

async function runDoctor(projectDir: string, values: { probe?: boolean; 'build-images'?: boolean }): Promise<void> {
  const marks = { ok: 'ok  ', warn: 'warn', fail: 'FAIL', skip: 'skip' };
  const checks = await doctor({
    projectDir,
    packageDir: packageRoot,
    version,
    probe: values.probe === true,
    buildImages: values['build-images'] === true,
    interactive: process.stdin.isTTY === true,
    report: (check) => console.log(`${marks[check.status]}  ${check.name}: ${check.detail}${check.fix ? `\n      → ${check.fix}` : ''}`),
  });
  const failed = checks.filter((c) => c.status === 'fail').length;
  const warned = checks.filter((c) => c.status === 'warn').length;
  console.log(failed ? `${failed} problem(s) to fix${warned ? `, ${warned} warning(s)` : ''}` : `all good${warned ? `, ${warned} warning(s)` : ''}`);
  if (failed) process.exitCode = 1;
}

/**
 * Stops the daemon, or the one still starting, which holds the lock but has no daemon.json
 * yet. It waits longer than the daemon waits for its step under way, and fails when the
 * process outlives that: `harness upgrade` must not install over a daemon that still runs.
 */
async function down(harnessDir: string): Promise<boolean> {
  const info = runningDaemon(harnessDir) ?? lockHolder(harnessDir);
  if (!info) {
    console.log('no daemon is running');
    return true;
  }
  process.kill(info.pid, 'SIGTERM');
  const end = Date.now() + STOP_GRACE_MS + 5_000;
  while (isRunning(info) && Date.now() < end) await sleep(200);
  if (isRunning(info)) {
    console.error(`pid ${info.pid} is still stopping`);
    process.exitCode = 1;
    return false;
  }
  console.log('stopped');
  return true;
}

function status(harnessDir: string): void {
  const file = join(harnessDir, 'state.json');
  if (!existsSync(file)) return console.log('no state yet: run `harness up` first');
  const state = JSON.parse(readFileSync(file, 'utf8')) as State;
  const info = runningDaemon(harnessDir);
  console.log(info ? `daemon: running, http://127.0.0.1:${info.port}` : 'daemon: stopped');
  console.log(`pipeline: ${state.pipeline.paused ? `paused (${state.pipeline.paused.reason})` : 'running'}`);
  for (const [key, plan] of Object.entries(state.plans)) {
    console.log(`\n${key}  ${plan.status}  ${plan.branch} @ ${plan.head.slice(0, 8)}`);
    if (plan.pr) console.log(`  PR #${plan.pr.number} ${plan.pr.url}  CI: ${plan.ci?.status ?? 'waiting for a push'}${plan.fixRounds ? `, ${plan.fixRounds} fix round(s)` : ''}`);
    for (const feature of Object.values(state.features).filter((f) => `${f.module}/${f.plan}` === key)) {
      const last = feature.attempts.at(-1);
      const detail = last ? `attempt ${last.n}: ${[last.status, last.outcome, last.reason].filter(Boolean).join(', ')}` : '';
      console.log(`  ${feature.feature.padEnd(10)} ${feature.status.padEnd(12)} ${detail}`);
    }
  }
  for (const module of Object.values(state.modules ?? {})) {
    const latest = module.proposals.at(-1);
    console.log(`\nmodule ${module.module}  ${module.status}${latest ? `  proposals: v1–v${latest.version}${module.accepted ? `, v${module.accepted} accepted` : ''}` : ''}${module.design?.pr ? `  Arch PR #${module.design.pr.number} ${module.design.pr.url}` : ''}`);
  }
  const open = Object.values(state.ownerRequests ?? {}).filter((r) => r.answer === undefined);
  for (const request of open) {
    console.log(`\nThe Manager of ${request.module} asks${request.blocking ? ' (blocking)' : ''}, request ${request.requestId}:\n  ${request.question.replace(/\n/g, '\n  ')}`);
  }
  if (open.length > 0) console.log('\nAnswer with: harness answer <request-id> <text>');
}

/**
 * An owner action, through the running daemon. When the daemon refuses it, the command
 * fails; `unchanged` is what to say instead when it was already so, such as a mode.
 */
async function ownerAction(harnessDir: string, path: string, body: unknown, unchanged?: string): Promise<{ done: boolean; error?: string }> {
  const info = runningDaemon(harnessDir);
  if (!info) throw new Error('no daemon is running');
  const response = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`the daemon answered ${response.status}: ${(await response.text()).trim()}`);
  const result = (await response.json()) as { done: boolean; error?: string };
  if (result.done) console.log('done');
  else if (unchanged !== undefined && result.error === undefined) console.log(unchanged);
  else {
    console.error(result.error ?? 'nothing to do');
    process.exitCode = 1;
  }
  return result;
}

/**
 * The Architect's terminal, attached in this one, and openshell's exit code. Detaching
 * leaves the Architect running. A running daemon is told while the owner is attached: it
 * types nothing into a terminal the owner is using.
 */
async function attach(harnessDir: string, module: string | undefined): Promise<number> {
  if (!module) throw new Error('usage: harness attach <module>');
  const file = join(harnessDir, 'state.json');
  const state = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as State) : undefined;
  const sandbox = state?.modules?.[module]?.architect.sandbox;
  if (!sandbox) throw new Error(`no Architect for ${module}: start it with \`harness module new ${module} <title>\``);
  const tell = async (attached: boolean) => {
    const info = runningDaemon(harnessDir);
    if (!info) return;
    await fetch(`http://127.0.0.1:${info.port}/api/attach`, {
      method: 'POST',
      headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ module, attached }),
    }).then((response) => response.body?.cancel(), () => {});
  };
  console.log(`The Architect of ${module}. Detach with Ctrl-P, then Ctrl-Q; it keeps running.`);
  await tell(true);
  try {
    return await attached('openshell', ['sandbox', 'connect', sandbox]);
  } finally {
    await tell(false);
  }
}

async function listActions(harnessDir: string): Promise<void> {
  const info = runningDaemon(harnessDir);
  if (!info) throw new Error('no daemon is running');
  const response = await fetch(`http://127.0.0.1:${info.port}/api/state`, { headers: { authorization: `Bearer ${info.token}` } });
  if (!response.ok) throw new Error(`the daemon answered ${response.status}: ${(await response.text()).trim()}`);
  const { state, design } = (await response.json()) as {
    state: State;
    design: { modules: Array<{ id: string; actions: Array<{ id: string; kind: string; title: string; blocks: string[]; instructions: string }> }> };
  };
  let any = false;
  for (const module of design.modules) {
    for (const action of module.actions) {
      any = true;
      const status = state.actions[`${module.id}/${action.id}`];
      console.log(`${module.id}/${action.id}  ${action.kind}  ${status?.status ?? 'pending'}  ${action.title}${action.blocks.length ? `  (holds back ${action.blocks.join(', ')})` : ''}`);
      if (status?.reason) console.log(`  ${status.reason}`);
    }
  }
  if (!any) console.log('no owner actions');
}

main().catch((error: Error) => {
  // Offline, fetch says only "fetch failed": the cause says what failed.
  const causes: string[] = [];
  for (let cause = error.cause; cause !== undefined && cause !== null; cause = cause instanceof Error ? cause.cause : undefined) {
    causes.push(cause instanceof Error ? cause.message : String(cause));
  }
  console.error([error.message, ...causes].join(': '));
  process.exitCode = 1;
});
