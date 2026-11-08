import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ExecResult, Follower, GatewayStatus, SandboxDriver, SandboxInfo, SandboxSpec, SandboxStatus } from '../../src/sandbox/driver.ts';
import { splitLines } from '../../src/sandbox/openshell.ts';
import { run } from '../../src/util.ts';

/** Runs each "sandbox" as a plain directory on this machine, so the orchestrator can be tested without OpenShell. */
export class LocalDriver implements SandboxDriver {
  readonly base: string;
  readonly created: SandboxSpec[] = [];
  private readonly env = new Map<string, Record<string, string>>();
  private readonly labels = new Map<string, Record<string, string>>();

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
    this.labels.set(spec.name, spec.labels ?? {});
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
    child.stdout.setEncoding('utf8');
    // The same bound on a line as OpenShell's driver.
    child.stdout.on('data', splitLines(onLine));
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

  /** Every directory is a sandbox; one made outside `create`, by a test, has no labels. */
  async list(): Promise<SandboxInfo[]> {
    return readdirSync(this.base).map((name) => ({ name, phase: 'Ready', labels: this.labels.get(name) ?? {} }));
  }

  /** What a test wrote to the sandbox's `.harness/openshell.log`, as OpenShell would log it. */
  async logs(name: string, lines: number): Promise<string> {
    const file = join(this.rootOf(name), '.harness', 'openshell.log');
    return existsSync(file) ? readFileSync(file, 'utf8').split('\n').slice(-lines - 1).join('\n') : '';
  }

  async gateway(): Promise<GatewayStatus> {
    return { status: 'connected', version: 'local' };
  }
}
