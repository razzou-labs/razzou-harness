import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { computeLock, directoryReader } from '../ci/harness-ci.ts';
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

/** The setup steps that `harness doctor` checks (§17.3). */
export const CHECKLIST = `Setup checklist (\`harness doctor\` checks it):
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
  if (top?.code !== 0 || top.stdout.trim() !== dir) throw new Error(`${dir} isn't the top of a git repository: run \`harness init\` in the project's repository`);
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
  const name = basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  const project: Record<string, string> = { name };
  if (repo && bot) Object.assign(project, { repo, bot });
  else notes.push(repo ? 'No GitHub App on this machine yet: create it, then set project.repo and project.bot in harness/config.json.' : 'No GitHub remote found: the project stays local until you set project.repo and project.bot.');
  write('harness/config.json', `${JSON.stringify({ harnessVersion: options.version, project, network: { bundles: ['core'] } }, null, 2)}\n`);

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

/** "acme/shop" from a GitHub remote URL, in its https or ssh form. */
export function githubRepo(url: string): string | undefined {
  return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url)?.[1];
}

/** The App's bot login, if this machine has the App. */
function appBot(): string | undefined {
  const file = join(configDir(), 'app.json');
  if (!existsSync(file)) return undefined;
  const { slug } = JSON.parse(readFileSync(file, 'utf8')) as { slug?: string };
  return slug ? `${slug}[bot]` : undefined;
}
