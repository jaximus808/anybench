# packages/naive

The only path from Anybench's own agents to a model. Wraps `@usenaive-sdk/managed-agents` behind a
narrow `NaiveClient` interface (bigint micro-USD, typed errors); `FakeNaive` implements the same
interface in memory for offline tests.

- `createNaiveClient({ apiKey, baseUrl?, fetch? })` / `createNaiveClientFromEnv()`: the live client.
- `ensureAgent(client, spec)`: create or update the agent for a role; unchanged spec is a no-op.
- `runSession(client, { agentId, role, input, output: { schema }, budgetMicroUsd, idempotencyKey, resume?, onEvent?, signal? })`:
  create (idempotent) → stream (afterSeq resume, dedupe, reconnect) → output gate. Throws
  `NaiveBudgetExceededError`, `NaiveOutputInvalidError`, `NaiveSessionFailedError`, `NaiveCancelledError`.
- `showCredits`, `spentMicroUsd`, `assertSubscriptionActive`, `creditCheck`.
- `FakeNaive` (also `@anybench/naive/fake`): `script(role, ...)`, `scriptDefault`, `failNext`,
  `setSubscription`, `setBalance`, `spentMicroUsd()`, `eventsOf(id)`, `sessionCreates`, `release(id)`.

- Per-trial model tokens through the Naïve proxy (`proxy-credentials.ts`, TDM-16; see
  `docs/findings/claude-code-naive-proxy.md`):
  - `provisionClaudeCodeProxyEnv({ keys: liveProxyKeys(admin), computers }, { trialId, computerId, model, smallFastModel? })`
    mints an `anybench-trial-<trialId>` key holding only `proxy:write` and writes
    `$HOME/.anybench/proxy.env` (0600) for Claude Code. The secret is non-enumerable; read it with
    `trialProxySecret(cred)` for the redactor.
  - On every heartbeat: `enforceTrialProxyBudget({ keys, spend: liveLedgerSpend(admin) }, { keyId, capMicroUsd, since: cred.createdAt })`
    revokes the key once spend reaches the cap.
  - At trial end, on every path: `revokeTrialProxyCredential(keys, cred)`. In the `computer.reap`
    sweep: `revokeStaleTrialProxyKeys(keys, keepIdsOfLiveTrials)`.
  - Fakes: `FakeProxyKeys`, `FakeProxySpend`.

Tests never call the live API; `test/tdm13-live-smoke.test.ts` runs only with `NAIVE_LIVE=1`.
See plan.md sections 5 and 11, and `docs/findings/naive-sdk-client.md`.
