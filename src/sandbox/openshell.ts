import { spawn } from 'node:child_process';
import { run, runOk } from '../util.ts';
import type { ExecResult, Follower, SandboxDriver, SandboxSpec, SandboxStatus } from './driver.ts';

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
    if (spec.tty) args.push('--tty');
    if (spec.command) args.push('--', ...spec.command);
    await runOk(this.bin, args);
  }

  exec(name: string, script: string, options: { input?: string; timeoutSec?: number } = {}): Promise<ExecResult> {
    const args = ['sandbox', 'exec', '-n', name, '--no-tty', '--no-login-shell'];
    if (options.timeoutSec) args.push('--timeout', String(options.timeoutSec));
    return run(this.bin, [...args, '--', 'bash', '-c', script], { input: options.input });
  }

  /**
   * A long-lived `exec` running `tail -F`. Piped input doesn't stream into an exec, but
   * output does, so every live stream from a sandbox is a file the daemon follows (spike 1).
   */
  follow(name: string, file: string, from: number, onLine: (line: string) => void): Follower {
    const child = spawn(
      this.bin,
      ['sandbox', 'exec', '-n', name, '--no-tty', '--no-login-shell', '--', 'tail', '-n', `+${from}`, '-s', '0.2', '-F', file],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
        onLine(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
      }
    });
    const done = new Promise<void>((resolve) => child.on('close', () => resolve()));
    return { stop: () => child.kill('SIGTERM'), done };
  }

  async upload(name: string, localFile: string, remoteDir: string): Promise<void> {
    await runOk(this.bin, ['sandbox', 'upload', name, localFile, remoteDir.endsWith('/') ? remoteDir : `${remoteDir}/`]);
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
}
