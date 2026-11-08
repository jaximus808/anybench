#!/usr/bin/env bash
# Harness runner for contender `tandem` (TDM-41 [4.9], plan.md P2 driver `harness`, P3 approver).
#
#   run.sh <task> <workspace>          (driver.sh `run` execs this)
#
# One trial, headless, on the subject computer:
#   1. a fresh Tandem server on a free port with its own data dir (`tandem-mcp up --foreground`);
#      TANDEM_AUTOSTART=0 everywhere, so no MCP gateway ever starts a second server;
#   2. `tandem-mcp init --write` in the workspace (a fresh canvas, .mcp.json, AGENTS.md); the agents
#      get a pinned copy of that MCP config (the installed, pinned gateway instead of an unpinned `npx`);
#   3. the approver sidecar for human_in_loop.policy (ANYBENCH_HIL_POLICY): @anybench/approver's
#      `eval-approver` when installed (ticket 5.7, every policy), else the built-in one
#      (`board.ts approve`: auto and human-sim; it refuses llm-reviewer);
#   4. the planner (`claude -p`) proposes one epic; once approved work is on the board, N workers
#      (`claude -p`, N = $TANDEM_WORKERS) claim and finish tickets in this workspace;
#   5. done when the planner has exited and every approved epic has drained (completion detector
#      over /api/canvas/epics), or at the hard timeout; then everything is stopped (TERM, KILL);
#   6. collect: board + /api/metrics dumps and a copy of tandem.db under $EVAL_OUT/tandem/, one
#      stream-json transcript per session under $EVAL_OUT/tandem/streams/ (stdout carries only the
#      compact usage/cost lines the runner's token cap reads);
#   7. scrub what init added (.mcp.json, AGENTS.md, …), then copy the workspace to
#      $EVAL_OUT/workspace/ for the scoring computer (hidden tests never come here).
#
# Env: EVAL_OUT (required), EVAL_SECRETS (sourced only into the agent sessions and the approver),
# TANDEM_WORKERS,
# ANYBENCH_HIL_POLICY (auto | llm-reviewer | human-sim), ANYBENCH_WALL_CAP_S (optional, overrides
# harness.yaml timeout_s), CC_MODEL (required: the pinned model id), AB_TOKEN_SOURCE=naive_proxy
# (+ NAIVE_PROXY_ENV), TANDEM_HOME (where install-tandem.sh put the
# binaries, default ~/.anybench/tandem), TANDEM_APPROVER_BIN / TANDEM_APPROVER_ARGS (optional).
# Exit: 0 completed, 124 timed out, 1 anything else. $EVAL_OUT/tandem/run.json says which.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
task="${1:?usage: run.sh <task> <workspace>}"
ws="${2:-${EVAL_WS:?EVAL_WS is not set}}"
out="${EVAL_OUT:?EVAL_OUT is not set}"
yaml="$here/harness.yaml"

# harness.yaml is flat `key: value` (HarnessConfigSchema in packages/kit keeps it that way).
cfg() {
  local v
  v="$(sed -n "s/^$1:[[:space:]]*//p" "$yaml" | head -n 1)"
  v="${v%%[[:space:]]#*}"
  v="${v%"${v##*[![:space:]]}"}"
  [[ -n "$v" ]] || { echo "harness.yaml: no '$1'" >&2; exit 2; }
  printf '%s' "$v"
}
int() { [[ "$2" =~ ^[0-9]+$ ]] || { echo "$1 must be a whole number, got '$2'" >&2; exit 2; }; }

workers_env="$(cfg workers_env)"
workers="${!workers_env:-}"
int "$workers_env" "$workers"
(( workers >= 1 )) || { echo "$workers_env must be at least 1" >&2; exit 2; }
model="${CC_MODEL:?CC_MODEL is not set: the kit pins the model in driver.env}"
policy="${ANYBENCH_HIL_POLICY:?ANYBENCH_HIL_POLICY is not set: the kit human_in_loop.policy (auto, llm-reviewer, human-sim)}"
timeout_s="${ANYBENCH_WALL_CAP_S:-$(cfg timeout_s)}"
poll_s="$(cfg poll_s)"
startup_timeout_s="$(cfg startup_timeout_s)"
epic_timeout_s="$(cfg epic_timeout_s)"
drain_grace_s="$(cfg drain_grace_s)"
stop_grace_s="$(cfg stop_grace_s)"
max_restarts="$(cfg max_worker_restarts)"
for k in timeout_s poll_s startup_timeout_s epic_timeout_s drain_grace_s stop_grace_s max_restarts; do int "$k" "${!k}"; done
read -r -a disallowed <<< "$(cfg disallowed_tools)"
read -r -a scrub <<< "$(cfg scrub)"
planner_prompt="$here/$(cfg planner_prompt)"
worker_prompt="$here/$(cfg worker_prompt)"

tandem_home="${TANDEM_HOME:-$HOME/.anybench/tandem}"
tandem_bin="${TANDEM_BIN:-$tandem_home/bin/tandem}"
gateway="${TANDEM_MCP_BIN:-$tandem_home/mcp/node_modules/.bin/tandem-mcp}"
for b in "$tandem_bin" "$gateway"; do
  [[ -x "$b" ]] || { echo "$b is missing: run adapters/tandem/install-tandem.sh at snapshot build" >&2; exit 1; }
done
board() { node "$here/board.ts" "$@"; }

t_out="$out/tandem"
mkdir -p "$t_out/streams"
data="$(mktemp -d "${TMPDIR:-/tmp}/anybench-tandem.XXXXXX")"
keep="$(mktemp -d "${TMPDIR:-/tmp}/anybench-scrub.XXXXXX")"
started_ms="$(node -p 'Date.now()')"
# Stop early enough to collect inside the cap: three stop rounds plus 30 s for the dumps and copy.
reserve=$(( 3 * stop_grace_s + 30 ))
(( reserve < timeout_s / 2 )) || reserve=$(( timeout_s / 2 ))
deadline=$(( $(date +%s) + timeout_s - reserve ))
outcome="error"
reason=""

# Every background process is its own process group (job control), so a stop takes its children.
set -m
pids=()
server_pid=""
approver_pid=""
planner_pid=""

stop_group() { # stop_group <pid>...: TERM each group, wait up to stop_grace_s, then KILL
  local p left t
  for p in "$@"; do [[ -n "$p" ]] && kill -TERM -- "-$p" 2>/dev/null || true; done
  t=$(( $(date +%s) + stop_grace_s ))
  while (( $(date +%s) < t )); do
    left=0
    for p in "$@"; do [[ -n "$p" ]] && kill -0 "$p" 2>/dev/null && left=1; done
    (( left == 0 )) && break
    sleep 1
  done
  for p in "$@"; do [[ -n "$p" ]] && kill -KILL -- "-$p" 2>/dev/null || true; done
  for p in "$@"; do [[ -n "$p" ]] && wait "$p" 2>/dev/null || true; done
}

json_str() { node -p 'JSON.stringify(process.argv[1])' "$1"; }

finish() {
  local rc=$? ended_ms
  set +e
  # Agents first (they may still be writing), then the approver, then the board is read and the
  # server stopped, so the database copy is complete.
  stop_group ${pids[@]+"${pids[@]}"} "$planner_pid"
  stop_group "$approver_pid"
  if [[ -n "${api:-}" && -n "${code:-}" ]]; then board dump --api "$api" --code "$code" --out "$t_out" 2>> "$t_out/board.log"; fi
  stop_group "$server_pid"
  for f in tandem.db tandem.db-wal tandem.db-shm; do [[ -f "$data/$f" ]] && cp "$data/$f" "$t_out/$f"; done
  rm -rf "$data"
  # Scrub what init added, then hand the workspace to the scoring computer.
  for f in "${scrub[@]}"; do
    rm -rf "${ws:?}/$f"
    [[ -e "$keep/$f" ]] && cp -R "$keep/$f" "$ws/$f"
  done
  rm -rf "$keep" "$out/workspace"
  mkdir -p "$out/workspace"
  (cd "$ws" && tar --exclude=.git --exclude=node_modules -cf - .) | tar -C "$out/workspace" -xf -
  ended_ms="$(node -p 'Date.now()')"
  [[ "$outcome" == "error" && -z "$reason" ]] && reason="run.sh exited with status $rc"
  printf '{"outcome":"%s","reason":%s,"workers":%s,"policy":"%s","canvas_code":"%s","tandem_version":"%s","wall_ms":%s,"timeout_s":%s}\n' \
    "$outcome" "$(json_str "$reason")" "$workers" "$policy" "${code:-}" "${tandem_version:-}" \
    "$(( ended_ms - started_ms ))" "$timeout_s" > "$t_out/run.json"
  case "$outcome" in
    completed) exit 0 ;;
    timeout) exit 124 ;;
    *) echo "tandem harness: $outcome: $reason" >&2; exit 1 ;;
  esac
}
trap finish EXIT
trap 'reason="stopped by a signal"; exit 1' TERM INT

# 0. Model tokens from the Naïve model proxy (AB_TOKEN_SOURCE=naive_proxy, TDM-16
# docs/findings/claude-code-naive-proxy.md), exactly as adapters/claude-code/driver.sh does it, so
# every planner and worker session gets what the Claude Code contenders get: the worker writes a
# per-trial proxy:write key to $HOME/.anybench/proxy.env (0600); it is sourced here, before Tandem
# starts, never echoed and never on an argv. The kit's proxy settings (driver.env) win over the
# file's, and no direct Anthropic key can bypass the proxy. Tandem itself makes no model calls.
if [[ "${AB_TOKEN_SOURCE:-}" == naive_proxy ]]; then
  proxy_env="${NAIVE_PROXY_ENV:-$HOME/.anybench/proxy.env}"
  [[ -f "$proxy_env" ]] || { outcome="startup_failed"; reason="AB_TOKEN_SOURCE=naive_proxy but $proxy_env is missing"; exit 1; }
  pinned=()
  for k in CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS MAX_THINKING_TOKENS CLAUDE_CODE_MODEL_CAPABILITIES \
    ANTHROPIC_DEFAULT_OPUS_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL ANTHROPIC_DEFAULT_HAIKU_MODEL ANTHROPIC_SMALL_FAST_MODEL; do
    [[ -n "${!k:-}" ]] && pinned+=("$k=${!k}")
  done
  set -a; . "$proxy_env"; set +a
  for kv in ${pinned[@]+"${pinned[@]}"}; do export "${kv?}"; done
  export ANTHROPIC_MODEL="$model"
  unset ANTHROPIC_API_KEY
  : "${ANTHROPIC_BASE_URL:?$proxy_env sets no ANTHROPIC_BASE_URL}" "${ANTHROPIC_AUTH_TOKEN:?$proxy_env sets no ANTHROPIC_AUTH_TOKEN}"
fi

# 1. Server on a free port (never Tandem's default 7891) with its own TANDEM_DATA_DIR outside
# EVAL_OUT (its JWT secret never leaves the box): a bare `tandem` would open ~/.tandem/tandem.db.
port="$(board free-port)"
while [[ "$port" == 7891 ]]; do port="$(board free-port)"; done
api="http://127.0.0.1:$port"
TANDEM_BIN="$tandem_bin" TANDEM_AUTOSTART=0 TANDEM_DATA_DIR="$data" \
  "$gateway" up --foreground --no-open --port "$port" --data-dir "$data" > "$t_out/server.log" 2>&1 &
server_pid=$!
tandem_version="$(board wait-healthy --api "$api" --timeout-s "$startup_timeout_s")" \
  || { outcome="startup_failed"; reason="Tandem did not come up on $api"; exit 1; }

# 2. A fresh canvas wired into the workspace, as a user would do it. Keep what init will touch.
for f in "${scrub[@]}"; do
  if [[ -e "$ws/$f" ]]; then mkdir -p "$(dirname "$keep/$f")"; cp -R "$ws/$f" "$keep/$f"; fi
done
(cd "$ws" && API_URL="$api" TANDEM_AUTOSTART=0 "$gateway" init --write --name "anybench-${EVAL_TRIAL_ID:-trial}") \
  > "$t_out/init.log" 2>&1 || { outcome="startup_failed"; reason="tandem-mcp init failed"; exit 1; }
mcp="$t_out/mcp.json"
code="$(board mcp-config --from "$ws/.mcp.json" --out "$mcp" --gateway "$gateway" --api "$api")" \
  || { outcome="startup_failed"; reason="no canvas code in .mcp.json"; exit 1; }

# 3. Approver sidecar: @anybench/approver's `eval-approver` (TANDEM_APPROVER_BIN, else on PATH),
# attached to the canvas init made; it writes $t_out/approvals.jsonl and approvals.summary.json.
# TANDEM_APPROVER_ARGS carries its non-secret extras (llm-reviewer: --reviewer-model, …); its
# NAIVE_API_KEY comes from EVAL_SECRETS. Without it, the built-in approver (auto, human-sim only).
approver_bin="${TANDEM_APPROVER_BIN:-$(command -v eval-approver || true)}"
if [[ -n "$approver_bin" ]]; then
  read -r -a approver_args <<< "${TANDEM_APPROVER_ARGS:-}"
  (
    if [[ -n "${EVAL_SECRETS:-}" && -f "$EVAL_SECRETS" ]]; then set -a; . "$EVAL_SECRETS"; set +a; fi
    exec "$approver_bin" --policy "$policy" --tandem-url "$api" --out "$t_out" --canvas-code "$code" \
      --trial "${EVAL_TRIAL_ID:-trial}" --contender "${ANYBENCH_CONTENDER_ID:-tandem}" ${approver_args[@]+"${approver_args[@]}"}
  ) > "$t_out/approver.stdout.log" 2> "$t_out/approver.log" &
else
  board approve --api "$api" --code "$code" --policy "$policy" --poll-s 2 \
    > "$t_out/approvals.jsonl" 2> "$t_out/approver.log" &
fi
approver_pid=$!

# 4. Sessions. Secrets reach only these processes, and only through EVAL_SECRETS.
claude_version="$(claude --version 2>/dev/null | head -n 1 || true)"
printf '{"claude_code":%s,"node":"%s","tandem":"%s","tandem_mcp":%s,"model":%s,"tandem_workers":%s,"policy":"%s"}\n' \
  "$(json_str "$claude_version")" "$(node --version)" "$tandem_version" \
  "$(json_str "$("$gateway" --version 2>/dev/null | head -n 1)")" "$(json_str "$model")" \
  "$workers" "$policy" > "$out/versions.json"

render() { # render <template> <out> <worker-name>
  node -e '
    const fs = require("node:fs");
    const [tpl, task, out, workers, code, name] = process.argv.slice(1);
    let p = fs.readFileSync(tpl, "utf8");
    const vars = { TASK: fs.readFileSync(task, "utf8"), TANDEM_WORKERS: workers, TANDEM_CANVAS_CODE: code, WORKER_NAME: name };
    for (const [k, v] of Object.entries(vars)) p = p.replaceAll(`{{${k}}}`, v);
    fs.writeFileSync(out, p);
  ' "$1" "$task" "$2" "$workers" "$code" "$3"
}
session() { # session <name> <prompt-file>: one headless Claude Code session in the workspace
  local args=(-p "$(cat "$2")" --output-format stream-json --verbose --dangerously-skip-permissions
    --mcp-config "$mcp" --strict-mcp-config)
  args+=(--model "$model")
  (( ${#disallowed[@]} > 0 )) && args+=(--disallowedTools "${disallowed[@]}")
  (
    cd "$ws"
    if [[ -n "${EVAL_SECRETS:-}" && -f "$EVAL_SECRETS" ]]; then set -a; . "$EVAL_SECRETS"; set +a; fi
    # On the proxy, a key from EVAL_SECRETS must not bypass it (the same rule as the claude-code driver).
    if [[ "${AB_TOKEN_SOURCE:-}" == naive_proxy ]]; then unset ANTHROPIC_API_KEY; fi
    exec env TANDEM_AUTOSTART=0 claude "${args[@]}"
  ) 2>> "$t_out/streams/$1.stderr.log" < /dev/null | board tap --file "$t_out/streams/$1.jsonl"
}

render "$planner_prompt" "$t_out/planner-prompt.md" planner
session planner "$t_out/planner-prompt.md" &
planner_pid=$!

status() { board status --api "$api" --code "$code" 2> /dev/null || echo '{}'; }
field() { node -p 'const s=JSON.parse(process.argv[1]); String(s[process.argv[2]] ?? "")' "$1" "$2"; }

# Wait for approved work before starting workers (they would only idle on an empty board).
epic_deadline=$(( $(date +%s) + epic_timeout_s ))
while :; do
  s="$(status)"
  [[ "$(field "$s" has_approved_work)" == true ]] && break
  if ! kill -0 "$planner_pid" 2>/dev/null; then
    sleep "$poll_s"; s="$(status)"
    [[ "$(field "$s" has_approved_work)" == true ]] && break
    outcome="planner_failed"; reason="the planner exited without approved work on the board ($s)"; exit 1
  fi
  if ! kill -0 "$approver_pid" 2>/dev/null; then outcome="approver_failed"; reason="the approver sidecar exited ($(tail -n 3 "$t_out/approver.log" | tr '\n' ' '))"; exit 1; fi
  (( $(date +%s) >= deadline )) && { outcome="timeout"; reason="no approved work before the wall-clock cap"; exit 124; }
  (( $(date +%s) >= epic_deadline )) && { outcome="planner_failed"; reason="no approved work within epic_timeout_s=$epic_timeout_s"; exit 1; }
  sleep "$poll_s"
done

declare -a restarts
for (( i = 1; i <= workers; i++ )); do
  render "$worker_prompt" "$t_out/worker-$i-prompt.md" "worker-$i"
  session "worker-$i" "$t_out/worker-$i-prompt.md" &
  pids[i]=$!
  restarts[i]=0
done

# 5. Completion detector: the board is complete (every approved epic drained, nothing proposed or
# open). Sessions then get drain_grace_s to exit on their own; if the board is still complete after
# that (a late epic reopens it), the trial is done.
alive_any() { local p; for p in "$@"; do [[ -n "$p" ]] && kill -0 "$p" 2>/dev/null && return 0; done; return 1; }
while :; do
  s="$(status)"
  planner_alive=0
  kill -0 "$planner_pid" 2>/dev/null && planner_alive=1
  if [[ "$(field "$s" complete)" == true ]]; then
    t=$(( $(date +%s) + drain_grace_s ))
    while (( $(date +%s) < t )) && alive_any "$planner_pid" "${pids[@]}"; do sleep 1; done
    s="$(status)"
    if [[ "$(field "$s" complete)" == true ]]; then
      outcome="completed"; reason="every approved epic drained ($s)"; exit 0
    fi
  fi
  if (( $(date +%s) >= deadline )); then outcome="timeout"; reason="wall-clock cap ${timeout_s}s ($s)"; exit 124; fi
  if ! kill -0 "$approver_pid" 2>/dev/null; then outcome="approver_failed"; reason="the approver sidecar exited"; exit 1; fi
  # Keep N workers while work is open; a slot that keeps dying is given up on.
  any=0
  for (( i = 1; i <= workers; i++ )); do
    if kill -0 "${pids[i]}" 2>/dev/null; then any=1; continue; fi
    if (( restarts[i] < max_restarts )); then
      restarts[i]=$(( restarts[i] + 1 ))
      echo "{\"event\":\"worker_restart\",\"worker\":\"worker-$i\",\"n\":${restarts[i]}}" >> "$t_out/harness.jsonl"
      # A restarted session gets its own transcript: each one ends in its own `result` line.
      session "worker-$i.r${restarts[i]}" "$t_out/worker-$i-prompt.md" &
      pids[i]=$!
      any=1
    fi
  done
  if (( any == 0 && planner_alive == 0 )); then
    outcome="workers_exhausted"; reason="every worker exited (restarts used up) with work open ($s)"; exit 1
  fi
  sleep "$poll_s"
done
