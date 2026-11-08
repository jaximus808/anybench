#!/usr/bin/env bash
# L5 gate: runs the hidden tests on the scoring computer against the frozen workspace.
# Usage: check.sh <frozen-out> <workload-id> <gate.json>
# Contender code (the tests import it) runs ONLY through "$AB_RUN", as its own uid, in its own
# copy "$AB_RUN_DIR". That uid can't write this verdict, the results file or the copied tests,
# and can't signal this script (packages/bench gate.ts). This script writes only under $1 and $3,
# and never into $AB_RUN_DIR after contender code has run there (it could plant symlinks).
set -euo pipefail
out="${1:?out}" workload="${2:?workload}" verdict="${3:?gate.json}"
: "${AB_RUN:?no AB_RUN: contender code would run as the check uid}" "${AB_RUN_DIR:?}"
tests="$(cd "$(dirname "$0")" && pwd)/tests/$workload"
[ -d "$tests" ] || { echo "no hidden tests for $workload" >&2; exit 2; }
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
# From here on the outputs are involved: whatever they make go wrong is a FAIL verdict. Only a
# step the outputs can't influence (phase=kit, e.g. copying the kit's own tests) exits without a
# verdict, which the runner records as a kit_suspect FAIL (still counted, flagged for a refund).
phase=outputs
fail_closed() {
  local rc=$?
  # Stop first, then the verdict: nothing of the contender outlives the check, on any path.
  stop_contender
  if [ "$phase" = kit ] && [ ! -s "$verdict" ]; then
    echo "hidden-tests: kit step failed (exit $rc)" >&2
    exit 3
  fi
  if [ ! -s "$verdict" ]; then
    printf '{"pass":false,"reason":"hidden tests could not run on these outputs (exit %d)","evidence":[]}\n' "$rc" > "$verdict"
  fi
  exit 0
}
trap fail_closed EXIT
ws="$AB_RUN_DIR/workspace"
if [ -L "$ws" ] || [ ! -d "$ws" ]; then
  printf '{"pass":false,"reason":"the outputs have no workspace/","evidence":[]}\n' > "$verdict"
  exit 0
fi
# The contender may have shipped its own .hidden-tests (a file, a symlink, fake tests): replace it.
rm -rf "$ws/.hidden-tests"
# The workspace dirs belong to this uid and contender code hasn't run yet: only the kit can break this.
phase=kit
cp -R "$tests" "$ws/.hidden-tests"
# The kit is readable by the check uid only (0640); the contender uid must read its copy.
chmod -R a+rX "$ws/.hidden-tests"
phase=outputs
if (cd "$ws" && "$AB_RUN" node --test ".hidden-tests/**/*.test.js" < /dev/null > "$out/hidden-tests.txt" 2>&1); then
  printf '{"pass":true,"reason":"all hidden tests pass","evidence":["hidden-tests.txt"]}\n' > "$verdict"
else
  printf '{"pass":false,"reason":"hidden tests failed","evidence":["hidden-tests.txt"]}\n' > "$verdict"
fi
