import type { Repo } from '../git/repo.ts';
import { tail } from '../util.ts';
import { GitHubError, type GitHubClient } from './app.ts';
import { zipEntry } from './artifacts.ts';

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

/** A commit status, the latest of its context: what the reviewers post as the App (v3 §5.4). */
export interface CommitStatus {
  context: string;
  state: string;
}

/** The rules in effect on a branch, as GitHub lists them for anyone who can read the repository (v4 §6). */
export interface BranchRules {
  approvals: number;
  codeOwners: boolean;
  /** The required status checks, each with the integration it is pinned to, if any. */
  checks: Array<{ context: string; integrationId?: number }>;
}

/** A review the daemon posts on a PR for a reviewer: a body, and comments on lines of the diff. */
export interface ReviewPost {
  head: string;
  body: string;
  comments: Array<{ path: string; line: number; body: string }>;
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
  /** The App's id, which the Swarm ruleset pins the reviewers' statuses to. */
  readonly appId?: number;
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
  /** The commit statuses on a commit, the latest per context. */
  commitStatuses(sha: string): Promise<CommitStatus[]>;
  /**
   * Merges a PR with a merge commit, as the App, under Swarm's policy (v3 §3.2). `head`
   * is the commit the daemon expects at the PR's head. Throws when GitHub refuses.
   */
  mergePullRequest(number: number, head: string): Promise<{ commit: string }>;
  /** Posts a reviewer's findings on the PR (v3 §5.4). Comments GitHub refuses, outside the diff, fold into the body. */
  createReview(number: number, review: ReviewPost): Promise<{ comments: number }>;
  /** Sets a commit status, the reviewers' verdict, which the Swarm ruleset requires (v3 §3.3). */
  setCommitStatus(sha: string, status: { context: string; state: 'success' | 'failure' | 'pending'; description: string }): Promise<void>;
  /** A file out of a named artifact of the commit's workflow run (v3 §5.5), or undefined when no run has one yet. */
  artifactFile(sha: string, artifact: string, file: string): Promise<string | undefined>;
  /** The rules in effect on a branch (v4 §6), or undefined when they can't be read. */
  branchRules(branch: string): Promise<BranchRules | undefined>;
  /** Whether the App may write commit statuses: false once a token had to be minted without it; undefined while unknown. */
  statusesWritable(): boolean | undefined;
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

  async commitStatuses(): Promise<CommitStatus[]> {
    return [];
  }

  async mergePullRequest(): Promise<{ commit: string }> {
    throw new GitHubError('a local project has no pull requests to merge', 0);
  }

  async createReview(): Promise<{ comments: number }> {
    return { comments: 0 };
  }

  async setCommitStatus(): Promise<void> {}

  async artifactFile(): Promise<undefined> {
    return undefined;
  }

  async branchRules(): Promise<undefined> {
    return undefined;
  }

  statusesWritable(): undefined {
    return undefined;
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

  get appId(): number {
    return this.client.appId;
  }

  statusesWritable(): boolean | undefined {
    return this.client.canWriteStatuses ? undefined : false;
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

  /** The combined status holds the latest status of each context. */
  async commitStatuses(sha: string): Promise<CommitStatus[]> {
    const combined = await this.client.request<{ statuses: Array<{ context: string; state: string }> }>('GET', `/repos/{repo}/commits/${sha}/status?per_page=100`);
    return combined.statuses.map((s) => ({ context: s.context, state: s.state }));
  }

  async createReview(number: number, review: ReviewPost): Promise<{ comments: number }> {
    const post = (comments: ReviewPost['comments'], body: string) => this.client.request('POST', `/repos/{repo}/pulls/${number}/reviews`, {
      commit_id: review.head,
      body,
      event: 'COMMENT',
      comments: comments.map((c) => ({ path: c.path, line: c.line, side: 'RIGHT', body: c.body })),
    });
    try {
      await post(review.comments, review.body);
      return { comments: review.comments.length };
    } catch (error) {
      // A line outside the diff is refused as a whole: the findings go in the body instead.
      if (!(error instanceof GitHubError) || error.status !== 422 || review.comments.length === 0) throw error;
      const folded = review.comments.map((c) => `**${c.path}:${c.line}** ${c.body}`).join('\n\n');
      await post([], `${review.body}\n\n${folded}`);
      return { comments: 0 };
    }
  }

  async setCommitStatus(sha: string, status: { context: string; state: 'success' | 'failure' | 'pending'; description: string }): Promise<void> {
    // The current token decides, and a new one asks for the permission again.
    await this.client.token();
    if (!this.client.canWriteStatuses) throw new GitHubError('the App has no "Commit statuses: write" permission: add it on GitHub and accept it on the installation', 403);
    await this.client.request('POST', `/repos/{repo}/statuses/${sha}`, { context: status.context, state: status.state, description: status.description.slice(0, 140) });
  }

  /** GitHub refuses with 405 when main's rules aren't met, and with 409 when the head moved. */
  async mergePullRequest(number: number, head: string): Promise<{ commit: string }> {
    const result = await this.client.request<{ sha: string; merged: boolean; message: string }>('PUT', `/repos/{repo}/pulls/${number}/merge`, { merge_method: 'merge', sha: head });
    if (!result.merged) throw new GitHubError(result.message, 0);
    return { commit: result.sha };
  }

  /** The newest completed run on the commit that has the artifact: its zip, read for the file. */
  async artifactFile(sha: string, artifact: string, file: string): Promise<string | undefined> {
    const runs = await this.client.request<{ workflow_runs: Array<{ id: number; status: string; created_at: string }> }>(
      'GET', `/repos/{repo}/actions/runs?head_sha=${sha}&per_page=20`,
    );
    const completed = runs.workflow_runs.filter((r) => r.status === 'completed').sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    for (const run of completed) {
      const list = await this.client.request<{ artifacts: Array<{ id: number; name: string; expired: boolean }> }>('GET', `/repos/{repo}/actions/runs/${run.id}/artifacts?per_page=100`);
      const found = list.artifacts.find((a) => a.name === artifact && !a.expired);
      if (found) return zipEntry(await this.client.downloadBytes(`/repos/{repo}/actions/artifacts/${found.id}/zip`), file);
    }
    return undefined;
  }

  /**
   * The rules GitHub applies to the branch, from every active ruleset, every page of them;
   * an empty list when none applies. Unreadable rules are undefined. GitHub enforces each
   * rule: the approvals are the most any asks for, and code owners count if one says so.
   */
  async branchRules(branch: string): Promise<BranchRules | undefined> {
    const rules: Array<{ type: string; parameters?: Record<string, any> }> = [];
    try {
      for (let page = 1; ; page++) {
        const batch = await this.client.request<typeof rules>('GET', `/repos/{repo}/rules/branches/${encodeURIComponent(branch)}?per_page=100&page=${page}`);
        rules.push(...batch);
        if (batch.length < 100) break;
      }
    } catch (error) {
      if (error instanceof GitHubError && (error.status === 403 || error.status === 404)) return undefined;
      throw error;
    }
    const prs = rules.filter((r) => r.type === 'pull_request').map((r) => r.parameters ?? {});
    const checks = rules.filter((r) => r.type === 'required_status_checks').flatMap((r) => (r.parameters?.required_status_checks ?? []) as Array<{ context: string; integration_id?: number | null }>);
    return {
      approvals: Math.max(0, ...prs.map((pr) => Number(pr.required_approving_review_count ?? 0))),
      codeOwners: prs.some((pr) => pr.require_code_owner_review === true),
      checks: checks.map((c) => ({ context: c.context, ...(typeof c.integration_id === 'number' ? { integrationId: c.integration_id } : {}) })),
    };
  }
}
