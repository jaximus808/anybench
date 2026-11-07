#!/usr/bin/env bash
# L7 do-less overlay: a no-op harness. It accepts every verb, changes nothing in the workspace,
# claims no tickets and spends no tokens. Every hidden test must fail on its output, and the
# Tandem board must show 0 claims.
set -euo pipefail
case "${1:-run}" in
  start|ready|stop|run) exit 0 ;;
  *) echo "unknown verb '$1'" >&2; exit 2 ;;
esac
