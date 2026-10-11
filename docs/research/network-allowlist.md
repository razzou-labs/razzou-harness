# Agent network allowlist (draft)

Status: draft for discussion, 2026-10-09. It will become data in the harness that
generates each sandbox's OpenShell network policy. Projects add hosts to it in
their own config.

## How it is enforced

- OpenShell denies every connection that no rule allows. A host is either an exact
  name or a `**.domain.tld` wildcard, which needs at least three DNS labels and
  does not match the bare domain. That is why `github.com` and `**.github.io`
  are listed separately.
- **read**: the endpoint uses `protocol: rest` with `access: read-only`. Only `GET`,
  `HEAD` and `OPTIONS` reach the host. `POST`, `PUT` and `DELETE` are denied, which
  limits what an agent can send out to the URL itself.
- **git**: read, plus `POST */git-upload-pack` (clone and fetch). `git-receive-pack`
  (push) is never allowed: agents hand back commits as git bundles.
- **provider**: a credential that OpenShell injects for this host only. The agent sees
  a placeholder, never the secret.
- OpenShell always blocks loopback, link-local (including `169.254.169.254`) and
  private addresses.
- Anything not listed is read through the harness `web_read` tool instead. It fetches
  with `GET` only, from outside the sandbox, and logs each read to the dashboard. It
  refuses private, loopback and link-local addresses, including after redirects,
  because it runs on the host and must not reach your LAN or the dashboard.

Bundles are switched on per project. The default for the stack we use is
**core, node, python, aws, terraform**.

## core (always on)

| Hosts | Purpose | Access |
|---|---|---|
| `api.anthropic.com` | Claude Code, with the subscription token injected | provider |
| `github.com` | clone and fetch public repositories | git |
| `api.github.com` | public API, unauthenticated (60 requests/hour) | read |
| `codeload.github.com` | repository archives | read |
| `**.githubusercontent.com` | raw files, release assets, gists | read |
| `**.github.io` | project documentation sites (esbuild, aws.github.io, ...) | read |
| `docs.github.com` | GitHub and Actions documentation | read |
| `gitlab.com` | clone and fetch | git |
| `**.gitlab.io` | project documentation sites | read |
| `stackoverflow.com`, `**.stackexchange.com`, `serverfault.com`, `superuser.com`, `askubuntu.com` | Q&A | read |
| `**.wikipedia.org` | reference | read |
| `developer.mozilla.org`, `web.dev`, `developer.chrome.com`, `caniuse.com` | web platform | read |
| `www.w3.org`, `**.whatwg.org`, `www.rfc-editor.org`, `datatracker.ietf.org`, `www.iana.org` | standards and RFCs | read |
| `json-schema.org`, `yaml.org`, `www.json.org`, `semver.org`, `www.conventionalcommits.org` | formats and conventions | read |
| `owasp.org`, `cheatsheetseries.owasp.org` | security guidance | read |
| `man7.org`, `manpages.ubuntu.com`, `www.gnu.org`, `wiki.archlinux.org`, `docs.kernel.org` | Linux and shell | read |
| `docs.docker.com` | container documentation | read |
| `docs.claude.com`, `code.claude.com`, `docs.anthropic.com`, `www.anthropic.com` | Claude and Claude Code documentation | read |

## node

| Hosts | Purpose | Access |
|---|---|---|
| `registry.npmjs.org` | package installs (images set `audit=false`; `npm audit` is a `POST`) | read |
| `www.npmjs.com`, `npmjs.com` | package pages | read |
| `registry.yarnpkg.com`, `repo.yarnpkg.com`, `yarnpkg.com` | Yarn | read |
| `jsr.io`, `npm.jsr.io` | JSR packages | read |
| `nodejs.org` | Node.js documentation and downloads | read |
| `cdn.jsdelivr.net`, `unpkg.com`, `esm.sh` | browse published package files | read |
| `www.typescriptlang.org`, `tc39.es` | TypeScript and ECMAScript | read |
| `react.dev`, `nextjs.org`, `vite.dev`, `vitest.dev`, `jestjs.io`, `playwright.dev`, `testing-library.com`, `pptr.dev` | frameworks and testing | read |
| `eslint.org`, `typescript-eslint.io`, `prettier.io`, `biomejs.dev` | lint and format | read |
| `pnpm.io`, `bun.sh`, `docs.deno.com`, `webpack.js.org`, `rollupjs.org`, `swc.rs`, `turbo.build`, `nx.dev` | tooling | read |
| `expressjs.com`, `fastify.dev`, `docs.nestjs.com`, `hono.dev`, `trpc.io`, `zod.dev` | servers and validation | read |
| `www.prisma.io`, `orm.drizzle.team` | databases | read |
| `tailwindcss.com`, `svelte.dev`, `vuejs.org`, `angular.dev`, `storybook.js.org` | front end | read |
| `graphql.org`, `www.apollographql.com`, `socket.io` | APIs and realtime | read |

## python

| Hosts | Purpose | Access |
|---|---|---|
| `pypi.org`, `files.pythonhosted.org` | package installs | read |
| `docs.python.org`, `www.python.org`, `peps.python.org` | language | read |
| `packaging.python.org`, `pip.pypa.io`, `docs.astral.sh` | packaging, uv, ruff | read |
| `**.readthedocs.io`, `**.readthedocs.org` | most library documentation | read |
| `docs.pytest.org`, `fastapi.tiangolo.com`, `docs.pydantic.dev`, `flask.palletsprojects.com`, `docs.djangoproject.com` | frameworks | read |

## aws

AWS API calls are not in this table. They go to the `<service>.<region>.amazonaws.com`
endpoints the project uses, which OpenShell signs with the agents' view-only role.
The harness generates those entries from the project's service list.

| Hosts | Purpose | Access |
|---|---|---|
| `docs.aws.amazon.com`, `aws.amazon.com`, `repost.aws` | documentation and pricing | read |
| `**.awsstatic.com` | documentation assets | read |
| `awscli.amazonaws.com` | AWS CLI installers | read |
| `docs.powertools.aws.dev`, `serverlessland.com` | Lambda tooling and patterns | read |

## terraform

| Hosts | Purpose | Access |
|---|---|---|
| `registry.terraform.io` | provider and module index | read |
| `releases.hashicorp.com` | provider downloads | read |
| `developer.hashicorp.com`, `www.terraform.io`, `discuss.hashicorp.com` | documentation and forum | read |
| `terraform-docs.io`, `www.checkov.io` | IaC tooling | read |

Images set `CHECKPOINT_DISABLE=1`, so `checkpoint-api.hashicorp.com` is not needed.

## Opt-in bundles

| Bundle | Hosts | Access |
|---|---|---|
| go | `proxy.golang.org`, `sum.golang.org`, `go.dev`, `pkg.go.dev` | read |
| rust | `index.crates.io`, `static.crates.io`, `crates.io`, `docs.rs`, `doc.rust-lang.org`, `static.rust-lang.org`, `www.rust-lang.org` | read |
| jvm | `repo.maven.apache.org`, `repo1.maven.org`, `central.sonatype.com`, `plugins.gradle.org`, `services.gradle.org`, `docs.gradle.org`, `docs.oracle.com`, `kotlinlang.org` | read |
| opentofu | `registry.opentofu.org`, `opentofu.org` | read |
| browsers | `cdn.playwright.dev`, `playwright.download.prss.microsoft.com` (better: bake browsers into the image) | read |

## Never allowed, not even through `web_read`

- Paste, file-drop, tunnel and request-capture services: `pastebin.com`,
  `transfer.sh`, `0x0.st`, `file.io`, `webhook.site`, request bins, `ngrok` and
  `trycloudflare.com` tunnels.
- Chat apps and personal storage that hold your data: `claude.ai`, `chatgpt.com`,
  `drive.google.com`, `dropbox.com`.
- Arbitrary cloud buckets (`*.s3.amazonaws.com`, `storage.googleapis.com`), except
  through the signed AWS provider.
- Email, SMTP, and anything that is not HTTP(S).
