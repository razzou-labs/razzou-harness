import { strict as assert } from 'node:assert';
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runDaemon } from '../src/daemon/main.ts';
import { run, runOk, sleep } from '../src/util.ts';
import { FAKE_BOT } from './helpers/fake-forge.ts';
import { createToyRepo, tempDir } from './helpers/toy-repo.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const source = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);

/** A script run as a process of its own: signals sent to it don't reach the test runner. */
function script(body: string): ChildProcess & { out: () => string } {
  const file = join(tempDir('script'), 'script.ts');
  writeFileSync(file, body);
  const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout!.on('data', (chunk: Buffer) => (out += String(chunk)));
  child.stderr!.on('data', (chunk: Buffer) => (out += String(chunk)));
  return Object.assign(child, { out: () => out });
}

async function until(condition: () => boolean, what: string, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

const exited = (child: ChildProcess) => new Promise<{ code: number | null; signal: string | null }>((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) resolve({ code: child.exitCode, signal: child.signalCode });
  else child.once('exit', (code, signal) => resolve({ code, signal }));
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe('the daemon\'s lifecycle', () => {
  it('stops cleanly when the closed terminal sends SIGHUP twice, the second during the shutdown', async () => {
    const child = script(`
      import { untilStopped } from ${source('../src/daemon/main.ts')};
      const alive = setInterval(() => {}, 1000);
      console.log('ready');
      await untilStopped(async () => {
        console.log('stopping');
        await new Promise((resolve) => setTimeout(resolve, 500));
        console.log('stopped');
      });
      clearInterval(alive);
    `);
    await until(() => child.out().includes('ready'), 'the script');
    child.kill('SIGHUP');
    await until(() => child.out().includes('stopping'), 'the shutdown');
    child.kill('SIGHUP');
    assert.deepEqual(await exited(child), { code: 0, signal: null }, child.out());
    assert.match(child.out(), /stopped/);
  });

  it('keeps running past an exception or a rejection that nothing caught, and logs their stacks', async () => {
    const child = script(`
      import { survive } from ${source('../src/daemon/main.ts')};
      survive((message) => console.log(message));
      setTimeout(() => { throw new Error('boom'); }, 10);
      void Promise.reject(new Error('rejected'));
      setTimeout(() => console.log('still running'), 200);
    `);
    assert.deepEqual(await exited(child), { code: 0, signal: null }, child.out());
    assert.match(child.out(), /uncaught exception: Error: boom\n\s+at /);
    assert.match(child.out(), /unhandled rejection: Error: rejected\n\s+at /);
    assert.match(child.out(), /still running/);
  });

  it('runs, writes daemon.json whole, keeps the dashboard\'s token out of daemon.log, and stops for `harness down`', async () => {
    const dir = tempDir('project');
    const port = await freePort();
    await createToyRepo(dir, { project: { name: 'toy', repo: 'acme/toy', bot: FAKE_BOT }, dashboard: { port } }, { design: false });
    const child = script(`
      import { runDaemon } from ${source('../src/daemon/main.ts')};
      import { FakeForge } from ${source('./helpers/fake-forge.ts')};
      import { LocalDriver } from ${source('./helpers/local-driver.ts')};
      const forge = await FakeForge.create(${JSON.stringify(dir)});
      await runDaemon(${JSON.stringify(dir)}, { forge: () => forge, driver: new LocalDriver(${JSON.stringify(join(dir, '.sandboxes'))}), tickMs: 60_000 });
      process.exit(0);
    `);
    const harnessDir = join(dir, '.harness');
    try {
      await until(() => existsSync(join(harnessDir, 'daemon.json')), 'daemon.json');
      const info = JSON.parse(readFileSync(join(harnessDir, 'daemon.json'), 'utf8')) as { pid: number; token: string; port: number };
      assert.equal(info.port, port);
      assert.deepEqual(readdirSync(harnessDir).filter((file) => file.endsWith('.tmp')), [], 'no temporary file is left');
      await until(() => child.out().includes(`?token=${info.token}`), 'the link');
      const log = readFileSync(join(harnessDir, 'logs', 'daemon.log'), 'utf8');
      assert.match(log, new RegExp(`dashboard: http://127\\.0\\.0\\.1:${port}\\n`));
      assert.doesNotMatch(log, new RegExp(info.token), 'the token is only on the terminal');

      const down = await run(process.execPath, [CLI, 'down', '--dir', dir]);
      assert.deepEqual([down.code, down.stdout.trim()], [0, 'stopped'], down.stderr);
      assert.deepEqual(await exited(child), { code: 0, signal: null });
      assert.equal(existsSync(join(harnessDir, 'daemon.json')), false);
      assert.equal(existsSync(join(harnessDir, 'daemon.lock')), false);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('refuses a new event log on a project whose main has accepted features, naming `harness recover`', async () => {
    const dir = tempDir('project');
    await createToyRepo(dir);
    writeFileSync(join(dir, 'progress.txt'), '2026-11-01T00:00:00.000Z feature.accepted demo/P1/F01\n');
    await runOk('git', ['-C', dir, 'add', 'progress.txt']);
    await runOk('git', ['-C', dir, '-c', 'user.name=owner', '-c', 'user.email=owner@test.invalid', 'commit', '--quiet', '-m', 'progress']);
    await assert.rejects(runDaemon(dir), /no event log: it was lost\. `harness recover` rebuilds it/);
    assert.equal(existsSync(join(dir, '.harness', 'daemon.lock')), false, 'refused before the lock');
  });
});
