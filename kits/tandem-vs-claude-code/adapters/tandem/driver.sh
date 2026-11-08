#!/usr/bin/env bash
# L2 driver for contender `tandem` (subject), type harness. Setups C, D and E come from the kit's
# `vary: {TANDEM_WORKERS: [1, 3, 5]}`. CC_MODEL (required) is the pinned model id.
#
#   driver.sh run <task> <workspace>
#
# Contract with the harness driver and approver sidecar (tickets 4.9 and 5.7): before `run`, the
# sidecar creates a fresh trial canvas, applies human_in_loop.policy to it, and exports
# TANDEM_CANVAS_CODE. The board's claims, conflicts and approvals are collected by the
# `tandem-board` collector, not by this script.
#
# Writes $EVAL_OUT/stream.jsonl (the planner's stream-json; workers run as its subagents, so their
# usage is included) and $EVAL_OUT/versions.json.
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
workers="${TANDEM_WORKERS:?TANDEM_WORKERS is not set}"
model="${CC_MODEL:?CC_MODEL is not set: the kit pins the model in driver.env}"
code="${TANDEM_CANVAS_CODE:?TANDEM_CANVAS_CODE is not set (the approver sidecar provides it)}"

if [[ -n "${EVAL_SECRETS:-}" ]]; then set -a; . "$EVAL_SECRETS"; set +a; fi

mcp="$out/tandem/mcp.json"
mkdir -p "$out/tandem"
printf '{"mcpServers":{"tandem":{"command":"npx","args":["-y","@jaximus/tandem-mcp@%s"]}}}\n' "${TANDEM_MCP_VERSION:-3.2.0}" > "$mcp"

prompt="$(TASK="$(cat "$task")" TANDEM_WORKERS="$workers" TANDEM_CANVAS_CODE="$code" node -e '
  const fs = require("node:fs");
  let p = fs.readFileSync(process.argv[1], "utf8");
  for (const k of ["TASK", "TANDEM_WORKERS", "TANDEM_CANVAS_CODE"]) p = p.replaceAll(`{{${k}}}`, process.env[k]);
  process.stdout.write(p);
' "$kit/adapters/tandem/planner-prompt.md")"

printf '{"claude_code":"%s","node":"%s","model":"%s","tandem_workers":%s}\n' "$(claude --version | head -1)" "$(node --version)" "$model" "$workers" > "$out/versions.json"

args=(-p "$prompt" --output-format stream-json --verbose --dangerously-skip-permissions --mcp-config "$mcp" --model "$model")
cd "$ws"
claude "${args[@]}" > "$out/stream.jsonl"
