// Billing routes (plan.md section 8): link a card (Checkout subscription with the metered price),
// the billing portal, the usage summary, and the Stripe webhook. Tickets 10.3, 10.4, 10.9.
// The 402 the run gate returns is PaymentRequiredSchema (common.ts), declared on `runs.go`.
import { z } from "zod";
import { CreditGrantIdSchema, RunIdSchema, TrialIdSchema, UsageEntryIdSchema } from "../ids.js";
import { MicroUsdSchema, NonNegativeMicroUsdSchema } from "../money.js";
import {
  FreeRunRefusalReasonSchema,
  IsoDateTimeSchema,
  PageQuerySchema,
  csvListSchema,
  pageOf,
} from "./common.js";
import { defineRoute, defineRoutes } from "./route.js";
import { RunKitOriginSchema } from "./runs.js";

export const PAYMENT_STATUSES = ["none", "ok", "past_due", "blocked"] as const;
export const PaymentStatusSchema = z.enum(PAYMENT_STATUSES);
/** Cost-plus (plan.md section 8): one `run_fee` per billable run, one `compute` per eval computer. */
export const USAGE_TYPES = [
  "run_fee",
  "compute",
  "managed_tokens",
  "adjustment",
  "refund",
] as const;
export const UsageTypeSchema = z.enum(USAGE_TYPES);
export const CREDIT_GRANT_CATEGORIES = ["promotional", "paid"] as const;
export const CreditGrantCategorySchema = z.enum(CREDIT_GRANT_CATEGORIES);

export const BillingAccountSchema = z.object({
  payment_status: PaymentStatusSchema,
  has_payment_method: z.boolean(),
  /** Usage not yet invoiced. */
  unbilled_micro_usd: NonNegativeMicroUsdSchema,
  /** Credit grants left; spent before the card. */
  granted_remaining_micro_usd: NonNegativeMicroUsdSchema,
  /** NEW_ACCOUNT_SPEND_LIMIT_MICRO_USD until the first paid invoice. */
  spend_limit_micro_usd: NonNegativeMicroUsdSchema,
  daily_cap_micro_usd: NonNegativeMicroUsdSchema.nullable(),
  /** Invoice early when unbilled usage reaches this (USAGE_INVOICE_THRESHOLD_MICRO_USD). */
  invoice_threshold_micro_usd: NonNegativeMicroUsdSchema,
});
export type BillingAccount = z.infer<typeof BillingAccountSchema>;

export const UsageEntrySchema = z.object({
  id: UsageEntryIdSchema,
  run_id: RunIdSchema.nullable(),
  trial_id: TrialIdSchema.nullable(),
  type: UsageTypeSchema,
  /** Negative for refunds and adjustments. */
  amount_micro_usd: MicroUsdSchema,
  /** Comped usage is recorded but never sent to Stripe. */
  comped: z.boolean(),
  reported_at: IsoDateTimeSchema.nullable(),
  created_at: IsoDateTimeSchema,
});
export type UsageEntry = z.infer<typeof UsageEntrySchema>;

export const CreditGrantSchema = z.object({
  id: CreditGrantIdSchema,
  amount_micro_usd: NonNegativeMicroUsdSchema,
  remaining_micro_usd: NonNegativeMicroUsdSchema,
  category: CreditGrantCategorySchema,
  /** `free_run`: covers a free starter run's own charges (TDM-223); never sent to Stripe. */
  source: z.enum(["signup", "admin", "free_run"]),
  reason: z.string().nullable(),
  expires_at: IsoDateTimeSchema.nullable(),
  created_at: IsoDateTimeSchema,
});
export type CreditGrant = z.infer<typeof CreditGrantSchema>;

export const InvoiceSummarySchema = z.object({
  id: z.string().min(1),
  status: z.enum(["draft", "open", "paid", "uncollectible", "void"]),
  total_micro_usd: MicroUsdSchema,
  credit_applied_micro_usd: NonNegativeMicroUsdSchema,
  period_start: IsoDateTimeSchema,
  period_end: IsoDateTimeSchema,
  hosted_invoice_url: z.url().nullable(),
});

/**
 * The account's free starter run (E20, TDM-224), for onboarding and the billing page:
 *   available     the account still has it and the pool is open: Go needs no card for a starter run
 *   in_use        it is held by a run that has not finished (`run_id`)
 *   used          the account used it (`run_id`)
 *   not_eligible  the account never gets one (`reason`: no GitHub account age, account too new)
 *   paused        the account has it, but the pool cannot fund a run right now (`reason`
 *                 pool_exhausted, or pool_off when free runs are switched off)
 */
export const FREE_RUN_STATUSES = ["available", "in_use", "used", "not_eligible", "paused"] as const;
export const FreeRunStatusSchema = z.object({
  status: z.enum(FREE_RUN_STATUSES),
  reason: FreeRunRefusalReasonSchema.nullable(),
  /** One plain sentence about it. */
  message: z.string().min(1),
  run_id: RunIdSchema.nullable(),
  /** A BYOK model key (Anthropic or OpenAI) is stored: a free run needs one. */
  has_model_key: z.boolean(),
  limits: z.object({
    max_setups: z.int().positive(),
    max_trials: z.int().nonnegative(),
    /** Compute at our cost (FREE_RUN_CAP_MICRO_USD). */
    compute_cap_micro_usd: NonNegativeMicroUsdSchema,
  }),
});
export type FreeRunStatus = z.infer<typeof FreeRunStatusSchema>;

export const BillingSummarySchema = z.object({
  account: BillingAccountSchema,
  period: z.object({
    start: IsoDateTimeSchema,
    end: IsoDateTimeSchema,
    usage_micro_usd: MicroUsdSchema,
  }),
  grants: z.array(CreditGrantSchema),
  invoices: z.array(InvoiceSummarySchema),
  mode: z.enum(["off", "test", "live"]),
  /** TDM-224: the free starter run. Optional so an older server still parses. */
  free_run: FreeRunStatusSchema.optional(),
});
export type BillingSummary = z.infer<typeof BillingSummarySchema>;

/**
 * TDM-226: GET /billing/free-pool, public. Whether free starter runs are open right now. Only the
 * state: never the pool's dollars, nor how many runs are left (packages/billing poolStatusFrom).
 */
export const FREE_POOL_STATES = ["open", "paused"] as const;
export const PublicFreePoolSchema = z.strictObject({ state: z.enum(FREE_POOL_STATES) });
export type PublicFreePool = z.infer<typeof PublicFreePoolSchema>;

/** One worked example on the pricing page: a fixed kit priced by estimateRunCost. */
export const PricingExampleSchema = z.object({
  id: z.enum(["starter", "head_to_head"]),
  title: z.string().min(1),
  /** One sentence: what the example kit compares. */
  summary: z.string().min(1),
  kit_origin: RunKitOriginSchema,
  /** Setups (contenders x their `vary` values), workloads and measured repeats of the kit. */
  setups: z.int().positive(),
  workloads: z.int().positive(),
  repeats: z.int().positive(),
  /** Whose model tokens the contenders spend: the user's own key, or Anybench's (managed). */
  tokens: z.enum(["own_key", "managed"]),
  /** The free starter run covers it (isStarterRun on the same estimate, an account with a key). */
  free: z.boolean(),
  run_fee_micro_usd: NonNegativeMicroUsdSchema,
  compute: z.object({
    computers: z.int().nonnegative(),
    /** Trials, warm-ups included. */
    trials: z.int().nonnegative(),
    blocks: z.int().nonnegative(),
    block_seconds: z.int().positive(),
    /** Each trial is priced at this length (its time cap unless the kit says otherwise). */
    est_trial_seconds: z.int().positive(),
    /** At the billed price: per computer, cost + COMPUTE_MARKUP_BPS, rounded down. */
    charge_micro_usd: NonNegativeMicroUsdSchema,
  }),
  /** run fee + computer time, before model tokens. What the run costs when it is not free. */
  total_micro_usd: NonNegativeMicroUsdSchema,
});
export type PricingExample = z.infer<typeof PricingExampleSchema>;

/**
 * TDM-226: GET /billing/pricing, public. Every number the pricing page shows, from the server's
 * billing config (RUN_FEE_MICRO_USD, COMPUTE_MARKUP_BPS, MANAGED_TOKEN_MARKUP_BPS, FREE_RUN_*)
 * and packages/billing's estimate functions, so the page cannot drift from what is billed.
 */
export const PublicPricingSchema = z.object({
  rates: z.object({
    /** RUN_FEE_MICRO_USD: per benchmark run whose kit our agents designed. */
    run_fee_micro_usd: NonNegativeMicroUsdSchema,
    /** UPLOADED_KIT_RUN_FEE_MICRO_USD: per run from a kit you uploaded. */
    uploaded_kit_run_fee_micro_usd: NonNegativeMicroUsdSchema,
    /** COMPUTE_MARKUP_BPS: computer time at our cost + this. */
    compute_markup_bps: z.int().nonnegative(),
    /** MANAGED_TOKEN_MARKUP_BPS: Anybench's model tokens at our cost + this. */
    managed_token_markup_bps: z.int().nonnegative(),
    /** Computer time is billed in blocks of this many seconds. */
    block_seconds: z.int().positive(),
    /** The standard eval computer and what one block of it costs. */
    machine: z.object({
      vcpu: z.int().positive(),
      memory_gb: z.int().positive(),
      /** What one block costs us (Naïve). */
      block_cost_micro_usd: NonNegativeMicroUsdSchema,
      /** What one block costs you: cost + COMPUTE_MARKUP_BPS. */
      block_charge_micro_usd: NonNegativeMicroUsdSchema,
    }),
  }),
  /** The free starter run's limits (FREE_RUN_MAX_TRIALS, FREE_RUN_CAP_MICRO_USD). */
  free_run: z.object({
    /** False when free runs are switched off (FREE_RUN_POOL_MICRO_USD=0). */
    offered: z.boolean(),
    max_setups: z.int().positive(),
    max_trials: z.int().nonnegative(),
    /** Computer time a free run covers, at our cost. */
    compute_cap_micro_usd: NonNegativeMicroUsdSchema,
    min_github_age_days: z.int().nonnegative(),
  }),
  examples: z.array(PricingExampleSchema),
});
export type PublicPricing = z.infer<typeof PublicPricingSchema>;

/** Where Stripe sends the browser back to; must be on the web origin (checked by the server). */
const ReturnPathSchema = z
  .string()
  .max(2048)
  .refine((s) => s.startsWith("/") && !s.startsWith("//"), { message: "must be a relative path" });

export const billingRoutes = defineRoutes({
  freePool: defineRoute({
    id: "billing.freePool",
    method: "GET",
    path: "/billing/free-pool",
    auth: ["public"],
    summary: "Whether free starter runs are open or paused (never amounts). Cacheable for 60 s.",
    response: PublicFreePoolSchema,
  }),
  pricing: defineRoute({
    id: "billing.pricing",
    method: "GET",
    path: "/billing/pricing",
    auth: ["public"],
    summary: "Rates, free-run limits and two worked examples, from the billing config. 60 s cache.",
    response: PublicPricingSchema,
  }),
  summary: defineRoute({
    id: "billing.summary",
    method: "GET",
    path: "/billing/summary",
    auth: ["session"],
    summary: "Billing account, this period's usage, grants and recent invoices.",
    response: BillingSummarySchema,
  }),
  usage: defineRoute({
    id: "billing.usage",
    method: "GET",
    path: "/billing/usage",
    auth: ["session"],
    summary: "Usage ledger entries, newest first.",
    query: PageQuerySchema.extend({
      run_id: RunIdSchema.optional(),
      type: csvListSchema(UsageTypeSchema).optional(),
    }),
    response: pageOf(UsageEntrySchema),
  }),
  linkCard: defineRoute({
    id: "billing.linkCard",
    method: "POST",
    path: "/billing/link-card",
    auth: ["session"],
    summary: "Checkout Session (mode subscription, metered STRIPE_PRICE_USAGE, no upfront charge).",
    body: z.object({
      success_path: ReturnPathSchema.default("/billing?linked=1"),
      cancel_path: ReturnPathSchema.default("/billing"),
    }),
    response: z.object({ url: z.url() }),
  }),
  portal: defineRoute({
    id: "billing.portal",
    method: "POST",
    path: "/billing/portal",
    auth: ["session"],
    summary: "Stripe billing portal for cards, invoices and receipts.",
    body: z.object({ return_path: ReturnPathSchema.default("/billing") }),
    response: z.object({ url: z.url() }),
  }),
  stripeWebhook: defineRoute({
    id: "billing.stripeWebhook",
    method: "POST",
    path: "/webhooks/stripe",
    auth: ["webhook"],
    summary:
      "Stripe events: raw body, signature verified, stripe_events insert first (idempotent).",
    headers: z.object({ "stripe-signature": z.string().min(1) }),
    rawBody: true,
    body: z.string(),
    response: z.object({ received: z.literal(true), duplicate: z.boolean() }),
  }),
});
