# Harness: architecture proposal v4 — one setup command

Status: draft of 2026-11-06, taken as accepted with the recommendations of §7 on the
owner's "ok perfect". It amends v2 §17 (package, CLI and setup) and folds in the three
steps Swarm added (v3 §2.1, §3.4, §4.3). Nothing here changes what the agents can do.

Built so far (S-C, in part): `harness mode` applies the ruleset; the daemon reads
main's rules in effect through the App (`GET /repos/{owner}/{repo}/rules/branches/main`,
which the App's metadata permission allows; a 403 or 404 shows as "can't be read" and
the full note stays) and the dashboard's note lists only the steps left;
`harness budget --owner-hours` writes `.harness/setup.json`, which the daemon takes
once when it starts. The rest of §4, the `harness setup` command, follows.

## Contents

1. [The goal](#1-the-goal)
2. [Everything a setup needs today](#2-everything-a-setup-needs-today)
3. [What can't be automated, and why](#3-what-cant-be-automated-and-why)
4. [The design: `harness setup`](#4-the-design-harness-setup)
5. [Swarm's steps, folded in](#5-swarms-steps-folded-in)
6. [The dashboard](#6-the-dashboard)
7. [Decisions for the owner](#7-decisions-for-the-owner)
8. [Delivery plan](#8-delivery-plan)

---

## 1. The goal

The owner sets up a machine and a project by typing one command and doing only what
only they can do: log in to accounts in the terminal, paste a key or a token at a hidden
prompt, and click where GitHub offers no API. Everything else the harness does itself,
in order, and it can be run again at any time: a second run skips what is done and fixes
what isn't.

Today the setup is a seven-step checklist that `harness init` prints and `harness doctor`
checks, with six commands to run in the right order, two files to edit by hand, and,
for Swarm, three more steps the README lists under "Before you use Swarm".

## 2. Everything a setup needs today

Once per machine:

| # | Step | Who does it today | Can the harness do it? | What stays with the owner |
|---|---|---|---|---|
| M1 | Node 24, git, Docker, and `python3`, `make`, `g++` for the dashboard's terminals | The owner installs them | No: system packages need root, and each distribution differs. The harness prints the one line for the distribution it detects | Run that line |
| M2 | OpenShell 0.1.2, and its gateway running | The owner installs it and runs `openshell gateway start` | The install, no, for the same reason. The gateway, yes: start it when it isn't running | Install it |
| M3 | Claude Code on the machine, with a subscription | The owner installs it | No: the owner needs it anyway, and its installer is theirs to run | Install it |
| M4 | `npm install -g razzou-harness --allow-scripts=node-pty` | The owner | It is the harness | Run it |
| M5 | `gh` logged in as an admin of the repository | The owner | Yes: run `gh auth login` for them when `gh` isn't logged in | Log in, in the terminal |
| M6 | The agents' image | `harness doctor --build-images` | Yes: build it when it is missing or its Claude Code differs from the machine's | Nothing |
| M7 | The Claude provider in OpenShell, from `claude setup-token` | `harness doctor` asks for the token at a hidden prompt and creates the provider; since v3 it stores the token for the usage probe too | Yes, apart from the token: `claude setup-token` is a browser login that prints the token, and the owner pastes it | Run `claude setup-token`, paste |
| M8 | The GitHub App, created from the manifest | `harness github-app create --org <org>` opens the browser; the owner clicks Create | Yes, apart from the click: GitHub creates Apps only through the browser | One click |
| M9 | The App installed on the repository | The owner, in the browser | GitHub has no API to install an App. The harness opens the page for the repository and waits until the installation appears | One click |

Once per project:

| # | Step | Who does it today | Can the harness do it? | What stays with the owner |
|---|---|---|---|---|
| P1 | A repository in an organization (rulesets need a public repository or a paid plan) | The owner | Yes: `gh repo create <org>/<name>` with the owner's `gh`, when there is no `origin` | Confirm the name and the visibility |
| P2 | The harness's files: `harness/config.json`, the workflow, the CI script, CODEOWNERS, `README.md`, `ARCHITECTURE.md`, `init.sh`, `.gitignore`, the lock | `harness init` | Done | Nothing |
| P3 | `harness/config.json` by hand: the network bundles for the stack, the models, `aws` and `terraform` | The owner, in an editor | Yes: three questions, and the file is written. The models keep their defaults | Answer: the stack, AWS or not, the hours of their time |
| P4 | Commit the files and push them to `main` | The owner, with their own git | Yes, with the owner's git and identity, after they confirm. The App may not touch workflows; the owner's own git may | Confirm |
| P5 | Merge settings and the ruleset on `main` | `harness github-setup --repo <org>/<repo>` | Done, with the owner's `gh`; the setup runs it | Nothing |
| P6 | AWS, for infrastructure: the state bucket, the OIDC provider, the CI plan and apply roles, the agents' view role, the gateway user, the boundary | The owner's bootstrap, outside the harness | No, by design: these need the owner's administrator credentials, and the harness never holds AWS write access (v3 D29). The setup asks for the three outputs it needs | Run the bootstrap; paste the view role's ARN and the CI roles' ARNs |
| P7 | The repository's `staging` environment, restricted to `main`, and the variables `AWS_REGION_STAGING`, `AWS_ROLE_PLAN_ARN_STAGING`, `AWS_ROLE_APPLY_ARN_STAGING` | The owner, or their bootstrap's script | Yes: three calls with the owner's `gh`, from the ARNs of P6 | Nothing |
| P8 | The AWS provider in OpenShell, with the gateway user's key | `harness doctor` asks for the role and the key | Done | Paste the key |
| P9 | `harness doctor --probe` | The owner | Yes: the setup ends with it | Nothing |
| P10 | `harness up` | The owner | Yes: offered at the end | Nothing |

For Swarm (v3):

| # | Step | Who does it today | Can the harness do it? | What stays with the owner |
|---|---|---|---|---|
| S1 | The ruleset of the mode, after each switch | `harness github-setup` again | Yes: `harness mode swarm` and `harness mode manual` apply it in the same command, with the owner's `gh`. The dashboard's switch can't: the daemon has no administration permission, on purpose (v3 §2.1), so it shows the command with a copy button | Run the command after a switch from the dashboard, or switch from the terminal |
| S2 | The App's **Commit statuses: write** | The owner, in the App's settings, then on its installation | New Apps have it since v3. For an older App, GitHub changes permissions only in the browser: the setup opens the two pages and waits until the permission shows on the installation | Two clicks, once |
| S3 | The token for the usage probe | `harness doctor` stores it when it creates the provider, or asks for it once Swarm is on | Done. A setup made before v3 pastes it once | Paste once, on an older setup |
| S4 | The Infracost key, for the cost estimate (v3 M10b, not built) | — | Yes: `infracost auth login` is a browser login; the setup reads the key it stored and sets the repository secret `INFRACOST_API_KEY` with the owner's `gh` | Log in to Infracost, in the browser |

The owner's part, in all: install four tools, log in to `gh`, paste one Claude token,
click twice for the App, answer three questions, and, with AWS, run their bootstrap and
paste its outputs and one key. Every other line of the checklist is the harness's.

## 3. What can't be automated, and why

- **System packages** (M1 to M3) need root, and the harness shouldn't run as root.
- **GitHub Apps** are created, installed and granted new permissions in the browser
  only. There is no API for any of the three, for every account type.
- **`claude setup-token`** logs in through the browser and prints the token once. The
  harness could capture it from a pseudo-terminal, but that depends on the text Claude
  Code prints, which changes. Pasting is one step and never breaks.
- **AWS administration** stays the owner's. The bootstrap needs credentials that can
  create roles and policies; the harness is built so that nothing in it ever has them.
- **Changing the rules on `main`** needs a repository administrator. The owner's `gh` is
  one; the daemon's App isn't, and must not become one, or a daemon bug could lift the
  rules it merges under.

## 4. The design: `harness setup`

One interactive command, `harness setup`, run in the project's repository. It is the
doctor with hands: the same checks, in the same order, and for each one that fails, the
fix, when the harness can make it, or the one thing the owner must do, with the page
opened and the command printed.

- **One list.** Each check in `src/setup/doctor.ts` gains an optional `apply`: what
  makes it pass. `harness doctor` runs the checks and prints the fixes; `harness setup`
  runs the checks and applies the fixes. There is no second checklist to keep in step,
  and `CHECKLIST` in `init.ts` goes: `harness init` prints "now run `harness setup`".
- **Idempotent.** Every `apply` is safe to run twice: it creates what is missing and
  leaves what exists. A second `harness setup` after a Claude Code update rebuilds the
  image and does nothing else.
- **Waits instead of stopping.** For a browser step, the setup opens the page, says what
  to click, and polls GitHub with the App's own credentials until the result shows: the
  App exists, the installation lists the repository, the permission is granted. The
  owner never comes back to re-run the command.
- **Secrets at hidden prompts only**, as the doctor does today: the token and the AWS
  key go through the environment of one `openshell` command, never through arguments
  or files, except the token file the usage probe reads (v3 §4.3).
- **The owner's git, after a confirmation.** The setup commits the scaffold on `main`
  with the owner's identity and pushes it, before the ruleset exists, so the push needs
  no pull request. It shows the file list first and asks.
- **Three questions**, asked once and written to `harness/config.json`:
  1. the stack, as a choice among the network bundles, so npm or pip or cargo work in
     the sandboxes;
  2. AWS, yes or no; with yes, the region, the Terraform paths, and the ARNs of P6;
  3. the hours of the owner's time for the whole project (v3 §4.1), recorded as the
     budget when the daemon starts, or skipped.
- **Non-interactive runs** stay possible: without a terminal, `harness setup` behaves
  as `harness doctor` and exits non-zero with the list of what the owner must do.

The flow, as the owner sees it:

```
$ harness setup
ok    Node 24.11.0, git 2.51, Docker 29.0
ok    OpenShell 0.1.2; gateway started
ok    gh: logged in as an admin of acme/shop
ok    Claude Code 2.1.312; image razzou-harness/agent:0.2.0 built
      Claude provider claude-sub is missing. Run `claude setup-token` in another
      terminal and paste the token here (hidden): ****
ok    Claude provider created; token stored for the usage probe
      No GitHub App on this machine. Opening the browser: review the App and click
      "Create GitHub App"... created acme-harness (id 123456).
      Opening the installation page: install it on acme/shop only... installed.
ok    harness/config.json written: bundles core, node; no AWS; 40 h of your time
      Commit and push 9 files to main as you? [Y/n] y
ok    pushed
ok    merge commits only; ruleset "harness: main" (Manual)
ok    probe: 32 checks passed
Start the daemon now? [Y/n]
```

## 5. Swarm's steps, folded in

- **The ruleset follows the mode** (S1). `harness mode swarm` records the switch and
  applies the Swarm ruleset in the same command; `harness mode manual` the Manual one.
  Both use the owner's `gh`, so they run on the owner's machine, as today. The
  dashboard's switch keeps recording the mode alone and shows the command to run, with
  a copy button, until the daemon sees the rules match (§6).
- **The App's permission** (S2) is a check with a browser wait like M8: the setup opens
  the App's permissions page, then the installation's, and polls `GET /app` and the
  installation until `statuses` is `write`.
- **The token** (S3) is stored when the provider is created, as since v3; the setup asks
  for it once on a machine set up before.
- **The owner's hours** are the third question. They land in the daemon's event log as
  `OWNER_HOURS_SET` when it starts, through a small pending file the daemon consumes,
  the same way `harness mode` records a switch while the daemon is down.
- **Infracost** (S4) joins with M10b: `infracost auth login`, then the repository secret.

## 6. The dashboard

The daemon can read the rules in effect on `main` with the App's `metadata: read`
permission, through `GET /repos/{owner}/{repo}/rules/branches/main`: it lists the
approvals the branch requires and the status checks with the integration that must
post them. With that, the daemon knows whether GitHub's rules match its mode, and the
dashboard's "Before you use Swarm" note shows only the steps still undone, and
disappears when none is left. The check runs at each switch and with each PR poll.
A spike confirms the permission the endpoint needs before this is built.

## 7. Decisions for the owner

| # | Question | Recommendation |
|---|---|---|
| 1 | `harness doctor` checks only, and `harness setup` fixes? Today the doctor already creates the providers at prompts | Yes: one verb each. The doctor's prompts move to the setup |
| 2 | May the setup commit and push the scaffold with your git? | Yes, after showing the list and asking. It is your checkout and your identity; the App still never touches workflows |
| 3 | `harness mode` applies the ruleset itself? | Yes. The dashboard's switch keeps showing the command: the daemon stays without administration rights |
| 4 | Create the repository with `gh repo create` when there is no remote? | Yes, with a confirmation of the name and the visibility |
| 5 | Ship the AWS bootstrap as Terraform in the package, applied by the owner with their own administrator session? | Not now. You have a bootstrap; the setup asks for its outputs. Revisit if the harness gets users without one |

## 8. Delivery plan

| Milestone | Delivers | Done when |
|---|---|---|
| **S-A Setup command** | `apply` on the machine and project checks; `gh auth login`, the image, the provider, the App with its browser waits, the three questions, the commit and push, the ruleset, the probe, `harness up`; `init` points to `setup` | On a throwaway organization and repository, a machine with the four tools installed goes from `npm install` to a green probe with the owner's inputs of §2 and nothing else |
| **S-B AWS** | The ARN prompts, the environment and variables through `gh`, the provider | With the owner's bootstrap outputs pasted once, `harness doctor --probe` passes its AWS checks and `tf-plan` runs in CI |
| **S-C Swarm folds** | `harness mode` applies the ruleset; the App permission wait; the hours question; the daemon's rules check and the dashboard's note that empties | A switch from the terminal needs no second command; a switch from the dashboard shows the one command until it is run |
| **S-D With M10b** | The Infracost login and secret | An `INFRA` plan gets its estimate in CI on the first try |

S-A is most of the value and lands first. S-B and S-C are small on top of it. S-D
waits for M10b.
