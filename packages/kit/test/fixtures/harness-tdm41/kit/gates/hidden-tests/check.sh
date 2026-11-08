#!/usr/bin/env bash
# L5 gate (gate runner contract, packages/bench gate.ts, TDM-51): check.sh <frozen-out> <workload> <gate.json>.
# Contender code runs only through "$AB_RUN", in its own copy "$AB_RUN_DIR"; this script writes
# only under $1 and $3.
set -euo pipefail
out="${1:?out}" workload="${2:?workload}" verdict="${3:?gate.json}"
: "${AB_RUN:?no AB_RUN: contender code would run as the check uid}" "${AB_RUN_DIR:?}"
tests="$(cd "$(dirname "$0")" && pwd)/tests/$workload"
[ -d "$tests" ] || { echo "no hidden tests for $workload" >&2; exit 2; }
fail_closed() {
  local rc=$?
  [ -s "$verdict" ] || printf '{"pass":false,"reason":"hidden tests could not run on these outputs (exit %d)","evidence":[]}\n' "$rc" > "$verdict"
  exit 0
}
trap fail_closed EXIT
ws="$AB_RUN_DIR/workspace"
if [ -L "$ws" ] || [ ! -d "$ws" ]; then
  printf '{"pass":false,"reason":"the outputs have no workspace/","evidence":[]}\n' > "$verdict"
  exit 0
fi
rm -rf "$ws/.hidden-tests"
cp -R "$tests" "$ws/.hidden-tests"
chmod -R a+rX "$ws/.hidden-tests"
if (cd "$ws" && "$AB_RUN" node --test .hidden-tests/math.hidden.ts < /dev/null > "$out/hidden-tests.txt" 2>&1); then
  printf '{"pass":true,"reason":"all hidden tests pass","evidence":["hidden-tests.txt"]}\n' > "$verdict"
else
  printf '{"pass":false,"reason":"hidden tests failed","evidence":["hidden-tests.txt"]}\n' > "$verdict"
fi
