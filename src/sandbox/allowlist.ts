/**
 * The hosts sandboxes may reach directly, by bundle (docs/research/network-allowlist.md).
 * `read` allows GET, HEAD and OPTIONS only. `git` also allows clone and fetch, never push.
 * Hosts are exact names or `**.domain.tld` (OpenShell needs three labels for a wildcard,
 * and `**.x.y` doesn't match `x.y` itself). Everything else goes through `web_read` (M2).
 */
export interface HostRule {
  host: string;
  access: 'read' | 'git';
  /** Package registries address scoped packages as `@scope%2fname`. */
  encodedSlash?: boolean;
}

const read = (...hosts: string[]): HostRule[] => hosts.map((host) => ({ host, access: 'read' }));
const git = (...hosts: string[]): HostRule[] => hosts.map((host) => ({ host, access: 'git' }));

export const BUNDLES: Record<string, HostRule[]> = {
  core: [
    ...git('github.com', 'gitlab.com'),
    ...read(
      'api.github.com', 'codeload.github.com', '**.githubusercontent.com', '**.github.io', 'docs.github.com', '**.gitlab.io',
      'stackoverflow.com', '**.stackexchange.com', 'serverfault.com', 'superuser.com', 'askubuntu.com', '**.wikipedia.org',
      'developer.mozilla.org', 'web.dev', 'developer.chrome.com', 'caniuse.com',
      'www.w3.org', '**.whatwg.org', 'www.rfc-editor.org', 'datatracker.ietf.org', 'www.iana.org',
      'json-schema.org', 'yaml.org', 'www.json.org', 'semver.org', 'www.conventionalcommits.org',
      'owasp.org', 'cheatsheetseries.owasp.org',
      'man7.org', 'manpages.ubuntu.com', 'www.gnu.org', 'wiki.archlinux.org', 'docs.kernel.org', 'docs.docker.com',
      'docs.claude.com', 'code.claude.com', 'docs.anthropic.com', 'www.anthropic.com',
    ),
  ],
  node: [
    { host: 'registry.npmjs.org', access: 'read', encodedSlash: true },
    { host: 'registry.yarnpkg.com', access: 'read', encodedSlash: true },
    ...read(
      'www.npmjs.com', 'npmjs.com', 'repo.yarnpkg.com', 'yarnpkg.com', 'jsr.io', 'npm.jsr.io', 'nodejs.org',
      'cdn.jsdelivr.net', 'unpkg.com', 'esm.sh', 'www.typescriptlang.org', 'tc39.es',
      'react.dev', 'nextjs.org', 'vite.dev', 'vitest.dev', 'jestjs.io', 'playwright.dev', 'testing-library.com', 'pptr.dev',
      'eslint.org', 'typescript-eslint.io', 'prettier.io', 'biomejs.dev',
      'pnpm.io', 'bun.sh', 'docs.deno.com', 'webpack.js.org', 'rollupjs.org', 'swc.rs', 'turbo.build', 'nx.dev',
      'expressjs.com', 'fastify.dev', 'docs.nestjs.com', 'hono.dev', 'trpc.io', 'zod.dev',
      'www.prisma.io', 'orm.drizzle.team', 'tailwindcss.com', 'svelte.dev', 'vuejs.org', 'angular.dev', 'storybook.js.org',
      'graphql.org', 'www.apollographql.com', 'socket.io',
    ),
  ],
  python: read(
    'pypi.org', 'files.pythonhosted.org', 'docs.python.org', 'www.python.org', 'peps.python.org',
    'packaging.python.org', 'pip.pypa.io', 'docs.astral.sh', '**.readthedocs.io', '**.readthedocs.org',
    'docs.pytest.org', 'fastapi.tiangolo.com', 'docs.pydantic.dev', 'flask.palletsprojects.com', 'docs.djangoproject.com',
  ),
  aws: read('docs.aws.amazon.com', 'aws.amazon.com', 'repost.aws', '**.awsstatic.com', 'awscli.amazonaws.com', 'docs.powertools.aws.dev', 'serverlessland.com'),
  terraform: read('registry.terraform.io', 'releases.hashicorp.com', 'developer.hashicorp.com', 'www.terraform.io', 'discuss.hashicorp.com', 'terraform-docs.io', 'www.checkov.io'),
  go: read('proxy.golang.org', 'sum.golang.org', 'go.dev', 'pkg.go.dev'),
  rust: read('index.crates.io', 'static.crates.io', 'crates.io', 'docs.rs', 'doc.rust-lang.org', 'static.rust-lang.org', 'www.rust-lang.org'),
  jvm: read('repo.maven.apache.org', 'repo1.maven.org', 'central.sonatype.com', 'plugins.gradle.org', 'services.gradle.org', 'docs.gradle.org', 'docs.oracle.com', 'kotlinlang.org'),
  opentofu: read('registry.opentofu.org', 'opentofu.org'),
  browsers: read('cdn.playwright.dev', 'playwright.download.prss.microsoft.com'),
};

/** Throws on a host OpenShell would reject, so a bad entry fails at load time rather than at sandbox creation. */
export function checkHost(host: string): void {
  const labels = host.split('.');
  const wildcard = host.includes('*');
  if (labels.some((label) => label === '')) throw new Error(`host ${host}: empty label`);
  if (wildcard && labels.length < 3) throw new Error(`host ${host}: a wildcard needs at least three labels`);
  if (labels.slice(1).some((label) => label.includes('**'))) throw new Error(`host ${host}: ** may only be the whole first label`);
}
