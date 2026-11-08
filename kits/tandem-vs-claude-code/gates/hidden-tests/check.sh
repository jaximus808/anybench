#!/usr/bin/env bash
# L5 gate `hidden-tests`: runs on the scoring computer, never on the computer that ran the subject.
#
#   check.sh <frozen-out> <workload-id> <gate.json>
#
# The gate runner's calling convention (packages/bench gate.ts, TDM-51): <frozen-out> is this
# check's private writable copy of the trial's outputs, <gate.json> is where the verdict goes.
# Contender code runs ONLY through "$AB_RUN" (its own uid, clean env) in "$AB_RUN_DIR", its own
# copy of the outputs (with workspace/ in it). This script writes only under $1 and $3, and puts
# the hidden tests into $AB_RUN_DIR before any contender code runs there (grade.mjs).
# Writes $3 {pass, reason, evidence[]} and $1/hidden-tests.{json,log,metrics.jsonl}. Needs only
# Node 22.18+; no network. Locally, AB_RUN can be scripts/ab-run-local.sh (no uid switch).
set -euo pipefail
out="${1:?usage: check.sh <frozen-out> <workload-id> <gate.json>}"
workload="${2:?usage: check.sh <frozen-out> <workload-id> <gate.json>}"
verdict="${3:?usage: check.sh <frozen-out> <workload-id> <gate.json>}"
: "${AB_RUN:?no AB_RUN: contender code would run as the check uid}" "${AB_RUN_DIR:?no AB_RUN_DIR}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$here/$workload/tests.json" ] || { echo "no hidden tests for $workload" >&2; exit 2; }
# From here on the outputs are involved: whatever they make go wrong (node killed, a crash before
# the verdict) is a FAIL verdict, never a verdict-less exit (which would read as a broken check).
fail_closed() {
  local rc=$?
  if [ ! -s "$verdict" ]; then
    printf '{"pass":false,"reason":"hidden tests could not run on these outputs (exit %d)","evidence":[]}\n' "$rc" > "$verdict"
  fi
  exit 0
}
trap fail_closed EXIT
node "$here/grade.mjs" --workload "$workload" --run-dir "$AB_RUN_DIR" --out "$out" --verdict "$verdict"
