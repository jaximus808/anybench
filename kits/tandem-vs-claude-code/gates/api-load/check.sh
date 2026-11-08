#!/usr/bin/env bash
# L5 gate `api-load`: API p95 at a fixed request rate, only after every hidden test passes.
#
#   check.sh <frozen-out> <workload-id> <gate.json>
#
# The gate runner's calling convention (packages/bench gate.ts, TDM-51), as in
# gates/hidden-tests/check.sh: contender code (the hidden tests, then the app under load) runs
# ONLY through "$AB_RUN" in "$AB_RUN_DIR"; this script writes only under $1 and $3.
# Writes $3 and $1/api-load.json, $1/api-load.metrics.jsonl (api_p95_ms, api_p50_ms, api_p99_ms,
# api_requests). Workloads without an API answer {pass: false, applicable: false}. No network.
set -euo pipefail
out="${1:?usage: check.sh <frozen-out> <workload-id> <gate.json>}"
workload="${2:?usage: check.sh <frozen-out> <workload-id> <gate.json>}"
verdict="${3:?usage: check.sh <frozen-out> <workload-id> <gate.json>}"
: "${AB_RUN:?no AB_RUN: contender code would run as the check uid}" "${AB_RUN_DIR:?no AB_RUN_DIR}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$here/workloads.json" ] || { echo "no workloads.json" >&2; exit 2; }
# From here on the outputs are involved: whatever they make go wrong (node killed, a crash before
# the verdict) is a FAIL verdict, never a verdict-less exit (which would read as a broken check).
fail_closed() {
  local rc=$?
  if [ ! -s "$verdict" ]; then
    printf '{"pass":false,"reason":"api-load could not run on these outputs (exit %d)","evidence":[]}\n' "$rc" > "$verdict"
  fi
  exit 0
}
trap fail_closed EXIT
node "$here/load.mjs" --workload "$workload" --run-dir "$AB_RUN_DIR" --out "$out" --verdict "$verdict"
