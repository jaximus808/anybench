# coding-agent driver: headless Claude Code as a non-root eval user (TDM-39)

Captured on 2026-11-07 on macOS arm64 (Claude Code 2.1.319 locally) and in Docker Desktop
(`node:22`, node v22.23.4). Code: `packages/kit/src/drivers/coding-agent/`. Example kit:
`packages/kit/examples/coding-agent/`. No run spent money: the local Claude Code probe used an
invalid key, and every trial below ran a fake `claude` that replays a recorded-shape transcript.

## Claude Code flags (real CLI, invalid key, no spend)

```
$ ANTHROPIC_API_KEY=sk-ant-invalid-test HOME=$PWD/home timeout 30 claude -p "hi" \
    --output-format stream-json --verbose --max-turns 3 --model claude-sonnet-4-5-20250929 \
    --disallowedTools "Task Agent" < /dev/null > out.jsonl 2> err.txt; echo "exit=$?"
exit=1
```

- 3 lines: `system/init`, a `<synthetic>` assistant message, then `result` with
  `"is_error":true,"subtype":"success","api_error_status":401,"result":"Invalid API key · Fix external API key"`.
- The init event carries `"model":"claude-sonnet-4-5-20250929"`, `"claude_code_version":"2.1.319"`
  and `"apiKeySource":"ANTHROPIC_API_KEY"`. So the driver checks the model pin against the init
  event after the run, and the version pin against `claude --version` before it.
- `--max-turns` is accepted although `claude --help` (2.1.319) no longer lists it.
- `--disallowedTools "Task Agent"` (one space-separated value) is accepted; help says "Comma or
  space-separated list". The init event's `tools` then lists neither `Task` nor `Agent`.
- A fresh `HOME` works in `-p` mode with an API key: no onboarding prompt. It writes
  `$HOME/.claude.json` and `$HOME/.claude/`.
- The key never appeared in stdout or stderr (`grep -c sk-ant-invalid` printed 0 for both).

## The eval-user switch on Linux (Docker, fake claude; anthropic-key path, before the token source existed)

The stub plans from `planCodingAgentStubTrial` / `planCodingAgentStubGate` were materialized and
run in `docker run --rm node:22` with users `naive` (passwordless sudo, HOME 0700, like a Naïve
computer) and `eval`, and a fake `/usr/local/bin/claude` that logs what it can see, prints its
key into the stream, and leaves a `setsid sleep 300` behind.

```
== honest, as naive (sudo -n -u eval)
run exit 0
user=eval uid=1002 home=/home/eval pwd=/home/eval/anybench-trial/ws
key=sk-ant-tdm39...
runner-secrets=denied
runner-home=denied
  drwxr-xr-x 2 eval eval 4096 Nov  8 03:28 .claude
  drwx------ 3 eval eval 4096 Nov  8 03:28 anybench-trial
eval processes left: 0
key in out/: 0  in stdout: 0
{"contender":"claude-code","claude_code":"2.0.14","claude_code_reported":"2.0.14 (Claude Code)","model":"claude-sonnet-4-5-20250929","node":"v22.23.4","eval_user":"eval","max_turns":"40","token_cap_tokens":"2000000","disallowed_tools":"","do_less":false}
{"pass":true,"reason":"hidden-tests: 7/7 hidden tests pass on slugify","evidence":["hidden-tests.tap"]}
== do-less, as root (runuser -u eval)
run exit 1
user=eval uid=1002 home=/home/eval pwd=/home/eval/anybench-trial/ws
{"pass":false,"reason":"hidden-tests: 0/7 hidden tests pass on slugify (7 failed, exit 1)","evidence":["hidden-tests.tap"]}
```

- Both switches work: `sudo -n -H -u eval -- env -i ...` from the Naïve-style user, and
  `runuser -u eval -- env -i ...` from root (docker-local).
- The agent got its key in its env, but could not read the runner's HOME or `secrets.env`, and
  `~/.anybench-secrets/` was already deleted when it started (the launcher reads then removes it).
- The key it printed was `[REDACTED]` in `stream.jsonl`, `coding-agent/stderr.txt` and stdout.
- `kill -9 -1` as eval killed the leftover `sleep` (0 eval processes after the run).

## Naïve proxy (the default token source) and the token cap (Docker, fake claude)

Same container setup, plans made with `proxyEnv` (base URL, a fake `proxy:write` token, the
model) and no Anthropic key; the fake prints its argv and the env it got. Abridged:

```
== honest, as naive (sudo -n -u eval)
run exit 0
user=eval uid=1002 home=/home/eval pwd=/home/eval/anybench-trial/ws
argv: claude -p '<instruction.md>' --output-format stream-json --verbose --model anthropic/claude-sonnet-4.6 --dangerously-skip-permissions --max-turns 40
token=naive-proxy-... api_key=unset base=https://api.vetta.sh/v1/proxy/anthropic
  ANTHROPIC_DEFAULT_HAIKU_MODEL=anthropic/claude-sonnet-4.6
  ANTHROPIC_DEFAULT_OPUS_MODEL=anthropic/claude-sonnet-4.6
  ANTHROPIC_DEFAULT_SONNET_MODEL=anthropic/claude-sonnet-4.6
  ANTHROPIC_MODEL=anthropic/claude-sonnet-4.6
  ANTHROPIC_SMALL_FAST_MODEL=anthropic/claude-sonnet-4.6
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1
  CLAUDE_CODE_MODEL_CAPABILITIES=-effort,-max_effort,-xhigh_effort,-per_turn_effort,-adaptive_thinking,-context_management,-rejects_disabled_thinking
  MAX_THINKING_TOKENS=0
runner-secrets=denied
runner-home=denied
eval processes left: 0
key in out/: 0  in stdout: 0
{"contender":"claude-code","claude_code":"2.1.319","claude_code_reported":"2.1.319 (Claude Code)","model":"anthropic/claude-sonnet-4.6","node":"v22.23.4","eval_user":"eval","max_turns":"40","token_cap_tokens":"2000000","disallowed_tools":"","token_source":"naive-proxy","provider":"naive:anthropic","effort":"naive-min","thinking":"off","model_capabilities":"-effort,...","do_less":false}
{"pass":true,"reason":"hidden-tests: 7/7 hidden tests pass on slugify","evidence":["hidden-tests.tap"]}
== do-less, as root (runuser -u eval)
{"pass":false,"reason":"hidden-tests: 0/7 hidden tests pass on slugify (7 failed, exit 1)","evidence":["hidden-tests.tap"]}
== token cap 20000, as naive
run exit 1
{"token_cap_tokens":20000,"tokens":26111}
token cap exceeded: {"token_cap_tokens":20000,"tokens":26111}
stream lines kept: 7  stdout lines (runner meter): 7
eval processes left: 0
```

- The worker's proxy file only set the base URL, token and model; the driver added the three
  required switches and pointed every model alias at the Naïve id (TDM-16 findings). A file that
  sets `MAX_THINKING_TOKENS` to anything but 0, drops a capability, or names an Anthropic id for
  an alias is refused.
- The token cap closed the stream at the line that crossed it; Claude Code then died on EPIPE.
  The cap file is what the executor watches to revoke the proxy key at once
  (`packages/bench/test/tdm39-executor-proxy-key.test.ts`).

## Wiring TDM-16's helpers (executor)

`TrialPrepared.proxy_key` is the adapter: the TrialSource passes
`{ secret: cred.secret, revoke: () => revokeTrialProxyCredential(keys, cred), enforce: () =>
enforceTrialProxyBudget({ keyId: cred.keyId, capMicroUsd }) }` and puts the proxy env file in
`files` as `.anybench/proxy.env` (mode 0600). The executor calls `enforce` every poll, revokes on
the runner's `token_cap.exceeded` or the driver's `coding-agent/token-cap.json`, and revokes at
the end of the attempt on every path except a worker abort or lost lease. The secret also goes to
`~/.anybench/env` as `ANYBENCH_PROXY_AUTH_TOKEN`, so the runner redacts it.
`withCapacityRetry(computers)` (@anybench/naive) retries a Naïve 429 on create, exec, writeFile
and mkdir with exponential backoff; it never retries a 5xx.

## What the eval computers need (agent-cc profile, [3.x])

- A non-root `eval` user, and passwordless `sudo` from the runner's user to it (`naive ALL=(eval)
  NOPASSWD: ALL` is enough). The runner's HOME should be 0700 so eval can't read
  `~/.anybench/env` or the per-trial ingest token.
- Claude Code installed globally (`npm install -g @anthropic-ai/claude-code@$CLAUDE_CODE_VERSION`)
  on a PATH eval can read, not under `/home/naive/.nvm`. The driver passes the runner's PATH to
  eval (override with `ANYBENCH_EVAL_PATH`).
- `node` on that PATH (Claude Code needs it; the driver uses it to redact, meter and freeze).

## Contract for the kit → TrialJob mapping ([5.9])

The driver reads its pins and caps from env, so the worker must export, per contender:
`CLAUDE_CODE_VERSION` (and every other `versions` key), `ANYBENCH_MODEL` (driver.model),
`ANYBENCH_MAX_TURNS` (driver.max_turns), `ANYBENCH_TOKEN_CAP_TOKENS` (driver.token_cap_tokens),
plus `driver.env` and the overlay's env. The stub does exactly this. The spend cap
(`token_cap_micro_usd`) stays the runner's (TrialJob); the driver tees the stream to stdout so
the runner's meter sees it live.
