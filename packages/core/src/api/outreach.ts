// Outreach (plan.md section 3, E15): leads, the founder's draft approval queue, the funnel, the
// AgentMail webhook and the CAN-SPAM unsubscribe. Admin only except unsubscribe and the webhook.
import { z } from "zod";
import { KitIdSchema, LeadIdSchema } from "../ids.js";
import {
  IsoDateTimeSchema,
  OkSchema,
  PageQuerySchema,
  ReasonSchema,
  csvListSchema,
  pageOf,
  uuidSchema,
} from "./common.js";
import { defineRoute, defineRoutes } from "./route.js";

export const OutreachMessageIdSchema = uuidSchema<"OutreachMessageId">();

export const LEAD_STATUSES = [
  "new",
  "scored",
  /** The scout scored it below OUTREACH_FIT_THRESHOLD, or found no verifiable claim (TDM-164). */
  "skipped",
  "kit_ready",
  "drafted",
  "emailed",
  "clicked",
  "signed_in",
  "card_linked",
  "run_started",
  "delivered",
  "published",
  "replied",
  "unsubscribed",
  "disqualified",
] as const;
export const LeadStatusSchema = z.enum(LEAD_STATUSES);

export const LeadSchema = z.object({
  id: LeadIdSchema,
  source: z.string().min(1),
  company: z.string().nullable(),
  contact: z.string().nullable(),
  email: z.email().nullable(),
  github_url: z.url().nullable(),
  /** Scout fit score 0–100. */
  fit: z.int().min(0).max(100).nullable(),
  status: LeadStatusSchema,
  kit_id: KitIdSchema.nullable(),
  brief: z.string().nullable(),
  created_at: IsoDateTimeSchema,
});
export type Lead = z.infer<typeof LeadSchema>;

export const OutreachMessageSchema = z.object({
  id: OutreachMessageIdSchema,
  lead_id: LeadIdSchema,
  kind: z.enum(["initial", "followup", "reply"]),
  subject: z.string(),
  html: z.string(),
  text: z.string(),
  status: z.enum(["draft", "approved", "rejected", "sent", "bounced", "replied"]),
  approved_by: z.string().nullable(),
  sent_at: IsoDateTimeSchema.nullable(),
  created_at: IsoDateTimeSchema,
});
export type OutreachMessage = z.infer<typeof OutreachMessageSchema>;

const messageParams = z.object({ id: OutreachMessageIdSchema });

export const outreachRoutes = defineRoutes({
  leads: defineRoute({
    id: "outreach.leads",
    method: "GET",
    path: "/admin/leads",
    auth: ["admin"],
    summary: "Leads by status, best fit first.",
    query: PageQuerySchema.extend({ status: csvListSchema(LeadStatusSchema).optional() }),
    response: pageOf(LeadSchema),
  }),
  lead: defineRoute({
    id: "outreach.lead",
    method: "GET",
    path: "/admin/leads/:id",
    auth: ["admin"],
    summary: "One lead with its messages.",
    params: z.object({ id: LeadIdSchema }),
    response: z.object({ lead: LeadSchema, messages: z.array(OutreachMessageSchema) }),
  }),
  drafts: defineRoute({
    id: "outreach.drafts",
    method: "GET",
    path: "/admin/outreach/messages",
    auth: ["admin"],
    summary: "The draft approval queue (and other messages by status).",
    query: PageQuerySchema.extend({
      status: csvListSchema(OutreachMessageSchema.shape.status).default(["draft"]),
    }),
    response: pageOf(OutreachMessageSchema),
  }),
  approve: defineRoute({
    id: "outreach.approve",
    method: "POST",
    path: "/admin/outreach/messages/:id/approve",
    auth: ["admin"],
    summary: "Approve a draft (optionally edited); it is sent within the daily limit.",
    params: messageParams,
    body: z.object({
      subject: z.string().min(1).max(200).optional(),
      html: z.string().min(1).optional(),
      text: z.string().min(1).optional(),
    }),
    response: z.object({ message: OutreachMessageSchema }),
  }),
  reject: defineRoute({
    id: "outreach.reject",
    method: "POST",
    path: "/admin/outreach/messages/:id/reject",
    auth: ["admin"],
    summary: "Reject a draft.",
    params: messageParams,
    body: z.object({ reason: ReasonSchema }),
    response: z.object({ message: OutreachMessageSchema }),
  }),
  funnel: defineRoute({
    id: "outreach.funnel",
    method: "GET",
    path: "/admin/outreach/funnel",
    auth: ["admin"],
    summary: "Lead counts per funnel stage.",
    query: z.object({ from: IsoDateTimeSchema.optional(), to: IsoDateTimeSchema.optional() }),
    response: z.object({ stages: z.record(LeadStatusSchema, z.int().nonnegative()) }),
  }),
  agentmailWebhook: defineRoute({
    id: "outreach.agentmailWebhook",
    method: "POST",
    path: "/webhooks/agentmail",
    auth: ["webhook"],
    summary: "AgentMail deliveries: replies, bounces, complaints.",
    rawBody: true,
    body: z.string(),
    response: OkSchema,
  }),
  unsubscribe: defineRoute({
    id: "outreach.unsubscribe",
    method: "POST",
    path: "/outreach/unsubscribe",
    auth: ["public"],
    summary: "CAN-SPAM unsubscribe from the link in every email; adds to the suppression list.",
    body: z.object({ token: z.string().min(16).max(512) }),
    response: OkSchema,
  }),
});
