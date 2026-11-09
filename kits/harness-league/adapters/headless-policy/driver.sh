#!/usr/bin/env bash
# L2 driver for every Claude Code setup of the league (A, B, and through adapters/tool-home G, S),
# type coding-agent (TDM-228 [21.2]): E18's adapters/claude-code/driver.sh, byte for byte, with the
# league's headless policy around Claude Code.
#
#   driver.sh run <task> <workspace>
#
# The policy (policy.mjs): when a `claude -p` session's final message waits on the user (a
# question, "say go", "approve the design", gstack's prose decision brief), the same session is
# resumed with one fixed reply, the same for every setup, at most MAX_AUTO_ANSWERS times per
# trial. Nothing is added to any prompt or CLAUDE.md. It is applied by putting bin/claude (the
# wrapper, shim.mjs) first on PATH, so the shared driver, its tap, redaction, caps and workspace
# freeze run unchanged; AB_REAL_CLAUDE is the Claude Code the image installed.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
kit="$(cd "$here/../.." && pwd)"
case "${1:-run}" in start|ready|stop) exit 0 ;; esac
if [[ -z "${AB_REAL_CLAUDE:-}" ]]; then
  AB_REAL_CLAUDE="$(command -v claude)" || { echo "no claude on PATH (adapters/claude-code/install.sh installs it)" >&2; exit 2; }
fi
[[ "$AB_REAL_CLAUDE" -ef "$here/bin/claude" ]] &&
  { echo "AB_REAL_CLAUDE is the headless-policy wrapper itself, not Claude Code" >&2; exit 2; }
export AB_REAL_CLAUDE
export PATH="$here/bin:$PATH"
exec "$kit/adapters/claude-code/driver.sh" "$@"
