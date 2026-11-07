import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDashboard } from '../dashboard/server.ts';
import { loadPty, Terminals } from '../dashboard/terminals.ts';
import { OpenShellDriver } from '../sandbox/openshell.ts';
import type { Ref } from '../state/events.ts';
import { Orchestrator } from './orchestrator.ts';

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

export function readDaemonInfo(harnessDir: string): DaemonInfo | undefined {
  const file = join(harnessDir, 'daemon.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as DaemonInfo) : undefined;
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
  for (let tries = 0; tries < 2; tries++) {
    try {
      writeFileSync(file, `${JSON.stringify(mine)}\n`, { flag: 'wx', mode: 0o600 });
      return () => rmSync(file, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let holder: { pid: number; processStart?: number } | undefined;
    try {
      holder = JSON.parse(readFileSync(file, 'utf8')) as { pid: number; processStart?: number };
    } catch {
      holder = undefined;
    }
    if (holder && isRunning(holder)) throw new Error(`a daemon is starting or running for this project (pid ${holder.pid}): see ${file}`);
    rmSync(file, { force: true });
  }
  throw new Error(`another \`harness up\` took ${file} meanwhile`);
}

/**
 * Runs the daemon in the foreground until SIGINT, SIGTERM or SIGHUP. Sandboxes keep
 * running when it stops. The caller should exit once this resolves: a step cut short may
 * still have a command running.
 */
export async function runDaemon(projectDir: string, options: { tickMs?: number } = {}): Promise<void> {
  const harnessDir = join(projectDir, '.harness');
  const running = runningDaemon(harnessDir);
  if (running) {
    throw new Error(`a daemon already runs for this project (pid ${running.pid}, http://127.0.0.1:${running.port})`);
  }
  mkdirSync(join(harnessDir, 'logs'), { recursive: true, mode: 0o700 });
  const unlock = takeDaemonLock(harnessDir);
  try {
    await serve(projectDir, harnessDir, options);
  } finally {
    unlock();
  }
}

async function serve(projectDir: string, harnessDir: string, options: { tickMs?: number }): Promise<void> {
  const logFile = join(harnessDir, 'logs', 'daemon.log');
  const log = (message: string) => {
    const line = `${new Date().toISOString()} ${message}`;
    console.log(line);
    appendFileSync(logFile, `${line}\n`);
  };
  // Once the terminal is closed, a write to it fails with EIO, which would stop the daemon mid-shutdown: the log file keeps every line.
  process.stdout.on('error', () => {});

  const orchestrator = new Orchestrator({
    projectDir,
    harnessDir,
    driver: new OpenShellDriver(),
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
  writeFileSync(join(harnessDir, 'daemon.json'), `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
  log(`dashboard: http://127.0.0.1:${port}/?token=${token}`);
  // From a terminal with a desktop, the dashboard opens by itself (§14.4).
  if (process.stdout.isTTY && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) {
    spawn('xdg-open', [`http://127.0.0.1:${port}/?code=${loginCode}`], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  }

  const timer = setInterval(() => void orchestrator.tick(), options.tickMs ?? 15_000);
  void orchestrator.tick();

  await new Promise<void>((resolve) => {
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      clearInterval(timer);
      await orchestrator.stop();
      server.close();
      rmSync(join(harnessDir, 'daemon.json'), { force: true });
      log('stopped');
      resolve();
    };
    // SIGHUP: the terminal that ran `harness up` was closed.
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, () => void shutdown());
  });
}

function refText(ref: Ref): string {
  return [ref.module, ref.plan, ref.feature].filter(Boolean).join('/') + (ref.attempt ? ` #${ref.attempt}` : '');
}
