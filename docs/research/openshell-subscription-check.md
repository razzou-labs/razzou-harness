# Claude subscription inside an OpenShell sandbox: verified

Checked 2026-10-09 on Linux: OpenShell 0.1.2 with the Docker driver and a local
gateway, and Claude Code 2.1.295.

## Result

A sandbox with the provider below attached ran
`claude -p "Reply with exactly: SUBSCRIPTION_OK" --model claude-opus-5-5`, and
Claude answered `SUBSCRIPTION_OK` on the owner's subscription.

- Inside the sandbox, `CLAUDE_CODE_OAUTH_TOKEN` held an OpenShell placeholder
  (`openshell:resolve:env:...`), never the real token.
- Claude Code sends that variable unchanged as `Authorization: Bearer <value>`. It
  does not check the token's format. OpenShell's proxy replaces the placeholder
  with the real token on `api.anthropic.com` only.
- With `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, Claude Code contacted only
  `api.anthropic.com:443`, with three requests: `GET /api/claude_code/policy_limits`,
  `GET /api/claude_code/settings` and `POST /v1/messages`. All three were allowed by
  the policy the provider generated, and the logs show no denials.
- OpenShell intercepted the TLS connection to read and check each request, and the
  stock Claude Code binary accepted that without any extra certificate setup.
- With the image already present locally, the sandbox started in about 0.1 s.

## Provider profile

OpenShell's built-in `claude-code` profile injects an API key. This profile injects
the subscription token instead. Create the token with `claude setup-token`.

```yaml
id: claude-code-subscription
display_name: Claude Code (subscription)
description: Claude Code CLI using a Claude subscription OAuth token
category: agent
inference_capable: true
credentials:
  - name: oauth_token
    description: Long-lived OAuth token printed by `claude setup-token`
    env_vars: [CLAUDE_CODE_OAUTH_TOKEN]
    required: true
    auth_style: bearer
    header_name: authorization
discovery:
  credentials: [oauth_token]
endpoints:
  - host: api.anthropic.com
    port: 443
    protocol: rest
    access: read-write
    enforcement: enforce
binaries: [/usr/local/bin/claude]
```

Owner steps: `openshell profile import -f <file> --global`, then
`openshell provider create --name claude-sub --type claude-code-subscription --from-existing`
with `CLAUDE_CODE_OAUTH_TOKEN` exported. The token was entered at a hidden prompt.

## Image requirements found on the way

- A non-root `USER` and a writable `/sandbox`, as OpenShell's bring-your-own-container
  example requires.
- `claude -p` waits 3 s for stdin unless it is given `< /dev/null`.
- Sandboxes need Docker containers to have outbound network. A VPN exit node, such as
  Tailscale's, can break that (containers then can't even resolve DNS), so
  `harness doctor` should test it.
