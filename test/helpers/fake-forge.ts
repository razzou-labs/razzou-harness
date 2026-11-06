import { join } from 'node:path';
import type { Repo } from '../../src/git/repo.ts';
import { GitHubError } from '../../src/github/app.ts';
import type { CheckRun, CommitStatus, Forge, PullRequest, ReviewPost } from '../../src/github/forge.ts';
import { runOk } from '../../src/util.ts';
import { tempDir } from './toy-repo.ts';

export const FAKE_BOT = 'toy-harness[bot]';

interface FakePullRequest {
  number: number;
  branch: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  mergeCommit?: string;
}

/**
 * GitHub, for tests: a local bare repository is the remote, pull requests live in memory,
 * and `ci` decides how CI ends on each pushed commit (undefined keeps it running).
 */
export class FakeForge implements Forge {
  readonly kind = 'github';
  readonly bot = FAKE_BOT;
  readonly remote: string;
  readonly prs: FakePullRequest[] = [];
  ci: (sha: string) => Record<string, string> | undefined = () => ({ verify: 'success', checks: 'success' });
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

  async findPullRequest(branch: string, options: { open?: boolean } = {}): Promise<{ number: number; url: string } | undefined> {
    const pr = this.prs.findLast((p) => p.branch === branch && (!options.open || p.state === 'open'));
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
      const decided = this.ci(sha);
      if (!decided) return [];
      this.runs.set(sha, Object.entries(decided).map(([name, conclusion]) => ({ id: this.nextRun++, name, status: 'completed', conclusion })));
    }
    return this.runs.get(sha)!;
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

  async artifactFile(sha: string, artifact: string, file: string): Promise<string | undefined> {
    return this.artifacts(sha)[artifact]?.[file];
  }

  /** The daemon merges under Swarm's policy: refused like GitHub when the rules aren't met or the head moved. */
  async mergePullRequest(number: number, head: string): Promise<{ commit: string }> {
    if (this.refuseMerge) throw new GitHubError(this.refuseMerge, 405);
    const pr = this.prs[number - 1]!;
    if (pr.state !== 'open') throw new GitHubError('Pull Request is not mergeable', 405);
    if ((await this.head(pr.branch)) !== head) throw new GitHubError('Head branch was modified. Review and try the merge again.', 409);
    return { commit: await this.merge(number, FAKE_BOT) };
  }

  /** The owner merges, or the daemon as the App: a merge commit on main with the branch as second parent. */
  async merge(number: number, by = 'owner'): Promise<string> {
    const pr = this.prs[number - 1]!;
    const head = await this.head(pr.branch);
    const main = await this.head('main');
    const tree = (await runOk('git', ['--git-dir', this.remote, 'rev-parse', `${head}^{tree}`])).trim();
    const env = { ...process.env, GIT_AUTHOR_NAME: by, GIT_AUTHOR_EMAIL: `${by}@test.invalid`, GIT_COMMITTER_NAME: by, GIT_COMMITTER_EMAIL: `${by}@test.invalid` };
    const commit = (await runOk('git', ['--git-dir', this.remote, 'commit-tree', tree, '-p', main, '-p', head, '-m', `${pr.title} (#${number})`], { env })).trim();
    await runOk('git', ['--git-dir', this.remote, 'update-ref', 'refs/heads/main', commit, main]);
    pr.mergeCommit = commit;
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
