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

Tests never call the live API; `test/tdm13-live-smoke.test.ts` runs only with `NAIVE_LIVE=1`.
See plan.md sections 5 and 11, and `docs/findings/naive-sdk-client.md`.
