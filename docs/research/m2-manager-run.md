# M2: the Manager on OpenShell

Checked 2026-10-11 with Claude Code 2.1.295, OpenShell 0.1.2 and the M2 daemon. Haiku 4.5
played both the Manager and the Developer, on two throwaway projects:
- **greeter2**: two features, with a daemon restart while both agents worked;
- **greeter3**: one feature, built to force a question and a rejection.

## The Manager's session

It ran as proposal v2 §6.4 and spike 3 describe: `--restricted`, `--tools Read,Grep,Glob,Bash`,
`--permission-mode dontAsk`, a settings file allowing `git log/diff/show` and
`mcp__harness`, and `--mcp-config` with `--strict-mcp-config`. Its `init` event showed:

| Field | Value |
|---|---|
| `permissionMode` | `dontAsk` |
| `tools` | `Bash`, `Glob`, `Grep`, `Read`, and the ten `mcp__harness__*` tools |
| `mcp_servers` | `harness`: `connected` |

- **Input.** Items reached it through a file followed by `tail -F` in a process
  substitution. `--replay-user-messages` echoed each one into its transcript.
- **Restart.** The daemon was stopped while F02 was being built. Both agents kept
  running. The restarted daemon reattached to the Manager's outbox and transcript and
  delivered the next review to the same launch. No relaunch was needed.
- **Read-only commands.** `find … | head` and `ls -la … | grep …` ran inside the
  Manager's clone without being refused, in `dontAsk` mode. Claude Code approves its
  built-in read-only commands inside the working directory by itself; spike 3's `ls /`
  was refused because `/` is outside it. This reads nothing that Read, Grep and Glob
  can't. Nothing flows back from the Manager's sandbox except its tool calls, so the
  design is unchanged.

## The protocol

| Path | Seen |
|---|---|
| Owner → Manager (`harness message`) | Delivered while the first attempt ran. |
| Review → `accept_feature` | It ran `git diff <base> HEAD`, checked a rule from `ARCHITECTURE.md`, and accepted, 6 to 10 s after the checks passed. |
| Review → `reject_feature` | At the owner's request, it rejected attempt 1 with guidance. Attempt 2 started with that guidance in its task. |
| Developer `ask_manager` → `answer_developer` | Asked at 22:18:46.6 UTC, answered at 22:18:49.5: 2.9 s, including the Manager's turn. The answer was the result of the Developer's MCP call. |
| Plan ready → `submit_plan` | 5 s after the full check run passed. |

## What the agents did

- **Developers look for answers themselves before asking.** In greeter2 the Developer
  found the greeting word in `ARCHITECTURE.md`. In greeter3's first attempt, it read
  the word from the check script. Questions come when the repository doesn't settle
  something, as the role asks.
- **Cost per Haiku attempt:** 150k to 260k input tokens, mostly cache reads, and 2k to
  3k output tokens.
- **Attribution in summaries.** The Manager's plan summary ended with Claude Code's
  "Generated with Claude Code" line. It will reach the pull request body in M3.

## Fixed during the run

- **One dashboard port per project.** Two daemons shared the default port, and the
  second exited at start. The dashboard now takes the next free port, and `daemon.json`
  records which one.
- **IPv4 refused by `web_read`.** Node's `BlockList` matches IPv4 addresses against
  IPv4-mapped IPv6 rules, so the rule for `::ffff:0:0/96` blocked every IPv4 address.
  Mapped addresses are now unwrapped and checked as IPv4. A unit test caught this before
  the real run.
