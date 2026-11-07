#!/usr/bin/env bash
# L1 install (snapshot build) for Tandem: Claude Code for the planner and workers, and the Tandem
# MCP server warmed into the npx cache so trials don't download it. TANDEM_MCP_VERSION pins it.
set -euo pipefail
npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION:-latest}"
npx -y "@jaximus/tandem-mcp@${TANDEM_MCP_VERSION:-latest}" --help >/dev/null
