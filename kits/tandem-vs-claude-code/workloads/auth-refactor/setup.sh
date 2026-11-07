#!/usr/bin/env bash
# Prepares EVAL_WS for the auth-refactor workload (see scripts/setup-workspace.sh).
set -euo pipefail
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/setup-workspace.sh" auth-refactor "${1:-${EVAL_WS:?EVAL_WS is not set}}"
