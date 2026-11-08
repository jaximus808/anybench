#!/usr/bin/env bash
# claude-code: the pinned build is first on PATH and runs, both as the exec user and as the eval
# user (the user trials run agents as).
set -euo pipefail
. "$RECIPE_LIB"

want="$CLAUDE_CODE_VERSION (Claude Code)"
expect_eq "claude on PATH" "/usr/local/bin/claude" "$(command -v claude)"
expect_eq "claude --version" "$want" "$(claude --version)"
expect_eq "claude --version as $EVAL_USER" "$want" "$(as_user "$EVAL_USER" claude --version)"
# Naïve proxy readiness (TDM-16, verified live on 2.1.319): the switches the proxy needs are
# exported, and this build understands CLAUDE_CODE_MODEL_CAPABILITIES (an older or newer build
# that dropped it would send fields the proxy refuses with 400). No model call: that needs the
# per-trial token, which never lives on the image.
expect_eq "ANTHROPIC_BASE_URL" "https://api.vetta.sh/v1/proxy/anthropic" "$ANTHROPIC_BASE_URL"
expect_eq "MAX_THINKING_TOKENS" "0" "$MAX_THINKING_TOKENS"
expect_eq "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS" "1" "$CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS"
case "$CLAUDE_CODE_MODEL_CAPABILITIES" in *-context_management*-rejects_disabled_thinking) ;;
  *) die "CLAUDE_CODE_MODEL_CAPABILITIES is '$CLAUDE_CODE_MODEL_CAPABILITIES'" ;; esac
grep -aqF CLAUDE_CODE_MODEL_CAPABILITIES "$(readlink -f "$ANYBENCH_CLAUDE_CODE_HOME/bin/claude")" \
  || die "claude $CLAUDE_CODE_VERSION does not know CLAUDE_CODE_MODEL_CAPABILITIES"
echo "claude $want ok (as $(id -un) and $EVAL_USER), naive proxy switches set"
