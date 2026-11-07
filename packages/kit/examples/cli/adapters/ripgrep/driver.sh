#!/usr/bin/env bash
# L2 driver. Verbs: start | ready | run <in> <out> | stop. A cli driver only needs `run`.
# Writes sorted path:line:match lines to <out>/matches.txt for the same-matches gate.
set -euo pipefail
verb="${1:?verb}"
case "$verb" in
  start|ready|stop) exit 0 ;;
  run)
    in="${2:?in}" out="${3:?out}"
    pattern="$(cat "$in/pattern.txt")"
    args=(--no-heading --line-number --only-matching --sort path)
    [[ -n "${MAX_COUNT:-}" ]] && args+=(--max-count "$MAX_COUNT")
    [[ -n "${THREADS:-}" ]] && args+=(--threads "$THREADS")
    (cd "$in" && rg "${args[@]}" -e "$pattern" tree) | LC_ALL=C sort > "$out/matches.txt" || true
    ;;
  *) echo "unknown verb: $verb" >&2; exit 2 ;;
esac
