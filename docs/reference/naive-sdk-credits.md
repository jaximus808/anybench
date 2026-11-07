> ## Documentation Index
> Fetch the complete documentation index at: https://vetta.sh/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# credits

> Balance, top-ups, ledger, and the plan — client.credits. Integer micro-USD, always.

Nine methods. Every monetary value is **integer micro-USD** — the client never exposes a float and never converts to dollars; formatting is your presentation decision. API detail: [Credits](https://vetta.sh/docs/api/credits.md).

## show

```ts theme={"system"}
client.credits.show(): Promise<Balance>
```

`GET /v1/credits/balance`:

```json theme={"system"}
{ "object": "credit_balance", "balance_micro_usd": 79416537, "mode": "test" }
```

`79416537` micro-USD is \$79.416537.

## topup

```ts theme={"system"}
client.credits.topup(amountMicroUsd: number, options?: { return_to?: string }): Promise<Topup>
```

`POST /v1/credits/topups`, body `{ amount_micro_usd, return_to? }`. `return_to` is an app-relative dashboard path (starting with `/`), carried through the hosted checkout so the person lands back there; an absolute or protocol-relative URL is refused `validation_failed`. Opens a hosted checkout and credits **nothing** — only the verified provider callback moves the balance. Send the person to the returned URL.

## ledger

```ts theme={"system"}
client.credits.ledger(query?: LedgerFilter): Promise<Page<LedgerEntry>>
```

`GET /v1/credits/ledger`. `LedgerFilter` extends the [page query](https://vetta.sh/docs/sdk/pagination.md) with `type` (`"debit" | "credit"`), `session_id`, `agent_id`, `deployment_id`, `from`, and `to` — every movement, attributable to what spent it.

## spend

```ts theme={"system"}
client.credits.spend(query?: { session_id?, agent_id?, deployment_id?, from?, to?, days?, timezone? }): Promise<Spend>
```

`GET /v1/credits/spend`. What the matching debits spent, summed by the server over the whole range: `spent_micro_usd`, `by_tier`, and the 50 dearest `by_agent` and `by_session`. `days` (alone, 1 to 90) adds `by_day`, the company's spend per day on `timezone`'s clock. Use it for any total or chart: a sum over one `ledger` page misses every debit past it.

## subscription

```ts theme={"system"}
client.credits.subscription(options?: { includePaymentMethod?: boolean }): Promise<Subscription>
```

`GET /v1/credits/subscription` — the plan, which is the right to use the organization at all:

```json theme={"system"}
{
  "object": "subscription", "status": "active", "plan": "standard",
  "price_micro_usd": 20000000, "included_credit_micro_usd": 20000000,
  "current_period_end": "2026-09-22T17:30:00Z", "grace_until": null, "cancel_at_period_end": false,
  "trial_end": "2026-09-22T17:30:00Z", "pending_plan": null, "trial_eligible": false, "action_url": null
}
```

`status` is `none | active | past_due | canceled`. Every route outside billing answers `402 subscription_required` until it reads `active`. While `past_due`, `grace_until` is the moment the organization stops working. `action_url` is `null` on a read.

`plan` is `"standard" | "pro" | null` (`null` before the first subscription), with its monthly `price_micro_usd` and `included_credit_micro_usd`. A free trial reads `status: "active"` — there is no trial status — with `trial_end` set while it runs. `pending_plan` is a downgrade scheduled for `current_period_end`. `trial_eligible` says whether `subscribe({ plan: "standard" })` would start the 7-day free trial. `trial_days` and `trial_credit_micro_usd` are the trial's length and starting credit on this deployment (`0` when trials are off). `plans` lists each plan this deployment sells as `{ plan, price_micro_usd, included_credit_micro_usd }`, readable before subscribing. The plan fields are optional in the schema, so the client still parses an older server that omits them. `includePaymentMethod: true` adds `payment_method`, the card the plan bills (`{ last4 }`, or `null` when there is none or it could not be read), read from the payment provider at call time. It needs a key with `billing:write`; without it the call is refused with `403 forbidden`.

## subscribe

```ts theme={"system"}
client.credits.subscribe(options?: { plan?: "standard" | "pro" }): Promise<Subscription>
```

`POST /v1/credits/subscription`. Opens the hosted checkout for the plan — Standard by default, with the 7-day free trial when `trial_eligible` — and answers `action_url`. Send the person there; nothing changes until the signed callback lands. An organization whose plan is already `active` throws `ApiError` `state_conflict`: use `changePlan`.

```ts theme={"system"}
const plan = await client.credits.subscription();
if (plan.status !== "active") {
  const { action_url } = await client.credits.subscribe({ plan: "standard" });
}
```

## changePlan

```ts theme={"system"}
client.credits.changePlan(plan: "standard" | "pro"): Promise<Subscription>
```

`PATCH /v1/credits/subscription`. Changes an active plan. `"pro"` is immediate: the difference for the rest of the month is charged now on the card on file, and a running trial ends with \$200 charged. `"standard"` from Pro takes effect at `current_period_end` — nothing refunded, the Pro credit kept — and reads back as `pending_plan: "standard"`; `changePlan("pro")` before then takes it back. The plan already held with nothing pending is a no-op. No active plan throws `state_conflict`.

```ts theme={"system"}
const upgraded = await client.credits.changePlan("pro");
```

## cancelSubscription

```ts theme={"system"}
client.credits.cancelSubscription(): Promise<Subscription>
```

`DELETE /v1/credits/subscription`. Stops the plan **at the end of the period already paid for** — never immediately. The state follows the provider's callback, so the answer reports the request, not a completed change (`cancel_at_period_end: true`).

## billingPortal

```ts theme={"system"}
client.credits.billingPortal(): Promise<{ object: "billing_portal_session"; action_url: string }>
```

`POST /v1/credits/billing_portal`. Returns a link to the payment provider's own hosted account page — change the card, download invoices, cancel. Send the person to `action_url`; it is single-use and expires, so mint one per visit rather than caching it.

```ts theme={"system"}
const { action_url } = await client.credits.billingPortal();
```

An organization that has never held a plan has no account to manage: the call throws `ApiError` with `code` `not_found`. Catch it and offer `subscribe()` instead.


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.