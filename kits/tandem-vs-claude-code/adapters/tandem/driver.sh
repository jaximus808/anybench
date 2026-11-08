#!/usr/bin/env bash
# L2 driver for contender `tandem` (subject), type harness. Setups come from the kit's
# `vary: {TANDEM_WORKERS: [...]}`.
#
#   driver.sh run <task> <workspace>
#
# `run` is the harness runner, run.sh (TDM-41 [4.9]): a fresh Tandem server and canvas per trial,
# the approver sidecar for human_in_loop.policy, a planner and $TANDEM_WORKERS workers as headless
# Claude Code sessions, a completion detector and a hard timeout. Outputs: $EVAL_OUT/tandem/
# (board, approvals, tandem.db, one stream-json per session), $EVAL_OUT/versions.json and the
# scrubbed workspace in $EVAL_OUT/workspace/. Config: harness.yaml next to this file.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
verb="${1:-run}"
case "$verb" in
  start|ready|stop) exit 0 ;;
  run) ;;
  *) echo "unknown verb '$verb'" >&2; exit 2 ;;
esac
task="${2:?usage: driver.sh run <task> <workspace>}"
exec "$here/run.sh" "$task" "${3:-${EVAL_WS:?EVAL_WS is not set}}"
