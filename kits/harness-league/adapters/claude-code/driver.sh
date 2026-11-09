#!/usr/bin/env bash
# L2 driver for contender A (claude-code-solo), type coding-agent. Copied from
# kits/tandem-vs-claude-code/adapters/claude-code/driver.sh (TDM-212) and changed in three ways:
# tokens come from our own Anthropic key, the run stops itself before the wall-clock cap so the
# workspace is always frozen (partial credit), and the stream goes through the same tap as the
# Tandem sessions, so the runner's BYOK spend cap sees it live and secrets are redacted.
#
#   driver.sh run <task> <workspace>     task = the workload's instruction.md
#
# Env (from the kit): CC_SETUP names the adapters/<setup>/ folder whose CLAUDE.md and .claude/
# become the user-level Claude Code config (so nothing is written into the graded workspace);
# CC_DISALLOWED_TOOLS (optional, e.g. "Task Agent") is passed to --disallowedTools; CC_MODEL
# (required) is the pinned first-party model id; CC_MAX_TURNS is optional; CC_WALL_CAP_S (or
# ANYBENCH_WALL_CAP_S) is the trial's wall-clock cap. CLAUDE_MD_OVERLAY (optional, kit-relative)
# is appended to CLAUDE.md (planted regression).
# Runner env: EVAL_OUT (outputs), EVAL_SECRETS (the worker's ~/.anybench/env; sourced, never echoed).
#
# Tokens: AB_TOKEN_SOURCE must be anthropic_key (BYOK). ANTHROPIC_API_KEY comes from the runner's
# env or EVAL_SECRETS. Every Naïve proxy setting is unset, so Claude Code talks to api.anthropic.com
# at its default effort with thinking on (no capability switches).
#
# Writes $EVAL_OUT/stream.jsonl (stream-json: tokens, turns, cost), $EVAL_OUT/versions.json and the
# frozen workspace $EVAL_OUT/workspace/. Stdout carries only the compact usage/cost lines the
# runner's token cap reads (adapters/tandem/board.ts tap).
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
board="$kit/adapters/tandem/board.ts"

if [[ -n "${EVAL_SECRETS:-}" && -f "$EVAL_SECRETS" ]]; then set -a; . "$EVAL_SECRETS"; set +a; fi

# Tokens from our own Anthropic key (AB_TOKEN_SOURCE=anthropic_key). Never echoed, never on argv.
[[ "${AB_TOKEN_SOURCE:-}" == anthropic_key ]] ||
  { echo "this kit runs on AB_TOKEN_SOURCE=anthropic_key, not '${AB_TOKEN_SOURCE:-}'" >&2; exit 2; }
case "$model" in */*) echo "CC_MODEL=$model is a Naïve id: anthropic_key needs a first-party id" >&2; exit 2 ;; esac
[[ -n "${ANTHROPIC_API_KEY:-}" ]] ||
  { echo "ANTHROPIC_API_KEY is not set (token source anthropic_key: the worker writes it to ~/.anybench/env)" >&2; exit 2; }
unset ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS MAX_THINKING_TOKENS \
  CLAUDE_CODE_MODEL_CAPABILITIES NAIVE_PROXY_ENV
export ANTHROPIC_MODEL="$model"

cfg="$HOME/.claude"
mkdir -p "$cfg"
cp "$kit/adapters/$setup/CLAUDE.md" "$cfg/CLAUDE.md"
if [[ -d "$kit/adapters/$setup/.claude" ]]; then cp -R "$kit/adapters/$setup/.claude/." "$cfg/"; fi
if [[ -n "${CLAUDE_MD_OVERLAY:-}" ]]; then cat "$kit/$CLAUDE_MD_OVERLAY" >> "$cfg/CLAUDE.md"; fi

printf '{"claude_code":"%s","node":"%s","model":"%s","setup":"%s","token_source":"anthropic_key"}\n' \
  "$(claude --version | head -1)" "$(node --version)" "$model" "$setup" > "$out/versions.json"

# The task goes in on stdin, never on argv: Linux caps one argument at 128 KiB (MAX_ARG_STRLEN)
# and project-tracker-xl's instruction is 150 KB, so passing it as the -p argument exits 126,
# "Argument list too long" (TDM-239). `claude -p` with no prompt argument reads it from stdin.
args=(-p --output-format stream-json --verbose --dangerously-skip-permissions --model "$model")
[[ -n "${CC_MAX_TURNS:-}" ]] && args+=(--max-turns "$CC_MAX_TURNS")
# One --disallowedTools value per tool ("Task Agent" -> Task, Agent).
if [[ -n "${CC_DISALLOWED_TOOLS:-}" ]]; then
  read -r -a disallowed <<< "${CC_DISALLOWED_TOOLS//,/ }"
  args+=(--disallowedTools "${disallowed[@]}")
fi

# Stop Claude Code before the runner's cap, so the workspace below is always frozen and partial
# work is graded (hidden_test_fraction). Reserve 60 s for TERM, KILL and the copy.
cap="${ANYBENCH_WALL_CAP_S:-${CC_WALL_CAP_S:-}}"
limit=()
if [[ -n "$cap" ]]; then
  [[ "$cap" =~ ^[0-9]+$ ]] || { echo "wall cap must be whole seconds, got '$cap'" >&2; exit 2; }
  run_s=$(( cap > 240 ? cap - 60 : cap * 3 / 4 ))
  command -v timeout > /dev/null && limit=(timeout --signal=TERM --kill-after=20 "$run_s")
fi

cd "$ws"
set +e
${limit[@]+"${limit[@]}"} claude "${args[@]}" < "$task" 2> >(node "$board" redact > "$out/claude.stderr.log") |
  node "$board" tap --file "$out/stream.jsonl"
statuses=("${PIPESTATUS[@]}")
set -e
rc="${statuses[0]}"
(( rc == 0 )) && rc="${statuses[1]}"
# Hand the workspace to the scoring computer (the hidden-tests gate reads $EVAL_OUT/workspace/),
# as the harness driver does: without .git and node_modules, whatever the agent's exit status.
rm -rf "$out/workspace" && mkdir -p "$out/workspace"
(cd "$ws" && tar --exclude=.git --exclude=node_modules -cf - .) | tar -C "$out/workspace" -xf -
exit "$rc"
