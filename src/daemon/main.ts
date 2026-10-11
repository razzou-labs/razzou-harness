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

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs the daemon in the foreground until SIGINT or SIGTERM. Sandboxes keep running when
 * it stops. The caller should exit once this resolves: a step cut short may still have
 * a command running.
 */
export async function runDaemon(projectDir: string, options: { tickMs?: number } = {}): Promise<void> {
  const harnessDir = join(projectDir, '.harness');
  const running = readDaemonInfo(harnessDir);
  if (running && isAlive(running.pid)) {
    throw new Error(`a daemon already runs for this project (pid ${running.pid}, http://127.0.0.1:${running.port})`);
  }
  mkdirSync(join(harnessDir, 'logs'), { recursive: true, mode: 0o700 });
  const logFile = join(harnessDir, 'logs', 'daemon.log');
  const log = (message: string) => {
    const line = `${new Date().toISOString()} ${message}`;
    console.log(line);
    appendFileSync(logFile, `${line}\n`);
  };

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
  const pty = await loadPty();
  if (!pty) log('node-pty is not installed: the dashboard has no terminals, and `harness attach` still works');
  const server = await startDashboard({
    orchestrator,
    port: orchestrator.design.config.dashboard.port,
    token,
    webRoot: join(packageRoot, 'dist', 'web'),
    terminals: new Terminals(pty),
  }).catch(async (error: Error) => {
    await orchestrator.stop(0);
    throw error;
  });
  const port = (server.address() as AddressInfo).port;
  const info: DaemonInfo = { pid: process.pid, port, token, startedAt: new Date().toISOString() };
  writeFileSync(join(harnessDir, 'daemon.json'), `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
  const url = `http://127.0.0.1:${port}/?token=${token}`;
  log(`dashboard: ${url}`);
  // From a terminal with a desktop, the dashboard opens by itself (§14.4).
  if (process.stdout.isTTY && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  }

  const timer = setInterval(() => void orchestrator.tick(), options.tickMs ?? 15_000);
  void orchestrator.tick();

  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      clearInterval(timer);
      await orchestrator.stop();
      server.close();
      rmSync(join(harnessDir, 'daemon.json'), { force: true });
      log('stopped');
      resolve();
    };
    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
  });
}

function refText(ref: Ref): string {
  return [ref.module, ref.plan, ref.feature].filter(Boolean).join('/') + (ref.attempt ? ` #${ref.attempt}` : '');
}
