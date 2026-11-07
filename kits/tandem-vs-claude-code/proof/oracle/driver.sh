#!/usr/bin/env bash
# L7 oracle overlay: replaces the contender's driver. Instead of running an agent, it applies the
# reference solution for the workload onto the workspace. Every gate must pass at 100% on it.
#
#   driver.sh run <task> <workspace>      (WORKLOAD or EVAL_WORKLOAD names the workload)
#
# proof/oracle/<workload>/ holds the files the solution adds or changes; an optional
# `.oracle-delete` lists paths (relative to the workspace) the solution removes.
set -euo pipefail
kit="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
verb="${1:-run}"
case "$verb" in
  start|ready|stop) exit 0 ;;
  run) ;;
  *) echo "unknown verb '$verb'" >&2; exit 2 ;;
esac
ws="${3:-${EVAL_WS:?EVAL_WS is not set}}"
workload="${WORKLOAD:-${EVAL_WORKLOAD:?WORKLOAD is not set}}"
overlay="$kit/proof/oracle/$workload"
[[ -d "$overlay" ]] || { echo "no oracle for workload '$workload'" >&2; exit 2; }
cp -R "$overlay/." "$ws/"
if [[ -f "$ws/.oracle-delete" ]]; then
  while IFS= read -r path; do
    [[ -z "$path" || "$path" == /* || "$path" == *..* ]] && continue
    rm -rf "${ws:?}/$path"
  done < "$ws/.oracle-delete"
  rm -f "$ws/.oracle-delete"
fi
