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
# Stop every contender process before this check exits. The gate runner fails the gate closed
# (`lingering`) on any process of the contender uid still alive when the check exits, and the
# contender's code (the app the tests import, a server it starts) can leave some behind. This uid
# can't signal the contender uid, so the stop runs AS it, through "$AB_RUN": TERM, a 2 s grace,
# then KILL, for every process of that uid except the stopper's own session. It does nothing when
# "$AB_RUN" doesn't switch uid (a local ab-run-local.sh), so it never signals your own processes.
AB_STOP_ALL='me=$$ uid=$(id -u)
[ "$uid" != "$1" ] && [ "$uid" != 0 ] || exit 0
alive() {
  left=""
  for p in /proc/[0-9]*; do
    [ "${p#/proc/}" != "$me" ] && [ -O "$p" ] || continue
    st=""; { read -r st < "$p/stat"; } 2>/dev/null || continue
    set -- ${st##*\)}
    case "${1:-}" in Z|X|"") continue ;; esac
    [ "${4:-}" != "$me" ] || continue
    c="${st#*\(}"; left="$left ${p#/proc/}:${c%\)*}"
  done
}
alive; [ -z "$left" ] || echo "stopping contender processes:$left"
kill -TERM -1 2>/dev/null
i=0; while alive; [ -n "$left" ] && [ "$i" -lt 20 ]; do sleep 0.1; i=$((i + 1)); done
kill -KILL -1 2>/dev/null
i=0; while alive; [ -n "$left" ] && [ "$i" -lt 20 ]; do sleep 0.1; kill -KILL -1 2>/dev/null; i=$((i + 1)); done
[ -z "$left" ] || { echo "still running after KILL:$left"; exit 1; }'
stop_contender() {
  [ -n "${AB_RUN:-}" ] && [ -d "${AB_RUN_DIR:-}" ] || return 0
  (cd "$AB_RUN_DIR" && "$AB_RUN" bash -c "$AB_STOP_ALL" ab-stop "$(id -u)" < /dev/null) >&2 || true
}
# From here on the outputs are involved: whatever they make go wrong (node killed, a crash before
# the verdict) is a FAIL verdict, never a verdict-less exit (which would read as a broken check).
fail_closed() {
  local rc=$?
  # Stop first, then the verdict: nothing of the contender outlives the check, on any path.
  stop_contender
  if [ ! -s "$verdict" ]; then
    printf '{"pass":false,"reason":"hidden tests could not run on these outputs (exit %d)","evidence":[]}\n' "$rc" > "$verdict"
  fi
  exit 0
}
trap fail_closed EXIT
node "$here/grade.mjs" --workload "$workload" --run-dir "$AB_RUN_DIR" --out "$out" --verdict "$verdict"
