#!/usr/bin/env bash
# tandem: the pinned binary is intact and on PATH, the gateway runs from PATH and offline from
# the npx cache for each user that needs it, and, as the eval user, `tandem-mcp up --foreground`
# (offline, via npx, with TANDEM_BIN) starts the server and GET /healthz answers version 0.2.0.
set -euo pipefail
. "$RECIPE_LIB"

have curl || die "curl missing"
expect_eq "tandem on PATH" "/usr/local/bin/tandem" "$(command -v tandem)"
expect_eq "tandem binary sha256" "$RECIPE_SHA256" "$(sha256_of "$ANYBENCH_TANDEM_HOME/tandem")"
expect_eq "tandem-mcp on PATH" "/usr/local/bin/tandem-mcp" "$(command -v tandem-mcp)"
tandem-mcp --version </dev/null | grep -qF "$TANDEM_MCP_VERSION" || die "tandem-mcp --version is not $TANDEM_MCP_VERSION"
expect_eq "TANDEM_AUTOSTART" "0" "$TANDEM_AUTOSTART"

for u in $(printf '%s\n' "$(stat -c %U "$HOME")" "$EVAL_USER" | sort -u); do
  [ "$u" = root ] && continue
  as_user "$u" npx --offline -y "@jaximus/tandem-mcp@$TANDEM_MCP_VERSION" --version </dev/null \
    | grep -qF "$TANDEM_MCP_VERSION" || die "npx cache for $u does not hold tandem-mcp $TANDEM_MCP_VERSION"
done

port=$(free_port)
out=$(as_user "$EVAL_USER" bash -c '
  set -uo pipefail
  port=$1
  d=$(mktemp -d -p "$HOME" .tandem-hc.XXXXXX)
  setsid npx --offline -y "@jaximus/tandem-mcp@$TANDEM_MCP_VERSION" up --foreground --no-open \
    --port "$port" --data-dir "$d/data" > "$d/log" 2>&1 < /dev/null &
  pid=$!
  body=""
  for _ in $(seq 1 60); do
    body=$(curl -fsS --max-time 2 "http://127.0.0.1:$port/healthz" 2>/dev/null) && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  kill -TERM -- "-$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
  kill -KILL -- "-$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  if [ -z "$body" ]; then echo "no /healthz answer; server log:" >&2; tail -20 "$d/log" >&2; fi
  rm -rf "$d"
  printf "%s" "$body"
' as_eval "$port")
case "$out" in
  *'"ok":true'*"\"version\":\"$TANDEM_VERSION\""*) ;;
  *) die "GET /healthz as $EVAL_USER: want ok and version $TANDEM_VERSION, got '$out'" ;;
esac
echo "tandem $TANDEM_VERSION /healthz $out, tandem-mcp $TANDEM_MCP_VERSION ok (as $EVAL_USER)"
