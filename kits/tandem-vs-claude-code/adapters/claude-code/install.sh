#!/usr/bin/env bash
# L1 install (snapshot build): headless Claude Code for contenders A and B, and for Tandem's
# planner and workers. CLAUDE_CODE_VERSION pins the version recorded on every trial; its default
# here must equal contenders[].versions.CLAUDE_CODE_VERSION in anybench.yaml (a kit test checks it).
set -euo pipefail
npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION:-2.1.311}"
claude --version
