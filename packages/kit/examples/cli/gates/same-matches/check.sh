#!/usr/bin/env bash
# L5 gate. Runs only on the scoring computer. Usage: check.sh <frozen-out> <workload-id> <gate.json>
set -euo pipefail
out="${1:?out}" workload="${2:?workload}" verdict="${3:?gate.json}"
ref="$(dirname "$0")/../../reference/same-matches/$workload.txt"
if diff -u "$ref" "$out/matches.txt" > "$out/same-matches.diff"; then
  printf '{"pass":true,"reason":"matches equal the reference","evidence":["matches.txt"]}\n' > "$verdict"
else
  printf '{"pass":false,"reason":"matches differ from the reference","evidence":["matches.txt","same-matches.diff"]}\n' > "$verdict"
fi
