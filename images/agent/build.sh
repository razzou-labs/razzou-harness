#!/usr/bin/env bash
# Builds the sandbox image. Claude Code comes from this machine: the sandboxes run the
# version the owner already uses, and nothing downloads it at build time.
#
#   images/agent/build.sh [tag]     (default: razzou-harness/agent:<package version>)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
version="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$here/../../package.json")"
tag="${1:-razzou-harness/agent:${version}}"

claude="$(command -v claude || true)"
if [ -z "$claude" ]; then
  echo "Claude Code isn't installed on this machine (no 'claude' on PATH)." >&2
  exit 1
fi
claude="$(readlink -f "$claude")"
claude_version="$("$claude" --version | cut -d' ' -f1)"

context="$(mktemp -d)"
trap 'rm -rf "$context"' EXIT
cp "$here/Dockerfile" "$context/"
cp "$claude" "$context/claude"

docker build --build-arg "CLAUDE_VERSION=${claude_version}" --tag "$tag" "$context"
echo "built $tag with Claude Code ${claude_version}"
