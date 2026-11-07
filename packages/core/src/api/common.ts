// Shared API schemas: errors, pagination, timestamps, query helpers (TDM-10).
import { z } from "zod";
import { NonNegativeMicroUsdSchema } from "../money.js";

/** ISO 8601 timestamp with an offset (`2026-11-07T21:00:00Z`). Timestamps stay strings on both sides. */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

/** A lowercase UUID string, for ids that have no branded `<Entity>IdSchema` in ids.ts. */
export function uuidSchema<const B extends string>() {
  return z
    .string()
    .transform((s) => s.toLowerCase())
    .pipe(z.uuid())
    .brand<B>();
}

/** Positive micro-USD (budgets, grants). Decimal string on the wire, bigint in memory. */
export const PositiveMicroUsdSchema = NonNegativeMicroUsdSchema.refine((v) => v > 0n, {
  message: "micro-USD amount must be > 0",
});

/** Why a mutating admin or ops action happened. Required on grants, comps and kill switches. */
export const ReasonSchema = z.string().trim().min(3, { error: "a reason is required" }).max(2000);

// ---------------------------------------------------------------------------------------------
// Errors

export const API_ERROR_CODES = [
  "bad_request",
  "validation_failed",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "payment_required",
  "rate_limited",
  "unsupported_media_type",
  "internal",
  "unavailable",
  "not_implemented",
] as const;
export const ApiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

/** The body of every error response (except statuses a route lists in `errors`). */
export const ApiErrorBodySchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    message: z.string(),
    /** `path: message` lines (formatSchemaIssues) for validation failures. */
    issues: z.array(z.string()).optional(),
    request_id: z.string().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;

export const API_ERROR_STATUS: Readonly<Record<ApiErrorCode, number>> = {
  bad_request: 400,
  validation_failed: 400,
  unauthorized: 401,
  payment_required: 402,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unsupported_media_type: 415,
  rate_limited: 429,
  internal: 500,
  not_implemented: 501,
  unavailable: 503,
};

export function apiError(
  code: ApiErrorCode,
  message: string,
  extra: { issues?: string[]; request_id?: string } = {},
): ApiErrorBody {
  return { error: { code, message, ...extra } };
}

/**
 * The run gate's 402 (plan.md section 8): the run waits in `awaiting_go` and resumes when the
 * Stripe webhook lands. `link_card_url` opens Checkout (or the billing page).
 */
export const PAYMENT_REQUIRED_REASONS = [
  "no_payment_method",
  "insufficient_credit",
  "payment_past_due",
  "account_blocked",
  "spend_limit",
  "daily_cap",
] as const;
export const PaymentRequiredReasonSchema = z.enum(PAYMENT_REQUIRED_REASONS);
export const PaymentRequiredSchema = z.object({
  reason: PaymentRequiredReasonSchema,
  link_card_url: z.url(),
});
export type PaymentRequired = z.infer<typeof PaymentRequiredSchema>;

// ---------------------------------------------------------------------------------------------
// Pagination (opaque cursors; events page by seq instead, see events.ts)

export const PAGE_LIMIT_DEFAULT = 50;
export const PAGE_LIMIT_MAX = 200;

export const PageQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
});

export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), next_cursor: z.string().nullable() });
}

// ---------------------------------------------------------------------------------------------
// Query helpers

/** `a,b,c` in a query string, or an array from a typed caller; yields a de-duplicated array. */
export function csvListSchema<T extends z.ZodType<string, string>>(item: T) {
  return z
    .union([z.array(z.string()), z.string()])
    .transform((v) => [...new Set((Array.isArray(v) ? v : v.split(",")).map((s) => s.trim()))])
    .pipe(z.array(item).min(1));
}

/** `true` / `false` in a query string, or a boolean from a typed caller. */
export const QueryBooleanSchema = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((v) => v === true || v === "true" || v === "1");

/** `{ok: true}` for actions with nothing else to say. */
export const OkSchema = z.object({ ok: z.literal(true) });

/** A presigned or redirect URL with its expiry. */
export const SignedUrlSchema = z.object({ url: z.url(), expires_at: IsoDateTimeSchema });

/** Documented body of a 302 (the real response has only a `Location` header). */
export const RedirectSchema = z.object({ location: z.url() });
