# Spike 5: reading the subscription's usage before a launch

Checked 2026-11-05 with the Claude Code login of the owner's machine. The question was
whether the daemon can read how much of the subscription's limits is used, so that
Swarm mode launches no new agent above a ceiling (proposal v3 §4.3), instead of learning
about a limit after an attempt hits it.

The endpoint is the one Claude Code's `/usage` reads. It is not documented, so the daemon
treats it as optional: when it fails, the pause after a hit remains the brake.

## Results

| Question | Result |
|---|---|
| `GET https://api.anthropic.com/api/oauth/usage` with `Authorization: Bearer <token>` and `anthropic-beta: oauth-2025-04-20`? | **200**, JSON. |
| Which token? | The OAuth access token of a Claude Code login (scopes `user:inference`, `user:profile`, …). The token from `claude setup-token`, which the OpenShell provider holds, is the same kind; the doctor confirms it when it stores one (§4.3). |
| What does the body hold? | `five_hour` and `seven_day`, each with `utilization` (a percentage) and `resets_at` (ISO 8601). A `limits` list with one entry per window: `kind` (`session`, `weekly_all`, `weekly_scoped`), `percent`, `severity`, `resets_at`, `is_active`, and a `scope` naming a model for the scoped one. Many other fields, null on this plan. |
| Is the response fast? | Under a second. |

At the time of the call the session window stood at 51% and the weekly at 55%, with
resets a few hours and a day away.

## Consequences for the design

- **The ceiling applies to the highest `percent` in `limits`**, and the pause lasts
  until that entry's `resets_at`. A scoped weekly limit counts too: a model the agents
  use can be exhausted while the overall weekly is not.
- **The daemon needs the token.** `harness doctor` stores the token it creates the
  provider with in `~/.config/harness/claude.token`, mode 0600, next to the App's key.
  An install made before this keeps working: the doctor asks for the token again when
  Swarm mode is on and the file is missing.
- **The beta header is required.** Without it the call is refused.
- **The call is cached for five minutes.** One call per launch decision is enough; the
  windows move slowly.
- **The response carries the organization and workspace ids in its headers.** The
  daemon reads the body only, and records nothing from the headers.
