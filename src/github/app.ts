import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The App's identity, kept on the owner's machine: `app.json` and `app.pem` in this folder, mode 0600. */
export function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'harness');
}

export interface AppCredentials {
  appId: number;
  slug: string;
  privateKey: KeyObject;
}

export function loadAppCredentials(dir = configDir()): AppCredentials {
  const info = join(dir, 'app.json');
  const key = join(dir, 'app.pem');
  if (!existsSync(info) || !existsSync(key)) {
    throw new Error(`no GitHub App in ${dir}: create one with \`harness github-app create --org <org>\``);
  }
  const { appId, slug } = JSON.parse(readFileSync(info, 'utf8')) as { appId: number; slug: string };
  return { appId, slug, privateKey: createPrivateKey(readFileSync(key, 'utf8')) };
}

/** What the App may do, and so what each token is restricted to (proposal v2 §11.4). No workflows, no administration. */
export const APP_PERMISSIONS = {
  contents: 'write',
  pull_requests: 'write',
  checks: 'read',
  actions: 'read',
  statuses: 'read',
  metadata: 'read',
} as const;

const API = 'https://api.github.com';

/**
 * The daemon's only door to GitHub: the App, acting on one repository. Tokens last an
 * hour and are restricted to that repository and the App's permissions; they stay in
 * memory and never reach a sandbox.
 */
export class GitHubClient {
  readonly repo: string;
  private readonly credentials: AppCredentials;
  private readonly fetch: typeof fetch;
  private cached?: { token: string; expires: number };

  constructor(credentials: AppCredentials, repo: string, fetchImpl: typeof fetch = fetch) {
    this.credentials = credentials;
    this.repo = repo;
    this.fetch = fetchImpl;
  }

  /** The bot's login, the author of every PR and push the harness makes. */
  get botLogin(): string {
    return `${this.credentials.slug}[bot]`;
  }

  /** A REST call as the App's installation on the repository. Paths may contain `{repo}`. */
  async request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    return this.call<T>(method, path.replaceAll('{repo}', this.repo), `token ${await this.token()}`, body);
  }

  /** A REST call as the App itself, for what happens before any installation token exists. */
  async appRequest<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    return this.call<T>(method, path.replaceAll('{repo}', this.repo), `Bearer ${this.jwt()}`, body);
  }

  /** A raw GET with the installation token, following redirects: job logs live behind one. */
  async download(path: string): Promise<string> {
    const response = await this.fetch(`${API}${path.replaceAll('{repo}', this.repo)}`, {
      headers: { authorization: `token ${await this.token()}`, 'user-agent': 'razzou-harness', 'x-github-api-version': '2022-11-28' },
    });
    if (!response.ok) throw new Error(`GET ${path}: ${response.status} ${(await response.text()).slice(0, 300)}`);
    return response.text();
  }

  /**
   * Environment for one git command against GitHub. The token goes in through git's
   * environment-based config, never on a command line that `ps` would show.
   */
  async gitEnv(): Promise<Record<string, string>> {
    const basic = Buffer.from(`x-access-token:${await this.token()}`).toString('base64');
    return {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
      GIT_TERMINAL_PROMPT: '0',
    };
  }

  get remoteUrl(): string {
    return `https://github.com/${this.repo}.git`;
  }

  async token(): Promise<string> {
    if (this.cached && this.cached.expires - Date.now() > 5 * 60_000) return this.cached.token;
    const installation = await this.appRequest<{ id: number }>('GET', '/repos/{repo}/installation');
    const name = this.repo.split('/')[1];
    const minted = await this.appRequest<{ token: string; expires_at: string }>('POST', `/app/installations/${installation.id}/access_tokens`, {
      repositories: [name],
      permissions: APP_PERMISSIONS,
    });
    this.cached = { token: minted.token, expires: Date.parse(minted.expires_at) };
    return minted.token;
  }

  /** A JSON Web Token for the App, valid for nine minutes (GitHub allows ten), backdated for clock skew. */
  private jwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 9 * 60, iss: String(this.credentials.appId) })}`;
    return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), this.credentials.privateKey).toString('base64url')}`;
  }

  private async call<T>(method: string, path: string, authorization: string, body?: unknown): Promise<T> {
    const response = await this.fetch(`${API}${path}`, {
      method,
      headers: {
        authorization,
        accept: 'application/vnd.github+json',
        'user-agent': 'razzou-harness',
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new GitHubError(`${method} ${path}: ${response.status} ${text.slice(0, 500)}`, response.status);
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

export class GitHubError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
