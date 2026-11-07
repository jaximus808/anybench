#!/usr/bin/env bash
# L5 gate: runs the hidden tests on the scoring computer against the frozen workspace.
# Usage: check.sh <frozen-out> <workload-id> <gate.json>
set -euo pipefail
out="${1:?out}" workload="${2:?workload}" verdict="${3:?gate.json}"
tests="$(dirname "$0")/tests/$workload"
cp -R "$tests" "$out/workspace/.hidden-tests"
if (cd "$out/workspace" && node --test .hidden-tests/ > "$out/hidden-tests.txt" 2>&1); then
  printf '{"pass":true,"reason":"all hidden tests pass","evidence":["hidden-tests.txt"]}\n' > "$verdict"
else
  printf '{"pass":false,"reason":"hidden tests failed","evidence":["hidden-tests.txt"]}\n' > "$verdict"
fi
