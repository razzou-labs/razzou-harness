# Spike 1: the daemon ↔ sandbox transport over OpenShell `exec`

Checked 2026-10-09 with OpenShell 0.1.2 (Docker driver, local gateway), on a sandbox
from the Claude Code test image. The question was whether `openshell sandbox exec` can
carry the transport of proposal v2 §9.2 and the Manager's input and output (§7.5).

## Results

| Question | Result |
|---|---|
| What does one `exec` cost? | 41 ms on average (39 to 44 ms over 5 calls). |
| Can a long-lived `exec` follow a file that something else appends to? | Yes. `tail -F` delivered 10 of 10 lines. With tail's default 1 s polling, latency was 116 to 937 ms. With `tail -s 0.2`, it was 100 to 250 ms end to end, including the `exec` that wrote the line. |
| Does input piped into a running `exec` command stream? | **No.** Lines reached the remote process only when the pipe closed. With the pipe still open, nothing arrived. |
| Does a process started with `setsid nohup` outlive its `exec`? | Yes. |
| Does a remote command die when the local `openshell` client is killed? | Yes. Killing the CLI terminated the remote process. |

## Consequences for the design

- **The bus works as designed (§9.2).**
  - An agent's tool call appends to its outbox file.
  - The daemon follows the outbox with `tail -n +1 -s 0.2 -F`.
  - The daemon writes replies with short `exec` calls.
- **The Manager can't be fed through `exec` stdin.** It runs detached, like a Developer:

  ```
  tail -n 0 -s 0.2 -F manager-in.jsonl | claude -p --input-format stream-json … > manager-out.jsonl
  ```

  The daemon appends to `manager-in.jsonl` and follows `manager-out.jsonl`. As a
  bonus, the Manager keeps running while the daemon restarts.
- **Every long-running agent process must be detached.** Anything running in the
  foreground of an `exec` dies with the daemon.
- **Gotcha:** `pkill -f <pattern>` inside `sh -c` also matches the shell running it.
  Use pid files.

## Still to observe in M1

- Following a file for hours, and reconnecting after the gateway restarts.
- Whether inotify works inside the sandbox. Tail appears to fall back to polling, which
  is fine at 0.2 s.

The spike scripts were throwaway and live in the session's scratch space. They are not
part of the harness.
