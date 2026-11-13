import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { projectKey } from '../daemon/refs.ts';
import { webRead } from '../daemon/web-read.ts';
import { loadPty } from '../dashboard/terminals.ts';
import { ConfigSchema, requiredChecks, type Config } from '../design/schemas.ts';
import { configDir, GitHubClient, loadAppCredentials } from '../github/app.ts';
import { checkApp, ciFiles, staleCiFiles } from '../github/setup.ts';
import { BUNDLES } from '../sandbox/allowlist.ts';
import { OpenShellDriver } from '../sandbox/openshell.ts';
import { apiProfile, apiProviderName } from '../sandbox/policy.ts';
import type { Mode } from '../state/state.ts';
import { run } from '../util.ts';
import { buildCache, removeOldAgentImages } from './images.ts';
import { appBot, MAIN_FILES } from './init.ts';
import { terraformSource } from './terraform.ts';
import { probe, stateLocation } from './probe.ts';

/** The OpenShell release the harness is built and probed against (§17.4). */
export const OPENSHELL_VERSION = '0.1.7';
/** OpenShell's AWS provider profile, at that release. */
const AWS_PROFILE_URL = `https://raw.githubusercontent.com/NVIDIA/OpenShell/v${OPENSHELL_VERSION}/providers/aws.yaml`;

export interface Check {
  status: 'ok' | 'warn' | 'fail' | 'skip';
  name: string;
  detail: string;
  /** What the owner can do about it. */
  fix?: string;
}

export interface DoctorOptions {
  projectDir: string;
  packageDir: string;
  version: string;
  probe: boolean;
  buildImages: boolean;
  /** Whether the owner is at a terminal: then missing providers are set up, with hidden prompts for secrets. */
  interactive: boolean;
  /** The AWS view role's ARN, when `harness setup` asked for it already: the AWS provider takes it without asking again. */
  awsViewRole?: string;
  /**
   * The secrets the owner skipped with Enter during this run, by provider name: not asked
   * for again, since `harness setup` runs the doctor up to three times.
   */
  skipped?: Set<string>;
  /** Asks for a secret without echoing it; the terminal's hidden prompt by default. */
  askSecret?: (question: string) => Promise<string>;
  report: (check: Check) => void;
}

/**
 * Checks the machine and the project against the setup checklist (§17.3), and sets up
 * what only needs the owner's secrets. With `probe`, it tries everything an agent must
 * not do, from each kind of sandbox and from outside (§6.2).
 */
export async function doctor(options: DoctorOptions): Promise<Check[]> {
  const checks: Check[] = [];
  const report = (check: Check) => {
    checks.push(check);
    options.report(check);
  };
  const configFile = join(options.projectDir, 'harness', 'config.json');
  let config: Config | undefined;
  if (existsSync(configFile)) {
    try {
      config = ConfigSchema.parse(JSON.parse(readFileSync(configFile, 'utf8')));
    } catch (error) {
      report({ status: 'fail', name: 'harness/config.json', detail: (error as Error).message.slice(0, 400), fix: 'fix the file' });
    }
  }
  const image = config?.sandbox.image ?? `razzou-harness/agent:${options.version}`;
  const claudeProvider = config?.sandbox.claudeProvider ?? 'claude-sub';

  // Without OpenShell, what needs it is a failed check, not an error that ends the run.
  const openshell = await machine(options, image, report);
  if (openshell) await claude(options, claudeProvider, report);
  else report(fail('Claude provider', 'needs OpenShell, which is missing', `install OpenShell ${OPENSHELL_VERSION}`));
  if (config) await project(options, config, report, openshell);
  else report({ status: 'skip', name: 'project', detail: 'no harness/config.json here', fix: 'run `harness init` in the project repository' });
  if (options.probe) {
    if (!config) report({ status: 'skip', name: 'probe', detail: 'the probe needs a project' });
    else if (!openshell) report({ status: 'skip', name: 'probe', detail: 'the probe needs OpenShell' });
    else await probes(options, config, report);
  }
  return checks;
}

/** The checks of this machine, as opposed to the project's: while one fails, the probe has nothing to try from. */
export const MACHINE_CHECKS = ['Node', 'git', 'Docker', 'OpenShell', 'OpenShell gateway', 'Claude Code', 'image build', 'image', 'container network'];

/** Checks the machine; true when OpenShell is installed. */
async function machine(options: DoctorOptions, image: string, report: (c: Check) => void): Promise<boolean> {
  const major = Number(process.versions.node.split('.')[0]);
  report(major >= 24 ? ok('Node', process.versions.node) : fail('Node', process.versions.node, 'install Node 24 or later'));
  const git = await run('git', ['--version']).catch(() => undefined);
  report(git?.code === 0 ? ok('git', git.stdout.trim()) : fail('git', 'not found', 'install git'));

  const docker = await run('docker', ['info', '--format', '{{.ServerVersion}}']).catch(() => undefined);
  report(docker?.code === 0 ? ok('Docker', `server ${docker.stdout.trim()}`) : fail('Docker', firstLine(docker?.stderr) || 'not found', 'install Docker, and add yourself to the docker group'));
  // A VPN exit node, such as Tailscale's, can cut the containers' network (§17.3).
  const tailscale = await run('tailscale', ['status', '--json']).catch(() => undefined);
  if (tailscale?.code === 0 && (JSON.parse(tailscale.stdout) as { ExitNodeStatus?: unknown }).ExitNodeStatus) {
    report(warn('Tailscale', 'an exit node is active', 'containers can lose their network: turn the exit node off if sandboxes can\'t connect'));
  }

  const openshell = await run('openshell', ['--version']).catch(() => undefined);
  const found = /(\d+\.\d+\.\d+)/.exec(openshell?.stdout ?? '')?.[1];
  if (!found) report(fail('OpenShell', 'not found', `install OpenShell ${OPENSHELL_VERSION}`));
  else report(found === OPENSHELL_VERSION ? ok('OpenShell', found) : fail('OpenShell', `${found}, but the harness is pinned to ${OPENSHELL_VERSION}`, `install OpenShell ${OPENSHELL_VERSION}`));
  const status = await run('openshell', ['status']).catch(() => undefined);
  report(/Status:\s*Connected/.test(status?.stdout ?? '') ? ok('OpenShell gateway', 'connected') : fail('OpenShell gateway', firstLine(status?.stdout || status?.stderr) || 'not running', 'start the gateway, a systemd user service: `systemctl --user start openshell-gateway`'));

  const host = await run('claude', ['--version']).catch(() => undefined);
  const hostClaude = /^(\S+)/.exec(host?.stdout ?? '')?.[1];
  report(hostClaude ? ok('Claude Code', hostClaude) : fail('Claude Code', 'not found', 'install Claude Code: the agents\' image takes it from this machine'));

  if (options.buildImages) {
    const built = await run('bash', [join(options.packageDir, 'images', 'agent', 'build.sh'), image]);
    report(built.code === 0 ? ok('image build', image) : fail('image build', lastLine(built.stderr || built.stdout), 'see the output of images/agent/build.sh'));
    if (built.code === 0) {
      // The images it replaces, about 2 GB each, once no container uses them.
      const { removed, kept } = await removeOldAgentImages(image);
      if (kept.length > 0) report(warn('old images', `${removed.length > 0 ? `removed ${removed.join(', ')}; ` : ''}kept ${kept.join(', ')}, which a container uses`, 'once the sandboxes that use them are gone, `harness doctor --build-images` removes them'));
      else if (removed.length > 0) report(ok('old images', `removed ${removed.join(', ')}`));
      const cache = await buildCache();
      if (cache) report(ok('build cache', `Docker's build cache holds ${cache.size}, ${cache.reclaimable} of it reclaimable: \`docker builder prune\` frees it, for every build on this machine`));
    }
  }
  const label = await run('docker', ['image', 'inspect', image, '--format', '{{index .Config.Labels "dev.razzou-harness.claude-code"}}']).catch(() => undefined);
  if (label?.code !== 0) {
    report(fail('image', `${image} isn't built`, 'run `harness doctor --build-images`'));
  } else {
    const inImage = label.stdout.trim();
    report(!hostClaude || inImage === hostClaude ? ok('image', `${image}, Claude Code ${inImage}`) : warn('image', `${image} has Claude Code ${inImage}, this machine ${hostClaude}`, 'rebuild it: `harness doctor --build-images`'));
    const net = await run('docker', ['run', '--rm', '--entrypoint', 'curl', image, '-sS', '-m', '10', '-o', '/dev/null', '-w', '%{http_code}', 'https://api.anthropic.com/']).catch(() => undefined);
    report(/^\d{3}$/.test(net?.stdout.trim() ?? '') && net?.stdout.trim() !== '000'
      ? ok('container network', `api.anthropic.com answered ${net!.stdout.trim()}`)
      : fail('container network', firstLine(net?.stderr) || 'no answer from api.anthropic.com', 'containers need outbound network; check VPNs and exit nodes'));
  }

  report((await loadPty()) ? ok('terminals', 'node-pty loads') : warn('terminals', 'node-pty is missing', 'the dashboard has no terminals; `harness attach` still works. Install build tools and reinstall to get them'));
  return found !== undefined;
}

/**
 * The Claude subscription provider (§17.3, step 2): the profile, then the provider with the
 * owner's token from `claude setup-token`. That token runs models and nothing else: the
 * daemon takes the subscription's usage from the agents' own reports (usage.ts), so it
 * needs no token of its own.
 */
async function claude(options: DoctorOptions, provider: string, report: (c: Check) => void): Promise<void> {
  const profiles = await run('openshell', ['profile', 'list']).catch(() => undefined);
  if (!/^claude-code-subscription\s/m.test(profiles?.stdout ?? '')) {
    const imported = await run('openshell', ['profile', 'import', '-f', join(options.packageDir, 'templates', 'openshell', 'claude-code-subscription.yaml'), '--global']);
    report(imported.code === 0 ? ok('Claude profile', 'imported') : fail('Claude profile', firstLine(imported.stderr), 'see `openshell profile import --help`'));
  }
  // Up to 0.4.15 the daemon read the usage with a token of its own, which `setup-token` tokens can't do.
  const leftover = join(configDir(), 'claude.token');
  if (existsSync(leftover)) report({ status: 'skip', name: 'Claude token', detail: `${leftover} is no longer used: the agents report the subscription's usage. Delete it` });
  if (await providerExists(provider)) return report(ok('Claude provider', provider));
  if (!options.interactive || options.skipped?.has(provider)) {
    return report(fail('Claude provider', `${provider} is missing`, 'run `claude setup-token`, then `harness doctor` in a terminal: it asks for the token'));
  }
  const token = await (options.askSecret ?? askSecret)(`Claude provider ${provider} is missing. Paste the token from \`claude setup-token\` (hidden; a token over two lines comes in whole): `);
  if (!token) {
    options.skipped?.add(provider);
    return report(fail('Claude provider', 'no token given', 'run `harness doctor` again'));
  }
  // The token reaches OpenShell through the environment of one command, never its arguments.
  const created = await run('openshell', ['provider', 'create', '--name', provider, '--type', 'claude-code-subscription', '--from-existing'], {
    env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token },
  });
  report(created.code === 0 ? ok('Claude provider', `${provider} created`) : fail('Claude provider', firstLine(created.stderr), 'see `openshell provider create --help`'));
}

/** What the App's installation grants of a permission, from checkApp's `Permissions:` line: only what the owner accepted on it. */
export function granted(appCheck: string[], permission: string): string | undefined {
  return new RegExp(`\\b${permission}=(\\w+)`).exec(appCheck.find((l) => l.startsWith('Permissions:')) ?? '')?.[1];
}

async function project(options: DoctorOptions, config: Config, report: (c: Check) => void, openshell: boolean): Promise<void> {
  report(ok('harness/config.json', `project ${config.project.name}`));
  report(await mainHolds(options.projectDir));
  const repo = config.project.repo;
  const mode = projectMode(options.projectDir);
  if (!repo) {
    // Without a repository, plans never reach main: `harness up` refuses such a project.
    report(fail('GitHub', 'no project.repo: the harness needs a GitHub repository, where each plan reaches main through a pull request', '`harness setup` creates one, and sets project.repo and project.bot'));
  } else {
    // CI tells the App's pull requests by the bot the config names, and the daemon refuses to start on another App's.
    const bot = appBot();
    if (bot && bot !== config.project.bot) {
      report(fail('GitHub App', `harness/config.json says the bot is ${config.project.bot}, but the App on this machine is ${bot}`, `set project.bot to "${bot}" in harness/config.json and run \`harness lock\`, or run the harness where the App of ${config.project.bot} is`));
    } else {
      try {
        const lines = await checkApp(repo);
        report(ok('GitHub App', lines.find((l) => l.startsWith('App:'))?.slice(5) ?? 'installed'));
        // In Swarm the reviewers' verdicts are commit statuses the App posts (v3 §3.4), once the installation accepted the permission.
        // Checked in Manual too, so that `harness setup` makes the project ready for Swarm.
        if (granted(lines, 'statuses') !== 'write') {
          report(warn('GitHub App', "can't write commit statuses, which the reviewers' verdicts need in Swarm", 'give the App "Commit statuses: write" on GitHub, and accept the new permission on its installation'));
        }
      } catch (error) {
        report(fail('GitHub App', firstLine((error as Error).message), 'create it with `harness github-app create --org <org>`, and install it on the repository'));
      }
    }
    const ruleset = await mainRuleset(repo);
    if (!ruleset) {
      report(warn('ruleset', 'not readable with your gh login', 'install and log in to gh to check it, or apply it with `harness github-setup`'));
    } else {
      // In Swarm the reviewers' statuses are required too (v3 §3.3); the probe checks the rest.
      const wanted = [...requiredChecks(config), ...(mode === 'swarm' ? config.swarm.requiredStatuses : [])];
      const missing = wanted.filter((c) => !ruleset.checks.includes(c));
      const fix = `run \`harness github-setup --repo ${repo}\``;
      if (missing.length > 0) report(fail('ruleset', `doesn't require ${missing.join(', ')}`, fix));
      else if (!ruleset.active) report(fail('ruleset', 'not active', fix));
      else if (ruleset.offMain) report(fail('ruleset', ruleset.offMain, offMainFix(repo)));
      else report(ok('ruleset', `requires ${ruleset.checks.join(', ')}`));
    }
    // The cost job's key: optional, so it is reported, never asked for here. `harness setup` asks once.
    if (config.terraform) {
      const set = await repositorySecret(repo, 'INFRACOST_API_KEY');
      report(set
        ? ok('Infracost key', 'INFRACOST_API_KEY is set: the cost job estimates each pull request')
        : { status: 'skip', name: 'Infracost key', detail: set === false
          ? "INFRACOST_API_KEY isn't set: the cost job estimates nothing, and Swarm leaves INFRA and MIXED_INFRA_AND_CODE plans to you. `harness setup` asks for it"
          : "your gh login can't tell whether INFRACOST_API_KEY is set" });
    }
    const stale = new Set(staleCiFiles(options.projectDir, options.packageDir));
    for (const [file] of ciFiles(options.packageDir)) {
      if (!existsSync(join(options.projectDir, file))) report(fail(file, 'missing', 'run `harness install-ci`, and commit the files'));
      else if (stale.has(file)) report(warn(file, 'differs from this version of the harness', 'run `harness install-ci`, and commit the files'));
      else report(ok(file, 'up to date'));
    }
  }
  if (!openshell) {
    if (config.aws || config.network.apis.some((api) => api.key)) report({ status: 'skip', name: 'providers', detail: "the AWS and API providers need OpenShell, which is missing" });
  } else {
    if (config.aws) await aws(options, config, report);
    await apis(options, config, report);
  }
  if (config.terraform) {
    const tf = config.terraform;
    for (const file of [tf.backendConfig, tf.varFile]) {
      report(existsSync(join(options.projectDir, tf.dir, file)) ? ok('Terraform', `${tf.dir}/${file}`) : fail('Terraform', `${tf.dir}/${file} is missing`, '`harness setup` writes the missing Terraform scaffold, or see the README\'s AWS section'));
    }
    report(terraformBackend(options.projectDir, tf.dir));
  }
}

/**
 * Without a `backend "s3"` block, CI's `terraform init -backend-config=...` only warns and
 * keeps the state on the runner: what tf-apply creates would be forgotten with it.
 */
export function terraformBackend(projectDir: string, dir: string): Check {
  return /^\s*backend\s+"s3"/m.test(terraformSource(join(projectDir, dir)))
    ? ok('Terraform', `${dir}/ has a backend "s3" block`)
    : fail('Terraform', `no .tf file in ${dir}/ has a backend "s3" block: CI would keep the state on its runner, and lose it`, 'add `terraform { backend "s3" {} }` in a .tf file of its own, or run `harness setup`, which writes it in backend.tf');
}

/**
 * main, and origin's main as of the last fetch or push, hold the config and the CI files as
 * the working tree has them: the daemon reads the config from main, and CI runs the
 * workflow that main has. Files the working tree hasn't are reported by their own checks.
 */
export async function mainHolds(projectDir: string): Promise<Check> {
  const git = (args: string[]) => run('git', ['-C', projectDir, ...args]).catch(() => undefined);
  const refs = ['main'];
  const problems: string[] = [];
  if ((await git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main']))?.code === 0) refs.push('origin/main');
  else if ((await git(['remote', 'get-url', 'origin']))?.code === 0) problems.push("origin's main is unknown here: it was never pushed or fetched");
  const files = MAIN_FILES.filter((file) => existsSync(join(projectDir, file)));
  for (const ref of refs) {
    const differ: string[] = [];
    for (const file of files) {
      const shown = await git(['show', `refs/${ref === 'main' ? 'heads' : 'remotes'}/${ref}:${file}`]);
      if (shown?.code !== 0 || shown.stdout !== readFileSync(join(projectDir, file), 'utf8')) differ.push(file);
    }
    if (differ.length > 0) problems.push(`${ref} doesn't hold ${differ.join(', ')} as ${differ.length === 1 ? 'it is' : 'they are'} here`);
  }
  return problems.length === 0
    ? ok('main', `holds ${files.join(', ')} as ${files.length === 1 ? 'it is' : 'they are'} here`)
    : fail('main', problems.join('; '), 'commit them on main and push it: `harness setup` offers both. The daemon reads the config from main, and CI runs the workflow main has');
}

/** The project's third-party APIs: each key in an OpenShell provider, under the variable the config names. */
async function apis(options: DoctorOptions, config: Config, report: (c: Check) => void): Promise<void> {
  for (const api of config.network.apis) {
    if (!api.key) {
      report(ok('API', `${api.host}: every method, no key`));
      continue;
    }
    // The daemon's name for it: the project with this checkout, so two checkouts of one project keep their own keys.
    const name = apiProviderName(projectKey(options.projectDir, config.project.name), api.host);
    const keys = await providerKeys(name);
    if (keys && keys.includes(api.key)) {
      report(ok('API', `${api.host}: its key in ${name}, as ${api.key}`));
      continue;
    }
    if (keys) {
      report(fail('API', `${name} holds the key of ${api.host} as ${keys.join(', ') || 'nothing'}, but the config says ${api.key}`, `delete it with \`openshell provider delete ${name}\`, then run \`harness doctor\` in a terminal`));
      continue;
    }
    if (!options.interactive) {
      report(fail('API', `no key stored for ${api.host}`, 'run `harness doctor` in a terminal: it asks for the key'));
      continue;
    }
    if (options.skipped?.has(name)) {
      report(fail('API', `no key stored for ${api.host}: skipped`, 'run `harness doctor` again with the key at hand'));
      continue;
    }
    const secret = await (options.askSecret ?? askSecret)(`The key of ${api.host}, which the project's code reads as ${api.key} (hidden, or Enter to skip): `);
    if (!secret) {
      options.skipped?.add(name);
      report(fail('API', `no key stored for ${api.host}`, 'run `harness doctor` again with the key at hand'));
      continue;
    }
    const problem = await storeApiKey(projectKey(options.projectDir, config.project.name), { host: api.host, key: api.key }, secret);
    report(problem ? fail('API', `${api.host}: ${problem}`, 'fix it, then run `harness doctor` again') : ok('API', `${api.host}: key stored in ${name}`));
  }
}

/** The variables a provider holds credentials under, or undefined when there is no such provider. */
async function providerKeys(name: string, bin = 'openshell'): Promise<string[] | undefined> {
  const listed = await run(bin, ['provider', 'list', '--output', 'json']).catch(() => undefined);
  if (listed?.code !== 0) return undefined;
  const provider = (JSON.parse(listed.stdout) as { providers?: Array<{ name?: string; credential_keys?: string[] }> }).providers?.find((p) => p.name === name);
  return provider ? provider.credential_keys ?? [] : undefined;
}

/**
 * Stores an API's key in a new OpenShell provider, after importing the profile the
 * harness writes for it (apiProfile). The key reaches `openshell` through its
 * environment, never its arguments, which other users of the machine can read. Returns
 * what went wrong, if anything.
 */
export async function storeApiKey(project: string, api: { host: string; key: string }, secret: string, bin = 'openshell'): Promise<string | undefined> {
  const name = apiProviderName(project, api.host);
  const dir = mkdtempSync(join(tmpdir(), 'harness-api-'));
  try {
    const file = join(dir, `${name}.yaml`);
    writeFileSync(file, `${JSON.stringify(apiProfile(project, api), null, 2)}\n`);
    // A profile left by an earlier try, or written for another variable, gives way to this one.
    await run(bin, ['profile', 'delete', name, '--global']).catch(() => undefined);
    const imported = await run(bin, ['profile', 'import', '-f', file, '--global']);
    if (imported.code !== 0) return `openshell profile import: ${firstLine(imported.stderr || imported.stdout)}`;
    const created = await run(bin, ['provider', 'create', '--name', name, '--type', name, '--credential', api.key, '--global-profile'], { env: { ...process.env, [api.key]: secret } });
    if (created.code !== 0) return `openshell provider create: ${firstLine(created.stderr || created.stdout)}`;
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The AWS view role in OpenShell (§17.3, step 5): the gateway user's key, assuming the project's view role. */
async function aws(options: DoctorOptions, config: Config, report: (c: Check) => void): Promise<void> {
  const provider = config.aws!.provider;
  if (await providerExists(provider)) {
    const status = await run('openshell', ['provider', 'refresh', 'status', provider]);
    return report(/\brefreshed\b/.test(status.stdout) ? ok('AWS provider', `${provider}, credentials fresh`) : fail('AWS provider', `${provider}: ${lastLine(status.stdout || status.stderr)}`, `run \`openshell provider refresh rotate ${provider} --credential-key AWS_ACCESS_KEY_ID\``));
  }
  if (!options.interactive) return report(fail('AWS provider', `${provider} is missing`, 'run `harness doctor` in a terminal: it asks for the role and the gateway user\'s key'));
  const profiles = await run('openshell', ['profile', 'list']);
  if (!/^aws\s/m.test(profiles.stdout)) {
    const imported = await run('openshell', ['profile', 'import', '--url', AWS_PROFILE_URL, '--global']);
    if (imported.code !== 0) return report(fail('AWS profile', firstLine(imported.stderr), `import ${AWS_PROFILE_URL}`));
  }
  console.log(`AWS provider ${provider} is missing. It needs the project's read-only role, and the gateway user's key (see the README's AWS section).`);
  const role = options.awsViewRole ?? (await ask('The project\'s view role ARN: '));
  const keyId = await ask('The harness-gateway user\'s AccessKeyId: ');
  const secret = await (options.askSecret ?? askSecret)('Its SecretAccessKey (hidden): ');
  if (!/^arn:aws:iam::\d{12}:role\/harness-[\w+=,.@-]+-view$/.test(role) || !keyId || !secret) {
    return report(fail('AWS provider', 'a value is missing or malformed', 'run `harness doctor` again'));
  }
  const steps: string[][] = [
    ['provider', 'create', '--name', provider, '--type', 'aws', '--runtime-credentials'],
    ['provider', 'refresh', 'configure', provider, '--credential-key', 'AWS_ACCESS_KEY_ID', '--strategy', 'aws-sts-assume-role',
      '--material', `role_arn=${role}`, '--material', 'session_name=harness-agents', '--material', `aws_region=${config.aws!.region}`,
      '--material', `aws_access_key_id=${keyId}`, '--secret-material-env', 'aws_secret_access_key=HARNESS_AWS_SECRET'],
    ['provider', 'refresh', 'rotate', provider, '--credential-key', 'AWS_ACCESS_KEY_ID'],
  ];
  for (const args of steps) {
    // The secret goes through the environment of these commands only.
    const result = await run('openshell', args, { env: { ...process.env, HARNESS_AWS_SECRET: secret } });
    if (result.code === 0) continue;
    const failed = `openshell ${args.slice(0, 3).join(' ')}: ${firstLine(result.stderr)}`;
    if (args[1] === 'create') return report(fail('AWS provider', failed, 'fix it, then run `harness doctor` again'));
    // A provider without its key would pass for done on every later run, and the key would never be asked for again.
    const deleted = await run('openshell', ['provider', 'delete', provider]);
    return report(deleted.code === 0
      ? fail('AWS provider', `${failed}; ${provider} was deleted again`, 'fix it, then run `harness doctor` again: it asks for the key again')
      : fail('AWS provider', `${failed}; deleting ${provider} failed too: ${firstLine(deleted.stderr)}`, `run \`openshell provider delete ${provider}\`, then \`harness doctor\` again`));
  }
  report(ok('AWS provider', `${provider} created`));
}

/** The permission tests (§6.2): from a sandbox like an agent's and like an Architect's, then from outside. */
async function probes(options: DoctorOptions, config: Config, report: (c: Check) => void): Promise<void> {
  const backend = config.terraform ? join(options.projectDir, config.terraform.dir, config.terraform.backendConfig) : undefined;
  const state = backend && existsSync(backend) ? stateLocation(readFileSync(backend, 'utf8')) : undefined;
  const roles: Array<[string, Config]> = [
    ['Developer, Manager and checks', config],
    ['Architect', { ...config, network: { ...config.network, bundles: Object.keys(BUNDLES) } }],
  ];
  for (const [label, roleConfig] of roles) {
    const scratch = mkdtempSync(join(tmpdir(), 'harness-probe-'));
    try {
      for (const result of await probe({ driver: new OpenShellDriver(), config: roleConfig, projectDir: options.projectDir, scratch, ...(state ? { state } : {}) })) {
        report({ status: result.skipped ? 'skip' : result.ok ? 'ok' : 'fail', name: `probe (${label})`, detail: `${result.name}: ${result.detail}` });
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  const refused = await webRead('http://192.168.1.1/');
  // Only the harness's own refusal counts: a network error, or an answer from the address, means it tried.
  report(refused.text.startsWith('refused:')
    ? ok('probe (outside)', `web_read refuses a private address: ${refused.text}`)
    : fail('probe (outside)', `web_read didn't refuse a private address: ${refused.status === undefined ? firstLine(refused.text) : `it answered ${refused.status}`}`));
  if (config.project.repo) {
    const repo = config.project.repo;
    report(await workflowPushRefused(repo));
    const ruleset = await mainRuleset(repo);
    if (!ruleset) report(warn('probe (outside)', 'the ruleset is not readable with your gh login', 'install and log in to gh'));
    else if (projectMode(options.projectDir) === 'swarm') report(swarmRuleset(ruleset, config, repo));
    else if (ruleset.active && ruleset.offMain) report(fail('probe (outside)', `main can be merged without the owner's approval: the ruleset ${ruleset.offMain}`, offMainFix(repo)));
    else {
      report(ruleset.approvals >= 1 && ruleset.codeOwners && ruleset.active
        ? ok('probe (outside)', `main needs ${ruleset.approvals} code owner approval to merge`)
        : fail('probe (outside)', "main can be merged without the owner's approval", `run \`harness github-setup --repo ${repo}\``));
    }
  }
}

/** In Swarm, main needs no approval, and the reviewers' statuses, each pinned to the App (v3 §3.3). */
function swarmRuleset(ruleset: Ruleset, config: Config, repo: string): Check {
  const statuses = config.swarm.requiredStatuses;
  const fix = `run \`harness github-setup --repo ${repo}\``;
  if (!ruleset.active) return fail('probe (outside)', 'the ruleset on main is not active', fix);
  if (ruleset.offMain) return fail('probe (outside)', `the ruleset ${ruleset.offMain}`, offMainFix(repo));
  if (ruleset.approvals > 0) return fail('probe (outside)', "main's rules are the Manual ones: they need an approval the daemon can't give", fix);
  const missing = statuses.filter((s) => !ruleset.checks.includes(s));
  if (missing.length > 0) return fail('probe (outside)', `main's rules miss the statuses ${missing.join(', ')}`, fix);
  let appId: number | undefined;
  try {
    appId = loadAppCredentials().appId;
  } catch {
    appId = undefined;
  }
  const unpinned = appId === undefined ? [] : statuses.filter((s) => ruleset.integrations[s] !== appId);
  if (unpinned.length > 0) return fail('probe (outside)', `the statuses ${unpinned.join(', ')} are not pinned to the App: anything could post them`, fix);
  return ok('probe (outside)', statuses.length > 0 ? `main needs no approval, and the App's statuses: ${statuses.join(', ')}` : 'main needs no approval, and the daemon merges on CI alone');
}

/**
 * The project's mode (v3 §2.1): the one `harness mode` recorded in .harness/setup.json for
 * the daemon to switch to, or else the daemon's, from its state snapshot; Manual when there
 * is neither. Main's rules are judged and applied for the mode the daemon will run in.
 */
export function projectMode(projectDir: string): Mode {
  for (const file of ['setup.json', 'state.json']) {
    try {
      const mode = (JSON.parse(readFileSync(join(projectDir, '.harness', file), 'utf8')) as { mode?: unknown }).mode;
      if (mode === 'manual' || mode === 'swarm') return mode;
    } catch {
      // No file, or one that can't be read: the next one says.
    }
  }
  return 'manual';
}

/**
 * The App tries to push a workflow to a new branch, and GitHub must refuse it. Its tokens
 * are minted without workflows, so GitHub refuses whatever the App holds: its
 * installation must not grant workflows either.
 */
async function workflowPushRefused(repo: string): Promise<Check> {
  const dir = mkdtempSync(join(tmpdir(), 'harness-probe-git-'));
  try {
    const workflows = granted(await checkApp(repo), 'workflows');
    if (workflows) return fail('probe (outside)', `the App's installation grants workflows=${workflows}: it must not have the workflows permission`, "remove the permission from the App's settings on GitHub");
    const client = new GitHubClient(loadAppCredentials(), repo);
    const env = { ...process.env, ...(await client.gitEnv()), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const git = (args: string[]) => run('git', ['-C', dir, ...args], { env });
    await git(['init', '--quiet']);
    const fetched = await git(['fetch', '--quiet', '--depth', '1', client.remoteUrl, 'main']);
    if (fetched.code !== 0) return fail('probe (outside)', `couldn't fetch main as the App: ${firstLine(fetched.stderr)}`);
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(dir, '.github', 'workflows', 'harness-probe.yml'), 'name: harness-probe\non: workflow_dispatch\njobs: {}\n');
    await git(['checkout', '--quiet', 'FETCH_HEAD']);
    await git(['add', '.github/workflows/harness-probe.yml']);
    await git(['-c', 'user.name=harness probe', '-c', 'user.email=probe@harness.invalid', 'commit', '--quiet', '-m', 'probe: a workflow the App must not push']);
    const branch = `harness-probe-${randomUUID().slice(0, 8)}`;
    const push = await git(['push', '--quiet', client.remoteUrl, `HEAD:refs/heads/${branch}`]);
    if (push.code === 0) {
      await git(['push', '--quiet', client.remoteUrl, '--delete', branch]);
      return fail('probe (outside)', 'the App pushed a workflow: it must not have the workflows permission', 'remove the permission from the App');
    }
    return /workflow/i.test(push.stderr) ? ok('probe (outside)', 'GitHub refuses a workflow from the App') : fail('probe (outside)', `the push failed for another reason: ${firstLine(push.stderr)}`);
  } catch (error) {
    return fail('probe (outside)', `couldn't try a workflow push: ${firstLine((error as Error).message)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Ruleset {
  /** The required checks' contexts: CI jobs, and in Swarm the App's statuses. */
  checks: string[];
  /** The integration each required check is pinned to, by context. */
  integrations: Record<string, number | undefined>;
  approvals: number;
  codeOwners: boolean;
  active: boolean;
  /** Why it doesn't apply to main, when it doesn't: it names neither main nor the default branch, or the default branch isn't main. */
  offMain?: string;
}

/** A default branch other than main is the owner's to change: the ruleset applies to the default branch. */
const offMainFix = (repo: string) => `make main the repository's default branch on GitHub, then run \`harness github-setup --repo ${repo}\``;

/** Whether the repository has the Actions secret, read with the owner's own `gh` login: undefined when it can't tell. */
export async function repositorySecret(repo: string, name: string): Promise<boolean | undefined> {
  const result = await run('gh', ['api', `repos/${repo}/actions/secrets/${name}`]).catch(() => undefined);
  if (result?.code === 0) return true;
  return /\(HTTP 404\)/.test(result?.stderr ?? '') ? false : undefined;
}

/** The ruleset on main, read with the owner's own `gh` login: the App may not read administration settings. */
export async function mainRuleset(repo: string): Promise<Ruleset | undefined> {
  const list = await run('gh', ['api', `repos/${repo}/rulesets`]).catch(() => undefined);
  if (list?.code !== 0) return undefined;
  const id = (JSON.parse(list.stdout) as Array<{ id: number; name: string }>).find((r) => r.name === 'harness: main')?.id;
  if (id === undefined) return { checks: [], integrations: {}, approvals: 0, codeOwners: false, active: false };
  const detail = await run('gh', ['api', `repos/${repo}/rulesets/${id}`]);
  if (detail.code !== 0) return undefined;
  const ruleset = JSON.parse(detail.stdout) as { enforcement: string; conditions?: { ref_name?: { include?: string[] } }; rules: Array<{ type: string; parameters?: Record<string, any> }> };
  // The harness's ruleset names the default branch, which must then be main.
  const include = ruleset.conditions?.ref_name?.include ?? [];
  let offMain: string | undefined;
  if (!include.includes('refs/heads/main')) {
    if (!include.includes('~DEFAULT_BRANCH')) offMain = "doesn't apply to main";
    else {
      const info = await run('gh', ['api', `repos/${repo}`, '--jq', '.default_branch']);
      if (info.code !== 0) return undefined;
      if (info.stdout.trim() !== 'main') offMain = `applies to the default branch, ${info.stdout.trim()}, not to main`;
    }
  }
  const pr = ruleset.rules.find((r) => r.type === 'pull_request')?.parameters ?? {};
  const checks = (ruleset.rules.find((r) => r.type === 'required_status_checks')?.parameters?.required_status_checks ?? []) as Array<{ context: string; integration_id?: number }>;
  return {
    checks: checks.map((c) => c.context),
    integrations: Object.fromEntries(checks.map((c) => [c.context, c.integration_id])),
    approvals: Number(pr.required_approving_review_count ?? 0),
    codeOwners: pr.require_code_owner_review === true,
    active: ruleset.enforcement === 'active',
    ...(offMain ? { offMain } : {}),
  };
}

async function providerExists(name: string): Promise<boolean> {
  const list = await run('openshell', ['provider', 'list']).catch(() => undefined);
  return new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s`, 'm').test(list?.stdout ?? '');
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Reads a secret without echoing it, typed or pasted: see `secretReader`. */
export function askSecret(question: string): Promise<string> {
  process.stdout.write(question);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  // Bracketed paste: the terminal marks what is pasted, so a token wrapped over two lines comes in whole.
  process.stdout.write(PASTE_MODE_ON);
  const reader = secretReader();
  return new Promise((resolve) => {
    const done = () => {
      stdin.off('data', onData);
      process.stdout.write(PASTE_MODE_OFF);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
    };
    const onData = (chunk: string) => {
      if (chunk.includes('\u0003')) {
        done();
        process.exit(130);
      }
      const answer = reader.feed(chunk);
      if (answer !== undefined) {
        done();
        resolve(answer);
      }
    };
    stdin.on('data', onData);
  });
}

const PASTE_MODE_ON = '\x1b[?2004h';
const PASTE_MODE_OFF = '\x1b[?2004l';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/**
 * A hidden answer, from the keys as they arrive. A program that prints a long token may
 * break it over two lines, and a copy then carries the line break: inside a paste, line
 * breaks don't end the answer, and neither does one with more of the same read after it,
 * for terminals that don't mark pastes. Only Enter does. Whitespace is dropped, since no
 * token or key has any; Backspace takes back a character.
 */
export function secretReader(): { feed(chunk: string): string | undefined } {
  let value = '';
  let pasting = false;
  return {
    feed(chunk) {
      let rest = chunk;
      while (rest.length > 0) {
        if (rest.startsWith(PASTE_START) || rest.startsWith(PASTE_END)) {
          pasting = rest.startsWith(PASTE_START);
          rest = rest.slice(PASTE_START.length);
          continue;
        }
        const ch = rest[0]!;
        rest = rest.slice(1);
        if (ch === '\r' || ch === '\n') {
          if (pasting || /[^\r\n]/.test(rest)) continue;
          return value;
        }
        if (ch === '\u007f') value = value.slice(0, -1);
        else if (!/\s/.test(ch)) value += ch;
      }
      return undefined;
    },
  };
}

const ok = (name: string, detail: string): Check => ({ status: 'ok', name, detail });
const warn = (name: string, detail: string, fix?: string): Check => ({ status: 'warn', name, detail, ...(fix ? { fix } : {}) });
const fail = (name: string, detail: string, fix?: string): Check => ({ status: 'fail', name, detail, ...(fix ? { fix } : {}) });
const firstLine = (text?: string) => (text ?? '').trim().split('\n')[0]?.slice(0, 200) ?? '';
const lastLine = (text?: string) => (text ?? '').trim().split('\n').at(-1)?.slice(0, 200) ?? '';
