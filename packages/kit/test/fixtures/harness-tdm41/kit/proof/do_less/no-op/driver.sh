#!/usr/bin/env bash
# Do-less: a harness that does nothing (no board, no claims). The workspace is left as it started.
set -euo pipefail
[[ "${1:-run}" == run ]] || exit 0
mkdir -p "$EVAL_OUT/workspace"
(cd "${3:-$EVAL_WS}" && tar --exclude=.git -cf - .) | tar -C "$EVAL_OUT/workspace" -xf -
