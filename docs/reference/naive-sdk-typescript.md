<!-- Source: https://usenaive.ai/docs/sdk/typescript (fetched 2026-11-07) -->

> ## Documentation Index
> 
> Fetch the complete documentation index at: [/docs/llms.txt](https://usenaive.ai/docs/llms.txt)
> 
> Use this file to discover all available pages before exploring further.

[Skip to main content](https://usenaive.ai/docs/sdk/typescript#content-area)

[Naive home page](https://usenaive.ai)

Search...

Ctrl K

### TypeScript

- [TypeScript SDK](https://usenaive.ai/docs/sdk/typescript)
- [Errors](https://usenaive.ai/docs/sdk/errors)
- [Pagination](https://usenaive.ai/docs/sdk/pagination)
- [Streaming](https://usenaive.ai/docs/sdk/streaming)

### Control plane

- [agents](https://usenaive.ai/docs/sdk/agents)
- [harnesses](https://usenaive.ai/docs/sdk/harnesses)
- [media](https://usenaive.ai/docs/sdk/media)
- [characters](https://usenaive.ai/docs/sdk/characters)
- [Data](https://usenaive.ai/docs/sdk/data)
- [Social data](https://usenaive.ai/docs/sdk/social-data)
- [models](https://usenaive.ai/docs/sdk/models)
- [sessions](https://usenaive.ai/docs/sdk/sessions)
- [board](https://usenaive.ai/docs/sdk/board)
- [proxy](https://usenaive.ai/docs/sdk/proxy)

### Resources

- [computers](https://usenaive.ai/docs/sdk/computers)
- [browser](https://usenaive.ai/docs/sdk/browser)
- [browserSessions](https://usenaive.ai/docs/sdk/browser-sessions)
- [mobileDevices](https://usenaive.ai/docs/sdk/mobile-devices)
- [skills](https://usenaive.ai/docs/sdk/skills)
- [outcomes](https://usenaive.ai/docs/sdk/outcomes)
- [crm](https://usenaive.ai/docs/sdk/crm)
- [files](https://usenaive.ai/docs/sdk/files)
- [apps](https://usenaive.ai/docs/sdk/apps)
- [storage](https://usenaive.ai/docs/sdk/storage)
- [database](https://usenaive.ai/docs/sdk/database)

### Identity & access

- [identities](https://usenaive.ai/docs/sdk/identities)
- [connections](https://usenaive.ai/docs/sdk/connections)
- [ads](https://usenaive.ai/docs/sdk/ads)
- [vaults](https://usenaive.ai/docs/sdk/vaults)
- [domains](https://usenaive.ai/docs/sdk/domains)
- [emails](https://usenaive.ai/docs/sdk/emails)
- [phones](https://usenaive.ai/docs/sdk/phones)
- [Social](https://usenaive.ai/docs/sdk/social)
- [Legal](https://usenaive.ai/docs/sdk/legal)
- [Wallet](https://usenaive.ai/docs/sdk/wallet)
- [Cards](https://usenaive.ai/docs/sdk/cards)
- [trading](https://usenaive.ai/docs/sdk/trading)

### Automation

- [deployments](https://usenaive.ai/docs/sdk/deployments)
- [webhooks](https://usenaive.ai/docs/sdk/webhooks)

### Account

- [auth](https://usenaive.ai/docs/sdk/auth)
- [orgs](https://usenaive.ai/docs/sdk/orgs)
- [miniApps](https://usenaive.ai/docs/sdk/mini-apps)
- [digest](https://usenaive.ai/docs/sdk/digest)
- [keys](https://usenaive.ai/docs/sdk/keys)
- [MCP sessions](https://usenaive.ai/docs/sdk/mcp-sessions)
- [credits](https://usenaive.ai/docs/sdk/credits)
- [auditLogs](https://usenaive.ai/docs/sdk/audit-logs)

- [Book a demo](https://cal.com/seandorjeceo/15min)
- [Start](https://app.usenaive.ai)

[Overview](https://usenaive.ai/docs) [Managed Agents](https://usenaive.ai/docs/concepts/agents) [API Reference](https://usenaive.ai/docs/api/overview) [SDK Reference](https://usenaive.ai/docs/sdk/typescript) [CLI Reference](https://usenaive.ai/docs/cli/overview)

[Naive home page](https://usenaive.ai)

Search...

Ctrl K

- [Book a demo](https://cal.com/seandorjeceo/15min)
- [Start](https://app.usenaive.ai)
- [Start](https://app.usenaive.ai)

Search...

Navigation

TypeScript

TypeScript SDK

[Overview](https://usenaive.ai/docs) [Managed Agents](https://usenaive.ai/docs/concepts/agents) [API Reference](https://usenaive.ai/docs/api/overview) [SDK Reference](https://usenaive.ai/docs/sdk/typescript) [CLI Reference](https://usenaive.ai/docs/cli/overview)

TypeScript

# TypeScript SDK

@usenaive-sdk/managed-agents — the published typed client for the Naive Managed Agents API, documented method by method from the source.

**This page is the map; the per-namespace pages are the territory.** The [method index](https://usenaive.ai/docs/sdk/typescript#method-index) below is generated from the client source and checked against the constructed client, so it cannot name a method the package does not export — and every namespace links to a page documenting each method’s signature, route, and semantics. TypeScript only; there is no Python package.

```
npm i @usenaive-sdk/managed-agents
```

Moving from `@usenaive-sdk/vetta`? Install `@usenaive-sdk/managed-agents` and change the package name in your imports. The exports are the same.

Its only runtime dependency is `zod`. Everything documented below is the package’s current surface. The package is **ESM-only** (no `require`). The examples use top-level `await`, which needs an ES module: set `"type": "module"` in `package.json`, or name the file `.mts` / `.mjs`. In a CommonJS project, load it with a dynamic import inside an async function:

```
async function main() {
  const { createClient } = await import("@usenaive-sdk/managed-agents");
  const client = createClient({ baseUrl: "https://api.vetta.sh", apiKey: process.env.NAIVE_API_KEY! });
}
main();
```

If `tsc` compiles your project, set `"module"` and `"moduleResolution"` to `"node16"` or `"nodenext"` in `tsconfig.json`. With `"module": "commonjs"`, tsc rewrites `import()` to `require()`, which fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Running the file with `tsx` keeps the `import()` as written. The CLI and the dashboard use this same client. It sends the bearer key, the `Vetta-Version` pin and an `Idempotency-Key` on every mutating verb, and reads the error envelope, the same way for every call.

## What it is not

It is deliberately thinner than a product SDK:

- **No retry policy.** A caller that wants retries owns that decision, because the CLI and the dashboard want different ones.
- **No pagination magic.** `list` returns one page and the cursor. No auto-paging iterator.
- **No client-side taxonomy.** `ApiError.type` and `ApiError.status` are read off the response. The server owns the code → (type, status) table; a second copy here would be a second taxonomy that could drift.
- **No wire shapes of its own.** Responses parse with the zod schemas from the core package. Where a body is not yet modelled there — shell exec, billing, the per-op `fs` replies — the client says so explicitly with a local schema or `RawSchema`, rather than inventing a type.

## Constructing a client

Only the origin and the key are required. `fetch` defaults to the global one and `idempotencyKey` to a random UUID per write; the test suite injects a recording `fetch`, and the CLI injects its own.

```
import { createClient } from "@usenaive-sdk/managed-agents";

const client = createClient({ baseUrl: "https://api.vetta.sh", apiKey: process.env.NAIVE_API_KEY! });
```

[​](https://usenaive.ai/docs/sdk/typescript#param-base-url)

baseUrl

string

required

Control-plane origin. Trailing slashes are trimmed.

[​](https://usenaive.ai/docs/sdk/typescript#param-api-key)

apiKey

string

required

Sent as `Authorization: Bearer …`. One client per credential — `naive login` has none until the sign-in reply comes back.

[​](https://usenaive.ai/docs/sdk/typescript#param-fetch)

fetch

typeof fetch

Defaults to the global `fetch`. Injected so tests can record and the CLI can wrap it (it names the host in connection errors).

[​](https://usenaive.ai/docs/sdk/typescript#param-idempotency-key)

idempotencyKey

() => string

Called once per mutating verb. Defaults to `crypto.randomUUID()` (in a browser, only on HTTPS or localhost). Injected so a test gets a deterministic key.

## Coverage

The client has 41 namespaces. The [method index](https://usenaive.ai/docs/sdk/typescript#method-index) below lists every method and the route it calls; each namespace has its own page:

| Namespace | Covers |
| --- | --- |
| [`agents`](https://usenaive.ai/docs/sdk/agents) [`harnesses`](https://usenaive.ai/docs/sdk/harnesses) [`models`](https://usenaive.ai/docs/sdk/models) [`sessions`](https://usenaive.ai/docs/sdk/sessions) [`board`](https://usenaive.ai/docs/sdk/board) [`proxy`](https://usenaive.ai/docs/sdk/proxy) | The control plane — agents, versions, harnesses, runs, budgets, cancellation, task boards |
| [`media`](https://usenaive.ai/docs/sdk/media) [`characters`](https://usenaive.ai/docs/sdk/characters) [`data`](https://usenaive.ai/docs/sdk/data) [`socialData`](https://usenaive.ai/docs/sdk/social-data) | Media generation, trained characters, and the data catalogue |
| [`computers`](https://usenaive.ai/docs/sdk/computers) [`browser`](https://usenaive.ai/docs/sdk/browser) [`browserSessions`](https://usenaive.ai/docs/sdk/browser-sessions) [`mobileDevices`](https://usenaive.ai/docs/sdk/mobile-devices) | Computers, managed browsers, cloud phones |
| [`skills`](https://usenaive.ai/docs/sdk/skills) [`outcomes`](https://usenaive.ai/docs/sdk/outcomes) [`crm`](https://usenaive.ai/docs/sdk/crm) [`files`](https://usenaive.ai/docs/sdk/files) | Skills, graded outcomes, CRM records, files |
| [`apps`](https://usenaive.ai/docs/sdk/apps) [`storage`](https://usenaive.ai/docs/sdk/storage) [`database`](https://usenaive.ai/docs/sdk/database) | Apps and their storage and database |
| [`identities`](https://usenaive.ai/docs/sdk/identities) [`connections`](https://usenaive.ai/docs/sdk/connections) [`vaults`](https://usenaive.ai/docs/sdk/vaults) | Personas ([legal](https://usenaive.ai/docs/sdk/legal), [wallet](https://usenaive.ai/docs/sdk/wallet), [cards](https://usenaive.ai/docs/sdk/cards)), external tool auth, credentials |
| [`domains`](https://usenaive.ai/docs/sdk/domains) [`emails`](https://usenaive.ai/docs/sdk/emails) [`phones`](https://usenaive.ai/docs/sdk/phones) [`social`](https://usenaive.ai/docs/sdk/social) [`ads`](https://usenaive.ai/docs/sdk/ads) [`trading`](https://usenaive.ai/docs/sdk/trading) | The identity’s reachable surface: mail, phone, social accounts, ads, brokerage |
| [`deployments`](https://usenaive.ai/docs/sdk/deployments) [`webhooks`](https://usenaive.ai/docs/sdk/webhooks) | Schedules and delivery |
| [`auth`](https://usenaive.ai/docs/sdk/auth) [`orgs`](https://usenaive.ai/docs/sdk/orgs) [`miniApps`](https://usenaive.ai/docs/sdk/mini-apps) [`digest`](https://usenaive.ai/docs/sdk/digest) [`keys`](https://usenaive.ai/docs/sdk/keys) [`mcpSessions`](https://usenaive.ai/docs/sdk/mcp-sessions) [`credits`](https://usenaive.ai/docs/sdk/credits) [`auditLogs`](https://usenaive.ai/docs/sdk/audit-logs) | Account, members, mini apps, digests, scoped and short-lived credentials, prepaid balance, audit trail |
| [`stream`](https://usenaive.ai/docs/sdk/streaming) | The resumable SSE consumer |

Cross-cutting behavior has its own pages too: [Errors](https://usenaive.ai/docs/sdk/errors), [Pagination](https://usenaive.ai/docs/sdk/pagination), and [Streaming](https://usenaive.ai/docs/sdk/streaming). Two methods are parameterized over a family rather than split per route, because splitting them would produce five near-identical methods with no added type safety:

- `computers.fs(id, op, body)` reaches all five `/v1/computers/{id}/fs/*` routes. The reply differs per op (`{content}`, `{entries}`, `{created}`…), so it comes back as `RawSchema`.
- `stream(sessionId, options)` is the one consumer of `GET /v1/sessions/{id}/stream`.

Not every API route has a method. Inbound provider callbacks, operator-only routes, the OpenAPI document and the MCP endpoint are reached over HTTP only, as are some other routes; the [API reference](https://usenaive.ai/docs/api/overview) documents the whole surface.

## Invariants worth knowing before your first call

### Money is integer micro-USD, always

Every monetary field on every signature is `z.number().int()`. The client never exposes a float and never converts to dollars — formatting is a presentation decision, and doing it here once cost a 10⁶ error in an earlier audit. `credits.topup` takes `amountMicroUsd`; `sessions.setBudget` takes `capMicroUsd`.

### The vault has no read method, by contract

`vaults` exposes `create`, `list`, `get`, `delete` and `credentials.{create,list,delete}` — and no reveal. The control plane serves no reveal route and `VaultCredentialSchema` has no `value` field, so `list` could not return one even if a handler tried. Rotation is create-new + delete-old rather than an `update`, so `last_injected_at` stays attributable to exactly one secret.

### The two skill pushes are not interchangeable

`skills.push({ slug, content })` hits `POST /v1/skills` and is create-or-version _by slug_: unknown slug creates the skill. `skills.pushVersion(ref, { content })` hits `POST /v1/skills/{id}/versions` and requires the skill to exist — an unknown ref is a 404, not a create. A release pipeline pinned to a skill id wants the second one, so a rename cannot silently mint a second skill. Both accept an optional `sha256`. It is an _integrity claim the server checks against its own digest_, never the digest of record. A mismatch is rejected.

## Worked examples

Every block below was run against staging on 2026-08-22. Replies are shown as returned, except the two marked as abridged.

### Reading the balance

```
const balance = await client.credits.show();
```

```
{ "object": "credit_balance", "balance_micro_usd": 79416537, "mode": "test" }
```

`79416537` micro-USD is $79.416537. The client hands you the integer; you format it.

### Pushing a skill, then a second version of it

```
const v1 = await client.skills.push({
  slug: "parity-demo-5e66aacb",
  content: "# Demo\nfirst.\n",
  description: "parity demo",
});
const v2 = await client.skills.pushVersion(v1.id, { content: "# Demo\nsecond.\n" });
```

```
{"version":1,"sha256":"5f22eb6cabbfe6b898548754a4da28d7e6d4e54d53a80780088d28662fe4869f","size_bytes":14,"created_at":"2026-08-23T00:44:28.415Z","id":"skl_e4dpzg0b1yxzhngqfzdanqxqa1","slug":"parity-demo-5e66aacb"}
{"version":2,"sha256":"84876f29ae4f70fe355c10186c5986e0db2d6c4b5fcd60a47b5bfe023b04b03e","size_bytes":15,"created_at":"2026-08-23T00:44:30.056Z","id":"skl_e4dpzg0b1yxzhngqfzdanqxqa1","slug":"parity-demo-5e66aacb"}
```

Note `id` and `slug` on the reply. They are what makes the chain above work: `pushVersion` takes the `id` the first push returned.

### Why `pushVersion` is not just `push`

```
await client.skills.pushVersion("skl_does_not_exist", { content: "x" });
```

```
ApiError status=404 code=not_found type=not_found message=no such skill: skl_does_not_exist
```

`push` with an unknown slug would have created a skill. That is the entire difference.

### The integrity claim is checked, not trusted

```
await client.skills.pushVersion(slug, { content: "# Demo\nthird.\n", sha256: "0".repeat(64) });
```

```
ApiError status=400 code=validation_failed param=sha256 message=sha256 does not match the content
```

`ApiError.param` names the offending field, which is what the CLI prints.

### Listing versions

```
const versions = await client.skills.listVersions(slug);
```

```
{ "data": [{ "version": 2, "sha256": "84876f29ae4f…" }, { "version": 1, "sha256": "5f22eb6cabbf…" }], "has_more": false, "next_cursor": null }
```

Abridged: the digests are full 64-character hexes. Newest first. The cursor is the version number, not an id — versions have none of their own.

### The page envelope

```
const agents = await client.agents.list({ limit: 2 });
```

```
{ "data": [ { "id": "agt_…", "name": "e2e-toolfail-1787443045296" }, { "id": "agt_…" } ], "has_more": true, "next_cursor": "agt_…" }
```

Abridged: the two agent objects are full agents. `{ data, has_more, next_cursor }` on every list. There is no auto-paging helper; pass `after: next_cursor`.

### Deleting

```
await client.skills.delete(slug);
```

```
{ "id": "skl_e4dpzg0b1yxzhngqfzdanqxqa1", "object": "skill", "deleted": true }
```

Every delete answers the same `{ id, object, deleted }` acknowledgement.

## Handling errors

Every non-2xx throws `ApiError`. There is one shape:

```
import { ApiError } from "@usenaive-sdk/managed-agents";

try {
  await client.skills.get("skl_nope");
} catch (error) {
  if (error instanceof ApiError) {
    // error.status  404
    // error.type    "not_found"
    // error.code    "not_found"
    // error.param   the offending field, when the server names one
    // error.requestId  quote this in a bug report
  }
}
```

`requestId` is the single most useful field in a report — it is the server’s own correlation id for that call.

## Streaming

`stream` is a resumable async generator over session events. `afterSeq` is **exclusive**, so resuming from the last seq you saw does not replay it:

```
let last = 0;
for await (const event of client.stream(sessionId, { afterSeq: last })) {
  last = event.seq;
}
```

The dashboard does not call this directly. It re-serves the SSE body same-origin using the `send` escape hatch, so the control-plane key never reaches a browser.

## The same operation in the other two interfaces

Most methods have a counterpart in the [CLI](https://usenaive.ai/docs/cli/overview) and a page in the [API reference](https://usenaive.ai/docs/api/overview), named the same way:

| SDK | CLI | API |
| --- | --- | --- |
| `client.agents.create` | [`naive agent create`](https://usenaive.ai/docs/cli/agents) | [Agents](https://usenaive.ai/docs/api/agents) |
| `client.sessions.create` · `client.stream` | [`naive session create`](https://usenaive.ai/docs/cli/sessions) · [`naive run`](https://usenaive.ai/docs/cli/sessions) | [Sessions](https://usenaive.ai/docs/api/sessions) · [Events](https://usenaive.ai/docs/api/events) |
| `client.computers.*` | [`naive computer`](https://usenaive.ai/docs/cli/computer) | [Computers](https://usenaive.ai/docs/api/computers) |
| `client.mobileDevices.*` | [`naive mobile`](https://usenaive.ai/docs/cli/mobile) | [Mobile devices](https://usenaive.ai/docs/api/mobile-devices) |
| `client.data.*` · `client.socialData.*` | [`naive data`](https://usenaive.ai/docs/cli/data) · [`naive social-data`](https://usenaive.ai/docs/cli/social-data) | [Data](https://usenaive.ai/docs/api/data) · [Social data](https://usenaive.ai/docs/api/social-data) |
| `client.skills.push` · `client.skills.pushVersion` | [`naive skill push`](https://usenaive.ai/docs/cli/skills) · [`naive skill push-version`](https://usenaive.ai/docs/cli/skills) | [Skills](https://usenaive.ai/docs/api/skills) |
| `client.files.*` | [`naive file`](https://usenaive.ai/docs/cli/files) | [Files](https://usenaive.ai/docs/api/files) |
| `client.deployments.*` · `client.webhooks.*` | [`naive deploy`](https://usenaive.ai/docs/cli/deployments) · [`naive webhook`](https://usenaive.ai/docs/cli/webhook) | [Deployments](https://usenaive.ai/docs/api/deployments) · [Webhooks](https://usenaive.ai/docs/api/webhooks) |
| `client.orgs.*` · `client.keys.*` · `client.credits.*` · `client.auditLogs.*` | [`naive org`](https://usenaive.ai/docs/cli/org) · [`naive keys`](https://usenaive.ai/docs/cli/keys) · [`naive credits`](https://usenaive.ai/docs/cli/billing) · [`naive audit`](https://usenaive.ai/docs/cli/audit) | [Organizations](https://usenaive.ai/docs/api/organizations) · [Credits](https://usenaive.ai/docs/api/credits) · [Audit logs](https://usenaive.ai/docs/api/audit-logs) |
| `client.auth.*` | [`naive auth`](https://usenaive.ai/docs/cli/auth) | [Authentication](https://usenaive.ai/docs/api/authentication) |
| `client.identities.*` · `client.connections.*` · `client.vaults.*` | [`naive identity`](https://usenaive.ai/docs/cli/identity) · [`naive vault`](https://usenaive.ai/docs/cli/vault) | [Identities](https://usenaive.ai/docs/api/identities) · [Connections](https://usenaive.ai/docs/api/connections) · [Vaults](https://usenaive.ai/docs/api/vaults) |
| `client.domains.*` · `client.emails.*` · `client.phones.*` | [`naive identity domain`](https://usenaive.ai/docs/cli/comms) · [`naive identity email`](https://usenaive.ai/docs/cli/comms) · [`naive identity phone`](https://usenaive.ai/docs/cli/phone) | [Domains](https://usenaive.ai/docs/api/domains) · [Messaging](https://usenaive.ai/docs/api/messaging) |

## Method index

Every method on the client, and the route it calls — 385 methods across 41 namespaces. Generated from the client source by `scripts/sdk-index.mjs`; the drift gate fails if it falls behind.

### `ads`

| Method | Route |
| --- | --- |
| `ads.activate` | `POST /v1/ads/campaigns/{id}/activate` |
| `ads.createSearchCampaign` | `POST /v1/ads/search_campaigns` |
| `ads.insights` | `GET /v1/ads/campaigns/{id}/insights` |
| `ads.listCampaigns` | `GET /v1/ads/campaigns` |
| `ads.pause` | `POST /v1/ads/campaigns/{id}/pause` |

### `agents`

| Method | Route |
| --- | --- |
| `agents.computer` | `GET /v1/agents/{id}/computer` |
| `agents.create` | `POST /v1/agents` |
| `agents.delete` | `DELETE /v1/agents/{id}` |
| `agents.get` | `GET /v1/agents/{id}` |
| `agents.getVersion` | `GET /v1/agents/{id}/versions/{id}` |
| `agents.list` | `GET /v1/agents` |
| `agents.listVersions` | `GET /v1/agents/{id}/versions` |
| `agents.rollback` | `POST /v1/agents/{id}/rollback` |
| `agents.spend` | `GET /v1/agents/{id}/spend` |
| `agents.update` | `PATCH /v1/agents/{id}` |

### `apps`

| Method | Route |
| --- | --- |
| `apps.access` | `GET /v1/apps/{id}/access` |
| `apps.artifacts.list` | `GET /v1/blueprints/artifacts` |
| `apps.companyTemplates.create` | `POST /v1/company_templates` |
| `apps.companyTemplates.draft` | `POST /v1/company_templates/draft` |
| `apps.companyTemplates.list` | `GET /v1/company_templates` |
| `apps.connectDomain` | `POST /v1/apps/{id}/domains` |
| `apps.create` | `POST /v1/apps` |
| `apps.delete` | `DELETE /v1/apps/{id}` |
| `apps.deleteSecret` | `DELETE /v1/apps/{id}/secrets/{id}` |
| `apps.deploy` | `POST /v1/apps/{id}/deployments` |
| `apps.deploymentFiles` | `GET /v1/apps/{id}/deployments/{id}/files` |
| `apps.deployments` | `GET /v1/apps/{id}/deployments` |
| `apps.disconnectDomain` | `DELETE /v1/apps/{id}/domains/{id}` |
| `apps.domains` | `GET /v1/apps/{id}/domains` |
| `apps.earnings.setUpPayouts` | `POST /v1/earnings/payouts/account` |
| `apps.entry` | `POST /v1/apps/{id}/entry` |
| `apps.get` | `GET /v1/apps/{id}` |
| `apps.installs.apply` | `POST /v1/blueprints/installs` |
| `apps.installs.context` | `GET /v1/blueprints/installs/{id}/context` |
| `apps.installs.list` | `GET /v1/blueprints/installs` |
| `apps.installs.preview` | `GET /v1/blueprints/preview` |
| `apps.installs.remove` | `DELETE /v1/blueprints/installs/{id}` |
| `apps.installs.update` | `PATCH /v1/blueprints/installs/{id}` |
| `apps.list` | `GET /v1/apps` |
| `apps.listings.checks` | `GET /v1/listings/checks` |
| `apps.listings.list` | `GET /v1/listings` |
| `apps.permissions` | `GET /v1/apps/{id}/permissions` |
| `apps.profile.get` | `GET /v1/listings/profile` |
| `apps.profile.update` | `PATCH /v1/listings/profile` |
| `apps.query` | `POST /v1/apps/{id}/db/query` |
| `apps.redeploy` | `POST /v1/apps/{id}/deployments` |
| `apps.rotateAccess` | `POST /v1/apps/{id}/access` |
| `apps.secrets` | `GET /v1/apps/{id}/secrets` |
| `apps.setSecret` | `POST /v1/apps/{id}/secrets` |
| `apps.update` | `PATCH /v1/apps/{id}` |

### `auditLogs`

| Method | Route |
| --- | --- |
| `auditLogs.list` | `GET /v1/audit_logs` |

### `auth`

| Method | Route |
| --- | --- |
| `auth.joinTournament` | `POST /v1/tournament/entries` |
| `auth.me` | `GET /v1/me` |
| `auth.recover` | `POST /v1/auth/recover` |
| `auth.register` | `POST /v1/auth/users` |
| `auth.resendConfirmation` | `POST /v1/auth/confirmations` |
| `auth.resetPassword` | `POST /v1/auth/password` |
| `auth.session` | `POST /v1/auth/session` |
| `auth.tournamentEntry` | `GET /v1/tournament/entry` |

### `board`

| Method | Route |
| --- | --- |
| `board.cards.assign` | `PATCH /v1/boards/{id}/cards/{id}` |
| `board.cards.comment` | `POST /v1/boards/{id}/cards/{id}/comments` |
| `board.cards.comments` | `GET /v1/boards/{id}/cards/{id}/comments` |
| `board.cards.create` | `POST /v1/boards/{id}/cards` |
| `board.cards.get` | `GET /v1/boards/{id}/cards/{id}` |
| `board.cards.list` | `GET /v1/boards/{id}/cards` |
| `board.cards.ofAgent` | `GET /v1/agents/{id}/board` |
| `board.cards.update` | `PATCH /v1/boards/{id}/cards/{id}` |
| `board.create` | `POST /v1/boards` |
| `board.get` | `GET /v1/boards/{id}` |

### `browser`

| Method | Route |
| --- | --- |
| `browser.contexts.grant` | `POST /v1/browser/contexts/{id}/grants` |
| `browser.contexts.revoke` | `DELETE /v1/browser/contexts/{id}` |
| `browser.credentials.save` | `POST /v1/browser/credentials` |

### `browserSessions`

| Method | Route |
| --- | --- |
| `browserSessions.list` | `GET /v1/computers/{id}/browser_sessions` |
| `browserSessions.liveView` | `POST /v1/computers/{id}/browser_sessions/{id}/live_view` |

### `characters`

| Method | Route |
| --- | --- |
| `characters.create` | `POST /v1/characters` |
| `characters.delete` | `DELETE /v1/characters/{id}` |
| `characters.get` | `GET /v1/characters/{id}` |
| `characters.list` | `GET /v1/characters` |
| `characters.update` | `PATCH /v1/characters/{id}` |

### `computers`

| Method | Route |
| --- | --- |
| `computers.browser.act` | `POST /v1/computers/{id}/browser/actions` |
| `computers.browser.click` | `POST /v1/computers/{id}/browser/actions` |
| `computers.browser.close` | `DELETE /v1/computers/{id}/browser` |
| `computers.browser.extract` | `POST /v1/computers/{id}/browser/actions` |
| `computers.browser.goto` | `POST /v1/computers/{id}/browser/actions` |
| `computers.browser.links` | `POST /v1/computers/{id}/browser/actions` |
| `computers.browser.login` | `POST /v1/computers/{id}/browser/login` |
| `computers.browser.observe` | `POST /v1/computers/{id}/browser/actions` |
| `computers.browser.saveContext` | `POST /v1/computers/{id}/browser/context` |
| `computers.browser.screenshot` | `POST /v1/computers/{id}/browser/actions` |
| `computers.browser.signup` | `POST /v1/computers/{id}/browser/signup` |
| `computers.browser.status` | `GET /v1/computers/{id}/browser` |
| `computers.browser.type` | `POST /v1/computers/{id}/browser/actions` |
| `computers.build3d` | `POST /v1/computers/{id}/build-3d` |
| `computers.commands` | `GET /v1/computers/{id}/commands` |
| `computers.create` | `POST /v1/computers` |
| `computers.delete` | `DELETE /v1/computers/{id}` |
| `computers.deleteSnapshot` | `DELETE /v1/snapshots/{id}` |
| `computers.exec` | `POST /v1/computers/{id}/exec` |
| `computers.execStream` | `POST /v1/computers/{id}/exec/stream` |
| `computers.fs` | `POST /v1/computers/{id}/fs/{id}` |
| `computers.get` | `GET /v1/computers/{id}` |
| `computers.handBack` | `DELETE /v1/computers/{id}/takeover` |
| `computers.inspect` | `GET /v1/computers/{id}/inspect` |
| `computers.list` | `GET /v1/computers` |
| `computers.listDir` | `POST /v1/computers/{id}/fs/list` |
| `computers.listSnapshots` | `GET /v1/snapshots` |
| `computers.pause` | `POST /v1/computers/{id}/pause` |
| `computers.resume` | `POST /v1/computers/{id}/resume` |
| `computers.snapshot` | `POST /v1/computers/{id}/snapshot` |
| `computers.takeOver` | `POST /v1/computers/{id}/takeover` |
| `computers.update` | `PATCH /v1/computers/{id}` |

### `connections`

| Method | Route |
| --- | --- |
| `connections.appLogo` | `GET /v1/connections/apps/{id}/logo` |
| `connections.connect` | `POST /v1/connections` |
| `connections.createAuthConfig` | `POST /v1/connections/auth_configs` |
| `connections.deleteAuthConfig` | `DELETE /v1/connections/auth_configs/{id}` |
| `connections.disconnect` | `DELETE /v1/connections/{id}` |
| `connections.get` | `GET /v1/connections/{id}` |
| `connections.getApp` | `GET /v1/connections/apps/{id}` |
| `connections.list` | `GET /v1/connections` |
| `connections.listApps` | `GET /v1/connections/apps` |
| `connections.listAuthConfigs` | `GET /v1/connections/auth_configs` |

### `credits`

| Method | Route |
| --- | --- |
| `credits.billingPortal` | `POST /v1/credits/billing_portal` |
| `credits.cancelSubscription` | `DELETE /v1/credits/subscription` |
| `credits.changePlan` | `PATCH /v1/credits/subscription` |
| `credits.ledger` | `GET /v1/credits/ledger` |
| `credits.show` | `GET /v1/credits/balance` |
| `credits.spend` | `GET /v1/credits/spend` |
| `credits.subscribe` | `POST /v1/credits/subscription` |
| `credits.subscription` | `GET /v1/credits/subscription` |
| `credits.topup` | `POST /v1/credits/topups` |

### `crm`

| Method | Route |
| --- | --- |
| `crm.activity.create` | `POST /v1/crm/activity` |
| `crm.activity.delete` | `DELETE /v1/crm/activity/{id}` |
| `crm.activity.update` | `PATCH /v1/crm/activity/{id}` |
| `crm.calendar` | `GET /v1/crm/calendar` |
| `crm.contacts.create` | `POST /v1/crm/contacts` |
| `crm.contacts.delete` | `DELETE /v1/crm/contacts/{id}` |
| `crm.contacts.get` | `GET /v1/crm/contacts/{id}` |
| `crm.contacts.list` | `GET /v1/crm/contacts` |
| `crm.contacts.update` | `PATCH /v1/crm/contacts/{id}` |

### `data`

| Method | Route |
| --- | --- |
| `data.getTool` | `GET /v1/data/tools/{id}` |
| `data.run` | `POST /v1/data/runs` |
| `data.searchTools` | `GET /v1/data/tools` |

### `database`

| Method | Route |
| --- | --- |
| `database.from().delete` | `DELETE /v1/apps/{id}/db/rest/{id}` |
| `database.from().insert` | `POST /v1/apps/{id}/db/rest/{id}` |
| `database.from().select` | `GET /v1/apps/{id}/db/rest/{id}` |
| `database.from().update` | `PATCH /v1/apps/{id}/db/rest/{id}` |
| `database.from().upsert` | `POST /v1/apps/{id}/db/rest/{id}` |
| `database.migrate` | `POST /v1/apps/{id}/db/migrations` |
| `database.migrations` | `GET /v1/apps/{id}/db/migrations` |
| `database.query` | `POST /v1/apps/{id}/db/query` |
| `database.tables` | `GET /v1/apps/{id}/db/tables` |

### `deployments`

| Method | Route |
| --- | --- |
| `deployments.create` | `POST /v1/deployments` |
| `deployments.delete` | `DELETE /v1/deployments/{id}` |
| `deployments.get` | `GET /v1/deployments/{id}` |
| `deployments.list` | `GET /v1/deployments` |
| `deployments.pause` | `POST /v1/deployments/{id}/pause` |
| `deployments.resume` | `POST /v1/deployments/{id}/resume` |
| `deployments.run` | `POST /v1/deployments/{id}/run` |
| `deployments.runs` | `GET /v1/deployments/{id}/runs` |
| `deployments.update` | `PATCH /v1/deployments/{id}` |

### `digest`

| Method | Route |
| --- | --- |
| `digest.get` | `GET /v1/digest` |

### `domains`

| Method | Route |
| --- | --- |
| `domains.create` | `POST /v1/domains` |
| `domains.delete` | `DELETE /v1/domains/{id}` |
| `domains.get` | `GET /v1/domains/{id}` |
| `domains.list` | `GET /v1/domains` |
| `domains.purchase` | `POST /v1/domains/purchase` |
| `domains.quote` | `POST /v1/domains/quote` |
| `domains.records` | `GET /v1/domains/{id}/records` |
| `domains.verify` | `POST /v1/domains/{id}/verify` |

### `emails`

| Method | Route |
| --- | --- |
| `emails.create` | `POST /v1/identities/{id}/emails` |
| `emails.delete` | `DELETE /v1/identities/{id}/emails/{id}` |
| `emails.list` | `GET /v1/identities/{id}/emails` |
| `emails.markRead` | `POST /v1/identities/{id}/messages/{id}/read` |
| `emails.messages` | `GET /v1/identities/{id}/messages` |
| `emails.send` | `POST /v1/identities/{id}/emails/{id}/send` |
| `emails.sent` | `GET /v1/identities/{id}/sent` |
| `emails.update` | `PATCH /v1/identities/{id}/emails/{id}` |

### `files`

| Method | Route |
| --- | --- |
| `files.createUpload` | `POST /v1/files/uploads` |
| `files.delete` | `DELETE /v1/files/{id}` |
| `files.deleteMany` | `POST /v1/files/delete` |
| `files.download` | `GET /v1/files/{id}` |
| `files.downloadBytes` | `GET /v1/files/{id}` |
| `files.folders` | `GET /v1/files/folders` |
| `files.get` | `GET /v1/files/{id}` |
| `files.import` | `POST /v1/files/imports` |
| `files.list` | `GET /v1/files` |
| `files.move` | `POST /v1/files/move` |
| `files.publish` | `POST /v1/files/{id}/publish` |
| `files.update` | `PATCH /v1/files/{id}` |
| `files.upload` | `POST /v1/files` |
| `files.url` | `POST /v1/files/{id}/url` |

### `harnesses`

| Method | Route |
| --- | --- |
| `harnesses.list` | `GET /v1/harnesses` |
| `harnesses.retrieve` | `GET /v1/harnesses/{id}` |

### `identities`

| Method | Route |
| --- | --- |
| `identities.agents` | `GET /v1/identities/{id}/agents` |
| `identities.attach` | `POST /v1/agents/{id}/identities` |
| `identities.cards.cancel` | `POST /v1/identities/{id}/cards/{id}/cancel` |
| `identities.cards.get` | `GET /v1/identities/{id}/cards/{id}` |
| `identities.cards.issue` | `POST /v1/identities/{id}/cards` |
| `identities.cards.list` | `GET /v1/identities/{id}/cards` |
| `identities.cards.logTransaction` | `POST /v1/identities/{id}/cards/{id}/transactions` |
| `identities.cards.quote` | `POST /v1/identities/{id}/cards/quote` |
| `identities.cards.refund` | `POST /v1/identities/{id}/cards/{id}/refund` |
| `identities.cards.retry` | `POST /v1/identities/{id}/cards/{id}/retry` |
| `identities.cards.revealCredentials` | `GET /v1/identities/{id}/cards/{id}/credentials` |
| `identities.cards.transactions` | `GET /v1/identities/{id}/cards/{id}/transactions` |
| `identities.create` | `POST /v1/identities` |
| `identities.delete` | `DELETE /v1/identities/{id}` |
| `identities.deleteInbox` | `DELETE /v1/identities/{id}/emails/{id}` |
| `identities.detach` | `DELETE /v1/agents/{id}/identities/{id}` |
| `identities.get` | `GET /v1/identities/{id}` |
| `identities.held` | `GET /v1/agents/{id}/identities` |
| `identities.inboxes` | `GET /v1/identities/{id}/emails` |
| `identities.legal.companies` | `GET /v1/identities/{id}/legal/companies` |
| `identities.legal.company` | `GET /v1/identities/{id}/legal/companies/{id}` |
| `identities.legal.completeMember` | `POST /v1/identities/{id}/legal/verifications/{id}/members/{id}/complete` |
| `identities.legal.createCompany` | `POST /v1/identities/{id}/legal/companies` |
| `identities.legal.documentLink` | `GET /v1/identities/{id}/legal/companies/{id}/documents/{id}` |
| `identities.legal.documents` | `GET /v1/identities/{id}/legal/companies/{id}/documents` |
| `identities.legal.naicsCodes` | `GET /v1/legal/naics_codes` |
| `identities.legal.resendMemberLink` | `POST /v1/identities/{id}/legal/verifications/{id}/members/{id}/resend` |
| `identities.legal.startVerification` | `POST /v1/identities/{id}/legal/verifications` |
| `identities.legal.states` | `GET /v1/legal/states` |
| `identities.legal.submitCompany` | `POST /v1/identities/{id}/legal/companies/{id}/submit` |
| `identities.legal.verification` | `GET /v1/identities/{id}/legal/verifications/{id}` |
| `identities.legal.verifications` | `GET /v1/identities/{id}/legal/verifications` |
| `identities.list` | `GET /v1/identities` |
| `identities.messages` | `GET /v1/identities/{id}/messages` |
| `identities.phones` | `GET /v1/identities/{id}/phones` |
| `identities.releasePhone` | `DELETE /v1/identities/{id}/phones/{id}` |
| `identities.update` | `PATCH /v1/identities/{id}` |
| `identities.wallet.create` | `POST /v1/identities/{id}/wallet` |
| `identities.wallet.freeze` | `POST /v1/identities/{id}/wallet/freeze` |
| `identities.wallet.fund` | `POST /v1/identities/{id}/wallet/fund` |
| `identities.wallet.get` | `GET /v1/identities/{id}/wallet` |
| `identities.wallet.pay` | `POST /v1/identities/{id}/wallet/pay` |
| `identities.wallet.quote` | `POST /v1/identities/{id}/wallet/quote` |
| `identities.wallet.receipts` | `GET /v1/identities/{id}/wallet/transactions` |
| `identities.wallet.sweep` | `POST /v1/identities/{id}/wallet/sweep` |
| `identities.wallet.transactions` | `GET /v1/identities/{id}/wallet/transactions` |
| `identities.wallet.transfer` | `POST /v1/identities/{id}/wallet/transfer` |
| `identities.wallet.unfreeze` | `POST /v1/identities/{id}/wallet/unfreeze` |
| `identities.wallet.updatePolicy` | `PATCH /v1/identities/{id}/wallet/policy` |

### `keys`

| Method | Route |
| --- | --- |
| `keys.create` | `POST /v1/api_keys` |
| `keys.list` | `GET /v1/api_keys` |
| `keys.revoke` | `DELETE /v1/api_keys/{id}` |
| `keys.rotate` | `POST /v1/api_keys/{id}/rotate` |

### `mcpSessions`

| Method | Route |
| --- | --- |
| `mcpSessions.create` | `POST /v1/mcp_sessions` |
| `mcpSessions.get` | `GET /v1/mcp_sessions/{id}` |
| `mcpSessions.list` | `GET /v1/mcp_sessions` |
| `mcpSessions.revoke` | `DELETE /v1/mcp_sessions/{id}` |

### `media`

| Method | Route |
| --- | --- |
| `media.audio.converse` | `POST /v1/media/audio/conversations` |
| `media.audio.get` | `GET /v1/media/audio/transcriptions/{id}` |
| `media.audio.speak` | `POST /v1/media/audio/speech` |
| `media.audio.transcribe` | `POST /v1/media/audio/transcriptions` |
| `media.clips.create` | `POST /v1/media/clips` |
| `media.clips.get` | `GET /v1/media/clips/{id}` |
| `media.clips.list` | `GET /v1/media/clips` |
| `media.edits.create` | `POST /v1/media/edits` |
| `media.edits.get` | `GET /v1/media/edits/{id}` |
| `media.get` | `GET /v1/media/{id}` |
| `media.images.generate` | `POST /v1/media/images` |
| `media.list` | `GET /v1/media` |
| `media.listModels` | `GET /v1/media/models` |
| `media.meshes.create` | `POST /v1/media/meshes` |
| `media.music.generate` | `POST /v1/media/music` |
| `media.skills.create` | `POST /v1/media/skills` |
| `media.skills.get` | `GET /v1/media/skills/{id}` |
| `media.skills.list` | `GET /v1/media/skills` |
| `media.skills.revise` | `POST /v1/media/skills` |
| `media.soundEffects.generate` | `POST /v1/media/sound-effects` |
| `media.stock.search` | `GET /v1/media/stock` |
| `media.videos.generate` | `POST /v1/media/videos` |

### `miniApps`

| Method | Route |
| --- | --- |
| `miniApps.get` | `GET /v1/mini-apps/{id}` |
| `miniApps.list` | `GET /v1/mini-apps` |

### `mobileDevices`

| Method | Route |
| --- | --- |
| `mobileDevices.act` | `POST /v1/mobile_devices/{id}/act` |
| `mobileDevices.create` | `POST /v1/mobile_devices` |
| `mobileDevices.delete` | `DELETE /v1/mobile_devices/{id}` |
| `mobileDevices.get` | `GET /v1/mobile_devices/{id}` |
| `mobileDevices.list` | `GET /v1/mobile_devices` |
| `mobileDevices.liveView` | `POST /v1/mobile_devices/{id}/live_view` |
| `mobileDevices.update` | `PATCH /v1/mobile_devices/{id}` |

### `models`

| Method | Route |
| --- | --- |
| `models.autoSelect` | `POST /v1/models/auto_select` |
| `models.list` | `GET /v1/models` |
| `models.retrieve` | `GET /v1/models/{id}` |

### `orgs`

| Method | Route |
| --- | --- |
| `orgs.addMember` | `POST /v1/organizations/{id}/members` |
| `orgs.create` | `POST /v1/organizations` |
| `orgs.get` | `GET /v1/organizations/{id}` |
| `orgs.list` | `GET /v1/organizations` |
| `orgs.members` | `GET /v1/organizations/{id}/members` |
| `orgs.removeMember` | `DELETE /v1/organizations/{id}/members/{id}` |
| `orgs.setRole` | `PATCH /v1/organizations/{id}/members/{id}` |
| `orgs.setup` | `POST /v1/organizations/setup` |
| `orgs.update` | `PATCH /v1/organizations/{id}` |

### `outcomes`

| Method | Route |
| --- | --- |
| `outcomes.create` | `POST /v1/outcomes` |
| `outcomes.get` | `GET /v1/outcomes/{id}` |
| `outcomes.list` | `GET /v1/outcomes` |

### `phones`

| Method | Route |
| --- | --- |
| `phones.list` | `GET /v1/identities/{id}/phones` |
| `phones.provision` | `POST /v1/identities/{id}/phones` |
| `phones.release` | `DELETE /v1/identities/{id}/phones/{id}` |
| `phones.send` | `POST /v1/identities/{id}/phones/{id}/send` |
| `phones.update` | `PATCH /v1/identities/{id}/phones/{id}` |

### `proxy`

| Method | Route |
| --- | --- |
| `proxy.call` | `GET /v1/proxy/calls/{id}` |
| `proxy.calls` | `GET /v1/proxy/calls` |
| `proxy.completions` | `POST /v1/proxy/openai/v1/chat/completions` |
| `proxy.messages` | `POST /v1/proxy/anthropic/v1/messages` |

### `sessions`

| Method | Route |
| --- | --- |
| `sessions.answer` | `POST /v1/sessions/{id}/answers` |
| `sessions.cancel` | `POST /v1/sessions/{id}/cancel` |
| `sessions.confirmTool` | `POST /v1/sessions/{id}/tool_confirmations` |
| `sessions.create` | `POST /v1/sessions` |
| `sessions.events` | `GET /v1/sessions/{id}/events` |
| `sessions.get` | `GET /v1/sessions/{id}` |
| `sessions.handoffs` | `POST /v1/sessions/{id}/handoffs` |
| `sessions.interrupt` | `POST /v1/sessions/{id}/interrupt` |
| `sessions.list` | `GET /v1/sessions` |
| `sessions.operatorPreview` | `GET /v1/sessions/{id}/operator_preview` |
| `sessions.plan` | `GET /v1/sessions/{id}/plan` |
| `sessions.send` | `POST /v1/sessions/{id}/messages` |
| `sessions.setBudget` | `PATCH /v1/sessions/{id}/budget` |
| `sessions.setOutcome` | `POST /v1/sessions/{id}/outcome` |
| `sessions.threads` | `GET /v1/sessions/{id}/threads` |
| `sessions.writePlan` | `PUT /v1/sessions/{id}/plan` |

### `skills`

| Method | Route |
| --- | --- |
| `skills.catalog.get` | `GET /v1/skills/catalog/{id}` |
| `skills.catalog.list` | `GET /v1/skills/catalog` |
| `skills.catalog.retrieve` | `GET /v1/skills/catalog/{id}/versions/{id}` |
| `skills.delete` | `DELETE /v1/skills/{id}` |
| `skills.get` | `GET /v1/skills/{id}` |
| `skills.getVersion` | `GET /v1/skills/{id}/versions/{id}` |
| `skills.list` | `GET /v1/skills` |
| `skills.listVersions` | `GET /v1/skills/{id}/versions` |
| `skills.push` | `POST /v1/skills` |
| `skills.pushVersion` | `POST /v1/skills/{id}/versions` |

### `social`

| Method | Route |
| --- | --- |
| `social.accountAnalytics` | `GET /v1/identities/{id}/social/accounts/{id}/analytics` |
| `social.accounts` | `GET /v1/identities/{id}/social/accounts` |
| `social.activate` | `POST /v1/identities/{id}/social/activate` |
| `social.comments` | `GET /v1/identities/{id}/social/posts/{id}/comments` |
| `social.createPost` | `POST /v1/identities/{id}/social/posts` |
| `social.deletePost` | `DELETE /v1/identities/{id}/social/posts/{id}` |
| `social.getPost` | `GET /v1/identities/{id}/social/posts/{id}` |
| `social.listPosts` | `GET /v1/posts` |
| `social.portal` | `POST /v1/identities/{id}/social/portal` |
| `social.postAnalytics` | `GET /v1/identities/{id}/social/posts/{id}/analytics` |
| `social.status` | `GET /v1/identities/{id}/social` |
| `social.upload` | `POST /v1/identities/{id}/social/uploads` |

### `socialData`

| Method | Route |
| --- | --- |
| `socialData.getTool` | `GET /v1/social_data/tools/{id}` |
| `socialData.run` | `POST /v1/social_data/runs` |
| `socialData.searchTools` | `GET /v1/social_data/tools` |

### `storage`

| Method | Route |
| --- | --- |
| `storage.buckets.create` | `POST /v1/apps/{id}/storage/buckets` |
| `storage.buckets.delete` | `DELETE /v1/apps/{id}/storage/buckets/{id}` |
| `storage.buckets.list` | `GET /v1/apps/{id}/storage/buckets` |
| `storage.download` | `GET /v1/apps/{id}/storage/buckets/{id}/objects/{id}` |
| `storage.list` | `GET /v1/apps/{id}/storage/buckets/{id}/objects` |
| `storage.remove` | `DELETE /v1/apps/{id}/storage/buckets/{id}/objects/{id}` |
| `storage.signedUploadUrl` | `POST /v1/apps/{id}/storage/buckets/{id}/objects/{id}/upload-url` |
| `storage.signedUrl` | `GET /v1/apps/{id}/storage/buckets/{id}/objects/{id}` |
| `storage.upload` | `PUT /v1/apps/{id}/storage/buckets/{id}/objects/{id}` |

### `stream`

| Method | Route |
| --- | --- |
| `stream` | `GET /v1/sessions/{id}/stream` |

### `trading`

| Method | Route |
| --- | --- |
| `trading.account` | `GET /v1/identities/{id}/trading/account` |
| `trading.cancelOrder` | `DELETE /v1/identities/{id}/trading/orders/{id}` |
| `trading.closePosition` | `POST /v1/identities/{id}/trading/positions/{id}/close` |
| `trading.complete` | `POST /v1/trading/oauth/complete` |
| `trading.connect` | `POST /v1/identities/{id}/trading/connect` |
| `trading.connections` | `GET /v1/identities/{id}/trading/connections` |
| `trading.disconnect` | `DELETE /v1/identities/{id}/trading/connections/{id}` |
| `trading.order` | `GET /v1/identities/{id}/trading/orders/{id}` |
| `trading.orders` | `GET /v1/identities/{id}/trading/orders` |
| `trading.placeOrder` | `POST /v1/identities/{id}/trading/orders` |
| `trading.positions` | `GET /v1/identities/{id}/trading/positions` |
| `trading.quotes` | `GET /v1/identities/{id}/trading/quotes` |

### `vaults`

| Method | Route |
| --- | --- |
| `vaults.create` | `POST /v1/vaults` |
| `vaults.credentials.create` | `POST /v1/vaults/{id}/credentials` |
| `vaults.credentials.delete` | `DELETE /v1/vaults/{id}/credentials/{id}` |
| `vaults.credentials.list` | `GET /v1/vaults/{id}/credentials` |
| `vaults.delete` | `DELETE /v1/vaults/{id}` |
| `vaults.get` | `GET /v1/vaults/{id}` |
| `vaults.list` | `GET /v1/vaults` |

### `webhooks`

| Method | Route |
| --- | --- |
| `webhooks.create` | `POST /v1/webhooks` |
| `webhooks.delete` | `DELETE /v1/webhooks/{id}` |
| `webhooks.deliveries` | `GET /v1/webhooks/{id}/deliveries` |
| `webhooks.delivery` | `GET /v1/webhooks/{id}/deliveries/{id}` |
| `webhooks.get` | `GET /v1/webhooks/{id}` |
| `webhooks.list` | `GET /v1/webhooks` |
| `webhooks.redeliver` | `POST /v1/webhooks/{id}/deliveries/{id}/redeliver` |
| `webhooks.rotate` | `POST /v1/webhooks/{id}/rotate` |
| `webhooks.test` | `POST /v1/webhooks/{id}/test` |
| `webhooks.update` | `PATCH /v1/webhooks/{id}` |

## Plan

An organization needs an active plan before it can be used. These two methods are open even when it does not have one, so a client can always read the state and start a checkout.

```
const plan = await client.credits.subscription();
// { object: "subscription", status: "none" | "active" | "past_due" | "canceled",
//   plan: "standard" | "pro" | null, price_micro_usd, included_credit_micro_usd,
//   current_period_end, grace_until, cancel_at_period_end,
//   trial_end, pending_plan, trial_eligible,
//   plans: [{ plan, price_micro_usd, included_credit_micro_usd }], action_url }

if (plan.status !== "active") {
  const { action_url } = await client.credits.subscribe({ plan: "standard" });
  // Send the person to `action_url`. Nothing changes until the signed callback lands.
  // Standard starts with a 7-day free trial when `plan.trial_eligible` is true.
}

// Later: Pro now, or back to Standard at the end of the period.
await client.credits.changePlan("pro");
```

A trial reads `status: "active"` with `trial_end` set; there is no trial status. Every other call on an organization without a plan answers `402` with code `subscription_required`.

[Errors\\ \\ ApiError — the one exception the client throws: the server's envelope, or a 2xx body the client cannot read.\\ \\ Next](https://usenaive.ai/docs/sdk/errors)

Ctrl+I

## On this page

- [What it is not](https://usenaive.ai/docs/sdk/typescript#what-it-is-not)
- [Constructing a client](https://usenaive.ai/docs/sdk/typescript#constructing-a-client)
- [Coverage](https://usenaive.ai/docs/sdk/typescript#coverage)
- [Invariants worth knowing before your first call](https://usenaive.ai/docs/sdk/typescript#invariants-worth-knowing-before-your-first-call)
 - [Money is integer micro-USD, always](https://usenaive.ai/docs/sdk/typescript#money-is-integer-micro-usd-always)
 - [The vault has no read method, by contract](https://usenaive.ai/docs/sdk/typescript#the-vault-has-no-read-method-by-contract)
 - [The two skill pushes are not interchangeable](https://usenaive.ai/docs/sdk/typescript#the-two-skill-pushes-are-not-interchangeable)
- [Worked examples](https://usenaive.ai/docs/sdk/typescript#worked-examples)
 - [Reading the balance](https://usenaive.ai/docs/sdk/typescript#reading-the-balance)
 - [Pushing a skill, then a second version of it](https://usenaive.ai/docs/sdk/typescript#pushing-a-skill-then-a-second-version-of-it)
 - [Why pushVersion is not just push](https://usenaive.ai/docs/sdk/typescript#why-pushversion-is-not-just-push)
 - [The integrity claim is checked, not trusted](https://usenaive.ai/docs/sdk/typescript#the-integrity-claim-is-checked-not-trusted)
 - [Listing versions](https://usenaive.ai/docs/sdk/typescript#listing-versions)
 - [The page envelope](https://usenaive.ai/docs/sdk/typescript#the-page-envelope)
 - [Deleting](https://usenaive.ai/docs/sdk/typescript#deleting)
- [Handling errors](https://usenaive.ai/docs/sdk/typescript#handling-errors)
- [Streaming](https://usenaive.ai/docs/sdk/typescript#streaming)
- [The same operation in the other two interfaces](https://usenaive.ai/docs/sdk/typescript#the-same-operation-in-the-other-two-interfaces)
- [Method index](https://usenaive.ai/docs/sdk/typescript#method-index)
 - [ads](https://usenaive.ai/docs/sdk/typescript#ads)
 - [agents](https://usenaive.ai/docs/sdk/typescript#agents)
 - [apps](https://usenaive.ai/docs/sdk/typescript#apps)
 - [auditLogs](https://usenaive.ai/docs/sdk/typescript#auditlogs)
 - [auth](https://usenaive.ai/docs/sdk/typescript#auth)
 - [board](https://usenaive.ai/docs/sdk/typescript#board)
 - [browser](https://usenaive.ai/docs/sdk/typescript#browser)
 - [browserSessions](https://usenaive.ai/docs/sdk/typescript#browsersessions)
 - [characters](https://usenaive.ai/docs/sdk/typescript#characters)
 - [computers](https://usenaive.ai/docs/sdk/typescript#computers)
 - [connections](https://usenaive.ai/docs/sdk/typescript#connections)
 - [credits](https://usenaive.ai/docs/sdk/typescript#credits)
 - [crm](https://usenaive.ai/docs/sdk/typescript#crm)
 - [data](https://usenaive.ai/docs/sdk/typescript#data)
 - [database](https://usenaive.ai/docs/sdk/typescript#database)
 - [deployments](https://usenaive.ai/docs/sdk/typescript#deployments)
 - [digest](https://usenaive.ai/docs/sdk/typescript#digest)
 - [domains](https://usenaive.ai/docs/sdk/typescript#domains)
 - [emails](https://usenaive.ai/docs/sdk/typescript#emails)
 - [files](https://usenaive.ai/docs/sdk/typescript#files)
 - [harnesses](https://usenaive.ai/docs/sdk/typescript#harnesses)
 - [identities](https://usenaive.ai/docs/sdk/typescript#identities)
 - [keys](https://usenaive.ai/docs/sdk/typescript#keys)
 - [mcpSessions](https://usenaive.ai/docs/sdk/typescript#mcpsessions)
 - [media](https://usenaive.ai/docs/sdk/typescript#media)
 - [miniApps](https://usenaive.ai/docs/sdk/typescript#miniapps)
 - [mobileDevices](https://usenaive.ai/docs/sdk/typescript#mobiledevices)
 - [models](https://usenaive.ai/docs/sdk/typescript#models)
 - [orgs](https://usenaive.ai/docs/sdk/typescript#orgs)
 - [outcomes](https://usenaive.ai/docs/sdk/typescript#outcomes)
 - [phones](https://usenaive.ai/docs/sdk/typescript#phones)
 - [proxy](https://usenaive.ai/docs/sdk/typescript#proxy)
 - [sessions](https://usenaive.ai/docs/sdk/typescript#sessions)
 - [skills](https://usenaive.ai/docs/sdk/typescript#skills)
 - [social](https://usenaive.ai/docs/sdk/typescript#social)
 - [socialData](https://usenaive.ai/docs/sdk/typescript#socialdata)
 - [storage](https://usenaive.ai/docs/sdk/typescript#storage)
 - [stream](https://usenaive.ai/docs/sdk/typescript#stream)
 - [trading](https://usenaive.ai/docs/sdk/typescript#trading)
 - [vaults](https://usenaive.ai/docs/sdk/typescript#vaults)
 - [webhooks](https://usenaive.ai/docs/sdk/typescript#webhooks)
- [Plan](https://usenaive.ai/docs/sdk/typescript#plan)

[Naive home page](https://usenaive.ai)

[x](https://x.com/usenaive) [linkedin](https://www.linkedin.com/company/usenaive) [website](https://usenaive.ai)

Product

[Home](https://usenaive.ai) [Docs](https://usenaive.ai/) [Primitives](https://usenaive.ai/primitives) [CLI](https://usenaive.ai/cli) [Deploy](https://usenaive.ai/deploy) [Benchmarks](https://usenaive.ai/blogs/introducing-naive-managed-agents) [Blog](https://usenaive.ai/blog)

Company

[Naive](https://usenaive.ai) [Contact](https://cal.com/seandorjeceo/15min)

Legal

[Terms](https://usenaive.ai/terms) [Privacy](https://usenaive.ai/policy) [Licenses](https://usenaive.ai/licenses)

[x](https://x.com/usenaive) [linkedin](https://www.linkedin.com/company/usenaive) [website](https://usenaive.ai)

[Powered byThis documentation is built and hosted on Mintlify, a developer documentation platform](https://www.mintlify.com?utm_campaign=poweredBy&utm_medium=referral&utm_source=vetta)