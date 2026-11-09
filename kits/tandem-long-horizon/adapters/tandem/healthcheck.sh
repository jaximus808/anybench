#!/usr/bin/env bash
# L1 health check: Claude Code, the pinned Tandem gateway and server binary, Node with type
# stripping (board.ts), git. Never starts a server: `tandem` with no data dir would open ~/.tandem.
set -euo pipefail
home_dir="${TANDEM_HOME:-$HOME/.anybench/tandem}"
claude --version >/dev/null
[[ "$("$home_dir/mcp/node_modules/.bin/tandem-mcp" --version)" == "@jaximus/tandem-mcp ${TANDEM_MCP_VERSION:-3.2.0}" ]]
[[ -x "$home_dir/bin/tandem" && "$(cat "$home_dir/bin/VERSION")" == "${TANDEM_VERSION:-0.2.0}" ]]
node -e 'if (!process.features.typescript) process.exit(1)'
git --version >/dev/null
