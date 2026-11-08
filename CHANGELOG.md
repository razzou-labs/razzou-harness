# Changelog

The notable changes in each release of razzou-harness. Before 1.0, a new minor version
may change how a project is set up, and its notes say how.

## 0.4.1 (2026-11-08)

**Upgrading a project from 0.4.0:** install the new version, then rebuild the agents'
image with `harness doctor --build-images`: its tag follows the harness's version. A
project's network stays as its `harness/config.json` lists it; for every bundle, set
`"bundles": ["all"]`.

- **Every network bundle by default.** `"all"` in `network.bundles` stands for every
  bundle, those later versions add included, and it is the default: `harness init`
  writes it, and `harness setup` no longer asks which bundles the stack needs. The
  sandboxes of every role reach every bundle's package registries and documentation,
  read-only. A project narrows it by listing bundles. An unknown bundle now fails when
  the config is read, not when a sandbox is made.
- **Third-party APIs**, in `network.apis`: the hosts the code may call with any method,
  like a payment provider's test API. With `"key": "STRIPE_API_KEY"`, `harness doctor`
  asks for the API's key at a hidden prompt and stores it in an OpenShell provider of
  its own; every sandbox gets it, and holds a placeholder in that variable, which
  OpenShell replaces with the key on requests to that host alone, in headers and URLs,
  not in request bodies. While a key isn't stored on the machine, no new attempt
  starts: the pipeline pauses and says so.

## 0.4.0 (2026-11-08)

**Upgrading a project from 0.3.x:** install the new version, then rebuild the agents'
image with `harness doctor --build-images`, or run `harness setup`, which does it: the
image's tag follows the harness's version. The doctor now removes the 0.3.0 image once
no container uses it. Nothing else changes in a project.

- A **Sandboxes** view in the dashboard lists the sandboxes on the OpenShell gateway:
  this project's, with what each is for and whether anything still uses it, then the
  others'. A left-over sandbox of this project, which a crash or a failed delete left,
  can be deleted there; one in use, or another project's, can't. Selecting a sandbox
  shows the network requests its policy refused, from its log: the program, the host,
  why, and how often. The daemon labels the sandboxes it makes with the project's name
  (`harness.project`) to tell them apart; a left-over sandbox from 0.3.0 or earlier has
  no label, so it shows among the others.
- The view shows what each sandbox uses of the machine now, its CPUs and memory against
  its caps, and the total for every OpenShell sandbox, read from `docker stats` every
  five seconds while the view is open.
- **Caps on each sandbox**, set in the Sandboxes view: how many CPUs and how much memory
  each new sandbox may use, so that Developers, check runs and reviewers in parallel
  leave the machine usable. The daemon records them, and creates every sandbox with
  them from then on; those already there keep theirs. There is no cap until you set one.
- An attempt keeps the network requests its sandbox's policy refused. OpenShell keeps
  only a sandbox's last 2,000 log lines, so the daemon reads the log every minute while
  the Developer works, and once more before the sandbox goes. The attempt's card shows
  them, and the Manager gets them with a failed attempt. A refused host is the
  Manager's to resolve: it guides the next Developer around the host, or asks the owner
  to allow it, since only the owner widens the network policy.

Disk space:
- The git bundles the daemon hands to sandboxes, each a copy of the plan branch's whole
  history, are deleted once uploaded, and the ones it takes back once fetched. One was
  kept for every attempt and every review, and never deleted, so `.harness/` grew with
  each. The daemon deletes the ones earlier versions left in `.harness/modules/` when it
  starts.
- The daemon deletes this project's left-over sandboxes when it starts and every hour:
  those the Sandboxes view offers to delete, so a delete that failed is tried again. It
  spares an Architect's, which holds the owner's conversation with it.
- `harness doctor --build-images` removes the agents' images the new one replaces, about
  2 GB each, once no container uses them: the other versions' tags, and the untagged
  images that building a tag again leaves. It also shows the size of Docker's build
  cache, with `docker builder prune` to free it; that cache is shared with every other
  build on the machine, so the doctor leaves it alone.

## 0.3.0 (2026-11-07)

**Upgrading a project from 0.2.x:** install the new version, then run `harness setup`
in the project, which does both steps, or do them by hand. Run `harness install-ci` and
commit the CI files it writes before the next `Arch:` pull request: the protected paths
changed, and the lock the daemon writes lists more, which the old CI script on `main`
would refuse. Rebuild the agents' image with `harness doctor --build-images`: its tag
now follows the harness's version. Then open the dashboard from the link the daemon
prints, once.

Fixes from a review of 0.2.0.

Protected files:
- Paths with a non-ASCII character, a quote or a backslash passed every protection rule,
  in CI's `verify` and in the daemon's own checks, because git quoted them: a Developer
  could add `.claude/skills/é/SKILL.md`, and a `CODE` plan could add Terraform in
  `iac/ñ.tf`. Paths are now read NUL-separated.
- `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` and `.claude/` are protected in every
  folder, as Claude Code reads them there; so are the configs that decide what a check
  runs (`vitest.config.mts` overrode a protected `vitest.config.js`; Vite, Babel, Mocha,
  pytest and tox configs, and package.json's `jest`, `babel` and `mocha` fields, weren't
  protected), and the npm script of `npm run -s lint` or `npm --prefix . test`.
- A Plan or Fix PR may not add a local link to `package-lock.json`, which could swap a
  check's tool for a stub. An Arch PR is judged by the base branch's rules, so it can't
  protect `src/**` to change `src/` in the same PR.
- `protect.files` takes globs, `./x` and `dir/`, which matched nothing before, and
  `terraform.dir` may be written `./iac` or `iac/`. `harness lock` leaves out what git
  ignores.

Swarm mode:
- Every Developer under way reaches the Manager: `ask_manager` from a second or third
  attempt at once was refused, and the Manager could answer or stop only the first. A
  plan's Manager acts on its own plan only.
- Plans in parallel no longer stop on `progress.txt`: both add lines to it, and the
  daemon keeps both sides' lines when it merges `main` into a plan branch. Before it
  merges a pull request, it merges `main` into it when `main` moved since CI ran, so CI
  and the reviewers judge what `main` gets.
- Modules are built one after another in Swarm too, as the design says: the first plan
  of a second module started alongside the first module's plans, with its own
  Developers, Manager and reviewers. Only the module being built has those now. Any
  module's Architect still works meanwhile, so the next module can be designed while one
  is built; its plans wait their turn. Two modules already under way at the upgrade are
  finished one after the other, the older first: the other's attempts are interrupted,
  and start again in its turn.
- A plan that a design change drops while it is built no longer holds a place under
  `swarm.maxPlans`, and its Manager is no longer started over and over, each time in a
  new sandbox and session.
- An `INFRA` or `MIXED` plan's estimate counts only for the head it was made on, and is
  read only once the `cost` job itself succeeded: after a fix round, a head without its
  own estimate merged on the earlier head's.
- `Arch:` and `Fix:` pull requests get the reviewers' statuses as "not reviewed", so the
  owner merges them without bypassing the rules, which also skipped CI.
- A blocking finding blocks, whatever the reviewer's verdict says. A usage limit is not
  one of a reviewer's two failures. Two reviews at once each keep their own transcript.
- Granting the App "Commit statuses: write" takes effect at its next token, within the
  hour, without restarting the daemon; the doctor reads what the installation accepted.
  Swarm's readiness note reads every ruleset on `main`, on every page.
- The pay-per-use calls the cost reviewer is told about are found in every SDK's
  spelling, without false hits on words in comments.

Both modes:
- A usage limit never shortens a pause already there, such as the owner's or a brake's:
  it replaced it with an hour's pause that lifted itself. An attempt that reports a usage
  limit counts from the third time on the same feature, as other interruptions do.
- A plan whose step keeps failing, such as a push GitHub refuses, no longer stops every
  other plan: it is tried again for a while, then the pipeline pauses with its error.
- In Manual, a module whose design lands while another is built waits for it, and the
  other's pull request is still followed: a module whose id sorted first took over.
- A design change that redefines a feature under way interrupts its attempt in Manual
  too. An accepted feature it redefines is built again while its plan is. A plan past its
  build is frozen: `submit_design` refuses a change to its features. A feature a design
  change drops no longer breaks the Manager's items.
- Dead ends after a failure: the owner's push to a plan's pull request branch is built
  on, instead of pausing; a CI run the owner starts again on GitHub counts once it passes;
  on resume, a failed deploy is looked at again, and a later successful apply on `main`
  covers an earlier merge, as when GitHub cancels a pending run.
- An invalid design on `main` pauses the pipeline with the reason, instead of a log line.
- `harness budget --owner-hours` with the daemon down replaces hours already set, and
  `harness mode` with the daemon down records the switch for it.

Setup and the CLI:
- `harness setup` on a machine without the App creates it and waits for its
  installation before it writes `harness/config.json`: the config had no `project.repo`
  or `project.bot`, and the project stayed local. A later run fills them in.
- The setup's commit holds the files it wrote, and nothing else you had staged, and it
  pushes only from `main`: run on another branch, it pushed that branch's commits to
  `main`. A setup commit that wasn't pushed is offered again. A ruleset GitHub refuses,
  as on a free plan's private repository, no longer stops the setup.
- `harness recover` reads GitHub's `main`, not your checkout's, and says what it can't
  rebuild.
- A daemon is running only if its process started when `daemon.json` says: after a crash
  or a reboot, `harness down` could stop another process that reused the pid. A lock
  keeps two `harness up` apart, and closing the terminal stops the daemon cleanly.
- The browser opens the dashboard with a code that works once, not the token, which
  showed on xdg-open's command line.
- Refused owner actions and unknown commands exit with an error.
- The doctor: the probe's `web_read` check passes only on the harness's own refusal; the
  workflow probe fails when the App's installation grants workflows; the ruleset must
  apply to `main`; the statuses warning reads what the installation accepted; a Claude
  token the usage endpoint refuses is reported; a half-created AWS provider is deleted
  so the next run asks for the key again, and setup asks for the view role's ARN once.
- AWS providers are named after the repository: two projects in folders of the same name
  shared one.
- The owner's time: a design without owner actions always fits, and actions done before
  a redesign dropped them still count.
- Hashes no longer depend on the machine's locale, a failed `terraform show` fails the
  check that needs the plan, and the usage endpoint has a timeout.

The sandboxes and the dashboard:
- `web_read` refuses this machine's own addresses and the networks it is on: over IPv6,
  or with a public IPv4 on an interface, an agent could read the host's services or the
  router. A compressed page past the size limit stops decompressing, instead of growing
  the daemon's memory, and a page full of unclosed comments or tags no longer freezes
  the daemon for minutes. One deadline of 75 seconds covers a read and its redirects,
  within the 90 seconds an agent waits. claude.ai and chatgpt.com are never read. An
  HTML comment ends at `--!>` too, as browsers read it: the text after one was lost.
- Usage limits are recognised in Claude Code 2.1's words ("You've hit your 5-hour
  limit"): an attempt that hit one counted as failed.
- An agent can no longer crash the daemon with a line too long for its follower, and a
  terminal whose sandbox ends at once no longer crashes it either. Transcripts and the
  agents' channels pick up again after the OpenShell gateway restarts, a hung `openshell`
  call is stopped, and a tool call too large gets an error, not a wait.
- A torn line in the Architect's inbox no longer breaks its prompt hook, and an
  `extraHosts` entry for a bundle's host, such as github.com, no longer takes away its
  git access.
- The dashboard's cookie is named after its port, so two projects' dashboards no longer
  log each other out: after upgrading, open the printed link once. Agent-written
  Markdown loses its styles, which could hide parts of Needs you. The reviewers' "Shell
  in" button works while a review runs.
- The agents' image pins the AWS CLI, 2.39.6, by checksum.

Releases:
- The release workflow runs the install and the tests in a job without the npm OIDC
  token, and a second job publishes the tarball the first one packed: no dependency's
  code runs where the token can publish.

## 0.2.0 (2026-11-06)

**Upgrading a project from 0.1.x:** install the new version, then run `harness setup`
in the project: it writes the workflow with the new `cost` job (commit it), waits for
you to give the App "Commit statuses: write", and stores the token the usage probe
reads. Without Swarm on, nothing else changes: Manual mode works as before, with the
new attempt clock of 120 minutes and Manager turn of 90.

- **Swarm mode**, designed in `docs/architecture/proposal-v3.md`: a second mode, switched
  in the dashboard or with `harness mode`, in which the daemon merges a plan's pull
  request once CI and the reviewers' statuses pass. `CODE` plans merge when
  `swarm.merge.code` is `daemon`; `INFRA` and `MIXED` plans need the cost job's
  estimate under `swarm.merge.infraMonthlyUsdCeiling`, or the owner's button (both
  below). A pull request the policy leaves to the owner shows the reason under Needs
  you. `Arch:` and `Fix:` pull requests stay the owner's.
- A plan is `CODE`, `INFRA` or `MIXED`, from its features' kinds. Plan pull requests
  carry the tag in their title, and CI's `verify` job keeps a `CODE` plan's pull
  request off the Terraform folder.
- `harness github-setup` applies the ruleset of the daemon's mode, or of `--mode`: in
  Swarm, no approval, and the reviewers' statuses required and pinned to the App.
  `harness doctor` checks the ruleset against the mode, and that the App may write
  commit statuses.
- Budgets in the Project view: your hours for the whole project, and a threshold for
  the agent hours, the Developers' attempt clocks summed, red when over.
- Your time as a design constraint, in both modes, once you set your hours: owner
  actions carry `estimatedMinutes`, a reserve of `ownerTime.reservePercent` stays out
  of designs, and `submit_design` refuses a design whose actions take more than what
  remains. Only owner actions count, not the proposals or pull requests you read. The
  Architect gets `get_owner_time`, and a note when the budget changes.
- An attempt's deadline is 120 minutes, and the Manager's turn 90, by default.
- In Swarm, up to `swarm.maxDevelopers` Developers build a plan's independent features
  at once. The plan's head is merged into an attempt before its checks when another
  feature landed first, and the feature lands as one commit on the head; a conflict
  interrupts the attempt, and the next one starts from the new head. A design change
  merged while a feature is built interrupts its attempt the same way. The Architect is
  told to declare every dependency in `dependsOn`, and hears in one line when a plan's
  pull request opens, waits for the owner, is blocked by a reviewer, or merges.
- Plans in parallel, in Swarm: a plan's `dependsOn` names the plans that must be merged
  first, or the previous plan without it; up to `swarm.maxPlans` plans build at once,
  each with its own Manager, keyed `module/plan`; a feature may depend on an earlier
  plan's feature as `P1/F03`. The Project view draws each module's features as a graph
  with their dependencies, and the Agents view lists the reviewers' sessions.
- Two reviewers, security and cost, read every plan's pull request once CI passed, in
  Swarm, or in Manual as comments only with `swarm.reviewersInManual`. Each runs in a
  fresh read-only sandbox with a brief: the features, the files changed, the
  pay-per-use AWS calls the change adds or removes, and the Terraform plan's JSON.
  Their findings are posted on the pull request, their verdicts set as the commit
  statuses `harness/security` and `harness/cost`, and a blocking verdict opens a fix
  round, two per reviewer by default, before the pull request is the owner's. The App
  needs "Commit statuses: write"; an older App's tokens fall back to read, and the
  pull request waits for the owner with the reason.
- `harness setup`, designed in `docs/architecture/proposal-v4.md`: one command that
  sets up this machine and the project, does every step the harness can, and asks only
  for what is the owner's: a `gh` login, the Claude token at a hidden prompt, the
  clicks GitHub needs for the App, three questions, and with AWS the role ARNs and the
  gateway key. It commits and pushes the files it wrote once the owner agrees, runs the
  doctor and fixes what it can, waits for the browser steps, runs the probe, and offers
  to start the daemon. `harness init` and the checklist stay, for the steps by hand.
- `harness mode` applies the mode's ruleset on `main` in the same command, with your
  own `gh`. In Swarm the daemon reads the rules in effect on `main` through the App,
  and the dashboard's "Before you use Swarm" note lists only what is left: the rules,
  the App's statuses permission, the usage probe's token; it goes once all are done.
  `harness budget --owner-hours <n>` sets your hours, even with the daemon down.
- A button in the dashboard's header, in Swarm, that lets the daemon merge `INFRA` and
  `MIXED` plans like `CODE` ones, once CI and both reviewers pass; an Infracost estimate
  over the ceiling still waits for the owner. Off by default; the choice is an event.
- The dependencies with advisories moved past them: zod 4.6.6 or later, and dompurify
  3.4.17 or later for the dashboard's Markdown.
- A `cost` job in the CI workflow, written by `harness install-ci`: on a pull request
  with `iac/` and the `INFRACOST_API_KEY` secret, Infracost's estimate of the monthly cost
  the change adds is uploaded as an artifact, which the daemon reads once CI passed.
  `INFRA` and `MIXED` plans then merge themselves in Swarm under
  `swarm.merge.infraMonthlyUsdCeiling`, and the cost reviewer gets the estimate in its
  brief. Without the job's artifact they wait for the owner, with the reason.
- In Swarm, the daemon reads the subscription's usage before it starts an attempt, and
  at or above `swarm.usageCeilingPercent` the pipeline waits for the window to reset.
  `harness doctor` stores the provider's token in `~/.config/harness/claude.token` for
  it, and asks for it on an older setup once Swarm is on. Spike 5 records the endpoint.

## 0.1.3 (2026-10-11)

- More npm keywords, for a team of agents in sandboxes.
- The README says what a module is, a part of the system you want to build, and how to
  size one: its design fits in the Architect's context.

## 0.1.2 (2026-10-11)

- The source is public, on GitHub, and the package links to it.
- Releases are published to npm from GitHub Actions, with provenance: a GitHub release
  tagged `v<version>` publishes that version.
- A user guide in the README: your first module, the concepts, the commands, the
  configuration, the AWS setup, security, usage, and troubleshooting.
- The README states what GitHub requires: an organization for the App, and a paid plan
  for rulesets on private repositories.
- `harness init` and `harness doctor` no longer point to a private setup repository for
  AWS.
- A security policy, in `SECURITY.md`.

## 0.1.1 (2026-10-11)

- The dashboard ships with `THIRD-PARTY-LICENSES.md`, the licenses of the libraries
  bundled into it.
- The command is also installed as `razzou-harness`, for machines where another
  `harness` comes first on the PATH.
- The package has no source maps any more: they pointed to sources it doesn't contain.
- A new description: your AI dev team, with you in charge.

## 0.1.0 (2026-10-11)

The first release:
- an Architect per module that designs it with you, Developers that build it one feature
  at a time, and a Manager that reviews their work, each in its own OpenShell sandbox;
- a daemon that runs the loop from an event log, and picks up where it stopped after a
  restart;
- one pull request per plan, opened by a GitHub App with no access to workflows, and CI
  rules that protect the design and its checks;
- read-only AWS for the agents, Terraform plans against the real state, applies only in
  CI, and post-deploy checks;
- the dashboard, with the Architect's terminal and live transcripts;
- `harness init`, `harness doctor` with its probe, and `harness recover`.
