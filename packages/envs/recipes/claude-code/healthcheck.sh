#!/usr/bin/env bash
# claude-code: the pinned build is first on PATH and runs, both as the exec user and as the eval
# user (the user trials run agents as).
set -euo pipefail
. "$RECIPE_LIB"

want="$CLAUDE_CODE_VERSION (Claude Code)"
expect_eq "claude on PATH" "/usr/local/bin/claude" "$(command -v claude)"
expect_eq "claude --version" "$want" "$(claude --version)"
expect_eq "claude --version as $EVAL_USER" "$want" "$(as_user "$EVAL_USER" claude --version)"
echo "claude $want ok (as $(id -un) and $EVAL_USER)"
