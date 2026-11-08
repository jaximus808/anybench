#!/usr/bin/env bash
# L5 gate: runs the hidden tests on the scoring computer against the frozen workspace.
# Usage: check.sh <frozen-out> <workload-id> <gate.json>
# Contender code (the tests import it) runs ONLY through "$AB_RUN", as its own uid, in its own
# copy "$AB_RUN_DIR". That uid can't write this verdict, the results file or the copied tests,
# and can't signal this script (packages/bench gate.ts).
set -euo pipefail
out="${1:?out}" workload="${2:?workload}" verdict="${3:?gate.json}"
: "${AB_RUN:?no AB_RUN: contender code would run as the check's uid}" "${AB_RUN_DIR:?}"
tests="$(dirname "$0")/tests/$workload"
ws="$AB_RUN_DIR/workspace"
if [ ! -d "$ws" ]; then
  printf '{"pass":false,"reason":"the outputs have no workspace/","evidence":[]}\n' > "$verdict"
  exit 0
fi
cp -R "$tests" "$ws/.hidden-tests"
if (cd "$ws" && "$AB_RUN" node --test .hidden-tests/ < /dev/null > "$out/hidden-tests.txt" 2>&1); then
  printf '{"pass":true,"reason":"all hidden tests pass","evidence":["hidden-tests.txt"]}\n' > "$verdict"
else
  printf '{"pass":false,"reason":"hidden tests failed","evidence":["hidden-tests.txt"]}\n' > "$verdict"
fi
