# @anybench/outreach

Outreach (E15) building blocks, from the TDM-162 spike (`docs/findings/outreach-spike.md`).

- `createMonidClient({ apiKey, spendCapMicroUsd? })` / `createMonidClientFromEnv()`: `inspect`, `run` (maxCost is required, in micro-USD), `getRun`, `balance`, `spentMicroUsd`. Async (202) runs are polled. Errors are `MonidError` with a `code` (`MAX_COST_EXCEEDED`, `WALLET_INSUFFICIENT_FUNDS`, `BLOCKED`, `PROVIDER_ERROR`, `SPEND_CAP`, ...).
- `createAgentMail(monid)`: `createInbox`, `listInboxes`, `send`, `reply`, `listMessages`, `listThreads`, `getThread`, `getMessage`. Helpers: `listUnsubscribeHeaders`, `isInboundReply`, `bareAddress`.
- `FakeAgentMail` (`@anybench/outreach/fake`): the same interface in memory, with `simulateInboundReply` for reply-polling tests.
- Money: `usdToMicroUsd` (Monid float USD → bigint, prices rounded up, balances down), `microUsdToUsdWire` (bigint → `maxCost`).

Default tests never touch the network.
