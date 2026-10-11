import type { Repo } from '../git/repo.ts';
import { tail } from '../util.ts';
import type { GitHubClient } from './app.ts';

export interface PullRequest {
  number: number;
  url: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommit?: string;
  /** The commit at the head of its branch. */
  head: string;
}

export interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  url?: string;
}

/**
 * Where the project lives: main comes from it, and plan branches and pull requests go to
 * it. GitHub, through the App; or the owner's local repository, with no pull requests,
 * when the project names no repository.
 */
export interface Forge {
  readonly kind: 'local' | 'github';
  /** The App's bot login: the author of the harness's PRs. */
  readonly bot?: string;
  fetchMain(repo: Repo): Promise<string>;
  /** A branch the harness pushed earlier, if the remote has it. */
  fetchBranch(repo: Repo, branch: string): Promise<string | undefined>;
  push(repo: Repo, branch: string): Promise<void>;
  openPullRequest(input: { branch: string; title: string; body: string }): Promise<{ number: number; url: string }>;
  /** The newest PR of a branch (only an open one with `open`): a previous process may have opened it just before stopping. */
  findPullRequest(branch: string, options?: { open?: boolean }): Promise<{ number: number; url: string } | undefined>;
  pullRequest(number: number): Promise<PullRequest>;
  checkRuns(sha: string): Promise<CheckRun[]>;
  /** The end of a failed job's log. */
  jobLog(run: CheckRun): Promise<string>;
}

export class LocalForge implements Forge {
  readonly kind = 'local';
  private readonly projectDir: string;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
  }

  fetchMain(repo: Repo): Promise<string> {
    return repo.fetchMain(this.projectDir);
  }

  async fetchBranch(): Promise<undefined> {
    return undefined;
  }

  push(): Promise<void> {
    return Promise.reject(new Error('this project has no GitHub repository (project.repo)'));
  }

  openPullRequest(): Promise<{ number: number; url: string }> {
    return Promise.reject(new Error('this project has no GitHub repository (project.repo)'));
  }

  async findPullRequest(): Promise<undefined> {
    return undefined;
  }

  pullRequest(): Promise<PullRequest> {
    return Promise.reject(new Error('this project has no GitHub repository (project.repo)'));
  }

  async checkRuns(): Promise<CheckRun[]> {
    return [];
  }

  async jobLog(): Promise<string> {
    return '';
  }
}

export class GitHubForge implements Forge {
  readonly kind = 'github';
  private readonly client: GitHubClient;

  constructor(client: GitHubClient) {
    this.client = client;
  }

  get bot(): string {
    return this.client.botLogin;
  }

  async fetchMain(repo: Repo): Promise<string> {
    return repo.fetchMain(this.client.remoteUrl, await this.client.gitEnv());
  }

  async fetchBranch(repo: Repo, branch: string): Promise<string | undefined> {
    return repo.fetchBranch(this.client.remoteUrl, branch, await this.client.gitEnv());
  }

  async push(repo: Repo, branch: string): Promise<void> {
    await repo.push(this.client.remoteUrl, branch, await this.client.gitEnv());
  }

  async openPullRequest(input: { branch: string; title: string; body: string }): Promise<{ number: number; url: string }> {
    const pr = await this.client.request<{ number: number; html_url: string }>('POST', '/repos/{repo}/pulls', {
      title: input.title,
      head: input.branch,
      base: 'main',
      body: input.body,
      maintainer_can_modify: false,
    });
    return { number: pr.number, url: pr.html_url };
  }

  async findPullRequest(branch: string, options: { open?: boolean } = {}): Promise<{ number: number; url: string } | undefined> {
    const owner = this.client.repo.split('/')[0];
    const prs = await this.client.request<Array<{ number: number; html_url: string }>>(
      'GET', `/repos/{repo}/pulls?state=${options.open ? 'open' : 'all'}&head=${encodeURIComponent(`${owner}:${branch}`)}`,
    );
    return prs[0] ? { number: prs[0].number, url: prs[0].html_url } : undefined;
  }

  async pullRequest(number: number): Promise<PullRequest> {
    const pr = await this.client.request<{
      number: number; html_url: string; state: 'open' | 'closed'; merged: boolean; merge_commit_sha: string | null; head: { sha: string };
    }>('GET', `/repos/{repo}/pulls/${number}`);
    return {
      number: pr.number,
      url: pr.html_url,
      state: pr.state,
      merged: pr.merged,
      ...(pr.merged && pr.merge_commit_sha ? { mergeCommit: pr.merge_commit_sha } : {}),
      head: pr.head.sha,
    };
  }

  async checkRuns(sha: string): Promise<CheckRun[]> {
    const page = await this.client.request<{ check_runs: Array<{ id: number; name: string; status: string; conclusion: string | null; html_url?: string }> }>(
      'GET', `/repos/{repo}/commits/${sha}/check-runs?per_page=100`,
    );
    return page.check_runs.map((r) => ({ id: r.id, name: r.name, status: r.status, conclusion: r.conclusion, ...(r.html_url ? { url: r.html_url } : {}) }));
  }

  /** For Actions, a check run is a job, and the job's log is behind a redirect. */
  async jobLog(run: CheckRun): Promise<string> {
    try {
      return tail(await this.client.download(`/repos/{repo}/actions/jobs/${run.id}/logs`), 4000);
    } catch (error) {
      return `(no log: ${(error as Error).message})`;
    }
  }
}
