# M5: an infrastructure feature from design to a verified deploy

Checked 2026-10-11 on `razzou-labs/harness-sandbox`, with OpenShell 0.1.2, Claude Code
2.1.295 and Terraform 1.16.3. Haiku 4.5 played the Architect, the Manager and the
Developer. The owner merged the Arch PR and the plan PR. CI planned with the plan role
and applied with the apply role, both through OIDC. Agents saw AWS only through the
view role, whose requests the OpenShell proxy signed.

## Setup

- **AWS.** `terraform-bootstrap` onboarded the repository with `harness = true`: plan
  and apply roles, and a view role.
  `configure-github.sh` created the `staging` environment, which only `main` may use,
  and published the role ARNs as repository variables. The owner typed the
  `harness-gateway` key at a hidden prompt, into the project's OpenShell AWS provider.
- **The repository.** It got an empty Terraform configuration in `iac/` with its backend
  config and variables, `aws` and `terraform` sections in `harness/config.json`, and the
  M5 workflow. Its first apply on `main` had nothing to create. The ruleset now requires
  `tf-plan` too.

## Timeline (UTC)

| Time | Event |
|---|---|
| 06:38:42 | `harness module new artifacts "An S3 bucket for build artifacts"`. |
| 06:40:18 | Without asking anything, the Architect submits proposal v1: one plan, one infra feature, five resources. |
| 06:41:26 | `harness accept artifacts v1`. The Architect sees it with the owner's next prompt. |
| 06:53:20 | The design is validated, and Arch PR #5 opens. Its plan assertion failed on the unbuilt repository, against a real plan, as it should. |
| 06:54:22 | CI passes on the Arch PR: `verify`, `tf-plan` (no changes) and `checks`. |
| 07:33:04 | The owner merges. The build starts at 07:33:23. |
| 07:34:35 | The Developer finishes in 67 seconds, 23 turns and $0.12. It planned against the real state as the view role, and ran the plan assertion itself. |
| 07:34:53 | A check sandbox makes its own plan, and `F01-plan` passes, 5 tests of 5. |
| 07:35:05 | The Manager accepts F01. |
| 07:35:39 | Plan PR #6 opens. |
| 07:37:07 | CI passes: `tf-plan` with the plan role ("5 to add"), `checks` with the plan's JSON (`F01-plan`, 5 of 5) and `verify`. |
| 07:37:20 | The owner merges. |
| 07:39:04 | `tf-apply` creates the five resources. The lifecycle configuration alone takes 57 seconds. |
| 07:39:06 | The daemon records the deploy. |
| 07:39:12 | `F01-deployed` passes in a check sandbox, as the view role, against the real bucket: `PLAN_VERIFIED`. |

The bucket stays in staging, empty.

## The probe

`harness probe` builds a sandbox like a Developer's, with the AWS provider, and tries
everything it must not do. All 12 tests pass:

| Test | Result |
|---|---|
| Credentials in the sandbox | Four variables, all placeholders |
| An allowed host (the control) | 200 |
| `169.254.169.254` | Unreachable |
| A host that isn't listed | Unreachable |
| A `POST` to a read-only host | 403, from the proxy |
| `git push` (a `POST` to `git-receive-pack`) | 403, from the proxy |
| The owner's home folder | Absent |
| `sts get-caller-identity` | The view role |
| `ec2 create-tags`, as a dry run | `UnauthorizedOperation` |
| `secretsmanager get-secret-value` | `AccessDenied` |
| Another project's state | `AccessDenied` |
| The project's own state | Readable |

The probe itself had two bugs, both found by this run:
- **The program a rule covers.** A network rule covers a process only if the process,
  or one above it, is a listed program: Claude Code, bash or dash. Given a single
  command, `bash -c` replaces itself with that command, which then has no listed
  ancestor. OpenShell refused it, whatever the host: the two `POST`s got `000`
  instead of `403`, and the "unreachable" results proved nothing. Agents aren't
  affected, since all their commands run under Claude Code. Check scripts aren't
  either, since the runner's `cd … && timeout …` keeps bash above them. The probe now
  keeps bash as the parent.
- **Missing keys.** A role that may list a bucket gets 404 for a key that doesn't
  exist, even under an explicit deny. The probe's made-up key proved nothing. It now
  lists the state bucket, and tries another project's state that exists: refused. A
  missing key leaks nothing here, since the role may list the bucket anyway (for
  `terraform init`).

The view role could also read the configuration of another project's bucket: its
versioning, encryption, public access block and lifecycle rules. These are the reads
`F01-deployed` makes.

## Bugs caught on the way

- **`tf-apply` never ran.** On `main`, `tf-plan` is skipped, and GitHub skips every job
  downstream of a skipped job, unless its condition checks the results itself. The
  workflow's `tf-apply` now says
  `!cancelled() && github.event_name == 'push' && needs.checks.result == 'success'`.
- **A failed plan could be merged.** When `tf-plan` fails, `checks` is skipped, and
  GitHub counts a skipped required job as passed. So `tf-plan` is a required check as
  soon as `harness/config.json` has a `terraform` section, both for the ruleset and for
  the daemon's reading of CI.
- **The roles didn't explain infrastructure.** The Architect's role now says what
  `needs: ["tfplan"]` and `needs: ["aws"]` give a check. The Developer's role now says
  how to plan against the real state, and how to run a plan assertion by hand. The
  Developer followed it step by step: `init` with the backend config,
  `plan -lock=false`, `show -json`, the check with `HARNESS_PLAN_JSON`, `fmt` and
  `validate`.

## Other observations

- **The Architect waits for the owner.** After `harness accept`, the Architect sees the
  acceptance only with the owner's next prompt, as in M4. Here it waited ten minutes.
  The M6 dashboard should prompt it when the owner accepts.
- **Detecting the merge took a minute; detecting the deploy, two seconds.** The daemon
  recorded the merge a minute after it happened, at the next pull request poll. It then
  noticed `tf-apply`'s end two seconds after it finished.
- **No plan on `main`.** In the merge's CI run, `checks` skips `F01-plan` with a notice,
  because a push makes no plan.
- **Untested here.** This run didn't exercise a failed apply or a failed post-deploy
  check, which lead to a `Fix:` PR. Only the tests, with stub agents, cover them.
