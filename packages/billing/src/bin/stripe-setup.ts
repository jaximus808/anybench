// `pnpm billing:setup` (TDM-88): create or find the usage meter, product and metered price in the
// mode BILLING_MODE names, then print the ids for .env. Idempotent; safe to run any time.
//
// Env: BILLING_MODE (test by default) and STRIPE_SECRET_KEY or STRIPE_<MODE>_SECRET_KEY. A key that
// does not match the mode is refused before any request. The key is never printed.
// Exit: 0 = catalog ready and .env matches (or ids unset; copy the printed lines),
//       1 = refused or failed, 2 = .env holds ids that differ from Stripe's (update .env).
import { redact } from "@anybench/core";
import { runStripeSetup } from "../setup.js";
import { createBillingStripe, resolveStripeConfig, StripeModeError } from "../stripe.js";

try {
  const client = createBillingStripe(resolveStripeConfig(process.env));
  const { stale } = await runStripeSetup(client);
  process.exitCode = stale.length > 0 ? 2 : 0;
} catch (err) {
  const message =
    err instanceof StripeModeError
      ? `refusing to run: ${err.message}`
      : `failed: ${err instanceof Error ? err.message : String(err)}`;
  // Belt and braces: Stripe masks keys in its own errors, and redact() catches any that slip in.
  console.error(
    redact(`[billing:setup] ${message}`, {
      STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
      STRIPE_TEST_SECRET_KEY: process.env.STRIPE_TEST_SECRET_KEY,
      STRIPE_LIVE_SECRET_KEY: process.env.STRIPE_LIVE_SECRET_KEY,
    }),
  );
  process.exitCode = 1;
}
