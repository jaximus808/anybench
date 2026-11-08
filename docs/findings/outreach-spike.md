# Outreach spike: Context.dev leads, GitHub signals, AgentMail via Monid (TDM-162, 2026-11-08)

Supersedes the ticket's planned `context-dev.md` / `github-signals.md` / `agentmail.md` split: one file, one spike.
Founder decision: AgentMail runs **through Monid** (provider `agentmail`, paid from Monid credit). There is no `AGENTMAIL_API_KEY`.

**Inbox:** `anybench-outreach@agentmail.to` (display name "Anybench", default `agentmail.to` domain, no custom domain).

**Spend:** Monid $1.002 (inbox $1.000 + send $0.001 + reply $0.001). Context.dev 21 credits (542 → 521). GitHub 7 unauthenticated requests. Total cap was $3 Monid and 30 Context.dev credits.

Scripts: `scripts/spikes/outreach/*.ts` (run with `npx tsx`; keys come from `.env` via `lib.ts`, which strips quotes and whitespace. A shell `source` of `.env` gave Monid 401s). Raw JSONL goes to `$SPIKE_OUT` (outside the repo). Typed client: `packages/outreach` (`@anybench/outreach`).

---

## 1. Monid API (what the client is built on)

- Base `https://api.monid.ai`, header `Authorization: Bearer <MONID_API_KEY>`. OpenAPI: `https://monid.ai/openapi.json` (not under api.monid.ai).
- `POST /v1/inspect {provider, endpoint}` returns the input JSON schema, the live price and a docUrl. It's free and its rate limit is 200/min.
- `POST /v1/run {provider, endpoint, input:{body,queryParams,pathParams}, maxCost}`. For **agentmail, every field goes in `input.body`, path params too** (`/threads/{id}` takes `{body:{threadId}}`). Rate limit 600/min.
  - 200 + `status: COMPLETED` means the provider answered. Check `providerResponse.httpStatus`: a provider non-2xx comes back with that same HTTP status and a full run body, and a provider 402 comes back as 502.
  - 200 + `status: BLOCKED` means a workspace budget or run cap stopped it. 202 means async, so poll `GET /v1/runs/{runId}`. 408 means `TIMED_OUT` (not charged).
  - 400 with `errorCode: MAX_COST_EXCEEDED` means the estimate was above maxCost. Nothing is charged. 402 means our wallet is low.
- `GET /v1/wallet/balance` returns `{balance:{value,currency}, held:{value,currency}}` in USD floats. `GET /v1/runs` lists runs with `cost`.
- `GET /v1/resources/{id}` returns resource metadata, including renewal pricing.
- Existing workspace control: `GET /v1/controls/workspace/budgets` shows a **$3/day budget control, status PAUSED** (created 01:06Z by someone else, not this spike). If it is resumed, runs over $3 per day come back `BLOCKED`.

### Money: float USD → integer micro-USD at the boundary
Monid sends USD as JSON floats in `price.amount.value` (0.0245), `cost.value`, `wallet.balance.value` (18.898), and takes `maxCost` as a float with at most 6 decimals. `POST /v1/run` also returns `billing.reportedCost: {value: 1000000, unit: "MICRO_DOLLAR"}`, which is already an integer. The client prefers that field.

`packages/outreach/src/money.ts`:
- `usdToMicroUsd(n, rounding)` parses `String(n)` as a decimal (including the `1e-7` form) with bigint math only. It never multiplies a float. Prices and costs round **up**, balances round **down**. It rejects NaN, Infinity and negatives.
- `microUsdToUsdWire(m)` builds `maxCost` from the decimal string, so `24_500n` becomes exactly `0.0245`.
- zod: `MonidUsdSchema` (rounds up), `MonidBalanceUsdSchema` (rounds down), `MonidReportedCostSchema` (`MICRO_DOLLAR|CENT|DOLLAR` → bigint).

### Prices from `/v1/inspect` (2026-11-08)
| provider | endpoint | price (USD float) | micro-USD |
|---|---|---|---|
| agentmail | `/create-inboxes` | PER_CALL 1 | 1,000,000 (plus **$1/month rent**, renews 2026-12-05, plus $1/GB-month storage) |
| agentmail | `/send-messages` | PER_RESULT 0.001, billed per recipient across to/cc/bcc | 1,000 per recipient |
| agentmail | `/reply-messages/{id}` | PER_RESULT 0.001 per recipient | 1,000 |
| agentmail | `/list-messages`, `/list-threads`, `/threads/{id}`, `/messages/{id}`, `/list-inboxes` | PER_CALL 0 | 0 |
| hunterio | `/email-finder` (GET, `queryParams`: domain or company, first_name, last_name or linkedin_handle) | PER_RESULT 0.0245, charged only when found | 24,500 |
| anyapi | `/github.repository` (`body.url`) | PER_CALL 0.0012 | 1,200 |

---

## 2. AgentMail via Monid (live)

```
npx tsx scripts/spikes/outreach/agentmail-create-inbox.ts      # list-inboxes (0) then create-inboxes, maxCost 1
```
```
POST /v1/run {"provider":"agentmail","endpoint":"/list-inboxes","input":{},"maxCost":0}
→ 200 {"status":"COMPLETED","output":{"count":0,"inboxes":[]},"billing":{"reportedCost":{"value":0,"unit":"MICRO_DOLLAR"}}}

POST /v1/run {"provider":"agentmail","endpoint":"/create-inboxes",
              "input":{"body":{"username":"anybench-outreach","displayName":"Anybench"}},"maxCost":1}
→ 200 runId 01M6WBKDP23P5732YW3QPH8RYZ, status COMPLETED
  output {"inbox_id":"anybench-outreach@agentmail.to","email":"anybench-outreach@agentmail.to","display_name":"Anybench",...}
  billing.reportedCost {"value":1000000,"unit":"MICRO_DOLLAR"}
  resources: PROVISIONED email_account (free container, not releasable) + email_inbox 01M6WBKGNHZT41QBKNYDD06SCD
```
- Custom domain: **not created** (founder rule). It would be `/create-domains` ($1/month, returns DNS records), then `/verify-domains`, then `create-inboxes {domain}`. Until H7 DNS is done, outreach sends from `@agentmail.to`.
- `/v1/resources` (list) shows only the email_account. The inbox resource is visible via `GET /v1/resources/01M6WBKGNHZT41QBKNYDD06SCD`: "Rent is $1 per month; the first month is charged when the inbox is created... Deleting the inbox releases it immediately."

### Self-send with HTML + text + List-Unsubscribe, read back, reply threading
```
npx tsx scripts/spikes/outreach/agentmail-selfsend.ts anybench-outreach@agentmail.to
```
```
POST /v1/run agentmail /send-messages maxCost 0.002
  body {inboxId: INBOX, to: INBOX, subject:"TDM-162 spike self-send ...", text:"...", html:"<p>...</p>",
        headers:{"List-Unsubscribe":"<mailto:anybench-outreach@agentmail.to?subject=unsubscribe>"}, labels:["outreach-spike"]}
→ output {"message_id":"<010001a1b8ba3a6e-...@email.amazonses.com>","thread_id":"650985e6-09eb-4057-9a6c-ce4272d15369"}
  reportedCost 1000 MICRO_DOLLAR

POST /v1/run agentmail /list-messages {"body":{"inboxId":INBOX,"limit":10}} maxCost 0   (1.5 s after send)
→ {"count":1,"messages":[{"thread_id":"650985e6-...","message_id":"<010001a1b8ba3a6e-...>",
   "labels":["sent","outreach-spike","received","unread"],"from":"Anybench <anybench-outreach@agentmail.to>",
   "to":["anybench-outreach@agentmail.to"],"preview":"...","headers":{"List-Unsubscribe":"<mailto:...?subject=unsubscribe>"}, ...}]}

POST /v1/run agentmail /list-threads {"body":{"limit":5}}
→ {"threads":[{"thread_id":"650985e6-...","message_count":1,"senders":[...],"recipients":[...],"last_message_id":"<...>", ...}]}

POST /v1/run agentmail /threads/{id} {"body":{"threadId":"650985e6-..."}}
→ thread summary + "messages":[{..., "text":"...", "html":"<div><p>...</p></div>", "extracted_text":"...", "extracted_html":"..."}]

POST /v1/run agentmail /reply-messages/{id} {"body":{"inboxId":INBOX,"messageId":"<010001a1b8ba3a6e-...>","text":"This is a reply..."}} maxCost 0.002
→ {"message_id":"<010001a1b8badf23-...>","thread_id":"650985e6-..."}   (SAME thread_id), reportedCost 1000

/threads/{id} 8 s later → message_count 2; /list-messages → 2 rows, newest first:
  {"message_id":"<010001a1b8badf23-...>","labels":["sent","received"],"subject":"Re: TDM-162 spike self-send ...",
   "in_reply_to":"<010001a1b8ba3a6e-...>","references":["<010001a1b8ba3a6e-...>"], "preview":"This is a reply...\n\nOn Sun, Nov 8, 2026 ... wrote:\n> ..."}
```
What this means for 15.6a (sending) and 15.8a (reply polling):
- Delivery is fast: the self-send was listed on the first poll, about 1.5 s after send.
- **A self-send is ONE message** that carries both `sent` and `received`. `received` alone doesn't identify inbound mail. Use `isInboundReply(msg, ourInbox)`: it requires the `received` label AND a `from` that isn't our address.
- Threading: a reply keeps `thread_id` and sets `in_reply_to` plus `references` to the parent `message_id` (RFC 5322 ids from SES). Map replies to leads by `thread_id`, falling back to `in_reply_to`. `/threads/{id}` returns full bodies, and `extracted_text` is the reply without the quoted history. List rows only carry `preview`.
- Custom headers pass through (`List-Unsubscribe` is visible on the stored message). One-click `List-Unsubscribe-Post` needs an https URL, so it waits for the public API (E13).
- Polling is free (`list-messages` with `after=<last seen ISO time>` and `labels`). The rate limit is 600 runs/min.

Typed client check, read-only and free (`npx tsx scripts/spikes/outreach/client-live-check.ts`):
```
balanceMicroUsd 18898000, heldMicroUsd 100000, inboxes [{inboxId: anybench-outreach@agentmail.to, state: ACTIVE}],
2 messages on thread 650985e6-..., inbound=false for both (self-send), thread.messageCount 2, spentMicroUsd 0
```
Wallet: $20.00 before. After: balance $18.898 + held $0.10. The $0.10 hold appeared right after inbox creation and is still held; it's most likely the storage-metering reservation. Runs list: create-inboxes $1, send-messages $0.001, reply-messages $0.001, everything else $0.

---

## 3. Context.dev (lead search + enrichment)

- REST base `https://api.context.dev/v1`, header `Authorization: Bearer <CONTEXT_DEV_API_KEY>`. OpenAPI: `https://api.context.dev/openapi.json`. Every response has `key_metadata.credits_consumed/credits_remaining`, and an `x-credits-used` header appears when credits are spent.
- Rate limits: `/web/search` and `/people/enrich` are **concurrency 2** (`x-ratelimit-mode: concurrency`). `/org/usage` is 60/min.
- `GET /org/usage` (0 credits) → `{"credits_remaining":542,"period":{"start":"2026-10-29T07:01:00Z","credits_used":370},"next_refill":{"at":"2026-11-29T08:01:00Z","credits":1000},"auto_topup":{"enabled":false}}`

```
npx tsx scripts/spikes/outreach/context-dev-search.ts
POST /web/search {"query":"site:github.com (\"faster than\" OR benchmark OR \"fewer tokens\") (\"Claude Code\" OR \"coding agent\") harness",
                  "freshness":"last_month","numResults":10}
→ 200, x-credits-used 1, cache miss. Fields per result: url, title, description (snippet), relevance (high|medium|low),
  markdown {code:NOT_REQUESTED}, highlights {code:NOT_REQUESTED}
```
| url | relevance | snippet claim |
|---|---|---|
| github.com/aarora79/agentic-coding-harness-benchmarks | high | Claude Code vs pi, "far more token-efficient" |
| github.com/samuelfaj/distill | high | "far more done with far fewer tokens" |
| github.com/VILA-Lab/Dive-into-Claude-Code | high | "+7.7 points, 4x fewer context tokens" (research) |
| github.com/trailhq/Trail-Code | medium | "33 of 50 vs 27, 25% fewer tool calls, 23% fewer tokens" |
| github.com/Heretek-AI/harness-benchmark/issues/60 | medium | (an issue, not a repo: filter `/issues/`) |
| github.com/juliusbrussee/caveman | medium | "54 Claude Code runs, 18 of 18 right" |
| github.com/bradagi/awesome-cli-coding-agents | medium | (awesome list: filter) |
| github.com/mibayy/token-savior | medium | "97.9% at -80% tokens, -83% wall time" |
| github.com/ai-boost/awesome-harness-engineering/... | medium | (awesome list: filter) |
| github.com/topics/agent-harness | medium | (topic page: filter) |

So 6 of 10 results are repos with a quantified perf claim. Sourcing must drop `/issues/`, `/topics/`, `/blob/` and `awesome-*` URLs, and normalise to `owner/repo`. **Cost: 1 credit per 10 results** (highlights +1 per 10, markdown +1 per result).

### people-enrich (one public lead)
```
npx tsx scripts/spikes/outreach/context-dev-enrich.ts https://github.com/samuelfaj
POST /people/enrich {"social_urls":["https://github.com/samuelfaj"]}
→ 200 {"match":{"status":"not_found","score":null,"person":null}}  credits_consumed 0

npx tsx scripts/spikes/outreach/context-dev-enrich.ts '{"name":{"first":"…","last":"…"},"location":{"region":"…","country":"Brazil"},"social_urls":["https://github.com/samuelfaj","<their blog>"]}'
→ 200, x-credits-used 20 {"match":{"status":"candidate","score":92,"person":{name, bio, location, social_urls:[linkedin],
   current_role, experience, education, skills, avatar_url, ...}}}   ← NO email field
```
Findings (n = 1 lead, 2 calls):
- A GitHub profile URL alone gives `not_found`, and that's **free** (0 credits). Name + location from the GitHub profile (`GET /users/{login}`) produced a match with score 92.
- A match costs **20 credits** even though it **returned no email** (fields: `avatar_url, bio, checked_at, current_role, current_role_status, education, experience, last_updated, location, name, skills, social_urls, website_urls`). So people-enrich isn't a reliable email source for GitHub leads. It does return the LinkedIn URL and the current employer, which is what Hunter `/email-finder` needs (`linkedin_handle` or name + company domain, $0.0245 only when found). For 15.2a: enrich (20 cr) only for leads that pass fit, then Hunter via Monid for the address. Alternatively, use the hackathon opt-in CSV.
- The not_found rate across 3 leads wasn't measured. The 30-credit cap allowed only one paid match. Sample: 1 not_found (URL only), 1 candidate (name + location).

---

## 4. GitHub signals (unauthenticated)

`GITHUB_TOKEN` is empty, so these calls are unauthenticated: **60 core requests/hour per IP, shared with every worker on this Mac.** It was already at 26/60 remaining when the spike started. `GET /rate_limit` doesn't count against the limit.
```
npx tsx scripts/spikes/outreach/github-signals.ts samuelfaj/distill trailhq/Trail-Code Mibayy/token-savior
GET https://api.github.com/rate_limit                 → core {limit:60, remaining:26, used:34}
GET /repos/{owner}/{repo}                              (Accept: application/vnd.github+json)
GET /repos/{owner}/{repo}/readme                       (Accept: application/vnd.github.raw+json → raw markdown)
GET https://api.github.com/rate_limit                 → core {remaining:20, used:40}   (2 per repo)
```
| repo | owner | stars | forks | pushed_at | lang | license | README claim lines |
|---|---|---|---|---|---|---|---|
| samuelfaj/distill | User | 777 | 54 | 2026-11-05 | Rust | Apache-2.0 | L32 "93% cheaper", L34 "0.069x the credits of Normal on our 20-case benchmark", L47 "~2x faster", L49 "0.509x the wall time" |
| trailhq/Trail-Code | Organization (homepage trailhq.com) | 11,135 | 990 | 2026-11-07 | TypeScript | MIT | L33 "46% fewer tool calls, 60% less time", L40 "SWE-bench Verified 27 → 33 of 50", L71 "Claude Sonnet 5 solved 33 of 50 ... 23% fewer tokens" |
| Mibayy/token-savior | User | 1,212 | 110 | 2026-10-15 | Python | MIT | L7 "97.9% on tsbench at -80% tokens", L17 "Benchmark source + fixtures: not currently published" (a correctness gate gap we can pitch) |

The claim regex in the script is too loose: `%` also matches `width="25%"`, and it picks up badge lines. 15.2a/15.3a should strip HTML and badge lines before matching and cite `README.md#L<n>`. With 60/h the scout can afford about 25 leads/hour (2 calls each). A `GITHUB_TOKEN` (5,000/h) or Monid `anyapi /github.repository` ($0.0012/call, repo metadata only, no README) removes the limit.

---

## 5. What downstream tickets get (`@anybench/outreach`)
- `createMonidClient({apiKey, spendCapMicroUsd?})` / `createMonidClientFromEnv()`: `inspect`, `run` (**maxCostMicroUsd is required**, as a bigint), `getRun`, `balance`, `spentMicroUsd`. It polls 202s. `MonidError.code` is one of `MAX_COST_EXCEEDED | WALLET_INSUFFICIENT_FUNDS | BLOCKED | PROVIDER_ERROR | RUN_FAILED | SPEND_CAP | RATE_LIMITED | ...` and carries `run` when Monid returned one.
- `createAgentMail(monid)`: `createInbox`, `listInboxes`, `send` (maxCost is $0.001 × recipients), `reply`, `listMessages`, `listThreads`, `getThread`, `getMessage`. Helpers: `listUnsubscribeHeaders(inbox)`, `isInboundReply(msg, inbox)`, `bareAddress`, `AGENTMAIL_PRICES`.
- `FakeAgentMail` (`@anybench/outreach/fake`) has the same interface in memory. It reproduces the observed labels and threading and adds `simulateInboundReply` for 15.8a tests.
- Env: `MONID_API_KEY` (required), `MONID_BASE_URL` (optional), `OUTREACH_FROM_ADDRESS=anybench-outreach@agentmail.to`.
