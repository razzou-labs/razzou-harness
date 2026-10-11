# M6: a fresh project, set up from the checklist and built from the dashboard

Checked 2026-10-11 on `razzou-labs/harness-fresh`, a new private repository. The
package was installed from its tarball into a separate prefix, with OpenShell 0.1.2 and
Claude Code 2.1.295. Haiku 4.5 played every role. The owner installed the App on the
repository and merged the pull requests. Everything else went through the installed
`harness` command and the dashboard. In the dashboard, Claude Code, the agent building
the harness, played the owner through a headless browser. There was no AWS in this
project.

## Setup from the checklist

The machine wasn't fresh: it had run M1 to M5. So Docker, OpenShell and its gateway,
the Claude provider and the GitHub App were already in place. `harness doctor` checked
them instead of setting them up. Setup on a clean machine is still untested.

1. **The package.** `npm pack` builds the CLI and the dashboard. The README's command
   installs it: `npm install -g ./razzou-harness-0.1.0.tgz --allow-scripts=node-pty`.
   node-pty is an optional dependency, loaded only for terminals. On Linux it compiles
   with node-gyp, because its prebuilt binaries are only for macOS and Windows. Without
   the flag, npm 11.19 warns about its install scripts but still runs them. Without
   node-pty, the dashboard has no terminals, and `harness doctor` says so.
2. **`harness init`** wrote the project's files:
   - `harness/config.json`, the workflow, the CI script and `CODEOWNERS`;
   - `README.md`, `ARCHITECTURE.md` and `init.sh`;
   - the `.gitignore` entry and `harness/lock.json`.

   It printed the checklist, and read the repository from the `origin` remote, the bot
   from the App's settings, and the code owner from `gh`. The three roles were then set
   to Haiku, and the files were committed and pushed to `main`.
3. **`harness github-setup`** set merge commits only, and the ruleset: PRs only, one
   approval from a code owner, and `verify` and `checks` green.
4. **The owner installed the App** on the repository. This was the only step that
   needed them.
5. **`harness doctor --probe`** was all green: 15 setup checks and 17 probe checks.
   - **Every role's sandbox** (Developer, Manager and checks; Architect):
     - the credentials are placeholders;
     - an allowed host answers, as the control;
     - the metadata address and an unlisted host are unreachable;
     - a `POST` to a read-only host and `git push` get 403 from the proxy;
     - the owner's home folder isn't there.
   - **From outside:**
     - `web_read` refuses a private address;
     - GitHub refuses a workflow pushed by the App;
     - `main` needs a code owner's approval.
6. **CI on `main`** passed on the first push. `harness up` started the daemon.

On `harness-sandbox`, which has AWS, the same installed `doctor --probe` passed 27 probe
checks in 24 seconds. For each role it adds:
- AWS answers as the view role;
- it refuses an EC2 write and a secret's value;
- it refuses another project's state;
- the project's own state is readable.

## Timeline (UTC)

| Time | Event |
|---|---|
| 11:28:05 | The owner starts module `greeter`, "A greeting command-line tool", from the dashboard's Project view. They talk with the Architect in its terminal, in the browser. |
| 11:29:28 | The Architect proposes v1. |
| 11:31:06 | The owner accepts it with the dashboard's button. The daemon types a prompt into the Architect's terminal. |
| 11:31:43 | The design arrives 37 seconds later, without anyone typing. Arch PR #1 opens at 11:31:49, and its CI passes at 11:32:52. |
| 12:38:38 | The owner merges Arch PR #1. The plan starts 14 seconds later. |
| 12:39:58 | The Developer asks the Manager about a bug in the Architect's check. |
| 12:40:06 | The Manager escalates to the Architect, and answers the Developer. |
| 12:40:22 | The Developer stops, blocked, without touching the protected check. Attempt 1 counts as failed. |
| 12:40:30 | The Manager asks the owner too, with a blocking question. |
| 12:40:40 | Prompted by the daemon, the Architect fixes the check and submits a design change. Arch PR #2 opens at 12:40:45. |
| 12:40:57 | The Architect's decision reaches the Manager, which asks for another attempt with guidance. |
| 12:54:13 | The daemon restarts with the fixes below. |
| 12:55:23 | The owner answers the Manager, in Needs you. The design change still holds the build. |
| 14:57:30 | The owner merges Arch PR #2. |
| 14:57:41 | The daemon merges `main` into `plan/greeter/P1`. |
| 14:58:28 | Attempt 2 starts on the merged base, with the fixed check and a fresh attempt budget. |
| 14:59:10 | The Developer finishes in 36 seconds, 17 turns and $0.08. The check passes at 14:59:12. |
| 14:59:22 | The Manager accepts F01. The plan's checks pass at 14:59:25. |
| 14:59:36 | Plan PR #3 opens. Its CI passes at 15:00:12. |
| 15:19:07 | The owner merges PR #3. CI on `main` passes. |
| 15:21:56 | The daemon records the merge, and the plan is complete. The Manager stops, since its module has no plans left. Nothing needs the owner. |

`src/greet.js` on `main` prints `Hello, Ada!` for `node src/greet.js Ada`, and the usage
with exit code 1 without a name.

## The check defect

The Architect's check, `F01-greeting.test.mjs`, imported `resolve` from `node:path`. It
also named its Promise's parameter `resolve`, which hides the import, so the check ran
`node undefined`. Nothing caught this at design time. Before anything is built, a broken
check fails just as a correct one does. The Developer was the first to run it against
real code.

The agents handled it as intended:
- **The Developer** found the bug and asked the Manager. It then stopped, blocked,
  without editing the protected file.
- **The Manager** asked the Architect, and the owner too.
- **The Architect**, prompted by the daemon, fixed the check in a design change
  34 seconds after the escalation.

The harness itself had no way to bring that fix into the build. The run exposed four
gaps, all now fixed and tested:
- **The plan branch never took the fix.** §11.3 says the daemon merges `main` into a
  plan branch when a design change moves it, but that wasn't implemented. Now, before
  the next work item, the daemon merges `main` into the plan branch if `main` has moved.
  It does this with `git merge-tree`, with nothing checked out. A plan branch with
  nothing of its own yet is fast-forwarded instead. A conflict pauses the pipeline and
  names the files.
- **The budget wasn't fresh.** §7.1 says features whose definitions change get fresh
  attempts. The definition hash covered only the feature's JSON, so a fixed check
  script didn't count. The hash now includes the design files its checks run.
- **Nothing waited for the merge.** The Manager's retry would have started attempt 2 at
  once, on the broken check, and used up the budget. Now no new attempt starts in a
  module while a design change is submitted or in review. If the owner closes its Arch
  PR, the module returns to `frozen`, with the design it had. Before, it went back to
  `decomposing`.
- **Escalated features.** A feature that a design change redefines starts again without
  waiting for the owner's retry.

Needs you now titles the review "A change to the design of greeter is ready for review",
and says that no new attempt starts until it's merged or closed.

## The dashboard

- **Views.** Needs you, Project, Agents and Events, built with React and Vite. The
  package ships them, and the daemon serves them.
- **The Architect's terminal** runs in the browser. xterm.js connects over a WebSocket
  to `openshell sandbox connect`, under node-pty. Every viewer and the daemon share it.
- **A shell** is available in any running sandbox.
- **The Architect is prompted.** When the Architect has new messages and no one is
  watching its terminal, the daemon types `[harness] New messages for you.` into it.
  Its prompt hook then delivers the messages. In M4 and M5, the Architect saw messages
  only with the owner's next prompt. Here it answered within 40 seconds, both times.
- **Owner actions.** The owner can:
  - accept a proposal, answer a question, and mark owner tasks done;
  - decide an escalated feature;
  - message the Manager, or type to the Architect;
  - pause and resume the pipeline.
- **Live transcripts** replace M1's activity list. They show each agent's stream-json:
  messages, tool calls with their arguments and results, and usage.
- **A recreated Architect.** On `harness-sandbox`, the daemon recreated the Architect's
  sandbox, and the browser terminal connected to the new one. A recreated Architect now
  gets its proposals back, and is told that its earlier conversation is gone. While its
  design is in review, it works on its Arch branch, so a fix goes on the same PR.

This run found four bugs in the transcripts:
- **Tokens written.** An assistant message carries its output tokens as counted when it
  starts, 1 to 6, so the sum undercounted: 49 instead of 5,703. Totals now come from
  each turn's `result`.
- **Repeated starts.** A long-lived session that reads its input as a stream repeats
  its `init` event every turn. Now only the first one shows.
- **Hidden items.** The `[harness]` items sent to the Manager rendered with no height.
  In a fixed-height grid, a scroll container's minimum height is zero. Rows are now
  sized to their content.
- **Colors.** Failed results and tool errors rendered muted instead of red, because of
  CSS order.

Transcripts now also show the model calls that Claude Code retries (`api_retry`). The
Manager and the first Developer each had two, at the start of the build.

## Other observations

- **Restarts.** The daemon restarted twice. The first restart loaded the fixes. The
  second came after the coding agent's background task limit, 30 minutes by default,
  stopped it; an owner's own terminal has no such limit. Both times the daemon stopped
  cleanly and picked up from the event log. The Manager kept running in its sandbox
  throughout, in its first launch.
- **A restart changes the dashboard's link.** Each `harness up` makes a new token, so an
  open tab needs the new link.
- **Polls.** The daemon fetches `main` often. The build started 14 seconds after the
  merge of Arch PR #1, and the plan branch took `main` 11 seconds after the merge of PR
  #2. Pull requests are polled less often: every minute, or every five minutes once
  nothing has changed for ten. So:
  - `DESIGN_FROZEN` came up to a minute after a design's merge. The design change hold
    waits for it, 56 seconds after the merge of PR #2.
  - The merge of plan PR #3 came 19 minutes after its CI passed, and was recorded
    3 minutes later.
- **Not published.** The package installs from its tarball. Publishing `razzou-harness`
  on npm (D18) is the owner's step.
- **Untested here:**
  - a clean machine;
  - `harness recover`, which only the tests cover, with stub agents;
  - a conflict between `main` and a plan branch;
  - an Architect sandbox recreated during review.
