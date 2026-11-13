import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { computeLock, directoryReader } from '../ci/harness-ci.ts';
import { ConfigSchema } from '../design/schemas.ts';
import { configDir } from '../github/app.ts';
import { ciFiles } from '../github/setup.ts';
import { run } from '../util.ts';

export interface InitOptions {
  projectDir: string;
  packageDir: string;
  version: string;
  /** The GitHub repository, like "acme/shop". By default, from the `origin` remote. */
  repo?: string;
  /** The owner's GitHub login, for CODEOWNERS. By default, from the owner's `gh`. */
  owner?: string;
}

/**
 * The files of the harness that main must hold as the working tree has them: the daemon
 * reads the config from main, and CI runs the workflow on it. CODEOWNERS and the lock are
 * the harness's too.
 */
export const MAIN_FILES = ['harness/config.json', '.github/workflows/harness.yml', '.github/harness/harness-ci.ts'];

/** Every file the harness writes into a project, but the README and ARCHITECTURE.md, which become the owner's. */
export const HARNESS_FILES = [...MAIN_FILES, 'harness/lock.json', '.github/CODEOWNERS', 'init.sh', '.gitignore'];

/** The setup steps: `harness setup` does what it can (v4 §4), and `harness doctor` checks them (§17.3). */
export const CHECKLIST = `Next: \`harness setup\` does these steps for you, and asks only for what is yours (a login,
a token, a click on GitHub). \`harness doctor\` checks them at any time. The steps:
  1. Docker, and OpenShell with a running gateway. Containers need outbound network.
  2. Claude subscription: run \`claude setup-token\`, then \`harness doctor\` in a terminal;
     it creates the provider with the token, at a hidden prompt.
  3. GitHub App: \`harness github-app create --org <org>\` once per machine, then install it
     on this repository only.
  4. Repository rules: \`harness github-setup --repo <owner/name>\`, with your own gh login.
  5. AWS, for infrastructure: create the roles the README lists, add \`aws\` and
     \`terraform\` to harness/config.json, then \`harness doctor\` stores the gateway key.
  6. Project files: review what \`harness init\` wrote, commit it and push it to main.
  7. Probe: \`harness doctor --probe\`.
Then \`harness up\`.`;

/**
 * Scaffolds the harness's files in a project repository (§17.2). It never overwrites a
 * file: what exists stays as it is.
 */
export async function init(options: InitOptions): Promise<{ wrote: string[]; kept: string[]; notes: string[] }> {
  const dir = options.projectDir;
  const top = await run('git', ['-C', dir, 'rev-parse', '--show-toplevel']).catch(() => undefined);
  // Real paths: a --dir through a symlink names the same folder.
  if (top?.code !== 0 || realpathSync(top.stdout.trim()) !== realpathSync(dir)) throw new Error(`${dir} isn't the top of a git repository: run \`harness init\` in the project's repository`);
  const wrote: string[] = [];
  const kept: string[] = [];
  const notes: string[] = [];
  const write = (path: string, content: string, mode?: number) => {
    const file = join(dir, path);
    if (existsSync(file)) return void kept.push(path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, content);
    if (mode) chmodSync(file, mode);
    wrote.push(path);
  };

  const repo = options.repo ?? githubRepo((await run('git', ['-C', dir, 'remote', 'get-url', 'origin'])).stdout.trim());
  const bot = appBot();
  const name = projectName(dir);
  const project: Record<string, string> = { name };
  if (repo && bot) Object.assign(project, { repo, bot });
  else notes.push(repo ? 'No GitHub App on this machine yet: `harness setup` creates it, and sets project.repo and project.bot in harness/config.json.' : 'No GitHub remote found: the project stays local until you set project.repo and project.bot.');
  // Checked before anything is written: a config the schema refuses would stop every later command.
  const config = checkedConfig({ harnessVersion: options.version, project, network: { bundles: ['all'] } });
  write('harness/config.json', `${JSON.stringify(config, null, 2)}\n`);

  const owner = options.owner ?? ((await run('gh', ['api', 'user', '--jq', '.login']).catch(() => undefined))?.stdout.trim() || undefined);
  for (const [path, content] of ciFiles(options.packageDir, owner)) write(path, content);
  if (!owner) notes.push('No owner login (pass --owner, or log in to gh): .github/CODEOWNERS wasn\'t written. `harness install-ci --owner <you>` writes it.');

  write('README.md', `# ${name}\n\nWhat this project is, and how to use it. The agents keep usage notes here.\n`);
  write('ARCHITECTURE.md', '# Architecture\n\nDecisions that hold across modules. The Architect records them here.\n');
  write('init.sh', [
    '#!/usr/bin/env bash',
    '# Prepares a fresh checkout for the checks: dependencies, build, local services. The',
    '# harness runs it in every check sandbox before the checks, so keep it idempotent.',
    'set -euo pipefail',
    '',
  ].join('\n'), 0o755);

  const ignore = join(dir, '.gitignore');
  const ignored = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
  if (!/^\/?\.harness\/?$/m.test(ignored)) {
    appendFileSync(ignore, `${ignored === '' || ignored.endsWith('\n') ? '' : '\n'}.harness/\n`);
    wrote.push('.gitignore');
  }

  const lock = await computeLock(directoryReader(dir));
  writeFileSync(join(dir, 'harness', 'lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  wrote.push('harness/lock.json');
  return { wrote, kept, notes };
}

/** The project's name, from its folder's: what the schema takes, at most 40 letters, digits and dashes. */
export function projectName(dir: string): string {
  return basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40).replace(/^-+|-+$/g, '') || 'project';
}

/** The config as it is to be written, or an error that says what the schema refuses in it. */
export function checkedConfig<T>(config: T): T {
  const result = ConfigSchema.safeParse(config);
  if (!result.success) throw new Error(`harness/config.json would not be valid, so nothing was written:\n${z.prettifyError(result.error)}`);
  return config;
}

/** "acme/shop" from a GitHub remote URL, in its https or ssh form. */
export function githubRepo(url: string): string | undefined {
  return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url)?.[1];
}

/** The App's bot login, if this machine has the App. */
export function appBot(): string | undefined {
  const file = join(configDir(), 'app.json');
  if (!existsSync(file)) return undefined;
  const { slug } = JSON.parse(readFileSync(file, 'utf8')) as { slug?: string };
  return slug ? `${slug}[bot]` : undefined;
}
