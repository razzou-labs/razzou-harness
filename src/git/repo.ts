import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TreeReader } from '../ci/harness-ci.ts';
import { run, runOk } from '../util.ts';

export interface Identity {
  name: string;
  email: string;
}

/** Author of feature commits. `.invalid` addresses can never belong to anyone. */
export const DEVELOPER: Identity = { name: 'Developer (harness)', email: 'developer@harness.invalid' };
/** Committer of everything the daemon writes. */
export const HARNESS: Identity = { name: 'harness', email: 'harness@harness.invalid' };
/** Author of the Architect's commits in its clone. */
export const ARCHITECT: Identity = { name: 'Architect (harness)', email: 'architect@harness.invalid' };

/**
 * The daemon's own bare repository in `.harness/git`: main, the plan branches and the
 * attempt refs. It has no working tree and runs no hooks but git's own, so nothing an
 * agent wrote ever executes on the host. Agents never touch it: code moves in and out
 * of sandboxes as bundles.
 */
export class Repo {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  static async open(dir: string): Promise<Repo> {
    if (!existsSync(join(dir, 'HEAD'))) {
      mkdirSync(dir, { recursive: true });
      await runOk('git', ['init', '--quiet', '--bare', '--initial-branch=main', dir]);
    }
    return new Repo(dir);
  }

  /** Copies main from where the project lives: a local repository, or GitHub with `env` carrying the token. */
  async fetchMain(source: string, env: NodeJS.ProcessEnv = {}): Promise<string> {
    await this.git(['fetch', '--quiet', '--no-tags', source, '+refs/heads/main:refs/heads/main'], env);
    const sha = await this.revParse('refs/heads/main');
    if (!sha) throw new Error(`${source} has no main branch`);
    return sha;
  }

  /** Copies a branch from a remote, if it has it. */
  async fetchBranch(source: string, branch: string, env: NodeJS.ProcessEnv = {}): Promise<string | undefined> {
    const result = await run('git', ['--git-dir', this.dir, 'fetch', '--quiet', '--no-tags', source, `+refs/heads/${branch}:refs/heads/${branch}`], { env: { ...ISOLATED, ...env } });
    return result.code === 0 ? this.revParse(`refs/heads/${branch}`) : undefined;
  }

  /** Pushes one branch. Never forced: a branch that was pushed is never rewritten (§11.3). */
  async push(target: string, branch: string, env: NodeJS.ProcessEnv = {}): Promise<void> {
    await this.git(['push', '--quiet', '--no-verify', target, `refs/heads/${branch}:refs/heads/${branch}`], env);
  }

  /** The tree of a commit, for the protection rules shared with CI. */
  treeReader(ref: string): TreeReader {
    return {
      read: async (path) => {
        const result = await run('git', ['--git-dir', this.dir, 'cat-file', 'blob', `${ref}:${path}`], { env: ISOLATED });
        return result.code === 0 ? result.stdout : undefined;
      },
      list: (folder) => this.listFiles(ref, folder),
    };
  }

  async revParse(ref: string): Promise<string | undefined> {
    const result = await run('git', ['--git-dir', this.dir, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { env: ISOLATED });
    return result.code === 0 ? result.stdout.trim() : undefined;
  }

  async show(ref: string, path: string): Promise<string | undefined> {
    const result = await run('git', ['--git-dir', this.dir, 'show', `${ref}:${path}`], { env: ISOLATED });
    return result.code === 0 ? result.stdout : undefined;
  }

  async listFiles(ref: string, prefix: string): Promise<string[]> {
    return lines(await this.git(['ls-tree', '-r', '--name-only', ref, '--', prefix]));
  }

  /** The blob id of each file under a folder, by path. */
  async blobs(ref: string, prefix: string): Promise<Map<string, string>> {
    const entries = (await this.git(['ls-tree', '-r', '-z', ref, '--', prefix])).split('\0').filter((entry) => entry !== '');
    return new Map(entries.map((entry) => {
      const tab = entry.indexOf('\t');
      return [entry.slice(tab + 1), entry.slice(0, tab).split(' ')[2]!];
    }));
  }

  async isAncestor(ancestor: string, ref: string): Promise<boolean> {
    return (await run('git', ['--git-dir', this.dir, 'merge-base', '--is-ancestor', ancestor, ref], { env: ISOLATED })).code === 0;
  }

  /**
   * Merges `theirs` into `ours`, with nothing checked out: `theirs` itself when `ours` has
   * nothing of its own, else one merge commit; or names the files that conflict.
   */
  async merge(options: { ours: string; theirs: string; message: string; committer: Identity }): Promise<{ commit: string } | { conflicts: string[] }> {
    if (await this.isAncestor(options.ours, options.theirs)) return { commit: options.theirs };
    const result = await run('git', ['--git-dir', this.dir, 'merge-tree', '--write-tree', '--name-only', '--no-messages', options.ours, options.theirs], { env: ISOLATED });
    const [tree, ...conflicts] = lines(result.stdout);
    if (result.code === 1) return { conflicts: [...new Set(conflicts)] };
    if (result.code !== 0 || !tree) throw new Error(`git merge-tree failed: ${result.stderr.trim()}`);
    const identity = {
      GIT_AUTHOR_NAME: options.committer.name,
      GIT_AUTHOR_EMAIL: options.committer.email,
      GIT_COMMITTER_NAME: options.committer.name,
      GIT_COMMITTER_EMAIL: options.committer.email,
    };
    return { commit: (await this.git(['commit-tree', tree, '-p', options.ours, '-p', options.theirs, '-F', '-'], identity, options.message)).trim() };
  }

  /** Moves a ref, refusing if it no longer points at `expected` (use '' for "must not exist yet"). */
  async setRef(ref: string, sha: string, expected?: string): Promise<void> {
    const old = expected === '' ? '0'.repeat(40) : expected;
    await this.git(['update-ref', ref, sha, ...(old === undefined ? [] : [old])]);
  }

  async bundle(refs: string | string[], file: string): Promise<void> {
    await this.git(['bundle', 'create', '--quiet', file, ...(Array.isArray(refs) ? refs : [refs])]);
  }

  /** Fetches the head of a bundle an agent produced into one of our refs, after git checks it. */
  async fetchBundle(file: string, into: string): Promise<string> {
    await this.git(['bundle', 'verify', '--quiet', file]);
    const heads = lines(await this.git(['bundle', 'list-heads', file])).map((line) => line.split(' ')[1]!);
    const head = heads.includes('HEAD') ? 'HEAD' : heads[0];
    if (!head) throw new Error(`${file} contains no ref`);
    await this.git(['fetch', '--quiet', '--no-tags', file, `+${head}:${into}`]);
    return (await this.revParse(into))!;
  }

  async mergeBase(a: string, b: string): Promise<string> {
    return (await this.git(['merge-base', a, b])).trim();
  }

  async changedFiles(base: string, head: string): Promise<string[]> {
    return lines(await this.git(['diff', '--name-only', '--no-renames', base, head]));
  }

  async log(ref: string, count: number): Promise<string> {
    return this.git(['log', '--oneline', `-n${count}`, ref]);
  }

  /** Parents and message of a commit, to recognise one the daemon wrote just before a restart. */
  async commitInfo(ref: string): Promise<{ parents: string[]; message: string }> {
    const [parents = '', message = ''] = (await this.git(['log', '-1', '--format=%P%x00%B', ref])).split('\0');
    return { parents: parents.trim().split(' ').filter(Boolean), message };
  }

  /**
   * Lands an accepted attempt as exactly one commit on top of `base`: the attempt's
   * final tree plus one line appended to progress.txt. The Developer's own commits stay
   * on their attempt ref.
   */
  async commitFeature(options: {
    base: string;
    head: string;
    progressLine: string;
    message: string;
    author: Identity;
    committer: Identity;
  }): Promise<string> {
    const progress = (await this.show(options.head, 'progress.txt')) ?? '';
    const separator = progress === '' || progress.endsWith('\n') ? '' : '\n';
    return this.commitTree({
      parent: options.base,
      tree: options.head,
      files: { 'progress.txt': `${progress}${separator}${options.progressLine}\n` },
      message: options.message,
      author: options.author,
      committer: options.committer,
    });
  }

  /** One commit on `parent` with the tree of `tree`, some files replaced. Nothing is checked out. */
  async commitTree(options: {
    parent: string;
    tree: string;
    files: Record<string, string>;
    message: string;
    author: Identity;
    committer: Identity;
  }): Promise<string> {
    const scratch = mkdtempSync(join(tmpdir(), 'harness-index-'));
    const index = { GIT_INDEX_FILE: join(scratch, 'index') };
    try {
      await this.git(['read-tree', options.tree], index);
      for (const [path, content] of Object.entries(options.files)) {
        const blob = (await this.git(['hash-object', '-w', '--stdin'], {}, content)).trim();
        await this.git(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], index);
      }
      const tree = (await this.git(['write-tree'], index)).trim();
      const identity = {
        GIT_AUTHOR_NAME: options.author.name,
        GIT_AUTHOR_EMAIL: options.author.email,
        GIT_COMMITTER_NAME: options.committer.name,
        GIT_COMMITTER_EMAIL: options.committer.email,
      };
      return (await this.git(['commit-tree', tree, '-p', options.parent, '-F', '-'], identity, options.message)).trim();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  private git(args: string[], env: NodeJS.ProcessEnv = {}, input?: string): Promise<string> {
    return runOk('git', ['--git-dir', this.dir, ...args], { env: { ...ISOLATED, ...env }, input });
  }
}

/**
 * The daemon's git ignores the owner's global and system configuration: a credential
 * helper or an `insteadOf` rule there must never turn the App's push into the owner's.
 */
const ISOLATED: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

function lines(text: string): string[] {
  return text.split('\n').filter((line) => line !== '');
}
