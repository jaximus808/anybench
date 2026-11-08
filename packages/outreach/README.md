# @anybench/outreach

Outreach (E15) building blocks, from the TDM-162 spike (`docs/findings/outreach-spike.md`).

- `createMonidClient({ apiKey, spendCapMicroUsd? })` / `createMonidClientFromEnv()`: `inspect`, `run` (maxCost is required, in micro-USD), `getRun`, `balance`, `spentMicroUsd`. Async (202) runs are polled. Errors are `MonidError` with a `code` (`MAX_COST_EXCEEDED`, `WALLET_INSUFFICIENT_FUNDS`, `BLOCKED`, `PROVIDER_ERROR`, `SPEND_CAP`, ...).
- `createAgentMail(monid)`: `createInbox`, `listInboxes`, `send`, `reply`, `listMessages`, `listThreads`, `getThread`, `getMessage`. Helpers: `listUnsubscribeHeaders`, `isInboundReply`, `bareAddress`.
- `FakeAgentMail` (`@anybench/outreach/fake`): the same interface in memory, with `simulateInboundReply` for reply-polling tests.
- Money: `usdToMicroUsd` (Monid float USD → bigint, prices rounded up, balances down), `microUsdToUsdWire` (bigint → `maxCost`).

Default tests never touch the network.

## Sourcing and opt-in import (TDM-163, 15.2a; `docs/findings/outreach-sourcing.md`)

- `createContextDevClient({ apiKey, creditCap })`: `webSearch` (1 credit per 10 results, refuses past the cap, at most 2 in flight), `usage`. `githubRepoRoot(url)` keeps repo roots only (no issues, topics, blobs or awesome lists).
- `createGithubSignals({ token?, requestBudget, cache, monid? })`: `repo`, `readme` (claim lines cited `blob/<branch>/<path>#L<n>`), `user` (never reads the profile email). Backs off on 403/429 using the reset headers, caches results (`createFileCache`), and falls back to Monid anyapi `/github.repository`. `extractReadmeClaims` matches prose only: a number plus a claim word near it.
- `findEmailViaHunter(monid, { domain, fullName })`: Hunter `/email-finder` via Monid, maxCost $0.0245.
- `runSourcing({ queryId, limit, contextDev, github, monid?, store })`: works through `SAVED_CLAIM_QUERIES`, applies the fit check, then does the Hunter lookup, dedupes (repo URL, company domain, email), checks suppression, and writes `leads` rows with `signals.provenance`.
- `importOptinCsv({ csv, file, store })`: `name,email,repo` rows, `source=hackathon_optin`.
- `PgLeadStore(pgClient)` / `MemoryLeadStore`: the `leads` + `suppressions` tables. `insert` returns `{id}` or `{duplicate: "email" | "repo"}`, enforced by the migration-0004 partial unique indexes (`on conflict do nothing`).
- Monid: a run with an unknown charge (poll timeout, transport error, 5xx with no run) is booked at maxCost and halts the client (`halted()`, later runs fail with `HALTED`).
