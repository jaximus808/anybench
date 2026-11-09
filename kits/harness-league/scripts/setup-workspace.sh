#!/usr/bin/env bash
# L3 setup: turn workloads/<id>/input/ into a fresh git repo at <workspace>.
#
#   setup-workspace.sh <workload> <workspace>
#
# Deterministic: fixed author, committer and dates, so the same input always gives the same
# commit hash. The workspace never contains gates/ or proof/ (hidden tests and the oracle stay
# kit-side). Needs git; no network.
set -euo pipefail
kit="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
workload="${1:?usage: setup-workspace.sh <workload> <workspace>}"
ws="${2:?usage: setup-workspace.sh <workload> <workspace>}"
src="$kit/workloads/$workload/input"
[[ -d "$src" ]] || { echo "no input for workload '$workload'" >&2; exit 2; }

case "$workload" in
  project-tracker) message="project-tracker 0.1.0: health endpoint, router and the tracker 1.x data file" ;;
  project-tracker-xl) message="project-tracker 0.1.0: health endpoint, router and the tracker 1.x data file" ;;
  *) message="$workload: starting point" ;;
esac

mkdir -p "$ws"
if [[ -n "$(ls -A "$ws")" ]]; then
  echo "workspace $ws is not empty" >&2
  exit 2
fi
cp -R "$src/." "$ws/"

export GIT_AUTHOR_NAME="Anybench Kit" GIT_AUTHOR_EMAIL="kit@anybench.invalid"
export GIT_COMMITTER_NAME="Anybench Kit" GIT_COMMITTER_EMAIL="kit@anybench.invalid"
export GIT_AUTHOR_DATE="2026-01-01T00:00:00Z" GIT_COMMITTER_DATE="2026-01-01T00:00:00Z"
git -C "$ws" init -q -b main
git -C "$ws" -c core.autocrlf=false add -A
git -C "$ws" -c commit.gpgsign=false commit -q -m "$message"
