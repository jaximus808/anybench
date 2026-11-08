# Stripe usage billing: meters, metered price, Checkout, credit grants, thresholds (TDM-21 [2.7] spike, 2026-11-08)

Does plan.md section 8 work as written on Stripe Billing? Every claim below comes from a live call against the founder's **test-mode** key. Checkout shows the account as "anybench sandbox", so the key belongs to a Stripe **sandbox**. The scripts are in `scripts/spikes/stripe/`, a small workspace package (`@anybench/spike-stripe`) so it can import the `stripe` SDK. Run them as:

```
node --env-file=<repo>/.env scripts/spikes/stripe/<script>.ts      # Node ≥ 22.18 strips the types; no tsx needed
```

`lib.ts` reads `STRIPE_TEST_SECRET_KEY` through a zod schema. It **refuses any key that is not `sk_test_`/`rk_test_`**, and it never prints the key. Every SDK response is recorded through `stripe.on("response")` (method, path, status, request_id). Each script saves its full evidence as JSON in `SPIKE_OUT_DIR`. Outputs below are trimmed copies of that evidence.

SDK: `stripe` 23.1.0 (already a dependency of `packages/billing`), API version `2026-10-28.endive` (the SDK default). Stripe CLI 1.55.1 for `stripe listen`.

## Summary

| Question | Answer |
|---|---|
| Meter + product + metered price, idempotent? | **Yes.** `setup.ts` creates them on the first pass. The second pass creates nothing and returns the same ids. |
| Checkout `mode=subscription` with the metered price saves a card and charges nothing? | **Yes.** It shows "$0.00 due today, then $0.01 per unit, billed monthly based on usage". I completed it with 4242 4242 4242 4242 in a headless browser: session `complete`, subscription `active`, card saved. **Gotcha:** `payment_status` is `"unpaid"` (not `no_payment_required`), and the card is the **subscription's** default payment method, not the customer's. |
| Meter events dedupe on `identifier`? | **Yes, synchronously.** Resending an identifier returns **HTTP 400** `"An event already exists with identifier ue_…"` (no `error.code`), whether the value is the same or different. The meter summary stayed at exactly 750. |
| Credit grant applied before the card is charged? | **Yes. This is the done condition.** On invoice `in_1UZKYhLELMnxuId9Qy9aGlRD`: $7.50 of metered usage, a **$5.00 promotional grant applied as a pretax credit**, and **$2.50 charged to the 4242 card**. Status `paid`. The grant balance is now $0. |
| `billing_thresholds` with meters? | **Works** on a `flexible` billing-mode subscription (the default). With `amount_gte: 500` and 600¢ of usage, Stripe drafted a `subscription_threshold` invoice for $6.00 and charged it 1 h later. **It is not real-time**: no invoice existed 90 s after the usage was aggregated. Treat thresholds as a debt limiter, not as the spend cap. |
| Billing alert on the meter? | **Works, and is near real-time.** `billing.alert.triggered` arrived about 45 s after the usage event, in real time with no clock advance. This is the fast signal for "this user just crossed $X". |
| Webhook sequence | Recorded with `stripe listen` and cross-checked with `events.list` (below). **Events in the same second arrive out of order**: for example, `payment_intent.created` came after `payment_intent.succeeded`, and `invoice.paid` came before `invoice.finalized`. |
| Spend | $0. Test mode only. The 4242 card charges ($2.50 and $6.00) are test charges. |

## Ids to put in `.env` (test mode)

These come from `setup.ts` (pass 1 created them; every run since has found the same ones):

```
STRIPE_TEST_METER_ID=mtr_test_61ViiSo4TTJ24bA7N41LELMnxuId9D1s
STRIPE_TEST_PRICE_USAGE=price_1UZKVSLELMnxuId9MrvjWTXp
# product id: anybench_usage   price lookup_key: anybench_usage_cents_v1   meter event_name: anybench_usage
```

What's in `.env` now (I checked only whether each key is empty, never its value):

| Key | State | Founder action |
|---|---|---|
| `STRIPE_TEST_SECRET_KEY` | set (sk_test_) | Optional: replace it with a restricted `rk_test_` key (Stripe recommends one) that has write access to Billing (meters, meter events, credit grants, alerts), Customers, Checkout Sessions, Subscriptions, Invoices, Payment Methods and Products/Prices, plus read access to Events. |
| `NEXT_PUBLIC_STRIPE_TEST_PUBLISHABLE_KEY` | set | none |
| `STRIPE_TEST_METER_ID` | empty | **fill** with the meter id above |
| `STRIPE_TEST_PRICE_USAGE` | empty | **fill** with the price id above |
| `STRIPE_TEST_WEBHOOK_SECRET` | empty | **fill**. For local dev, use the `whsec_` that `stripe listen --forward-to localhost:8787/webhooks/stripe` prints. For the deployed API, use the endpoint's secret from Dashboard → Developers → Webhooks (event list in `.env.example`). |
| `STRIPE_SECRET_KEY` | (not in `.env`) | copy of the test key while `BILLING_MODE=test` |
| `STRIPE_LIVE_*` | empty | only at the 10.11 cutover; run `setup.ts` against the live key then (it refuses today by design) |

`.env.example` gained one new name, `SPIKE_OUT_DIR` (optional, spike only), and its Stripe comment now points at `setup.ts`.

## 1. Catalog setup (idempotent): `setup.ts`

```
$ node --env-file=../anybench/.env scripts/spikes/stripe/setup.ts
[setup] pass 1 {"meterId":"mtr_test_61ViiSo4TTJ24bA7N41LELMnxuId9D1s","productId":"anybench_usage","priceId":"price_1UZKVSLELMnxuId9MrvjWTXp","created":{"meter":true,"product":true,"price":true}}
[setup] pass 2 (must create nothing, same ids) {"meterId":"mtr_test_61ViiSo4TTJ24bA7N41LELMnxuId9D1s","productId":"anybench_usage","priceId":"price_1UZKVSLELMnxuId9MrvjWTXp","created":{"meter":false,"product":false,"price":false}}
[setup] calls: GET /v1/billing/meters?limit=100 200 | POST /v1/billing/meters 200 | GET /v1/products/anybench_usage 404 | POST /v1/products 200 | GET /v1/prices?lookup_keys[0]=anybench_usage_cents_v1&active=true&limit=1 200 | POST /v1/prices 200 | GET /v1/billing/meters?limit=100 200 | GET /v1/products/anybench_usage 200 | GET /v1/prices?lookup_keys[0]=anybench_usage_cents_v1&active=true&limit=1 200
```

How each object stays idempotent (10.2 can copy `ensureMeter`, `ensureProduct`, `ensurePrice` and `ensureBillingCatalog` as they are):

- **Meter.** Meters have no `metadata` or `lookup_key`, so the key is `event_name = "anybench_usage"`, found by listing. An `inactive` meter with that name is reactivated rather than duplicated. Config: `default_aggregation.formula = "sum"`; `customer_mapping = {type: "by_id", event_payload_key: "stripe_customer_id"}`; `value_settings.event_payload_key = "value"`. The value is in **cents**.
- **Product.** A caller-chosen id, `anybench_usage` (`products.create({id})` accepts it), found with retrieve. A 404 means create it.
- **Price.** `lookup_key = "anybench_usage_cents_v1"`, USD, `unit_amount: 1` (1¢ per meter unit), `recurring: {interval: "month", usage_type: "metered", meter}`. Prices are immutable, so `ensurePrice` **throws** if the price behind that lookup key doesn't match the meter or unit. To change a price, create `_v2` with `transfer_lookup_key`; never edit it in place.

## 2. Link a card: Checkout `mode=subscription`: `checkout.ts`

```
$ node --env-file=../anybench/.env scripts/spikes/stripe/checkout.ts create
[checkout] session created {"customer":"cus_VaVcT8UhhvxTiR","session":"cs_test_a17YtROA4akaEzitC6xNP5QOFkA2hdhwvhIE2Omi2LCO7ouKUThsyDSclB","status":"open","payment_status":"unpaid","amount_total":0,"url":"https://checkout.stripe.com/c/pay/cs_test_a17Yt…"}
```

The call: `checkout.sessions.create({mode: "subscription", customer, client_reference_id: user_id, line_items: [{price}] /* no quantity for metered */, subscription_data: {metadata: {user_id}}, success_url, cancel_url, integration_identifier: "anybench_link_card_<8 letters>", metadata})`. I created the Customer first, with `metadata.user_id`, because Checkout cannot set customer metadata itself. Per Stripe guidance there is no `payment_method_types`. The page offered **Card, Cash App Pay, Klarna and Bank** (dynamic payment methods from the Dashboard). Turn off the ones we don't want in Settings → Payment methods; don't hard-code a list.

Checkout Sessions **cannot be completed through the API**. I completed this one in a headless browser (gstack `browse`): selected Card, entered 4242 4242 4242 4242 / 12/34 / 123 / 94107, unchecked "Save with Link", clicked Subscribe. It redirected to `success_url` (localhost isn't served, so the page shows an error, which is expected). Then:

```
$ node --env-file=../anybench/.env scripts/spikes/stripe/checkout.ts inspect cs_test_a17Yt…
[checkout] inspect {"session":{"status":"complete","payment_status":"unpaid","amount_total":0,"mode":"subscription"},
  "subscription":{"id":"sub_1UZKctLELMnxuId9RyMBaeQa","status":"active","default_payment_method":"pm_1UZKcrLELMnxuId99PCOkWQd","metadata":{"user_id":"spike-checkout-9eyy0g2q"},"latest_invoice":null},
  "customer":{"id":"cus_VaVcT8UhhvxTiR","metadata":{"user_id":"spike-checkout-9eyy0g2q",…},"invoice_settings":{"default_payment_method":null,…}},
  "payment_methods":[{"id":"pm_1UZKcrLELMnxuId99PCOkWQd","type":"card","brand":"visa","last4":"4242"}]}
```

What 10.3 and 10.4 need to know:

- **Gate "card linked" on `session.status == "complete"` plus the subscription being `active`**, not on `payment_status == "paid"`. A $0 metered subscription completes with `payment_status: "unpaid"`.
- The card lands on **`subscription.default_payment_method`**, while `customer.invoice_settings.default_payment_method` stays `null`. Invoices for this subscription use it. `has_payment_method` should come from `payment_method.attached` / `customers.listPaymentMethods`, not from the customer's default. If we ever bill outside this subscription, copy it to the customer default first.
- `latest_invoice` is `null`. In `flexible` billing mode, a metered-only subscription creates **no $0 first invoice**.
- Webhooks for the session, in order: `customer.created` (our create), then 107 s later when Subscribe was clicked: `customer.updated`, `setup_intent.created`, `payment_method.attached`, `customer.subscription.created`, `checkout.session.completed`, `setup_intent.succeeded`.
- Cosmetic: Checkout says "$0.01 per **unit**". Set the product's `unit_label` (for example "usage cent"; Stripe caps it at 12 characters), or present the price as "billed at cost of usage" on our own page.

## 3. Usage, dedupe, credit grant, invoice: `scenario-grant.ts` (the done condition)

This runs on a **test clock**, so a month passes in seconds. The customer gets `pm_card_visa` (the 4242 card) attached through the API as the default payment method, which is the same end state Checkout produces.

```
$ node --env-file=../anybench/.env scripts/spikes/stripe/scenario-grant.ts
[customer] created on test clock with card {"clock":"clock_1UZKXtLELMnxuId9kyQ0HzLu","customer":"cus_VaVZFQiQWKtvXl","pm":"pm_1UZKXtLELMnxuId9d7MyemyM","card":"4242"}
[grant] created {"id":"credgr_test_61ViiVGUuwvbBa3Hs41LELMnxuId9VPs","amount":{"monetary":{"currency":"usd","value":500},"type":"monetary"},"effective_at":1794099920,"expires_at":null}
[subscription] created {"id":"sub_1UZKXuLELMnxuId9AqnW7gID","status":"active","billing_mode":"flexible","period":[1794099920,1796691920],"first_invoice":null}
```

The grant call: `billing.creditGrants.create({customer, name, category: "promotional", amount: {type: "monetary", monetary: {currency: "usd", value: 500}}, applicability_config: {scope: {price_type: "metered"}}, metadata})`. **`value` is in cents.** `effective_at` defaulted to the clock's current time.

**Micro-USD → cents with carry** (core's `toCents`). Four ledger entries add up to exactly 7,500,000 µ$ ($7.50), with fractional cents carried forward:

```
[meter] reported 4 events [
 {"identifier":"ue_ymrpkxqm_0","micro":"2000000","cents":"200","carry_after":"0"},
 {"identifier":"ue_ymrpkxqm_1","micro":"1234567","cents":"123","carry_after":"4567"},
 {"identifier":"ue_ymrpkxqm_2","micro":"2000005","cents":"200","carry_after":"4572"},
 {"identifier":"ue_ymrpkxqm_3","micro":"2265428","cents":"227","carry_after":"0"}]          → 750 ¢, nothing lost
```

Each event is `billing.meterEvents.create({event_name: "anybench_usage", identifier, timestamp, payload: {stripe_customer_id, value: "<cents>"}})`. Payload values are **strings**.

**Dedupe**: I resent identifier `ue_ymrpkxqm_1` twice, first with the same value and then with 9999:

```
[dedupe] resends {"same_identifier_same_value":{"accepted":false,"error":{"type":"StripeInvalidRequestError","status":400,"message":"An event already exists with identifier ue_ymrpkxqm_1.","request_id":"req_yE7zeALOgEqvYk"}},
                  "same_identifier_value_9999":{"accepted":false,"error":{"type":"StripeInvalidRequestError","status":400,"message":"An event already exists with identifier ue_ymrpkxqm_1.","request_id":"req_CQYVzkr2bb2VUP"}}}
[meter] summary aggregated_value after 41s {"aggregated_value":750,"expected":750}
```

So the reporter (10.5) must treat a **400 with "An event already exists with identifier"** as "already reported" and mark the entry reported. There is no `error.code` to match on. The meter aggregates asynchronously: `event_summaries` reached 750 about 41 s after the events.

**Invoice preview** (before the period ends) already shows the grant:

```
[preview] upcoming invoice {"subtotal":750,"total":250,"amount_due":250,"total_pretax_credit_amounts":[{"amount":500,"type":"credit_balance_transaction"}],"lines":[{"description":"750 × Anybench usage (at $0.01 / month)","amount":750,"quantity":750}]}
```

**Advance the clock past the period end.** Stripe drafts the cycle invoice, auto-finalizes it about 1 h later, applies the grant and charges the card:

```
[clock] advance to period end + 1 min {"frozen_time":1796691980,"iso":"2026-12-08T01:06:20.000Z"}   ready after 12s
[invoice] after period end {"id":"in_1UZKYhLELMnxuId9Qy9aGlRD","status":"draft","subtotal":750,"amount_due":250}
[clock] advance to period end + 3 h (auto-finalize + charge) {"frozen_time":1796702720}               ready after 9s
[invoice] cycle invoice {"id":"in_1UZKYhLELMnxuId9Qy9aGlRD","status":"paid","billing_reason":"subscription_cycle",
  "subtotal":750,
  "total_pretax_credit_amounts":[{"amount":500,"credit_balance_transaction":"cbtxn_test_61ViiWCgEv53LdlV441LELMnxuId9Cfg","type":"credit_balance_transaction"}],
  "total":250,"amount_due":250,"amount_paid":250,
  "lines":[{"description":"750 × Anybench usage (at $0.01 / month)","amount":750,"quantity":750,"pretax_credit_amounts":[{"amount":500,…}]}],
  "payments":[{"id":"inpay_1UZKYrLELMnxuId9fQD5FOOL","status":"paid","amount_paid":250,"payment":{"payment_intent":"pi_3UZKYqLELMnxuId90ojgWK8j","type":"payment_intent"}}]}
[grant] balance after invoice {"balances":[{"available":{"monetary":{"currency":"usd","value":0}},"ledger":{"monetary":{"currency":"usd","value":0}}}],
  "transactions":[{"id":"cbtxn_test_61ViiWCgEv53LdlV441LELMnxuId9Cfg","type":"debit","debit":{"amount":{"monetary":{"value":500}},"credits_applied":{"invoice":"in_1UZKYhLELMnxuId9Qy9aGlRD",…},"type":"credits_applied"}},
                  {"id":"cbtxn_test_61ViiVGGmeZ7En3yq41LELMnxuId9BOC","type":"credit","credit":{"amount":{"monetary":{"value":500}},"type":"credits_granted"}}]}
```

**Result: $7.50 of usage, $5.00 of grant, $2.50 charged to the card.** In the new API the payment is on `invoicePayments.list({invoice})` (`payment.payment_intent`), not on `invoice.charge`. For 10.4, the credit Stripe actually applied is `invoice.total_pretax_credit_amounts[type=credit_balance_transaction]`, and the matching `billing.credit_balance_transaction.created` event carries `credits_applied.invoice`.

Every API call in this run (from `stripe.on("response")`):

```
GET  /v1/billing/meters 200 · GET /v1/products/anybench_usage 200 · GET /v1/prices 200
POST /v1/test_helpers/test_clocks 200 req_UXVYzk42Tqc3CZ
POST /v1/customers 200 req_U8SoLQqp77KFnq
POST /v1/payment_methods/pm_card_visa/attach 200 req_VP5UsI6c2jjPB9
POST /v1/customers/cus_VaVZFQiQWKtvXl 200 req_MApINj4fCf5NNr          (invoice_settings.default_payment_method)
POST /v1/billing/credit_grants 200 req_jM1nwhEiVoUtN5
POST /v1/subscriptions 200 req_w2oNEAgPXYA1rF
POST /v1/billing/meter_events 200 ×4 (req_jYJynadObAWue3, req_BogX0v0xR8QFaL, req_OkvB7n7oFuh7iN, req_brrhexElDJBzdM)
POST /v1/billing/meter_events 400 ×2 (req_yE7zeALOgEqvYk, req_CQYVzkr2bb2VUP)   ← dedupe
GET  /v1/billing/meters/mtr_test_…/event_summaries 200 ×5                      ← polling until 750
POST /v1/invoices/create_preview 200 req_j9o5xj8U85OeAI
POST /v1/test_helpers/test_clocks/clock_…/advance 200 req_qoJXU47r896GSQ  + GET clock ×4
GET  /v1/invoices 200 req_8cgShk5kF6ZSMY
POST /v1/test_helpers/test_clocks/clock_…/advance 200 req_Kg7nNYNiynlRIQ  + GET clock ×3
GET  /v1/invoices 200 req_qjJyCabRNQBNMm
GET  /v1/invoice_payments 200 req_aaQ1TeW4yfx7j5
GET  /v1/billing/credit_balance_summary 200 req_7e6rkyc1YswNpS
GET  /v1/billing/credit_balance_transactions 200 req_jpFmRTyS9XTTBH
GET  /v1/events 200 req_lQKeH4f0BgZ7eP
```

## 4. Usage thresholds with meters: `scenario-threshold.ts`

This uses a fresh clock and customer. The threshold is 500¢ ($5; production uses `USAGE_INVOICE_THRESHOLD_MICRO_USD` = $50), with 600¢ of usage.

```
$ node --env-file=../anybench/.env scripts/spikes/stripe/scenario-threshold.ts
[thresholds] billing_thresholds attempts {"on_create":{"accepted":true,"billing_thresholds":{"amount_gte":500,"reset_billing_cycle_anchor":false},"billing_mode":{"type":"flexible",…}}}
[alert] create {"accepted":true,"id":"alrt_test_61ViiXy2qNzXgWbYn41LELMnxuId9F3Q","status":"active"}
[meter] usage aggregated {"cents":600}
[observe] 90 s real time after usage aggregated []
[clock] advance +1 h            ready after 4s
[observe] clock +1 h []
[clock] advance +1 day          ready after 16s
[observe] clock +1 day [{"id":"in_1UZKd0LELMnxuId9nbttgeVq","billing_reason":"subscription_threshold","status":"paid","subtotal":600,"amount_due":600}]
```

The threshold invoice in detail:

```
{"id":"in_1UZKd0LELMnxuId9nbttgeVq","reason":"subscription_threshold","created":1794103686 (clock +1 h),"finalized_at":1794107286 (+1 h later),"paid_at":1794107286,
 "period":[1794100086,1794103686],"subtotal":600,"amount_paid":600,"lines":[[600,{"start":1794100080,"end":1794103680}]]}
```

- `billing_thresholds.amount_gte` **is accepted and works with a meter-backed price** in the default `flexible` billing mode. Stripe does not evaluate it instantly. Nothing appeared after 90 s of real time or after the jump to +1 h. During the next clock jump, Stripe created the invoice stamped at the +1 h mark, then finalized and charged it 1 h later. Expect up to about 2 h in production before the threshold invoice is charged.
- With `reset_billing_cycle_anchor: false`, the threshold invoice covers usage up to that point, and the monthly invoice bills only what comes after.
- **So thresholds limit debt; they are not a cap.** The run gate (10.6) must keep enforcing `NEW_ACCOUNT_SPEND_LIMIT_MICRO_USD` and the daily cap from our own ledger. Stripe's threshold only makes sure the money is collected.
- **The billing alert is the fast signal.** `billing.alerts.create({alert_type: "usage_threshold", usage_threshold: {gte: 500, meter, recurrence: "one_time", filters: [{type: "customer", customer}]}})` fired `billing.alert.triggered` about 45 s after the usage (real time, no clock move). Alerts are per meter and customer, and the script archives its alert at the end. We probably don't need alerts, because our ledger knows the spend first, but they are a cheap reconciliation cross-check for 10.10.
- Our own early invoice (the fallback) is not needed. For the record: `subscriptions.update(sub, {billing_cycle_anchor: {type: "now"}, proration_behavior: "none"})` is accepted. In this API version the anchor is an object, not the string `"now"`. Here it produced a $0 `subscription_update` invoice, because the threshold invoice had already billed the usage.

Threshold event sequence (seconds after start, real time): `customer.subscription.created` +4, **`billing.alert.triggered` +51**, then during the clock jumps `invoice.created` +153, `payment_intent.succeeded`/`charge.succeeded` +162, `invoice.paid`/`invoice.updated`/`invoice.payment_succeeded`/`invoice.finalized`/`payment_intent.created` +163.

## 5. Webhook sequence (`stripe listen`)

```
$ STRIPE_API_KEY="$(grep '^STRIPE_TEST_SECRET_KEY=' .env | cut -d= -f2-)" stripe listen --skip-update --format JSON \
    | sed -E 's/whsec_[A-Za-z0-9]+/whsec_REDACTED/g' > stripe-listen.log
Ready! You are using Stripe API Version [2026-10-28.endive]. Your webhook signing secret is whsec_REDACTED (^C to quit)
```

(The key reaches the CLI through the environment, never through argv, and the signing secret is redacted in the log.) Here are the 62 events captured across all runs, filtered to the grant scenario's customer and clock (`created` is real time):

```
1794099921 test_helpers.test_clock.created
1794099921 customer.created
1794099922 payment_method.attached
1794099922 customer.updated
1794099923 billing.credit_grant.created                 credgr_test_61ViiVGU…
1794099923 customer.updated
1794099923 customer.subscription.created               sub_1UZKXu…
1794099923 setup_intent.created
1794099923 billing.credit_balance_transaction.created   (credits_granted)
1794099923 setup_intent.succeeded
1794099965 test_helpers.test_clock.advancing            ← period end
1794099970 invoice.upcoming
1794099972 invoice.created                              in_1UZKYh… (draft)
1794099972 customer.subscription.updated                (new period)
1794099975 test_helpers.test_clock.ready
1794099978 test_helpers.test_clock.advancing            ← +3 h: auto-finalize
1794099981 billing.credit_balance_transaction.created   (credits_applied → in_1UZKYh…)
1794099982 payment_intent.succeeded
1794099982 charge.succeeded
1794099983 payment_intent.created                       ← arrives AFTER succeeded
1794099983 invoice.updated
1794099983 invoice.finalized
1794099983 invoice.paid
1794099983 invoice.payment_succeeded
1794099985 test_helpers.test_clock.ready
```

What the handler (10.4) must do:

1. **Don't assume order.** Insert into `stripe_events` first (idempotency), then fetch the current object from the API (`invoices.retrieve`, `subscriptions.retrieve`) and update state from it, rather than applying event payloads in sequence.
2. Add `billing.credit_balance_transaction.created` to the endpoint's event list. It is the exact record of credit applied to each invoice, and the ledger comment in `packages/billing/src/ledger.ts` already asks 10.4 for "the credit Stripe actually applied". Also consider `invoice.created` (the draft, 1 h before charge) and `billing.alert.triggered` if alerts are used. The `.env.example` list does not have these yet.
3. `checkout.session.completed` can arrive before or after `customer.subscription.created` (same second in this run). Resolve both through the subscription id.

## Notes and recommendations for E10

- **Stripe's skill recommends Metronome** for new usage-based billing. Plan.md section 8 chose Billing Meters + credit grants, and this spike shows that path covers everything section 8 needs: a single meter, pay-as-you-go, promotional grants, a threshold and Checkout. Metronome would add contracts and commits, which we don't need. Keep Billing Meters.
- **Use a sandbox per environment.** The key is already a sandbox ("anybench sandbox"). Give CI its own sandbox so test clocks and customers don't pile up in the dev one. Each test clock deletes itself after 30 days (`deletes_after`).
- **Tax.** No `automatic_tax` is set. Before taking money for real (10.11), decide on Stripe Tax. It needs an active registration, or Stripe collects nothing while the setting looks on.
- **Grants on threshold invoices are untested.** A grant applies to invoices finalized while it has balance. The ledger's rule (`packages/billing/src/ledger.ts` header) already handles the case where a later grant does not cover an already-finalized threshold invoice.
- **Restricted key.** See the env table above.

## Files

- `scripts/spikes/stripe/lib.ts`: test-key guard (zod), client, call log, clock helper.
- `scripts/spikes/stripe/setup.ts`: idempotent meter/product/price (`ensureBillingCatalog`). **10.2 reuses this.**
- `scripts/spikes/stripe/scenario-grant.ts`: test clock, $7.50 usage vs $5 grant, dedupe, invoice, grant ledger, events.
- `scripts/spikes/stripe/scenario-threshold.ts`: `billing_thresholds`, billing alert, anchor reset.
- `scripts/spikes/stripe/checkout.ts`: `create` / `inspect` for the Checkout link-card flow.
- Evidence JSON for this run (outside the repo): `scenario-grant-ymrpkxqm.json`, `scenario-threshold-obosw7bv.json`, `checkout-create-9eyy0g2q.json`, `checkout-inspect-hsyDSclB.json`, `setup.json`.
