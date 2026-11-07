#!/usr/bin/env bash
# Plain Claude Code baseline: one session, the uploaded CLAUDE.md, no board.
set -euo pipefail
verb="${1:?verb}"
case "$verb" in
  start|ready|stop) exit 0 ;;
  run)
    task="${2:?task}" ws="${3:?workspace}"
    set -a; source "$EVAL_SECRETS"; set +a
    cp "$(dirname "$0")/../../baselines/claude-code/CLAUDE.md" "$ws/CLAUDE.md"
    cd "$ws" && claude -p "$(cat "$task")" --dangerously-skip-permissions \
      --output-format stream-json --verbose > "$EVAL_OUT/stream.jsonl"
    ;;
  *) echo "unknown verb: $verb" >&2; exit 2 ;;
esac
