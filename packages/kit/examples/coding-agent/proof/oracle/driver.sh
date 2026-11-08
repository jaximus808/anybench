#!/usr/bin/env bash
# L7 oracle overlay: replaces the contender's driver. Instead of running an agent it applies the
# reference solution proof/oracle/<workload>/ to the workspace and freezes it where the
# coding-agent driver does (EVAL_OUT/workspace), so the hidden-tests gate sees the same layout.
#
#   driver.sh run <task> <workspace>      (WORKLOAD or EVAL_WORKLOAD names the workload)
set -euo pipefail
case "${1:-}" in
  start | ready | stop) exit 0 ;;
  run) ;;
  *) echo "usage: driver.sh start | ready | run <task> <workspace> | stop" >&2; exit 2 ;;
esac
kit="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ws="${3:-${EVAL_WS:?EVAL_WS is not set}}"
out="${EVAL_OUT:?EVAL_OUT is not set}"
workload="${WORKLOAD:-${EVAL_WORKLOAD:?WORKLOAD is not set}}"
overlay="$kit/proof/oracle/$workload"
[ -d "$overlay" ] || { echo "no oracle for workload '$workload'" >&2; exit 2; }
cp -R "$overlay/." "$ws/"
rm -rf "$out/workspace"
mkdir -p "$out/workspace"
cp -R "$ws/." "$out/workspace/"
