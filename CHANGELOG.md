# Changelog

The notable changes in each release of razzou-harness. Before 1.0, a new minor version
may change how a project is set up, and its notes say how.

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
