import { spawn, type ChildProcess } from 'node:child_process';
import { run, runOk } from '../util.ts';
import type { ExecResult, Follower, GatewayStatus, SandboxDriver, SandboxInfo, SandboxSpec, SandboxStatus } from './driver.ts';

/** Longer lines from a sandbox are dropped: an agent could otherwise grow the daemon's memory without end. */
export const MAX_FOLLOWED_LINE = 1024 * 1024;

/** Splits a stream into lines for `onLine`. A line over the limit is dropped up to its newline, and `onDrop` called instead. */
export function splitLines(onLine: (line: string) => void, onDrop: () => void = () => {}): (chunk: string) => void {
  let buffer = '';
  let dropping = false;
  return (chunk) => {
    let start = 0;
    for (let i = chunk.indexOf('\n'); i >= 0; i = chunk.indexOf('\n', start)) {
      const line = buffer + chunk.slice(start, i);
      buffer = '';
      start = i + 1;
      if (dropping || line.length > MAX_FOLLOWED_LINE) onDrop();
      else onLine(line);
      dropping = false;
    }
    if (!dropping) buffer += chunk.slice(start);
    if (buffer.length > MAX_FOLLOWED_LINE) {
      buffer = '';
      dropping = true;
    }
  };
}

/** The only code that calls the `openshell` CLI. OpenShell is young (0.1.x), so its surface stays in this file. */
export class OpenShellDriver implements SandboxDriver {
  readonly bin: string;

  constructor(bin = 'openshell') {
    this.bin = bin;
  }

  rootOf(): string {
    return '/sandbox';
  }

  async create(spec: SandboxSpec): Promise<void> {
    const args = ['sandbox', 'create', '--name', spec.name, '--from', spec.image, '--detach'];
    for (const provider of spec.providers) args.push('--provider', provider);
    if (spec.policyFile) args.push('--policy', spec.policyFile);
    for (const [key, value] of Object.entries(spec.env)) args.push('--env', `${key}=${value}`);
    for (const [key, value] of Object.entries(spec.labels ?? {})) args.push('--label', `${key}=${value}`);
    if (spec.cpu) args.push('--cpu', spec.cpu);
    if (spec.memory) args.push('--memory', spec.memory);
    if (spec.tty) args.push('--tty');
    if (spec.command) args.push('--', ...spec.command);
    await runOk(this.bin, args);
  }

  exec(name: string, script: string, options: { input?: string; timeoutSec?: number } = {}): Promise<ExecResult> {
    const args = ['sandbox', 'exec', '-n', name, '--no-tty', '--no-login-shell'];
    if (options.timeoutSec) args.push('--timeout', String(options.timeoutSec));
    // `--timeout` ends the command in the sandbox. A CLI stuck on a gateway that stopped
    // answering gets as long again, 30 s more at most, and is then killed.
    const limitSec = options.timeoutSec ? options.timeoutSec + Math.min(options.timeoutSec, 30) : 0;
    return run(this.bin, [...args, '--', 'bash', '-c', script], { input: options.input, timeout: limitSec * 1000, killSignal: 'SIGKILL' }).catch(
      (error: Error & { killed?: boolean }) => {
        if (!error.killed) throw error;
        return { code: 124, stdout: '', stderr: `openshell sandbox exec did not end within ${limitSec} s, and was killed` };
      },
    );
  }

  /**
   * A long-lived `exec` running `tail -F`. Piped input doesn't stream into an exec, but
   * output does, so every live stream from a sandbox is a file the daemon follows (spike 1).
   * An exec that ends unasked, as when the gateway restarts, starts again after the last
   * line it delivered: a second later, then twice as late each time it read nothing, a
   * minute at most.
   */
  follow(name: string, file: string, from: number, onLine: (line: string) => void): Follower {
    let next = from;
    let stopped = false;
    let backoff = 1000;
    let child: ChildProcess | undefined;
    let retry: NodeJS.Timeout | undefined;
    const { promise: done, resolve: ended } = Promise.withResolvers<void>();
    const start = () => {
      const tail = spawn(
        this.bin,
        ['sandbox', 'exec', '-n', name, '--no-tty', '--no-login-shell', '--', 'tail', '-n', `+${next}`, '-s', '0.2', '-F', file],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      child = tail;
      // A spawn that fails closes too, and is retried like any other end.
      tail.on('error', () => {});
      tail.stdout.setEncoding('utf8');
      tail.stdout.on('data', splitLines((line) => {
        next++;
        backoff = 1000;
        onLine(line);
      }, () => next++));
      tail.on('close', () => {
        child = undefined;
        if (stopped) return ended();
        retry = setTimeout(start, backoff);
        backoff = Math.min(backoff * 2, 60_000);
      });
    };
    start();
    return {
      stop: () => {
        stopped = true;
        clearTimeout(retry);
        if (child) child.kill('SIGTERM');
        else ended();
      },
      done,
    };
  }

  /**
   * Inside a Git work tree, OpenShell 0.1.7 uploads only what `.gitignore` lets through, and
   * the harness keeps the files it uploads under `.harness/`, which the project ignores:
   * without `--no-git-ignore` every upload stops. The trailing slash puts the file in the folder.
   */
  async upload(name: string, localFile: string, remoteDir: string): Promise<void> {
    await runOk(this.bin, ['sandbox', 'upload', '--no-git-ignore', name, localFile, remoteDir.endsWith('/') ? remoteDir : `${remoteDir}/`]);
  }

  async download(name: string, remoteFile: string, localFile: string): Promise<void> {
    await runOk(this.bin, ['sandbox', 'download', name, remoteFile, localFile]);
  }

  async status(name: string): Promise<SandboxStatus> {
    const result = await run(this.bin, ['sandbox', 'get', name, '--output', 'json']);
    if (result.code !== 0) return 'missing';
    const phase = (JSON.parse(result.stdout) as { phase?: string }).phase;
    if (phase === 'Ready') return 'ready';
    if (phase === 'Stopped') return 'stopped';
    return 'other';
  }

  async remove(name: string): Promise<void> {
    await run(this.bin, ['sandbox', 'delete', name]);
  }

  async list(): Promise<SandboxInfo[]> {
    const sandboxes: SandboxInfo[] = [];
    let token = '';
    // A page holds 100: a gateway that keeps answering with more pages is cut off at 20 of them.
    for (let page = 0; page < 20; page++) {
      const args = ['sandbox', 'list', '--output', 'json', ...(token ? ['--page-token', token] : [])];
      const result = await run(this.bin, args, { timeout: 30_000, killSignal: 'SIGKILL' });
      if (result.code !== 0) throw new Error(`openshell sandbox list failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
      const listed = JSON.parse(result.stdout) as { sandboxes?: unknown[]; next_page_token?: string };
      sandboxes.push(...(listed.sandboxes ?? []).map(sandboxInfo));
      token = listed.next_page_token ?? '';
      if (!token) break;
    }
    return sandboxes;
  }

  async logs(name: string, lines: number): Promise<string> {
    const result = await run(this.bin, ['logs', name, '-n', String(lines), '--source', 'sandbox', '--color', 'never'], { timeout: 30_000, killSignal: 'SIGKILL' });
    if (result.code !== 0) throw new Error(`openshell logs failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
    return result.stdout;
  }

  async providers(): Promise<string[]> {
    const names: string[] = [];
    let token = '';
    for (let page = 0; page < 20; page++) {
      const result = await run(this.bin, ['provider', 'list', '--output', 'json', ...(token ? ['--page-token', token] : [])], { timeout: 30_000, killSignal: 'SIGKILL' });
      if (result.code !== 0) throw new Error(`openshell provider list failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
      const listed = JSON.parse(result.stdout) as { providers?: Array<{ name?: unknown }>; next_page_token?: string };
      names.push(...(listed.providers ?? []).flatMap((p) => (typeof p.name === 'string' ? [p.name] : [])));
      token = listed.next_page_token ?? '';
      if (!token) break;
    }
    return names;
  }

  async gateway(): Promise<GatewayStatus> {
    const result = await run(this.bin, ['status', '--output', 'json'], { timeout: 15_000, killSignal: 'SIGKILL' }).catch((error: Error) => ({ code: 1, stdout: '', stderr: error.message }));
    if (result.code !== 0) return { status: 'unreachable', problem: (result.stderr || result.stdout).trim().slice(0, 300) || `openshell status exited with ${result.code}` };
    const status = JSON.parse(result.stdout) as { status?: string; version?: string };
    return { status: status.status ?? 'unknown', ...(status.version ? { version: status.version } : {}) };
  }
}

/** One entry of `openshell sandbox list --output json`. Its `created_at` is UTC, without the zone. */
function sandboxInfo(raw: unknown): SandboxInfo {
  const item = raw as { name?: unknown; phase?: unknown; created_at?: unknown; labels?: unknown };
  const created = typeof item.created_at === 'string' ? item.created_at : '';
  const createdAt = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(created) ? `${created.replace(' ', 'T')}Z` : created || undefined;
  const labels = item.labels && typeof item.labels === 'object' ? Object.fromEntries(Object.entries(item.labels).filter(([, v]) => typeof v === 'string')) as Record<string, string> : {};
  return { name: String(item.name ?? ''), phase: typeof item.phase === 'string' ? item.phase : 'unknown', ...(createdAt ? { createdAt } : {}), labels };
}
