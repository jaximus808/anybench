#!/usr/bin/env bash
# L1 install (snapshot build) for Tandem: Claude Code for the planner and workers, and the Tandem
# MCP server warmed into the npx cache so trials don't download it. CLAUDE_CODE_VERSION and
# TANDEM_MCP_VERSION pin them; the defaults here must equal contenders[].versions in anybench.yaml
# (a kit test checks it). tandem-mcp 3.2.0 is tag mcp-v3.2.0, the same commit as source.ref.
set -euo pipefail
npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION:-2.1.311}"
npx -y "@jaximus/tandem-mcp@${TANDEM_MCP_VERSION:-3.2.0}" --help >/dev/null
