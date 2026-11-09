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

/** Where Stripe sends the browser back to; must be on the web origin (checked by the server). */
const ReturnPathSchema = z
  .string()
  .max(2048)
  .refine((s) => s.startsWith("/") && !s.startsWith("//"), { message: "must be a relative path" });

export const billingRoutes = defineRoutes({
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
