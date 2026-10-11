# M4: a module from requirements to a merged Arch PR, then built

Checked 2026-10-11 on `razzou-labs/harness-sandbox`, with OpenShell 0.1.2 and Claude
Code 2.1.295. Haiku 4.5 played the Architect, the Manager and the Developers. The owner's
side of the conversation was typed through a pseudo-terminal, as the dashboard will do.
The owner merged the Arch PR.

## The Architect's terminal

- **The main command can have a terminal.** Spike 4 found that a sandbox created with a
  command gets none, but it hadn't tried `--tty`. With `--detach --tty -- <command>`,
  the command runs on `pts/0`, and `openshell sandbox connect` attaches to that terminal:
  the shell reached through `connect` reported the main command's PID. `stop` then
  `start` ran the command again with a terminal. So the Architect's sandbox runs a
  command that waits for the launcher, then `exec`s it. No `.bash_profile` hook is
  needed, and `--env` values reach the command.
- **No first-run screens.** A `~/.claude.json` with onboarding done, a theme, the
  bypass-permissions warning accepted and the clone trusted made the terminal open
  straight on the conversation.
- **The welcome message,** given as the first launch's prompt, made the Architect read
  the repository and greet the owner before anyone attached.
- **The harness MCP tools work in the interactive interface:** `submit_proposal` and
  `submit_design` were called from it.
- **The inbox hook works:** after the owner accepted v1, the hook consumed the
  acceptance note (233 bytes) with the next prompt.
- **Questions came as plain text.** Haiku asked its two clarifying questions in prose,
  not through `AskUserQuestion`.

## Timeline (UTC)

| Time | Event |
|---|---|
| 23:39:08 | `harness module new notes "A command-line notes tool"`: the module is created. |
| 23:39:10 | The Architect's launcher is in place, and Claude starts in its terminal. |
| 23:42:13 | After two questions, the Architect submits proposal v1 (a scoped `add`/`list` notes CLI). |
| 23:43:46 | `harness accept notes v1`. |
| 23:44:46 | The design is validated, its new checks fail on the unbuilt repository as they should, and the hash list is committed: Arch PR #3 opens. |
| 23:45:55 | CI passes on the Arch PR (`verify` with the Arch rules, `checks`). |
| 23:49:46 | After the owner's review comment, the Architect fixes its checks and resubmits. The same PR updates, by fast-forward. |
| 23:57:43 | The owner merged. The daemon starts building `notes/P1` from `main`. |
| 23:57:48 | `DESIGN_FROZEN` is recorded, and the Architect's clone moves to the new `main`. |
| 23:59:01, 23:59:59 | The Manager accepts F01, then F02, each on its first attempt. |
| 00:00:12 | Plan PR #4 opens. |
| 00:00:59 | CI passes on it, running `F01-add` and `F02-list`. |

## A real bug, caught on the way

The Architect's first check scripts ran `node /sandbox/work/src/notes.js`. They pass in
every harness sandbox, but GitHub Actions checks the repository out elsewhere. Plan PR
#4's CI would have failed, and no fix round could have repaired a protected check.
- **The fix in the harness.** `submit_design` now refuses any check that mentions
  `/sandbox/`, and the Architect's role says to use paths from the repository root.
- **In this run,** the owner's review comment made the Architect fix the scripts, and
  plan PR #4's CI then ran them green.

## Other observations

- **When the build starts.** The build started as soon as the merged design reached
  `main`, a few seconds before the Arch PR poll recorded `DESIGN_FROZEN`. `main` is the
  source of truth, so this is fine.
- **The hash-list commit goes back to the Architect.** The daemon's commit is synced into
  the Architect's branch after each submission, so a resubmission pushes as a
  fast-forward, and the open PR updates instead of a second one opening.
