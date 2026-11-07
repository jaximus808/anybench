#!/usr/bin/env bash
# Prepares EVAL_WS for the todo-api workload (see scripts/setup-workspace.sh).
set -euo pipefail
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/setup-workspace.sh" todo-api "${1:-${EVAL_WS:?EVAL_WS is not set}}"
