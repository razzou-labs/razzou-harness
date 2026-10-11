import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { run } from '../util.ts';
import { APP_PERMISSIONS, configDir, GitHubClient, loadAppCredentials } from './app.ts';

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

/** Whether the App works on a repository: who it is, whether it's installed there, and whether a token can be minted. */
export async function checkApp(repo: string, dir = configDir()): Promise<string[]> {
  const client = new GitHubClient(loadAppCredentials(dir), repo);
  const app = await client.appRequest<{ name: string; owner: { login: string }; permissions: Record<string, string> }>('GET', '/app');
  const lines = [`App: ${app.name} (owner ${app.owner.login})`, `Permissions: ${Object.entries(app.permissions).map(([k, v]) => `${k}=${v}`).join(', ')}`];
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
    const paths = ['/harness/', '/.github/', '/.claude/', '/CLAUDE.md', '/AGENTS.md', '/ARCHITECTURE.md', '/init.sh', '/.npmrc', '/package.json'];
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

/** The ruleset on main (§11.4): PRs only, the harness's jobs green, the owner's approval, merge commits, no force push. */
export function mainRuleset(requiredChecks: string[]): object {
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
          required_approving_review_count: 1,
          dismiss_stale_reviews_on_push: true,
          require_code_owner_review: true,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
          allowed_merge_methods: ['merge'],
        },
      },
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: false,
          // 15368 is GitHub Actions: another App can't post a passing "verify".
          required_status_checks: requiredChecks.map((context) => ({ context, integration_id: 15368 })),
        },
      },
    ],
  };
}

/** Applies the repository's merge settings and the ruleset with the owner's own `gh` login. */
export async function applyRepositoryRules(repo: string, requiredChecks: string[]): Promise<string[]> {
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
  const existing = JSON.parse(await gh([`/repos/${repo}/rulesets`])) as Array<{ id: number; name: string }>;
  const ruleset = mainRuleset(requiredChecks);
  const previous = existing.find((r) => r.name === 'harness: main');
  if (previous) await gh(['--method', 'PUT', `/repos/${repo}/rulesets/${previous.id}`], ruleset);
  else await gh(['--method', 'POST', `/repos/${repo}/rulesets`], ruleset);
  done.push(`ruleset "harness: main": PRs only, one approval from a code owner, no force push or deletion, and these checks green: ${requiredChecks.join(', ')}`);
  return done;
}
