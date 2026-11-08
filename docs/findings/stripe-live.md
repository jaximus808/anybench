# Stripe live cutover (plan.md 10.11)

Tooling: `scripts/ops/stripe-go-live.ts` (catalog + live webhook + .env + test-state reset), the API
and worker deploy plans accept `BILLING_MODE=live` and map `STRIPE_LIVE_*` onto the app's `STRIPE_*`.

## Dry run, 2026-11-08 (live key pasted by the founder; no writes)

```
$ pnpm tsx scripts/ops/stripe-go-live.ts --dry-run
[stripe:go-live] account acct_1UZHbeLfMYcJTYF4 charges_enabled=false payouts_enabled=false details_submitted=true
[stripe:go-live] WARNING: charges are not enabled: finish account activation in the Stripe Dashboard
[stripe:go-live] catalog: meter mtr_61ViylW0GzlmGRuJZ41LfMYcJTYF4PaK price price_1UZaoBLfMYcJTYF4KTXDKnpJ
[stripe:go-live] webhook would be created at https://anybench.vercel.app/api/webhooks/stripe (16 events)
[stripe:go-live] database: unchanged (not flipping to live on this run)
```

- The live meter and price already exist (created earlier); the script finds them, it does not duplicate.
- The account has submitted details but **cannot take charges yet** (`charges_enabled=false`). Live
  Checkout would fail for every user, so the script keeps `BILLING_MODE=test` (exit 3) until Stripe
  enables charges; `--allow-inactive-account` overrides.
- The flip to live clears test-mode Stripe state in the database (1 account holds a test customer on
  the dev branch): a test card must never pass the live run gate.
