// Alert routes (plan.md section 7). The engine (9.1) fires them; the run banner, the bell and the
// MCP `list_alerts` / `ack_alert` tools read and ack them here.
import { z } from "zod";
import { AlertIdSchema, RunIdSchema, UserIdSchema } from "../ids.js";
import { IsoDateTimeSchema, PageQuerySchema, csvListSchema, pageOf } from "./common.js";
import { defineRoute, defineRoutes } from "./route.js";

export const ALERT_SEVERITIES = ["info", "warn", "critical", "page"] as const;
export const AlertSeveritySchema = z.enum(ALERT_SEVERITIES);
export const ALERT_STATUSES = ["open", "acked", "resolved"] as const;
export const AlertStatusSchema = z.enum(ALERT_STATUSES);

export const AlertSchema = z.object({
  id: AlertIdSchema,
  rule_key: z.string().min(1),
  fingerprint: z.string().min(1),
  run_id: RunIdSchema.nullable(),
  severity: AlertSeveritySchema,
  status: AlertStatusSchema,
  message: z.string(),
  first_seen: IsoDateTimeSchema,
  last_seen: IsoDateTimeSchema,
  count: z.int().positive(),
  acked_by: UserIdSchema.nullable(),
  resolved_at: IsoDateTimeSchema.nullable(),
  auto_action: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
});
export type Alert = z.infer<typeof AlertSchema>;

const alertParams = z.object({ id: AlertIdSchema });

export const alertRoutes = defineRoutes({
  list: defineRoute({
    id: "alerts.list",
    method: "GET",
    path: "/alerts",
    auth: ["session", "apiKey:runs:read"],
    summary: "Alerts the caller can see, newest last_seen first.",
    query: PageQuerySchema.extend({
      status: csvListSchema(AlertStatusSchema).optional(),
      severity: csvListSchema(AlertSeveritySchema).optional(),
      run_id: RunIdSchema.optional(),
    }),
    response: pageOf(AlertSchema),
  }),
  ack: defineRoute({
    id: "alerts.ack",
    method: "POST",
    path: "/alerts/:id/ack",
    auth: ["session", "apiKey:alerts:write"],
    summary: "Acknowledge an open alert. Idempotent.",
    params: alertParams,
    response: z.object({ alert: AlertSchema }),
  }),
  resolve: defineRoute({
    id: "alerts.resolve",
    method: "POST",
    path: "/alerts/:id/resolve",
    auth: ["session", "apiKey:alerts:write"],
    summary: "Resolve an alert by hand.",
    params: alertParams,
    body: z.object({ note: z.string().trim().max(2000).optional() }),
    response: z.object({ alert: AlertSchema }),
  }),
});
