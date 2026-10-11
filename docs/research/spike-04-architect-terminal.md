# Spike 4: the Architect's terminal through `openshell sandbox connect`

Checked 2026-10-10 with OpenShell 0.1.2 (Docker driver) and Claude Code 2.1.295 (Haiku),
on the owner's subscription through the custom provider. The question was whether the
Architect can be a long-lived interactive Claude Code session inside a sandbox, which
the owner attaches to from the dashboard and leaves again (proposal v2 §7.5, §14.3).

The terminal was driven by a small Python script around `pty.fork()` running
`openshell sandbox connect`, the same thing the dashboard will do with node-pty.

## Results

| Question | Result |
|---|---|
| A sandbox created `--detach` **with** a command (`… -- sh -c '…; exec claude'`): does the main process get a terminal? | **No.** Claude printed "no stdin data received in 3s" and "Input must be provided … when using --print", then exited. |
| A sandbox created `--detach` **without** a command: does its login shell keep a terminal? | Yes. `stty size` answered `30 100`. |
| Do resizes reach the sandbox? | Yes. After resizing to 50×150, `stty size` answered `50 150`. |
| Started from that shell with `exec` and with first-run screens pre-answered, does the Claude Code interface work? | Yes. It answered `OK42` through the subscription. |
| Detach with Ctrl-P, Ctrl-Q, then reattach? | The session kept running. Reattaching replayed recent output, and the conversation continued: it remembered 42. |
| `/exit`, then `openshell sandbox start` on the now `Completed` sandbox? | **It went to `Error`** and gave no usable shell. |
| A launcher that runs Claude in a loop, `--session-id <id>` the first time and `--resume <id>` afterwards, then `/exit`? | Claude came back within seconds in the same conversation (`AGAIN42`), and the sandbox stayed `Ready`. |
| `openshell sandbox stop`, then `start` (the reboot case), then the launcher again? | `Stopped`, then `Ready`. The conversation resumed (`THIRD42`): the session files survived in the container's writable layer. |

## Consequences for the design

- **Creation.** The Architect's sandbox is created without a command. The image's
  `.bash_profile` checks `HARNESS_ROLE=architect` and `exec`s the launcher in the
  retained terminal, including after a `sandbox start`.
- **The launcher's job:**
  1. write `~/.claude.json` with `hasCompletedOnboarding`, a theme and the workspace's
     trust;
  2. run Claude in a loop on one fixed session id, so the main process never exits;
  3. set the permission mode explicitly, because the interface otherwise starts in auto
     mode.
- **After a reboot,** `harness up` runs `openshell sandbox start` on stopped sandboxes,
  and the Architect resumes by itself.
- **The dashboard terminal** is a pseudo-terminal running `openshell sandbox connect`.
  M1 must confirm that node-pty installs cleanly. If it doesn't, a small Python helper
  like the spike's driver is the fallback.
