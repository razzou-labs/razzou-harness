import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { ConfigSchema, requiredChecks, type Config } from '../design/schemas.ts';
import type { Mode } from '../state/state.ts';
import { run } from '../util.ts';
import { APP_PERMISSIONS, configDir, GitHubClient, loadAppCredentials } from './app.ts';
import type { BranchRules } from './forge.ts';

export interface CreatedApp {
  appId: number;
  slug: string;
  name: string;
  owner: string;
  htmlUrl: string;
}

export interface CreateAppOptions {
  org: string;
  name: string;
  dir?: string;
  /** Called with the local page the owner opens to start. */
  onReady: (url: string) => void;
  timeoutMs?: number;
}

/**
 * Creates the harness's GitHub App from a manifest (proposal v2 §11.4, §17.3 step 3). A
 * page on 127.0.0.1 posts the manifest to GitHub, the owner reviews it and clicks Create,
 * and GitHub redirects back with a one-time code. The harness exchanges the code for the
 * App's id and private key, and stores only those, mode 0600. The App has no webhook: a
 * local daemon polls instead.
 */
export function createApp(options: CreateAppOptions): Promise<CreatedApp> {
  const dir = options.dir ?? configDir();
  if (existsSync(join(dir, 'app.pem'))) {
    return Promise.reject(new Error(`${dir} already holds an App. Move app.json and app.pem away to create another.`));
  }
  const state = randomBytes(16).toString('hex');
  let manifest = '';

  return new Promise((resolve, reject) => {
    const finish = (error: Error | undefined, app?: CreatedApp) => {
      clearTimeout(timer);
      server.close();
      if (error) reject(error);
      else resolve(app!);
    };
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/') {
        const action = `https://github.com/organizations/${encodeURIComponent(options.org)}/settings/apps/new?state=${state}`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>Create the harness App</title>
<p>Sending the App's manifest to GitHub. Review it there, then click <b>Create GitHub App</b>.</p>
<form method="post" action="${escapeHtml(action)}"><input type="hidden" name="manifest" value="${escapeHtml(manifest)}"><button>Continue to GitHub</button></form>
<script>document.forms[0].submit()</script>`);
        return;
      }
      if (url.pathname !== '/created') {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      if (url.searchParams.get('state') !== state || !code) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('This is not the redirect from GitHub for this App.');
        return;
      }
      try {
        const response = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
          method: 'POST',
          headers: { accept: 'application/vnd.github+json', 'user-agent': 'razzou-harness', 'x-github-api-version': '2022-11-28' },
        });
        if (!response.ok) throw new Error(`GitHub refused the code: ${response.status} ${(await response.text()).slice(0, 300)}`);
        const created = (await response.json()) as { id: number; slug: string; name: string; owner: { login: string }; html_url: string; pem: string };
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileSync(join(dir, 'app.pem'), created.pem, { mode: 0o600 });
        const app: CreatedApp = { appId: created.id, slug: created.slug, name: created.name, owner: created.owner.login, htmlUrl: created.html_url };
        writeFileSync(join(dir, 'app.json'), `${JSON.stringify(app, null, 2)}\n`, { mode: 0o600 });
        const install = `https://github.com/apps/${created.slug}/installations/new`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>App created</title><p>The App <b>${escapeHtml(created.name)}</b> exists.</p>
<p>Now <a href="${escapeHtml(install)}">install it</a> on your project repository, and on that repository only.</p>`);
        finish(undefined, app);
      } catch (error) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end((error as Error).message);
        finish(error as Error);
      }
    });
    const timer = setTimeout(() => finish(new Error('no App was created within the time limit')), options.timeoutMs ?? 15 * 60_000);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      manifest = JSON.stringify({
        name: options.name,
        url: `https://github.com/${options.org}`,
        redirect_url: `http://127.0.0.1:${port}/created`,
        public: false,
        default_permissions: APP_PERMISSIONS,
        default_events: [],
      });
      options.onReady(`http://127.0.0.1:${port}/`);
    });
  });
}

/**
 * Whether the App works on a repository: who it is, whether it's installed there, and whether
 * a token can be minted. `Permissions:` are the ones the installation accepted, which tokens
 * get; the App may ask for more, which the owner still has to accept.
 */
export async function checkApp(repo: string, dir = configDir()): Promise<string[]> {
  const client = new GitHubClient(loadAppCredentials(dir), repo);
  const app = await client.appRequest<{ name: string; owner: { login: string }; permissions: Record<string, string> }>('GET', '/app');
  const installation = await client.appRequest<{ permissions: Record<string, string> }>('GET', '/repos/{repo}/installation');
  const list = (permissions: Record<string, string>) => Object.entries(permissions).map(([k, v]) => `${k}=${v}`).join(', ');
  const lines = [`App: ${app.name} (owner ${app.owner.login})`, `Permissions: ${list(installation.permissions)}`, `App permissions: ${list(app.permissions)}`];
  const installations = await client.appRequest<Array<{ account: { login: string }; repository_selection: string }>>('GET', '/app/installations');
  lines.push(`Installations: ${installations.map((i) => `${i.account.login} (${i.repository_selection} repositories)`).join(', ') || 'none'}`);
  const repos = await client.request<{ repositories: Array<{ full_name: string }> }>('GET', '/installation/repositories');
  lines.push(`Repositories it can reach: ${repos.repositories.map((r) => r.full_name).join(', ')}`);
  lines.push(`A token for ${repo}: minted`);
  return lines;
}

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** The workflow, the CI script and, with the owner's login, CODEOWNERS (§11.5). */
export function ciFiles(packageDir: string, owner?: string): Array<[string, string]> {
  const files: Array<[string, string]> = [
    ['.github/workflows/harness.yml', readFileSync(join(packageDir, 'templates', 'harness.yml'), 'utf8')],
    ['.github/harness/harness-ci.ts', readFileSync(join(packageDir, 'src', 'ci', 'harness-ci.ts'), 'utf8')],
  ];
  if (owner) {
    // Without a leading slash, a pattern matches in any folder: Claude Code reads these in every one.
    const paths = ['/harness/', '/.github/', '.claude/', 'CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '/ARCHITECTURE.md', '/init.sh', '/.npmrc', '/package.json'];
    files.push(['.github/CODEOWNERS', `# The owner reviews every protected path (razzou-harness).\n${paths.map((p) => `${p} @${owner}`).join('\n')}\n`]);
  }
  return files;
}

/**
 * Writes the CI files into a project, over older versions. The owner commits them with
 * their own credentials: the App can't touch workflows.
 */
export function installCi(projectDir: string, packageDir: string, owner?: string): string[] {
  const files = ciFiles(packageDir, owner);
  for (const [path, content] of files) {
    mkdirSync(join(projectDir, path, '..'), { recursive: true });
    writeFileSync(join(projectDir, path), content);
  }
  return files.map(([path]) => path);
}

/** GitHub Actions' integration id: pinned to it, a required job can't be posted by another App. */
const GITHUB_ACTIONS = 15368;

/** What the ruleset on main enforces, per mode (v3 §3.3). */
export interface RulesetOptions {
  mode: Mode;
  /** The App's id. In Swarm the reviewers' statuses are pinned to it, so nothing else can post them. */
  appId?: number;
  /** In Swarm, the App's commit statuses a PR must carry: `swarm.requiredStatuses`. */
  statuses?: string[];
}

/**
 * The ruleset on main (§11.4, v3 §3.3): PRs only, the harness's jobs green, merge commits, no
 * force push or deletion. Manual needs the owner's approval as a code owner. Swarm needs no
 * approval, and instead the reviewers' statuses, pinned to the App.
 */
export function mainRuleset(requiredChecks: string[], options: RulesetOptions = { mode: 'manual' }): object {
  const swarm = options.mode === 'swarm';
  if (swarm && options.appId === undefined) {
    throw new Error("Swarm pins the reviewers' statuses to the App, whose id is missing: run `harness github-app create --org <org>` first");
  }
  const statuses = swarm ? (options.statuses ?? []) : [];
  return {
    name: 'harness: main',
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    // Repository admins (role 5), that is the owner, may bypass: to install the workflow, or in an emergency.
    bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }],
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: swarm ? 0 : 1,
          dismiss_stale_reviews_on_push: true,
          require_code_owner_review: !swarm,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
          allowed_merge_methods: ['merge'],
        },
      },
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: false,
          required_status_checks: [
            ...requiredChecks.map((context) => ({ context, integration_id: GITHUB_ACTIONS })),
            ...statuses.map((context) => ({ context, integration_id: options.appId })),
          ],
        },
      },
    ],
  };
}

/**
 * What the rules in effect on main lack for the mode (v3 §3.3, v4 §6): nothing when they
 * match. Manual needs a code owner's approval; Swarm needs none, and the reviewers'
 * statuses pinned to the App; both need the harness's CI jobs.
 */
export function rulesProblems(rules: BranchRules | undefined, options: { mode: Mode; requiredChecks: string[]; statuses: string[]; appId?: number }): string[] {
  if (!rules) return ["main's rules can't be read through the App: check them with `harness doctor`"];
  const problems: string[] = [];
  const check = (context: string) => rules.checks.find((c) => c.context === context);
  for (const context of options.requiredChecks) if (!check(context)) problems.push(`the ${context} job isn't required`);
  if (options.mode === 'swarm') {
    if (rules.approvals > 0) problems.push(`${rules.approvals} approval${rules.approvals === 1 ? ' is' : 's are'} required, which the daemon can't give`);
    for (const status of options.statuses) {
      const required = check(status);
      if (!required) problems.push(`the ${status} status isn't required`);
      else if (options.appId !== undefined && required.integrationId !== options.appId) problems.push(`the ${status} status isn't pinned to the App`);
    }
  } else if (rules.approvals < 1 || !rules.codeOwners) {
    problems.push("a code owner's approval isn't required");
  }
  return problems;
}

/** Applies the repository's merge settings and the ruleset of the mode with the owner's own `gh` login. */
export async function applyRepositoryRules(repo: string, requiredChecks: string[], options: RulesetOptions = { mode: 'manual' }): Promise<string[]> {
  const gh = async (args: string[], body?: object) => {
    const result = await run('gh', ['api', ...args, ...(body ? ['--input', '-'] : [])], body ? { input: JSON.stringify(body) } : {});
    if (result.code !== 0) throw new Error(`gh api ${args.join(' ')}: ${(result.stderr || result.stdout).trim()}`);
    return result.stdout;
  };
  const done = [];
  await gh(['--method', 'PATCH', `/repos/${repo}`], {
    allow_merge_commit: true,
    allow_squash_merge: false,
    allow_rebase_merge: false,
    merge_commit_title: 'PR_TITLE',
    merge_commit_message: 'PR_BODY',
    delete_branch_on_merge: false,
  });
  done.push('merge commits only, titled and described by the PR');
  const ruleset = mainRuleset(requiredChecks, options);
  const existing = JSON.parse(await gh([`/repos/${repo}/rulesets`])) as Array<{ id: number; name: string }>;
  const previous = existing.find((r) => r.name === 'harness: main');
  if (previous) await gh(['--method', 'PUT', `/repos/${repo}/rulesets/${previous.id}`], ruleset);
  else await gh(['--method', 'POST', `/repos/${repo}/rulesets`], ruleset);
  const checks = `these checks green: ${requiredChecks.join(', ')}`;
  if (options.mode === 'swarm') {
    const statuses = options.statuses ?? [];
    const gate = statuses.length > 0 ? `these statuses from the App: ${statuses.join(', ')}` : 'no status from the App: the daemon merges on CI alone';
    done.push(`ruleset "harness: main" (Swarm): PRs only, no approval, no force push or deletion, ${checks}, and ${gate}`);
  } else {
    done.push(`ruleset "harness: main" (Manual): PRs only, one approval from a code owner, no force push or deletion, and ${checks}`);
  }
  return done;
}

/**
 * The ruleset of `mode` on main, with the owner's own gh (v3 §2.1): what `harness mode`,
 * the dashboard's switch and `harness github-setup` apply. The App never can: it has no
 * administration permission, on purpose.
 */
export async function applyModeRules(config: Config | undefined, repo: string, mode: Mode): Promise<string[]> {
  const required = config ? requiredChecks(config) : ['verify', 'checks'];
  if (mode === 'manual') return applyRepositoryRules(repo, required, { mode });
  const statuses = (config?.swarm ?? ConfigSchema.shape.swarm.parse(undefined)).requiredStatuses;
  let appId: number | undefined;
  try {
    appId = loadAppCredentials().appId;
  } catch {
    appId = undefined;
  }
  return applyRepositoryRules(repo, required, { mode, statuses, ...(appId !== undefined ? { appId } : {}) });
}

/** What the owner reads when the rules couldn't be applied: the fix is theirs, with gh. */
export function rulesNotChanged(problem: string, repo: string): string {
  return `GitHub's rules on main were not changed: ${problem}\nRun \`harness github-setup --repo ${repo}\` with gh logged in as an admin of the repository.`;
}
