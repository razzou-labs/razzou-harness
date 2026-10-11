# M3: plans as pull requests on GitHub

Checked 2026-10-11 with the M3 daemon on `razzou-labs/harness-sandbox`, a private
throwaway repository. Haiku 4.5 played the Manager and the Developer.

## Setup

- **The App.** `harness github-app create --org razzou-labs` served a page on 127.0.0.1
  that posted the manifest to GitHub. One click created `razzou-labs-harness`, and the
  redirect brought back a one-time code. The harness exchanged it for the App's id and
  private key, stored in `~/.config/harness/` with mode 0600. The App has no webhook.
  - Its permissions are exactly those of proposal v2 §11.4: contents and pull requests
    read and write; checks, actions, statuses and metadata read.
  - The owner installed it on `harness-sandbox` only. `harness github-app check`
    confirmed that, and that a token could be minted.
- **The repository.** `install-ci` wrote the workflow, the CI script and `CODEOWNERS`,
  and `lock` wrote `harness/lock.json`. The owner's first commit was pushed with the
  owner's own credentials, since the App may not touch workflows.
- **The rules.** `github-setup` applied, with the owner's `gh` login:
  - merge commits only, titled and described by the PR;
  - a ruleset on `main` requiring a PR, one code-owner approval, and `verify` and
    `checks` from GitHub Actions (integration 15368, so no other App can post them);
  - no force pushes or deletion.

  Rulesets on private repositories need a paid GitHub plan, such as Team.

## The plan's pull request

| Time (UTC) | Event |
|---|---|
| 23:04:18 | The daemon starts and fetches `main` from GitHub as the App. |
| 23:05:13, 23:06:10 | The Manager accepts F01, then F02, after their checks passed locally. |
| 23:06:13 | The full check run passes on the plan branch. |
| 23:06:18 | The Manager calls `submit_plan`. |
| 23:06:20 | The daemon pushes `plan/greeter/P1` as the App. |
| 23:06:22 | The daemon opens PR #1, "Plan: greeter/P1 — Two small Node commands", as `app/razzou-labs-harness`. |
| 23:07:05 | CI passes: `verify` and `checks`. |

- **Commits.** The PR has one commit per feature, authored by `Developer (harness)`.
- **CI.** The `checks` job read `progress.txt` and ran exactly `F01-greet` and
  `F02-sum`. `verify` judged the PR with the rules of the base branch.
- **Merging.** GitHub showed the PR as blocked until the owner reviews it, as the
  ruleset requires.

## A change to a protected file fails `verify`

As the App, a script pushed `plan/greeter/P9` with one commit changing
`harness/modules/greeter/checks/F01.sh` to `true`, and opened PR #2, "Plan: greeter/P9 —
tamper test". The daemon itself would have refused to push this: it runs the same rules
first.

- `verify` failed: *changes a protected file: harness/modules/greeter/checks/F01.sh*.
- `checks` passed. A weakened check passes, and that is the case `verify` exists for.
- The PR was blocked, then closed, and its branch deleted.

## Hardening found on the way

- **The daemon's git ignores the owner's git configuration** (`GIT_CONFIG_GLOBAL=/dev/null`,
  `GIT_CONFIG_NOSYSTEM=1`). A credential helper such as `gh auth setup-git`, or an
  `insteadOf` rule, could otherwise turn the App's push into the owner's.
- **The App's token travels in git's environment-based config,** never on a command line
  that `ps` shows.
- **`~/.config/harness/` was group-writable,** left over from v1. It is now mode 0700.
