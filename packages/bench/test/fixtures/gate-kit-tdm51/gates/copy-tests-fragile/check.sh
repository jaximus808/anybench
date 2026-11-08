#!/usr/bin/env bash
# L5 gate 'copy-tests-fragile', TDM-51 test kit: the ORIGINAL harness pattern, kept to prove that a
# check the outputs can break still counts against the contender (kit_suspect, never a re-roll).
set -euo pipefail
out="$1" wl="$2" verdict="$3"
tests="$(cd "$(dirname "$0")/../copy-tests" && pwd)/tests/$wl"
ws="$AB_RUN_DIR/workspace"
cp -R "$tests" "$ws/.hidden-tests"
if (cd "$ws" && "$AB_RUN" bash .hidden-tests/run.sh </dev/null >"$out/copy-tests-fragile.txt" 2>&1); then
  printf '{"pass":true,"reason":"hidden tests pass","evidence":[]}\n' > "$verdict"
else
  printf '{"pass":false,"reason":"hidden tests failed","evidence":[]}\n' > "$verdict"
fi
