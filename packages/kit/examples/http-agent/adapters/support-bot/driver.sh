#!/usr/bin/env bash
# L2 driver for an http-agent. start | ready | stop manage the agent under test (the stub support
# bot); run posts the conversation set to it with anybench-http-agent and writes transcripts,
# http-agent.jsonl and http-agent.metrics.jsonl to <out>.
# Env: EVAL_WS (state dir), STUB_AGENT_MODE / STUB_AGENT_DELAY_MS (proof overlays),
# ANYBENCH_HTTP_AGENT (path to the command, default anybench-http-agent on PATH).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
state="${EVAL_WS:?EVAL_WS}"
port_file="$state/support-bot.port"
pid_file="$state/support-bot.pid"
verb="${1:?verb}"
case "$verb" in
  start)
    rm -f "$port_file"
    STUB_AGENT_PORT_FILE="$port_file" PORT="${SUPPORT_BOT_PORT:-0}" \
      nohup node --experimental-strip-types --no-warnings "$here/server.ts" \
      > "$state/support-bot.log" 2>&1 &
    echo $! > "$pid_file"
    ;;
  ready)
    [[ -s "$port_file" ]] || exit 1
    node -e 'fetch(process.argv[1]).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' \
      "http://127.0.0.1:$(cat "$port_file")/health"
    ;;
  run)
    in="${2:?in}" out="${3:?out}"
    "${ANYBENCH_HTTP_AGENT:-anybench-http-agent}" run --config "$here/http-agent.json" \
      --endpoint "http://127.0.0.1:$(cat "$port_file")/chat" --in "$in" --out "$out"
    ;;
  stop)
    if [[ -f "$pid_file" ]]; then kill "$(cat "$pid_file")" 2> /dev/null || true; fi
    rm -f "$pid_file" "$port_file"
    ;;
  *) echo "unknown verb: $verb" >&2; exit 2 ;;
esac
