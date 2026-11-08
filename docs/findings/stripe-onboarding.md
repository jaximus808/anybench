# Link a card, then Go: Stripe test-mode check (stripe-onboarding, 2026-11-07)

This checks the real `StripeBillingPort` (`packages/billing/src/stripe-ops.ts`) against the founder's Stripe **test-mode** sandbox. No live key was used and nothing was charged. The script printed ids only, never a key.

```
node --env-file=<repo>/.env <scratchpad>/link-card.ts create
{"mode":"test","keyFrom":"STRIPE_TEST_SECRET_KEY","priceFrom":"STRIPE_TEST_PRICE_USAGE",
 "userId":"onboarding-evidence-k0hfoqst","customerId":"cus_VaaWFYQCx3jbWt","sameCustomerOnRetry":true,
 "before":{"subscriptionId":null,"paymentStatus":"none","hasPaymentMethod":false},
 "session":"cs_test_a1wyzGHBa3TmMzkOxE0dNCr3zWgnZ7yfSvjt353Bo2tLGbcl8EbZLTZHBf","url":"https://checkout.stripe.com/c/pay/cs_test_…"}
```

- `ensureCustomer` twice with the same user id returned the **same** Customer, because of the idempotency key `anybench-customer-<user_id>`.
- Checkout (mode `subscription`, the metered usage price) showed **"$0.00 due today, then $0.01 per unit, billed monthly based on usage"**. It offered Card, Cash App Pay, Klarna and Bank.
- I completed it in a headless browser (gstack `browse`) with 4242 4242 4242 4242, 12/34, 123, 94107. Playwright's `click` timed out on Stripe's accordion and Subscribe button. Dispatching pointer and mouse events through `js` worked. It then redirected to `success_url`. The web app was not served at that host locally, so the page showed `chrome-error://`, which is expected.

```
node --env-file=<repo>/.env <scratchpad>/link-card.ts cus_VaaWFYQCx3jbWt
{"customer":"cus_VaaWFYQCx3jbWt","after":{"subscriptionId":"sub_1UZPMwLELMnxuId9O20Z501H","paymentStatus":"ok","hasPaymentMethod":true}}
```

So `accountState` reads the card from `subscription.default_payment_method` and returns `ok`. The run gate allows Go on exactly that.

## Notes for operators

- Checkout says "per **unit**" because the product has no `unit_label`. `pnpm billing:setup` (TDM-88 `ensureProduct`) sets it to "usage cent" (Stripe caps `unit_label` at 12 characters; "cent of usage" was rejected in live). Run it once in test mode.
- Webhook endpoint: `POST <api>/webhooks/stripe`. The server re-reads the account from Stripe on `checkout.session.completed`, `customer.subscription.*`, `payment_method.*` and `invoice.paid|payment_failed|payment_action_required`. Every other event type is only recorded in `stripe_events`. The billing page also re-syncs while the account has a Customer but no recorded card. A late webhook therefore never strands a user.
- The meter reporter (`billing.report`, every 60 s on the worker) treats Stripe's HTTP 400 `An event already exists with identifier` as already reported (TDM-21).
