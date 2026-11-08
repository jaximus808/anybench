#!/usr/bin/env bash
# L2 driver for contenders A (claude-code-solo) and B (claude-code-subagents), type coding-agent.
#
#   driver.sh run <task> <workspace>     task = the workload's instruction.md
#
# Env (from the kit): CC_SETUP names the adapters/<setup>/ folder whose CLAUDE.md and .claude/
# become the user-level Claude Code config (so nothing is written into the graded workspace);
# CC_DISALLOWED_TOOLS (optional, e.g. "Task Agent") is passed to --disallowedTools; CC_MODEL
# (required) is the pinned model id; CC_MAX_TURNS is optional. CLAUDE_MD_OVERLAY (optional, kit-relative) is appended to CLAUDE.md (planted regression).
# Runner env: EVAL_OUT (outputs), EVAL_SECRETS (a file that sets ANTHROPIC_API_KEY; sourced, never echoed).
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
