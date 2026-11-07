#!/usr/bin/env bash
# L1 install (snapshot build): headless Claude Code for contenders A and B, and for Tandem's
# planner and workers. CLAUDE_CODE_VERSION pins the version recorded on every trial.
set -euo pipefail
npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION:-latest}"
claude --version
