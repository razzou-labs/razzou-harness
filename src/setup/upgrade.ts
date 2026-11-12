import { sep } from 'node:path';

/** The package's name on npm. */
export const PACKAGE = 'razzou-harness';

export interface UpgradeOptions {
  /** The version that runs this command. */
  version: string;
  /** The package's root: where that version is installed. */
  packageDir: string;
  /** The version to install; without one, the registry's latest. */
  target?: string;
  /** Whether the directory holds a harness project: its image is built, and its daemon started again. */
  project: boolean;
  say: (line: string) => void;
  /** Runs a command with the terminal attached, and gives its exit code. */
  run: (file: string, args: string[]) => Promise<number>;
  /** A command's output, or undefined when it fails. */
  capture: (file: string, args: string[]) => Promise<string | undefined>;
  /** Runs the harness as it is installed when called, with the terminal attached: after the install, the new version. */
  harness: (args: string[]) => Promise<number>;
  /** The pid of the project's daemon, while one runs. */
  daemon: () => number | undefined;
  /** Stops the project's daemon, as `harness down` does. */
  stop: () => Promise<void>;
}

/**
 * `harness upgrade`: the steps of every release's upgrade note, in one command. It stops
 * the project's daemon, installs the new version from npm, builds the agents' image,
 * whose tag follows the version, and starts the daemon again in this terminal. The
 * sandboxes keep running meanwhile, and the daemon picks up where it stopped.
 *
 * A step that fails stops the rest, and says where things stand: the daemon is started
 * again on the version that is installed whenever that version is whole.
 */
export async function upgrade(o: UpgradeOptions): Promise<'current' | 'upgraded' | 'restarted'> {
  if (!o.packageDir.split(sep).includes('node_modules')) {
    throw new Error(`this harness runs from its sources in ${o.packageDir.replace(/[\\/]+$/, '')}, not from npm: update them there (git pull, npm install, npm run build), then run \`harness doctor --build-images\``);
  }
  const target = (o.target ?? (await o.capture('npm', ['view', PACKAGE, 'version'])))?.trim().replace(/^v/, '');
  if (!target) throw new Error('npm did not give the latest version: is the network up? `harness upgrade <version>` installs the version you name');
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(target)) throw new Error(`"${target}" is not a version: one looks like 0.6.0`);
  if (target === o.version) {
    o.say(`${PACKAGE} ${o.version} is ${o.target ? 'the version installed' : 'the latest'}: nothing to upgrade.`);
    return 'current';
  }

  const pid = o.daemon();
  if (pid !== undefined) {
    o.say(`Stopping the daemon (pid ${pid}). The sandboxes keep running, and it starts again here once ${target} is ready.`);
    await o.stop();
    if (o.daemon() !== undefined) throw new Error(`the daemon (pid ${pid}) is still stopping: run \`harness upgrade\` again once it has`);
  }
  const startAgain = async (): Promise<void> => {
    if (pid !== undefined) await o.harness(['up']);
  };

  o.say(`Installing ${PACKAGE} ${target}, from ${o.version}.`);
  if ((await o.run('npm', ['install', '-g', `${PACKAGE}@${target}`, '--allow-scripts=node-pty'])) !== 0) {
    o.say(`npm could not install ${target}: ${o.version} is still the one installed.${pid !== undefined ? ' Starting the daemon again on it.' : ''}`);
    await startAgain();
    throw new Error(`the upgrade to ${target} failed at the install`);
  }
  if (!o.project) {
    o.say(`${target} is installed. In each project, run \`harness doctor --build-images\`, then \`harness down\` and \`harness up\`.`);
    return 'upgraded';
  }

  o.say(`Building the agents' image for ${target}, and checking the machine and the project.`);
  if ((await o.harness(['doctor', '--build-images'])) !== 0) {
    throw new Error(`${target} is installed, and \`harness doctor\` reports a problem: fix what it lists, run \`harness doctor --build-images\` again, then start the daemon with \`harness up\``);
  }
  if (pid === undefined) {
    o.say(`${target} is ready. Start the daemon with \`harness up\`.`);
    return 'upgraded';
  }
  o.say(`${target} is ready. The daemon runs in this terminal from now on; the dashboard opens again with it.`);
  await startAgain();
  return 'restarted';
}
