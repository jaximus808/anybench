#!/usr/bin/env bash
# L5 gate `api-load`: API p95 at a fixed request rate, only after every hidden test passes.
#
#   check.sh [<workload> <workspace> <out>]     (falls back to WORKLOAD, EVAL_WS, EVAL_OUT)
#
# Writes <out>/gate.json and <out>/metrics.jsonl (api_p95_ms, api_p50_ms, api_p99_ms,
# api_requests). Workloads without an API get pass:false, "not applicable". No network.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workload="${1:-${WORKLOAD:-${EVAL_WORKLOAD:-}}}"
workspace="${2:-${EVAL_WS:-}}"
out="${3:-${EVAL_OUT:-}}"
if [[ -z "$workload" || -z "$workspace" || -z "$out" ]]; then
  echo "usage: check.sh <workload> <workspace> <out>  (or set WORKLOAD, EVAL_WS, EVAL_OUT)" >&2
  exit 2
fi
exec node "$here/load.mjs" --workload "$workload" --workspace "$workspace" --out "$out"
