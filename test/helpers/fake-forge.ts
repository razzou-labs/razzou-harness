import { join } from 'node:path';
import type { Repo } from '../../src/git/repo.ts';
import { GitHubError } from '../../src/github/app.ts';
import type { ArtifactOptions, BranchRules, CheckRun, CommitStatus, Forge, PullRequest, ReviewPost } from '../../src/github/forge.ts';
import { run, runOk } from '../../src/util.ts';
import { tempDir } from './toy-repo.ts';

export const FAKE_BOT = 'toy-harness[bot]';

interface FakePullRequest {
  number: number;
  branch: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  mergeCommit?: string;
  /** The head it was merged with: a closed one's head counts for `findPullRequest`'s `head`, and only a merged one's is known. */
  mergedHead?: string;
}

/**
 * GitHub, for tests: a local bare repository is the remote, pull requests live in memory,
 * and `ci` decides how CI ends on each pushed commit (undefined keeps it running).
 */
/** A job as a test declares it: a conclusion, or `in_progress` and `queued` for one still to end. */
function settled(conclusion: string): Pick<CheckRun, 'status' | 'conclusion' | 'completedAt'> {
  if (conclusion === 'in_progress' || conclusion === 'queued') return { status: conclusion, conclusion: null };
  return { status: 'completed', conclusion, completedAt: new Date().toISOString() };
}

export class FakeForge implements Forge {
  readonly kind = 'github';
  readonly bot = FAKE_BOT;
  readonly appId = 4242;
  readonly remote: string;
  /** The rules in effect on main (v4 §6): by default those of Manual, as `harness github-setup` sets them. */
  rules: BranchRules | undefined = {
    approvals: 1, codeOwners: true, checks: [{ context: 'verify', integrationId: 15368 }, { context: 'checks', integrationId: 15368 }],
  };
  /** False once the App is known not to write statuses. */
  writable: boolean | undefined = undefined;
  readonly prs: FakePullRequest[] = [];
  /** How CI ends on each pushed commit, by job; the cost job runs on every PR, as the workflow's does, and is no required check. */
  ci: (sha: string) => Record<string, string> | undefined = () => ({ verify: 'success', checks: 'success', cost: 'success' });
  /** The commit statuses on each commit, by context: what the reviewers would post as the App (v3 §5.4). */
  statuses: (sha: string) => Record<string, string> = () => ({});
  /** When set, the daemon's merge is refused with this message, as GitHub does under rules the merge doesn't meet. */
  refuseMerge?: string;
  /** What the daemon posted for the reviewers (v3 §5.4), and the statuses it set. */
  readonly reviews: Array<{ number: number } & ReviewPost> = [];
  readonly statusesSet: Array<{ sha: string; context: string; state: string; description: string }> = [];
  /** When set, setting a status fails with this message, as GitHub does for an App without the permission. */
  refuseStatus?: string;
  /** The artifacts of each commit's workflow run, by name, then by file: what the cost job uploads (v3 §5.5). */
  artifacts: (sha: string) => Record<string, Record<string, string>> = () => ({});
  private readonly runs = new Map<string, CheckRun[]>();
  private nextRun = 1;

  private constructor(remote: string) {
    this.remote = remote;
  }

  /** A remote that starts with the project's main. */
  static async create(projectDir: string): Promise<FakeForge> {
    const remote = join(tempDir('remote'), 'repo.git');
    await runOk('git', ['init', '--quiet', '--bare', '--initial-branch=main', remote]);
    await runOk('git', ['-C', projectDir, 'push', '--quiet', remote, 'main:main']);
    return new FakeForge(remote);
  }

  fetchMain(repo: Repo): Promise<string> {
    return repo.fetchMain(this.remote);
  }

  fetchBranch(repo: Repo, branch: string): Promise<string | undefined> {
    return repo.fetchBranch(this.remote, branch);
  }

  push(repo: Repo, branch: string): Promise<void> {
    return repo.push(this.remote, branch);
  }

  async openPullRequest(input: { branch: string; title: string; body: string }): Promise<{ number: number; url: string }> {
    const pr: FakePullRequest = { number: this.prs.length + 1, ...input, state: 'open' };
    this.prs.push(pr);
    return { number: pr.number, url: `https://github.test/pull/${pr.number}` };
  }

  async findPullRequest(branch: string, options: { open?: boolean; head?: string } = {}): Promise<{ number: number; url: string } | undefined> {
    const pr = this.prs.findLast((p) => p.branch === branch && (p.state === 'open' || (!options.open && (options.head === undefined || p.mergedHead === options.head))));
    return pr ? { number: pr.number, url: `https://github.test/pull/${pr.number}` } : undefined;
  }

  async pullRequest(number: number): Promise<PullRequest> {
    const pr = this.prs[number - 1]!;
    return {
      number,
      url: `https://github.test/pull/${number}`,
      state: pr.state,
      merged: pr.mergeCommit !== undefined,
      ...(pr.mergeCommit ? { mergeCommit: pr.mergeCommit } : {}),
      head: await this.head(pr.branch),
    };
  }

  async checkRuns(sha: string): Promise<CheckRun[]> {
    if (!this.runs.has(sha)) {
      if (await this.unmergeable(sha)) return [];
      const decided = this.ci(sha);
      if (!decided) return [];
      // One workflow run of the jobs, as GitHub has it: the daemon reads an artifact from its job's run.
      const runId = 9000 + this.nextRun;
      this.runs.set(sha, Object.entries(decided).map(([name, conclusion]) => ({ id: this.nextRun++, name, runId, ...settled(conclusion) })));
    }
    return this.runs.get(sha)!;
  }

  /**
   * GitHub runs no workflow on a pull request it can't merge into its base, and it merges
   * by git's own rules: two sides that both added lines to progress.txt conflict there.
   */
  private async unmergeable(sha: string): Promise<boolean> {
    for (const pr of this.prs.filter((p) => p.state === 'open')) {
      if ((await this.head(pr.branch).catch(() => undefined)) !== sha) continue;
      const merged = await run('git', ['--git-dir', this.remote, 'merge-tree', '--write-tree', '--no-messages', await this.head('main'), sha]);
      if (merged.code === 1) return true;
    }
    return false;
  }

  /** The owner runs CI again on GitHub: newer runs of the same jobs, which end as `conclusions` say. */
  async rerun(sha: string, conclusions: Record<string, string>): Promise<void> {
    await this.checkRuns(sha);
    const runs = this.runs.get(sha) ?? [];
    const runId = 9000 + this.nextRun;
    runs.push(...Object.entries(conclusions).map(([name, conclusion]) => ({ id: this.nextRun++, name, runId, ...settled(conclusion) })));
    this.runs.set(sha, runs);
  }

  async jobLog(run: CheckRun): Promise<string> {
    return `the ${run.name} job failed: expected 5, got 4`;
  }

  /** The statuses a test declares, and the latest the daemon set, per context. */
  async commitStatuses(sha: string): Promise<CommitStatus[]> {
    const latest = new Map<string, string>(Object.entries(this.statuses(sha)));
    for (const status of this.statusesSet) if (status.sha === sha) latest.set(status.context, status.state);
    return [...latest].map(([context, state]) => ({ context, state }));
  }

  async createReview(number: number, review: ReviewPost): Promise<{ comments: number }> {
    this.reviews.push({ number, ...review });
    return { comments: review.comments.length };
  }

  async setCommitStatus(sha: string, status: { context: string; state: 'success' | 'failure' | 'pending'; description: string }): Promise<void> {
    if (this.refuseStatus) throw new GitHubError(this.refuseStatus, 403);
    this.statusesSet.push({ sha, ...status });
  }

  async artifactFile(sha: string, artifact: string, file: string, _options?: ArtifactOptions): Promise<string | undefined> {
    return this.artifacts(sha)[artifact]?.[file];
  }

  async branchRules(): Promise<BranchRules | undefined> {
    return this.rules;
  }

  statusesWritable(): boolean | undefined {
    return this.writable;
  }

  /** The daemon merges under Swarm's policy: refused like GitHub when the rules aren't met or the head moved. */
  async mergePullRequest(number: number, head: string): Promise<{ commit: string }> {
    if (this.refuseMerge) throw new GitHubError(this.refuseMerge, 405);
    const pr = this.prs[number - 1]!;
    if (pr.state !== 'open') throw new GitHubError('Pull Request is not mergeable', 405);
    if ((await this.head(pr.branch)) !== head) throw new GitHubError('Head branch was modified. Review and try the merge again.', 409);
    return { commit: await this.merge(number, FAKE_BOT) };
  }

  /**
   * The owner merges, or the daemon as the App: a merge commit on main with the branch as
   * second parent, from a real three-way merge, refused like GitHub's when they conflict.
   */
  async merge(number: number, by = 'owner'): Promise<string> {
    const pr = this.prs[number - 1]!;
    const head = await this.head(pr.branch);
    const main = await this.head('main');
    const merged = await run('git', ['--git-dir', this.remote, 'merge-tree', '--write-tree', '-z', '--name-only', '--no-messages', main, head]);
    if (merged.code === 1) throw new GitHubError(`Merge conflict in ${merged.stdout.split('\0').slice(1).filter(Boolean).join(', ')}: the pull request is not mergeable`, 405);
    if (merged.code !== 0) throw new Error(`git merge-tree failed: ${merged.stderr.trim()}`);
    const tree = merged.stdout.split('\0')[0]!;
    const env = { ...process.env, GIT_AUTHOR_NAME: by, GIT_AUTHOR_EMAIL: `${by}@test.invalid`, GIT_COMMITTER_NAME: by, GIT_COMMITTER_EMAIL: `${by}@test.invalid` };
    const commit = (await runOk('git', ['--git-dir', this.remote, 'commit-tree', tree, '-p', main, '-p', head, '-m', `${pr.title} (#${number})`], { env })).trim();
    await runOk('git', ['--git-dir', this.remote, 'update-ref', 'refs/heads/main', commit, main]);
    pr.mergeCommit = commit;
    pr.mergedHead = head;
    pr.state = 'closed';
    return commit;
  }

  close(number: number): void {
    this.prs[number - 1]!.state = 'closed';
  }

  private async head(branch: string): Promise<string> {
    return (await runOk('git', ['--git-dir', this.remote, 'rev-parse', `refs/heads/${branch}`])).trim();
  }
}
