#!/usr/bin/env bash
# Local stand-in for the gate runner's $AB_RUN (packages/bench gate.ts): runs contender code in the
# caller's cwd with a clean env. It does NOT switch uid, so it is for local proofs and tests only;
# on a scoring computer the gate runner provides the real $AB_RUN.
#
#   AB_RUN=scripts/ab-run-local.sh AB_RUN_DIR=<dir with workspace/> gates/<gate>/check.sh ...
set -u
[ "$#" -ge 1 ] || { echo "usage: ab-run-local.sh <cmd> [args...]" >&2; exit 2; }
h="${AB_RUN_HOME:-${TMPDIR:-/tmp}}"
exec env -i PATH="${PATH:-/usr/local/bin:/usr/bin:/bin}" HOME="$h" TMPDIR="$h" LC_ALL=C LANG=C "$@"
