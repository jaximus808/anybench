#!/usr/bin/env bash
# Builds EVAL_WS for the slugify workload: the input as a one-commit git repo (fixed author and
# dates, so the commit is the same on every computer).
set -euo pipefail
in="${EVAL_IN:?EVAL_IN is not set}"
ws="${1:-${EVAL_WS:?EVAL_WS is not set}}"
mkdir -p "$ws"
cp -R "$in/." "$ws/"
if command -v git > /dev/null; then
  export GIT_AUTHOR_NAME=anybench GIT_AUTHOR_EMAIL=kit@anybench.dev GIT_COMMITTER_NAME=anybench \
    GIT_COMMITTER_EMAIL=kit@anybench.dev GIT_AUTHOR_DATE=2026-01-01T00:00:00Z \
    GIT_COMMITTER_DATE=2026-01-01T00:00:00Z
  git -C "$ws" init -q -b main
  git -C "$ws" add -A
  git -C "$ws" -c commit.gpgsign=false commit -q -m "slugify task: starting repo"
fi
