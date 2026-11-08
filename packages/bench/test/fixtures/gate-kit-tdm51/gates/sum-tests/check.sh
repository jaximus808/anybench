#!/usr/bin/env bash
# L5 gate 'sum-tests' (kind: hidden-tests), TDM-51 test kit.
# Usage: check.sh <frozen-out> <workload-id> <gate.json>
# Runs the contender's workspace/sum.sh on the hidden cases in reference/sum-tests/<workload>/.
set -u
out="$1" wl="$2" verdict="$3"
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
  got="$(cd "$out/workspace" && bash ./sum.sh "$a" "$b" 2>/dev/null)"
  [ "$got" = "$want" ] || failed=$((failed + 1))
done < "$cases"
if [ "$total" -gt 0 ] && [ "$failed" -eq 0 ]; then
  printf '{"pass":true,"reason":"%d/%d hidden cases pass","evidence":["workspace/sum.sh"]}\n' "$total" "$total" > "$verdict"
else
  printf '{"pass":false,"reason":"%d/%d hidden cases fail","evidence":["workspace/sum.sh"]}\n' "$failed" "$total" > "$verdict"
fi
