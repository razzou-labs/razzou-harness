import { basename, join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { computeLock, directoryReader } from '../ci/harness-ci.ts';
import { ConfigSchema, requiredChecks, type Config } from '../design/schemas.ts';
import { configDir, loadAppCredentials } from '../github/app.ts';
import { applyRepositoryRules, checkApp, createApp, installCi, type RulesetOptions } from '../github/setup.ts';
import type { Mode, State } from '../state/state.ts';
import { run, sha256 } from '../util.ts';
import { doctor, granted, type Check } from './doctor.ts';
import { appBot, githubRepo, init } from './init.ts';
import { writeTerraformScaffold, type TerraformLayout, type TerraformScaffold } from './terraform.ts';

/**
 * `harness setup` (proposal v4 §4): the doctor with hands. It walks the setup in order,
 * does every step the harness can, and stops only for what is the owner's: a login at
 * the terminal, a token or a key at a hidden prompt, a click where GitHub has no API.
 * It can run again at any time: what is done is skipped.
 */
export interface SetupOptions {
  projectDir: string;
  packageDir: string;
  version: string;
  /** The GitHub repository, like "acme/shop"; by default from the `origin` remote. */
  repo?: string;
  /** The owner's GitHub login, for CODEOWNERS; by default from `gh`. */
  owner?: string;
  say: (line: string) => void;
  ask: (question: string) => Promise<string>;
  /** Opens a page in the owner's browser. */
  open: (url: string) => void;
  /** Runs a program with the owner's terminal, like `gh auth login`, and returns its exit code. */
  interactive: (file: string, args: string[]) => number;
  /** Starts the daemon, at the end. */
  up: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

/** What `harness setup` does about a check the doctor reported; the pure part, for tests. */
export type Fix =
  | { kind: 'start-gateway' }
  | { kind: 'build-image' }
  | { kind: 'create-app' }
  | { kind: 'install-app' }
  | { kind: 'app-statuses' }
  | { kind: 'apply-rules' }
  | { kind: 'install-ci' };

export function fixFor(check: Check): Fix | undefined {
  if (check.status === 'ok' || check.status === 'skip') return undefined;
  switch (check.name) {
    case 'OpenShell gateway':
      return { kind: 'start-gateway' };
    case 'image':
      return { kind: 'build-image' };
    case 'GitHub App':
      if (check.detail.startsWith('no GitHub App in')) return { kind: 'create-app' };
      if (check.detail.includes("can't write commit statuses")) return { kind: 'app-statuses' };
      return { kind: 'install-app' };
    case 'ruleset':
      // The ruleset applies to the default branch: making main the default is the owner's.
      return check.detail.includes('default branch') ? undefined : { kind: 'apply-rules' };
    case '.github/workflows/harness.yml':
    case '.github/harness/harness-ci.ts':
      return { kind: 'install-ci' };
    default:
      return undefined;
  }
}

/**
 * The OpenShell provider of the project's AWS view role. Providers are per machine: it is
 * named after the repository, or else after the folder and a hash of its path, so two
 * projects in folders of the same name never share one.
 */
export function awsProviderName(projectDir: string, repo?: string): string {
  const safe = (text: string) => text.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return repo ? `aws-view-${safe(repo)}` : `aws-view-${safe(basename(projectDir)) || 'project'}-${sha256(resolve(projectDir)).slice(0, 8)}`;
}

const VIEW_ROLE = /^arn:aws:iam::\d{12}:role\/harness-[\w+=,.@-]+-view$/;
const ROLE = /^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]+$/;

export async function setup(options: SetupOptions): Promise<void> {
  const { projectDir, say } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  await ghLogin(options);
  const scaffolded = await scaffold(options, sleep);
  const settings = await askSettings(options);
  await commitAndPush(options, [...scaffolded, ...settings.written]);

  const config = loadConfig(projectDir);
  if (!config) throw new Error('harness/config.json is missing after init: run `harness setup` again');
  let buildImages = false;
  for (let round = 1; round <= 3; round++) {
    say(round === 1 ? '\nChecking this machine and the project:' : '\nChecking again:');
    const checks = await doctor({
      projectDir, packageDir: options.packageDir, version: options.version, probe: false, buildImages, interactive: true,
      ...(settings.viewRole ? { awsViewRole: settings.viewRole } : {}), report: (c) => say(line(c)),
    });
    buildImages = false;
    let again = false;
    for (const check of checks) {
      const fix = fixFor(check);
      if (!fix) continue;
      if (fix.kind === 'build-image') {
        buildImages = true;
        again = true;
        continue;
      }
      if (await applyFix(options, config, fix, sleep)) again = true;
    }
    if (!again) break;
  }

  say('\nThe probe: everything an agent must not do, tried.');
  const probe = await doctor({ projectDir, packageDir: options.packageDir, version: options.version, probe: true, buildImages: false, interactive: false, report: (c) => { if (c.name.startsWith('probe')) say(line(c)); } });
  const failed = probe.filter((c) => c.status === 'fail');
  if (failed.length > 0) {
    say(`\n${failed.length} problem${failed.length === 1 ? '' : 's'} left: ${failed.map((c) => c.name).join(', ')}. Fix them, then run \`harness setup\` again.`);
    return;
  }
  say('\nAll good.');
  if (!/^n/i.test(await options.ask('Start the daemon now? [Y/n] '))) await options.up();
}

/** gh must be logged in as an admin of the repository: it applies the rules and creates the repository. */
async function ghLogin(options: SetupOptions): Promise<void> {
  const status = await run('gh', ['auth', 'status']).catch(() => undefined);
  if (status === undefined) throw new Error('gh is not installed: install the GitHub CLI, then run `harness setup` again');
  if (status.code === 0) return;
  options.say('GitHub: log in with gh, as an admin of the project\'s repository. It opens a browser, or asks for a token.');
  options.interactive('gh', ['auth', 'login']);
  const after = await run('gh', ['auth', 'status']);
  if (after.code !== 0) throw new Error('gh is still not logged in: the setup needs it for the repository\'s rules');
}

/**
 * The harness's files, when the project has none yet: a repository on GitHub first, if
 * the owner wants one, and the App, which the config needs for project.repo and
 * project.bot. On a later run, what changed since: the CI files, and the repository.
 */
async function scaffold(options: SetupOptions, sleep: (ms: number) => Promise<void>): Promise<string[]> {
  const { projectDir, say } = options;
  if (existsSync(join(projectDir, 'harness', 'config.json'))) {
    // The CI files follow the harness's version: written again when they differ, and committed with the rest.
    const stale = ['.github/workflows/harness.yml', '.github/harness/harness-ci.ts'].filter((file) => {
      const local = join(projectDir, file);
      const packaged = join(options.packageDir, file.endsWith('.yml') ? 'templates/harness.yml' : 'src/ci/harness-ci.ts');
      return !existsSync(local) || readFileSync(local, 'utf8') !== readFileSync(packaged, 'utf8');
    });
    const written = stale.length === 0 ? [] : installCi(projectDir, options.packageDir, options.owner ?? (await ownerLogin(options)));
    for (const path of written) say(`wrote ${path}`);
    return [...written, ...(await linkRepo(options, sleep))];
  }
  const top = await run('git', ['-C', projectDir, 'rev-parse', '--show-toplevel']).catch(() => undefined);
  if (top?.code !== 0) {
    await run('git', ['init', '--quiet', '--initial-branch=main', projectDir]);
    say('git: a new repository, on main.');
  }
  let repo = options.repo ?? githubRepo((await run('git', ['-C', projectDir, 'remote', 'get-url', 'origin'])).stdout.trim());
  if (!repo) {
    const name = basename(projectDir).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
    const answer = (await options.ask(`No GitHub remote. Create a private repository on GitHub? Type org/name (like acme/${name}), or Enter to stay local: `)).trim();
    if (answer) {
      const created = await run('gh', ['repo', 'create', answer, '--private', `--source=${projectDir}`, '--remote=origin']);
      if (created.code !== 0) throw new Error(`gh repo create: ${(created.stderr || created.stdout).trim()}`);
      say(`created https://github.com/${answer}`);
      repo = answer;
    }
  }
  // Without the App, init would leave project.repo and project.bot out, and the project local.
  if (repo && !appBot()) await createAndInstallApp(options, repo, sleep);
  const result = await init({ projectDir, packageDir: options.packageDir, version: options.version, ...(repo ? { repo } : {}), ...(options.owner ? { owner: options.owner } : {}) });
  for (const path of result.wrote) say(`wrote ${path}`);
  for (const path of result.kept) say(`kept  ${path} (it exists)`);
  for (const note of result.notes) say(note);
  return result.wrote;
}

/**
 * project.repo and project.bot, when the config has none but the project has a GitHub
 * remote: an earlier run, or `harness init`, found no App on this machine. The App is
 * created if it still isn't there, and the lock follows the config.
 */
export async function linkRepo(options: SetupOptions, sleep: (ms: number) => Promise<void>): Promise<string[]> {
  const { projectDir, say } = options;
  const configFile = join(projectDir, 'harness', 'config.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, any>;
  if (config.project?.repo) return [];
  const repo = options.repo ?? githubRepo((await run('git', ['-C', projectDir, 'remote', 'get-url', 'origin'])).stdout.trim());
  if (!repo) return [];
  if (!appBot()) await createAndInstallApp(options, repo, sleep);
  const bot = appBot();
  if (!bot) return [];
  config.project = { ...config.project, repo, bot };
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  await writeLock(projectDir);
  say(`harness/config.json: the project is ${repo} on GitHub, and the App's bot ${bot}.`);
  return ['harness/config.json', 'harness/lock.json'];
}

/** The App, created from its manifest in the owner's browser (M8), then installed on the repository (M9). */
async function createAndInstallApp(options: SetupOptions, repo: string, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  const org = repo.split('/')[0]!;
  options.say(`No GitHub App on this machine: the harness needs one for ${repo}, and the config its bot.`);
  const app = await createApp({
    org,
    name: `${org}-harness`,
    onReady: (url) => {
      options.say(`GitHub App: review it in the browser and click "Create GitHub App": ${url}`);
      options.open(url);
    },
  });
  options.say(`created ${app.name} (id ${app.appId}).`);
  return waitForInstall(options, repo, app.slug, sleep);
}

async function writeLock(projectDir: string): Promise<void> {
  const lock = await computeLock(directoryReader(projectDir));
  writeFileSync(join(projectDir, 'harness', 'lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
}

/** The owner's GitHub login from gh, for CODEOWNERS. */
async function ownerLogin(options: SetupOptions): Promise<string | undefined> {
  const login = await run('gh', ['api', 'user', '--jq', '.login']).catch(() => undefined);
  if (login?.code !== 0 || !login.stdout.trim()) options.say('No owner login from gh: CODEOWNERS is not written. `harness install-ci --owner <you>` writes it.');
  return login?.code === 0 ? login.stdout.trim() || undefined : undefined;
}

/**
 * The questions (v4 §4), asked once: AWS, and the owner's hours. The network needs none:
 * a project gets every bundle unless its config lists fewer. What they settle goes into
 * harness/config.json, with the lock that hashes it, and into .harness/setup.json for
 * the daemon. The view role's ARN goes to the doctor, which creates the AWS provider
 * with it.
 */
async function askSettings(options: SetupOptions): Promise<{ written: string[]; viewRole?: string }> {
  const { projectDir, say, ask } = options;
  const configFile = join(projectDir, 'harness', 'config.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, any>;
  const written: string[] = [];
  let changed = false;
  let viewRole: string | undefined;
  let account: string | undefined;

  if (!config.aws && /^y/i.test(await ask('Does this project deploy to AWS with Terraform? [y/N] '))) {
    say('The roles come from your bootstrap (see the README\'s AWS section); the key is asked for later, at a hidden prompt.');
    const region = (await ask('AWS region (like eu-west-1): ')).trim();
    const view = (await ask("The agents' view role ARN (arn:aws:iam::<account>:role/harness-<project>-view): ")).trim();
    const plan = (await ask('The CI plan role ARN: ')).trim();
    const apply = (await ask('The CI apply role ARN: ')).trim();
    if (!region || !VIEW_ROLE.test(view) || !ROLE.test(plan) || !ROLE.test(apply)) {
      say('AWS skipped: a value is missing or malformed. Add `aws` and `terraform` to harness/config.json by hand, or run `harness setup` again.');
    } else {
      config.aws = { region, provider: awsProviderName(projectDir, config.project?.repo), services: ['all'] };
      config.terraform = { dir: 'iac', backendConfig: 'backend-configs/staging.hcl', varFile: 'env/staging.tfvars' };
      changed = true;
      viewRole = view;
      const repo = config.project?.repo as string | undefined;
      if (repo) await configureGitHubForAws(options, repo, { region, plan, apply });
      account = /^arn:aws:iam::(\d{12}):/.exec(view)![1]!;
    }
  }

  // The Terraform scaffold the bootstrap expects, which the doctor checks: whatever of it is
  // missing, on this run or a later one. A later run reads the account from the plan role
  // this one stored on GitHub.
  if (config.aws?.region && config.terraform) {
    const repo = config.project?.repo as string | undefined;
    account ??= /^arn:aws:iam::(\d{12}):/.exec((await githubVariable(repo, 'AWS_ROLE_PLAN_ARN_STAGING')) ?? '')?.[1];
    if (account) {
      const layout = { dir: 'iac', backendConfig: 'backend-configs/staging.hcl', varFile: 'env/staging.tfvars', ...(config.terraform as object) } as TerraformLayout;
      // As the schema reads it: `iac`, `./iac` and `iac/` are one folder. Slashes are trimmed by hand: a regex would take quadratic time on a long run of them.
      let dir = layout.dir;
      while (dir.startsWith('./') || dir.startsWith('/')) dir = dir.slice(dir.startsWith('./') ? 2 : 1);
      while (dir.endsWith('/')) dir = dir.slice(0, -1);
      layout.dir = dir || 'iac';
      const scaffold = writeTerraformScaffold(projectDir, layout, await terraformFacts(repo, String(config.project?.name ?? 'project'), String(config.aws.region), account));
      if (scaffold.length > 0) say(`Terraform: wrote ${scaffold.join(', ')}.`);
      written.push(...scaffold);
    }
  }

  if (changed) {
    writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
    await writeLock(projectDir);
    written.push('harness/config.json', 'harness/lock.json');
  }

  // setup.json may hold a mode `harness mode` recorded: the hours join it.
  const pendingFile = join(projectDir, '.harness', 'setup.json');
  const pending = existsSync(pendingFile) ? (JSON.parse(readFileSync(pendingFile, 'utf8')) as Record<string, unknown>) : {};
  const stateFile = join(projectDir, '.harness', 'state.json');
  const budgeted = existsSync(stateFile) && (JSON.parse(readFileSync(stateFile, 'utf8')) as State).budgets?.ownerHours !== undefined;
  if (pending.ownerHours === undefined && !budgeted) {
    const answer = (await ask('How many hours of your time may this whole project take? The Architect designs your actions within it. (Enter to skip) ')).trim();
    const hours = Number(answer);
    if (answer && Number.isFinite(hours) && hours > 0) {
      mkdirSync(join(projectDir, '.harness'), { recursive: true });
      writeFileSync(pendingFile, `${JSON.stringify({ ...pending, ownerHours: hours }, null, 2)}\n`);
      say(`${hours} hours: the daemon records it when it starts.`);
    }
  }
  return { written, ...(viewRole ? { viewRole } : {}) };
}

/**
 * Where the project's state lives, and its repository's numeric ids: read from GitHub, where
 * the bootstrap's configure-github.sh set TF_STATE_BUCKET_STAGING and TF_STATE_KEY_STAGING,
 * or else by the bootstrap's naming, `tf-state-staging-<account>` and
 * `staging/<repository>/terraform.tfstate`.
 */
async function terraformFacts(repo: string | undefined, name: string, region: string, account: string): Promise<TerraformScaffold> {
  const bucket = await githubVariable(repo, 'TF_STATE_BUCKET_STAGING');
  const key = await githubVariable(repo, 'TF_STATE_KEY_STAGING');
  const ids = (await ghApi(repo, `repos/${repo}`, '"\\(.owner.id) \\(.id)"'))?.split(' ');
  return {
    region,
    account,
    bucket: bucket ?? `tf-state-staging-${account}`,
    key: key ?? `staging/${repo ? repo.split('/')[1] : name}/terraform.tfstate`,
    ...(repo && ids?.length === 2 ? { github: { repo, ownerId: ids[0]!, repoId: ids[1]! } } : {}),
  };
}

/** What the owner's gh reads at `path`, through `jq`; undefined without a repository, or on any failure. */
async function ghApi(repo: string | undefined, path: string, jq: string): Promise<string | undefined> {
  const result = repo ? await run('gh', ['api', path, '--jq', jq]).catch(() => undefined) : undefined;
  return result?.code === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
}

const githubVariable = (repo: string | undefined, name: string) => ghApi(repo, `repos/${repo}/actions/variables/${name}`, '.value');

/** The staging environment, restricted to main, and the variables the workflow reads, with the owner's gh. */
async function configureGitHubForAws(options: SetupOptions, repo: string, aws: { region: string; plan: string; apply: string }): Promise<void> {
  const gh = async (args: string[], body?: object) => {
    const result = await run('gh', ['api', ...args, ...(body ? ['--input', '-'] : [])], body ? { input: JSON.stringify(body) } : {});
    if (result.code !== 0) throw new Error(`gh api ${args.join(' ')}: ${(result.stderr || result.stdout).trim()}`);
  };
  await gh(['--method', 'PUT', `/repos/${repo}/environments/staging`], { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } });
  await gh(['--method', 'POST', `/repos/${repo}/environments/staging/deployment-branch-policies`], { name: 'main', type: 'branch' }).catch(() => {});
  for (const [name, value] of [['AWS_REGION_STAGING', aws.region], ['AWS_ROLE_PLAN_ARN_STAGING', aws.plan], ['AWS_ROLE_APPLY_ARN_STAGING', aws.apply]] as const) {
    const set = await run('gh', ['variable', 'set', name, '--repo', repo, '--body', value]);
    if (set.code !== 0) throw new Error(`gh variable set ${name}: ${(set.stderr || set.stdout).trim()}`);
  }
  options.say(`GitHub: the staging environment, for main only, and the variables ${['AWS_REGION_STAGING', 'AWS_ROLE_PLAN_ARN_STAGING', 'AWS_ROLE_APPLY_ARN_STAGING'].join(', ')}.`);
}

/** The setup's commit message, by which a later run finds the commit unpushed. */
const SETUP_COMMIT = 'Set up razzou-harness';

/**
 * The files the setup wrote, committed with the owner's git once they agree, and pushed
 * to main: before the ruleset, which would refuse the push. The commit holds those files
 * only, and only main is pushed. A setup commit on main that origin hasn't, after a push
 * refused or declined, is offered again.
 */
export async function commitAndPush(options: Pick<SetupOptions, 'projectDir' | 'say' | 'ask'>, paths: string[]): Promise<void> {
  const { projectDir, say } = options;
  const git = (args: string[]) => run('git', ['-C', projectDir, ...args]);
  const tracked = paths.filter((p) => !p.startsWith('.harness/'));
  const status = tracked.length > 0 ? (await git(['status', '--porcelain', '--', ...tracked])).stdout : '';
  const changed = status.split('\n').filter((l) => l.trim() !== '').map((l) => l.slice(3));
  if (changed.length > 0) {
    const branch = (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim() || 'a detached HEAD';
    const files = `${changed.length} file${changed.length === 1 ? '' : 's'}`;
    say(`\nTo commit on ${branch}: ${changed.join(', ')}`);
    const question = branch === 'main' ? `Commit and push ${files} to main, as you? [Y/n] ` : `Commit ${files} on ${branch}, as you? The setup pushes only main. [Y/n] `;
    if (/^n/i.test(await options.ask(question))) return say('Commit them, and push them to main yourself before `harness up`.');
    const add = await git(['add', '--', ...changed]);
    if (add.code !== 0) throw new Error(`git add: ${add.stderr.trim()}`);
    // These files only: whatever the owner had staged stays staged, out of the commit.
    const commit = await git(['commit', '--quiet', '-m', SETUP_COMMIT, '--', ...changed]);
    if (commit.code !== 0) throw new Error(`git commit: ${(commit.stderr || commit.stdout).trim()}`);
    if (branch !== 'main') {
      const sha = (await git(['rev-parse', '--short', 'HEAD'])).stdout.trim();
      return say(`committed on ${branch} (${sha}), not pushed: the setup pushes only main. Bring the commit to main (\`git switch main && git cherry-pick ${sha}\`, or \`git branch -m main\` if ${branch} is your main line), then run \`harness setup\` again: it offers the push.`);
    }
  } else if (!(await unpushedSetup(projectDir))) {
    return;
  } else if (/^n/i.test(await options.ask("main has the setup's commit, and origin's main doesn't yet. Push main, as you? [Y/n] "))) {
    return say('Push main yourself before `harness up`.');
  }
  const committed = changed.length > 0;
  if ((await git(['remote', 'get-url', 'origin'])).code !== 0) return say('committed; no origin to push to.');
  const push = await git(['push', '--quiet', '-u', 'origin', 'main']);
  if (push.code !== 0) say(`${committed ? 'committed, but ' : ''}the push was refused: ${push.stderr.trim()}\nRun \`harness setup\` again to retry, or push main yourself.`);
  else say(committed ? 'committed and pushed to main.' : 'pushed to main.');
}

/** Whether local main has a setup commit that origin's main hasn't, as of the last fetch or push. */
async function unpushedSetup(projectDir: string): Promise<boolean> {
  const git = (args: string[]) => run('git', ['-C', projectDir, ...args]);
  if ((await git(['remote', 'get-url', 'origin'])).code !== 0) return false;
  const known = (await git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'])).code === 0;
  const unpushed = await git(['log', '--format=%h', '--fixed-strings', `--grep=${SETUP_COMMIT}`, 'refs/heads/main', ...(known ? ['^refs/remotes/origin/main'] : [])]);
  return unpushed.code === 0 && unpushed.stdout.trim() !== '';
}

/** One fix, with the owner's part if any; true when something changed and the doctor should look again. */
async function applyFix(options: SetupOptions, config: Config, fix: Fix, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  const { projectDir, say } = options;
  const repo = config.project.repo;
  switch (fix.kind) {
    case 'start-gateway': {
      // OpenShell's Debian package runs the gateway as a systemd user service; its CLI has no command to start it.
      const started = await run('systemctl', ['--user', 'start', 'openshell-gateway']).catch(() => undefined);
      if (started?.code === 0) say('OpenShell: gateway started.');
      else say(`OpenShell: the gateway did not start: ${(started?.stderr || started?.stdout || 'systemctl is missing').trim()}`);
      return started?.code === 0;
    }
    case 'create-app':
      return repo ? createAndInstallApp(options, repo, sleep) : false;
    case 'install-app': {
      if (!repo) return false;
      let slug: string | undefined;
      try {
        slug = loadAppCredentials().slug;
      } catch {
        return false;
      }
      return waitForInstall(options, repo, slug, sleep);
    }
    case 'app-statuses': {
      if (!repo) return false;
      const { slug } = loadAppCredentials();
      const info = JSON.parse(readFileSync(join(configDir(), 'app.json'), 'utf8')) as { owner?: string };
      const settings = info.owner ? `https://github.com/organizations/${info.owner}/settings/apps/${slug}/permissions` : `https://github.com/settings/apps/${slug}/permissions`;
      say(`GitHub App: give it "Commit statuses: Read and write" and save: ${settings}`);
      say(`Then accept the new permission on its installation: https://github.com/organizations/${repo.split('/')[0]}/settings/installations`);
      options.open(settings);
      // What the installation accepted, as the doctor reads it: the App's own permission alone grants nothing yet.
      return waitUntil(options, 'the installation grants "Commit statuses: write"', sleep, async () => {
        try {
          return granted(await checkApp(repo), 'statuses') === 'write';
        } catch {
          return false;
        }
      });
    }
    case 'apply-rules': {
      if (!repo) return false;
      const stateFile = join(projectDir, '.harness', 'state.json');
      const mode: Mode = existsSync(stateFile) ? ((JSON.parse(readFileSync(stateFile, 'utf8')) as State).mode ?? 'manual') : 'manual';
      let ruleset: RulesetOptions = { mode };
      if (mode === 'swarm') {
        let appId: number | undefined;
        try {
          appId = loadAppCredentials().appId;
        } catch {
          appId = undefined;
        }
        ruleset = { mode, statuses: config.swarm.requiredStatuses, ...(appId !== undefined ? { appId } : {}) };
      }
      try {
        for (const done of await applyRepositoryRules(repo, requiredChecks(config), ruleset)) say(`set: ${done}`);
        return true;
      } catch (error) {
        // A free organization's private repository has no rulesets: the setup goes on, and the probe reports main unprotected.
        const message = (error as Error).message;
        const plan = /upgrade|make this repository public/i.test(message)
          ? '\nRulesets on a private repository need a paid GitHub plan, such as Team for an organization; a public repository has them for free. Without them, nothing on GitHub makes code wait for your review before it reaches main.'
          : '';
        say(`GitHub: the rules on main were not applied: ${message}${plan}`);
        return false;
      }
    }
    case 'install-ci': {
      const owner = options.owner ?? (await ownerLogin(options));
      for (const path of installCi(projectDir, options.packageDir, owner)) say(`wrote ${path}`);
      say('Commit and push the CI files yourself: the App may not change workflows.');
      return false;
    }
    default:
      return false;
  }
}

/** The App must be installed by the owner, in the browser: the page is opened, and the setup waits for the installation to show. */
async function waitForInstall(options: SetupOptions, repo: string, slug: string, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  const url = `https://github.com/apps/${slug}/installations/new`;
  options.say(`GitHub App: install it on ${repo}, and on that repository only: ${url}`);
  options.open(url);
  return waitUntil(options, `the App is installed on ${repo}`, sleep, async () => {
    try {
      await checkApp(repo);
      return true;
    } catch {
      return false;
    }
  });
}

/** Polls every five seconds, for up to fifteen minutes, saying what it waits for. */
async function waitUntil(options: SetupOptions, what: string, sleep: (ms: number) => Promise<void>, done: () => Promise<boolean>): Promise<boolean> {
  options.say(`Waiting until ${what}...`);
  for (let i = 0; i < 180; i++) {
    if (await done()) {
      options.say(`${what}.`);
      return true;
    }
    await sleep(5_000);
  }
  options.say(`Still waiting for ${what} after fifteen minutes: run \`harness setup\` again once it is done.`);
  return false;
}

function loadConfig(projectDir: string): Config | undefined {
  const file = join(projectDir, 'harness', 'config.json');
  return existsSync(file) ? ConfigSchema.parse(JSON.parse(readFileSync(file, 'utf8'))) : undefined;
}

const MARKS = { ok: 'ok  ', warn: 'warn', fail: 'FAIL', skip: 'skip' };
const line = (check: Check): string => `${MARKS[check.status]}  ${check.name}: ${check.detail}${check.fix ? `\n      → ${check.fix}` : ''}`;
