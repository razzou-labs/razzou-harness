# Security policy

razzou-harness runs AI agents next to your code, your GitHub repositories and your AWS
account, so its controls matter as much as its features. The README's Security section
describes them.

## Reporting a vulnerability

Report it privately, through GitHub's private vulnerability reporting: in this
repository, open **Security**, then **Report a vulnerability**. Please don't open a
public issue, and don't put real tokens or keys in the report.

Useful to include:
- the version, from `harness version`;
- what you did, and what happened;
- what should have been refused.

The project is maintained on a best-effort basis. A fix ships as a new version, with a
note in the changelog.

## What counts

Anything that lets an agent, a repository's content or a web page get around the
harness's own controls. For example:
- a sandbox gets hold of a credential, or reaches a host or an HTTP method its policy
  refuses;
- a change to a protected file reaches `main` through a `Plan:` or `Fix:` pull request;
- `verify` passes a pull request that it should fail;
- `web_read` reaches a private, loopback or link-local address;
- the dashboard answers without its token, or to another origin;
- the daemon runs code or git hooks that an agent wrote, on the host;
- the AWS setup the README describes lets an agent write, or read data or secrets.

Vulnerabilities in OpenShell, Claude Code, Docker, GitHub or AWS themselves belong to
their maintainers. Tell us as well if the harness makes one worse.

## Supported versions

The latest release gets the fixes. Before 1.0, older versions don't.
