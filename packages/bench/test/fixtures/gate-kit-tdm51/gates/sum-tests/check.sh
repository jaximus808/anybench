#!/usr/bin/env bash
# L5 gate 'sum-tests' (kind: hidden-tests), TDM-51 test kit.
# Usage: check.sh <frozen-out> <workload-id> <gate.json>
# Runs the contender's workspace/sum.sh on the hidden cases in reference/sum-tests/<workload>/.
# Contender code runs ONLY through "$AB_RUN" (its own uid), in its own copy "$AB_RUN_DIR": it can't
# read the cases, write this verdict or signal this script.
set -u
out="$1" wl="$2" verdict="$3"
: "${AB_RUN:?no AB_RUN: the scoring computer gives contender code no uid of its own}"
: "${AB_RUN_DIR:?}"
cases="$(cd "$(dirname "$0")/../.." && pwd)/reference/sum-tests/$wl/cases.txt"
[ -f "$cases" ] || { echo "no hidden cases for $wl" >&2; exit 2; }
prog="$out/workspace/sum.sh"
if [ -L "$prog" ] || [ ! -f "$prog" ]; then
  printf '{"pass":false,"reason":"workspace/sum.sh is missing","evidence":[]}\n' > "$verdict"
  exit 0
fi
total=0 failed=0
while read -r a b want; do
  [ -n "${a:-}" ] || continue
  total=$((total + 1))
  got="$(cd "$AB_RUN_DIR/workspace" && "$AB_RUN" bash ./sum.sh "$a" "$b" </dev/null 2>/dev/null)"
  [ "$got" = "$want" ] || failed=$((failed + 1))
done < "$cases"
# Metric rows (kept by the runner only on a passing verdict).
printf '{"metric":"cases_passed","value":%d,"unit":"count"}\n{"metric":"Bad Name","value":1}\n' \
  "$((total - failed))" > "$out/sum-tests.metrics.jsonl"
if [ "$total" -gt 0 ] && [ "$failed" -eq 0 ]; then
  printf '{"pass":true,"reason":"%d/%d hidden cases pass","evidence":["workspace/sum.sh"]}\n' "$total" "$total" > "$verdict"
else
  printf '{"pass":false,"reason":"%d/%d hidden cases fail","evidence":["workspace/sum.sh"]}\n' "$failed" "$total" > "$verdict"
fi
