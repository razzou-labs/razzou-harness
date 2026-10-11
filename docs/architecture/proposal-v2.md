# Harness v2: architecture proposal v2

| | |
|---|---|
| Status | **Accepted** by the owner on 2026-10-09, with the decisions D24 to D26 in §20. It supersedes [v1](proposal-v1.md). |
| Date | 2026-10-09 |
| Authors | Claude, with the owner (design chat of 2026-10-08 and 2026-10-09) |
| Sources | The owner's project brief; Anthropic, *Effective harnesses for long-running agents*; the abandoned v1 harness (`~/dev/harness`, design revision 2); NVIDIA OpenShell 0.1.2 docs and a live test ([research](../research/openshell-subscription-check.md)); `terraform-bootstrap`; AWS managed policy references (`ViewOnlyAccess` v46, `SecurityAudit` v94) |

## Contents

1. [Summary](#1-summary)
2. [What we take from the sources](#2-what-we-take-from-the-sources)
3. [Weak spots in the brief and how this design resolves them](#3-weak-spots-in-the-brief-and-how-this-design-resolves-them)
4. [Architecture overview](#4-architecture-overview)
5. [Components and interfaces](#5-components-and-interfaces)
6. [Roles and permissions](#6-roles-and-permissions)
7. [Lifecycles](#7-lifecycles)
8. [Project artifacts](#8-project-artifacts)
9. [Communication](#9-communication)
10. [State](#10-state)
11. [Git, GitHub and CI](#11-git-github-and-ci)
12. [AWS and Terraform](#12-aws-and-terraform)
13. [Network access](#13-network-access)
14. [Dashboard](#14-dashboard)
15. [Recovery](#15-recovery)
16. [Security model](#16-security-model)
17. [Package, CLI and setup](#17-package-cli-and-setup)
18. [Delivery plan](#18-delivery-plan)
19. [Open decisions for the owner](#19-open-decisions-for-the-owner)
20. [Decisions log](#20-decisions-log)
21. [Appendix: the brief's 40 open questions](#appendix-the-briefs-40-open-questions)

## Changes from v1

| § | Change |
|---|---|
| All | The brief's "system part" is now called a **module**: `harness/modules/<module>/`, `harness module new`, `MODULE_*` events, `architect-<module>` sandboxes. The daemon's own building blocks are now called "components", so "module" has one meaning. |
| 11.3 | Exactly one PR per plan. Each feature lands as one commit on the plan branch. PRs merge with merge commits only, so `main` keeps every feature commit. |
| 7.3, 8.5 | A feature's `progress.txt` line lands in that feature's own commit, instead of a separate bot commit. |
| 11.4, 17.3 | A new GitHub App, dedicated to the harness. |
| 17.1 | The package is named `razzou-harness`. |
| 18 | Throwaway repositories during development. A blank repository is for the owner's end-to-end test. |
| 19, 20 | v1's open decisions are settled (D17 to D23). One small naming point remains. |

### Amendments after acceptance

| Date | § | Change |
|---|---|---|
| 2026-10-09 | 5.3, 7.5, 15, 18.1 | Spike 1: input piped into `openshell sandbox exec` arrives only when stdin closes. So the Manager runs detached and is fed through a file, which also lets it outlive a daemon restart. |
| 2026-10-10 | 5.4, 12.4, 18.1 | Spike 2: OpenShell's signing works with the read-only role for the AWS CLI and Terraform. Image `ENV` variables don't reach sandbox processes, so settings go through `--env`. A region must always be set, or the AWS CLI calls global endpoints that the policy doesn't list. |
| 2026-10-10 | 12.2, 12.7 | `terraform-bootstrap` PR #9 implements §12.7. It also denies SNS subscription endpoints, which hold emails and phone numbers, and onboards the first project with a harness view role. The gateway user's key goes into OpenShell through an `aws-sts-assume-role` refresh. |
| 2026-10-10 | 5.3, 7.5, 15, 18.1 | Spike 4: the Architect's sandbox is created without a command, and its login shell `exec`s a launcher that relaunches Claude with `--resume` whenever it exits. A sandbox started detached with a command gets no terminal. |
| 2026-10-10 | 6.4, 8.7, 18.1 | Spike 3: the Manager runs with `--restricted`, `dontAsk` and three `git` allow rules. A repository's `.claude/settings.json` can run hooks in any agent that doesn't use `--restricted`, so `.claude/**`, `CLAUDE.md` and `AGENTS.md` are now protected files. |
| 2026-10-10 | 7.3, 18 | M1 on OpenShell: a sandbox name is a DNS label of at most 19 characters, so sandboxes are named `dev-<hash>-a<n>` and `chk-<hash>-a<n>`, hashing the project and the feature. Claude Code's `--json-schema` rejects a schema that names the 2020-12 meta-schema, so the report schema is draft 7 without `$schema`. A detached launch backgrounds only the simple command; `cd x && cmd &` keeps the exec open until the agent ends. |
| 2026-10-11 | 6.4, 7.3, 7.4, 9.2, 9.3 | M2 ([notes](../research/m2-manager-run.md)). The Developer's report stays its structured output (`--json-schema`), which Claude Code enforces; there are no `report_done` or `report_blocked` tools. After a failure other than a rejection, the Manager gives guidance with `retry_feature`. `submit_plan` replaces `open_plan_pr`, and M3 opens the PR from it. The daemon checks out each attempt in the Manager's clone, so `get_diff` isn't needed. The shim and the role's `tools.json` are uploaded into each sandbox, not built into the image. When Claude Code fails to start, the attempt doesn't count and the pipeline pauses with its error. In `dontAsk` mode Claude Code still runs its read-only commands, such as `ls` and `find`, inside the Manager's clone, which adds nothing to its read access. |
| 2026-10-11 | 8.7, 11.3–11.7, 17.3 | M3 ([notes](../research/m3-github-run.md)). The CI script is one TypeScript file that Node 24 runs directly: vendored as `.github/harness/harness-ci.ts` by `harness install-ci`, and imported by the daemon, so both apply the same rules. For a `Plan:` or `Fix:` PR, `verify` compares every protected file and field between the base and the head, with the base's rules; `harness/lock.json` (`harness lock`, later M4's freeze step) is checked only on `Arch:` PRs. A CI fix round is a work item named `fix<n>`, built and reviewed like a feature, with CI as its check, and it lands as `fix(<module>/<plan>): CI, round <n>`. The daemon's git ignores the owner's git configuration. Required checks are pinned to GitHub Actions' integration. |
| 2026-10-11 | 5.3, 5.4, 7.1, 7.5, 9.6 | M4 ([notes](../research/m4-architect-run.md)). The Architect's sandbox is created with `--tty` and a main command that waits for the launcher, then runs it: `openshell sandbox connect` attaches to that terminal, and `stop`/`start` runs it again, so no `.bash_profile` hook is needed (spike 4 hadn't tried `--tty`). Its messages reach it through a `UserPromptSubmit` hook, with the owner's next prompt. The `grill-me` skill, the role prompt and the hook settings are uploaded into each sandbox, not built into the image. `submit_design` refuses checks with `/sandbox/` paths: they pass in sandboxes, but not in CI. The daemon's hash-list commit is synced back into the Architect's branch, so a resubmission updates the open Arch PR. The build starts once the design is on `main`. |
| 2026-10-11 | 6.2, 11.5, 12.4, 12.6 | M5 ([notes](../research/m5-aws-terraform-run.md)). `harness probe` runs §6.2's list from a sandbox set up like a Developer's, with the AWS provider. M6's `doctor --probe` adds the other roles and the tests outside the sandboxes. A network rule covers a process only if the process, or one above it, is a listed program. `bash -c` with a single command replaces itself with that command, which OpenShell then refuses whatever the host, so the probe keeps bash as the parent. S3 answers 404 for a missing key even under an explicit deny when the role may list the bucket, so the probe tries another project's state that exists. `tf-plan` is required as soon as `harness/config.json` has a `terraform` section, not when `iac/` exists: when it fails, GitHub skips `checks` and counts the skipped job as passed. After a merge that touches the Terraform folder, the daemon follows `tf-apply` on the merge commit, then runs the post-deploy checks. |
| 2026-10-11 | 7.1, 11.3, 14, 17.1 | M6 ([notes](../research/m6-fresh-setup-run.md)). `harness doctor --probe` replaces `harness probe`. It probes each role's sandbox, then checks from outside that `web_read` refuses a private address, that GitHub refuses a workflow from the App, and that `main` needs a code owner's approval. `node-pty` is an optional dependency that compiles on Linux, so the install needs `--allow-scripts=node-pty`; without it, the dashboard has no terminals. When the Architect has messages and no one is at its terminal, the dashboard types a short prompt into it. Live transcripts replace the activity list, with token totals from each turn's `result`. A broken check in a design exposed three gaps, now closed. Before the next attempt, the daemon merges `main` into the plan branch when `main` has moved, or fast-forwards a plan branch with nothing of its own. A feature's definition hash covers the check scripts it runs. No new attempt starts in a module while a design change is in review. |

---

## 1. Summary

The harness is a small TypeScript daemon plus three Claude Code agents, each in its
own OpenShell sandbox. The owner designs one module at a time with a persistent
Architect. The daemon then builds that module one feature at a time: one Developer at a
time writes the code, a long-lived Manager reviews it, and fresh sandboxes run the
checks. Each completed plan becomes one pull request, which the owner merges. CI
applies Terraform after the merge.

A **module** is the unit of design: one architecture proposal, then several plans, each
made of features. The brief calls it a "system part".

The ten things that shape everything else:

1. **Code runs the loop.** Agents do the work and make judgments. Code decides what a
   judgment is allowed to change.
2. **Three agent roles, nothing else.**
   - The Architect is a persistent session, one per module.
   - The Manager is a long-lived session, one per module.
   - The Developer runs in a fresh sandbox for each feature attempt.
3. **Agents hold no credentials.**
   - OpenShell adds the Claude token and signs AWS requests in its proxy.
   - Only the daemon talks to GitHub, as a GitHub App.
4. **The host never runs project code.** Builds, tests and checks run in sandboxes.
5. **Agent messages are claims; only the daemon records facts.**
   - The daemon's event log is the message bus.
   - The daemon reaches into each sandbox. No sandbox connects to the daemon, so no
     sandbox can pretend to be another.
6. **Protected artifacts change only in an `Arch:` PR that the owner merges.**
   - Protected artifacts are plans, features, checks, the configs they depend on, and
     selected `package.json` fields.
   - They are listed with hashes in `harness/lock.json`.
   - CI checks this using code from the base branch, not from the PR.
7. **Agents see AWS through one view-only role and never write.** Terraform applies only
   in CI, after the owner merges.
8. **Every task has a deadline and an attempt budget, recorded before it starts.** The
   brakes are a handful of counters, not a set of health checks.
9. **Git holds what must last.** `.harness/` holds runtime state, and it can be rebuilt
   from git and GitHub if it is lost.
10. **The dashboard is the owner's main interface.** The conversation with the Architect
    happens in its real Claude Code terminal, which the dashboard embeds.

Out of scope for v1:
- parallel Developers;
- Codex and Cursor adapters (the interface exists, only Claude Code is implemented);
- stacked plans;
- one daemon serving several projects;
- production deploys;
- remote access to the dashboard.

---

## 2. What we take from the sources

### 2.1 *Effective harnesses for long-running agents*

| The article | This harness |
|---|---|
| Each session starts with no memory, and compaction alone did not fix that. | State lives outside the agents: frozen plan files, `progress.txt`, git history and the event log. Each Developer attempt starts a fresh session. The long-lived Architect and Manager treat their context as a cache, and re-read state through tools. |
| An initializer agent sets up the environment, a feature list, a progress file and `init.sh`. | For each module, the Architect writes plans with features (JSON), checks, `init.sh` changes and owner actions. The daemon keeps `progress.txt`. |
| The feature list is JSON, and agents must not edit or remove tests. | Plan files and checks are protected by hashes and by CI. Only the daemon records a feature as accepted. |
| Agents work on one feature at a time. | Each Developer attempt covers one feature, in a fresh sandbox. |
| A session starts by checking where it is, reading progress and the git log, picking a feature, running `init.sh`, and smoke-testing what already works. | The daemon picks the feature and runs `init.sh` and the regression checks before the agent starts. It puts the results, the end of the progress file and the git log in the task. |
| A session ends clean and committed. | The Developer commits. The daemon verifies the work and merges it. Work that doesn't pass never reaches the plan branch. |
| Agents marked features done without testing them. | The worker never decides. The daemon runs the checks in a fresh sandbox, the Manager reviews the diff, and CI re-runs everything. |
| Agents should test as a user would. | The Architect writes the checks. Application features get test scripts with synthetic data. Infrastructure features get assertions on the Terraform plan before merge, and AWS checks after apply. |
| Git is used to recover from bad changes. | Each attempt lives on its own ref, and a rejected attempt is never merged. |
| Open question: one general agent, or several specialists? | Three roles, with code running the loop. There are no reviewer, QA or cleanup agents. |

### 2.2 The v1 harness

**What carries over.** These lessons were tested on the owner's machine:
- CI must run its checks from the base branch, because a PR can rewrite a checker that
  runs from its own head.
- `--agent` replaces Claude Code's system prompt, while `--append-system-prompt-file`
  keeps it.
- Headless sessions load the owner's MCP servers and tools such as `SendMessage` and
  remote triggers unless they are given an explicit `--tools` list and
  `--strict-mcp-config`.
- The check files themselves must be hashed, not only the command that runs them.
- The worker never declares a feature done; something else verifies it.
- Each agent needs its own clone, never the owner's working copy.

**What goes, and why v1 grew.** Each failure got its own mechanism, and a homemade
sandbox had to be patched hole by hole. That produced:
- five roles: a reviewer, headless "architect calls", and two kinds of manager
  judgment calls;
- failure signatures, adoption scans, guided fixes and five kinds of budget;
- an orphan state branch, and GitHub issues used as the owner's inbox;
- bubblewrap with a long list of exceptions;
- feature files split into frozen and mutable fields;
- enforced `allowed_paths`.

v2 replaces all of this with a few invariants (§4) and OpenShell.

### 2.3 OpenShell

**What we rely on.** These are verified in the docs and, for credentials, in a live test:
- **Isolation:** each sandbox is a container with no network of its own. All traffic goes
  through a trusted proxy, which checks a policy per program, per host and per HTTP
  method and path. Filesystem and system-call limits apply as well.
- **Credentials:** they never enter the sandbox. The proxy replaces a placeholder with
  the real token, only on hosts named in the provider profile. Our subscription test
  showed the Claude token injected only on `api.anthropic.com`. For AWS, the proxy
  signs requests with credentials that the gateway gets by assuming a role.
- **Blocked addresses:** the cloud metadata address `169.254.169.254`, loopback and
  private addresses are always blocked.
- **Persistence:** sandboxes outlive the process that started them.
  `openshell sandbox connect` reattaches to a sandbox's main process and replays its
  recent output. `exec`, `upload` and `download` work from the host.
- **Hot reload:** network policy changes take effect without recreating the sandbox.

**Its limits, and how we work around them:**

| Limit | Workaround |
|---|---|
| No "allow every host" rule: wildcards need three DNS labels. | Allowlist bundles plus a `web_read` tool (§13). |
| The built-in Claude Code provider injects an API key. | A custom provider profile for the subscription token (tested). |
| Mounting host folders is opt-in, and bypasses the filesystem policy. | Code moves in and out as git bundles; nothing is mounted. |
| It is version 0.1.x and still changing. | Pin the version, keep all CLI calls in one adapter file, and re-run the permission probe after upgrades. |

---

## 3. Weak spots in the brief and how this design resolves them

| Brief | Problem | Resolution |
|---|---|---|
| §10 hash table | Anyone who can push can change a protected file and its hash in the same commit. | No agent can write to GitHub. The hash list changes only in `Arch:` PRs. CI verifies it with code from the base branch, and the owner merges (§11). |
| §5, §8 infrastructure validation | "The queue exists" is only true after merge and apply. | Checks run in two phases: assertions on the Terraform plan before merge, and view-only AWS checks after apply (§8.3, §12.6). |
| §16 broad Internet read | OpenShell denies everything by default and has no "allow every host" rule. | Allowlist bundles plus `web_read` (§13). |
| §6 "its own git worktree" | A mounted worktree would expose the host repository's `.git`, including its branches and its hooks, and hooks run on the host. | Each sandbox gets its own clone; code moves in and out as git bundles (§11.2). |
| §12 read-only AWS | `ReadOnlyAccess` can read S3 objects, DynamoDB items and SSM parameters. | `ViewOnlyAccess` plus `SecurityAudit` plus an explicit deny (§12.2). |
| §11, §12 the agents' AWS role | The project's own Terraform could widen it, and CI would apply that after a merge. | The role lives in `terraform-bootstrap` and is protected by `TerraformDeployBoundary` (§12.7). |
| §7 the Manager orchestrates | A model cannot be the brake on itself. | Code runs the loop; the Manager makes judgments and code permits them (§4, §7.4). |
| §18, §20 messages to the Architect | An interactive session cannot be woken while the owner is away. | Messages queue up and appear as owner tasks (§9.6). |
| §6, §7 validation | Validation runs code the agents wrote. | Checks run in fresh check sandboxes; the host never runs project code (§5.3). |
| §9 CI protection | On a pull request, GitHub runs the workflow from the PR's own branch, so a PR could rewrite the check that guards it. | The GitHub App has no workflow permission. Checks are data, not workflow edits. Workflow changes go through owner gates (§11.5, §11.6). |
| §10 protected checks | A check can be weakened through its config, `package.json`, `.npmrc` or suppression comments, without touching the check itself. | Whole-file and JSON-field hashes, a lockfile check, and a review of new suppressions (§8.7). |
| Container networking | A VPN exit node, such as Tailscale's, can cut it. | `harness doctor` tests for it (§17.3). |

---

## 4. Architecture overview

```
 owner's machine (Linux)
┌────────────────────────────────────────────────────────────────────────────┐
│ Chrome ─► dashboard ─┐                                                     │
│                      │                                                     │
│            ┌─────────┴─────────┐  openshell CLI   ┌──────────────────────┐ │
│            │  harness daemon   │ ────────────────►│  OpenShell (Docker)  │ │
│            │  event log        │  exec · upload · │  architect-<module>  │ │
│            │  bare git repo    │  download ·      │  manager-<module>    │ │
│            └─────────┬─────────┘  connect         │  dev-<feature>-a<n>  │ │
│                      │                            │  check-<run>         │ │
│                      │                            └──────────┬───────────┘ │
└──────────────────────┼───────────────────────────────────────┼─────────────┘
                       │ GitHub App                            │ OpenShell proxy:
                       ▼                                       │ Claude token, AWS signing,
          GitHub: repo, PRs, Actions                           │ allowlisted web reads
                       │ OIDC, after merge only                ▼
                       └──────────────────► AWS staging ◄── view-only reads by agents
```

### Invariants

The rest of this document refers to these by number.

| # | Invariant | Enforced by |
|---|---|---|
| I1 | Code runs the loop. Agents judge, and code permits. | The orchestrator's state machine accepts only the actions allowed in the current state. |
| I2 | Agents hold no credentials. | OpenShell providers (Claude token, AWS signing). The GitHub App key exists only on the host. |
| I3 | Only the daemon records facts. | Agents can only send messages. Events are written by the daemon alone. |
| I4 | The host never runs project code, and never runs git hooks that came from an agent. | Sandboxes for all execution; a bare repository; code moved as bundles. |
| I5 | Protected artifacts change only through `Arch:` PRs that the owner merges. | `harness/lock.json`, the CI `verify` job running from the base branch, CODEOWNERS, repository rules. |
| I6 | Infrastructure changes only through CI, after a merge. | View-only IAM, the `staging` environment restricted to `main`, OIDC trust, `TerraformDeployBoundary`. |
| I7 | Every task has a deadline and an attempt budget, recorded before it starts. | Brakes (§7.4) checked by the orchestrator. |
| I8 | Git holds durable truth. `.harness/` can be rebuilt from git and GitHub. | `progress.txt`, the hash list and plan files are in git. `harness recover` rebuilds the rest (§15). |
| I9 | Claude Code's built-in system prompt is never replaced. | `--append-system-prompt-file` only. `--system-prompt` and `--agent` are never used. |
| I10 | A role's permissions are defined once, in code. | A role definition generates the OpenShell policy, the providers, the agent tools and the Claude Code flags. `harness doctor --probe` tests the result (§6.2). |

---

## 5. Components and interfaces

### 5.1 The daemon

There is one Node.js process per project. `harness up` starts it, and it runs on the
host as the owner's user.

| Component | Responsibility |
|---|---|
| Orchestrator | The state machines for modules, plans, features, attempts and pull requests (§7). It runs a reconcile loop every 15 seconds and after every event (§15). |
| Event store | Appends to `.harness/events.jsonl`, projects the log into `state.json`, and rebuilds state on start. |
| Bus and tools | Message types, their schemas and their access rules, plus the handlers behind each agent tool (§9). |
| Sandbox driver | The only component that calls the `openshell` CLI, always with `--output json`. |
| Agent adapters | Launch commands and stream parsing for each agent CLI. v1 ships Claude Code. |
| Git service | A bare repository at `.harness/git/repo.git`, bundles, branches and attempt refs. |
| GitHub service | GitHub App authentication with one-hour tokens, branch pushes, pull requests, and polling of checks and Actions runs. |
| Check runner | Runs checks in a check sandbox and reports exit codes and output tails. |
| Web reader | Implements `web_read` (§13). |
| Dashboard server | HTTP API, server-sent events, terminal WebSockets and owner actions, all on `127.0.0.1` (§14). |

### 5.2 Main interfaces

```ts
interface SandboxDriver {
  create(spec: SandboxSpec): Promise<void>;           // openshell sandbox create --detach
  exec(name: string, argv: string[], o?: ExecOptions): Promise<ExecResult>;
  stream(name: string, argv: string[]): ExecStream;     // long-lived exec: outbox tail, Manager I/O
  upload(name: string, from: string, to: string): Promise<void>;
  download(name: string, from: string, to: string): Promise<void>;
  status(name: string): Promise<SandboxStatus | undefined>;
  stop(name: string): Promise<void>;
  start(name: string): Promise<void>;
  remove(name: string): Promise<void>;
}

interface SandboxSpec {
  name: string;
  role: Role | 'check';
  image: string;
  providers: string[];         // e.g. ['claude-sub', 'aws-view-<project>']
  policy: string;              // OpenShell policy YAML, generated from the role (§6.2)
  main?: string[];             // the Architect's launcher; otherwise `sleep infinity`
}

interface AgentAdapter {
  id: 'claude-code' | 'codex' | 'cursor';
  providers(role: Role): string[];
  launch(role: Role, run: AgentRun): string[];         // argv run inside the sandbox
  parse(line: string): AgentActivity | undefined;      // stream → tool calls, usage, usage-limit hits
}

interface CheckRunner {
  run(req: {
    base: string;              // commit of the plan branch head
    commits?: string;          // bundle with the attempt's commits
    checks: Check[];
    terraformPlan?: boolean;   // produce plan JSON for assertions first
  }): Promise<CheckRunResult>; // per check: exit code, duration, output tail
}
```

### 5.3 Sandboxes

| Sandbox | Lifetime | Main process | Providers | Network |
|---|---|---|---|---|
| `architect-<module>` | The module's life. Stopped while idle and kept until the module is archived. | A login shell in OpenShell's retained terminal, which `exec`s the Claude Code launcher (§7.5). | Claude, AWS view | All bundles plus project extras |
| `manager-<module>` | The module's build phase. | `sleep infinity`. Claude runs detached inside the sandbox, fed from a file (§7.5). | Claude, AWS view | Core plus project bundles |
| `dev-<module>-<plan>-<feature>-a<n>` | One attempt. | `sleep infinity`. The agent is launched detached. | Claude, AWS view | Project bundles |
| `check-<run>` | One check run. | `sleep infinity`. Checks run through `exec`. | AWS view, only if a check needs it | Project bundles |

All four kinds use the same image. Roles differ by policy, providers and flags, not by
image. Developer and check sandboxes are deleted once their bundle and logs have been
copied out.

### 5.4 Image

The harness ships `images/agent/Dockerfile`, and `harness doctor --build-images` builds
it. The image contains:
- Ubuntu 24.04, `ca-certificates`, `git`, `bash`, `curl` and `iproute2`;
- Node 24 and a pinned Claude Code;
- pinned Terraform, AWS CLI v2 and Python 3;
- the harness MCP shim (§9.2) and the role launchers;
- a non-root `agent` user and `/sandbox` as the workspace;
- npm's `audit=false` and `fund=false`, set in the image's npm configuration file.

The environment settings `DISABLE_AUTOUPDATER=1`,
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `CHECKPOINT_DISABLE=1`,
`AWS_DEFAULT_REGION` and `AWS_REGION` are not baked into the image: OpenShell doesn't
pass an image's `ENV` to sandbox processes (spike 2). The daemon passes them with
`openshell sandbox create --env`, and the launchers export them again. Inside a sandbox,
`HOME` is `/sandbox`.

A project can add a `harness/Dockerfile` (protected) that starts `FROM` the harness
image.

### 5.5 CLI

These commands are detailed in §17.2:
- `harness init`, `doctor`, `up`, `down`, `status`, `attach`;
- `harness module new`;
- `harness owner apply`;
- `harness recover`;
- `harness upgrade`;
- `harness gc`.

---

## 6. Roles and permissions

### 6.1 Permission matrix

| Layer | Architect | Manager | Developer | Check run | Daemon (host) |
|---|---|---|---|---|---|
| Runs as | A non-root user with no Linux capabilities, in its own OpenShell container | Same | Same | Same | The owner's user |
| Files | Its clone and home folder (read-write). Nothing from the host. | Its clone (read) and home folder | Its clone and home folder (read-write) | The candidate clone | `.harness/`, the GitHub App key, the OpenShell client certificate |
| Shell | Yes | No: read-only file tools plus `git log`, `git diff` and `git show` | Yes | The check commands only; no agent runs here | n/a |
| Network, through the proxy | All bundles plus extras, and `web_read` | Core plus project bundles, and `web_read` | Project bundles, and `web_read` | Project bundles | GitHub API, the OpenShell gateway, and `web_read` fetches |
| Claude | Subscription, injected | Subscription, injected | Subscription, injected | None | None |
| Git | Commits on `arch/<module>` in its clone | Read | Commits on its attempt branch | Read | All refs in the bare repository. Pushes `plan/*` and `arch/*` as the App. |
| GitHub | None. Asks the daemon for `Arch:` PRs. | None. Asks for `Plan:` and `Fix:` PRs, and reads CI through the daemon. | None | None | GitHub App (§11.4) |
| AWS | View-only, signed by the proxy | View-only | View-only | View-only, if a check needs it | None |
| Terraform | `init`, `validate`, `plan -lock=false` | Reads plans | `init`, `validate`, `plan -lock=false` | `plan`, then assertions | None |
| Messages | To the Manager; to the owner through its terminal | To the Developer, the Architect, the owner and the daemon | To the Manager only | n/a | All |

### 6.2 One definition, applied on every layer

A role is a TypeScript object in `src/roles.ts`. The daemon derives everything else
from it:
- the OpenShell policy (filesystem, process, and network endpoints by bundle);
- the providers to attach;
- the agent tools exposed through the MCP shim, and the access rules for messages;
- the Claude Code flags (§6.4).

`harness/config.json` can change models, effort, timeouts and extra network hosts. It
cannot weaken a role. Settings such as "the Developer may push" or "write access to
AWS" don't exist.

`harness doctor --probe` checks that the layers agree. From every role's sandbox it
expects each of these to fail:
- `aws ec2 create-tags`;
- reading an S3 object other than the project's state file;
- `aws secretsmanager get-secret-value`;
- a `POST` to a read-only host, or a request to a host that isn't listed;
- `git push` to GitHub;
- a request to `169.254.169.254`;
- reading the owner's home folder.

It also expects every credential variable in the sandbox to hold a placeholder, not a
real value. Outside the sandboxes, it checks that:
- `web_read` refuses `http://192.168.1.1`;
- the App cannot push a file under `.github/workflows/`;
- `main` refuses a merge without the owner's approval.

The probe runs at setup and after upgrades. It is a conformance test, not a recurring
health check.

### 6.3 The Architect's broader permissions

"Broader" means four things:
- it reads the whole repository and every module's design;
- it has the widest network allowlist;
- it has write authority over design artifacts, which reach `main` only through `Arch:`
  PRs that the owner merges;
- its session is long-lived and conversational.

It keeps the same hard limits as every other role:
- no host access;
- no credentials;
- view-only AWS;
- no GitHub writes except through `submit_design`;
- no way to merge.

The remaining risk is that the Architect shapes everything downstream, checks included.
The owner reviews `Arch:` PRs, and the hash list makes every protected change visible
in them.

### 6.4 How each agent is launched

| | Architect | Manager | Developer |
|---|---|---|---|
| Mode | Interactive terminal UI | `-p --input-format stream-json --output-format stream-json --verbose` | `-p --output-format stream-json --verbose`, with the task on stdin |
| System prompt | `--append-system-prompt-file /opt/harness/roles/architect.md` | `…/manager.md` | `…/developer.md` |
| Tools | `--tools` with an explicit list: shell, files, web, subagents, skills, `AskUserQuestion` | `--restricted --tools Read,Grep,Glob,Bash`, plus harness tools | Shell, files, web, subagents, skills, harness tools |
| MCP | `--mcp-config` naming only the harness shim, plus `--strict-mcp-config` | Same | Same |
| Permissions | `bypassPermissions`, because the sandbox is the boundary | `--permission-mode dontAsk`, with `--settings` allowing only `Bash(git log:*)`, `Bash(git diff:*)` and `Bash(git show:*)` (verified, spike 3) | `bypassPermissions` |
| Session | `--session-id` the first time, then `--resume` | Same | A new `--session-id` for each attempt |

The explicit tool list leaves out anything that acts outside the sandbox:
- remote triggers;
- scheduled cloud tasks;
- messaging other local sessions.

The project's own `CLAUDE.md` or `AGENTS.md` loads as usual. Skills such as `grill-me`
ship in the image.

**The Manager runs with `--restricted` because it reads code it didn't write.** Spike 3
showed that, without it, a `SessionStart` hook planted in the repository's
`.claude/settings.json` runs in the Manager's sandbox, even with a limited tool list
and `dontAsk`. `--restricted` ignores the repository's settings files and keeps the file
tools inside the clone. For every role, `.claude/**`, `CLAUDE.md` and `AGENTS.md` are
protected files (§8.7).

### 6.5 Other developer agents

A new agent needs an `AgentAdapter` (§5.2) and must satisfy five requirements:
- a headless mode;
- a way to add instructions without replacing its built-in prompt (Codex reads
  `AGENTS.md`, Cursor reads rules files);
- MCP support, because its reports and questions go through harness tools, not stdout
  parsing;
- an OpenShell provider for its credentials (OpenShell ships profiles for Codex and
  Cursor);
- a stream the dashboard can render.

v1 implements Claude Code only.

---

## 7. Lifecycles

### 7.1 Module

```
designing ⇄ proposed(vN) ──owner accepts vN──► decomposing ──submit_design──► in_review (Arch PR)
   ▲                                                                            │ owner merges
   │                                                                            ▼
   │                                   design change (Arch PR) ◄───────── frozen ──► building ──► complete
   └────────────────────────────────── new module: harness module new <id>            (plans in order)
```

1. **Start the module.** `harness module new orders "Order intake"`, or the dashboard,
   creates `architect-orders` and its Claude session. The owner attaches and describes
   what is needed.
2. **Grill and propose.** The Architect grills the owner with the `grill-me` skill. It
   writes `harness/modules/orders/proposals/v1.md` and calls `submit_proposal`, and the
   dashboard shows v1. Further rounds produce v2, v3 and so on, until the owner clicks
   **Accept vN**.
3. **Decompose.** The Architect then writes:
   - the plans and features;
   - the checks and fixtures;
   - `owner-actions.json` and `owner-guide.md`;
   - any `init.sh` and tool-config changes;
   - updates to the root `ARCHITECTURE.md` and `README.md`.

   It then calls `submit_design`.
4. **Validate and open the PR.** The daemon validates the schemas and checks that every
   reference resolves. It runs the new pre-merge checks once against `main`, where they
   should all fail; any that pass are listed in the PR as suspect. It computes the hash
   list, commits it as the bot, and opens the `Arch:` PR.
5. **Freeze and build.** The owner merges and the module is `frozen`. Building starts with
   the first plan, unless a gate blocks it.
6. **Change the design during the build.** A design change goes through the same
   `submit_design` path as a new `Arch:` PR. Features whose definitions changed get
   fresh attempts.

### 7.2 Plan

```
waiting ─► active ─► validating ─► pr_open ─► ready_to_merge ─► merged ─► deploying ─► verifying ─► done
   (deps/gates)  (features)  (full checks +  (CI)     (CI green,          (CI apply,   (post-deploy
                             Manager)  │              owner task)          if iac/)     checks)
                                       └─ ci_failed ─► fixing (≤ 2 rounds) ─┘     failure ─► Fix: PR (≤ 2 rounds)
```

Plans run strictly in order within a module. A plan starts only after the previous plan
of the same module is `done`. The plan branch is cut from `main` at that moment.

### 7.3 One feature attempt

| # | Step | Done by | On failure |
|---|---|---|---|
| 1 | **Preconditions.** Dependencies are accepted, gates are satisfied, attempts remain, nothing else is running, and the pipeline isn't paused for any reason (owner pause, circuit breaker or usage limit). | Code | Wait |
| 2 | Record `ATTEMPT_STARTING` with the attempt number and the deadline. | Code | n/a |
| 3 | Create the sandbox. Upload the plan-branch bundle and clone it. Run `init.sh` (15-minute cap). | Code | Infrastructure retry; the attempt is not counted |
| 4 | **Baseline checks.** The project checks and the accepted features' checks must pass, or the environment is escalated to the Manager. The feature's own pre-merge checks must fail; if one already passes, the Manager decides between "already satisfied" and "weak check, send to the Architect". | Code | Not counted |
| 5 | Write the task and launch the Developer, detached. The task holds the feature, the relevant design references, the baseline results, the last 20 lines of `progress.txt`, recent `git log` and, for attempt 2, the Manager's guidance. | Code | n/a |
| 6 | The Developer works and commits. It can call `ask_manager` and `web_read`, and ends with `report_done` or `report_blocked`. | Developer | Timeout: `timed_out` |
| 7 | Copy the commits out as a bundle into `refs/attempts/...`. Run static checks: protected paths and fields untouched, lockfile resolves from the registry, suppressions listed. | Code | Attempt failed, with the reason |
| 8 | **Check run** in a fresh check sandbox: the project checks, every accepted feature's pre-merge checks, and this feature's. | Code | `CHECKS_FAILED` |
| 9 | **Review.** The Manager receives the report, the check results, a diff summary and the suppressions, and calls `accept_feature` or `reject_feature`. | Manager | n/a |
| 10 | **Accept** (permitted only after `CHECKS_PASSED`): land the feature on the plan branch as one commit that includes its `progress.txt` line (§11.3), push the plan branch, delete the sandboxes. **Reject:** `ATTEMPT_FAILED`, then the next attempt with the Manager's guidance, or `ESCALATED`. | Code | n/a |

Uncommitted changes at the end of an attempt are discarded; the task says to commit.

### 7.4 Brakes

| Brake | Default | What happens when it trips |
|---|---|---|
| Attempts per feature | 2 per version of the feature's definition | The feature is `escalated`. The owner chooses one more attempt with guidance, a referral to the Architect, or pausing the pipeline. |
| Attempt wall clock | 90 minutes, not counting usage-limit pauses | The daemon stops the agent. The attempt is `timed_out` and counts. |
| Interrupted attempts | Not counted, up to 2 per feature | After that, interruptions count as attempts. |
| Manager turn | 20 minutes | Interrupted and re-sent once. After that the pipeline pauses and the owner is notified. |
| `ask_manager` wait | Within the attempt clock, up to 15 minutes | No answer: the Developer ends with `report_blocked`. |
| CI fix rounds per PR | 2 | Escalated to the owner. |
| Post-deploy fix rounds per plan | 2 | Escalated to the owner. |
| Consecutive failed attempts, any feature | 3 | The pipeline pauses (circuit breaker) and the owner is notified. |
| Usage limit reached | Until the reset time | The pipeline pauses. The running attempt resumes in the same session afterwards. |
| Concurrency | One Developer at a time | Enforced by the scheduler. |

Two rules make loop detection unnecessary:
- Every attempt counts. Clarifications happen inside an attempt through `ask_manager`.
- A second attempt cannot start without non-empty guidance from the Manager.

With only two attempts, the same attempt can't repeat. No failure signatures or
heuristics are needed.

### 7.5 Agent sessions

**Architect.**
- **Spike 4 decided how it starts.** The sandbox is created without a command, so
  OpenShell starts a login shell in a terminal it keeps open. The image's `.bash_profile`
  sees `HARNESS_ROLE=architect` and `exec`s the launcher there. A command given at
  creation would get no terminal: Claude would fall back to print mode and exit.
- The launcher pre-answers Claude Code's first-run screens, then runs Claude in a loop:
  `--session-id <id>` the first time, `--resume <id>` afterwards. If Claude exits or
  crashes, the loop starts it again with the same conversation, so the sandbox's main
  process never ends.
- The owner attaches through the dashboard terminal or `harness attach architect`.
  Detaching leaves the session running, and reattaching replays recent output.
- The daemon copies the session transcript to `.harness/modules/<module>/architect/` after
  each turn, so a lost sandbox can be recreated with the session intact.
- After each merge, the daemon uploads a fresh `main` bundle, and the Architect fetches
  from it before working.

**Manager.**
- It is one long-lived headless session per module, started when the module's build
  begins.
- It runs detached inside `manager-<module>`, fed from a file. This was settled by
  spike 1 (§18.1): input piped into an `exec` doesn't stream.

  ```
  tail -n 0 -s 0.2 -F manager-in.jsonl | claude -p --input-format stream-json … > manager-out.jsonl
  ```

- The daemon appends events, messages and the owner's chat to `manager-in.jsonl` with
  short `exec` calls. It follows `manager-out.jsonl` and shows it in the dashboard's
  Manager panel.
- The owner chats with it from the same panel.
- The Manager keeps running while the daemon restarts. If Claude itself exits, the
  daemon restarts the pipeline with `--resume` and sends again any message that has no
  recorded answer.
- Its transcript is backed up like the Architect's.
- Its durable memory is the harness state, which it queries through tools. Its context
  is a cache, so compaction is safe.

**Developer.**
- Each attempt gets a new session.
- The agent is launched with `setsid nohup claude -p …` inside its sandbox, so it keeps
  running if the daemon restarts.
- The daemon follows its stream file and its process id through `exec`.

---

## 8. Project artifacts

### 8.1 Layout of a project built with the harness

```
README.md                    shared knowledge across modules; developers may update usage notes
ARCHITECTURE.md              cross-module architecture and decisions (protected)
progress.txt                 append-only ledger, written only by the daemon
init.sh                      brings up the environment: dependencies, build, local services (protected)
harness/
  config.json                project settings (protected, §8.6)
  lock.json                  hash list (§8.7); changes only in Arch: PRs
  Dockerfile                 optional additions to the agent image (protected)
  modules/<module>/
    module.json                id, title, accepted proposal version, plan order
    proposals/v1.md v2.md …  every proposal version, kept
    plans/P1.json …          a plan and its features (§8.2)
    checks/                  check scripts and fixtures with synthetic data (§8.3)
    owner-actions.json       owner gates and tasks (§8.4)
    owner-guide.md           the owner's guide for this module, referring to action ids
.github/
  workflows/harness.yml      installed by the owner with `harness init`; never edited by agents
  harness/verify.mjs         CI verifier, a single file vendored by `harness init` and `upgrade`
  CODEOWNERS                 the owner on every protected path
iac/                         Terraform shared by all modules (§12.8)
src/ …                       the application
```

`.harness/` is runtime only (§10). `harness init` adds it to `.gitignore`.

### 8.2 Plans and features

A plan file holds the plan and its features. It is protected as a whole file.

```json
{
  "id": "P2",
  "module": "orders",
  "title": "Order intake API",
  "goal": "Customers can submit orders; orders are queued for fulfilment.",
  "features": [
    {
      "id": "F07",
      "title": "Create order endpoint",
      "kind": "app",
      "description": "POST /orders validates the payload, stores the order and returns 201 with a Location header.",
      "expected": "A valid order is stored and can be read back; an invalid one gets 400 with field errors.",
      "dependsOn": ["F05"],
      "gates": [],
      "resources": ["src/orders/**", "ARCHITECTURE.md#orders"],
      "checks": [
        { "id": "F07-api", "run": "node --test harness/modules/orders/checks/F07-api.test.mjs", "phase": "pre-merge", "timeoutSec": 300 }
      ]
    },
    {
      "id": "F08",
      "title": "Order queue",
      "kind": "infra",
      "description": "An SQS queue with a dead-letter queue receives new orders.",
      "expected": "orders and orders-dlq exist in us-east-1; maxReceiveCount is 5; encryption is on.",
      "dependsOn": [],
      "gates": ["G1"],
      "resources": ["iac/orders.tf"],
      "checks": [
        { "id": "F08-plan", "run": "node harness/modules/orders/checks/F08-plan.mjs", "phase": "pre-merge", "needs": ["tfplan"] },
        { "id": "F08-live", "run": "bash harness/modules/orders/checks/F08-live.sh", "phase": "post-deploy", "needs": ["aws"] }
      ]
    }
  ]
}
```

- `resources` are hints for the Developer, not restrictions. The Manager reviews what
  was actually touched.
- Status, attempts and Findings are not in this file. The definition is frozen and
  hashed whole, while status changes all the time. Status lives in the harness state
  (§10), and its durable record goes to `progress.txt`.
- The version of a feature's definition is the hash of its JSON. When it changes, the
  feature's attempts reset.

### 8.3 Checks

```ts
type Check = {
  id: string;
  run: string;                        // shell command, run from the repository root
  phase: 'pre-merge' | 'post-deploy';
  timeoutSec?: number;                // default 600
  needs?: ('aws' | 'tfplan')[];       // aws: attach the view-only role; tfplan: plan first, path in $HARNESS_PLAN_JSON
};
```

- **Application features.** Test scripts with synthetic data in `checks/fixtures/`.
- **Infrastructure features.**
  - Before merge, assertions on `terraform show -json` of the plan: "an
    `aws_sqs_queue.orders` will exist with `max_receive_count = 5`".
  - After apply, read-only AWS checks: "`aws sqs get-queue-attributes` shows the
    redrive policy".
- **Project checks** apply to every feature, for example `npm run lint`,
  `npm run typecheck` and `npm test`. They are listed in `harness/config.json`
  (§8.6).

### 8.4 Owner actions and gates

`owner-actions.json` is the source the dashboard tracks. `owner-guide.md` explains it in
prose and refers to the same ids.

```json
[
  {
    "id": "G1",
    "kind": "gate",
    "title": "Approve the KMS key policy for order data",
    "when": "before P2",
    "blocks": ["P2/F08"],
    "instructions": "Read harness/modules/orders/proposals/v3.md §5, then confirm in the dashboard.",
    "verify": null
  },
  {
    "id": "T1",
    "kind": "task",
    "title": "Create the SES sending identity for orders@example.com",
    "when": "anytime",
    "blocks": [],
    "instructions": "In the AWS console … (Markdown)",
    "verify": { "run": "bash harness/modules/orders/checks/T1-ses.sh", "needs": ["aws"] }
  }
]
```

- A **gate** blocks the work it lists. A **task** doesn't block anything.
- Statuses are pending, in progress, done and blocked. They live in the harness state.
- The owner marks an action done in the dashboard. If it has a `verify` command, the
  daemon runs it in a check sandbox before accepting.
- A satisfied gate also gets a line in `progress.txt`, so it survives losing
  `.harness/`.
- Some gates are implicit and need no entry:
  - accepting an architecture version;
  - merging an `Arch:` PR;
  - merging a `Plan:` PR;
  - deciding an escalation.

### 8.5 `progress.txt`

The daemon appends one line per durable milestone. It is never edited, and CI checks
that it only grows. Each line holds a time, an event, a reference, some key=value pairs,
and a quoted summary:

```
2026-10-12T14:03:22Z feature.accepted  orders/P2/F07 attempt=1 "POST /orders returns 201 with Location"
2026-10-12T14:03:22Z next              orders/P2/F08
2026-10-12T16:40:10Z plan.pr_opened    orders/P2 pr=14
2026-10-13T09:12:44Z gate.satisfied    orders/G1 by=owner "KMS key policy approved"
2026-10-13T10:02:31Z plan.verified     orders/P2 "post-deploy checks green"
```

It is readable by humans and parseable by code. Each line is committed with the next
commit the daemon writes:
- a `feature.accepted` line lands in that feature's own commit;
- lines for later events, such as a PR opened or a gate satisfied, land in the next
  feature commit.

The dashboard reads the event log, so it is never behind. CI uses the
`feature.accepted` lines to decide which features' checks it must run. The dashboard shows the last ten lines. The
Developer's own notes stay in the attempt report under `.harness/`, and the quoted
summary comes from that report.

### 8.6 `harness/config.json`

```json
{
  "$schema": "https://…/harness-config.schema.json",
  "harnessVersion": "0.1.0",
  "project": { "repo": "<org>/example", "baseBranch": "main" },
  "roles": {
    "architect": { "agent": "claude-code", "model": "claude-opus-5-5", "effort": "max" },
    "manager":   { "agent": "claude-code", "model": "claude-opus-5-5", "effort": "high" },
    "developer": { "agent": "claude-code", "model": "claude-opus-5-5", "effort": "xhigh",
                   "attemptTimeoutMinutes": 90, "maxAttempts": 2 }
  },
  "network": { "bundles": ["core", "node", "python", "aws", "terraform"], "extraHosts": [] },
  "aws": {
    "accountId": "123456789012", "region": "us-east-1",
    "viewRoleArn": "arn:aws:iam::123456789012:role/harness-example-staging-view",
    "services": ["s3", "iam", "sts", "sqs", "lambda", "logs", "kms", "dynamodb", "apigateway"]
  },
  "terraform": { "dir": "iac", "backendConfig": "backend-configs/staging.hcl", "varFile": "env/staging.tfvars" },
  "checks": [
    { "id": "lint",      "run": "npm run lint",      "phase": "pre-merge" },
    { "id": "typecheck", "run": "npm run typecheck", "phase": "pre-merge" },
    { "id": "unit",      "run": "npm test",          "phase": "pre-merge" }
  ],
  "protect": {
    "files": ["eslint.config.js", "vitest.config.ts", ".npmrc"],
    "jsonFields": { "tsconfig.json": ["/compilerOptions/strict"], "package.json": ["/overrides", "/devDependencies/eslint"] }
  },
  "brakes": { "consecutiveFailures": 3, "ciFixRounds": 2, "managerTurnMinutes": 20 },
  "dashboard": { "port": 4777 }
}
```

Roles set the model, effort and timeouts. Permissions come from the role definitions in
code (§6.2). The file has a JSON Schema, so editors can autocomplete it.

### 8.7 Protected files and `harness/lock.json`

**What is protected.**
- The whole `harness/` folder except `lock.json`, plus `ARCHITECTURE.md`, `init.sh` and
  `.github/**`.
- What agents load as instructions or settings: `.claude/**`, `CLAUDE.md` and
  `AGENTS.md`. A Developer could otherwise plant a hook that runs in another agent's
  sandbox (spike 3).
- Tool configs: the stack's defaults plus whatever `protect` lists. JSON configs are
  protected by field, configs written as code by whole file. `.npmrc` is protected
  because its `script-shell` setting can make every `npm run` succeed.
- **package.json fields:**
  - For every check written as `npm run X`, the daemon adds `/scripts/X`,
    `/scripts/preX` and `/scripts/postX` automatically.
  - The Architect adds the versions of the tools those scripts call, and `/overrides`.
  - A missing field is hashed too, so adding a `prelint` later is caught.

```json
{
  "version": 1,
  "entries": [
    { "path": "harness/modules/orders/plans/P2.json", "sha256": "9b1f…" },
    { "path": "eslint.config.js", "sha256": "4c0d…" },
    { "path": "package.json", "fields": {
        "/scripts/lint": "e3b0…", "/scripts/prelint": "absent", "/scripts/postlint": "absent",
        "/devDependencies/eslint": "77aa…", "/overrides": "absent" } }
  ]
}
```

**Who writes it.** Only the daemon's freeze step writes it, during `submit_design`, by
hashing the Architect's branch. No agent writes it. Field hashes are taken over
canonical JSON, with sorted keys and no whitespace.

**Where it is enforced:**
1. **Daemon, attempt step 7.** If an attempt touches a protected path or field, the
   attempt fails and the reason goes into the next task. A `PreToolUse` hook in the
   Developer's sandbox blocks edits to protected paths earlier. That hook gives fast
   feedback but is not a security boundary.
2. **Daemon, before pushing any branch.**
3. **CI `verify` job, run from the base branch (§11.5).**
   - A `Plan:` or `Fix:` PR must leave every protected hash, and the hash list itself,
     unchanged.
   - An `Arch:` PR may change the list, but the list must match the files and the PR
     must come from the App.
   - CODEOWNERS and repository rules then require the owner's approval.

**What can't be hashed.**
- The lockfile is checked instead: every locked package must resolve from
  `registry.npmjs.org`.
- New suppressions are listed for the Manager, who accepts or rejects each one:
  `eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `.skip` and `.only`. Some are
  legitimate, so they don't fail automatically.

---

## 9. Communication

### 9.1 Messages and events

There is one envelope for both:

```json
{
  "v": 1,
  "id": "msg_01J9ZK3",
  "ts": "2026-10-12T14:02:11Z",
  "kind": "message",
  "type": "BLOCKED",
  "from": "developer",
  "to": "manager",
  "ref": { "module": "orders", "plan": "P2", "feature": "F07", "attempt": 2 },
  "replyTo": null,
  "payload": { "...": "validated against the schema of BLOCKED" }
}
```

1. **Messages** are what someone says: requests, reports and answers. **Events** are
   facts recorded only by the daemon. A Developer's `DONE` is a claim; `CHECKS_PASSED`
   is a fact.
2. **The daemon stamps** `id`, `ts`, `from`, `ref` and any counters. The agent provides
   only `payload`. `from` is the role of the sandbox the message came from. `ref` is
   checked against what that sandbox is actually assigned. Attempt numbers come from the
   state, never from the agent.
3. **Each type has a schema and an access rule** saying who may send it and to whom. The
   schemas are defined once with zod, which produces both the runtime validators and the
   JSON Schemas of the MCP tools. An invalid message is rejected with the reason, so the
   agent can fix it.
4. **Everything is appended to `.harness/events.jsonl`.** Inboxes, `state.json` and the
   dashboard feed are computed from it. Agents never read the log; they see only their
   own inbox.

### 9.2 Transport: the daemon reaches into the sandboxes

Every sandbox runs the harness MCP shim. It is a small Node file in the image, with no
dependencies, and Claude Code talks to it over stdio.

- **Agent to daemon:** a tool call appends a request line to
  `/sandbox/.harness/outbox.jsonl`. The daemon follows that file through a long-lived
  `openshell sandbox exec`.
- **Daemon to agent:** the daemon appends replies and incoming messages to
  `/sandbox/.harness/inbox.jsonl` through `exec`. The shim matches each reply to its
  request id.

Consequences:
- No sandbox opens a connection to the daemon, and the host opens no port for agents.
  This avoids firewall changes and reduces exposure.
- **Identity needs no secret.** A message's sender is the sandbox the daemon read it
  from. Writing fake lines into one's own outbox only speaks as oneself.
- The daemon validates every line strictly and caps its size.

*Changed since the chat:* this replaces per-sandbox tokens injected by OpenShell.

### 9.3 Message types, tools and access rules

| Type | From → to | Tool | Effect |
|---|---|---|---|
| `QUESTION` | Developer → Manager | `ask_manager` | The attempt waits for the answer (§7.4). |
| `CONTINUE` | Manager → Developer | `answer_developer` | Becomes the return value of `ask_manager`. |
| `DONE` | Developer → Manager | `report_done` | Ends the session. The daemon runs the checks, then the Manager reviews. |
| `BLOCKED` | Developer → Manager | `report_blocked` | Ends the attempt and carries a Finding (§9.7). |
| `ABORT` | Manager → Developer | `abort_attempt` | The daemon stops the attempt, which counts. |
| `ACCEPT` | Manager → daemon | `accept_feature` | Permitted only after `CHECKS_PASSED` for this attempt. |
| `REJECT` | Manager → daemon | `reject_feature` | The attempt fails. Guidance is required. |
| `ESCALATION` | Manager → Architect | `escalate_to_architect` | Queued for the Architect, and shown as an owner task. |
| `DECISION` | Architect → Manager | `reply_to_manager` | Delivered to the Manager. |
| `OWNER_REQUEST` | Manager → owner | `ask_owner` | Becomes a dashboard task. It can block the plan. |
| `OWNER_MESSAGE` | owner → Manager or Architect | dashboard | Goes to the Manager's stdin, or the Architect's inbox. |
| `PR_REQUEST` | Manager → daemon | `open_plan_pr` | Permitted only when the plan is `validating` and its full check run passed. |
| `FIX_REQUEST` | Manager → daemon | `request_fix` | Starts a fix attempt, within the round limits. |
| `PROPOSAL` | Architect → daemon | `submit_proposal` | Proposal vN appears in the dashboard. |
| `DESIGN` | Architect → daemon | `submit_design` | Validated, hashed and opened as an `Arch:` PR. Permitted after the owner accepts a version, or as a design change. |

Read tools:
- **Manager:** `get_state`, `get_attempt`, `get_diff`, `get_ci_results`,
  `get_progress`, `web_read`.
- **Architect:** `get_state`, `get_inbox`, `get_findings`, `web_read`.
- **Developer:** `web_read`. Its task already contains everything else.

The Developer can never address the owner or the Architect.

### 9.4 Events

| Group | Events |
|---|---|
| Design | `MODULE_CREATED`, `ARCHITECTURE_PROPOSED`, `ARCHITECTURE_ACCEPTED`, `DESIGN_SUBMITTED`, `DESIGN_FROZEN`, `DESIGN_CHANGED` |
| Work | `PLAN_STARTED`, `ATTEMPT_STARTING`, `ATTEMPT_STARTED`, `BASELINE_FAILED`, `ATTEMPT_ENDED` (done, blocked, timed out, interrupted), `CHECKS_PASSED`, `CHECKS_FAILED`, `FEATURE_ACCEPTED`, `ATTEMPT_FAILED`, `RETRY_SCHEDULED`, `ESCALATED` |
| Owner | `GATE_OPENED`, `GATE_SATISFIED`, `OWNER_DECISION` |
| GitHub and AWS | `PR_OPENED`, `CI_PASSED`, `CI_FAILED`, `PR_MERGED`, `APPLY_SUCCEEDED`, `APPLY_FAILED`, `POST_DEPLOY_CHECKS_PASSED`, `POST_DEPLOY_CHECKS_FAILED`, `PLAN_VERIFIED`, `MODULE_COMPLETED` |
| Runtime | `AGENT_STARTED`, `AGENT_STOPPED`, `USAGE_LIMIT_REACHED`, `USAGE_LIMIT_CLEARED`, `PIPELINE_PAUSED`, `PIPELINE_RESUMED`, `WEB_READ` |

### 9.5 What each role receives

- **Manager:** only actionable items, written to its stdin as one JSON line each:
  - a feature ready for review, with its check results;
  - `QUESTION` and `BLOCKED`;
  - `CI_FAILED`;
  - a plan ready for its PR;
  - a `DECISION`;
  - `OWNER_MESSAGE`;
  - `POST_DEPLOY_CHECKS_FAILED`.

  Informational events go to the dashboard only. When an actionable item gets no
  decision within its turn limit, the daemon sends it again as a reminder.
- **Developer:** answers to its own questions, and `ABORT`.
- **Architect:** see §9.6.
- **Owner:** everything, in the dashboard.

### 9.6 Messages to the Architect

They queue in its inbox. The dashboard shows them under "Needs you" as "Architect has 1
message". When the owner next types in the Architect's terminal, a `UserPromptSubmit`
hook adds the pending messages to the context. Design decisions need the owner anyway,
so nothing tries to wake the Architect while the owner is away.

### 9.7 Findings

A Finding is the payload of `BLOCKED`:

```json
{
  "category": "missing_decision",
  "summary": "No decision on how workers receive jobs",
  "tried": ["Polled the jobs table: ruled out by ARCHITECTURE.md §4"],
  "errors": [{ "command": "npm test", "exit": 1, "excerpt": "…first failing lines…" }],
  "suspectedCause": "The plan does not say which queue service carries jobs",
  "needs": "Choose SQS or EventBridge for job delivery",
  "recommendation": "SQS, to match the order queue in P2/F08"
}
```

- Categories: `missing_decision`, `spec_gap`, `environment`, `dependency`,
  `check_defect`, `external` and `implementation`.
- The daemon adds the feature, attempt, time and status: open, triaged or resolved.
- The Manager resolves a Finding in one of three ways:
  - guidance for the next attempt;
  - an escalation to the Architect, which may lead to a design change;
  - an `OWNER_REQUEST`.

---

## 10. State

### 10.1 Where state lives

| Kind | Where | Examples | If lost |
|---|---|---|---|
| Durable, shared | Git, pushed to GitHub | Designs, plans, checks, `lock.json`, `progress.txt`, code, plan branches | Never lost: it's in GitHub |
| Durable, local | `.harness/` | Event log, `state.json`, attempt reports and transcripts, Findings, session backups | `harness recover` rebuilds what matters from git and GitHub (§15) |
| Ephemeral | Daemon memory | Exec streams, process handles, dashboard connections, caches | Rebuilt on start |

### 10.2 The `.harness/` folder

```
.harness/                          never versioned; mode 0700; holds no secrets
  events.jsonl                     append-only log of messages and events
  state.json                       projection of the log, rewritten atomically
  daemon.json                      pid, ports, version, start time
  git/repo.git                     bare repository: main, plan/*, arch/*, refs/attempts/*
  modules/<module>/
    architect/                     session id, transcript backup
    manager/                       session id, transcript backup
    proposals/vN.md                copies shown in the dashboard before they reach GitHub
    attempts/<plan>-<feature>-a<n>/ task.md, stream.jsonl, report.json, checks.log, result.bundle
    checks/<run>/                  outputs of plan-level and post-deploy check runs
  logs/daemon.log
  tmp/
```

### 10.3 `events.jsonl` and `state.json`

- Each line of the log is an envelope (§9.1), written with `fsync`.
- After each event the daemon rewrites `state.json`: it writes a temporary file, then
  renames it.
- On start, the daemon loads `state.json` and replays the events that are newer.
- Nobody edits `state.json` by hand.

```ts
interface State {
  v: 1;
  lastEventId: string;
  pipeline: { paused?: { reason: string; since: string; until?: string }; consecutiveFailures: number };
  modules: Record<ModuleId, {
    status: 'designing' | 'proposed' | 'decomposing' | 'in_review' | 'frozen' | 'building' | 'complete';
    proposals: { version: number; submittedAt: string; acceptedAt?: string }[];
    architect: AgentState;
    manager?: AgentState;
    plans: Record<PlanId, {
      status: 'waiting' | 'active' | 'validating' | 'pr_open' | 'ready_to_merge' | 'merged'
            | 'deploying' | 'verifying' | 'fixing' | 'done';
      branch?: string; pr?: number; ciFixRounds: number; deployFixRounds: number;
      features: Record<FeatureId, {
        status: 'waiting' | 'ready' | 'in_progress' | 'checking' | 'reviewing' | 'accepted' | 'escalated';
        definitionHash: string;
        attempts: Attempt[];
      }>;
    }>;
    actions: Record<ActionId, { status: 'pending' | 'in_progress' | 'done' | 'blocked'; doneAt?: string }>;
  }>;
  findings: Record<FindingId, Finding & { status: 'open' | 'triaged' | 'resolved' }>;
  inbox: { architect: MessageId[]; owner: MessageId[] };
  usage: { limitedUntil?: string; tokensBySession: Record<string, { input: number; output: number }> };
}

interface Attempt {
  n: number;
  status: 'starting' | 'running' | 'checking' | 'reviewing' | 'accepted' | 'failed'
        | 'timed_out' | 'interrupted' | 'blocked';
  sandbox: string; sessionId: string;
  startedAt: string; deadline: string; endedAt?: string;
  counts: boolean; findingId?: string; checkRun?: string; reason?: string;
}

interface AgentState {
  sandbox: string;
  sessionId: string;
  status: 'running' | 'idle' | 'stopped' | 'error';
}
```

### 10.4 Retention

- The event log and `state.json` are kept for the life of the project; they are small.
- Attempt transcripts, check logs and bundles are kept until the module is complete, plus
  30 days.
- `harness gc` removes them, and the retention period is configurable.
- Session backups stay until the module is archived.

---

## 11. Git, GitHub and CI

### 11.1 Branches and refs

| Ref | Lives | Written by |
|---|---|---|
| `main` | GitHub | Owner merges only |
| `arch/<module>` | GitHub | The daemon pushes the Architect's commits and the hash-list commit |
| `plan/<module>/<plan>` | GitHub (an off-machine backup; pushing to it starts no CI) | The daemon: one commit per accepted feature, plus fix commits (§11.3) |
| `fix/<module>/<plan>-<n>` | GitHub | The daemon, for post-merge fixes |
| `refs/attempts/<module>/<plan>/<feature>/a<n>` | `.harness/git/repo.git` only | The daemon, from attempt bundles |

### 11.2 Code in and out of sandboxes

1. **In.** The daemon runs `git bundle create` for the right branch, `openshell sandbox
   upload` sends it, and the sandbox runs `git clone`.
2. **Out.** The sandbox runs `git bundle create` for its commits since the base, and
   `openshell sandbox download` brings the bundle back. The daemon runs
   `git bundle verify`, then `git fetch` into its bare repository.
3. **Safety.** The bare repository has no working tree and runs only the daemon's own
   hooks, so nothing written by an agent executes on the host.
4. **Commit authors.** Sandboxes commit as `Developer (harness)`, `Architect (harness)`
   and so on.
   - A feature commit keeps the Developer as its author, with the App bot as committer.
   - The daemon's own commits, such as the hash list or a merge of `main`, are made as
     the App bot.

### 11.3 Pull requests, commits and merging

| Title prefix | Kind | Requested by | Branch | May change | Merged by |
|---|---|---|---|---|---|
| `Arch: <module> — <summary>` | Design freeze or design change | Architect (`submit_design`) | `arch/<module>` | Protected files and `lock.json`, `ARCHITECTURE.md`, `README.md`, `init.sh`, tool configs | Owner |
| `Plan: <module>/<plan> — <title>` | One completed plan | Manager (`open_plan_pr`) | `plan/<module>/<plan>` | Anything except protected files and `lock.json` | Owner |
| `Fix: <module>/<plan> — <summary>` | A fix after merge (post-deploy, or CI on `main`) | Manager (`request_fix`) | `fix/<module>/<plan>-<n>` | Same as `Plan:` | Owner |
| `Owner: <summary>` | A change the owner applies, such as workflow YAML from an owner gate | Owner, with their own credentials | any | Anything | Owner |
| `Harness: <summary>` | A harness upgrade: vendored CI files, config migrations | Owner (`harness upgrade`) | `harness/upgrade-<version>` | `.github/**`, `harness/config.json` | Owner |

The `verify` job works out the PR's kind from its author, branch and changed paths. If
the title prefix doesn't match that kind, the job fails. The title alone never grants
anything.

**Exactly one pull request per plan.**
- Features never get PRs of their own.
- CI fix rounds add commits to the plan's open PR.
- The only other PR that can concern a plan is a `Fix:` PR, when post-deploy checks fail
  after the merge. A merged PR can't be reopened.

**One commit per feature.** When the Manager accepts a feature, the daemon lands the
attempt on the plan branch as exactly one commit:
- it contains the attempt's changes and the feature's `progress.txt` line;
- its author is the Developer and its committer is the App bot;
- its message is built from the feature definition and the Developer's report:

```
feat(orders/P2/F07): Create order endpoint

POST /orders validates the payload, stores the order and returns 201
with a Location header.

Validation errors use problem details; storage follows the repository
pattern in ARCHITECTURE.md §3.

Feature: orders/P2/F07
Attempt: 1
Checks: lint, typecheck, unit, F07-api
```

The Developer's own intermediate commits stay on `refs/attempts/...` and in the
attempt's bundle under `.harness/`, for reference.

Two other kinds of commit can appear on a plan branch:
- a CI fix round adds a `fix(orders/P2): <summary>` commit;
- if `main` changes during a plan, because of a design change, the daemon merges `main`
  into the plan branch. It never rewrites a plan branch that has been pushed.

**Merging.** The repository allows merge commits only: squash and rebase merging are
turned off, both in the ruleset and in the repository settings. The merge commit takes
the PR's title and description. `main` therefore keeps every feature commit, plus one
merge commit per plan:

```
*   Plan: orders/P2 — Order intake API (#14)
|\
| * feat(orders/P2/F08): Order queue
| * feat(orders/P2/F07): Create order endpoint
|/
*   Plan: orders/P1 — Order model (#12)
```

`git log --first-parent main` shows one line per plan. A plain `git log` shows every
feature, which is what a Developer reads at the start of a session.

### 11.4 GitHub App and repository rules

**The App** is new and dedicated to the harness; v1's App is not
reused. The harness generates its manifest with exactly the permissions below. It is
installed on the project repository only. Its permissions:

| Permission | Level |
|---|---|
| Contents | Read and write (branches) |
| Pull requests | Read and write |
| Checks, Actions, Commit statuses | Read |
| Metadata | Read |
| Workflows, Administration, Secrets, Environments, Variables, Issues | None |

- Its private key lives in `~/.config/harness/<repo>.pem` with mode 0600. Only the
  daemon reads it, minting a one-hour token per operation.
- Without the workflow permission, GitHub itself rejects any push that touches
  `.github/workflows/`.

**A repository ruleset on `main`:**
- requires a pull request;
- requires the `verify` and `checks` jobs, plus `tf-plan` when `iac/` exists;
- requires one approval and code-owner review;
- allows merge commits only;
- blocks force pushes and deletion;
- lists only the owner (repository admin) as bypass actor.

**Repository settings:**
- squash and rebase merging are off;
- the merge commit's title and message come from the PR's title and description.

The App authors its PRs, and GitHub doesn't let an author approve its own PR, so every
merge needs the owner. CODEOWNERS assigns the owner to every protected path.

### 11.5 The CI workflow

`harness init` installs one workflow, and only the owner changes it, through
`harness upgrade`. Every job declares its own permissions and a timeout.

| Job | Runs when | Does | Permissions |
|---|---|---|---|
| `verify` | Every PR | Checks out the **base** branch and runs `.github/harness/verify.mjs` from there against the PR head. It checks the PR kind and its title, protected hashes and the hash list, that `progress.txt` only grew, and the lockfile registry. | `contents: read` |
| `checks` | Every PR, and pushes to `main` | Runs `init.sh`, the project checks, and the pre-merge checks of every feature with a `feature.accepted` line. Plan assertions use the plan JSON from `tf-plan`. | `contents: read`; no secrets, no OIDC |
| `tf-plan` | PRs touching `iac/` | OIDC plan role, `terraform plan`, plan JSON uploaded as an artifact | `id-token: write` |
| `tf-apply` | Pushes to `main` touching `iac/` | Runs in the `staging` environment (`main` only, already configured by `terraform-bootstrap`) with the OIDC apply role | `id-token: write` |

The workflow triggers only on `pull_request` to `main` and on `push` to `main`, so
pushing plan branches costs no CI. The `tf-*` jobs follow the existing `iac/` template
used by the owner's other projects.

### 11.6 Adding CI checks, and changing workflows

**Checks are data.** To add Node.js linting, the Architect adds
`{ "id": "lint", "run": "npm run lint", "phase": "pre-merge" }` to
`harness/config.json` in an `Arch:` PR. From the next PR on, the fixed workflow runs it.

**Workflow changes are owner gates.** Some changes can't be expressed as a check entry:
new triggers, schedules, deploy pipelines. For those:
1. the Architect writes the YAML into an owner action;
2. the dashboard shows it;
3. `harness owner apply <action>` opens an `Owner:` PR with the owner's own credentials;
4. the owner reviews and merges it.

**Why the App has no workflow permission.** On a pull request, GitHub runs the workflow
from the PR's own branch. A PR that could edit workflows could rewrite the very check
that guards it, before anyone has reviewed it.

### 11.7 How the Manager sees CI

- While a PR is open, the daemon polls the Checks and Actions APIs every 30 seconds,
  backing off when nothing changes. A local machine can't receive webhooks, so polling
  replaces them.
- `get_ci_results(pr)` returns each job's conclusion and the end of the log of every
  failed step.
- On `CI_FAILED`, the Manager diagnoses the failure and calls `request_fix` with
  guidance. A Developer fix attempt then commits on the same plan branch, and the
  daemon pushes it, which re-runs CI.

---

## 12. AWS and Terraform

### 12.1 Two authorities

| | Local agents | CI |
|---|---|---|
| Identity | `harness-<repo>-staging-view`, assumed by the OpenShell gateway | `gha-<repo>-staging-plan` and `-apply`, through GitHub OIDC |
| Can change AWS | Never | Only `apply`, only from `main`, only after the owner merges |
| Credentials in reach of an agent | None: the proxy signs requests | n/a |

### 12.2 The agents' view-only role

| Piece | Purpose |
|---|---|
| `ViewOnlyAccess` (AWS managed) | See what exists: lists and basic metadata, never resource content |
| `SecurityAudit` (AWS managed) | The configuration details Terraform re-reads before planning: bucket settings, IAM role and policy details, KMS key details, Lambda configuration, and secret and parameter *metadata* |
| Custom read policy | Read this project's state object, decrypt it with the state key (only through S3), plus whatever leftover `Get*` or `Describe*` calls a real plan reveals |
| Explicit deny | Data and secret values. A deny always wins over an allow, and AWS updates to its managed policies can't undo it. |

The explicit deny covers:
- `s3:GetObject*` on everything except the project's state object;
- DynamoDB item reads: `GetItem`, `BatchGetItem`, `Query`, `Scan`, the PartiQL
  calls and `GetRecords`;
- `secretsmanager:GetSecretValue` and `BatchGetSecretValue`;
- the SSM parameter reads: `ssm:GetParameter`, `GetParameters`,
  `GetParametersByPath` and `GetParameterHistory`;
- `kms:Decrypt` on every key except the state key;
- the CloudWatch Logs content reads: `GetLogEvents`, `FilterLogEvents`, `StartQuery`,
  `GetQueryResults` and `StartLiveTail`;
- `sqs:ReceiveMessage`, `kinesis:GetRecords`, `athena:GetQueryResults` and
  `rds-data:*`;
- the Cognito user reads: `cognito-idp:ListUsers`, `ListUsersInGroup` and
  `AdminGetUser`;
- SNS subscription endpoints, which hold email addresses and phone numbers:
  `sns:ListSubscriptions`, `ListSubscriptionsByTopic` and `GetSubscriptionAttributes`.
  A project that manages SNS subscriptions in Terraform can't refresh them with this
  role, so such subscriptions stay owner-managed;
- `ec2:GetPasswordData` and `GetConsoleOutput`;
- container image content: `ecr:BatchGetImage` and `GetDownloadUrlForLayer`.

If Terraform must read a non-secret SSM parameter, reads are allowed only under
`/<project>/config/*`.

**Three things remain visible:**
- infrastructure metadata;
- object names in S3 buckets (Terraform needs list permission just to check that a
  bucket exists);
- Lambda environment variables.

So the project follows two rules: no user identifiers in object names, and no secrets
in Lambda environment variables.

### 12.3 Controls that stop local changes to AWS

| Control | What it stops |
|---|---|
| The IAM role allows only reads, plus explicit denies | Any write, or any data read, made with the role |
| No credentials in sandboxes: the proxy signs, the environment holds placeholders, there's no `~/.aws`, and `169.254.169.254` is blocked | Using or stealing any other identity |
| OpenShell network policy | Reaching AWS endpoints the project doesn't use |
| The CI apply role trusts only `environment:staging`, and that environment accepts only `main` | Applying from a PR, or from any other branch |
| Owner approval on `main` | Merging infrastructure the owner hasn't seen |
| `TerraformDeployBoundary` protects the `harness-*` roles and the gateway user | A project apply widening the agents' access |

### 12.4 Local Terraform

- **Commands.** In Developer and check sandboxes, agents run `terraform init` with the
  real backend config, then `terraform plan -lock=false`.
- **Why `-lock=false` is safe.** The role can't write the lock file, and a plan never
  writes state. Only CI takes the lock.
- **What `apply` does.** It stops with `AccessDenied` at its first write, and it can't
  write state either.
- **Code that runs during plan,** such as `external` data sources, runs inside the
  sandbox like any other project code. Provisioners run only at apply time, which can't
  happen locally.
- **Where infrastructure checks run.** Pre-merge checks with `needs: ["tfplan"]` run in
  a check sandbox: the daemon runs the plan there, then the assertions.

### 12.5 Secrets stay out of state

Agents can read the state file, so "no secrets in state" has to be real. The project
follows these rules:
- **Secret values.** Terraform creates secrets but never sets their values. The owner
  sets them at an owner gate, or rotation does. This also keeps
  `secretsmanager:GetSecretValue` denied.
- **RDS.** The database manages its own master password
  (`manage_master_user_password`).
- **Anything else.** Use Terraform's write-only arguments (Terraform 1.11 and later,
  for example `password_wo`) or ephemeral resources, which never land in state.

**Optional enforcement.** A step after `tf-apply` lists every value that Terraform marks
sensitive in the state, and fails if one isn't on an approved list.

### 12.6 Post-deploy checks

1. After `tf-apply` succeeds on `main`, the daemon runs the plan's `post-deploy`
   checks in a check sandbox with the view-only role.
2. Green: `PLAN_VERIFIED`.
3. Red: the Manager diagnoses the failure and requests a `Fix:` PR. After two rounds,
   the failure is escalated to the owner.

### 12.7 Changes in `terraform-bootstrap`

The owner makes these once, through a PR in that repository:

1. **A role per project,** `harness-<repo>-staging-view`, made of the four pieces in
   §12.2.
2. **One IAM user, `harness-gateway`.** Its only permission is `sts:AssumeRole` on
   `harness-*-view` roles. Its access key goes into OpenShell's credential store (the
   AWS provider's refresh material), never into a repository or `.harness/`. The
   gateway uses it to mint one-hour credentials.
3. **The state bucket policy** gets one statement per view role, following the existing
   per-repository pattern: the role may only read its own project's state object.
4. **`TerraformDeployBoundary`** additionally denies writes to `harness-*` roles and to
   the `harness-gateway` user.
5. **Verification,** the way the bootstrap README already does it:
   `simulate-principal-policy` confirms the denies, then a real plan reveals any
   missing reads.

### 12.8 Several modules, one `iac/`

`terraform-bootstrap` gives each repository one state per environment, so `iac/` is one
Terraform root shared by all modules:
- each module adds its own Terraform files, for example `iac/orders.tf`, or a
  Terraform module under `iac/modules/orders/`;
- cross-module decisions go in `ARCHITECTURE.md`;
- modules are built one after another, so plans never touch `iac/` concurrently.

---

## 13. Network access

The full list is in [`docs/research/network-allowlist.md`](../research/network-allowlist.md).

- **Bundles.** `core`, `node`, `python`, `aws` and `terraform` are on by default.
  `go`, `rust`, `jvm`, `opentofu` and `browsers` are opt-in. The Architect gets every
  bundle.
- **Read-only.** Documentation sites and package registries allow `GET`, `HEAD` and
  `OPTIONS` only. Git hosts also allow clone and fetch, never push. `api.anthropic.com`
  is reachable only through the Claude provider. AWS endpoints are generated from
  `aws.services`, and the proxy signs requests to them with the view-only role.
- **`web_read(url)`** covers every other public URL:
  - the daemon fetches with `GET` only, outside the sandbox, following at most five
    redirects;
  - it re-checks every redirect, and refuses private, loopback and link-local
    addresses so it can't reach the owner's LAN or the dashboard;
  - it limits size (2 MB fetched, 100 kB of text returned);
  - it converts HTML to text, applies the "never" list, and logs every read as a
    `WEB_READ` event.
- **Never.** Paste, tunnel and webhook sites, chat apps, personal storage, arbitrary
  cloud buckets, and anything that isn't HTTP(S).

---

## 14. Dashboard

### 14.1 Views

| View | Contents |
|---|---|
| **Needs you** (home) | Gates and owner tasks with instructions; PRs ready to merge; escalations; Manager questions; messages waiting for the Architect; the proposal waiting for acceptance; the next owner actions from each module's guide |
| **Project** | Modules, then proposals (v1…vN, with the accepted one marked), plans, features. Each feature shows its status, attempts (n of 2), duration and Findings. Plus CI status per PR, post-deploy results, and the last ten lines of `progress.txt`. |
| **Agents** | One card per agent: status, current task, elapsed time against the deadline, attempt, tokens used in the session, last activity, errors. From a card the owner can open the Architect's terminal, the Manager's chat and stream, or the Developer's live stream. |
| **Events** | The live feed of messages and events, with filters |

### 14.2 Owner actions

All of these are buttons or forms in the dashboard. Each records an event.

- Accept proposal vN.
- Mark an action done (its `verify` runs first if it has one).
- Answer an `OWNER_REQUEST`.
- Decide an escalation: one more attempt with guidance, send it to the Architect, or
  pause.
- Message the Manager or the Architect.
- Pause or resume the pipeline.
- Open a shell in any sandbox (owner only).

### 14.3 Terminals and streams

- **Architect.** The browser's xterm.js connects over a WebSocket to the daemon, which
  runs `openshell sandbox connect architect-<module>` under node-pty. The terminal is
  fully interactive, and `harness attach architect` gives the same view in any
  terminal.
- **Manager and Developer.** Their stream-json output is rendered as a live transcript:
  messages, tool calls with their arguments and results, and usage.
- **Any sandbox.** "Open shell" runs `openshell sandbox exec --tty -- bash -l`.

### 14.4 Implementation and security

- **Server.** It runs in the daemon process: HTTP on `127.0.0.1:<port>`, server-sent
  events for live updates, WebSockets for terminals, and POST requests for actions.
- **Front end.** React, Vite and TypeScript, built to static files that ship in the
  package. Agent-written Markdown is rendered through a sanitizer, because agents can
  write HTML.
- **Access.** `harness up` opens the dashboard with a one-time token, which becomes an
  HttpOnly cookie.
  - Host and Origin headers are checked, against DNS rebinding and cross-site requests.
  - A content security policy is set.
  - There is no remote access in v1; use SSH port forwarding if needed.
- **Isolation.** Sandboxes can't reach the host's loopback, and the agents' channel
  doesn't use the network at all (§9.2).

---

## 15. Recovery

### 15.1 One reconcile loop, not health checks

Every 15 seconds and after every event, the orchestrator compares each unfinished item
in the state with reality, and takes the next idempotent step. Reality means OpenShell
sandboxes, processes and stream files, plus GitHub pull requests and runs.

- Each side effect is recorded before it runs and after it runs, for example
  `ATTEMPT_STARTING`, then the sandbox is created, then `ATTEMPT_STARTED`.
- Names are deterministic, so a step repeated after a crash finds its earlier work.

### 15.2 Failures

| Failure | Behaviour |
|---|---|
| Computer restart, or unexpected shutdown | Docker and the OpenShell gateway restart on their own (systemd user service). `harness up` replays the log and restarts stopped sandboxes. The Architect and the Manager resume their sessions. A running attempt is `interrupted`, which doesn't count, and is restarted. If its sandbox survived, its session resumes instead. A half-written log line is dropped. |
| Daemon crash or restart | Sandboxes keep running. On start, the daemon reattaches: it follows the outboxes, the Manager's output file and the attempt streams again. |
| Agent process exits without a report | The attempt is `interrupted` and doesn't count (up to 2 per feature). |
| Sandbox lost | Developer: the attempt is `interrupted`. Architect or Manager: the sandbox is recreated, the transcript backup is uploaded, and the session resumes. |
| Network loss | The OpenShell CLI and Claude Code retry. A long outage marks the attempt `interrupted`. GitHub polling backs off. |
| Usage limit | The pipeline pauses until the reset time, then the same session continues. |
| Architect session ended (`/exit` or a crash) | The launcher's loop restarts Claude with `--resume` within seconds. |
| CI failure | The Manager diagnoses it, then fix rounds run (§7.4). |
| Owner gate pending | Nothing that depends on it runs. The dashboard shows it. |
| `.harness/` lost | `harness recover` rebuilds from git and GitHub (below). |

What `harness recover` rebuilds, and from where:
- modules and designs, from `harness/modules`;
- accepted features and satisfied gates, from `progress.txt` on `main` and the plan
  branches;
- pull requests and CI results, from GitHub;
- sessions, from backups if they survive. Otherwise new sessions start with a written
  summary.

---

## 16. Security model

### 16.1 Assumptions and assets

**What we assume about agents.** Any agent may:
- be confused;
- take shortcuts to make a check pass;
- follow instructions injected through a web page or repository content;
- try something outside its role.

**What's out of scope:** a compromised host, owner account, Docker or OpenShell.

**What we protect:**
- the owner's machine and credentials;
- the integrity of `main`, CI and the repository's protections;
- the AWS staging account;
- the owner's Claude subscription;
- the correctness of what gets built.

### 16.2 Threats and controls

| Threat | Controls |
|---|---|
| An agent changes AWS | Six independent controls (§12.3) |
| An agent weakens a check | The hash list with JSON fields; CI `verify` from the base branch; the lockfile check; Manager review of suppressions; owner review |
| An agent changes CI | The App has no workflow permission; CODEOWNERS; the repository ruleset |
| An agent escapes to the host | OpenShell isolation (non-root, no capabilities, Landlock, seccomp, no network of its own); no host folders mounted; the host never runs project code or agent git hooks |
| An agent steals or misuses credentials | There are none in sandboxes: Claude and AWS are injected at the proxy, and the GitHub key exists only on the host |
| An agent impersonates another, or reads private messages | Identity comes from which sandbox the daemon reads; access rules per type; agents never read the log |
| Prompt injection | Its effect is bounded by code-enforced permissions (I1). The Manager cannot accept a feature without passing checks, and the owner merges. |
| Runaway or looping agents | The brakes (§7.4) |
| An attack on the dashboard from the browser | Bound to localhost, token cookie, Host and Origin checks, sanitized Markdown, content security policy |
| `web_read` used to probe the owner's network | Public addresses only, re-checked on every redirect |

### 16.3 Secrets

| Secret | Where it lives | Used by |
|---|---|---|
| Claude subscription token | OpenShell provider store | Injected into requests to `api.anthropic.com` |
| `harness-gateway` access key (it can only assume view roles) | OpenShell provider refresh material | The gateway mints one-hour credentials |
| GitHub App private key | `~/.config/harness/<repo>.pem`, mode 0600 | The daemon only |
| The owner's own GitHub and AWS logins | The owner's usual config | Only commands the owner runs (`harness owner …`, `terraform-bootstrap`) |
| Dashboard token | Daemon memory and `daemon.json` (0600) | The owner's browser |

### 16.4 Accepted risks

- An agent could send repository code out in the URLs of `GET` requests to an
  allowlisted host or through `web_read`. That is the price of broad read access.
- View-only AWS reveals infrastructure metadata, object names and Lambda environment
  variables. The project rules in §12.2 cover them.
- The Architect could design weak checks. The owner reviews `Arch:` PRs, and step 4 of
  §7.3 flags checks that pass before anything is built.
- OpenShell is version 0.1.x. It is pinned, isolated behind the adapter, and re-probed
  after upgrades.
- The gateway user's key sits on the owner's machine. It can only assume view-only
  roles.

---

## 17. Package, CLI and setup

### 17.1 Package

- **Distribution.** The npm package `razzou-harness`, installed globally.
  - The name is unscoped, so the package is public on npmjs.com. The name was free on
    2026-10-09.
  - Its command is `harness` (see §19).
  - Projects built with it don't need to be Node projects.
- **Language and runtime.** TypeScript compiled to ESM, running on Node 24 or later.
- **Runtime dependencies**, kept few:
  - `zod` for schemas;
  - `ws` for terminal WebSockets;
  - `node-pty` for terminal attachment;
  - an HTML-to-text converter for `web_read`.
- **Build-time only:** React, Vite and xterm.js.
- **No dependencies:** the MCP shim and the CI verifier.

### 17.2 Commands

| Command | Who runs it | Does |
|---|---|---|
| `harness init` | Owner, in the project repository | Scaffolds `harness/config.json`, the workflow, `verify.mjs`, CODEOWNERS entries, `.gitignore`, the root `README.md` and `ARCHITECTURE.md`, and an `init.sh` stub. Prints the setup checklist. |
| `harness doctor [--probe] [--build-images]` | Owner | Checks the environment: Docker, container networking (and an active Tailscale exit node), the OpenShell version and gateway, providers, images, the GitHub App and the AWS role. `--probe` runs the permission tests (§6.2). |
| `harness up` / `down` | Owner | Starts the daemon and opens the dashboard, or stops the daemon. Sandboxes keep their state. |
| `harness status` | Owner | A one-screen summary in the terminal |
| `harness attach <architect\|manager\|sandbox>` | Owner | Attaches a terminal |
| `harness module new <id> "<title>"` | Owner | Starts a module |
| `harness owner apply <action>` | Owner | Applies an owner action that needs the owner's credentials, such as an `Owner:` PR for workflow YAML |
| `harness recover` | Owner | Rebuilds `.harness/` from git and GitHub |
| `harness upgrade` | Owner | Updates vendored CI files and migrates config, through a `Harness:` PR |
| `harness gc` | Owner | Applies retention (§10.4) |

### 17.3 One-time owner setup

`harness init` prints this checklist and `harness doctor` checks it.

1. **Docker and OpenShell.** Docker is installed and containers can reach the internet
   (no exit node). OpenShell is installed (done) at the pinned version.
2. **Claude subscription.** `claude setup-token`, then `harness doctor` imports the
   `claude-code-subscription` profile and creates the provider. This was tested
   2026-10-09.
3. **GitHub App.** Create the new App from the manifest the harness generates (§11.4),
   and install it on the project repository. Store its key in `~/.config/harness/`.
4. **Repository rules.** Apply the ruleset and CODEOWNERS. The harness prints the
   settings, or applies them with the owner's own `gh` login.
5. **AWS.** Make the `terraform-bootstrap` changes (§12.7), then store the
   `harness-gateway` key in OpenShell's AWS provider.
6. **Project files.** Commit the files `harness init` scaffolded (an `Owner:` PR).
7. **Probe.** Run `harness doctor --probe`.

### 17.4 Upgrades

- A project pins `harnessVersion`. `harness up` refuses a CLI with a different major
  version.
- `harness upgrade` rewrites the vendored CI files and migrates the config through a
  `Harness:` PR.
- New images come from `harness doctor --build-images`.
- OpenShell upgrades are checked against the pinned version, then re-probed.

### 17.5 Source layout of the harness

There are about thirty source files:

```
src/
  cli.ts                 command dispatch
  roles.ts               role definitions (§6.2)
  daemon/                main.ts, orchestrator.ts, brakes.ts, events.ts, state.ts
  protocol/              messages.ts, events.ts, acl.ts (zod schemas)
  tools/                 handlers per role, web-read.ts
  sandbox/               openshell.ts (the only CLI caller), policy.ts (role → policy YAML)
  agents/                adapter.ts, claude-code.ts
  git/                   repo.ts, bundles.ts
  github/                app.ts, prs.ts, ci.ts
  checks/                runner.ts, manifest.ts (shared with the CI verifier)
  design/                schemas.ts (module, plan, feature, check, owner action)
  dashboard/             server.ts
  setup/                 init.ts, doctor.ts, probe.ts, recover.ts
images/agent/            Dockerfile, mcp-shim.mjs, launchers
roles/                   architect.md, manager.md, developer.md
skills/                  grill-me/
ci/                      harness.yml, verify.mjs (built bundle)
dashboard/               React application
test/                    unit tests, plus an end-to-end test with stub agents
```

---

## 18. Delivery plan

Claude builds the harness directly in this repository.
- **During development,** each milestone ends with a demo on a throwaway repository.
  M1 and M2 need only local repositories and stub agents. M3 and M5 need a real GitHub
  repository and AWS role, so a throwaway repository is created when M3 starts.
- **The end-to-end test** is the owner's, once the harness is ready. It runs on a blank
  private repository, after its `terraform-bootstrap` onboarding.

| Milestone | Delivers | Done when |
|---|---|---|
| **M0 Spikes** (§18.1) | Answers to the open technical questions | Each spike is recorded in `docs/research/` |
| **M1 Walking skeleton** | Daemon, event log and state, the OpenShell driver, bundles, a Developer attempt, a check sandbox, brakes, `harness up` and `status`, a minimal live dashboard | A stub feature on a toy repository goes through attempt, checks and acceptance, and survives a daemon restart |
| **M2 Manager** | The long-lived Manager, the protocol and tools, Findings, review, plan validation | A two-feature plan completes with one rejected attempt and one question answered |
| **M3 GitHub** | The App, plan branches, PRs, the workflow and verifier, the hash list, CI polling, fix rounds | A `Plan:` PR passes CI. A deliberate change to a protected file fails `verify`. |
| **M4 Architect** | Module lifecycle, proposals, `grill-me`, decomposition, freeze, `Arch:` PRs, owner actions and gates | A small module goes from requirements to a merged `Arch:` PR |
| **M5 AWS and Terraform** | The `terraform-bootstrap` changes (owner), AWS signing, local plans, plan assertions, post-deploy checks | An infrastructure feature passes its plan assertion, applies in CI and passes its post-deploy check. Probe denials are confirmed. |
| **M6 Owner experience** | The full dashboard (needs-you, terminals, Manager chat), `init`, `doctor --probe`, `recover`, packaging | Fresh-machine setup from the checklist works, and the probe is green |

### 18.1 Spikes

1. **Done** ([results](../research/spike-01-exec-transport.md)): long-lived
   `openshell sandbox exec` streams. Following a file works, with 100 to 250 ms
   latency. Streaming stdin does not, so the Manager is fed through a file.
   Reconnecting after a gateway restart, and behaviour over many hours, are still to
   be observed in M1.
2. **Done** ([results](../research/spike-02-aws-signing.md)): AWS signing through the
   proxy. The AWS CLI and Terraform worked as the read-only role: reads, the S3 backend
   and `plan -lock=false`. Writes, data reads, secret reads and the state lock were all
   refused, and nothing was created.
3. **Done** ([results](../research/spike-03-manager-permissions.md)): the Manager's
   restricted tools. `--restricted`, `dontAsk` and three `git` allow rules give exactly
   read-only files plus `git log/diff/show`.
4. **Done** ([results](../research/spike-04-architect-terminal.md)): the Architect's
   terminal. A login shell in a sandbox created without a command keeps a terminal, and
   `connect` carries keystrokes, resizes, detach and reattach. A relaunch loop and
   `sandbox stop`/`start` keep the conversation through `/exit` and through a reboot.
   node-pty itself is checked in M1; the spike drove the terminal from Python's `pty`.
5. How a usage-limit hit appears in stream-json, and resuming after it.
6. Caches across attempts: npm and Terraform plugin caches on labelled Docker volumes.

---

## 19. Open decisions for the owner

None remain. v1's six open points are settled (D17 to D23), and so is v2's last one,
the CLI command's name (D24).

---

## 20. Decisions log

Settled in the design chat of 2026-10-08 and 2026-10-09.

| # | Decision |
|---|---|
| D1 | Code runs the loop; agents judge, code permits. Three roles: Architect, Manager, Developer. |
| D2 | The Manager is long-lived, a headless session driven by the daemon (option a). The owner chats with it from the dashboard. |
| D3 | Claude runs on the owner's subscription, through a custom OpenShell provider (verified). |
| D4 | At most three agents run at once. Developers run one at a time, with no parallel features in v1. |
| D5 | Internet: allowlist bundles plus `web_read` (option b). |
| D6 | Local `terraform plan` against real state, with no secrets in state. |
| D7 | Infrastructure checks run in two phases: plan assertions before merge, AWS checks after apply. |
| D8 | Each sandbox has its own clone, with bundles in and out. The daemon opens every PR, at the Architect's or the Manager's request. |
| D9 | The Architect is sandboxed too. |
| D10 | The dashboard is primary, the Architect is in its real terminal, and there's no tmux. |
| D11 | One Architect per module. Shared knowledge lives in the root `README.md` and `ARCHITECTURE.md`. |
| D12 | One view-only AWS role per project, shared by all agents: `ViewOnlyAccess`, `SecurityAudit`, a custom read policy and an explicit deny. It is defined in `terraform-bootstrap` and protected by `TerraformDeployBoundary`. |
| D13 | Messages are typed JSON, events are recorded only by the daemon, and the daemon stamps every envelope. |
| D14 | CI checks are data. The App has no workflow permission. Workflow changes go through owner gates. |
| D15 | `package.json` is protected by JSON-field hashes, and checks keep `npm run`. Tool configs and `.npmrc` stay protected. Suppressions are flagged to the Manager. |
| D16 | `harness doctor` checks container networking, including Tailscale exit nodes. |
| D17 | The unit with one architecture proposal and several plans is called a **module**, not a "part" or "system part". |
| D18 | The npm package is `razzou-harness`, public on npm. |
| D19 | A new GitHub App, dedicated to the harness. |
| D20 | Exactly one PR per plan. When a feature is accepted, the daemon combines the Developer's commits into exactly one commit for that feature (§11.3). PRs merge with merge commits only, so feature commits are preserved on `main`; plans are never squashed. |
| D21 | The dashboard front end uses React with Vite. |
| D22 | The first end-to-end project is a blank repository, run by the owner once the harness is ready. |
| D23 | Effort per role stays as proposed in v1: Architect `max`, Manager `high`, Developer `xhigh`. |
| D24 | The CLI command is `harness`. The owner will never install the Harness.io CLI. |
| D25 | The GitHub organization is `razzou-labs`. Harness repositories commit as `razzou`, with a GitHub noreply email. |
| D26 | `terraform-bootstrap` trusts GitHub's OIDC subjects by numeric owner and repository ids, with the organization name as a wildcard, so CI doesn't depend on the organization's name. |

**Refinements in this document, not discussed in the chat:**
- The daemon reaches into sandboxes through OpenShell `exec`, instead of each sandbox
  holding a token (§9.2).
- There is one Manager session per module (§7.5).
- Every attempt counts toward the limit, and clarifications happen inside an attempt
  through `ask_manager` (§7.4).

---

## Appendix: the brief's 40 open questions

| # | Question | Answer | § |
|---|---|---|---|
| 1 | Communication bus | Built into the daemon: event log plus MCP tools, carried over OpenShell exec | 9 |
| 2 | Communication authorization | Identity is the sandbox. Access rules per message type. Agents read only their own inbox. | 9.2, 9.3 |
| 3 | Launching sessions | The daemon creates OpenShell sandboxes and launches each role as described | 5.3, 6.4, 7.5 |
| 4 | Keep tmux? | No | 14.3 |
| 5 | tmux or a process supervisor | The daemon plus OpenShell, which keeps sandboxes alive | 5, 15 |
| 6 | Persistent Architect sessions | A session id per module, a persistent sandbox, transcript backups, `--resume` | 7.5 |
| 7 | Dashboard and runtime | The same process: HTTP, server-sent events, WebSockets | 14.4 |
| 8 | Node server plus front end? | Yes: React and Vite, built into the package | 14.4 |
| 9 | Terminal streaming | xterm.js, WebSocket, node-pty, `openshell sandbox connect`. Rendered streams for headless agents. | 14.3 |
| 10 | `state.json` contents | A projection of the event log | 10.3 |
| 11 | Durable versus runtime state | Git, `.harness/`, memory | 10.1 |
| 12 | `.harness/` structure | See 10.2 | 10.2 |
| 13 | Feature schema | See 8.2 | 8.2 |
| 14 | Plan schema | See 8.2 | 8.2 |
| 15 | Validation checks | A generic command with a phase and needs | 8.3 |
| 16 | Owner gates | `owner-actions.json` plus the dashboard | 8.4 |
| 17 | Findings | The payload of `BLOCKED`, with categories | 9.7 |
| 18 | `progress.txt` | Structured lines written by the daemon; append-only | 8.5 |
| 19 | Owner interaction | The Architect in its terminal, the Manager through the dashboard chat, everything else as dashboard actions | 14 |
| 20 | Dashboard as primary interface | Yes, with the Architect's real terminal embedded | 14 |
| 21 | GitHub App permissions | Contents and pull requests read-write; checks, Actions and statuses read; no workflows or administration | 11.4 |
| 22 | Linux and OpenShell permissions per role | One role definition generates every layer | 6 |
| 23 | IAM roles per Harness role | One view-only role per project, shared by all agents | 12.2 |
| 24 | Preventing local Terraform changes | Six independent controls | 12.3 |
| 25 | Safe local Terraform | `plan -lock=false` in sandboxes, plus plan assertions | 12.4 |
| 26 | CI results for the Manager | The daemon polls GitHub; `get_ci_results` | 11.7 |
| 27 | Hash mechanism | `harness/lock.json`: whole files and JSON fields | 8.7 |
| 28 | Unauthorized hash changes | Only `Arch:` PRs, verified from the base branch, merged by the owner | 8.7, 11.5 |
| 29 | Swappable developer agents | `AgentAdapter` plus MCP tools | 6.5 |
| 30 | Keeping Claude Code's prompt | `--append-system-prompt-file` only | 6.4 |
| 31 | Enforcing 90 minutes | A deadline recorded at start; the reconcile loop stops the agent | 7.4, 15 |
| 32 | Enforcing two attempts | Counted per definition version, checked before each start | 7.4 |
| 33 | Detecting infinite loops | Counters and deadlines only; no heuristics | 7.4 |
| 34 | Resuming or replacing failed agents | Per role, see 15.2 | 15.2 |
| 35 | Shared infrastructure across modules | One `iac/` root plus `ARCHITECTURE.md` | 12.8 |
| 36 | npm package configuration | `harness/config.json` with a JSON Schema | 8.6 |
| 37 | Upgrading the harness | Version pin plus `harness upgrade` | 17.4 |
| 38 | Secrets | See 16.3 | 16.3 |
| 39 | Retention of logs and messages | See 10.4 | 10.4 |
| 40 | Security of the Architect's broad permissions | Broader reading, same hard limits | 6.3 |
