import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { computeLock, directoryReader } from '../src/ci/harness-ci.ts';
import { processStart, runningDaemon, STOP_GRACE_MS, takeDaemonLock } from '../src/daemon/main.ts';
import { run } from '../src/util.ts';
import { tempDir } from './helpers/toy-repo.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
// The CLI runs as the owner would, with a configuration folder of its own.
const env = { ...process.env, XDG_CONFIG_HOME: tempDir('xdg') };
const harness = (dir: string, ...args: string[]) => run(process.execPath, [CLI, ...args, '--dir', dir], { env });

/** A project folder: its config, and an empty .harness/. */
function projectDir(): string {
  const dir = tempDir('project');
  mkdirSync(join(dir, 'harness'));
  writeFileSync(join(dir, 'harness', 'config.json'), JSON.stringify({ harnessVersion: '0.1.0', project: { name: 'shop', repo: 'acme/shop', bot: 'acme-harness[bot]' } }));
  mkdirSync(join(dir, '.harness'));
  return dir;
}

/** A project folder whose daemon.json names `pid`, started at `start`, listening on `port`. */
function daemonJson(info: { pid: number; processStart?: number; port?: number }): string {
  const dir = projectDir();
  writeFileSync(join(dir, '.harness', 'daemon.json'), JSON.stringify({ port: 1, token: 'cafe', startedAt: '2026-11-07T00:00:00.000Z', ...info }));
  return dir;
}

/** A daemon's API, for the CLI: what it was sent, by path, and the answers it gives. */
async function fakeDaemon(answers: Record<string, { status?: number; body: string }>) {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += String(chunk))).on('end', () => {
      calls.push(`${req.url} ${body}`);
      const answer = answers[req.url ?? ''] ?? { status: 404, body: 'not found' };
      res.writeHead(answer.status ?? 200, { 'content-type': answer.status ? 'text/plain' : 'application/json' }).end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = daemonJson({ pid: process.pid, processStart: processStart(process.pid)!, port: (server.address() as AddressInfo).port });
  return { dir, calls, close: () => server.close() };
}

describe('a daemon counts as running only while its own process does', () => {
  const start = processStart(process.pid)!;

  it('reads a process\'s start time, and none once the process is gone', async () => {
    assert.ok(Number.isInteger(start) && start > 0);
    const child = spawn('true');
    await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(processStart(child.pid!), undefined);
  });

  it('tells the daemon of daemon.json from a process that took its pid since', () => {
    const harnessDir = (info: { pid: number; processStart?: number }) => join(daemonJson(info), '.harness');
    assert.equal(runningDaemon(harnessDir({ pid: process.pid, processStart: start }))?.pid, process.pid);
    assert.equal(runningDaemon(harnessDir({ pid: process.pid, processStart: start - 1 })), undefined, 'the pid is alive, but not the daemon');
    assert.equal(runningDaemon(harnessDir({ pid: process.pid }))?.pid, process.pid, 'a daemon.json from before start times: the pid alone');
  });

  it('lets one daemon start at a time, and takes over the lock of one that is gone', () => {
    const dir = tempDir('harness');
    const unlock = takeDaemonLock(dir);
    assert.throws(() => takeDaemonLock(dir), /a daemon is starting or running for this project \(pid \d+\)/);
    unlock();
    assert.equal(existsSync(join(dir, 'daemon.lock')), false);
    writeFileSync(join(dir, 'daemon.lock'), JSON.stringify({ pid: process.pid, processStart: start - 1 }));
    const again = takeDaemonLock(dir);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'daemon.lock'), 'utf8')), { pid: process.pid, processStart: start });
    again();
  });

  it('`harness down` leaves alone a process that took a dead daemon\'s pid', async () => {
    const other = spawn('sleep', ['30'], { stdio: 'ignore' });
    await new Promise((resolve) => other.once('spawn', resolve));
    try {
      const dir = daemonJson({ pid: other.pid!, processStart: processStart(other.pid!)! + 1 });
      const down = await harness(dir, 'down');
      assert.equal(down.stdout.trim(), 'no daemon is running');
      assert.equal(other.exitCode, null);
      assert.notEqual(processStart(other.pid!), undefined, 'still running');
    } finally {
      other.kill();
    }
  });

  it('`harness down` stops a daemon still starting, and waits past the daemon\'s own grace', async () => {
    // A daemon that holds the lock, has no daemon.json yet, and takes longer than STOP_GRACE_MS to stop.
    const starting = spawn('sh', ['-c', `trap 'sleep ${STOP_GRACE_MS / 1000 + 2}; exit 0' TERM; while :; do sleep 1; done`], { stdio: 'ignore' });
    await new Promise((resolve) => starting.once('spawn', resolve));
    try {
      const dir = projectDir();
      writeFileSync(join(dir, '.harness', 'daemon.lock'), JSON.stringify({ pid: starting.pid, processStart: processStart(starting.pid!) }));
      const down = await harness(dir, 'down');
      assert.deepEqual([down.code, down.stdout.trim()], [0, 'stopped'], down.stderr);
    } finally {
      starting.kill('SIGKILL');
    }
  });

  it('counts a daemon.json that can\'t be read as no daemon, and says so', async () => {
    const dir = projectDir();
    writeFileSync(join(dir, '.harness', 'daemon.json'), '');
    const down = await harness(dir, 'down');
    assert.deepEqual([down.code, down.stdout.trim()], [0, 'no daemon is running']);
    assert.match(down.stderr, /daemon\.json can't be read \(Unexpected end of JSON input\): counted as no daemon/);
  });
});

describe('the CLI', () => {
  it('fails on an unknown command, with the help on stderr', async () => {
    const dir = tempDir('project');
    const unknown = await harness(dir, 'frobnicate');
    assert.equal(unknown.code, 1);
    assert.equal(unknown.stdout, '');
    assert.match(unknown.stderr, /^unknown command: frobnicate\n\nharness \d+\.\d+\.\d+\n\nUsage: harness <command>/);
    const help = await harness(dir, '--help');
    assert.equal(help.code, 0);
    assert.match(help.stdout, /Usage: harness <command>/);
  });

  it('fails when the daemon refuses an owner action, and not when the mode was already so', async () => {
    const answers: Record<string, { status?: number; body: string }> = {
      '/api/resume': { body: JSON.stringify({ done: false, error: 'the pipeline is not paused' }) },
      '/api/actions/done': { body: JSON.stringify({ done: true }) },
      '/api/accept': { body: JSON.stringify({ done: false }) },
      '/api/mode': { body: JSON.stringify({ done: false }) },
      '/api/answer': { status: 500, body: 'boom' },
    };
    const server = createServer((req, res) => {
      req.resume().on('end', () => {
        const answer = answers[req.url ?? ''] ?? { status: 404, body: 'not found' };
        res.writeHead(answer.status ?? 200, { 'content-type': answer.status ? 'text/plain' : 'application/json' }).end(answer.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      // The daemon is this process, as far as the CLI can tell.
      const dir = daemonJson({ pid: process.pid, processStart: processStart(process.pid)!, port: (server.address() as AddressInfo).port });
      const refused = await harness(dir, 'resume');
      assert.deepEqual([refused.code, refused.stderr.trim()], [1, 'the pipeline is not paused']);
      const done = await harness(dir, 'done', 'shop/T1');
      assert.deepEqual([done.code, done.stdout.trim()], [0, 'done']);
      const nothing = await harness(dir, 'accept', 'shop', 'v2');
      assert.deepEqual([nothing.code, nothing.stderr.trim()], [1, 'nothing to do']);
      const already = await harness(dir, 'mode', 'swarm');
      assert.deepEqual([already.code, already.stdout.trim()], [0, 'already swarm']);
      assert.equal(existsSync(join(dir, '.harness', 'setup.json')), false, 'the running daemon took the switch');
      const failed = await harness(dir, 'answer', 'r1', 'yes');
      assert.deepEqual([failed.code, failed.stderr.trim()], [1, 'the daemon answered 500: boom']);
    } finally {
      server.close();
    }
  });

  it("leaves main's rules to a running daemon, which switches as the dashboard does, and applies them itself while it is down", async () => {
    let answer: object = { done: true, rules: ['ruleset "harness: main" (Swarm)'] };
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += String(chunk))).on('end', () => {
        appendFileSync(log, `daemon ${req.url} ${body}\n`);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const dir = daemonJson({ pid: process.pid, processStart: processStart(process.pid)!, port: (server.address() as AddressInfo).port });
    const log = join(dir, 'calls.log');
    writeFileSync(log, '');
    // A gh that says what it was asked, and fails.
    const bin = tempDir('bin');
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "gh $1" >> '${log}'\nexit 1\n`, { mode: 0o755 });
    const mode = (to: string) => run(process.execPath, [CLI, 'mode', to, '--dir', dir], { env: { ...env, PATH: `${bin}:${process.env.PATH}` } });
    const calls = () => readFileSync(log, 'utf8').trim().split('\n');
    try {
      const swarm = await mode('swarm');
      assert.deepEqual([swarm.code, swarm.stdout.trim().split('\n')], [0, ['done', 'set: ruleset "harness: main" (Swarm)']]);
      assert.deepEqual(calls(), ['daemon /api/mode {"mode":"swarm"}'], "the daemon applied the rules: the CLI's gh wasn't asked");

      answer = { done: true, rules: [], problem: 'gh: not an admin of acme/shop' };
      const manual = await mode('manual');
      assert.equal(manual.code, 0);
      assert.match(manual.stdout, /^done\nGitHub's rules on main were not changed: gh: not an admin of acme\/shop\nRun `harness github-setup --repo acme\/shop --mode manual`/);
    } finally {
      server.close();
    }

    // The daemon is down: the CLI applies them with the owner's gh, and the switch waits for the daemon.
    rmSync(join(dir, '.harness', 'daemon.json'));
    writeFileSync(log, '');
    const down = await mode('swarm');
    assert.equal(down.code, 0, down.stderr);
    assert.match(down.stdout, /GitHub's rules on main were not changed: .*\nRun `harness github-setup --repo acme\/shop --mode swarm`/);
    assert.match(down.stdout, /swarm: the daemon switches when it starts/);
    assert.equal(calls()[0], 'gh api');
    assert.equal(JSON.parse(readFileSync(join(dir, '.harness', 'setup.json'), 'utf8')).mode, 'swarm');
  });

  it("records a module's hours and the mode for the daemon while it is down (v4 §5), each module's beside the others'", async () => {
    const dir = projectDir();
    const budget = await harness(dir, 'budget', '--module', 'shop', '--owner-hours', '12');
    assert.deepEqual([budget.code, budget.stdout.trim()], [0, '12 hours of your time for shop: recorded for when the daemon starts (harness up).'], budget.stderr);
    const mode = await harness(dir, 'mode', 'swarm');
    assert.equal(mode.code, 0, mode.stderr);
    assert.match(mode.stdout, /swarm: the daemon switches when it starts/);
    const cleared = await harness(dir, 'budget', '--module', 'pay', '--clear');
    assert.equal(cleared.stdout.trim(), 'pay: your hours are cleared, recorded for when the daemon starts (harness up).');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, '.harness', 'setup.json'), 'utf8')), { ownerHours: { shop: 12, pay: null }, mode: 'swarm' });
    for (const args of [['--owner-hours', '3'], ['--module', 'shop'], ['--module', 'shop', '--owner-hours', '3', '--clear'], ['--module', 'shop', '--owner-hours', '-1']]) {
      const wrong = await harness(dir, 'budget', ...args);
      assert.equal(wrong.code, 1, args.join(' '));
    }
  });

  it("sends a module's hours to a running daemon, with a new module or for one that exists", async () => {
    const daemon = await fakeDaemon({ '/api/owner-hours': { body: JSON.stringify({ done: true }) }, '/api/modules': { body: JSON.stringify({ done: true }) } });
    try {
      assert.equal((await harness(daemon.dir, 'budget', '--module', 'shop', '--owner-hours', '4.5')).code, 0);
      assert.equal((await harness(daemon.dir, 'budget', '--module', 'shop', '--clear')).code, 0);
      assert.equal((await harness(daemon.dir, 'module', 'new', 'pay', 'Payments', 'by card', '--owner-hours', '6')).code, 0);
      assert.equal((await harness(daemon.dir, 'module', 'new', 'ads', 'Ads')).code, 0);
      assert.deepEqual(daemon.calls, [
        '/api/owner-hours {"module":"shop","hours":4.5}',
        '/api/owner-hours {"module":"shop","hours":null}',
        '/api/modules {"id":"pay","title":"Payments by card","ownerHours":6}',
        '/api/modules {"id":"ads","title":"Ads"}',
      ]);
    } finally {
      daemon.close();
    }
  });

  it("tells a running daemon while the owner is attached to an Architect, and exits with openshell's code", async () => {
    const daemon = await fakeDaemon({ '/api/attach': { body: JSON.stringify({ done: true }) } });
    const bin = tempDir('bin');
    writeFileSync(join(bin, 'openshell'), `#!/bin/sh\necho "openshell $*" >> '${join(daemon.dir, 'openshell.log')}'\nexit 3\n`, { mode: 0o755 });
    writeFileSync(join(daemon.dir, '.harness', 'state.json'), JSON.stringify({ modules: { shop: { architect: { sandbox: 'arch-shop' } } } }));
    try {
      const attach = await run(process.execPath, [CLI, 'attach', 'shop', '--dir', daemon.dir], { env: { ...env, PATH: `${bin}:${process.env.PATH}` } });
      assert.equal(attach.code, 3, attach.stderr);
      assert.equal(readFileSync(join(daemon.dir, 'openshell.log'), 'utf8'), 'openshell sandbox connect arch-shop\n');
      assert.deepEqual(daemon.calls, ['/api/attach {"module":"shop","attached":true}', '/api/attach {"module":"shop","attached":false}']);
    } finally {
      daemon.close();
    }
  });

  it('refuses a flag that is not the command\'s, an action of three parts, and a folder that is no project', async () => {
    const dir = projectDir();
    const flag = await harness(dir, 'status', '--mode', 'swarm');
    assert.deepEqual([flag.code, flag.stderr.trim()], [1, '--mode: not a flag of `harness status`. `harness --help` lists each command\'s']);
    const done = await harness(dir, 'done', 'shop/T1/extra');
    assert.deepEqual([done.code, done.stderr.trim()], [1, 'usage: harness done <module>/<action> [--note <text>]']);

    const empty = tempDir('empty');
    for (const command of ['up', 'status', 'mode', 'budget', 'lock', 'recover']) {
      const result = await harness(empty, command);
      assert.equal(result.code, 1, command);
      assert.match(result.stderr, /holds no harness\/config\.json: run the command in the project's folder, or name it with --dir/, command);
    }
    assert.equal(existsSync(join(empty, '.harness')), false, 'nothing is created there');
  });

  it('refuses to start a daemon for a project without a GitHub repository', async () => {
    const dir = tempDir('local');
    mkdirSync(join(dir, 'harness'));
    writeFileSync(join(dir, 'harness', 'config.json'), JSON.stringify({ harnessVersion: '0.1.0', project: { name: 'shop' } }));
    const up = await harness(dir, 'up');
    assert.equal(up.code, 1);
    assert.match(up.stderr, /^harness\/config\.json has no project\.repo: the harness needs a GitHub repository.*`harness setup` creates one/);
    assert.equal(existsSync(join(dir, '.harness')), false);
  });

  it("says why a request failed, and checks the daemon's answer to `actions`", async () => {
    // A port nothing listens on any more.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    const offline = daemonJson({ pid: process.pid, processStart: processStart(process.pid)!, port });
    const resume = await harness(offline, 'resume');
    assert.equal(resume.code, 1);
    assert.match(resume.stderr, /^fetch failed: .*ECONNREFUSED/);
    const daemon = await fakeDaemon({ '/api/state': { status: 500, body: 'boom' } });
    try {
      const actions = await harness(daemon.dir, 'actions');
      assert.deepEqual([actions.code, actions.stderr.trim()], [1, 'the daemon answered 500: boom']);
    } finally {
      daemon.close();
    }
  });

  it('writes harness/lock.json again after the CI files, as `harness lock` does, and says what to commit', async () => {
    const dir = projectDir();
    const install = await harness(dir, 'install-ci', '--owner', 'owner');
    assert.equal(install.code, 0, install.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'harness', 'lock.json'), 'utf8')), await computeLock(directoryReader(dir)));
    assert.match(install.stdout, /\nCommit \.github\/workflows\/harness\.yml, \.github\/harness\/harness-ci\.ts, \.github\/CODEOWNERS, harness\/lock\.json and push them to main yourself/);
  });
});
