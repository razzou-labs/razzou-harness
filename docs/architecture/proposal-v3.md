# Harness: architecture proposal v3 — Swarm mode

Settled in the design chat of 2026-11-05. v2 stays the reference for everything this
document doesn't change: it describes Manual mode, which keeps working as it does today.

## Contents

1. [Summary](#1-summary)
2. [Two modes](#2-two-modes)
3. [Pull requests in Swarm](#3-pull-requests-in-swarm)
4. [Budgets and brakes](#4-budgets-and-brakes)
5. [The reviewers](#5-the-reviewers)
6. [Parallel plans and features](#6-parallel-plans-and-features)
7. [Dashboard](#7-dashboard)
8. [State and events](#8-state-and-events)
9. [Configuration](#9-configuration)
10. [Security model](#10-security-model)
11. [Delivery plan](#11-delivery-plan)
12. [Decisions log](#12-decisions-log)

## Changes from v2

- **A second mode, Swarm**, switched per project in the dashboard. Manual is the default
  and is unchanged: the owner reviews and merges every pull request.
- **Plan kinds.** A plan is `CODE`, `INFRA` or `MIXED`, from the kinds of its features.
  The kind is in the PR's title, and CI enforces what each kind may change.
- **In Swarm the daemon merges.** `CODE` plans when CI and the reviewers pass; `INFRA`
  plans when, in addition, the monthly cost the PR adds stays under a ceiling. `Arch:`
  and `Fix:` PRs stay the owner's in both modes.
- **The owner's time is a design constraint.** The owner sets the hours the whole
  project may take of their time. The Architect estimates every owner action, and
  `submit_design` refuses a design that doesn't fit.
- **Two reviewers**, security and cost, read every PR before it merges, after
  deterministic scanners ran in CI. Their findings are PR comments, and their verdicts
  are commit statuses the ruleset requires.
- **Parallel plans and features**, only where the Architect declared independence, with
  one Manager per plan in flight.
- **Subscription usage is read before a launch**, so Swarm starts nothing above a
  ceiling, and waits for the window to reset.
- **Two brakes change for both modes:** an attempt's clock is 120 minutes, and the
  Manager's turn 90.
- **No cost monitoring after a merge.** The owner's account-wide AWS alarms cover it.

### Amendments after acceptance

| Date | Sections | Amendment |
|---|---|---|
| 2026-11-05 | 4.1 | M8. The Architect reads the owner-time numbers with `get_owner_time`, and hears of the budget in its welcome and in a note when it changes, rather than from a prompt the daemon rewrites. A design in review counts as committed, read from the Architect's ref. |
| 2026-11-05 | 4.3 | M9. The usage is read at most every five minutes; a reset time in the past or unreadable pauses for an hour instead. |
| 2026-11-05 | 6.2, 6.3, 6.5, 6.6 | M11, first slice: parallel features within the plan under way, with the landing of §6.3. The merge with the moved head happens before an attempt's checks, not only at landing, so the checks of accepted work see that work; a conflict interrupts the attempt, which doesn't count, instead of a rebase work item. A design change that redefines a feature under way interrupts its attempt (§6.6). The Architect's digest (§6.5) is one note per plan event, in both modes. Plans still build in order: plan dependencies, Managers per plan and the graph remain. |
| 2026-11-05 | 5.1, 5.3, 5.5 | M10. The reviewers run as one print-mode session each, like a Developer, with the Manager's read-only permissions and model, and answer with a structured report instead of a `report_findings` tool. The daemon makes their inputs itself: the paid-call inventory from the base and head trees, and the Terraform plan's JSON the way a check that needs it gets one. The CI jobs of §5.5, the scanners and Infracost, move to M10b, with the cost estimate in the merge policy. An App created before this version can only read statuses: its tokens fall back to that, and a PR whose reviewer passed waits for the owner with the reason. |
| 2026-11-06 | 4.1, 9, 12 | M8 amended, at the owner's request: only owner actions count in the owner's time. The proposal's reading no longer does, and `ownerTime.linesPerHour` is gone. The owner also confirmed the landing of §6.3 as built: a conflict interrupts the attempt, and there is no rebase work item. |
| 2026-11-06 | 5.3, 5.5, 11 | M10b, first slice: the `cost` job and its artifact. The job runs Infracost, pinned by version and checksum, on the base and the head, and uploads the JSON; the daemon reads the artifact of the head's workflow run with the App's Actions permission once CI passed, for twenty minutes, records `COST_ESTIMATED`, and the merge policy and the cost reviewer's brief use it. The paid-call inventory stays the daemon's, not CI's. The scanners (gitleaks, semgrep, checkov) are deferred: they can't be tried here, gitleaks's action needs an organization licence, and the reviewer reads the diff itself meanwhile; they wait for a real repository to iterate against. |
| 2026-11-06 | 3.2, 7, 12 | D36: the owner's button for infra merges. The policy's clause 6 holds without the button; with it, an `INFRA` or `MIXED` PR merges like a `CODE` one, and only an estimate over the ceiling leaves it to the owner. |
| 2026-11-06 | 6.1, 6.2, 6.4, 6.6, 6.7, 7 | M11, second slice: plan dependencies and parallel plans, Managers per plan, the graph, and the reviewers' transcripts in Agents. A plan's `dependsOn` is optional: absent, the previous plan; a plan starts once its dependencies are merged, or complete without GitHub. A feature's dependency on an earlier plan's feature holds until that plan is merged, and `main` is merged into the plan branch before the attempt. In Swarm the daemon follows every plan in flight on each pass, even with every Developer busy. Managers are keyed by module in Manual and by `module/plan` in Swarm; one started under the other mode keeps its scope until it stops, and owner answers and Architect decisions go back to the Manager that asked. `main` is merged into a plan branch while its attempts run, since they land on the moved head (§6.3); a conflict there still pauses. Plan-level edges are a label on the plan's box, not lines. |
| 2026-11-07 | 3.2, 3.3, 4.3, 5.4, 6.1, 6.2, 6.6 | After a review of 0.2.0. Modules are built one after another in Swarm too (v2 §12.8, D35): plans in parallel are plans of the module under way, and only that module has Developers, Managers and reviewers; Architects may design other modules meanwhile, whose plans wait. A plan a design change drops while it is built is no longer in flight. Before the daemon merges a PR, `main` is merged into it when it moved since CI ran, and `progress.txt` takes both sides' lines in the daemon's merges; a conflict in other files no longer pauses: the plan goes on from its base and the conflict is resolved in its PR, where the owner's push is built on, unless `main` changed the module's design. The cost estimate counts only for its own head, and only once the `cost` job succeeded. Arch and Fix PRs get the reviewers' statuses as "not reviewed", since the rules require them on every PR. A blocking finding blocks whatever the verdict. A usage limit never shortens a pause already there, and counts from the third time on a feature. A design change interrupts the attempt it redefines in Manual too, an accepted feature it redefines is built again while its plan is, and a plan past its build is frozen. |
| 2026-11-11 | 6.3, 6.6 | Conflicts with `main` go through the plan's Manager, at the owner's request. §6.6's rebase work item is built as a merge round, a fix round of kind `merge`. When `main` no longer merges into a plan's branch, while the plan is built or with its pull request open, `PLAN_MAIN_CONFLICT` is recorded, nothing new starts in the plan, and its Manager gets the conflict with both sides in its clone. It calls `request_fix` with how each file must come out, or escalates a contradiction to the Architect. A Developer merges `main` at that commit in a sandbox that holds both. The daemon refuses a result that leaves `main` out, keeps a conflict marker, or holds a protected file otherwise than `main` does; it runs the checks of both sides on it, and the Manager reviews it. Accepted, it lands as one commit with both parents, with `progress.txt` written by the daemon. The pause for a conflict that came with a design change is gone, as the plan waits for the merge. A pull request that conflicts no longer waits for CI, which GitHub doesn't run on it, and shows no card to merge it. Within a plan, §6.3 stays as confirmed on 2026-11-06: a conflict interrupts the attempt. |

---

## 1. Summary

Manual mode works for a project the owner can read in full. Past a certain size the
owner becomes the bottleneck: agents produce more than one person reviews. Swarm mode
gives the agents more autonomy and the owner less to read, without giving up what makes
the harness safe: code runs the loop, agents hold no credentials, protected files change
only through `Arch:` PRs, and AWS changes only through CI after a merge.

What Swarm changes, in one table:

| | Manual | Swarm |
|---|---|---|
| Who merges a `CODE` plan | The owner | The daemon, once CI, security and cost pass |
| Who merges an `INFRA` plan | The owner | The daemon, when the monthly cost it adds is under the ceiling; the owner otherwise |
| Who merges `Arch:` and `Fix:` PRs | The owner | The owner |
| Developers at once | One | Up to `swarm.maxDevelopers`, on features whose dependencies are merged |
| Plans at once | One | Up to `swarm.maxPlans`, when the Architect declared them independent |
| Managers | One per module | One per plan in flight |
| Reviewers | None | Security and cost, on every PR |
| Before a launch | Nothing | The subscription's usage must be under `swarm.usageCeilingPercent` |
| The ruleset on `main` | One approval from a code owner | No approval; the reviewers' statuses required |

What both modes get:
- the owner-time budget, once the owner sets it;
- the agent-hours meter;
- plan kinds in PR titles, and the CI rule that goes with them;
- the new brake defaults.

Out of scope for v3:
- pull requests per feature;
- several daemons on one project;
- cost monitoring after a merge: the owner's account-wide alarms cover it (D29);
- any write permission on AWS for the daemon.

---

## 2. Two modes

### 2.1 The switch

The mode is operational state, like a pause, not a field of the protected
`harness/config.json`: the owner switches it in the dashboard, or with
`harness mode swarm` and `harness mode manual`. The daemon records `MODE_CHANGED`, and
`state.mode` is `manual` until the first switch.

A switch takes effect at item boundaries:
- running attempts finish under the rules they started with;
- Swarm to Manual: the daemon stops merging at once, and open PRs wait for the owner;
- Manual to Swarm: the reviewers run on the PRs already open before anything merges.

GitHub needs its own switch, because the rules on `main` differ per mode (§3.3) and
only a repository admin can change them. The daemon's App has no administration
permission, on purpose. So the owner runs `harness github-setup --repo <org>/<repo>`
once after a switch: it applies the ruleset of the mode the daemon is in. Until the
ruleset matches, Swarm can't merge, the dashboard says so next to the switch, and
`harness doctor` reports the mismatch.

### 2.2 What stays

Everything v2 describes that this document doesn't amend: sandboxes, bundles, the
protocol and tools, checks in fresh sandboxes, the Manager's review, the event log,
`Arch:` PRs, protected files and `lock.json`, Terraform through CI, recovery.

---

## 3. Pull requests in Swarm

### 3.1 Plan kinds

A feature already has a `kind`, `app` or `infra`. A plan's kind follows from its
features:

| Features | Plan kind | Title |
|---|---|---|
| all `app` | `CODE` | `Plan: shop/P2 -CODE- Order API` |
| all `infra` | `INFRA` | `Plan: shop/P1 -INFRA- Queues and tables` |
| both | `MIXED` | `Plan: shop/P3 -MIXED- Notifications` |

The daemon writes the tag; it grants nothing. CI's `verify` job derives the kind from
the plan file on the base branch, from the PR's branch name:
- a title that carries a tag must carry the right one; a title without a tag, from an
  older daemon, passes;
- a `CODE` PR may not change anything under the Terraform folder (`terraform.dir`,
  `iac/` by default) when the project has a `terraform` section: infrastructure can't
  reach `main` as code.

The Architect already decides which features go together; v3 tells it to put
infrastructure in plans of its own (D26), so `MIXED` is rare and merges like `INFRA`.

### 3.2 Merge policy

One PR per plan stays (D27). In Swarm, the daemon merges a plan's PR, as the App, when
all of these hold:
1. `state.mode` is `swarm`, and the ruleset on `main` is the Swarm one;
2. the PR is a `Plan:` PR whose head is the commit the daemon pushed;
3. every required CI job passed on that head;
4. every context in `swarm.requiredStatuses` is `success` on that head: by default
   `harness/security` and `harness/cost`, which the reviewers post (§5.4);
5. for a `CODE` plan: `swarm.merge.code` is `daemon`;
6. for an `INFRA` or `MIXED` plan: `swarm.merge.infraMonthlyUsdCeiling` is a number,
   and the cost job's estimate of the monthly cost the PR adds (§5.3) is at or under it.

A PR that fails 5 or 6 waits for the owner, as in Manual: the dashboard lists it under
**Needs you** with the reason. `Fix:` PRs, after a failed deploy, and `Arch:` PRs are
the owner's in both modes: a failed deploy is exactly when the owner should look.

The merge is a merge commit; GitHub takes its title and message from the PR, as the
repository settings already require. The daemon records `PR_MERGED` from the merge
response, and the flow after a merge is v2's: `tf-apply` on the merge commit, then the
post-deploy checks.

### 3.3 The ruleset per mode

`harness github-setup` applies the ruleset of the daemon's current mode, read from
`.harness/state.json`; `--mode manual|swarm` overrides.

| Rule | Manual (v2) | Swarm |
|---|---|---|
| Pull request required | Yes | Yes |
| Approvals | 1, from a code owner | 0 |
| Required status checks | `verify`, `checks`, `tf-plan` with Terraform, pinned to GitHub Actions | The same, plus `swarm.requiredStatuses` pinned to the App |
| Merge method | Merge commit | Merge commit |
| Force push, deletion | Blocked | Blocked |
| Bypass | The owner | The owner |

Pinning a status to the App's id means no other integration, and no user, can post a
passing `harness/security`. The ruleset enforces the policy against the daemon too: a
daemon that tried to merge before the reviewers answered would be refused by GitHub.

### 3.4 App permissions

Two additions to v2 §11.4: **Commit statuses: write**, for the reviewers' verdicts, and
nothing else. Merging needs the contents and pull requests permissions the App has.
`harness github-app check` reports a missing permission.

---

## 4. Budgets and brakes

Four numbers, one of which stops anything. None of them concerns money spent in AWS:
the harness doesn't watch spend after a merge (D29).

| Meter | Source | Over the line |
|---|---|---|
| The owner's time | Estimates the Architect writes, against the hours the owner set | A design that doesn't fit is refused; the meter turns red when used exceeds the hours |
| Agent hours | The Developers' attempt clocks, summed | Red, nothing stops |
| Subscription usage | The usage endpoint, before each launch in Swarm | Launches wait until the window resets |
| AWS cost, per PR | The cost job's estimate of the monthly cost an `INFRA` PR adds | The PR waits for the owner |

### 4.1 The owner's time

The point: today the Architect can give the owner any amount of work through owner
actions. With a budget, it must design within it.

- **The owner sets the hours** for the whole project, once, before the first module:
  a form in the dashboard, recorded as `OWNER_HOURS_SET`. They can be changed later,
  and the meter says since when.
- **Every owner action carries `estimatedMinutes`**, written by the Architect. When
  hours are set, `submit_design` requires it on every action of the module.
- **Only owner actions count** (D30). The proposal, the Arch PRs and the infra PRs the
  owner reads are their own reading, which the harness doesn't measure.
- **A reserve** of `ownerTime.reservePercent`, 20 by default, stays out of what designs
  may use: escalations, questions and merges the policy sends to the owner come out of
  it.
- **Planned** for a module = the sum of its actions' estimates. **Committed** = planned
  over the modules whose design is submitted or frozen.
  **Available** for a module = hours × (1 − reserve) − committed by the other modules.
- **`submit_design` refuses** a design whose planned time exceeds what is available, and
  says by how much. The Architect reads the hours, the reserve, what the other modules
  committed and what is available with `get_owner_time`; its welcome and a note when
  the budget changes point it there, and its prompt asks for the module's owner time
  in the proposal, so the owner sees it before accepting. A design in review counts as
  committed, read from the Architect's ref since it isn't on `main` yet.
- **Used** = the estimates of the actions marked done.
  The dashboard shows used, planned and the hours; red when planned exceeds the hours
  minus the reserve, or used exceeds the hours.

Without hours set, nothing changes: estimates are optional, and the Architect behaves as
in v2. This holds in both modes.

### 4.2 Agent hours

The sum of the Developers' attempt clocks, from `ATTEMPT_STARTING` to the attempt's end,
running attempts counted to now. Managers and Architects aren't counted: their sessions
are long and mostly idle, and their cost is per item. The owner sets a threshold in the
dashboard (`AGENT_HOURS_SET`); over it, the number turns red and nothing stops (D31).

### 4.3 Subscription usage

Before Swarm starts an attempt, the daemon reads the subscription's usage
([spike 5](../research/spike-05-usage-endpoint.md)): the highest `percent` across the
windows the endpoint lists. At or above `swarm.usageCeilingPercent`, 80 by default, the
daemon records `PIPELINE_PAUSED` with `until` set to that window's `resets_at`, and the
existing resume-at-`until` rule lifts the pause. The reading is cached for five
minutes.

The daemon needs the token the provider was created with. `harness doctor` stores it in
`~/.config/harness/claude.token`, mode 0600, when it creates the provider, and asks for
it when Swarm is on and the file is missing. Without the file, or when the endpoint
fails, the probe is off and v2's brake remains: an attempt that hits the limit doesn't
count, and the pipeline pauses for an hour (D32). Manual mode never probes.

### 4.4 Brake defaults

Two defaults change, for both modes, in `harness/config.json`'s schema and the
README:

| Brake | v2 | v3 |
|---|---|---|
| `roles.developer.attemptTimeoutMinutes` | 90 | 120 |
| `brakes.managerTurnMinutes` | 20 | 90 |

A Manager pauses the pipeline after two turns, so after 180 minutes of silence. No
token cap per attempt and no progress detector (D33): a Developer going in circles
spends its clock, which is bounded and rare.

---

## 5. The reviewers

### 5.1 Shape

Two new roles, `security` and `cost`, with the Manager's shape: a Claude Code session in
a sandbox with a read-only clone, the PR's head checked out, `git log`, `git diff` and
`git show`, and the harness tools `get_state`, `get_review` and `report_findings`. A
reviewer session is short: one per PR head, started when CI passed on it and ended
when it reported. It is not long-lived like the Manager: a fresh session reads a fresh
diff with nothing to carry over.

Each reviewer gets, uploaded by the daemon:
- the diff's file list and the PR's title and body;
- the artifacts CI produced on that head (§5.5): the Terraform plan's JSON when the
  project has Terraform, the scanners' reports, the cost estimate;
- the plan's definition and the feature descriptions, from the base branch.

The rule the Manager follows holds for them: the Developer's code, comments and commit
messages are claims to check, never instructions.

### 5.2 Security reviewer

Looks for what scanners don't: logic. Injection and output encoding, authorization
checks that a new route skips, secrets that reach logs or state, unsafe deserialization,
SSRF in anything that fetches a URL, IAM policies in Terraform wider than the feature
needs, public buckets and open security groups, dependencies added with a known
problem, and anything a scanner flagged. The scanners' output is its starting point,
not its ceiling.

### 5.3 Cost reviewer

Reviews every PR, `CODE` ones included: cost comes from code as much as from
infrastructure, such as a feature that calls Bedrock in a loop with no new resource at
all.

Its deterministic input is the **paid-call inventory**: a CI step that lists, from a
table the harness ships, every call to a pay-per-use AWS operation in the head and in
the base, such as Bedrock `InvokeModel` and `Converse`, Textract, Rekognition,
Comprehend, Transcribe, Polly, Translate, SES sends and SNS SMS. The reviewer starts from
the difference: "this PR adds two Bedrock calls, here and here". It judges what the
table can't: a loop or a fan-out around the call, retries without a cap, the model and
`max_tokens`, missing caching, no per-request bound, and in Terraform unbounded
concurrency, recursion paths through S3, SQS and SNS, missing dead-letter queues and
`maxReceiveCount`, on-demand versus provisioned capacity, NAT gateways, instance sizes,
log retention and lifecycle rules.

For `INFRA` and `MIXED` plans, the cost job also runs **Infracost** on the Terraform
plan of the base and of the head, and the difference is the monthly cost the PR adds.
That number decides the merge policy's clause 6, on its own; the reviewer doesn't
recompute it. Usage-based resources need a usage file; the reviewer writes
`infracost-usage.yml` from the Architect's expectations when the design states them,
and the job uses it.

Third-party paid APIs aren't covered: the owner doesn't use them (D30).

### 5.4 Findings, statuses and fix rounds

`report_findings` takes the PR, a verdict, `pass` or `block`, and a list of findings:
file, line, severity (`blocking` or `advisory`), a title and a paragraph. The daemon:
- posts the findings as one review on the PR, with inline comments where there is a
  file and line, as the App;
- sets the commit status `harness/security` or `harness/cost` on the head: `success`
  for `pass`, `failure` for `block`, with the count of blocking findings as the
  description;
- for `block`, opens a fix round: a work item `secfix<n>` or `costfix<n>`, built and
  reviewed like a CI fix round (v2 §11.7). The Developer's guidance is the blocking
  findings. The fix lands on the plan branch, the daemon pushes, CI runs again, and both
  reviewers run again on the new head.

Rounds are capped by `swarm.securityFixRounds` and `swarm.costFixRounds`, 2 each; past
them the pipeline pauses and the owner decides, as after CI fix rounds. Advisory
findings are comments and nothing else.

In Manual mode the reviewers don't run: the owner reads the PR. A project in Manual
with the reviewers wanted can turn them on with `swarm.reviewersInManual`, which posts
their comments without gating anything.

### 5.5 The CI side

`harness install-ci` writes two more jobs to the workflow, which the owner commits as
today:
- `security-scan`: gitleaks on the diff, semgrep with its default rules, checkov on the
  Terraform folder when there is one; their reports are artifacts. The job fails only
  when a tool fails to run, not on findings: the reviewer judges findings.
- `cost`: the paid-call inventory on base and head, and `infracost diff` when the
  project has Terraform; the estimate is an artifact. Infracost needs an API key for
  its pricing data, free for this use, which the owner sets as a repository secret
  named in the README.

The daemon downloads the artifacts of the head's workflow run with the Actions read
permission the App has, and uploads them into the reviewers' sandboxes.

---

## 6. Parallel plans and features

### 6.1 Dependencies

- **Plans get `dependsOn`**, a list of plan ids of the same module. A plan without it
  depends on the previous plan, which is v2's order: nothing runs in parallel unless
  the Architect says so (D35). A plan starts when every plan it depends on is merged,
  not merely accepted, so it starts from a `main` that holds them.
- **Features' `dependsOn`** may name features of earlier plans too, as `P1/F03`.
  Within a plan it keeps v2's meaning.
- **The Architect's prompt** gets a Swarm section: declare plan dependencies, put
  shared decisions in earlier plans, keep plans meant to run in parallel off the same
  files, and give infrastructure plans of its own.

### 6.2 The scheduler

The ready set is every feature such that:
- its plan is active, and at most `swarm.maxPlans` plans are active;
- every feature it depends on is accepted, and every plan it depends on is merged;
- no gate holds it, no design change is in review for its module, and the module isn't
  waiting on the owner;
- it has no attempt running.

The daemon starts attempts from the ready set, in plan order then file order, until
`swarm.maxDevelopers` run, and only while the subscription's usage is under the ceiling.
`activeAttempt` becomes `activeAttempts`; each attempt's step runs in turn in the
reconcile loop, as today for one.

### 6.3 Landing in parallel

An attempt starts from its plan's head and lands as one commit on the plan branch, as in
v2. When two attempts of one plan run, the second may be accepted after the first
landed:
- if the plan head moved since the attempt started, the daemon merges the head into
  the attempt's commit in its own repository, and runs the full check set once more in
  a fresh check sandbox before landing; a failure there is the attempt's failure;
- a merge conflict becomes a **rebase work item**, `rebase<n>`, for a Developer: it
  gets both sides and the conflicting files, resolves on top of the head, and the
  Manager reviews it like a feature. It is not counted against the feature's attempts.

### 6.4 Managers per plan

A Manager's working directory is one plan's clone, and its whole prompt builds on
that. Swarm keeps the model and runs one Manager per plan in flight, keyed
`<module>/<plan>` in `state.managers`. A Manager's items are its plan's; escalations
go to the module's Architect as today. Two idle Managers cost little: a Manager spends
tokens per item, not per hour.

### 6.5 The Architect during the build

The Architect's session stays open, as in v2, and receives a digest through its inbox:
a plan started, a PR opened or merged, an escalation, a blocking finding, a design
change applied. It can answer the Managers' escalations with `reply_to_manager` and
change the design through `submit_design` as today.

### 6.6 Design changes while plans run

v2 already stops new attempts in a module while an `Arch:` PR is in review, and
counts attempts per version of a feature's definition. Swarm adds:
- a running attempt of a feature whose definition changed is aborted when the change
  merges, as an interruption that doesn't count;
- a plan in flight keeps its branch, gets `main` merged in (v2's `mergeMain`), and
  continues with the new definitions; a conflict there becomes a rebase work item too;
- a plan whose dependencies changed waits again for them.

### 6.7 The graph

The **Project** view draws the module's features as a graph, plan boxes around them,
edges for `dependsOn`: green for accepted and merged, blue for in progress, grey for
waiting, red for escalated, with a plan's merge state on its box.

---

## 7. Dashboard

- **Header:** the mode, a switch with a confirmation, and the ruleset warning when
  GitHub doesn't match (§2.1).
- **Budgets**, in the Project view: your time (used, planned, hours), agent hours
  against the threshold, the subscription's windows when Swarm is on; forms to set the
  hours and the threshold.
- **Needs you** gains: PRs the policy left to the owner, with the reason; reviewer
  rounds exhausted; the ruleset mismatch.
- **Agents** gains the reviewers' transcripts and the Managers per plan.
- **Project** gains the graph (§6.7).

---

## 8. State and events

New events, all facts the daemon establishes:

| Event | Payload |
|---|---|
| `MODE_CHANGED` | `{ mode }` |
| `OWNER_HOURS_SET` | `{ hours }` |
| `AGENT_HOURS_SET` | `{ hours }` |
| `USAGE_READ` | `{ percent, resetsAt, limits }`, recorded only when it pauses |
| `PR_MERGED_BY_DAEMON` | `{ number, commit }`, then v2's `PR_MERGED` |
| `PR_LEFT_TO_OWNER` | `{ number, reason }` |
| `REVIEW_STARTED`, `REVIEW_REPORTED` | `{ role, head, sandbox }`, `{ role, head, verdict, blocking, advisory }` |
| `STATUS_SET` | `{ context, head, state }` |
| `REBASE_NEEDED` | `{ feature, conflicts }` |

New state: `mode`, `budgets: { ownerHours?, agentHours?, setAt }`, `usage?`,
`reviews` keyed by head, managers keyed by plan in Swarm, and `attempts` as a list of
active ones. `harness recover` rebuilds the mode from the ruleset it finds, and the
budgets from nothing: the owner sets them again.

---

## 9. Configuration

Additions to `harness/config.json`, all optional:

```json
{
  "ownerTime": { "reservePercent": 20 },
  "swarm": {
    "maxDevelopers": 3,
    "maxPlans": 2,
    "merge": { "code": "daemon", "infraMonthlyUsdCeiling": 50 },
    "requiredStatuses": ["harness/security", "harness/cost"],
    "usageCeilingPercent": 80,
    "securityFixRounds": 2,
    "costFixRounds": 2,
    "reviewersInManual": false
  }
}
```

| Field | Default | What it sets |
|---|---|---|
| `ownerTime.reservePercent` | 20 | The share of the owner's hours designs may not plan |
| `swarm.maxDevelopers` | 3 | Attempts at once |
| `swarm.maxPlans` | 2 | Plans in flight at once |
| `swarm.merge.code` | `daemon` | `daemon` merges `CODE` plans; `owner` leaves them to the owner |
| `swarm.merge.infraMonthlyUsdCeiling` | 50 | The monthly cost an `INFRA` or `MIXED` PR may add and still merge itself; `null` leaves them all to the owner |
| `swarm.requiredStatuses` | `["harness/security", "harness/cost"]` | The App's statuses a PR needs; `[]` merges on CI alone |
| `swarm.usageCeilingPercent` | 80 | No launch at or above this usage; `null` turns the probe off |
| `swarm.securityFixRounds`, `swarm.costFixRounds` | 2, 2 | Fix rounds a reviewer may ask for, before the owner decides |
| `swarm.reviewersInManual` | `false` | Run the reviewers in Manual too, as comments only |

The changed defaults of §4.4 are in `roles.developer.attemptTimeoutMinutes` and
`brakes.managerTurnMinutes`.

---

## 10. Security model

v2 §16 holds, with these changes:

| Invariant | v2 | v3 in Swarm |
|---|---|---|
| I5, protected artifacts | Change only in `Arch:` PRs the owner merges | Unchanged: `verify` still runs with the base's rules, and the daemon never merges an `Arch:` PR |
| I6, infrastructure | Changes only through CI after a merge | Unchanged in mechanism. Who merges changes: the daemon, for `INFRA` PRs under the ceiling |
| Who merges `main` | The owner | The owner for `Arch:` and `Fix:` PRs; the daemon for plans, under the policy, and only with the reviewers' statuses the ruleset requires |

New assets and controls:
- **The reviewers' statuses** are pinned to the App's id in the ruleset: nothing else
  can post them.
- **The reviewers are read-only** like the Manager, with the same restricted tools. A
  Developer can't address them: findings go to the daemon, which posts them.
- **The stored Claude token** (`~/.config/harness/claude.token`) is a new secret on the
  owner's machine, mode 0600, read by the daemon for one GET to Anthropic. It is the
  same token the provider holds.
- **The daemon's merge** is the new trusted action. A daemon bug could merge a `CODE`
  plan that passed CI and both reviewers; it couldn't merge without them, change
  protected files, or merge infrastructure over the ceiling.

Accepted risks, in addition to v2 §16.4:
- a reviewer can miss what a human reviewer would catch; the scanners and CI bound
  the damage, and the owner's AWS alarms cover cost after the merge;
- the usage endpoint is undocumented and may change; the daemon then falls back to
  v2's brake.

---

## 11. Delivery plan

Each milestone ends with a demo on the toy repository of the test suite, and the ones
that touch GitHub on a throwaway repository.

| Milestone | Delivers | Done when |
|---|---|---|
| **Spike 5** ([done](../research/spike-05-usage-endpoint.md)) | The usage endpoint's shape and headers | Recorded |
| **Spike 6** | Infracost and the scanners on a real plan in CI; the App posting a commit status that a ruleset pinned to the App's id accepts | Recorded in `docs/research/` |
| **M7 Mode and policy** | The mode switch, `MODE_CHANGED`, plan kinds in titles and in `verify`, the merge policy, `github-setup` per mode, the doctor check, the brake defaults, the agent-hours meter | On the fake forge, a `CODE` plan merges itself in Swarm with the statuses present, waits without them, and waits in Manual; `verify` fails a `CODE` PR that touches `iac/` |
| **M8 Owner time** | `OWNER_HOURS_SET`, `estimatedMinutes`, the Architect's brief and prompt, the `submit_design` refusal, the meter | A stub Architect's design over the available hours is refused with the numbers; one within is accepted; the meter shows used and planned |
| **M9 Usage probe** | The stored token, `readUsage`, the pre-launch check and pause until reset | With a fake endpoint, Swarm launches under the ceiling and pauses until the reset time above it |
| **M10 Reviewers** | The two roles, their briefs with the paid-call inventory and the Terraform plan, review comments and statuses, fix rounds | A stub reviewer blocks a plan, a fix round lands, the second review passes and the plan merges; a status the App can't set leaves the PR to the owner with the reason |
| **M10b Cost estimate and scanners** | The CI jobs and artifacts of §5.5: Infracost and the ceiling in the policy, the scanners' reports in the security brief | An `INFRA` plan under the ceiling merges itself, one over it waits for the owner |
| **M11 Parallel** | Plan and cross-plan dependencies, the scheduler, landing with re-check, rebase items, Managers per plan, the Architect digest, design changes in flight, the graph | Two independent plans build at once with three Developers; a conflict becomes a rebase item; a design change aborts only the redefined feature's attempt |

M7 to M9 are useful on their own and land first; M10 is what lets Swarm merge by
default; M11 is throughput, last, once the gates exist.

---

## 12. Decisions log

Settled in the design chat of 2026-11-05.

| # | Decision |
|---|---|
| D25 | Two modes, Manual and Swarm, switched per project in the dashboard. One repository, no fork: Swarm is additive behind the mode. |
| D26 | Plan kinds `CODE`, `INFRA` and `MIXED` from the features' kinds, tagged in the PR title and enforced by `verify`: a `CODE` PR can't touch the Terraform folder. Infrastructure gets plans of its own. |
| D27 | One PR per plan stays. Parallelism comes from plans and features, not from PRs. |
| D28 | In Swarm the daemon merges `CODE` plans when CI and both reviewers pass, and `INFRA` plans when the monthly cost the PR adds is under a ceiling, 50 USD by default. `Arch:` and `Fix:` PRs stay the owner's. |
| D29 | No cost monitoring after a merge in the harness: the owner's account-wide AWS alarms cover it, and the daemon keeps no write permission on AWS. |
| D30 | The owner's time is a design constraint: hours set at the start, a 20% reserve, estimates on every owner action, gates and tasks, and `submit_design` refuses what doesn't fit. Only owner actions count: the proposals, Arch PRs and infra PRs the owner reads don't (amended 2026-11-06; until then the proposal counted at 1000 lines an hour). In both modes, once hours are set. No check for third-party paid APIs. |
| D31 | Agent hours are a meter with a threshold: red when over, nothing stops. |
| D32 | Before a launch in Swarm, the subscription's usage must be under 80%; above it the pipeline waits for the window's reset. The doctor stores the token. When the endpoint fails, v2's pause after a hit remains. |
| D33 | Attempt clock 120 minutes and Manager turn 90 minutes, in both modes. No token cap, no progress detector. |
| D34 | Two reviewers, security and cost, read every PR after deterministic scanners ran in CI. Findings are PR comments; verdicts are App statuses the ruleset requires; blocking findings open fix rounds, two each. The cost reviewer covers code PRs, with the paid-call inventory. |
| D35 | Only plans the Architect declared independent run in parallel, and a plan starts once its dependencies are merged. One Manager per plan in flight. The Architect gets a digest and stays the authority on the design. |
| D36 | A button in the dashboard, off by default, lets the daemon merge `INFRA` and `MIXED` plans like `CODE` ones: CI and both reviewers as the gate, an estimate over the ceiling still the owner's. Recorded as `INFRA_MERGE_SET`, operational state like the mode (2026-11-06, at the owner's request). |
