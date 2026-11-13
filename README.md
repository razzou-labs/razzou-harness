# razzou-harness

**Your AI dev team, with you in charge.**

> **Alpha.** razzou-harness is young: expect bugs, and expect a new minor version to
> change how a project is set up. Each release's [changelog](CHANGELOG.md) entry says
> how to upgrade.

You describe a module, a part of the system you want to build. An Architect designs it
with you, Developers build it one feature at a time, and a Manager reviews each one.
Every agent works in its own [OpenShell](https://github.com/NVIDIA/OpenShell) sandbox
with no credentials, every feature is checked in a fresh one, and nothing reaches `main`
until you merge its pull request. A small daemon runs the loop, following Anthropic's
[Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents).
That is Manual mode. For a project too large to read in full, [Swarm mode](#swarm-mode)
lets the daemon merge the plans that pass CI and two reviewers.

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install and set up a project](#install-and-set-up-a-project)
- [Your first module](#your-first-module)
- [Concepts](#concepts)
- [The dashboard](#the-dashboard)
- [Swarm mode](#swarm-mode)
- [Commands](#commands)
- [Configuration](#configuration)
- [AWS and Terraform](#aws-and-terraform)
- [Security](#security)
- [Usage and costs](#usage-and-costs)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## How it works

```mermaid
flowchart TB
    you(["You"])

    subgraph machine["Your machine"]
        dash["Dashboard<br/>localhost, behind a token"]
        daemon["Daemon<br/>event log, brakes, .harness/git"]
    end

    subgraph sandboxes["OpenShell sandboxes, with no credentials"]
        arch["Architect<br/>designs the module with you"]
        mgr["Manager<br/>reviews, read-only"]
        dev["Developers<br/>one feature per attempt"]
        chk["Checks<br/>a fresh sandbox, no agent"]
    end

    proxy["OpenShell proxy<br/>adds the Claude token,<br/>signs AWS requests"]
    claude["Claude API"]

    subgraph github["GitHub"]
        pr["Pull requests<br/>Arch:, Plan:, Fix:"]
        ci["CI<br/>with the base branch's rules"]
        mainb["main"]
    end

    aws["AWS<br/>read-only view role for agents"]

    you <--> dash
    you -- "talks it through" --> arch
    dash <--> daemon
    daemon <-- "harness tools" --> arch
    daemon <-- "harness tools" --> mgr
    daemon <-- "harness tools" --> dev
    daemon -- "runs" --> chk
    sandboxes --> proxy
    proxy --> claude
    proxy -- "read-only" --> aws
    daemon -- "as a GitHub App:<br/>pushes, opens PRs" --> pr
    pr --> ci
    pr -- "you merge" --> mainb
    mainb -- "CI applies Terraform" --> aws
```

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
  fails, the Manager diagnoses it and a Developer fixes it, twice at most. You merge,
  or the daemon does in [Swarm mode](#swarm-mode).

Infrastructure features take the same path. Agents see AWS through a read-only role
whose requests the OpenShell proxy signs, so they plan against the real state but never
write. A check can assert on that plan. CI plans again with its own role, and applies
`main` after every merge, whatever the merge changed, since code that Terraform packages
deploys with it. Post-deploy checks then test the real resources, and a failed apply or
post-deploy check gets a `Fix:` pull request, twice at most.

Agents reach the daemon only through harness tools: a small MCP server inside each
sandbox relays their calls through files, and the daemon decides. Everything is recorded
in an event log, so the daemon picks up where it stopped after a restart, while the
agents keep working. The project needs a GitHub repository, since every design and plan
reaches `main` through a pull request: `harness up` refuses a project without
`project.repo`.

## Requirements

- Linux, Node 24 or later, git, Docker, and `gh` logged in as an admin of your
  project's repository.
- OpenShell 0.1.7 with a running gateway. The harness is tested with this version only,
  and `harness doctor` refuses others.
- Claude Code on this machine, with a Claude subscription: its binary goes into the
  sandbox image, and `claude setup-token` gives the agents' token. Access with an API
  key is untested.
- For terminals in the dashboard: `python3`, `make` and `g++`, to build node-pty at
  install. Without them, everything else works, and `harness attach` opens the
  Architect's terminal.
- On GitHub, a repository for the project, which `harness setup` creates when the project
  has no remote. The harness doesn't run without one: every design and plan reaches
  `main` through a pull request. Also:
  - **An organization** that owns your project's repository: `harness github-app
    create` creates the harness's App in an organization. A free one works.
  - **Rulesets** protect `main`. GitHub offers them on private repositories only with a
    paid plan, such as Team for an organization; public repositories get them for free.
    Without them, nothing on GitHub makes code wait for your review before it reaches
    `main`, and `harness doctor --probe` reports it.

## Install and set up a project

```sh
npm install -g razzou-harness --allow-scripts=node-pty
cd path/to/project && harness setup   # the rest, asking only for what is yours
```

The command is also installed as `razzou-harness`, for machines where another `harness`,
such as the Harness.io CLI, comes first on the PATH.

To move to a newer version later, run `harness upgrade` in the project's folder: it
stops the daemon, installs the latest version from npm, builds the agents' image for
it, and starts the daemon again in that terminal. The sandboxes keep running meanwhile.
When the project's CI files are an earlier version's, it stops before it starts the
daemon: run `harness install-ci`, commit what it wrote, `harness/lock.json` included,
push it to `main`, then run `harness up`. It upgrades only npm's global copy of the
harness, and fails when the copy that runs is another, such as one built from its
sources.

`harness setup` does every step it can and asks only for what is yours: a `gh` login,
the token from `claude setup-token` at a hidden prompt, two clicks on GitHub for the
App, since GitHub creates and installs Apps only in the browser, one question (AWS or
not), and, with AWS, the role ARNs from your bootstrap, the gateway key and, if you want
cost estimates, an Infracost token. It checks each answer, and the whole
`harness/config.json`, against the config's schema before it writes anything, on GitHub
or in the files, and asks again for an answer the schema refuses. In order, it logs you
in to `gh`; creates the repository on GitHub if the project has no remote; creates the
App from its manifest when this machine has none, and waits for you to install it;
writes the harness's files; asks the questions and writes `harness/config.json`, with
the `staging` environment and the variables on GitHub for AWS, the Terraform scaffold in
`iac/` that your bootstrap expects, and the cost job's Infracost token as a repository
secret; offers to commit the harness's files that git shows new or changed, and only
those, with your git, and to push them when you are on `main`, saying what else the push
sends; runs `harness doctor` and fixes what it can (starts the OpenShell gateway, builds
the agents' image, imports the Claude profile and creates the provider with your token,
gives the App the permission to write commit statuses whatever the mode, applies the
ruleset on `main`, creates the AWS provider with your key); runs the probe, unless a
check of the machine fails; and, with nothing left to fix, offers to start the daemon.
With problems left, it says which and exits 1. Run it again at any time: what is done is
skipped, and the harness's files are offered again until they are committed, as is a
setup commit that wasn't pushed. On a private repository of a free plan, where GitHub
has no rulesets, it says so and goes on.

The same by hand: `harness init` writes the harness's files into the repository, never
over existing ones, and prints the setup checklist:
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

`harness doctor --build-images` builds the agents' image, `harness doctor --probe` runs
the probe, and `harness up` starts the daemon. `harness doctor` checks each step, and
says what to do about what fails. `--probe` tries,
from a sandbox made like an agent's, with the project's labels and its APIs' keys, and
from outside, everything that must be refused: AWS writes, the value of a real secret,
other projects' state, `git push`, a POST to a read-only host, a publish to npm, unlisted
hosts and the metadata address, a workflow pushed by the App, a merge without your
approval. It also checks that the sandbox runs as a user other than root, and, with AWS,
that DynamoDB's account endpoint answers the view role. On a machine where nothing
answers at the metadata address, that check is skipped, as there is no refusal to see.

`harness init` lets the sandboxes reach every network bundle: the package registries
and documentation of each stack, read-only. To narrow it, list fewer bundles in
`harness/config.json`; to let the code call a third-party API, add it under
`network.apis` (see [Configuration](#configuration)).

## Your first module

With `harness up` running and the dashboard open:

1. **Start it.** In **Project**, give the module an id and a line about what it is for,
   and if you want, the hours of your time it may take (see **Budgets** under
   [Swarm mode](#swarm-mode)), then **Start**. An Architect starts in its own sandbox.
   From a terminal: `harness module new greeter "A greeting command-line tool"`, with
   `--owner-hours <n>` for the hours.
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
   once CI passes. Its description lists first the settings of `harness/config.json` it
   changes, with their values before and after, and the check files already on `main`
   that it changes, which the checks of built features may run. The build starts.
5. **Watch the build.** In **Agents**, each Developer's session and the Manager's are
   live transcripts. **Project** shows each feature's attempts, checks and commits.
6. **Answer what comes up.** What goes wrong, the Manager and the Architect settle
   between them. What only you can settle, such as a question from the Manager or a
   design change to merge, appears in **Needs you** with a form or buttons.
7. **Merge the plan.** When all of a plan's features are accepted and its checks pass
   again, the daemon opens one `Plan:` pull request. Merge it with a merge commit once
   CI passes. The next plan starts.

You can also write a module's design by hand, on `main`: the daemon builds whatever
plans it finds there (see [Configuration](#configuration)).

## Concepts

- **Module:** a part of the system you want to build, with one Architect and one
  accepted proposal, then its plans. Modules are built one after another, in both modes:
  the one under way is finished before the next starts, and only it has Developers,
  Managers and reviewers. They are built in the order their designs were merged; a
  design you wrote by hand comes after those, by its module's name. Every module's
  Architect stays available, so you can design the next module while one is built; its
  plans wait their turn. Size a module
  so that its design fits in one conversation. With its default model, Fable 5.2, the
  Architect's context holds up to a million tokens, and a well-sized module never fills
  it. If a module's design keeps growing, split it into smaller modules: each gets its
  own Architect, with a fresh context.
- **Proposal:** the Architect's design document, in versions v1, v2 and so on. You
  accept one.
- **Plan:** features that ship together as one pull request. A module's plans are built
  in order. A plan is `CODE`, `INFRA` or `MIXED_INFRA_AND_CODE`, from its features'
  kinds: the kind is tagged in the pull request's title, and a `CODE` plan's pull
  requests, its Fix PRs included, may not touch the Terraform folder. Give
  infrastructure plans of its own.
- **Feature:** one change that a Developer can make in one attempt, with at least one
  check. A design change can redefine it while its plan is built: an attempt under way
  stops, and the feature is built again with a fresh budget, even if it was accepted.
  When the code already does what the new definition says, its Developer may report it
  done with nothing to commit. Once its plan is past its build (every feature of it
  accepted, then its pull request and merge), nothing more is built in that plan: a new
  feature goes in a new plan, `submit_design` refuses one added to it, and one you add
  by hand pauses the pipeline with the reason. The plan's features are then **locked**.
  A wrong definition of one, such as a check that can't pass in the environment,
  changes only in a `[CHANGED_LOCKED_FILES]` pull request, which you alone merge; new
  behavior comes in a new plan, whose feature `supersedes` it: from then on its checks
  no longer run, and its definition stays as the record of what was built.
- **Check:** a shell command, run from the repository root, that exits 0 when the feature
  works. `pre-merge` checks run on every attempt and in CI; `post-deploy` checks run on
  `main` after the plan's merge, and in a project with Terraform only once CI's apply of
  that merge succeeded. Each check has an id that no other check of the project has,
  those of `harness/config.json` included.
- **Attempt:** one Developer session on one feature, in a fresh sandbox, with a deadline
  (180 minutes) and a budget (2 attempts per feature). A failed attempt's successor
  starts with the Manager's guidance. Once the budget is spent, the Manager takes the
  feature to the Architect, which grants another attempt or changes the design; in a
  module designed by hand, which has no Architect, the feature is escalated to you. An
  attempt stopped by something outside it, such as a conflict, a design change, a usage
  limit or the model's API failing, is interrupted and costs none of the budget, up to
  two interruptions of the same definition: from the third on, each counts, since the
  attempt's own sandbox writes the stream they are read from. One that finds the plan's
  branch broken before it starts never counts.
- **Owner actions:** what only you can do, such as creating an account, approving a
  policy or setting a secret. A **gate** holds back the plans or features it blocks
  until you mark it done; a **task** holds nothing back.
- **Protected files:** the design and its checks, CI, what agents read as
  instructions, and what decides what a check runs:
  - `harness/`, `.github/`, `ARCHITECTURE.md`, `init.sh` and `.npmrc`, and in any
    folder `.claude/`, `CLAUDE.md`, `CLAUDE.local.md` and `AGENTS.md`, which Claude Code
    reads wherever they are;
  - in any folder, the configs of ESLint, Prettier, Biome, Vitest, Vite, Jest, Babel,
    Playwright, Mocha, pytest and tox, with `.eslintignore`, `.prettierignore` and
    `conftest.py`;
  - what npm applies by itself as it installs: `patches/` and `.npm-extension.mjs` or
    `.cjs`;
  - fields of the files that hold much else, in any folder: package.json's `jest`,
    `babel`, `mocha`, `eslintConfig`, `eslintIgnore`, `prettier`, `overrides`,
    `patchedDependencies`, `packageExtensions`, `allowScripts`, and the scripts npm runs
    as it installs (`preinstall`, `install`, `postinstall`, `preprepare`, `prepare`,
    `postprepare`); tsconfig.json's `strict`, `noImplicitAny`, `strictNullChecks`,
    `skipLibCheck`, `exclude`, `include` and `extends`; pytest's, tox's and coverage's
    tables in `pyproject.toml`, and `[tool:pytest]` in `setup.cfg`;
  - the npm scripts that checks run, with their `pre` and `post` scripts, in the
    package.json the check's command names, as in `npm --prefix web test` or
    `cd web && npm test`;
  - what `protect` in `harness/config.json` adds (see [Configuration](#configuration)).

  A `Plan:` or `Fix:` pull request may not change them, nor add a package that the base
  branch doesn't have from outside the npm registry: in `package-lock.json`, one resolved
  from elsewhere, a link or a patched one, and without a lockfile, a `file:` or `link:`
  dependency. What the base already has keeps passing, such as a private registry or a
  workspace. CI's `verify` job, run with the base branch's rules, compares the pull
  request with where its branch started, and fails it; the daemon refuses to push such
  a branch first. What the work runs can't change them either: the checks that judge
  it, an attempt's, a plan's full run, the post-deploy checks and CI's `checks` job, run
  under a tripwire, which fails the run as `protected-files` once `init.sh` or a check
  changes, adds or removes a protected file, as a `prepare` script could. It leaves
  alone what installing fills: `node_modules`, `.terraform` and Python's virtual
  environments.
  Protected files change through an `Arch:` pull request, also judged by the base
  branch's rules, so what it newly protects counts from the next one, or your own
  commits. `harness/lock.json` holds their hashes.
- **Pull requests:** each says what it is in its title, `<Type>: [<TAG>] [<scope>] <title>`,
  and CI's `verify` holds it to that:

  | Type | Opened for | Tags | Who merges |
  |---|---|---|---|
  | `Plan:` | a plan's features, built by the Developers | `[CODE]`, `[INFRA]`, `[MIXED_INFRA_AND_CODE]`: its kind | you in Manual, the daemon in Swarm under its policy |
  | `Fix:` | a fix after a merged plan's deploy failed | `[DEPLOY_FAILED]`: the apply; `[VERIFY_FAILED]`: its post-deploy checks | you in Manual; the daemon in Swarm, under the same policy as a plan's, unless you keep Fix PRs |
  | `Arch:` | the Architect's design | `[DESIGN]`: a module's first design, once, which freezes it; `[DESIGN_MODIFY]`: every later change | you |
  | `Arch:` | built features' definitions, on `locked/<module>` | `[CHANGED_LOCKED_FILES]`: only those definitions and the module's scripts their checks run | you |
  | `Harness:`, `Owner:` | yours | none | you |

  For example `Plan: [MIXED_INFRA_AND_CODE] [shop/P3] The report Lambda`. CI's `verify`
  also fails a pull request the App opens from a branch other than `plan/`, `fix/`,
  `arch/` or `locked/`, and one whose head has more than one merge base with `main`:
  merging it would change more than its diff shows. The daemon refuses such a design
  first.

  A `[CHANGED_LOCKED_FILES]` pull request has a card of its own under **Needs you**,
  with a warning: a check that proves less can make a broken feature look like it
  works. Its changed pre-merge checks pass before it opens, and CI runs them as it
  defines them, where every other pull request runs those of `main`. It rebuilds
  nothing. Once it is merged, a plan whose post-deploy checks failed is checked again by
  itself, as it is whenever those checks change on `main`, your own commits included.
- **`progress.txt`:** one line per accepted feature and satisfied gate, committed with
  the work. It only grows. When plans in parallel both add lines, the daemon keeps both.
  Git alone can't merge such a file, nor can GitHub, which runs no CI on a pull request
  it can't merge: the daemon merges `main` into an open pull request whose branch lacks
  `main`'s lines, and pushes it.
- **Brakes:** counters and deadlines, not judgment. A Manager that leaves an item
  waiting for 180 minutes, CI still failing after two fix rounds, or a deploy still
  failing after two Fix PRs pause the pipeline until you resume it; while it is paused,
  the Manager's silence sets off no reminder and no brake. A usage limit, whichever agent
  hits it, a Developer, the Manager or a reviewer, pauses it until the limit resets, or
  for an hour when no agent said when, and never shortens a pause already there. When
  the model's API fails, overloaded or with an error, the attempt under way is
  interrupted, as above, nothing starts for ten minutes, and then the daemon looks again
  by itself. Failed attempts in a row pause nothing: each goes to the Manager, which is
  told from the third on that they add up.
- **When something goes wrong:** the Manager deals with it, the Architect decides what
  concerns the design, and you hear of it last.

  | What happens | Who handles it | What reaches you |
  |---|---|---|
  | An attempt fails | The Manager gives guidance, and the next attempt starts | Nothing |
  | A feature uses up its attempts | The Manager takes it to the Architect, which grants another attempt or changes the design | A design change to merge, if one comes. Without an Architect: the feature itself |
  | The work accepted on a plan's branch stops passing its checks | The daemon runs them once more; then the Manager has a Developer fix the branch | Nothing, unless the Manager asks you |
  | `main` conflicts with a plan's branch | The Manager says how each file must come out, and a Developer merges | Nothing, unless the Manager asks you |
  | CI fails on a plan's pull request | The Manager has a Developer fix it | After two rounds, the pipeline pauses |
  | A reviewer blocks a pull request | A Developer fixes the findings | After two rounds, that pull request waits for you, and the rest goes on |
  | A deploy fails, or its post-deploy checks do | The Manager's Fix PR, which the daemon merges in Swarm | After two Fix PRs, the pipeline pauses; each Fix PR, if you keep them |
  | A question about the design comes up | The Architect decides | The question, when the choice is yours |
  | An agent hits your subscription's usage limit | The pipeline pauses until the limit resets | The pause, which lifts itself |
  | The model's API fails | The attempt under way is interrupted, and nothing starts for ten minutes | The reason, and nothing to do |
  | GitHub or the network doesn't answer | The daemon waits ten minutes, then looks again by itself | The reason, and nothing to do |
  | The OpenShell gateway doesn't answer, or the machine rebooted | Nothing under way is interrupted or made again for it, and a stopped sandbox is started again; the daemon looks again every ten minutes | The reason, and nothing to do |

  The Manager asks you only for what you alone can do outside the design: an account,
  a credential, a host to allow.

## The dashboard

`harness up` runs the daemon in the foreground and opens the dashboard: localhost only,
behind a token. Its views:
- **Needs you:** a paused pipeline, the Architects' pull requests and proposals,
  questions from the Manager, pull requests to merge, escalations, owner actions. Each
  has its button or form. They are numbered in the order to handle them: what changes
  the design first, and gates and tasks last, since marking one done starts the work it
  held back. The daemon holds back whatever isn't ready, so most cards can't be handled
  too early. A gate can: its card shows its `when`, what it holds back, and any plan
  that work builds on that isn't complete, with a warning once that plan's deploy or
  post-deploy checks failed; marking it done while such a plan isn't complete asks you
  to confirm. An owner action's card shows the Architect's estimate of your minutes,
  when the design gives one. A pause that only waits to look again has **Look again
  now**, which looks at once and sets off nothing else a resume does.

  That order goes by the kind of each card, and can't read what the cards say. When
  some depend on others in their text only, **Ask the Manager for an order** sends a
  Manager every card, what handling each sets off, and where the plans stand. Its answer
  is advice and changes nothing else: the cards in its order, each with its reason. It
  shows while the cards are as the Manager saw them, less the ones you handled; once a
  card came or changed, the standard order is back, and you can ask again. A Manager
  whose sandbox was made before 0.5.6 has no tool to answer with: the page gives the
  command that deletes its sandbox, and the daemon starts a new one, without the old
  one's conversation.
- **Project:** modules, proposals, plans and features, with attempts, findings, CI,
  deploys and `progress.txt`. A module's badge is its design's state, `frozen` once
  merged; **module completed** joins it once every plan of the module is complete. Each
  module's card shows the hours of your time for it, with what its design plans and
  what you used, and lets you set, change or clear them; the New module form takes them
  too. And the budgets: the agents' active hours in a table by agent with each one's
  model and effort, the tokens Claude used, written and read, in a table by role, and
  your subscription's usage as bars, one per window your plan has, each with when it
  resets: a five-hour session and a weekly window, or the weekly one alone on a plan
  without a session limit. The
  Developers, the Manager and the reviewers report it with each model call, in either
  mode; the daemon keeps the last report across a restart, and a window that has reset
  since leaves the card until the next report.
- **Agents:** the Architect's terminal, the Manager's and the Developers' live
  transcripts, a message box for the Manager, and a shell in an agent's sandbox while
  the agent has one: a Developer's is gone once its work goes to its checks. The
  Architect is Claude Code itself, in a terminal; the others run without a screen, so
  the page draws their sessions. When the daemon has news for an Architect, it types
  `[harness] New messages for you.` in its terminal: at once when nobody is there, and
  when somebody is, once nobody has typed there for five minutes, trying again each
  minute. `harness attach` counts as somebody, and its opening as typing, since its keys
  don't pass through the daemon. A line about a plan, such as a pull request that opened
  or merged, waits for your next prompt instead, and without node-pty every message
  does. A Developer's transcript opens with its task, and a
  reviewer's with its brief: click the first line for the whole text. An attempt's
  card keeps the network requests its sandbox's policy refused. **Only agents with a
  sandbox**, above the list, hides the agents whose sandbox is gone, such as a stopped
  Manager, or a Developer whose work went to its checks; the browser remembers the
  choice. To copy
  from the Architect's terminal, select with the mouse: Claude Code copies the
  selection as you release the button, and `/copy` copies its last answer. Elsewhere,
  or with Shift held as you drag (Option on a Mac), the page selects, and Ctrl+C
  copies (Cmd+C on a Mac); with nothing selected, Ctrl+C still interrupts the program.
  Only the Architect's terminal may set your clipboard, within five seconds of a key
  or click of yours there, and no program can read it.
- **Sandboxes:** what runs on the OpenShell gateway. This project's sandboxes, with what
  each is for, whether anything still uses it, and the CPUs and memory it uses now,
  read from `docker stats` every five seconds. Sandboxes, and the providers that hold
  your APIs' keys, are named by the project and by its checkout, a hash of the folder's
  path, so two clones of one project on one machine share nothing: here, another clone
  counts as another project. A left-over one, which a crash or a failed delete left, has
  a button to delete it, which says done once the gateway no longer lists it; the daemon
  deletes them itself when it starts and every hour, except an Architect's. Select one
  to see the network requests its policy refused, from its log: the program, the host,
  why, and how often. Then the other projects' sandboxes, which the dashboard only
  lists, and the gateway's status. Above them, the caps on each new sandbox: how many
  CPUs and how much memory it may use, so that agents and checks in parallel leave the
  machine usable. There is no cap until you set one.
- **Events:** the event log, live, with a filter.
- **Config:** every setting the harness runs with. First, **Mode and reviews**: your
  switches, each a line with its toggle. The mode, Manual or Swarm; who merges INFRA
  and MIXED plans in Swarm, you or the daemon; who merges Fix PRs in Swarm, the daemon
  or you; the security reviews, on or off; the cost reviews, on, for infrastructure
  plans only, or off. The daemon keeps them in its
  state and records each switch: `harness/config.json` isn't written. Then all of
  `harness/config.json` on `main`, each value from the file or the default, with the
  default a value of the file replaces, and a filter. What else the daemon's state
  holds: your hours by module, the pipeline. And this machine: Node.js, Claude Code, the
  OpenShell gateway and providers, and the GitHub App. No key or token is shown.

The header pauses and resumes the pipeline: a pause lets what runs finish, and starts
nothing new. It also shows the mode, Manual or Swarm, and in Swarm who merges
infrastructure: **Config** switches both. Its last button switches between light and
dark: the browser remembers your choice, and until you make one, the dashboard follows
your system's.

An open page lives through a daemon restart: it reconnects by itself, or, once the
token has changed, asks you to open the new link. It refreshes when the design on
`main` changes, and each minute. A time that isn't today's shows its day.

**Notifications.** The bell in the header switches this browser's notifications. Once
they are on, the browser tells you when a card arrives under **Needs you** while you
look elsewhere: a question from the Manager, a pull request that waits for you, a
pause. A pause that only waits to look again, for the same reason as the last one it
told you of, stays quiet for an hour; any other pause is news. It needs the dashboard
open in a tab, in front or not, and says nothing of what already waited when the page
loaded. The tab's title counts the cards in any case.

## Swarm mode

Manual mode, the default, is what the rest of this README describes: you review and
merge every pull request. Past a certain size you become the bottleneck. Swarm mode
gives the agents more autonomy and you less to read. Its design is
`docs/architecture/proposal-v3.md` in the source repository; this section says what
exists today.

**The switch.** The dashboard's **Config** tab switches the mode; so do `harness mode
swarm` and `harness mode manual`, and both do the same. A switch takes effect at item
boundaries: what runs finishes under the rules it started with. GitHub's rules on
`main` differ per mode, and only a repository admin can change them: the App has no
administration permission, on purpose. So the switch applies the mode's ruleset with
your own `gh`, which the daemon runs on your machine: Swarm's rules before the daemon
enters Swarm, Manual's once it has left, so it never merges under the other mode's
rules. If your `gh` isn't logged in as an admin, the switch still happens and says why
the rules didn't change; `harness github-setup --repo <org>/<repo>` applies them once
it is. With the daemon down, `harness mode` applies them, and the daemon switches when
it starts; meanwhile `harness doctor` and `harness github-setup` judge and apply the
rules of the mode it will start in. Until the rules match nothing merges. The daemon
reads the rules in effect on `main` through the App and the dashboard's note lists what
is still to do, the commands ready to copy: the rules, and the App's "Commit statuses:
write". While a step is left, the daemon checks again every 30 seconds, so the note
goes soon after the last one; `harness doctor` checks the same. `harness setup`
prepares the App's permission in either mode, so a switch to Swarm needs only its
rules.

**What merges itself.** In Swarm the daemon merges a plan's pull request, as the App,
once CI passed and every status in `swarm.requiredStatuses` is green on its head:
- a `CODE` plan, when `swarm.merge.code` is `daemon`;
- an `INFRA` or `MIXED_INFRA_AND_CODE` plan, when the monthly cost it adds, estimated by CI, is at or
  under `swarm.merge.infraMonthlyUsdCeiling`; or, once **Infra merges** is switched to
  the daemon's under **Config**, like a `CODE` plan, once CI and the reviewers pass, an
  estimate over the ceiling still waiting for you. The switch starts on yours, and the
  choice is recorded in the event log.

A pull request whose head changes the Terraform folder never merges as `CODE`, whatever
its plan's kind: it is held to the ceiling like infrastructure. Only an estimate of the
pull request's current head counts: after a fix round, the new head needs its own.
While the `cost` job still runs, the daemon waits for its estimate, rather than merging
or leaving the pull request to you. Before it merges, the daemon merges `main` into the
pull request's branch if `main` moved since CI ran, so CI and the reviewers judge what
`main` gets; a conflict goes to the Manager, as described under **Conflicts with
`main`**.

Anything else waits for you, under **Needs you** with the reason. `Arch:` pull requests
are yours in both modes. A `Fix:` pull request, which the Manager has a Developer write
after a failed deploy, merges under the same policy as its plan's, reviewers included,
and the deploy then runs again without you. Switch **Fix PR merges** to yours under
**Config** to keep them: the switch starts on the daemon's. In Swarm, GitHub's rules
need no approval but require the reviewers' statuses, pinned to the App, so even the
daemon can't merge before they pass. The reviewers read the pull requests the daemon
merges: it gives an `Arch:` pull request, and a `Fix:` one you keep, the two statuses
as "not reviewed", so you merge it without bypassing the rules, and CI still gates it.

**Before a launch.** In Swarm the daemon checks your subscription's usage before it
starts an attempt, and at or above `swarm.usageCeilingPercent` the pipeline waits for
the window to reset. The agents report the usage: each model call comes back with your
plan's windows, the five-hour session and the weekly one, or the weekly one alone,
which Claude Code writes into the stream the daemon reads, so no token of the daemon's
own is needed. After a restart, the daemon reads the agents' streams again from their
start, and takes no report from what they held before. A `claude setup-token` token couldn't read it
anyway: it may only run models. Before the first report, the daemon learns of a limit
only when an agent hits it, as in Manual.

**The reviewers.** Once CI passed on a plan's pull request, two reviewers read it, one
after the other, each in a fresh sandbox, read-only like the Manager's, without AWS
access, where nothing of the pull request runs: a security reviewer and a cost
reviewer, with `roles/security.md` and `roles/cost.md` as their prompts and the
Manager's model, within `swarm.reviewTimeoutMinutes`. Each gets a brief: the plan's
features, the files changed, the pay-per-use AWS calls the change adds or removes,
found by pattern in the code, with the code the patterns didn't scan, such as a line
over 2,000 characters, and, when the project has Terraform, the plan's JSON from CI's
`tfplan` artifact of that head, up to 20 MB. Each answers with a verdict and findings.
The daemon posts the findings on the pull request as a review, with comments on the
lines of the diff, and sets the reviewer's commit status, `harness/security` or
`harness/cost`. A blocking verdict opens a fix round on the plan branch, like a CI
failure: a Developer fixes with the findings as guidance, the Manager reviews, CI and
the reviewers run again on the new head. A blocking finding blocks, whatever the verdict
says. After `swarm.securityFixRounds` or `swarm.costFixRounds`, the pull request is
yours, and the rest of the pipeline goes on. In Manual, `swarm.reviewersInManual` runs
them as comments and statuses that gate nothing.

Each reviewer has a switch under **Config**. Off, it reads nothing; the cost reviewer
can also be kept for `INFRA` and `MIXED_INFRA_AND_CODE` plans, since a `CODE` plan
seldom changes what a project costs. In Swarm, GitHub's rules and the merge policy
still require the status of a reviewer that didn't read a pull request, so the daemon
sets it as passed and says why: "not reviewed: the owner switched security reviews
off". The plan then merges on CI and whatever review is left, and on CI alone with
both off. A session of a reviewer switched off stops, and a pull request it blocked is
released. Switched on again, it reads the open pull requests it hasn't read, and a
verdict it gave a head stands. The cost job's estimate in CI and its ceiling don't
depend on the cost reviewer. A switch narrows what `swarm.requiredStatuses` and
`swarm.reviewersInManual` run, and never widens it.

The App needs **Commit statuses: write** for the verdicts. An App created before this
version has read only: `harness setup` opens the App's permissions page, in either mode,
and waits until you have given it the permission and accepted it on the installation;
`harness doctor` warns until then. Until then, a plan whose reviewer passed waits for
you with the reason.

**Parallel Developers.** In Swarm, up to `swarm.maxDevelopers` Developers build the
features of the plan under way at once, each in its own sandbox, as soon as the
features they depend on are accepted: `dependsOn` in the design decides, so the
Architect is told to declare every dependency. Each attempt starts from the plan
branch as it is. When another feature lands first, the daemon merges the new head
into the attempt before its checks, so they see the accepted work, and the feature
lands as one commit on the head. A conflict interrupts the attempt, which counts only as
interruptions do (see **Attempt** under [Concepts](#concepts)), and the next one starts
from the new head. In both modes, a design change merged while a feature is built
interrupts its attempt the same way, and the next one builds the new definition. Manual
mode builds one feature at a time, as before. In both modes, the Architect hears in one
line when a plan's pull request opens, waits for you, is blocked by a reviewer, or
merges.

**Parallel plans.** A plan may declare `dependsOn`, the plans of its module that must
be merged before it starts; without it, it waits for the previous plan, as always. In
Swarm, up to `swarm.maxPlans` plans of the module under way whose dependencies are
merged build at once, each on its own branch. One Manager has the whole module, in both
modes: it reviews every plan's features, so that what happens between two plans, such
as a conflict, has one agent that knows both sides and can act on both. When a plan
merges, `main` is merged into the others, `progress.txt` keeping both sides' lines. A
feature may also depend on a feature of an earlier plan, as `P1/F03`, and then waits
for that plan's merge. The Project view draws each module's features as trees, one per
plan: a feature hangs from the feature it waits for, the end of the longest chain when it
waits for several, and the others, an earlier plan's included, are named beside it. Green
is accepted, blue under way, amber waiting for a decision, red escalated, grey not started;
hover a feature for where it stands. Manual mode builds one plan at a time.

**Conflicts with `main`.** `main` moves while a plan is built or its pull request is open:
another plan merges, or a design change does. Git merges it into the plan's branch when
the two sides changed different lines. When they changed the same lines, the Manager
resolves it, in both modes, and you are not asked:
- Nothing new starts in the plan, and its pull request, which GitHub can't merge and
  runs no CI on, shows no card under **Needs you**. The Project view says which files
  conflict.
- The Manager gets the files with both sides in its clone, and says how each must come
  out. When the two plans ask for contradictory things, it asks the Architect instead.
- A Developer merges `main` in a fresh sandbox, following that. The daemon runs the
  checks of everything accepted on both sides on the result, and refuses a result that
  leaves `main` out, keeps a conflict marker, or holds a protected file otherwise than
  `main` does.
- The Manager reviews the merge like a feature. Accepted, it lands as one merge commit;
  on an open pull request it is pushed, and CI and the reviewers run again.

A merge that uses up its attempts goes the way of a feature that does: the Manager takes
it to the Architect. The Architect hears of each conflict in one line, as plans meant to
build together should stay off the same files.

**Checks that stop passing.** Git can merge `main` into a plan's branch without a
conflict and still break what the plan built, and two features can each pass alone and
fail together. The checks of accepted work run before every attempt, and all together
once a plan's features are accepted. When they fail on the branch:
- The daemon runs them a second time on the same commit. A registry that didn't answer,
  or a check that flakes, ends there, and nobody is asked.
- Failed twice, they go to the Manager with their output. Nothing new starts in that
  plan; its attempts under way finish, and the module's other plans go on.
- The Manager says what breaks and where, and a Developer fixes the branch in a round of
  its own, which the Manager reviews like a feature. The plan then goes on, and the full
  run comes again once every feature is accepted.
- A check that is itself wrong goes to the Architect, and a cause outside the code to
  you, as a question: the checks run again once the design change reaches the branch,
  or once you answer.
- An attempt doesn't pay for a broken branch: one that finds it broken before it starts
  is interrupted and never counts, and one whose checks fail after the branch's head
  moved under it, while the branch fails by itself, is interrupted and counts only as
  interruptions do.

**When GitHub doesn't answer.** A plan's step that keeps failing, such as a push GitHub
refuses, or a pull request on which no CI has run for ten minutes, makes the daemon wait
ten minutes and look again by itself, for as long as it lasts. **Needs you** says why
and since when, and you have nothing to lift: if the cause is yours, such as a workflow
missing on `main`, fix it, and the next look goes on. **Look again now** on the card
looks at once. The daemon does the same while the OpenShell gateway doesn't answer,
with nothing under way interrupted or made again for it, and after the model's API
failed.

**The cost job.** `harness install-ci` adds a `cost` job to the workflow: on a pull
request that has `iac/`, it runs [Infracost](https://www.infracost.io) on the base and
the head and uploads the estimate as the `cost` artifact, which the daemon reads once
CI passed and the `cost` job itself succeeded, and only from that job's own run, made
before the job ended: the run's later jobs execute the pull request's code. An Infracost
project with errors gives no estimate. It needs the repository secret
`INFRACOST_API_KEY`: a free token from your Infracost organization's Settings, CLI tokens,
on [dashboard.infracost.io](https://dashboard.infracost.io). `harness setup` asks for it
once the project has Terraform, and gives it to `gh secret set`; the doctor says whether
it is set. Infracost's current CLI, 2.x, logs in through the browser and stores no key,
and the job runs its own pinned 0.10.47, so you don't need the CLI. Without the secret the
job does nothing, no estimate exists, and `INFRA` and `MIXED_INFRA_AND_CODE` plans wait for you with that
reason. Infracost sees your Terraform's resource types and sizes, not your code or state,
and prices fixed resources only: pay-per-use charges count as zero. Its numbers are
estimates at AWS's list prices, which change. The cost reviewer gets the estimate in its
brief. The job is not a required check. It was checked on a real repository with such a
token: Infracost estimated a KMS key at 1 USD a month, at AWS's prices then, and the
daemon read the estimate.

**Where it stands.** The scanners in CI that the security reviewer would start from,
gitleaks, semgrep and checkov, are still to come (proposal v3 §5.5): the reviewer reads
the diff itself.

**Budgets.** In both modes, the Project view shows your time, on each module's card,
the agents' active hours, and Claude's tokens:
- **Your time.** The hours a module may take of you, which you set as it starts, on
  its card, or with `harness budget --module <id> --owner-hours <n>`. They are the
  module's own: no other module draws on them, and a module without hours is designed
  with no limit on your time. Once set, every owner action of the module's design, gate
  or task, carries the Architect's estimate of how long it takes you, a reserve of
  `ownerTime.reservePercent` stays out of what the design may plan, and `submit_design`
  refuses a design whose actions don't fit. An action you did that a redesign dropped
  still counts. Only owner actions count: the proposals and pull requests you read
  don't. The Architect reads the numbers with `get_owner_time`, and is told when you set
  or clear them. The module's meter shows used, planned and the hours, red when over.
- **Active hours.** The hours the agents worked, in a table by agent with the model and
  effort `harness/config.json` sets: each Developer's attempt and each reviewer's
  session, from its start to its end, and the time a Manager or an Architect spends on
  its prompts, from each prompt to its last step, which the daemon reads in its sandbox
  every five minutes. They live for their module, and wait far more than they work.
- **Claude tokens.** What Claude read and wrote, by role: what was read, how much of it
  the prompt cache served, and the cache's share. Every call reads the whole
  conversation again, mostly from the cache, which the API bills at a small share of a
  fresh read: at Anthropic's prices of November 2026, which change, a twentieth on Opus
  5.5, a fortieth on Fable 5.2 and a tenth on Haiku 4.5.

## Commands

Run them in the project's folder, or add `--dir <project>`. `harness --help` lists them
too. A command that acts on a project fails in a folder without `harness/config.json`,
and creates nothing there; a flag the command doesn't take is refused, not ignored.

| Command | What it does |
|---|---|
| `harness init` | Writes the harness's files into the repository, and prints the setup checklist |
| `harness doctor [--build-images] [--probe]` | Checks the machine and the project, builds the agents' image, and tries what agents must not do |
| `harness github-app create --org <org>` | Creates the harness's GitHub App, once per machine |
| `harness github-app check --repo <org>/<repo>` | Checks that the App can reach the repository |
| `harness github-setup --repo <org>/<repo> [--mode manual\|swarm]` | Sets merge commits only, and the ruleset on `main` for the daemon's mode, with your own `gh` |
| `harness budget --module <id> --owner-hours <n>\|--clear` | Sets the hours of your time for one module, or clears them; with the daemon down, it records them for when it starts |
| `harness setup [--repo <owner/name>] [--owner <login>]` | Sets up this machine and the project, asking only for what is yours; run it again any time. Exits 1 while problems are left |
| `harness install-ci [--owner <login>]` | Writes the workflow, its CI script and the script's `package.json` again, `CODEOWNERS` only when there is none, and `harness/lock.json`; commit them and push them to `main` yourself, after an upgrade |
| `harness lock` | Writes `harness/lock.json`, the hashes of the protected files and fields |
| `harness up`, `harness down` | Starts the daemon and the dashboard, or stops the daemon, even one still starting; sandboxes keep running. `up` refuses a project without `project.repo`, and a `.harness/` without its event log while `main` has accepted features (run `harness recover`). `down` waits up to 15 seconds, and exits 1 if the daemon still runs |
| `harness upgrade [<version>]` | Installs the latest harness from npm, or the version named, builds the agents' image for it, and starts the project's daemon again in this terminal if one was running, unless the project's CI files are an earlier version's |
| `harness status` | Plans, features, modules and open questions, in the terminal |
| `harness module new <id> <title> [--owner-hours <n>]` | Starts a module and its Architect, with the hours of your time for it if given |
| `harness attach <module>` | Opens the Architect's terminal here; detach with Ctrl-P, then Ctrl-Q. While you are attached, the daemon types a nudge there no sooner than five minutes after you attached. Exits with openshell's code |
| `harness accept <module> <vN>` | Accepts the Architect's proposal vN |
| `harness actions`, `harness done <module>/<id>` | Lists the owner actions, or marks one done |
| `harness answer <request-id> <text>` | Answers a question from the Manager |
| `harness message <text>` | Writes to the Manager of the module being built |
| `harness retry <module>/<plan>/<feature>` | Gives an escalated feature one more attempt; `--note` adds guidance |
| `harness resume` | Lifts a pause |
| `harness mode [manual\|swarm]` | Shows the mode, or switches it as the dashboard's switch does, with `main`'s rules applied through your own `gh`; with the daemon down, it applies the rules and records the switch for when it starts |
| `harness recover` | Rebuilds a lost `.harness/` from GitHub's `main` and branches, and lists what it can't: the mode, each module's hours, the switches under **Config**, the owner tasks done. A plan whose pull request was closed is recorded as such: reopen the pull request, and the daemon goes on from its branch. It names an Architect's pull request that was open, and refuses a `.harness/` that has a snapshot or the git mirror but no event log: move it away first |

## Configuration

`harness/config.json` holds the project's settings. It is a protected file: it changes
through an `Arch:` pull request, or a commit of your own on `main`.

```json
{
  "harnessVersion": "0.7.0",
  "project": { "name": "shop", "repo": "<org>/shop", "bot": "<org>-harness[bot]" },
  "roles": {
    "architect": { "model": "claude-fable-5-2", "effort": "max" },
    "manager": { "model": "claude-opus-5-5", "effort": "max" },
    "developer": { "model": "claude-opus-5-5", "effort": "max", "attemptTimeoutMinutes": 90, "maxAttempts": 2 }
  },
  "network": { "bundles": ["all"], "apis": [{ "host": "api.stripe.com", "key": "STRIPE_API_KEY" }] },
  "checks": [{ "id": "unit", "run": "npm test", "phase": "pre-merge" }]
}
```

| Field | Default | What it sets |
|---|---|---|
| `harnessVersion` | none | The version of the harness that wrote the file, which `init` sets: a record for you, which nothing reads |
| `project.name` | the folder's name, from `init` | Names the sandboxes and the dashboard |
| `project.repo`, `project.bot` | none | The GitHub repository, and the App's bot login, set together; `harness setup` sets them. Required: `harness up` refuses a project without them, and `harness doctor` fails on it |
| `roles.<role>.model` | `claude-fable-5-2` for the Architect, `claude-opus-5-5` for the Manager and the Developers | The role's model. The reviewers run on the Manager's model and effort. |
| `roles.<role>.effort` | `max` | Claude Code's `--effort`; `null` for a model without effort levels, such as Haiku |
| `roles.developer.attemptTimeoutMinutes` | 180 | An attempt's deadline |
| `roles.developer.maxAttempts` | 2 | Attempts per feature before its Manager takes it to the Architect, or to you in a module without one |
| `network.bundles` | `["all"]` | The hosts sandboxes reach directly, read-only, by bundle: `core`, `node`, `python`, `aws`, `terraform`, `go`, `rust`, `jvm`, `opentofu`, `browsers`, or `all` for every one, those later versions add included. The Architect gets them all. |
| `network.extraHosts` | `[]` | More hosts, read-only, as lowercase host names of two labels or more, like `docs.example.com`, with `*.` or `**.` allowed only in front, like `**.example.com`; no address, no port. A bad entry is refused when the config is read |
| `network.apis` | `[]` | Third-party APIs the code may call with any method, like a payment provider's test API: `{ "host": "api.stripe.com" }`, with `"key": "STRIPE_API_KEY"` for one that needs a key. A git host, such as github.com, can't be one. `harness doctor` asks for the key at a hidden prompt and stores it in OpenShell, in a provider of this checkout's; in a sandbox the variable holds a placeholder, which OpenShell replaces with the key on requests to that host alone, in headers and URLs, not in request bodies. CI gets no key. |
| `checks` | `[]` | Checks that every feature must keep passing, such as `npm run lint`: commands from the repository root, never a `/sandbox/` path, each with an id no other check of the project has |
| `protect.files`, `protect.jsonFields`, `protect.tomlTables` | none | More protected files, as paths or globs (`scripts/*.sh`, `docs/`, `**/Makefile`); protected JSON fields by file or glob, like `{"tsconfig.json": ["/compilerOptions/strict"]}`; and protected TOML tables or INI sections by file or glob, like `{"pyproject.toml": ["tool.mypy"]}` |
| `sandbox.image` | `razzou-harness/agent:<version>` | The agents' image, tagged with the harness's version, which `harness doctor --build-images` builds |
| `sandbox.claudeProvider` | `claude-sub` | The OpenShell provider that holds your Claude token |
| `sandbox.env` | `{}` | Environment variables for every sandbox |
| `github.requiredChecks` | `["verify", "checks"]` | The CI jobs a pull request must pass; `tf-plan` is added with Terraform |
| `github.applyJob` | `tf-apply` | The CI job that applies Terraform on `main`, which the daemon waits for after every merge |
| `brakes.consecutiveFailures` | 3 | Failed attempts in a row from which the Manager is told that they add up; nothing pauses |
| `brakes.managerTurnMinutes` | 90 | How long an item waits for the Manager before a reminder; as long again, and the pipeline pauses. Neither happens while the pipeline is paused |
| `brakes.ciFixRounds`, `brakes.deployFixRounds` | 2, 2 | Fix rounds after CI fails, and `Fix:` pull requests after a deploy fails |
| `ownerTime.reservePercent` | 20 | The share of a module's hours its design may not plan for owner actions |
| `swarm.merge.code` | `daemon` | Who merges a `CODE` plan in Swarm: `daemon`, or `owner` |
| `swarm.merge.infraMonthlyUsdCeiling` | 50 | The monthly cost an `INFRA` or `MIXED_INFRA_AND_CODE` plan may add and still merge itself in Swarm; `null` leaves them all to you |
| `swarm.requiredStatuses` | `["harness/security", "harness/cost"]` | The App's statuses a pull request needs before the daemon merges it; `[]` merges on CI alone |
| `swarm.maxDevelopers`, `swarm.maxPlans` | 3, 2 | Attempts and plans at once in Swarm |
| `swarm.usageCeilingPercent` | 80 | No launch in Swarm at or above this share of your subscription's limits; `null` turns the probe off |
| `swarm.securityFixRounds`, `swarm.costFixRounds` | 2, 2 | Fix rounds a reviewer may ask for, before you decide |
| `swarm.reviewTimeoutMinutes` | 30 | A reviewer's deadline |
| `swarm.reviewersInManual` | `false` | Run the reviewers in Manual too, as comments only |
| `dashboard.port` | 4777 | The dashboard's port, or the next free one |
| `aws`, `terraform` | none | See [AWS and Terraform](#aws-and-terraform). `terraform`'s three paths take one value each, the one the CI workflow uses: `dir` is `iac`, `backendConfig` is `backend-configs/staging.hcl`, and `varFile` is `env/staging.tfvars`; any other is refused when the config is read |

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
  the same plan, or of an earlier plan as `P1/F03`), `supersedes` (see **Feature** under
  [Concepts](#concepts)), `gates`, and `resources` (where the Developer should look). A
  feature's id can't be `fix1`, `fix2` and so on: those name a plan's fix rounds.
- **Checks** have an `id` that no other check of the project has, `run` (a shell
  command from the repository root, never a `/sandbox/` path), `phase` (`pre-merge` or
  `post-deploy`), `timeoutSec` (600 by default), and `needs`: `tfplan` to get a
  Terraform plan's JSON in `$HARNESS_PLAN_JSON`, `aws` to use the read-only AWS role.
- **Owner actions** look like this, and a `verify` command, if set, runs in a fresh
  sandbox before the action counts as done:

  ```json
  [{ "id": "G1", "kind": "gate", "title": "Approve the retention policy", "when": "before P2",
     "blocks": ["P2"], "instructions": "Markdown for you.", "verify": null }]
  ```

  `when` is a sentence for you, which the daemon doesn't check: once a gate is done, the
  work it held back starts as soon as the plans it depends on are merged.

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

**Then, in the project** (`harness setup` does steps 1 to 3 when you answer its AWS
questions):
1. In `harness/config.json`, add `aws` and `terraform`:

   ```json
   "aws": { "region": "us-east-1", "provider": "aws-view-<org>-shop", "services": ["all"] },
   "terraform": { "dir": "iac", "backendConfig": "backend-configs/staging.hcl", "varFile": "env/staging.tfvars" }
   ```

   `services` lists the AWS services whose endpoints the sandboxes reach, signed with
   the view role. `all`, the default, is every service the AWS SDK knows, so the view
   role alone decides what agents read; a list of names narrows it. Every service but S3
   is signed with the hash of the request's body, empty for a `GET`: OpenShell's
   automatic mode signs a bodiless `GET` in a way only S3 accepts
   ([NVIDIA/OpenShell#5375](https://github.com/NVIDIA/OpenShell/issues/5375)). With
   `all`, or with `dynamodb` listed, the account's own DynamoDB endpoint,
   `<account>.ddb.<region>.amazonaws.com`, which SDKs and Terraform call by default, is
   signed too; the sandboxes also get `AWS_ACCOUNT_ID_ENDPOINT_MODE=disabled`, so the SDKs
   in them call DynamoDB's regional endpoint. The `terraform` paths are the ones the CI
   workflow uses, and the config is refused with any other. `harness github-setup` then
   requires `tf-plan` as well.

   In `iac/`, the Terraform scaffold: a partial `backend "s3" {}` block in `backend.tf`,
   the backend config with the state bucket, the project's key, the region and
   `use_lockfile = true`, the variables file, and what those feed: the required
   provider, the variables and the AWS provider. `harness setup` writes whatever of it is
   missing, from the variables your bootstrap set on GitHub, and never a block that a
   `.tf` file of the folder declares already. Without a `backend "s3"` block, CI's
   `terraform init` keeps the state on its runner, and what the apply created is lost
   with it: `harness doctor` fails until a `.tf` file in `iac/` has one. Its backend
   config sets no encryption, so the bucket's default, your KMS key, applies:
   `encrypt = true` without `kms_key_id` would replace it with SSE-S3.
2. Set the repository variables the workflow reads: `AWS_REGION_STAGING`,
   `AWS_ROLE_PLAN_ARN_STAGING` and `AWS_ROLE_APPLY_ARN_STAGING`.
3. `harness doctor` creates the OpenShell AWS provider: it asks for the view role's ARN,
   and for the gateway user's key at a hidden prompt. Only OpenShell holds the key.
4. `harness doctor --probe` checks the result: AWS must answer as the view role, at
   DynamoDB's account endpoint too, and refuse a write, a real secret's value and
   another project's state.

A check with `"needs": ["tfplan"]` finds the plan's JSON in `$HARNESS_PLAN_JSON`. A
`post-deploy` check with `"needs": ["aws"]` runs after the apply, as the read-only role.
Once `iac/` exists, CI applies `main` after every merge, whatever the merge changed,
and the daemon waits for that apply (`github.applyJob`) before the post-deploy checks
run: code that Terraform packages deploys with it. An apply that was skipped never
started: the Manager gets the jobs it waited for that failed, with their logs. In CI,
`tf-plan` runs only once `verify` passed, takes no state lock, and keeps the plan, which
holds the state's values, one day; `checks` always starts, and fails when `tf-plan` did;
the apply waits up to ten minutes for the state lock.

Agents can read the Terraform state, so keep secrets out of it: Terraform creates a
secret, but you or a rotation set its value; a database manages its own password (for
RDS, `manage_master_user_password`); anything else uses write-only arguments.

## Security

What agents can't do, and what stops them:
- **Hold credentials.** Sandboxes hold placeholders. The OpenShell proxy adds the Claude
  token on `api.anthropic.com` only, each key of `network.apis` on its API's host only,
  and signs AWS requests with the read-only role.
- **Reach the host.** Each agent runs in its own container, with no host folder mounted;
  code moves in and out as git bundles. The host never runs code or git hooks that an
  agent wrote.
- **Write to GitHub.** Only the daemon talks to GitHub, as an App with no access to
  workflows or settings. Sandboxes may clone and fetch, with a POST only to a
  repository's `git-upload-pack`, and never push; a git host can't be listed in
  `network.apis`, which would open it to every method. In Swarm mode the daemon also
  merges plans, under the policy above, and GitHub requires the reviewers' statuses,
  pinned to the App, before it can. What the daemon posts of an agent's text, pull
  request titles and descriptions and review comments, mentions nobody: an `@` outside
  code gets a zero-width space after it.
- **Change the rules.** Checks, CI and the agents' instructions are protected files: a
  Developer's work can't change them, and CI checks that with the base branch's rules.
  Nor can what the work runs, as the checks that judge it run under a tripwire (see
  **Protected files** under [Concepts](#concepts)). They change only through an Arch PR
  you merge, or your own commits. A reviewer's verdict is read from files of its own
  sandbox, so nothing of the pull request it reads runs there.
- **Change AWS.** A read-only role with explicit denies, and applies only in CI after
  your merge.
- **Go anywhere online.** Sandboxes reach listed hosts, read-only, and the APIs in
  `network.apis` with any method; OpenShell has no rule for every host, and
  `network.extraHosts` takes host names only, no address or port. Other pages go
  through `web_read`: a URL of at most 2,000 characters, GET only, public addresses
  only, never this machine's own addresses or the networks it is on, nor Azure's host
  endpoint (IPv6 included, and IPv4 written as IPv6), checked again after every
  redirect, within 75 seconds and 2 MB, decompressed. A sandbox's tool calls, `web_read`
  included, are handled two at a time, and those over 60 a minute are refused.
- **Stop the dashboard, or act through it.** Markdown an agent writes keeps only the
  tags Markdown makes, with no classes, styles or SVG, so it can't cover the page or
  pass clicks to its buttons. Nothing a client sends or an agent writes stops the
  dashboard.
- **Decide alone.** Code runs the loop: deadlines, attempt budgets, checks in fresh
  sandboxes and the merges, yours or the Swarm policy's, are enforced by the daemon,
  not left to the agents.

What remains possible, by design:
- an agent could send code out in the URL of an allowed GET request;
- the read-only role shows infrastructure metadata, S3 object names and Lambda
  environment variables: keep user identifiers out of object names, and secrets out of
  Lambda environment variables;
- the Architect writes the checks: review Arch PRs. Checks that pass before anything is
  built are flagged in them, and each lists first the settings and the check files
  already on `main` that it changes.

`harness doctor --probe` tries, from sandboxes set up like the agents', what must be
refused. Run it after setup, and after upgrading the harness, OpenShell or Claude Code.
To report a vulnerability, see `SECURITY.md` in the source repository.

## Usage and costs

- The agents run on your Claude subscription, so their usage counts against your plan's
  limits. When Claude Code reports that a limit is reached, whichever agent hit it, a
  Developer, the Manager or a reviewer, the pipeline pauses until a minute past the
  reset, then goes on by itself, and an attempt it cut short is interrupted, which counts
  only from the third interruption of its feature's definition. The reset comes from the
  agents' last usage report, or from an older Claude Code's message; without either, the
  pause lasts an hour. When the model's API fails instead, overloaded or with an error,
  the attempt is interrupted the same way, nothing starts for ten minutes, and then the
  daemon looks again by itself. In Swarm mode the daemon also checks the usage the
  agents last reported before each launch, and waits at or above
  `swarm.usageCeilingPercent` until a minute past the window's reset; the Project view
  shows the windows. Nothing has to run to learn of the reset: each report says when
  every window resets. The times are Unix times, so your timezone doesn't matter; the
  minute covers a clock a little ahead. While paused, agents already running finish,
  and their results count at once.
- By default, the Architect runs Fable 5.2, the most capable model, and the Manager,
  the reviewers and the Developers run Opus 5.5, all at the highest effort, `max`. At
  Anthropic's API prices of November 2026, which change, Fable 5.2 costs twice as much as
  Opus 5.5 per token, so the Architect's sessions use your plan fastest. To try the
  harness, or to use less of your plan, set each role's `model` to Haiku 4.5
  (`claude-haiku-4-5-20251001`) and its `effort` to `null`.
- With Haiku 4.5 in our test runs, a Developer attempt took under 90 seconds and 17 to
  23 turns: 150,000 to 310,000 input tokens, mostly read from the cache, and 2,000 to
  6,000 output tokens. Claude Code estimated $0.08 to $0.12 per attempt at the API
  prices of the time; an estimate, which changes with the prices. The Architect and the
  Manager use more, over their long sessions.
- The dashboard shows each session's model calls, tokens and Claude Code's cost
  estimate, at API prices.

## Troubleshooting

`harness doctor` names what fails and what to do. The usual cases:

| `harness doctor` says | What to do |
|---|---|
| `Docker: … permission denied` | Add yourself to the `docker` group, then log in again |
| `Tailscale: an exit node is active`, or `container network` fails | An exit node can cut the containers' network: turn it off |
| `OpenShell: not found`, or `… pinned to 0.1.7` | Install OpenShell 0.1.7, from its Debian package; the checks that need it fail until then |
| `OpenShell gateway` fails | `systemctl --user start openshell-gateway`: the gateway is a systemd user service |
| `image: … has Claude Code X, this machine Y` | `harness doctor --build-images`, after each Claude Code update |
| `terminals: node-pty is missing` | Install `python3`, `make` and `g++`, then reinstall with `--allow-scripts=node-pty`. `harness attach` works meanwhile. |
| `Claude provider: … is missing` | `claude setup-token`, then `harness doctor` in a terminal: it asks for the token |
| `GitHub: no project.repo` | `harness setup`: it creates the repository, and sets `project.repo` and `project.bot` |
| `GitHub App: … 404` | Install the App on the repository, from the link `harness github-app create` printed, or the organization's settings |
| `GitHub App: harness/config.json says the bot is …, but the App on this machine is …` | Set `project.bot` to this machine's App and run `harness lock`, or run the harness on the machine of the App the config names |
| `ruleset: …` fails | `harness github-setup --repo <org>/<repo>`. A private repository needs a paid GitHub plan for rulesets. |
| `ruleset: applies to the default branch, master, not to main` | Make `main` the repository's default branch on GitHub, then `harness github-setup --repo <org>/<repo>` |
| `.github/… differs from this version of the harness` | `harness install-ci`, then commit the files it wrote, `harness/lock.json` included, and push them to `main` yourself |
| `main: … doesn't hold …` | Commit those files on `main` and push it, which `harness setup` offers: the daemon reads the config from `main`, and CI runs the workflow `main` has |
| `Terraform: no .tf file in iac/ has a backend "s3" block` | `harness setup` writes one in `iac/backend.tf`, or add `terraform { backend "s3" {} }` in a `.tf` file of its own |

While the daemon runs:
- **The pipeline is paused.** **Needs you** says why: a Manager that didn't act, CI
  still failing after its fix rounds, a deploy still failing after its Fix PRs, a usage
  limit, an invalid design on `main`, or a broken environment. Fix the cause, then
  **Resume**. On resume, checks that failed run again and a failed deploy is looked at
  again: a later successful apply on `main` counts. A pause that says when the daemon
  looks again lifts by itself: GitHub, the network or the OpenShell gateway didn't
  answer, or the model's API failed. **Look again now** looks at once, and sets off
  nothing else.
- **A reviewer keeps blocking a pull request.** After its fix rounds, the pull request
  waits for you under **Needs you**, with what you can do, and the rest of the pipeline
  goes on.
- **CI fails for a reason outside the code.** Fix it (a secret, the runner), then re-run
  the jobs on GitHub: a passing re-run counts. To fix the code yourself, push to the pull
  request's branch, or resolve a conflict in GitHub's editor: the daemon builds on your
  push, and CI runs again.
- **A feature is escalated.** It used its attempts, and its Manager takes it to the
  Architect: the Project view says so on the feature, and **Needs you** shows the
  question to the Architect, which you can weigh in on at its terminal. `harness retry`
  gives it one more attempt yourself. In a module designed by hand, with no Architect,
  the feature has a card under **Needs you**: give it one more attempt with your
  guidance, or pause.
- **The dashboard asks for its token.** Each `harness up` prints a new link, in its
  terminal only: open that one. `.harness/logs/daemon.log` has the address without the
  token. A page already open asks for the new link by itself. Each project's dashboard
  keeps its own cookie, named after its port, so several can be open at once. The
  browser it opens by itself logs in with a code that works once, for two minutes, so
  the token never shows on a command line.
- **A merge takes minutes to show up.** The daemon polls GitHub: every minute, then every
  five once nothing has changed for ten minutes.
- **`harness up` refuses to start.** Without `project.repo` in `harness/config.json`,
  run `harness setup`. With a `.harness/` that has no event log while `main`'s
  `progress.txt` has accepted features, `.harness/` was lost: `harness recover` rebuilds
  it from git and GitHub.
- **`harness upgrade` stopped before starting the daemon.** The doctor it runs listed a
  problem: fix it, run `harness doctor --build-images` again, then `harness up`. Or the
  project's CI files are an earlier version's, which a `.github/…` file the doctor finds
  missing shows too: run `harness install-ci`, commit what it wrote, `harness/lock.json`
  included, push it to `main`, then run `harness up`.
- **Closing the terminal stopped the daemon.** It stops cleanly, as with `harness down`.
  Run `harness up` again: it picks up from its event log, and the agents kept working
  meanwhile. An error that nothing caught doesn't stop it: it writes the stack in
  `.harness/logs/daemon.log` and goes on. A daemon that crashed leaves
  `.harness/daemon.json` and `.harness/daemon.lock` behind: the next `harness up` sees
  that their process is gone.

## Development

```sh
npm install
npm test            # unit tests and the daemon end to end, with a local stand-in for OpenShell
npm run typecheck   # the daemon and the dashboard
npm run build       # dist/: the daemon, and the dashboard in dist/web
npm pack            # a package of these sources: npm install -g ./razzou-harness-<version>.tgz --allow-scripts=node-pty
npm run harness -- up --dir path/to/project   # from the sources; run `npm run build` once for the dashboard
```

The dashboard, in `dashboard/`, is built with Vue and Quasar. It writes its components in
TSX rather than `.vue` files: TypeScript 7 has no JavaScript API for `vue-tsc`, and `tsc`
checks TSX itself. It uses Quasar's prebuilt CSS and SVG icons, Quasar's own included, so
neither Sass nor font files.

A GitHub release tagged with the package's version, such as `v0.1.2`, publishes it to
npm. The release workflow checks the tag against `package.json`, runs the typecheck and
the tests, then publishes with npm's trusted publishing, so each version shows where it
was built. It publishes with the npm that comes with Node 24, after checking its
version, so nothing fetched from the registry runs where the publishing token is.

## License

MIT
