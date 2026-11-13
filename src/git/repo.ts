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
    await this.git(['fetch', '--quiet', '--no-tags', source, '+refs/heads/main:refs/heads/main'], env, undefined, NETWORK);
    const sha = await this.revParse('refs/heads/main');
    if (!sha) throw new Error(`${source} has no main branch`);
    return sha;
  }

  /** Copies a branch from a remote, if it has it: undefined only when the remote says it has no such branch, an error for any other failure. */
  async fetchBranch(source: string, branch: string, env: NodeJS.ProcessEnv = {}): Promise<string | undefined> {
    const result = await run('git', ['--git-dir', this.dir, 'fetch', '--quiet', '--no-tags', source, `+refs/heads/${branch}:refs/heads/${branch}`], { env: { ...ISOLATED, ...env }, ...NETWORK });
    if (result.code === 0) return this.revParse(`refs/heads/${branch}`);
    if (/couldn't find remote ref/i.test(result.stderr)) return undefined;
    throw new Error(`git fetch of ${branch} failed: ${result.stderr.trim().slice(0, 300) || `exit code ${result.code}`}`);
  }

  /** Pushes one branch. Never forced: a branch that was pushed is never rewritten (§11.3). */
  async push(target: string, branch: string, env: NodeJS.ProcessEnv = {}): Promise<void> {
    await this.git(['push', '--quiet', '--no-verify', target, `refs/heads/${branch}:refs/heads/${branch}`], env, undefined, NETWORK);
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

  /** Every file under a folder, or in the whole tree for ''. NUL-separated: git quotes unusual paths otherwise. */
  async listFiles(ref: string, prefix: string): Promise<string[]> {
    const scope = prefix === '' || prefix === '.' ? [] : ['--', prefix];
    return nulSeparated(await this.git(['ls-tree', '-r', '-z', '--name-only', ref, ...scope]));
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
   * nothing of its own, else one merge commit; or names the files that conflict. A file in
   * `union` that both sides only appended to, like progress.txt, takes theirs' lines and
   * then ours', so the result still starts with theirs: it conflicts only when a side
   * rewrote it.
   */
  async merge(options: { ours: string; theirs: string; message: string; committer: Identity; union?: string[] }): Promise<{ commit: string } | { conflicts: string[] }> {
    if (await this.isAncestor(options.ours, options.theirs)) return { commit: options.theirs };
    const merged = await this.mergeTree(options.ours, options.theirs, options.union);
    if ('conflicts' in merged) return merged;
    const identity = {
      GIT_AUTHOR_NAME: options.committer.name,
      GIT_AUTHOR_EMAIL: options.committer.email,
      GIT_COMMITTER_NAME: options.committer.name,
      GIT_COMMITTER_EMAIL: options.committer.email,
    };
    return { commit: (await this.git(['commit-tree', merged.tree, '-p', options.ours, '-p', options.theirs, '-F', '-'], identity, options.message)).trim() };
  }

  /** The files in which merging `theirs` into `ours` would conflict, by the rules of `merge`; none when it merges. No commit is written. */
  async conflicts(ours: string, theirs: string, union?: string[]): Promise<string[]> {
    if (await this.isAncestor(ours, theirs)) return [];
    const merged = await this.mergeTree(ours, theirs, union);
    return 'conflicts' in merged ? merged.conflicts : [];
  }

  /** The merged tree of two commits, or the files that conflict. */
  private async mergeTree(ours: string, theirs: string, union?: string[]): Promise<{ tree: string } | { conflicts: string[] }> {
    const result = await run('git', ['--git-dir', this.dir, 'merge-tree', '--write-tree', '-z', '--name-only', '--no-messages', ours, theirs], { env: ISOLATED });
    const [tree, ...names] = nulSeparated(result.stdout);
    if ((result.code !== 0 && result.code !== 1) || !tree) throw new Error(`git merge-tree failed: ${result.stderr.trim()}`);
    if (result.code === 0) return { tree };
    const conflicts = [...new Set(names)];
    const appended = conflicts.every((file) => union?.includes(file)) ? await this.appendedOnBothSides(ours, theirs, conflicts) : undefined;
    return appended ? { tree: await this.treeWith(tree, appended) } : { conflicts };
  }

  /** A file both sides only appended to, as `merge` writes it for `union`: theirs' lines, then ours'. Undefined when a side did more than append. */
  async unionOf(ours: string, theirs: string, file: string): Promise<string | undefined> {
    return (await this.appendedOnBothSides(ours, theirs, [file]))?.[file];
  }

  /** Each file's lines added by theirs, then by ours, on top of the merge base; undefined when a side did more than append. */
  private async appendedOnBothSides(ours: string, theirs: string, files: string[]): Promise<Record<string, string> | undefined> {
    const base = lines(await this.git(['merge-base', ours, theirs]))[0]!;
    const merged: Record<string, string> = {};
    for (const file of files) {
      const [before, mine, other] = await Promise.all([this.show(base, file), this.show(ours, file), this.show(theirs, file)]);
      const start = before ?? '';
      if (mine === undefined || other === undefined || !mine.startsWith(start) || !other.startsWith(start)) return undefined;
      const added = mine.slice(start.length);
      merged[file] = added === '' ? other : `${other}${other === '' || other.endsWith('\n') ? '' : '\n'}${added}`;
    }
    return merged;
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

  /**
   * Every best common ancestor of two commits. More than one means that a diff from "the"
   * merge base shows only part of what a merge would do: the rest comes from the other.
   */
  async mergeBases(a: string, b: string): Promise<string[]> {
    return lines(await this.git(['merge-base', '--all', a, b]));
  }

  /** The paths that differ, NUL-separated: git quotes unusual ones otherwise, and a quoted path matches no protection rule (§8.7). */
  async changedFiles(base: string, head: string): Promise<string[]> {
    return nulSeparated(await this.git(['diff', '-z', '--name-only', '--no-renames', base, head]));
  }

  async log(ref: string, count: number): Promise<string> {
    return this.git(['log', '--oneline', `-n${count}`, ref]);
  }

  /** What `head` gained since `base`, newest first, one line each: a merged pull request shows as its merge, not as its commits. */
  async gained(base: string, head: string, count: number): Promise<string[]> {
    return lines(await this.git(['log', '--first-parent', '--format=%h %s', `-n${count}`, `${base}..${head}`]));
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

  /**
   * Lands a merge round as one commit that merges `main` into `base`, with the tree a
   * Developer resolved at `head`. progress.txt is written here, as `merge` writes it:
   * main's lines, then the plan's, then this round's line.
   */
  async commitMerge(options: {
    base: string;
    main: string;
    head: string;
    progressLine: string;
    message: string;
    author: Identity;
    committer: Identity;
  }): Promise<string> {
    const progress = (await this.unionOf(options.base, options.main, 'progress.txt')) ?? (await this.show(options.head, 'progress.txt')) ?? '';
    const separator = progress === '' || progress.endsWith('\n') ? '' : '\n';
    return this.commitTree({
      parent: options.base,
      merged: options.main,
      tree: options.head,
      files: { 'progress.txt': `${progress}${separator}${options.progressLine}\n` },
      message: options.message,
      author: options.author,
      committer: options.committer,
    });
  }

  /**
   * One commit on `parent` with the tree of `tree`, some files replaced. Nothing is
   * checked out. With `merged`, it is the merge of that commit into `parent`.
   */
  async commitTree(options: {
    parent: string;
    merged?: string;
    tree: string;
    files: Record<string, string>;
    message: string;
    author: Identity;
    committer: Identity;
  }): Promise<string> {
    const tree = await this.treeWith(options.tree, options.files);
    const identity = {
      GIT_AUTHOR_NAME: options.author.name,
      GIT_AUTHOR_EMAIL: options.author.email,
      GIT_COMMITTER_NAME: options.committer.name,
      GIT_COMMITTER_EMAIL: options.committer.email,
    };
    const parents = ['-p', options.parent, ...(options.merged ? ['-p', options.merged] : [])];
    return (await this.git(['commit-tree', tree, ...parents, '-F', '-'], identity, options.message)).trim();
  }

  /** The tree of `treeish` with some files replaced, written with a scratch index. */
  private async treeWith(treeish: string, files: Record<string, string>): Promise<string> {
    const scratch = mkdtempSync(join(tmpdir(), 'harness-index-'));
    const index = { GIT_INDEX_FILE: join(scratch, 'index') };
    try {
      await this.git(['read-tree', treeish], index);
      for (const [path, content] of Object.entries(files)) {
        const blob = (await this.git(['hash-object', '-w', '--stdin'], {}, content)).trim();
        await this.git(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], index);
      }
      return (await this.git(['write-tree'], index)).trim();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  private git(args: string[], env: NodeJS.ProcessEnv = {}, input?: string, limits: { timeout?: number; killSignal?: NodeJS.Signals } = {}): Promise<string> {
    return runOk('git', ['--git-dir', this.dir, ...args], { env: { ...ISOLATED, ...env }, input, ...limits });
  }
}

/**
 * The daemon's git ignores the owner's global and system configuration: a credential
 * helper or an `insteadOf` rule there must never turn the App's push into the owner's.
 */
const ISOLATED: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

/** A fetch or a push that got no answer for ten minutes is killed: a remote that hangs must not hold the daemon's pass. */
const NETWORK = { timeout: 600_000, killSignal: 'SIGKILL' } as const;

function lines(text: string): string[] {
  return text.split('\n').filter((line) => line !== '');
}

function nulSeparated(text: string): string[] {
  return text.split('\0').filter((part) => part !== '');
}
