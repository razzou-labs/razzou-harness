# razzou-harness

**Your AI dev team, with you in charge.**

You describe a module. An Architect designs it with you, Developers build it one feature
at a time, and a Manager reviews each one. Every agent works in its own
[OpenShell](https://github.com/NVIDIA/OpenShell) sandbox with no credentials, every
feature is checked in a fresh one, and nothing reaches `main` until you merge its pull
request. A small daemon runs the loop, following Anthropic's
[Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents).

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install and set up a project](#install-and-set-up-a-project)
- [Your first module](#your-first-module)
- [Concepts](#concepts)
- [The dashboard](#the-dashboard)
- [Commands](#commands)
- [Configuration](#configuration)
- [AWS and Terraform](#aws-and-terraform)
- [Security](#security)
- [Usage and costs](#usage-and-costs)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## How it works

You start a module in the dashboard, and talk with its Architect (Claude Code,
interactive) in its terminal. The Architect asks you questions until the need is clear,
writes proposals until you accept one, then turns it into plans, features, checks and
owner actions. These reach `main` as an `Arch:` pull request that you merge. Then the
daemon builds the module, feature by feature:
- it starts a Developer (Claude Code) in a fresh sandbox, with a 2-attempt budget and a
  deadline;
- it checks the result in another fresh sandbox, which has no agent;
- a long-lived Manager (Claude Code, read-only) reviews what passed, answers the
  Developer's questions, and gives the guidance a failed attempt's successor starts
  with;
- the daemon lands each accepted feature as one commit on the plan branch, in its own
  git repository under `.harness/git`. When a plan is done, all its checks run again,
  and the Manager submits it;
- the daemon pushes the plan branch and opens one pull request for it, as a GitHub App
  with no access to workflows. CI checks the PR with the rules of the base branch. If CI
  fails, the Manager diagnoses it and a Developer fixes it, twice at most. You merge.

Infrastructure features take the same path. Agents see AWS through a read-only role
whose requests the OpenShell proxy signs, so they plan against the real state but never
write. A check can assert on that plan. CI plans again with its own role, and applies
`main` after the merge. Post-deploy checks then test the real resources, and a failed
apply or post-deploy check gets a `Fix:` pull request, twice at most.

Agents reach the daemon only through harness tools: a small MCP server inside each
sandbox relays their calls through files, and the daemon decides. Everything is recorded
in an event log, so the daemon picks up where it stopped after a restart, while the
agents keep working. Without `project.repo`, a project stays local: plans complete
without pull requests.

## Requirements

- Linux, Node 24 or later, git, Docker, and `gh` logged in as an admin of your
  project's repository.
- OpenShell 0.1.2 with a running gateway. The harness is tested with this version only,
  and `harness doctor` refuses others.
- Claude Code on this machine, with a Claude subscription: its binary goes into the
  sandbox image, and `claude setup-token` gives the agents' token. Access with an API
  key is untested.
- For terminals in the dashboard: `python3`, `make` and `g++`, to build node-pty at
  install. Without them, everything else works, and `harness attach` opens the
  Architect's terminal.
- On GitHub, for pull requests:
  - **An organization** that owns your project's repository: `harness github-app
    create` creates the harness's App in an organization. A free one works.
  - **Rulesets** protect `main`. GitHub offers them on private repositories only with a
    paid plan, such as Team for an organization; public repositories get them for free.
    Without them, nothing on GitHub makes code wait for your review before it reaches
    `main`, and `harness doctor --probe` reports it.

## Install and set up a project

```sh
npm install -g razzou-harness --allow-scripts=node-pty
cd path/to/project && harness init    # then follow the checklist it prints
harness doctor --build-images         # builds the agents' image
harness doctor --probe                # everything an agent must not do, tried
harness up                            # the daemon, and the dashboard
```

The command is also installed as `razzou-harness`, for machines where another `harness`,
such as the Harness.io CLI, comes first on the PATH.

`harness init` writes the harness's files into the repository, never over existing
ones, and prints the setup checklist:
1. Docker, and OpenShell with a running gateway.
2. The Claude subscription: `claude setup-token`, then `harness doctor` in a terminal
   creates the provider, with the token typed at a hidden prompt.
3. The GitHub App, once per machine: `harness github-app create --org <org>`, then install
   it on the project repositories only.
4. The repository rules: `harness github-setup --repo <org>/<repo>`, with your own `gh`.
5. AWS, for infrastructure: see [AWS and Terraform](#aws-and-terraform).
6. Review the files `init` wrote, commit them, and push them to `main` yourself: the App
   may not touch workflows.
7. `harness doctor --probe`.

`harness doctor` checks each step, and says what to do about what fails. `--probe` tries,
from a sandbox like an agent's and from outside, everything that must be refused: AWS
writes and secret reads, other projects' state, `git push`, unlisted hosts and the
metadata address, a workflow pushed by the App, a merge without your approval.

`harness init` lets the sandboxes reach only the `core` network bundle. Add your
stack's bundles, such as `node` for npm, in `harness/config.json` (see
[Configuration](#configuration)).

## Your first module

With `harness up` running and the dashboard open:

1. **Start it.** In **Project**, give the module an id and a line about what it is for,
   then **Start**. An Architect starts in its own sandbox. From a terminal:
   `harness module new greeter "A greeting command-line tool"`.
2. **Talk it through.** In **Agents**, open the Architect's terminal and say what you
   need. It reads the repository, asks its questions, then writes a proposal: the
   problem, the design, the plans it expects, and what only you can do. From a terminal:
   `harness attach greeter`, and detach with Ctrl-P, then Ctrl-Q.
3. **Accept a proposal.** **Needs you** shows it. Accept it, or ask for changes in the
   terminal, and the Architect writes the next version. Once you accept one, the
   dashboard prompts the Architect, which turns it into plans, features and checks, and
   the daemon opens an `Arch:` pull request with them. Its new checks run once first: they should fail,
   since nothing is built yet, and any that pass are flagged.
4. **Merge the design.** Review the Arch PR on GitHub, and merge it with a merge commit
   once CI passes. The build starts.
5. **Watch the build.** In **Agents**, each Developer's session and the Manager's are
   live transcripts. **Project** shows each feature's attempts, checks and commits.
6. **Answer what comes up.** A question from the Manager, or a feature that ran out of
   attempts, appears in **Needs you** with a form or buttons.
7. **Merge the plan.** When all of a plan's features are accepted and its checks pass
   again, the daemon opens one `Plan:` pull request. Merge it with a merge commit once
   CI passes. The next plan starts.

You can also write a module's design by hand, on `main`: the daemon builds whatever
plans it finds there (see [Configuration](#configuration)).

## Concepts

- **Module:** a unit of design, with one Architect and one accepted proposal, then its
  plans. Modules are built one after another.
- **Proposal:** the Architect's design document, in versions v1, v2 and so on. You
  accept one.
- **Plan:** features that ship together as one pull request. A module's plans are built
  in order.
- **Feature:** one change that a Developer can make in one attempt, with at least one
  check. Its definition is frozen once its design is merged.
- **Check:** a shell command, run from the repository root, that exits 0 when the feature
  works. `pre-merge` checks run on every attempt and in CI; `post-deploy` checks run
  after an infrastructure deploy.
- **Attempt:** one Developer session on one feature, in a fresh sandbox, with a deadline
  (90 minutes) and a budget (2 attempts per feature). A failed attempt's successor
  starts with the Manager's guidance. Once the budget is spent, the feature is escalated
  to you.
- **Owner actions:** what only you can do, such as creating an account, approving a
  policy or setting a secret. A **gate** holds back the plans or features it blocks
  until you mark it done; a **task** holds nothing back.
- **Protected files:** the design and its checks, CI, and what agents read as
  instructions: `harness/`, `.github/`, `.claude/`, `CLAUDE.md`, `AGENTS.md`,
  `ARCHITECTURE.md`, `init.sh`, tool configs and the npm scripts that checks run. A
  `Plan:` or `Fix:` pull request may not change them: CI's `verify` job, run with the
  base branch's rules, fails it. They change through an `Arch:` pull request, or your own
  commits. `harness/lock.json` holds their hashes.
- **`progress.txt`:** one line per accepted feature and satisfied gate, committed with
  the work. It only grows.
- **Brakes:** counters and deadlines, not judgment. Three failed attempts in a row, a
  Manager that leaves an item waiting for 40 minutes, or CI still failing after two fix
  rounds pause the pipeline until you resume it.

## The dashboard

`harness up` runs the daemon in the foreground and opens the dashboard: localhost only,
behind a token. Its views:
- **Needs you:** questions from the Manager, proposals to accept, pull requests to merge,
  escalations, owner actions, a paused pipeline. Each has its button or form.
- **Project:** modules, proposals, plans and features, with attempts, findings, CI,
  deploys and `progress.txt`.
- **Agents:** the Architect's terminal, the Manager's and the Developers' live
  transcripts, a message box for the Manager, and a shell in any agent's sandbox.
- **Events:** the event log, live, with a filter.

The header pauses and resumes the pipeline: a pause lets what runs finish, and starts
nothing new.

## Commands

Run them in the project's folder, or add `--dir <project>`. `harness --help` lists them
too.

| Command | What it does |
|---|---|
| `harness init` | Writes the harness's files into the repository, and prints the setup checklist |
| `harness doctor [--build-images] [--probe]` | Checks the machine and the project, builds the agents' image, and tries what agents must not do |
| `harness github-app create --org <org>` | Creates the harness's GitHub App, once per machine |
| `harness github-app check --repo <org>/<repo>` | Checks that the App can reach the repository |
| `harness github-setup --repo <org>/<repo>` | Sets merge commits only, and the ruleset on `main`, with your own `gh` |
| `harness install-ci [--owner <login>]` | Writes the workflow, its CI script and `CODEOWNERS` again, after an upgrade |
| `harness lock` | Writes `harness/lock.json`, the hashes of the protected files |
| `harness up`, `harness down` | Starts the daemon and the dashboard, or stops the daemon; sandboxes keep running |
| `harness status` | Plans, features, modules and open questions, in the terminal |
| `harness module new <id> <title>` | Starts a module and its Architect |
| `harness attach <module>` | Opens the Architect's terminal here; detach with Ctrl-P, then Ctrl-Q |
| `harness accept <module> <vN>` | Accepts the Architect's proposal vN |
| `harness actions`, `harness done <module>/<id>` | Lists the owner actions, or marks one done |
| `harness answer <request-id> <text>` | Answers a question from the Manager |
| `harness message <text>` | Writes to the Manager of the module being built |
| `harness retry <module>/<plan>/<feature>` | Gives an escalated feature one more attempt; `--note` adds guidance |
| `harness resume` | Lifts a pause |
| `harness recover` | Rebuilds a lost `.harness/` from `main` and GitHub |

## Configuration

`harness/config.json` holds the project's settings. It is a protected file: it changes
through an `Arch:` pull request, or a commit of your own on `main`.

```json
{
  "harnessVersion": "0.1.1",
  "project": { "name": "shop", "repo": "<org>/shop", "bot": "<org>-harness[bot]" },
  "roles": {
    "architect": { "model": "claude-opus-5-5", "effort": "max" },
    "manager": { "model": "claude-opus-5-5", "effort": "high" },
    "developer": { "model": "claude-opus-5-5", "effort": "xhigh", "attemptTimeoutMinutes": 90, "maxAttempts": 2 }
  },
  "network": { "bundles": ["core", "node"], "extraHosts": [] },
  "checks": [{ "id": "unit", "run": "npm test", "phase": "pre-merge" }]
}
```

| Field | Default | What it sets |
|---|---|---|
| `project.name` | the folder's name, from `init` | Names the sandboxes and the dashboard |
| `project.repo`, `project.bot` | none | The GitHub repository, and the App's bot login. Without them, the project stays local. |
| `roles.<role>.model` | `claude-opus-5-5` | The model of the Architect, the Manager and the Developers |
| `roles.<role>.effort` | `max`, `high`, `xhigh` | Claude Code's `--effort`; `null` for a model without effort levels, such as Haiku |
| `roles.developer.attemptTimeoutMinutes` | 90 | An attempt's deadline |
| `roles.developer.maxAttempts` | 2 | Attempts per feature before it is escalated to you |
| `network.bundles` | `["core"]` | The hosts sandboxes reach, by bundle: `core`, `node`, `python`, `aws`, `terraform`, `go`, `rust`, `jvm`, `opentofu`, `browsers`. The Architect gets them all. |
| `network.extraHosts` | `[]` | More hosts, read-only |
| `checks` | `[]` | Checks that every feature must keep passing, such as `npm run lint` |
| `protect.files`, `protect.jsonFields` | none | More protected files, and protected JSON fields by file, like `{"tsconfig.json": ["/compilerOptions/strict"]}` |
| `sandbox.image` | `razzou-harness/agent:0.1.0` | The agents' image, which `harness doctor --build-images` builds |
| `sandbox.claudeProvider` | `claude-sub` | The OpenShell provider that holds your Claude token |
| `sandbox.env` | `{}` | Environment variables for every sandbox |
| `github.requiredChecks` | `["verify", "checks"]` | The CI jobs a pull request must pass; `tf-plan` is added with Terraform |
| `brakes.consecutiveFailures` | 3 | Failed attempts in a row that pause the pipeline |
| `brakes.managerTurnMinutes` | 20 | How long an item waits for the Manager before a reminder; as long again, and the pipeline pauses |
| `brakes.ciFixRounds`, `brakes.deployFixRounds` | 2, 2 | Fix rounds after CI fails, and `Fix:` pull requests after a deploy fails |
| `dashboard.port` | 4777 | The dashboard's port, or the next free one |
| `aws`, `terraform` | none | See [AWS and Terraform](#aws-and-terraform) |

A module's design lives on `main` too, whether the Architect wrote it or you did:

```
harness/modules/<module>/plans/P1.json        a plan and its features
harness/modules/<module>/checks/...           the scripts its checks run, with synthetic data
harness/modules/<module>/owner-actions.json   gates and tasks for you, if any
```

A plan, `harness/modules/greeter/plans/P1.json`:

```json
{
  "id": "P1",
  "module": "greeter",
  "title": "Greeting CLI",
  "goal": "A command that greets a name.",
  "features": [
    {
      "id": "F01",
      "title": "Greet by name",
      "description": "src/greet.js prints \"Hello, <name>!\" for its first argument, and a usage line with exit code 1 without one.",
      "expected": "`node src/greet.js Ada` prints Hello, Ada!",
      "checks": [
        { "id": "F01-greet", "run": "node --test harness/modules/greeter/checks/F01.test.mjs", "phase": "pre-merge" }
      ]
    }
  ]
}
```

- **Features** may also have `kind` (`app` or `infra`), `dependsOn` (earlier features of
  the same plan), `gates`, and `resources` (where the Developer should look).
- **Checks** have `run` (a shell command from the repository root, never a `/sandbox/`
  path), `phase` (`pre-merge` or `post-deploy`), `timeoutSec` (600 by default), and
  `needs`: `tfplan` to get a Terraform plan's JSON in `$HARNESS_PLAN_JSON`, `aws` to use
  the read-only AWS role.
- **Owner actions** look like this, and a `verify` command, if set, runs in a fresh
  sandbox before the action counts as done:

  ```json
  [{ "id": "G1", "kind": "gate", "title": "Approve the retention policy", "blocks": ["P2"],
     "instructions": "Markdown for you.", "verify": null }]
  ```

## AWS and Terraform

Infrastructure is optional: skip this section for a project without it. With it, agents
see your AWS account and plan Terraform against the real state, but never change
anything. They work through a read-only role whose requests the OpenShell proxy signs,
and Terraform applies only in CI, after you merge.

**What you need in AWS.** The harness doesn't create it:
1. **A state bucket** for Terraform, with this project's state under its own key.
2. **CI roles, trusted through GitHub's OIDC:** a plan role for pull requests, and an
   apply role trusted only from a GitHub environment named `staging`, which only `main`
   may use.
3. **The agents' read-only role**, named `harness-<project>-view`: `harness doctor`
   expects the `harness-` prefix and the `-view` suffix. It has:
   - the AWS managed policies `ViewOnlyAccess` and `SecurityAudit`;
   - list access to the state bucket, read access to this project's state object, and
     `kms:Decrypt` on the state's key through S3;
   - an explicit deny on data and secrets, which no update to the managed policies can
     undo: `s3:GetObject*` on anything but the state object; the DynamoDB item reads
     (`GetItem`, `BatchGetItem`, `Query`, `Scan`, the PartiQL calls, `GetRecords`);
     `secretsmanager:GetSecretValue` and `BatchGetSecretValue`; the SSM parameter reads;
     `kms:Decrypt` on any other key; the CloudWatch Logs content reads (`GetLogEvents`,
     `FilterLogEvents`, `StartQuery`, `GetQueryResults`, `StartLiveTail`);
     `sqs:ReceiveMessage`, `kinesis:GetRecords`, `athena:GetQueryResults` and
     `rds-data:*`; the Cognito user reads; the SNS subscription reads, which hold emails
     and phone numbers; `ec2:GetPasswordData` and `GetConsoleOutput`; and the ECR image
     content (`BatchGetImage`, `GetDownloadUrlForLayer`);
   - a trust policy that lets only the gateway user assume it.
4. **A gateway user**, whose only permission is `sts:AssumeRole` on the view roles. Its
   access key goes into OpenShell, never into a repository or a sandbox.
5. **A permissions boundary** on the CI apply role that denies changes to the
   `harness-*` roles and to the gateway user, so your project's own Terraform can't widen
   the agents' access.

**Then, in the project:**
1. In `harness/config.json`, add `aws` and `terraform`:

   ```json
   "aws": { "region": "us-east-1", "provider": "aws-view-shop", "services": ["sts", "s3", "iam", "sqs"] },
   "terraform": { "dir": "iac", "backendConfig": "backend-configs/staging.hcl", "varFile": "env/staging.tfvars" }
   ```

   `services` lists the AWS services the project uses: their endpoints become reachable,
   and signed. Keep the `terraform` paths as they are: the CI workflow uses the same
   ones. `harness github-setup` then requires `tf-plan` as well.
2. Set the repository variables the workflow reads: `AWS_REGION_STAGING`,
   `AWS_ROLE_PLAN_ARN_STAGING` and `AWS_ROLE_APPLY_ARN_STAGING`.
3. `harness doctor` creates the OpenShell AWS provider: it asks for the view role's ARN,
   and for the gateway user's key at a hidden prompt. Only OpenShell holds the key.
4. `harness doctor --probe` checks the result: AWS must answer as the view role, and
   refuse a write, a secret and another project's state.

A check with `"needs": ["tfplan"]` finds the plan's JSON in `$HARNESS_PLAN_JSON`. A
`post-deploy` check with `"needs": ["aws"]` runs after the apply, as the read-only role.

Agents can read the Terraform state, so keep secrets out of it: Terraform creates a
secret, but you or a rotation set its value; a database manages its own password (for
RDS, `manage_master_user_password`); anything else uses write-only arguments.

## Security

What agents can't do, and what stops them:
- **Hold credentials.** Sandboxes hold placeholders. The OpenShell proxy adds the Claude
  token on `api.anthropic.com` only, and signs AWS requests with the read-only role.
- **Reach the host.** Each agent runs in its own container, with no host folder mounted;
  code moves in and out as git bundles. The host never runs code or git hooks that an
  agent wrote.
- **Write to GitHub.** Only the daemon talks to GitHub, as an App with no access to
  workflows or settings. Sandboxes may clone and fetch, never push.
- **Change the rules.** Checks, CI and the agents' instructions are protected files: a
  Developer's work can't change them, and CI checks that with the base branch's rules.
  They change only through an Arch PR you merge, or your own commits.
- **Change AWS.** A read-only role with explicit denies, and applies only in CI after
  your merge.
- **Go anywhere online.** Sandboxes reach listed hosts, read-only. Other pages go
  through `web_read`: GET only, public addresses only, checked again after every
  redirect.
- **Decide alone.** Code runs the loop: deadlines, attempt budgets, checks in fresh
  sandboxes and your merges are enforced by the daemon, not left to the agents.

What remains possible, by design:
- an agent could send code out in the URL of an allowed GET request;
- the read-only role shows infrastructure metadata, S3 object names and Lambda
  environment variables: keep user identifiers out of object names, and secrets out of
  Lambda environment variables;
- the Architect writes the checks: review Arch PRs. Checks that pass before anything is
  built are flagged in them.

`harness doctor --probe` tries, from sandboxes set up like the agents', what must be
refused. Run it after setup, and after upgrading the harness, OpenShell or Claude Code.
To report a vulnerability, see `SECURITY.md` in the source repository.

## Usage and costs

- The agents run on your Claude subscription, so their usage counts against your plan's
  limits. When Claude Code reports that a limit is reached, the attempt under way
  doesn't count, and the pipeline pauses for an hour, then goes on.
- By default, all three roles run Opus 5.5 at a high effort. To try the harness, or to
  use less of your plan, set each role's `model` to Haiku 4.5
  (`claude-haiku-4-5-20251001`) and its `effort` to `null`.
- With Haiku 4.5 in our test runs, a Developer attempt took under 90 seconds and 17 to
  23 turns: 150,000 to 310,000 input tokens, mostly read from the cache, and 2,000 to
  6,000 output tokens. Claude Code estimated $0.08 to $0.12 per attempt at API prices.
  The Architect and the Manager use more, over their long sessions.
- The dashboard shows each session's model calls, tokens and Claude Code's cost estimate.

## Troubleshooting

`harness doctor` names what fails and what to do. The usual cases:

| `harness doctor` says | What to do |
|---|---|
| `Docker: … permission denied` | Add yourself to the `docker` group, then log in again |
| `Tailscale: an exit node is active`, or `container network` fails | An exit node can cut the containers' network: turn it off |
| `OpenShell: … pinned to 0.1.2` | Install OpenShell 0.1.2 |
| `OpenShell gateway` fails | `openshell gateway start` |
| `image: … has Claude Code X, this machine Y` | `harness doctor --build-images`, after each Claude Code update |
| `terminals: node-pty is missing` | Install `python3`, `make` and `g++`, then reinstall with `--allow-scripts=node-pty`. `harness attach` works meanwhile. |
| `Claude provider: … is missing` | `claude setup-token`, then `harness doctor` in a terminal: it asks for the token |
| `GitHub App: … 404` | Install the App on the repository, from the link `harness github-app create` printed, or the organization's settings |
| `ruleset: …` fails | `harness github-setup --repo <org>/<repo>`. A private repository needs a paid GitHub plan for rulesets. |
| `.github/… differs from this version of the harness` | `harness install-ci`, then commit the files yourself |

While the daemon runs:
- **The pipeline is paused.** **Needs you** says why: attempts that failed in a row, a
  Manager that didn't act, CI still failing after its fix rounds, a usage limit, or a
  broken environment. Fix the cause, then **Resume**.
- **A feature is escalated.** It used its attempts. In **Needs you**, give it one more
  attempt with your guidance, send it to the Architect (the design may change), or pause.
- **The dashboard asks for its token.** Each `harness up` prints a new link: open that
  one.
- **A merge takes minutes to show up.** The daemon polls GitHub: every minute, then every
  five once nothing has changed for ten minutes.
- **Closing the terminal stopped the daemon.** Run `harness up` again: it picks up from
  its event log, and the agents kept working meanwhile.

## Development

```sh
npm install
npm test            # unit tests and the daemon end to end, with a local stand-in for OpenShell
npm run typecheck   # the daemon and the dashboard
npm run build       # dist/: the daemon, and the dashboard in dist/web
npm pack            # a package of these sources: npm install -g ./razzou-harness-<version>.tgz --allow-scripts=node-pty
npm run harness -- up --dir path/to/project   # from the sources; run `npm run build` once for the dashboard
```

A GitHub release tagged with the package's version, such as `v0.1.2`, publishes it to
npm. The release workflow checks the tag against `package.json`, runs the typecheck and
the tests, then publishes with npm's trusted publishing, so each version shows where it
was built.

## License

MIT
