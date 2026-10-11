import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ExecResult, Follower, SandboxDriver, SandboxSpec, SandboxStatus } from '../../src/sandbox/driver.ts';
import { run } from '../../src/util.ts';

/** Runs each "sandbox" as a plain directory on this machine, so the orchestrator can be tested without OpenShell. */
export class LocalDriver implements SandboxDriver {
  readonly base: string;
  readonly created: SandboxSpec[] = [];
  private readonly env = new Map<string, Record<string, string>>();

  constructor(base: string) {
    this.base = base;
    mkdirSync(base, { recursive: true });
  }

  rootOf(name: string): string {
    return join(this.base, name);
  }

  async create(spec: SandboxSpec): Promise<void> {
    // OpenShell's rule: a DNS label of at most 19 characters.
    if (!/^[a-z0-9]([-a-z0-9]{0,17}[a-z0-9])?$/.test(spec.name)) throw new Error(`invalid sandbox name "${spec.name}"`);
    const root = this.rootOf(spec.name);
    mkdirSync(join(root, '.harness'), { recursive: true });
    this.env.set(spec.name, spec.env);
    this.created.push(spec);
    // A main command other than `sleep infinity` runs, detached, like a container's.
    if (spec.command && spec.command.join(' ') !== 'sleep infinity') {
      const [file, ...args] = spec.command;
      const child = spawn(file!, args, {
        cwd: root,
        env: { PATH: process.env.PATH, HOME: root, ...spec.env },
        detached: true,
        stdio: 'ignore',
      });
      writeFileSync(join(root, '.harness', 'main.pid'), String(child.pid));
      child.unref();
    }
  }

  async exec(name: string, script: string, options: { input?: string } = {}): Promise<ExecResult> {
    const root = this.rootOf(name);
    if (!existsSync(root)) return { code: 1, stdout: '', stderr: `no sandbox ${name}` };
    return run('bash', ['-c', script], {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: root, ...this.env.get(name) },
      input: options.input,
    });
  }

  follow(name: string, file: string, from: number, onLine: (line: string) => void): Follower {
    const child = spawn('tail', ['-n', `+${from}`, '-s', '0.2', '-F', file], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
        onLine(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
      }
    });
    return { stop: () => child.kill(), done: new Promise((resolve) => child.on('close', () => resolve())) };
  }

  async upload(_name: string, localFile: string, remoteDir: string): Promise<void> {
    mkdirSync(remoteDir, { recursive: true });
    copyFileSync(localFile, join(remoteDir, basename(localFile)));
  }

  async download(_name: string, remoteFile: string, localFile: string): Promise<void> {
    copyFileSync(remoteFile, localFile);
  }

  async status(name: string): Promise<SandboxStatus> {
    return existsSync(this.rootOf(name)) ? 'ready' : 'missing';
  }

  /** Removing a container ends its processes: here, every agent whose pid file is in the sandbox. */
  async remove(name: string): Promise<void> {
    const harness = join(this.rootOf(name), '.harness');
    const pidFiles = existsSync(harness)
      ? readdirSync(harness, { recursive: true, encoding: 'utf8' }).filter((f) => /(^|\/)[\w.]*pid$/.test(f)).map((f) => join(harness, f))
      : [];
    for (const file of pidFiles) {
      try {
        process.kill(-Number(readFileSync(file, 'utf8').trim()), 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    rmSync(this.rootOf(name), { recursive: true, force: true });
  }

  async removeAll(): Promise<void> {
    for (const name of readdirSync(this.base)) await this.remove(name);
  }
}
