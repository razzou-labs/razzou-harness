# Changelog

The notable changes in each release of razzou-harness. Before 1.0, a new minor version
may change how a project is set up, and its notes say how.

## Unreleased

- **Swarm mode**, designed in `docs/architecture/proposal-v3.md`: a second mode, switched
  in the dashboard or with `harness mode`, in which the daemon merges a plan's pull
  request once CI and the reviewers' statuses pass. `CODE` plans merge when
  `swarm.merge.code` is `daemon`; `INFRA` and `MIXED` plans need the cost estimate
  under `swarm.merge.infraMonthlyUsdCeiling`, which no project produces yet, so they
  wait for the owner. A pull request the policy leaves to the owner shows the reason
  under Needs you. `Arch:` and `Fix:` pull requests stay the owner's.
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
  actions carry `estimatedMinutes`, reading a proposal counts at
  `ownerTime.linesPerHour`, a reserve of `ownerTime.reservePercent` stays out of
  designs, and `submit_design` refuses a design over what remains. The Architect gets
  `get_owner_time`, and a note when the budget changes.
- An attempt's deadline is 120 minutes, and the Manager's turn 90, by default.
- In Swarm, up to `swarm.maxDevelopers` Developers build a plan's independent features
  at once. The plan's head is merged into an attempt before its checks when another
  feature landed first, and the feature lands as one commit on the head; a conflict
  interrupts the attempt, and the next one starts from the new head. The Architect is
  told to declare every dependency in `dependsOn`.
- Two reviewers, security and cost, read every plan's pull request once CI passed, in
  Swarm, or in Manual as comments only with `swarm.reviewersInManual`. Each runs in a
  fresh read-only sandbox with a brief: the features, the files changed, the
  pay-per-use AWS calls the change adds or removes, and the Terraform plan's JSON.
  Their findings are posted on the pull request, their verdicts set as the commit
  statuses `harness/security` and `harness/cost`, and a blocking verdict opens a fix
  round, two per reviewer by default, before the pull request is the owner's. The App
  needs "Commit statuses: write"; an older App's tokens fall back to read, and the
  pull request waits for the owner with the reason.
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
