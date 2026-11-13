import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { upgrade, type UpgradeOptions } from '../src/setup/upgrade.ts';

/** `harness upgrade` on a pretend machine: what it ran, in order, and what it said. */
function machine(over: Partial<UpgradeOptions> & { latest?: string; running?: number; failing?: string[]; stale?: string[] } = {}) {
  const ran: string[] = [];
  const said: string[] = [];
  let daemon = over.running;
  let installed = '0.5.9';
  const failing = over.failing ?? [];
  const exit = (line: string) => (failing.some((prefix) => line.startsWith(prefix)) ? 1 : 0);
  const options: UpgradeOptions = {
    version: '0.5.9',
    packageDir: '/usr/lib/node_modules/razzou-harness',
    project: true,
    say: (line) => said.push(line),
    run: async (file, args) => {
      const line = [file, ...args].join(' ');
      ran.push(line);
      if (args[0] === 'install' && !exit(line)) installed = args[2]!.split('@')[1]!;
      return exit(line);
    },
    capture: async (file, args) => {
      ran.push([file, ...args].join(' '));
      return over.latest === undefined ? undefined : `${over.latest}\n`;
    },
    harness: async (args) => {
      const line = `harness ${args.join(' ')}`;
      ran.push(line);
      if (args[0] === 'up') daemon = 4321;
      return exit(line) || (args[0] === 'up' ? 3 : 0);
    },
    daemon: () => daemon,
    stop: async () => {
      ran.push('harness down');
      daemon = undefined;
      return true;
    },
    installed: () => installed,
    staleCi: () => over.stale ?? [],
    ...Object.fromEntries(Object.entries(over).filter(([key]) => !['latest', 'running', 'failing', 'stale'].includes(key))),
  };
  return { options, ran, said };
}

describe('harness upgrade', () => {
  it('stops the daemon, installs the latest version, builds its image, and starts the daemon again', async () => {
    const { options, ran, said } = machine({ latest: '0.6.0', running: 1234 });
    assert.equal(await upgrade(options), 3, "the restarted daemon's exit code");
    assert.deepEqual(ran, [
      'npm view razzou-harness version',
      'harness down',
      'npm install -g razzou-harness@0.6.0 --allow-scripts=node-pty',
      'harness doctor --build-images',
      'harness up',
    ]);
    assert.match(said[0]!, /^Stopping the daemon \(pid 1234\)\. The sandboxes keep running/);
    assert.match(said.at(-1)!, /^0\.6\.0 is ready\. The daemon runs in this terminal from now on/);
  });

  it('starts no daemon where none was running, and says how to', async () => {
    const { options, ran, said } = machine({ latest: '0.6.0' });
    assert.equal(await upgrade(options), 0);
    assert.deepEqual(ran, ['npm view razzou-harness version', 'npm install -g razzou-harness@0.6.0 --allow-scripts=node-pty', 'harness doctor --build-images']);
    assert.equal(said.at(-1), '0.6.0 is ready. Start the daemon with `harness up`.');
  });

  it('does nothing when the version installed is the latest, and leaves the daemon alone', async () => {
    const { options, ran, said } = machine({ latest: '0.5.9', running: 1234 });
    assert.equal(await upgrade(options), 0);
    assert.deepEqual(ran, ['npm view razzou-harness version']);
    assert.deepEqual(said, ['razzou-harness 0.5.9 is the latest: nothing to upgrade.']);
  });

  it('installs the version named, without asking npm for the latest', async () => {
    const { options, ran } = machine({ target: 'v0.5.8' });
    assert.equal(await upgrade(options), 0);
    assert.equal(ran[0], 'npm install -g razzou-harness@0.5.8 --allow-scripts=node-pty');
    await assert.rejects(upgrade(machine({ target: 'latest; rm -rf /' }).options), /is not a version: one looks like 0\.6\.0/);
  });

  it('starts the daemon again on the version still installed when npm fails', async () => {
    const { options, ran, said } = machine({ latest: '0.6.0', running: 1234, failing: ['npm install'] });
    await assert.rejects(upgrade(options), /the upgrade to 0\.6\.0 failed at the install/);
    assert.deepEqual(ran.slice(1), ['harness down', 'npm install -g razzou-harness@0.6.0 --allow-scripts=node-pty', 'harness up']);
    assert.equal(said.at(-1), 'npm could not install 0.6.0: 0.5.9 is still the one installed. Starting the daemon again on it.');
  });

  it("starts no daemon on a version whose image isn't built: it says what doctor needs first", async () => {
    const { options, ran } = machine({ latest: '0.6.0', running: 1234, failing: ['harness doctor'] });
    await assert.rejects(upgrade(options), /0\.6\.0 is installed, and `harness doctor` reports a problem: fix what it lists, run `harness doctor --build-images` again, then start the daemon with `harness up`/);
    assert.equal(ran.includes('harness up'), false);
  });

  it('outside a project, installs and says what each project needs', async () => {
    const { options, ran, said } = machine({ latest: '0.6.0', project: false });
    assert.equal(await upgrade(options), 0);
    assert.deepEqual(ran, ['npm view razzou-harness version', 'npm install -g razzou-harness@0.6.0 --allow-scripts=node-pty']);
    assert.match(said.at(-1)!, /In each project, run `harness doctor --build-images`, then `harness install-ci` and commit what it writes, then `harness down` and `harness up`\./);
  });

  it('waits for a daemon that is busy past the first wait of `down`, and fails while it still runs', async () => {
    const busy = machine({ latest: '0.6.0', running: 1234, stop: async () => false });
    await assert.rejects(upgrade(busy.options), /the daemon \(pid 1234\) is still stopping: run `harness upgrade` again once it has/);
    assert.equal(busy.ran.some((line) => line.startsWith('npm install')), false, 'nothing is installed under a running daemon');
  });

  it("fails when the copy that runs isn't the one npm installed, and starts no daemon", async () => {
    const { options, ran } = machine({ latest: '0.6.0', running: 1234, installed: () => '0.5.9' });
    await assert.rejects(upgrade(options), /npm installed 0\.6\.0, but \/usr\/lib\/node_modules\/razzou-harness holds 0\.5\.9: this harness isn't npm's global one/);
    assert.equal(ran.includes('harness up'), false);
  });

  it("stops before the restart while the project's CI files are an earlier version's, and names the commit to make", async () => {
    const { options, ran } = machine({ latest: '0.6.0', running: 1234, stale: ['.github/workflows/harness.yml'] });
    await assert.rejects(upgrade(options), /0\.6\.0 is installed, and the project's CI files are those of an earlier version \(\.github\/workflows\/harness\.yml\): run `harness install-ci`, commit what it writes with harness\/lock\.json and push it to main, then start the daemon with `harness up`/);
    assert.deepEqual(ran.slice(-1), ['harness doctor --build-images']);
  });

  it('refuses a harness that runs from its sources, and when npm gives no version', async () => {
    await assert.rejects(upgrade(machine({ latest: '0.6.0', packageDir: '/home/dev/razzou-harness' }).options), /runs from its sources in \/home\/dev\/razzou-harness, not from npm/);
    const offline = machine({});
    await assert.rejects(upgrade(offline.options), /npm did not give the latest version: is the network up\?/);
    assert.deepEqual(offline.ran, ['npm view razzou-harness version']);
  });
});
