#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { computeLock, directoryReader } from './ci/harness-ci.ts';
import { isRunning, packageRoot, runDaemon, runningDaemon, version } from './daemon/main.ts';
import { ConfigSchema, requiredChecks } from './design/schemas.ts';
import { loadAppCredentials } from './github/app.ts';
import { applyRepositoryRules, checkApp, createApp, installCi, type RulesetOptions } from './github/setup.ts';
import { doctor } from './setup/doctor.ts';
import { CHECKLIST, init } from './setup/init.ts';
import { recover } from './setup/recover.ts';
import { setup } from './setup/setup.ts';
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
                     in Swarm the daemon merges plans (docs/architecture/proposal-v3.md)
  budget --owner-hours <n> | --agent-hours <n>
                     Set the hours of your time for the whole project, or the agent-hours threshold
  retry <m/p/f>      Grant one more attempt to an escalated feature (--note: guidance)
  module new <id> <title>
                     Start a module: its Architect's sandbox and conversation
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
      'agent-hours': { type: 'string' },
      probe: { type: 'boolean' },
      'build-images': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, argument] = positionals;
  const projectDir = resolve(values.dir ?? process.cwd());
  const harnessDir = join(projectDir, '.harness');

  switch (values.help ? 'help' : command) {
    case 'up':
      await runDaemon(projectDir);
      process.exit(0);
    case 'down':
      return down(harnessDir);
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
      const running = runningDaemon(harnessDir) !== undefined;
      if (running && (await ownerAction(harnessDir, '/api/mode', { mode: argument }, `already ${argument}`)).error) return;
      // GitHub's rules on main differ per mode, and only the owner's gh may change them (v3 §2.1): done here, in the same command.
      const repo = projectConfig(projectDir)?.project.repo;
      if (repo) {
        try {
          await applyRules(projectDir, harnessDir, repo, argument);
        } catch (error) {
          console.log(`GitHub's rules on main were not changed: ${(error as Error).message}\nRun \`harness github-setup --repo ${repo}\` with gh logged in as an admin of the repository.`);
        }
      }
      if (!running) {
        // The daemon is down: the switch waits for it in .harness/setup.json (v4 §5).
        recordForDaemon(harnessDir, { mode: argument });
        console.log(`${argument}: the daemon switches when it starts (harness up).`);
      }
      return;
    }
    case 'budget': {
      const hours = (key: 'owner-hours' | 'agent-hours') => (values[key] === undefined ? undefined : Number(values[key]));
      const budgets = { ownerHours: hours('owner-hours'), agentHours: hours('agent-hours') };
      if ((budgets.ownerHours === undefined && budgets.agentHours === undefined) || [budgets.ownerHours, budgets.agentHours].some((h) => h !== undefined && (!Number.isFinite(h) || h <= 0))) {
        throw new Error('usage: harness budget --owner-hours <n> | --agent-hours <n>, with positive numbers');
      }
      if (runningDaemon(harnessDir)) return void (await ownerAction(harnessDir, '/api/budgets', budgets, 'already set'));
      // The daemon is down: the hours wait for it in .harness/setup.json (v4 §5), and replace any it has, as they would if it ran.
      if (budgets.agentHours !== undefined) throw new Error('the agent-hours threshold needs the daemon running: `harness up`');
      recordForDaemon(harnessDir, { ownerHours: budgets.ownerHours, ownerHoursFrom: 'budget' });
      console.log(`${budgets.ownerHours} hours of your time: the daemon records it when it starts (harness up).`);
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
      if (argument !== 'new' || !id) throw new Error('usage: harness module new <id> <title>');
      return void await ownerAction(harnessDir, '/api/modules', { id, title: title.join(' ') });
    }
    case 'attach':
      return attach(harnessDir, argument);
    case 'accept': {
      const version = Number((positionals[2] ?? '').replace(/^v/, ''));
      if (!argument || !Number.isInteger(version) || version < 1) throw new Error('usage: harness accept <module> <vN>');
      return void await ownerAction(harnessDir, '/api/accept', { module: argument, version });
    }
    case 'actions':
      return listActions(harnessDir);
    case 'done': {
      const [module, action] = (argument ?? '').split('/');
      if (!module || !action) throw new Error('usage: harness done <module>/<action> [--note <text>]');
      return void await ownerAction(harnessDir, '/api/actions/done', { module, action, note: values.note });
    }
    case 'github-app':
      return githubApp(argument, values);
    case 'install-ci': {
      for (const path of installCi(projectDir, packageRoot, values.owner)) console.log(`wrote ${path}`);
      console.log('Commit and push these yourself: the App may not change workflows.');
      return;
    }
    case 'github-setup': {
      if (!values.repo) throw new Error('usage: harness github-setup --repo <owner/repo> [--mode manual|swarm]');
      if (values.mode !== undefined && values.mode !== 'manual' && values.mode !== 'swarm') throw new Error('--mode is manual or swarm');
      return applyRules(projectDir, harnessDir, values.repo, values.mode);
    }
    case 'setup': {
      if (process.stdin.isTTY !== true) throw new Error('harness setup needs a terminal: it asks for what only you can give. `harness doctor` lists what is missing.');
      return setup({
        projectDir,
        packageDir: packageRoot,
        version,
        ...(values.repo ? { repo: values.repo } : {}),
        ...(values.owner ? { owner: values.owner } : {}),
        say: (line) => console.log(line),
        ask: (question) => ask(question),
        open: (url) => spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(),
        interactive: (file, args) => spawnSync(file, args, { stdio: 'inherit' }).status ?? 1,
        up: async () => {
          await runDaemon(projectDir);
          process.exit(0);
        },
      });
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
    case 'lock': {
      const lock = await computeLock(directoryReader(projectDir));
      writeFileSync(join(projectDir, 'harness', 'lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
      console.log(`wrote harness/lock.json: ${lock.entries.length} entries`);
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

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Records what the daemon takes from .harness/setup.json when it starts, while it is down (v4 §5). */
function recordForDaemon(harnessDir: string, values: Record<string, unknown>): void {
  const file = join(harnessDir, 'setup.json');
  const pending = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...pending, ...values }, null, 2)}\n`);
}

/** The project's configuration, when the directory has one. */
function projectConfig(projectDir: string) {
  const configFile = join(projectDir, 'harness', 'config.json');
  return existsSync(configFile) ? ConfigSchema.parse(JSON.parse(readFileSync(configFile, 'utf8'))) : undefined;
}

/** Merge settings and the ruleset of the mode on main, with the owner's own gh: the daemon's mode, unless `mode` says otherwise (v3 §2.1). */
async function applyRules(projectDir: string, harnessDir: string, repo: string, mode?: Mode): Promise<void> {
  const config = projectConfig(projectDir);
  const required = config ? requiredChecks(config) : ['verify', 'checks'];
  const stateFile = join(harnessDir, 'state.json');
  const snapshot = existsSync(stateFile) ? (JSON.parse(readFileSync(stateFile, 'utf8')) as State) : undefined;
  const effective = mode ?? snapshot?.mode ?? 'manual';
  let options: RulesetOptions = { mode: effective };
  if (effective === 'swarm') {
    const statuses = (config?.swarm ?? ConfigSchema.shape.swarm.parse(undefined)).requiredStatuses;
    let appId: number | undefined;
    try {
      appId = loadAppCredentials().appId;
    } catch {
      appId = undefined;
    }
    options = { mode: effective, statuses, ...(appId !== undefined ? { appId } : {}) };
  }
  for (const line of await applyRepositoryRules(repo, required, options)) console.log(`set: ${line}`);
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
    console.log(`Created ${app.name} (id ${app.appId}). Its key is in ~/.config/harness/app.pem.`);
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

async function down(harnessDir: string): Promise<void> {
  const info = runningDaemon(harnessDir);
  if (!info) return console.log('no daemon is running');
  process.kill(info.pid, 'SIGTERM');
  for (let i = 0; i < 50 && isRunning(info); i++) await sleep(200);
  console.log(isRunning(info) ? `pid ${info.pid} is still stopping` : 'stopped');
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

/** The Architect's terminal, attached in this one. Detaching leaves the Architect running. */
function attach(harnessDir: string, module: string | undefined): void {
  if (!module) throw new Error('usage: harness attach <module>');
  const file = join(harnessDir, 'state.json');
  const state = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as State) : undefined;
  const sandbox = state?.modules?.[module]?.architect.sandbox;
  if (!sandbox) throw new Error(`no Architect for ${module}: start it with \`harness module new ${module} <title>\``);
  console.log(`The Architect of ${module}. Detach with Ctrl-P, then Ctrl-Q; it keeps running.`);
  spawnSync('openshell', ['sandbox', 'connect', sandbox], { stdio: 'inherit' });
}

async function listActions(harnessDir: string): Promise<void> {
  const info = runningDaemon(harnessDir);
  if (!info) throw new Error('no daemon is running');
  const response = await fetch(`http://127.0.0.1:${info.port}/api/state`, { headers: { authorization: `Bearer ${info.token}` } });
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
  console.error(error.message);
  process.exitCode = 1;
});
