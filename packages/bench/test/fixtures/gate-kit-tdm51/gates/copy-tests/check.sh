#!/usr/bin/env bash
# L5 gate 'copy-tests', TDM-51 test kit: the hardened harness pattern (packages/kit/examples/harness
# hidden-tests): copy hidden tests into the contender's workspace and run them through $AB_RUN.
# Anything the outputs make go wrong becomes a FAIL verdict, never a verdict-less exit.
set -euo pipefail
out="$1" wl="$2" verdict="$3"
: "${AB_RUN:?}" "${AB_RUN_DIR:?}"
tests="$(cd "$(dirname "$0")" && pwd)/tests/$wl"
[ -d "$tests" ] || exit 2
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
# The kit is readable by the check uid only (0640); the contender uid must read its copy.
chmod -R a+rX "$ws/.hidden-tests"
if (cd "$ws" && "$AB_RUN" bash .hidden-tests/run.sh </dev/null >"$out/copy-tests.txt" 2>&1); then
  printf '{"pass":true,"reason":"hidden tests pass","evidence":["copy-tests.txt"]}\n' > "$verdict"
else
  printf '{"pass":false,"reason":"hidden tests failed","evidence":["copy-tests.txt"]}\n' > "$verdict"
fi
