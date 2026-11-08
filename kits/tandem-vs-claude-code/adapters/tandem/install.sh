#!/usr/bin/env bash
# L1 install (snapshot build) for Tandem: Claude Code for the planner and workers, then the pinned
# Tandem server and MCP gateway (install-tandem.sh), so trials download nothing.
# CLAUDE_CODE_VERSION, TANDEM_VERSION and TANDEM_MCP_VERSION pin them; the defaults must equal
# contenders[].versions in anybench.yaml (a kit test checks it).
set -euo pipefail
npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION:-2.1.319}"
"$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install-tandem.sh"
