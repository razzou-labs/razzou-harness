import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDashboard } from '../dashboard/server.ts';
import { loadPty, Terminals } from '../dashboard/terminals.ts';
import { ConfigSchema } from '../design/schemas.ts';
import type { SandboxDriver } from '../sandbox/driver.ts';
import { OpenShellDriver } from '../sandbox/openshell.ts';
import type { Ref } from '../state/events.ts';
import { run } from '../util.ts';
import { Orchestrator, type OrchestratorOptions } from './orchestrator.ts';

export interface DaemonInfo {
  pid: number;
  /** When the process started, in clock ticks after boot: after a crash or a reboot, its pid may be another process's. */
  processStart?: number;
  port: number;
  token: string;
  startedAt: string;
}

export const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
export const version = (JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version: string }).version;

/** How long the daemon waits for the step under way when it stops; `harness down` waits a little longer. */
export const STOP_GRACE_MS = 10_000;

/**
 * daemon.json, or undefined when there is none. One that can't be read, as after a power
 * cut, counts as no daemon: every command would fail on it otherwise.
 */
export function readDaemonInfo(harnessDir: string): DaemonInfo | undefined {
  const file = join(harnessDir, 'daemon.json');
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as DaemonInfo;
  } catch (error) {
    console.error(`${file} can't be read (${(error as Error).message}): counted as no daemon`);
    return undefined;
  }
}

/** The process that holds `.harness/daemon.lock`, while it runs: a daemon that is starting has no daemon.json yet. */
export function lockHolder(harnessDir: string): { pid: number; processStart?: number } | undefined {
  try {
    const holder = JSON.parse(readFileSync(join(harnessDir, 'daemon.lock'), 'utf8')) as { pid: number; processStart?: number };
    return isRunning(holder) ? holder : undefined;
  } catch {
    return undefined;
  }
}

/** Writes a file whole or not at all: a reader never sees it half written. */
function writeWhole(file: string, content: string): void {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, file);
}

/** The daemon that daemon.json names, while it runs. */
export function runningDaemon(harnessDir: string): DaemonInfo | undefined {
  const info = readDaemonInfo(harnessDir);
  return info && isRunning(info) ? info : undefined;
}

/** Whether a recorded process still runs: its pid is alive, and started when the record says. */
export function isRunning(recorded: { pid: number; processStart?: number }): boolean {
  // A daemon.json from before start times were recorded has the pid alone.
  if (recorded.processStart === undefined) return isAlive(recorded.pid);
  return processStart(recorded.pid) === recorded.processStart;
}

/** A process's start time, in clock ticks after boot (field 22 of /proc/<pid>/stat), or undefined when it doesn't run. */
export function processStart(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Field 2, the command's name, is in parentheses and may hold spaces: the fields after it count from its end.
    const start = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
    return Number.isInteger(start) ? start : undefined;
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Takes `.harness/daemon.lock` for this process, or throws while another daemon holds
 * it: daemon.json is written only once the orchestrator has started, and two daemons
 * would both write the event log. A lock whose process is gone is taken over.
 */
export function takeDaemonLock(harnessDir: string): () => void {
  const file = join(harnessDir, 'daemon.lock');
  const mine = { pid: process.pid, processStart: processStart(process.pid) };
  // The lock is written whole beside it, then linked into place, which fails while a lock exists: a second
  // `harness up` never reads a lock still empty, which it would take for a lost one.
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(mine)}\n`, { mode: 0o600 });
  try {
    for (let tries = 0; tries < 2; tries++) {
      try {
        linkSync(temporary, file);
        return () => rmSync(file, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const holder = lockHolder(harnessDir);
      if (holder) throw new Error(`a daemon is starting or running for this project (pid ${holder.pid}): see ${file}`);
      rmSync(file, { force: true });
    }
  } finally {
    rmSync(temporary, { force: true });
  }
  throw new Error(`another \`harness up\` took ${file} meanwhile`);
}

/**
 * Runs the daemon in the foreground until SIGINT, SIGTERM or SIGHUP. Sandboxes keep
 * running when it stops. The caller should exit once this resolves: a step cut short may
 * still have a command running.
 */
export async function runDaemon(projectDir: string, options: DaemonOptions = {}): Promise<void> {
  const harnessDir = join(projectDir, '.harness');
  const running = runningDaemon(harnessDir);
  if (running) {
    throw new Error(`a daemon already runs for this project (pid ${running.pid}, http://127.0.0.1:${running.port})`);
  }
  await refuseLostState(projectDir, harnessDir);
  refuseLocal(projectDir);
  mkdirSync(join(harnessDir, 'logs'), { recursive: true, mode: 0o700 });
  const unlock = takeDaemonLock(harnessDir);
  try {
    await serve(projectDir, harnessDir, options);
  } finally {
    unlock();
  }
}

export interface DaemonOptions {
  tickMs?: number;
  /** Stand-ins for OpenShell and GitHub, in tests. */
  driver?: SandboxDriver;
  forge?: OrchestratorOptions['forge'];
}

/**
 * A new event log on a project whose main already has accepted features means that
 * `.harness/` was lost: started on it, the daemon would build the first plan again.
 */
async function refuseLostState(projectDir: string, harnessDir: string): Promise<void> {
  const events = join(harnessDir, 'events.jsonl');
  if (existsSync(events) && statSync(events).size > 0) return;
  const progress = await run('git', ['-C', projectDir, 'show', 'refs/heads/main:progress.txt']);
  if (progress.code === 0 && / feature\.accepted \S+/.test(progress.stdout)) {
    throw new Error("main's progress.txt has accepted features, but .harness/ has no event log: it was lost. `harness recover` rebuilds it from git and GitHub; run `harness up` after it.");
  }
}

/** Without a repository, plans never reach main: the harness needs one on GitHub. */
function refuseLocal(projectDir: string): void {
  const config = ConfigSchema.parse(JSON.parse(readFileSync(join(projectDir, 'harness', 'config.json'), 'utf8')));
  if (!config.project.repo) {
    throw new Error('harness/config.json has no project.repo: the harness needs a GitHub repository, where each plan reaches main through a pull request. `harness setup` creates one, and sets project.repo and project.bot');
  }
}

/**
 * Keeps the daemon running past an error that nothing caught, and writes its stack to the
 * log: every step reads the state again, so going on is safer than leaving the agents under
 * way with nobody following them.
 */
export function survive(log: (message: string) => void): void {
  const write = (kind: string) => (error: unknown) => log(`${kind}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.on('uncaughtException', write('uncaught exception'));
  process.on('unhandledRejection', write('unhandled rejection'));
}

/**
 * Calls `stop` on the first SIGINT, SIGTERM or SIGHUP, and resolves once it is done. The
 * handlers stay: a terminal that closes sends SIGHUP twice, from the shell and from the
 * kernel, and under Node's default action the second would kill the process mid-shutdown.
 */
export function untilStopped(stop: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      stop().then(resolve, reject);
    };
    // SIGHUP: the terminal that ran `harness up` was closed.
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, shutdown);
  });
}

async function serve(projectDir: string, harnessDir: string, options: DaemonOptions): Promise<void> {
  const logFile = join(harnessDir, 'logs', 'daemon.log');
  const log = (message: string) => {
    const line = `${new Date().toISOString()} ${message}`;
    console.log(line);
    appendFileSync(logFile, `${line}\n`);
  };
  // Once the terminal is closed, a write to it fails with EIO, which would stop the daemon mid-shutdown: the log file keeps every line.
  process.stdout.on('error', () => {});
  survive(log);

  const orchestrator = new Orchestrator({
    projectDir,
    harnessDir,
    driver: options.driver ?? new OpenShellDriver(),
    ...(options.forge ? { forge: options.forge } : {}),
    packageDir: packageRoot,
    version,
    log,
  });
  orchestrator.events.on('event', (event: { type: string; ref?: Ref; from?: string; to?: string }) => {
    const route = event.from ? ` (${event.from}${event.to ? ` → ${event.to}` : ''})` : '';
    log(`${event.type}${event.ref ? ` ${refText(event.ref)}` : ''}${route}`);
  });
  await orchestrator.start();

  const token = randomBytes(16).toString('hex');
  // The browser gets a code that logs in once, shortly after the start: the token would show on xdg-open's command line, to any local user.
  const loginCode = randomBytes(16).toString('hex');
  const pty = await loadPty();
  if (!pty) log('node-pty is not installed: the dashboard has no terminals, and `harness attach` still works');
  const server = await startDashboard({
    orchestrator,
    port: orchestrator.design.config.dashboard.port,
    token,
    loginCode,
    webRoot: join(packageRoot, 'dist', 'web'),
    terminals: new Terminals(pty),
  }).catch(async (error: Error) => {
    await orchestrator.stop(0);
    throw error;
  });
  const port = (server.address() as AddressInfo).port;
  const info: DaemonInfo = { pid: process.pid, processStart: processStart(process.pid), port, token, startedAt: new Date().toISOString() };
  writeWhole(join(harnessDir, 'daemon.json'), `${JSON.stringify(info, null, 2)}\n`);
  log(`dashboard: http://127.0.0.1:${port}`);
  // The link holds the token, which no file but daemon.json may keep: only the terminal shows it.
  console.log(`dashboard, logged in: http://127.0.0.1:${port}/?token=${token}`);
  // From a terminal with a desktop, the dashboard opens by itself (§14.4).
  if (process.stdout.isTTY && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) {
    spawn('xdg-open', [`http://127.0.0.1:${port}/?code=${loginCode}`], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  }

  const timer = setInterval(() => void orchestrator.tick(), options.tickMs ?? 15_000);
  void orchestrator.tick();

  await untilStopped(async () => {
    clearInterval(timer);
    await orchestrator.stop(STOP_GRACE_MS);
    server.close();
    rmSync(join(harnessDir, 'daemon.json'), { force: true });
    log('stopped');
  });
}

function refText(ref: Ref): string {
  return [ref.module, ref.plan, ref.feature].filter(Boolean).join('/') + (ref.attempt ? ` #${ref.attempt}` : '');
}
