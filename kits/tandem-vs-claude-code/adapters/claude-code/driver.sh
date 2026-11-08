#!/usr/bin/env bash
# L2 driver for contenders A (claude-code-solo) and B (claude-code-subagents), type coding-agent.
#
#   driver.sh run <task> <workspace>     task = the workload's instruction.md
#
# Env (from the kit): CC_SETUP names the adapters/<setup>/ folder whose CLAUDE.md and .claude/
# become the user-level Claude Code config (so nothing is written into the graded workspace);
# CC_DISALLOWED_TOOLS (optional, e.g. "Task Agent") is passed to --disallowedTools; CC_MODEL
# (required) is the pinned model id; CC_MAX_TURNS is optional. CLAUDE_MD_OVERLAY (optional, kit-relative) is appended to CLAUDE.md (planted regression).
# Runner env: EVAL_OUT (outputs), EVAL_SECRETS (optional secrets file; sourced, never echoed).
# AB_TOKEN_SOURCE=naive_proxy (the kit sets it) sources the Naïve proxy env file (below).
#
# Writes $EVAL_OUT/stream.jsonl (stream-json: tokens, turns, cost) and $EVAL_OUT/versions.json.
set -euo pipefail
kit="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
verb="${1:-run}"
case "$verb" in
  start|ready|stop) exit 0 ;;
  run) ;;
  *) echo "unknown verb '$verb'" >&2; exit 2 ;;
esac
task="${2:?usage: driver.sh run <task> <workspace>}"
ws="${3:-${EVAL_WS:?EVAL_WS is not set}}"
out="${EVAL_OUT:?EVAL_OUT is not set}"
setup="${CC_SETUP:?CC_SETUP is not set}"
model="${CC_MODEL:?CC_MODEL is not set: the kit pins the model in driver.env}"

if [[ -n "${EVAL_SECRETS:-}" ]]; then set -a; . "$EVAL_SECRETS"; set +a; fi

# Tokens from the Naïve model proxy (AB_TOKEN_SOURCE=naive_proxy, docs/findings/claude-code-naive-proxy.md).
# The worker writes a per-trial proxy:write key to $HOME/.anybench/proxy.env (0600); it is sourced,
# never echoed and never on an argv. The kit's proxy settings (driver.env) win over the file's, so
# every contender runs the same model with effort naive-min and thinking off, and no direct
# Anthropic key can bypass the proxy.
if [[ "${AB_TOKEN_SOURCE:-}" == naive_proxy ]]; then
  proxy_env="${NAIVE_PROXY_ENV:-$HOME/.anybench/proxy.env}"
  [[ -f "$proxy_env" ]] || { echo "AB_TOKEN_SOURCE=naive_proxy but $proxy_env is missing" >&2; exit 2; }
  pinned=()
  for k in CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS MAX_THINKING_TOKENS CLAUDE_CODE_MODEL_CAPABILITIES \
    ANTHROPIC_DEFAULT_OPUS_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL ANTHROPIC_DEFAULT_HAIKU_MODEL ANTHROPIC_SMALL_FAST_MODEL; do
    [[ -n "${!k:-}" ]] && pinned+=("$k=${!k}")
  done
  set -a; . "$proxy_env"; set +a
  for kv in "${pinned[@]}"; do export "${kv?}"; done
  export ANTHROPIC_MODEL="$model"
  unset ANTHROPIC_API_KEY
  : "${ANTHROPIC_BASE_URL:?$proxy_env sets no ANTHROPIC_BASE_URL}" "${ANTHROPIC_AUTH_TOKEN:?$proxy_env sets no ANTHROPIC_AUTH_TOKEN}"
fi

cfg="$HOME/.claude"
mkdir -p "$cfg"
cp "$kit/adapters/$setup/CLAUDE.md" "$cfg/CLAUDE.md"
if [[ -d "$kit/adapters/$setup/.claude" ]]; then cp -R "$kit/adapters/$setup/.claude/." "$cfg/"; fi
if [[ -n "${CLAUDE_MD_OVERLAY:-}" ]]; then cat "$kit/$CLAUDE_MD_OVERLAY" >> "$cfg/CLAUDE.md"; fi

printf '{"claude_code":"%s","node":"%s","model":"%s","setup":"%s"}\n' "$(claude --version | head -1)" "$(node --version)" "$model" "$setup" > "$out/versions.json"

args=(-p "$(cat "$task")" --output-format stream-json --verbose --dangerously-skip-permissions --model "$model")
[[ -n "${CC_MAX_TURNS:-}" ]] && args+=(--max-turns "$CC_MAX_TURNS")
# One --disallowedTools value per tool ("Task Agent" -> Task, Agent).
if [[ -n "${CC_DISALLOWED_TOOLS:-}" ]]; then
  read -r -a disallowed <<< "${CC_DISALLOWED_TOOLS//,/ }"
  args+=(--disallowedTools "${disallowed[@]}")
fi
cd "$ws"
claude "${args[@]}" > "$out/stream.jsonl"
