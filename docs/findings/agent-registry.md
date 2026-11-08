# Agent registry, deploy sync and session persistence (TDM-55 [6.1])

## What exists

- `packages/agents/<role>/{prompt.md, config.json, output.schema.json}`: one folder per role. The
  config shape is the TDM-164 scout's. `tools` must carry `configs` (the SDK refuses
  `{default_config}` alone, found by TDM-164); the registry's zod schema requires it.
- `@anybench/agents`: `loadRole`, `listRoles`, `roleAgentSpec`, `planSync`, `syncAgents`,
  `syncMain`. CLI `pnpm --filter @anybench/agents sync [--dry-run] [--role r]... [--model m]`.
- `apps/server/src/jobs/agent-session.ts`: `runAgentStage(deps, args)`, `agentSessionIdFor`,
  `ensureAgentCached`, `AGENT_SESSION_STATUS`, `AGENT_MESSAGE_MAX_CHARS`.

## Decisions

- **agent_sessions.id** is a name-based UUID (RFC 9562 version 8, from sha256 of
  `anybench:agent_session:<ctx.idempotencyKey>\0<role>`). It is also the Naïve `Idempotency-Key`,
  so a rerun of the same stage visit replays the same Naïve session (plan.md section 5).
- **Statuses** use the API vocabulary (`AgentSessionSchema`): `pending → running → done | waiting |
  failed | cancelled`. `stop_reason` keeps Naïve's stop reason, or `budget_exceeded`,
  `output_invalid`, `output_missing`, `cancelled`.
- **Spend.** Our own agents are covered by the $2 run fee (plan.md section 8), so their Naïve spend
  is COGS: `cost_entries(source "naive", run_id, ref = Naïve session id)`, booked as the delta over
  what is already booked for that Naïve session, in the same transaction as the row update (a
  replay books nothing). `runs.spent_micro_usd` and `usage_entries` are not touched, and the
  `agent.message` events carry `cost_delta_micro_usd: 0` so the user's spent counter does not move.
  Nothing in apps/server writes `runs.spent_micro_usd` yet (grep, 2026-11-08).
- **Events.** Every Naïve event is stored in agent_events (payload through core `redactJson`,
  `on conflict do nothing` on `(agent_session_id, naive_seq)`), then `agent.message` is emitted for
  each non-user `message.completed` (redacted, cut at 2,000 chars, `truncated: true`), then
  `last_seq` moves. A crash between emit and `last_seq` re-emits that one message
  (at-least-once); it never drops one.
- **Our own persistence failing** inside `onEvent` is not a dropped stream: runSession would
  reconnect past the event and could even return a result. The helper remembers the first error,
  persists nothing after it, and rethrows it, so the job retries and resumes from `last_seq`.
- **Cancel.** `ctx.signal` is passed to runSession, which cancels the Naïve session on abort. That
  includes a lost lease or a worker shutdown, not only a user cancel (StageContext does not tell
  them apart). So a later visit that finds the row `cancelled` with a live signal starts a fresh
  Naïve session for the same row, keyed `<id>:after:<cancelled Naïve session id>` (deterministic,
  so that restart is idempotent too); the cancelled session's events are dropped, its spend stays
  booked.
- **Holds vs throws.** Output invalid/missing, budget exceeded (also the 402 pre-flight quote
  refusal at create), awaiting a human (row `waiting`, `pending_action` in the API's
  PendingActionSchema shape), a failed session, a missing role folder and a non-retryable Naïve
  refusal (credits, auth, validation) → `stageHold(reason)`. Retryable Naïve errors (429, 5xx,
  network) and our own errors throw.
- **429 "at capacity".** `syncAgents` and `ensureAgentCached` retry ensureAgent whole on a 429
  (TDM-39 `retryOnNaiveCapacity`; a refused call wrote nothing).

## Live check (2026-11-08)

Command (from `apps/server`, the local Docker Postgres overriding `.env`'s LOCAL_DATABASE_URL):

```
LOCAL_DATABASE_URL=postgres://anybench:anybench@localhost:55432/anybench NAIVE_LIVE=1 \
  node --env-file=<repo>/.env ../../node_modules/vitest/vitest.mjs \
  run test/agent-session-naive-live-tdm55.test.ts --reporter=verbose
```

First run (21:18 PT) and second run with capacity retry (21:19–21:22 PT): every call answered
`429 rate_limited "the service is at capacity"` after ~15 s, including `agents.list` and
`credits.show`:

```
NaiveError: the service is at capacity
Serialized Error: { code: 'rate_limited', status: 429, requestId: 'req_537nas5952ayq2z4nsn07q005r', ... }
credits.show err 15079 ms 429 rate_limited the service is at capacity
agents.findByName err 15035 ms 429 rate_limited the service is at capacity
```

So Naïve was refusing the whole organization at the time, not only computer creates (TDM-16 saw
the 429 on computer create only). Spend: 0 µ$ (nothing was created).

Gotcha: `.env` sets `LOCAL_DATABASE_URL` to a database the local Docker Postgres does not accept,
so live DB tests skip with "password authentication failed" unless it is overridden on the
command line (`node --env-file` never overrides a variable already in the environment).
