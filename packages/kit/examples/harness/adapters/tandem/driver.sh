#!/usr/bin/env bash
# L2 driver for a harness with approvals. The approver sidecar (human_in_loop) runs beside it.
# Usage: driver.sh run <instruction.md> <workspace>. Env: EVAL_OUT, EVAL_SECRETS, WORKERS.
set -euo pipefail
verb="${1:?verb}"
case "$verb" in
  start|ready|stop) exit 0 ;;
  run)
    task="${2:?task}" ws="${3:?workspace}"
    set -a; source "$EVAL_SECRETS"; set +a
    tandem run --workers "${WORKERS:-3}" --task "$task" --workspace "$ws" \
      --events "$EVAL_OUT/tandem/events.jsonl" \
      --claude-args "--output-format stream-json --verbose" > "$EVAL_OUT/stream.jsonl"
    ;;
  *) echo "unknown verb: $verb" >&2; exit 2 ;;
esac
