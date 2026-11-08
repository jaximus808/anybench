#!/usr/bin/env bash
# L1 install (snapshot build): headless Claude Code at the version the kit pins
# (contenders[].versions.CLAUDE_CODE_VERSION). Installed globally so the eval user runs it too.
set -euo pipefail
npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION:?pin versions.CLAUDE_CODE_VERSION in anybench.yaml}"
claude --version
