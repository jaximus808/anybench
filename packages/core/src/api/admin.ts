// Admin routes (plan.md sections 5, 6, 8). Admin = ADMIN_GITHUB_LOGINS, checked per request.
// Every grant, comp and kill switch takes a `reason` and writes an `interventions` row in the same
// transaction (a DB trigger rejects a grant or comp without one). Tickets 10.7, 10.8, 8.6, 8.10.
import { z } from "zod";
import {
  ComputerIdSchema,
  InterventionIdSchema,
  RunIdSchema,
  TrialIdSchema,
  UserIdSchema,
} from "../ids.js";
import { MicroUsdSchema, NonNegativeMicroUsdSchema } from "../money.js";
import { ComputeProviderNameSchema } from "../schemas/env.js";
import { UserSchema } from "./auth.js";
import { BillingAccountSchema, CreditGrantCategorySchema, CreditGrantSchema } from "./billing.js";
import {
  IsoDateTimeSchema,
  PageQuerySchema,
  PositiveMicroUsdSchema,
  ReasonSchema,
  pageOf,
} from "./common.js";
import { defineRoute, defineRoutes } from "./route.js";

export const InterventionSchema = z.object({
  id: InterventionIdSchema,
  run_id: RunIdSchema.nullable(),
  user_id: UserIdSchema.nullable(),
  /** The admin's github login. */
  who: z.string().min(1),
  what: z.string().min(1),
  why: z.string().min(1),
  at: IsoDateTimeSchema,
});
export type Intervention = z.infer<typeof InterventionSchema>;

export const KillSwitchSchema = z.object({
  scope: z.enum(["global", "run", "user"]),
  target_id: z.string().nullable(),
  enabled: z.boolean(),
  reason: z.string(),
  set_by: z.string(),
  at: IsoDateTimeSchema,
});

export const ComputerSchema = z.object({
  id: ComputerIdSchema,
  provider: ComputeProviderNameSchema,
  provider_id: z.string().nullable(),
  run_id: RunIdSchema.nullable(),
  trial_id: TrialIdSchema.nullable(),
  snapshot_id: z.string().nullable(),
  status: z.enum(["creating", "running", "destroying", "destroyed", "leaked", "error"]),
  blocks_billed: z.int().nonnegative(),
  cost_micro_usd: NonNegativeMicroUsdSchema,
  created_at: IsoDateTimeSchema,
  destroyed_at: IsoDateTimeSchema.nullable(),
  last_seen_at: IsoDateTimeSchema.nullable(),
});
export type Computer = z.infer<typeof ComputerSchema>;

export const GrantBodySchema = z.object({
  amount_micro_usd: PositiveMicroUsdSchema,
  reason: ReasonSchema,
  category: CreditGrantCategorySchema.default("promotional"),
  expires_at: IsoDateTimeSchema.optional(),
});

export const CompBodySchema = z.object({ reason: ReasonSchema });

export const KillBodySchema = z
  .object({
    scope: z.enum(["global", "run", "user"]),
    /** The run or user id; omitted for `global`. */
    target_id: z.uuid().optional(),
    enabled: z.boolean(),
    reason: ReasonSchema,
  })
  .refine((b) => (b.scope === "global") === (b.target_id === undefined), {
    message: "target_id is required for run and user scope, and not allowed for global",
    path: ["target_id"],
  });

export const adminRoutes = defineRoutes({
  users: defineRoute({
    id: "admin.users",
    method: "GET",
    path: "/admin/users",
    auth: ["admin"],
    summary: "Users with their billing account.",
    query: PageQuerySchema.extend({ q: z.string().trim().min(1).max(100).optional() }),
    response: pageOf(z.object({ user: UserSchema, billing: BillingAccountSchema.nullable() })),
  }),
  grant: defineRoute({
    id: "admin.grant",
    method: "POST",
    path: "/admin/users/:id/grant",
    auth: ["admin"],
    summary: "Grant credit: a Stripe credit grant + credit_grants row + interventions row.",
    params: z.object({ id: UserIdSchema }),
    body: GrantBodySchema,
    status: 201,
    response: z.object({ grant: CreditGrantSchema, intervention: InterventionSchema }),
  }),
  comp: defineRoute({
    id: "admin.comp",
    method: "POST",
    path: "/admin/runs/:id/comp",
    auth: ["admin"],
    summary: "Comp a run: its usage is recorded with comped_by and never sent to Stripe.",
    params: z.object({ id: RunIdSchema }),
    body: CompBodySchema,
    response: z.object({
      run_id: RunIdSchema,
      comped_by: z.string().min(1),
      comped_reason: z.string().min(1),
      intervention: InterventionSchema,
    }),
  }),
  kill: defineRoute({
    id: "admin.kill",
    method: "POST",
    path: "/admin/kill",
    auth: ["admin"],
    summary: "Set or clear a kill switch (global, run or user).",
    body: KillBodySchema,
    response: z.object({ kill_switch: KillSwitchSchema, intervention: InterventionSchema }),
  }),
  interventions: defineRoute({
    id: "admin.interventions",
    method: "GET",
    path: "/admin/interventions",
    auth: ["admin"],
    summary: "Every admin intervention, newest first.",
    query: PageQuerySchema,
    response: pageOf(InterventionSchema),
  }),
  costs: defineRoute({
    id: "admin.costs",
    method: "GET",
    path: "/admin/costs",
    auth: ["admin"],
    summary: "Per-run billed vs cost and margin, plus the Naïve balance (/admin/costs).",
    query: PageQuerySchema.extend({
      from: IsoDateTimeSchema.optional(),
      to: IsoDateTimeSchema.optional(),
    }),
    response: z.object({
      runs: pageOf(
        z.object({
          run_id: RunIdSchema,
          billed_micro_usd: MicroUsdSchema,
          cost_micro_usd: MicroUsdSchema,
          margin_micro_usd: MicroUsdSchema,
          comped: z.boolean(),
        }),
      ),
      naive: z.object({
        balance_micro_usd: MicroUsdSchema,
        spend_micro_usd: NonNegativeMicroUsdSchema,
        checked_at: IsoDateTimeSchema,
      }),
    }),
  }),
  computer: defineRoute({
    id: "admin.computer",
    method: "GET",
    path: "/admin/computers/:id",
    auth: ["admin"],
    summary: "One eval computer: status, owning trial, cost (drill-down 3).",
    params: z.object({ id: ComputerIdSchema }),
    response: z.object({ computer: ComputerSchema }),
  }),
  inspectComputer: defineRoute({
    id: "admin.inspectComputer",
    method: "POST",
    path: "/admin/computers/:id/inspect",
    auth: ["admin"],
    summary: "Run the read-only inspect probe on a computer.",
    params: z.object({ id: ComputerIdSchema }),
    response: z.object({ output: z.string(), at: IsoDateTimeSchema }),
  }),
});
