#!/usr/bin/env bash
set -euo pipefail
npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION:?set in contenders[].versions}"
