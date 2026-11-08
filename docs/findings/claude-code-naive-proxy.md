# Claude Code on a Naïve computer, paid from Naïve credit (TDM-16 [2.2], 2026-11-08)

**Answer: YES.** The Claude Code CLI (2.1.319), running on a Naïve computer, gets all its model tokens from Naïve's Anthropic-compatible proxy, billed to Naïve credit, with no Anthropic key. `claude -p … --output-format stream-json --verbose` runs end to end: single turn, multi-turn tool use (Write, Bash), an Explore subagent, and an MCP server with 25 Tandem-shaped tools. It needs **five env switches** (below), because Claude Code otherwise sends three request fields that the proxy refuses with a 400. Naïve bills **exactly Anthropic list price**: every call matched Claude Code's own list-price `total_cost_usd` to the micro-dollar, and `billed_micro_usd == vendor_cost_micro_usd`, so there is no markup. The managed `claude_code` harness exists but has `runnable: false` on this deploy, so we can't use it.

Every claim comes from a live call. The spike script is `scripts/spikes/claude-code-naive-proxy/spike.ts`. Run it as `ENV_FILE=<repo>/.env SPIKE_STATE=<0600 file> SPIKE_LOG=<file> ../naive-hosting/run.sh spike.ts <cmd>`. The helper is in `packages/naive/src/proxy-credentials.ts`. No Anthropic key was used.

## Summary

| Question | Answer |
|---|---|
| Anthropic-compatible endpoint? | **Yes.** `ANTHROPIC_BASE_URL=https://api.vetta.sh/v1/proxy/anthropic`. Streaming SSE works (`message_start` … `message_stop`, with `resolved_model` on `message_delta`). |
| Auth | A Naïve key with scope **`proxy:write`** only, minted with `keys.create` (that needs an `admin` key). Claude Code sends it as `Authorization: Bearer` via `ANTHROPIC_AUTH_TOKEN`; the proxy also accepts `x-api-key`. |
| Claude models offered | `anthropic/claude-{haiku-4.5, haiku-5.5, sonnet-4.5, sonnet-4.6, sonnet-5, sonnet-5.5, opus-4.1, opus-4.5, opus-4.6, opus-4.7, opus-4.8, opus-5, opus-5.5}`, each also as a `:batch` id, plus the aliases `~anthropic/claude-{haiku,sonnet,opus}-latest` and `anthropic/claude-fable-5{,.1}:batch`. All `immediate` window only. The ids are Naïve's: `claude-sonnet-4-6` is refused. |
| Price vs direct Anthropic | **The same.** Verified live for haiku-4.5, haiku-5.5, sonnet-4.6 and opus-5.5 (table below). |
| `claude -p --output-format stream-json` end to end | **Yes**, with the env file below. |
| Tandem | **Same path.** Tandem makes no model calls itself. Its workers are `claude` processes that inherit the environment, and the MCP tool round-trip works through the proxy (tested with a 25-tool MCP stub). |
| Naïve `claude_code` harness | Listed (`preview`, `sandbox`, `billing: usage`) but **`runnable: false`**, and approvals, structured_output and streaming_deltas are all `false`. It can't be used today, and it wouldn't be a fair Claude Code vs Tandem setup anyway (see the end). |
| Scope of a `proxy:write` key | Every route that touches a machine is **403**. Read-only computer metadata (list, get) is allowed; this risk is accepted, see section 6.1. |
| Spend | **560,941 µ$ ($0.56)** = 507,602 µ$ tokens (20 proxy calls) + 53,339 µ$ for one 2 vCPU / 4 GiB computer over about 15 min. Read from `credits.ledger` filtered to this spike's two keys and its computer. |

## 1. Discovery

```
auth.me (admin key) → scopes [sessions:*, proxy:write, computers:write, files:*, billing:*, webhooks:*, audit:read, admin, agents:read]
credits.show        → {"balance_micro_usd":250881852,"mode":"live"}   (03:08:49Z, before)
models.list search=claude → (trimmed) {"id":"anthropic/claude-sonnet-4.6","context_window":1000000,"max_output_tokens":32768,
                              "supported_windows":["immediate"],"efforts":["low","medium","high"]}, … (ids above)
                           haiku-4.5 / sonnet-4.5 / opus-4.5 / opus-4.1 publish "efforts":[]
harnesses.list → pi (ga, runnable) · claude_code {"status":"preview","execution":"sandbox","runnable":false,
                 "capabilities":{"approvals":false,"structured_output":false,"streaming_deltas":false,"injected_tools":true}}
                 · vetta (preview, runnable) · hermes (preview, runnable:false)
```

The model object has no prices. Prices come from the trace and ledger of each call (section 4).

## 2. Proxy key and raw probes (from the Mac, haiku-4.5)

```
keys.create {name:"tdm16-spike-proxy", scopes:["proxy:write"]} → {"id":"key_hqtk82tywkhx4sfhze4bjdm6g3","scopes":["proxy:write"],"mode":"live", "secret":<redacted>}
auth.me (proxy key)      → scopes ["proxy:write"]
credits.show (proxy key) → 403 forbidden "this API key is missing the `billing:read` scope"
computers.list (proxy key) → 200 {"data":[]}     ← proxy:write is NOT a confinement boundary (docs say the same)
```

| Probe (`POST /v1/proxy/anthropic/v1/messages`) | Result |
|---|---|
| plain, `max_tokens 64` | 200, `"content":[{"type":"text","text":"OK"}]`, usage 13 in / 4 out |
| `stream: true` | 200 SSE, full Messages event sequence |
| `cache_control` on system and user blocks | 200 (accepted) |
| `thinking: {type:"enabled", budget_tokens:1024}` | **400** `thinking.type: Invalid input: expected "disabled"` |
| `anthropic-beta: claude-code-20250219,interleaved-thinking-2025-05-14` header | 200 (header ignored) |
| `POST …/v1/messages/count_tokens` | **404** `no route` (Claude Code `-p` never needed it) |

## 3. Claude Code on the computer

```
computers.create {vcpu:2, memory_mb:4096, disk_gb:10} → 429 rate_limited "the service is at capacity" (after 15 s), then 202 on retry
  cmp_01a1b922fb0970e5b8cc0f0e63a434c5 · user tenki (uid 1000), HOME=/home/tenki · node v24.22.1 · npm 11.19.1 · x86_64 · 9.8G disk
exec "npm config set prefix ~/.npm-global && npm i -g @anthropic-ai/claude-code; ~/.npm-global/bin/claude --version"   (3.8 s)
  → "added 2 packages in 3s" + npm warn install-scripts (postinstall not allowed under npm 11 allowScripts) → "2.1.319 (Claude Code)"
```

Installing as the non-root user with a user prefix works. npm 11 skips the postinstall, and the CLI runs anyway.

The env file reaches the computer only through `fs/write` and then `chmod 600`. No secret was ever on an exec argv. Each `claude` run below is one exec:

```
cd ~/work && set -a && . ~/.anybench/<file>.env && set +a && \
timeout 240 ~/.npm-global/bin/claude -p "<task>" --output-format stream-json --verbose --dangerously-skip-permissions < /dev/null > run.jsonl 2> run.err
```

(Without `< /dev/null`, `-p` prints "no stdin data received in 3s" and waits 3 s.)

### Each 400, and the switch that removes it

| Run | Env added | Result (last stream-json line) |
|---|---|---|
| 1, haiku-4.5 | base URL + token + model only | `"is_error":true,"result":"API Error: 400 unknown body field: context_management"` |
| 2 | `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` | `"API Error: 400 thinking.type: Invalid input: expected \"disabled\""` |
| 3 | `MAX_THINKING_TOKENS=0` | **ok**: `"result":"DONE"`, `num_turns 2`, `hello.txt` = `naive-proxy-ok`, `total_cost_usd 0.03571285` |
| 4, sonnet-4.6 | (as run 3) | `"API Error: 400 unknown body field: output_config"` (the effort parameter) |
| 5 | `ANTHROPIC_DEFAULT_SONNET_MODEL=… ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES=` | same 400. The per-alias override did not take effect for `--model anthropic/claude-sonnet-4.6`. |
| 6 | `CLAUDE_CODE_MODEL_CAPABILITIES=-effort,-max_effort,-xhigh_effort,-per_turn_effort,-adaptive_thinking,-context_management,-rejects_disabled_thinking` | **ok**: 3 turns, tools `Write` + `Bash`, `fizz.py` prints `…14\nFizzBuzz`, `total_cost_usd 0.11620815` |

I found `CLAUDE_CODE_MODEL_CAPABILITIES` in the 2.1.319 binary (`strings`). It is a `;`-separated list of `[model=]cap,-cap`; an entry with no `model=` applies to every model, and `-cap` turns a capability off. Claude Code's baked-in catalogue gives sonnet-4.6 `["effort","max_effort","adaptive_thinking","context_management",…]`, and Claude Code maps `anthropic/claude-sonnet-4.6` onto it (`"canonicalModel":"claude-sonnet-4-6"` in `modelUsage`). That is why it sent `output_config`.

### With the helper's env file (`provisionClaudeCodeProxyEnv`, second key `key_tv66nygde2vxhgp4bs7patwbky`)

```
provisionClaudeCodeProxyEnv {trialId:"tdm16-spike", model:"anthropic/claude-opus-5.5", smallFastModel:"anthropic/claude-haiku-4.5"} (5.3 s)
  → {"anthropicBaseUrl":"https://api.vetta.sh/v1/proxy/anthropic","envFile":{"fsPath":"/home/naive/.anybench/proxy.env","shellPath":"$HOME/.anybench/proxy.env"}}
exec "ls -l ~/.anybench/; cut -d= -f1 ~/.anybench/proxy.env"
  → -rw------- 1 tenki tenki 730 … proxy.env
    ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_MODEL ANTHROPIC_DEFAULT_OPUS_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL
    ANTHROPIC_DEFAULT_HAIKU_MODEL ANTHROPIC_SMALL_FAST_MODEL CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS MAX_THINKING_TOKENS
    CLAUDE_CODE_MODEL_CAPABILITIES CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC DISABLE_TELEMETRY DISABLE_ERROR_REPORTING DISABLE_AUTOUPDATER
```

| Run (sources only `proxy.env`) | Result |
|---|---|
| opus-5.5, "launch an Explore subagent to find the file with banana, write it to answer.txt" | ok: 3 turns, tools `Agent` + 2×`Bash`, `subagent_stats {"spawned":1,"completed":1,"by_type":{"Explore":1}}`, `answer.txt` = `src/f4.txt`, `total_cost_usd 0.2030956`. The Explore agent inherited opus-5.5 (2 of the 5 calls). |
| sonnet-4.6 + `--mcp-config mcp.json --strict-mcp-config`, a stdio MCP stub with 25 Tandem-named tools | ok: `mcp_servers [{"name":"fakeboard","status":"connected"}]`, 50 tools offered, calls `mcp__fakeboard__queue_next` → `task_claim` → `Write` → `task_complete`, `greeting.txt` = `hi`, 5 turns, `total_cost_usd 0.1497561` |
| haiku-5.5, "Reply PONG" | ok: `"result":"PONG"`, `total_cost_usd 0.0026884`. haiku-5.5 carries `rejects_disabled_thinking`, which the capability switch turns off. |

The ticket also asks about running as root. The run used the non-root `tenki` user, which `bypassPermissions` accepts. Known behaviour, not run here: Claude Code refuses `--dangerously-skip-permissions` as root unless `IS_SANDBOX=1`. The `agent-cc` profile uses a non-root `eval` user, so this doesn't come up.

## 4. Billing: per-call traces vs Anthropic list price

`proxy.calls` (admin key, `audit:read`) has one trace per call. Every trace carries `actor: {type:"key", id:<trial key>}`, `source:"proxy"`, the five token tiers, `billed_micro_usd` and `vendor_cost_micro_usd`. `credits.ledger` carries the same actor, so **a per-trial key gives per-trial token metering for free.**

| Model (served by) | Trace (in / cache_write / cache_read / out / reasoning) | Billed µ$ | List-price check ($/MTok in, cw5m, cr, out) |
|---|---|---|---|
| haiku-4.5 (Anthropic) | 3 / 25,911 / 0 / 98 / 0 | 32,882 | 1, 1.25, 0.10, 5 → 3 + 32,388.75 + 490 = 32,881.75 ✓ |
| haiku-4.5 (Anthropic) | 5 / 168 / 25,911 / 5 / 0 | 2,831 | 5 + 210 + 2,591.1 + 25 = 2,831.1 ✓ |
| sonnet-4.6 (Anthropic) | 3 / 25,342 / 0 / 165 / 23 | 97,862 | 3, 3.75, 0.30, 15 → 9 + 95,032.5 + 188×15 = 97,861.5 ✓ (reasoning billed as output) |
| sonnet-4.6 (Anthropic) | 1 / 239 / 25,342 / 88 / 0 | 9,822 | 3 + 896.25 + 7,602.6 + 1,320 = 9,821.85 ✓ |
| opus-5.5 (**Azure**) | 4 / 21,413 / 0 / 170 / 0 | 110,481 | 4, 5, 0.20, 20 → 16 + 107,065 + 3,400 = 110,481 ✓ |
| opus-5.5 (Azure) | 2 / 121 / 21,763 / 45 / 0 | 5,866 | 8 + 605 + 4,352.6 + 900 = 5,865.6 ✓ |
| haiku-5.5 (Azure) | 4 / 21,484 / 0 / 5 / 0 | 2,688 | 0.10, 0.125, 0.01, 0.50 → 0.4 + 2,685.5 + 2.5 = 2,688.4 ✓ |

The list prices are Claude Code 2.1.319's own baked-in `pricing_tiers` (`tier_3_15`, `tier_4_20_cache_read_0_20`, `haiku_45`, `haiku_55`), which is what its `total_cost_usd` (`"costBasis":"list"`) uses. Per run, Naïve's sum equals Claude Code's figure: haiku-4.5 35,713 µ$ vs $0.03571285; sonnet-4.6 116,209 vs $0.11620815; opus-5.5 203,096 vs $0.2030956. `billed == vendor_cost` on every row, so Naïve adds no markup on the proxy (its pricing page says the same). Prompt caching works through the proxy and is billed at cache rates; Claude Code's ~25k-token system prompt is written once per run and read after that.

Catalogue list prices for models not run live, per MTok in/out: sonnet-5 $2/$10, sonnet-5.5 $2/$10 (cache read $0.10), opus-4.6 $5/$25. Naïve's router picks the fastest host in the `immediate` window, and its docs warn that two identical calls can then cost different amounts. Every call here billed at list. Keep reading `billed_micro_usd`; don't assume a fixed price.

## 5. Behaviour changes to record in every trial

1. **No client-chosen effort or extended thinking.** The proxy refuses `output_config` and `thinking.type != "disabled"`, and runs the model at its lowest published effort. Sonnet-4.6 still reported 23–28 `reasoning` tokens on a first call. So Claude Code on Naïve isn't the same configuration as first-party Claude Code at its default effort. Compare contenders only when both run through the proxy, and record `tokens: naive-proxy, effort: naive-min, thinking: off` with the trial.
2. **No `context_management`** (server-side context editing) and **no `count_tokens`.** Long sessions rely on Claude Code's client-side auto-compact.
3. **Model aliases.** `sonnet`, `opus`, `haiku` and the subagent defaults resolve through `ANTHROPIC_DEFAULT_*_MODEL`, and the helper sets all of them. An Anthropic id that reaches the proxy is refused, never silently mapped.
4. **Provider mix.** opus-5.5 and haiku-5.5 were served by Azure, the 4.x models by Anthropic. Latency and availability follow the host. Record `provider` from the trace.
5. **Capacity 429s.** Naïve answered `429 rate_limited "the service is at capacity"` after about 15 s on `computers.create`, on `exec` (3 times) and on `fs/write` (3 times) during this spike. The model proxy never returned 429. Callers need retry with backoff, and the runner must not count a 429 against the subject.

## 6. Security

### 6.1 Scope probe: what a `proxy:write` key can reach (review blocker, run 2026-11-08 03:44Z)

`spike.ts scope-probe` mints a fresh trial key with `mintTrialProxyCredential`. It calls every route that could reach a computer, an agent or a session, using a made-up id `cmp_00000000000000000000000000000000` or an invalid body, so nothing is created. Then it revokes the key, and the next call gets `401 unauthorized "invalid API key"`. A 403 means the scope blocks the route. A 400 or 404 means the request got past the scope check to the handler.

| Route (proxy:write key) | Status | Message |
|---|---|---|
| `POST /v1/computers/{id}/exec` | **403** | this API key is missing the `computers:write` scope |
| `POST /v1/computers/{id}/fs/read` · `fs/write` · `fs/remove` · `fs/list` | **403** | missing `computers:write` |
| `DELETE /v1/computers/{id}` · `PATCH /v1/computers/{id}` | **403** | missing `computers:write` |
| `POST /v1/computers/{id}/pause` · `resume` · `snapshot` | **403** | missing `computers:write` |
| `GET /v1/computers/{id}/inspect` · `GET …/commands` | **403** | missing `computers:write` |
| `POST /v1/computers` (invalid body) | **403** | missing `computers:write` |
| `GET /v1/computers` | 200 | `{"data":[],…}` (**read-only metadata**) |
| `GET /v1/computers/{id}` | 404 | `no such computer` (**read-only metadata**, passes the scope) |
| `POST /v1/sessions` · `GET /v1/sessions` | **403** | missing `sessions:write` / `sessions:read` |
| `POST /v1/agents` · `GET /v1/agents` · `POST /v1/apps` | **403** | missing `agents:write` / `agents:read` |
| `POST /v1/api_keys` | **403** | missing `admin` |
| `POST /v1/mcp_sessions` (invalid body) | 400 | validation_failed (the body is validated first) |
| `POST /v1/mcp_sessions {name}` | **403** | only a signed-in person can connect their own agent |
| `POST /v1/mcp_sessions {name, scopes:["computers:write"], allowed_tools:["computers_exec_command"]}` | **403** | only an owner or an admin can choose an MCP session's scopes and tools |
| `GET /v1/proxy/calls` · `GET /v1/credits/ledger` · `GET /v1/files` | **403** | missing `audit:read` / `billing:read` / `files:read` |
| `POST /v1/proxy/anthropic/v1/messages` | 200 | (the one thing it is for) |

**Decision (orchestrator, 2026-11-08): accepted.** A trial key can't exec on, read or write files on, inspect, snapshot, pause, delete or create any computer. It also can't mint a wider credential. The scoring computer is unreachable. What it *can* do is read computer **metadata**: list the org's computers and get one by id (id, name, vCPU/memory/disk, status, agent_id, snapshot_id). That is an accepted risk. The known exposure is that computer names carry run and trial tags (TDM-22 encodes them for the reaper), so a contender can see other trials' names and statuses. A follow-up ticket will make the tags opaque (an HMAC of run and trial id) while keeping them resolvable by the reaper.

### 6.2 MCP-session credentials don't work on the proxy

`mcpSessions.create {scopes:["proxy:write"], allowed_tools:["models_list_catalog"], expires_in_seconds:300}` (admin) mints an `mcp_…` bearer. Expiry would have made it a crash backstop. But the proxy refuses it: `403 "an MCP session may not call this route"`. The Naïve MCP catalog (366 tools) has no proxy tool, and an MCP bearer only works on REST routes behind an allowlisted tool. Every other route in the probe was 403 for it too. **So it can't be used for auto-expiry.** Trial keys are long-lived API keys, and the backstop is revoke-at-end plus the reaper sweep.

### 6.3 Spend: there is no per-key cap on Naïve, so we enforce one

A key has no spend limit of its own. An agent that reads its env can spend on any catalogue model up to the org balance. `enforceTrialProxyBudget` closes this after the fact:

- `trialProxySpend(source, {keyId, since})` sums the key's debits as bigint micro-USD. `since` is the credential's `createdAt`. Neither live list filters by actor on the server, so the reader pages newest first and stops at `since`.
  - `liveLedgerSpend` (`GET /v1/credits/ledger?type=debit&from=<since>`, needs `billing:read`) is the recommended source. The ledger is the authority on what was charged: it books a partial debit for a stream that failed part-way, where a trace's `billed_micro_usd` is null. Ledger rows also carry no prompt bodies.
  - `liveProxyCallsSpend` (`GET /v1/proxy/calls`, needs `audit:read`) reads the traces' `billed_micro_usd`. It works too, but every row carries the full prompt and reply (about 38 KB per Claude Code call), so it's heavy for a heartbeat.
  - Live check, read-only, for the probe key's one call: ledger `35 µ$, 1 call` in 786 ms; proxy.calls `35 µ$, 1 call` in 548 ms. The two sources agree.
- `enforceTrialProxyBudget({keys, spend}, {keyId, capMicroUsd, since})` returns `{spentMicroUsd, capMicroUsd, remainingMicroUsd, calls, unpricedCalls, revoked}` and revokes the key once `spent >= cap`. It's after-the-fact: calls in flight when the cap is crossed still settle, so the overshoot is bounded by those calls' cost, not zero. Keep the poll interval short, and the cap below the run budget by one call's worth.

### 6.4 Secret handling

- On credentials from `mintTrialProxyCredential`/`makeTrialProxyCredential`, `TrialProxyCredential.secret` is **non-enumerable**, and `toJSON` replaces it with `<redacted:naive-proxy-key>`. So `JSON.stringify`, `{...cred}`, `Object.values` and `util.inspect` never carry it (unit-tested). Read it with `trialProxySecret(cred)`, and add it to the runner's redaction list with `createRedactor` (`@anybench/core`).
- The secret travels only in the `fs/write` body. The helper makes `~/.anybench` 0700, pre-creates the file 0600 with `umask 077`, writes it, then re-checks `stat -c '%a %s'` and refuses anything but 600 at the right size. No exec argv contains it (unit-tested).

### 6.5 Integration (TDM-39 coding-agent driver, TDM-49 executor/reaper)

1. **Trial start:** `provisionClaudeCodeProxyEnv(...)`. Store `credential.keyId` and `credential.createdAt` on the trial row, never the secret, and add `trialProxySecret(credential)` to the trial's redactor.
2. **Every heartbeat:** `enforceTrialProxyBudget({keys, spend: liveLedgerSpend(admin)}, {keyId, capMicroUsd: <trial token cap>, since: createdAt})`. On `revoked: true`, stop the subject and record the trial as budget-exceeded.
3. **Trial end, on every path** (success, subject failure, timeout, cancel, infra failure): `revokeTrialProxyCredential(keys, {keyId})`, in a `finally`. It's idempotent, and a 404 counts as done.
4. **`computer.reap` sweep:** `revokeStaleTrialProxyKeys(keys, keep)`, where `keep` is the set of `keyId`s of trials that are still live. That revokes the key of any trial that crashed before step 3.

## 7. Can the Naïve `claude_code` harness run a fair Claude Code vs Tandem benchmark?

Not today: `runnable: false`, so a session on it is a 501. Even once it's runnable, it would be the wrong tool. Naïve drives the CLI inside its own session: it chooses the version and flags, injects its own tool endpoint into every turn, and leaves out any tool whose permission is `ask`. Its capabilities are `approvals:false`, `structured_output:false` and `streaming_deltas:false`, and its output is Naïve's event stream, not `stream-json`. Tandem (a board plus several `claude` workers) can't run inside it at all. That would compare a Naïve-managed Claude Code against our own Tandem setup, so the harness, not the contender, would be the variable. **Recommendation:** run both contenders ourselves on Naïve computers (the `agent-cc` profile), with the same pinned CLI, the same env file and the same model, all paid through the proxy. That is the path verified here.

## 8. Recommended `agent-cc` setup

The profile build runs as the `eval` user, and no secret is involved:

```sh
npm config set prefix "$HOME/.npm-global"
npm i -g @anthropic-ai/claude-code@2.1.319     # pin; record the version in the trial
"$HOME/.npm-global/bin/claude" --version
```

Per trial (TypeScript, in the worker):

```ts
import { liveProxyKeys, createNaiveClient, provisionClaudeCodeProxyEnv, revokeTrialProxyCredential } from "@anybench/naive";
const keys = liveProxyKeys({ apiKey: env.NAIVE_API_KEY, baseUrl: env.NAIVE_BASE_URL });  // admin key
const { credential, envFile } = await provisionClaudeCodeProxyEnv(
  { keys, computers: createNaiveClient({ apiKey: env.NAIVE_API_KEY }).computers },
  { trialId, computerId, model: "anthropic/claude-sonnet-4.6", smallFastModel: "anthropic/claude-haiku-4.5" },
);
// launch: set -a && . "$HOME/.anybench/proxy.env" && set +a && claude -p … --output-format stream-json --verbose < /dev/null
// finally: await revokeTrialProxyCredential(keys, credential);
```

Tandem workers: source the same file before starting `tandem-mcp listen --exec 'claude -p …'` (or the harness's own worker launcher). The listener spawns each worker with `{ ...process.env, ...execEnv(batch) }` (agentcanvas `apps/mcp-gateway/src/listen/server.ts:185`), so every worker inherits the proxy env.

## Cleanup

```
keys.revoke key_hqtk82tywkhx4sfhze4bjdm6g3 → deleted:true ; keys.revoke key_tv66nygde2vxhgp4bs7patwbky → deleted:true
proxy call with the revoked secret → 401 {"code":"unauthorized","message":"invalid API key"}
computers.delete cmp_01a1b922fb0970e5b8cc0f0e63a434c5 → deleted:true ; computers.list → []
credits.show → 250,237,135 (the org-wide balance also fell from other workers' computers; this spike's own debits sum to 560,941 µ$)
```
