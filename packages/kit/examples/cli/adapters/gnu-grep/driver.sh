#!/usr/bin/env bash
set -euo pipefail
verb="${1:?verb}"
case "$verb" in
  start|ready|stop) exit 0 ;;
  run)
    in="${2:?in}" out="${3:?out}"
    pattern="$(cat "$in/pattern.txt")"
    (cd "$in" && grep -rnoP -e "$pattern" tree) | LC_ALL=C sort > "$out/matches.txt" || true
    ;;
  *) echo "unknown verb: $verb" >&2; exit 2 ;;
esac
