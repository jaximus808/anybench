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
# From here on the outputs are involved: whatever they make go wrong is a FAIL verdict, never a
# verdict-less exit (which would read as a broken check).
fail_closed() {
  local rc=$?
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
cp -R "$tests" "$ws/.hidden-tests"
if (cd "$ws" && "$AB_RUN" node --test ".hidden-tests/**/*.test.js" < /dev/null > "$out/hidden-tests.txt" 2>&1); then
  printf '{"pass":true,"reason":"all hidden tests pass","evidence":["hidden-tests.txt"]}\n' > "$verdict"
else
  printf '{"pass":false,"reason":"hidden tests failed","evidence":["hidden-tests.txt"]}\n' > "$verdict"
fi
