import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { webRead } from '../daemon/web-read.ts';
import { loadPty } from '../dashboard/terminals.ts';
import { ConfigSchema, requiredChecks, type Config } from '../design/schemas.ts';
import { GitHubClient, loadAppCredentials } from '../github/app.ts';
import { checkApp } from '../github/setup.ts';
import { BUNDLES } from '../sandbox/allowlist.ts';
import { OpenShellDriver } from '../sandbox/openshell.ts';
import { run } from '../util.ts';
import { probe, stateLocation } from './probe.ts';

/** The OpenShell release the harness is built and probed against (§17.4). */
export const OPENSHELL_VERSION = '0.1.2';
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

  await machine(options, image, report);
  await claude(options, claudeProvider, report);
  if (config) await project(options, config, report);
  else report({ status: 'skip', name: 'project', detail: 'no harness/config.json here', fix: 'run `harness init` in the project repository' });
  if (options.probe) {
    if (config) await probes(options, config, report);
    else report({ status: 'skip', name: 'probe', detail: 'the probe needs a project' });
  }
  return checks;
}

async function machine(options: DoctorOptions, image: string, report: (c: Check) => void): Promise<void> {
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
  report(/Status:\s*Connected/.test(status?.stdout ?? '') ? ok('OpenShell gateway', 'connected') : fail('OpenShell gateway', firstLine(status?.stdout || status?.stderr) || 'not running', 'start the gateway: `openshell gateway start`'));

  const host = await run('claude', ['--version']).catch(() => undefined);
  const hostClaude = /^(\S+)/.exec(host?.stdout ?? '')?.[1];
  report(hostClaude ? ok('Claude Code', hostClaude) : fail('Claude Code', 'not found', 'install Claude Code: the agents\' image takes it from this machine'));

  if (options.buildImages) {
    const built = await run('bash', [join(options.packageDir, 'images', 'agent', 'build.sh'), image]);
    report(built.code === 0 ? ok('image build', image) : fail('image build', lastLine(built.stderr || built.stdout), 'see the output of images/agent/build.sh'));
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
}

/** The Claude subscription provider (§17.3, step 2): the profile, then the provider with the owner's token. */
async function claude(options: DoctorOptions, provider: string, report: (c: Check) => void): Promise<void> {
  const profiles = await run('openshell', ['profile', 'list']).catch(() => undefined);
  if (!/^claude-code-subscription\s/m.test(profiles?.stdout ?? '')) {
    const imported = await run('openshell', ['profile', 'import', '-f', join(options.packageDir, 'templates', 'openshell', 'claude-code-subscription.yaml'), '--global']);
    report(imported.code === 0 ? ok('Claude profile', 'imported') : fail('Claude profile', firstLine(imported.stderr), 'see `openshell profile import --help`'));
  }
  if (await providerExists(provider)) return report(ok('Claude provider', provider));
  if (!options.interactive) {
    return report(fail('Claude provider', `${provider} is missing`, 'run `claude setup-token`, then `harness doctor` in a terminal: it asks for the token'));
  }
  const token = await askSecret(`Claude provider ${provider} is missing. Paste the token from \`claude setup-token\` (hidden): `);
  if (!token) return report(fail('Claude provider', 'no token given', 'run `harness doctor` again'));
  // The token reaches OpenShell through the environment of one command, never its arguments.
  const created = await run('openshell', ['provider', 'create', '--name', provider, '--type', 'claude-code-subscription', '--from-existing'], {
    env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token },
  });
  report(created.code === 0 ? ok('Claude provider', `${provider} created`) : fail('Claude provider', firstLine(created.stderr), 'see `openshell provider create --help`'));
}

async function project(options: DoctorOptions, config: Config, report: (c: Check) => void): Promise<void> {
  report(ok('harness/config.json', `project ${config.project.name}`));
  const repo = config.project.repo;
  if (!repo) {
    report({ status: 'skip', name: 'GitHub', detail: 'no project.repo: the project stays local' });
  } else {
    try {
      const lines = await checkApp(repo);
      report(ok('GitHub App', lines.find((l) => l.startsWith('App:'))?.slice(5) ?? 'installed'));
    } catch (error) {
      report(fail('GitHub App', firstLine((error as Error).message), 'create it with `harness github-app create --org <org>`, and install it on the repository'));
    }
    const ruleset = await mainRuleset(repo);
    if (!ruleset) {
      report(warn('ruleset', 'not readable with your gh login', 'install and log in to gh to check it, or apply it with `harness github-setup`'));
    } else {
      const missing = requiredChecks(config).filter((c) => !ruleset.checks.includes(c));
      report(missing.length === 0 && ruleset.active ? ok('ruleset', `requires ${ruleset.checks.join(', ')}`) : fail('ruleset', missing.length ? `doesn't require ${missing.join(', ')}` : 'not active', `run \`harness github-setup --repo ${repo}\``));
    }
    for (const file of ['.github/workflows/harness.yml', '.github/harness/harness-ci.ts']) {
      const local = join(options.projectDir, file);
      const packaged = join(options.packageDir, file.endsWith('.yml') ? 'templates/harness.yml' : 'src/ci/harness-ci.ts');
      if (!existsSync(local)) report(fail(file, 'missing', 'run `harness install-ci`, and commit the files'));
      else if (readFileSync(local, 'utf8') !== readFileSync(packaged, 'utf8')) report(warn(file, 'differs from this version of the harness', 'run `harness install-ci`, and commit the files'));
      else report(ok(file, 'up to date'));
    }
  }
  if (config.aws) await aws(options, config, report);
  if (config.terraform) {
    const tf = config.terraform;
    for (const file of [tf.backendConfig, tf.varFile]) {
      report(existsSync(join(options.projectDir, tf.dir, file)) ? ok('Terraform', `${tf.dir}/${file}`) : fail('Terraform', `${tf.dir}/${file} is missing`, 'see harness/config.json under terraform'));
    }
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
  const role = await ask('The project\'s view role ARN: ');
  const keyId = await ask('The harness-gateway user\'s AccessKeyId: ');
  const secret = await askSecret('Its SecretAccessKey (hidden): ');
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
    if (result.code !== 0) return report(fail('AWS provider', `openshell ${args.slice(0, 3).join(' ')}: ${firstLine(result.stderr)}`, 'fix it, then run `harness doctor` again'));
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
      for (const result of await probe({ driver: new OpenShellDriver(), config: roleConfig, scratch, ...(state ? { state } : {}) })) {
        report({ status: result.skipped ? 'skip' : result.ok ? 'ok' : 'fail', name: `probe (${label})`, detail: `${result.name}: ${result.detail}` });
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  const refused = await webRead('http://192.168.1.1/');
  report(!refused.ok ? ok('probe (outside)', `web_read refuses a private address: ${refused.text}`) : fail('probe (outside)', 'web_read read a private address'));
  if (config.project.repo) {
    report(await workflowPushRefused(config.project.repo));
    const ruleset = await mainRuleset(config.project.repo);
    report(ruleset
      ? (ruleset.approvals >= 1 && ruleset.codeOwners && ruleset.active ? ok('probe (outside)', `main needs ${ruleset.approvals} code owner approval to merge`) : fail('probe (outside)', 'main can be merged without the owner\'s approval', `run \`harness github-setup --repo ${config.project.repo}\``))
      : warn('probe (outside)', 'the ruleset is not readable with your gh login', 'install and log in to gh'));
  }
}

/** The App tries to push a workflow to a new branch. GitHub must refuse it: the App has no workflow permission. */
async function workflowPushRefused(repo: string): Promise<Check> {
  const dir = mkdtempSync(join(tmpdir(), 'harness-probe-git-'));
  try {
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

/** The ruleset on main, read with the owner's own `gh` login: the App may not read administration settings. */
async function mainRuleset(repo: string): Promise<{ checks: string[]; approvals: number; codeOwners: boolean; active: boolean } | undefined> {
  const list = await run('gh', ['api', `repos/${repo}/rulesets`]).catch(() => undefined);
  if (list?.code !== 0) return undefined;
  const id = (JSON.parse(list.stdout) as Array<{ id: number; name: string }>).find((r) => r.name === 'harness: main')?.id;
  if (id === undefined) return { checks: [], approvals: 0, codeOwners: false, active: false };
  const detail = await run('gh', ['api', `repos/${repo}/rulesets/${id}`]);
  if (detail.code !== 0) return undefined;
  const ruleset = JSON.parse(detail.stdout) as { enforcement: string; rules: Array<{ type: string; parameters?: Record<string, any> }> };
  const pr = ruleset.rules.find((r) => r.type === 'pull_request')?.parameters ?? {};
  const checks = ruleset.rules.find((r) => r.type === 'required_status_checks')?.parameters?.required_status_checks ?? [];
  return {
    checks: (checks as Array<{ context: string }>).map((c) => c.context),
    approvals: Number(pr.required_approving_review_count ?? 0),
    codeOwners: pr.require_code_owner_review === true,
    active: ruleset.enforcement === 'active',
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

/** Reads a secret without echoing it. */
function askSecret(question: string): Promise<string> {
  process.stdout.write(question);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve) => {
    let value = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\u0003') process.exit(130);
        if (ch === '\r' || ch === '\n') {
          stdin.off('data', onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write('\n');
          return resolve(value.trim());
        }
        value = ch === '\u007f' ? value.slice(0, -1) : value + ch;
      }
    };
    stdin.on('data', onData);
  });
}

const ok = (name: string, detail: string): Check => ({ status: 'ok', name, detail });
const warn = (name: string, detail: string, fix?: string): Check => ({ status: 'warn', name, detail, ...(fix ? { fix } : {}) });
const fail = (name: string, detail: string, fix?: string): Check => ({ status: 'fail', name, detail, ...(fix ? { fix } : {}) });
const firstLine = (text?: string) => (text ?? '').trim().split('\n')[0]?.slice(0, 200) ?? '';
const lastLine = (text?: string) => (text ?? '').trim().split('\n').at(-1)?.slice(0, 200) ?? '';
