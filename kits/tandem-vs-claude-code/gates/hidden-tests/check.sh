#!/usr/bin/env bash
# L5 gate `hidden-tests`: runs on the scoring computer, never on the computer that ran the subject.
#
#   check.sh [<workload> <workspace> <out>]
#
# Arguments fall back to the runner env: WORKLOAD (or EVAL_WORKLOAD), EVAL_WS, EVAL_OUT.
# Writes <out>/gate.json {pass, reason, evidence[]} and <out>/metrics.jsonl. Needs only Node 22.18+;
# no network.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workload="${1:-${WORKLOAD:-${EVAL_WORKLOAD:-}}}"
workspace="${2:-${EVAL_WS:-}}"
out="${3:-${EVAL_OUT:-}}"
if [[ -z "$workload" || -z "$workspace" || -z "$out" ]]; then
  echo "usage: check.sh <workload> <workspace> <out>  (or set WORKLOAD, EVAL_WS, EVAL_OUT)" >&2
  exit 2
fi
exec node "$here/grade.mjs" --workload "$workload" --workspace "$workspace" --out "$out"
