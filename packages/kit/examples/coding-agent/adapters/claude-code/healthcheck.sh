#!/usr/bin/env bash
# L1 health check: the pinned Claude Code, node and git are on PATH, and the eval user exists.
set -euo pipefail
v="$(claude --version | head -n 1)"
[ "${v%% *}" = "${CLAUDE_CODE_VERSION:?}" ] || { echo "claude --version says '$v', not $CLAUDE_CODE_VERSION" >&2; exit 1; }
node --version > /dev/null
git --version > /dev/null
id -u "${ANYBENCH_EVAL_USER:-eval}" > /dev/null
