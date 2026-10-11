import { join } from 'node:path';
import type { Repo } from '../../src/git/repo.ts';
import type { CheckRun, Forge, PullRequest } from '../../src/github/forge.ts';
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

  /** The owner merges: a merge commit on main with the branch as second parent. */
  async merge(number: number): Promise<string> {
    const pr = this.prs[number - 1]!;
    const head = await this.head(pr.branch);
    const main = await this.head('main');
    const tree = (await runOk('git', ['--git-dir', this.remote, 'rev-parse', `${head}^{tree}`])).trim();
    const env = { ...process.env, GIT_AUTHOR_NAME: 'owner', GIT_AUTHOR_EMAIL: 'owner@test.invalid', GIT_COMMITTER_NAME: 'owner', GIT_COMMITTER_EMAIL: 'owner@test.invalid' };
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
