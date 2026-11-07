// Invite links (plan.md section 3, ticket 15.7): `/i/<token>` shows a lead the free pre-built kit;
// after GitHub sign-in and a linked card they claim it as their own run.
import { z } from "zod";
import { KitIdSchema, LeadIdSchema, RunIdSchema } from "../ids.js";
import { IsoDateTimeSchema } from "./common.js";
import { KitSummarySchema } from "./kits.js";
import { defineRoute, defineRoutes } from "./route.js";

/** Opaque, URL-safe; stored only as a hash (`invites.token_hash`). */
export const InviteTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{24,128}$/);

export const InviteSchema = z.object({
  company: z.string().nullable(),
  kit: KitSummarySchema.nullable(),
  /** The insights brief: what they'd be compared against, what we'd measure. */
  brief: z.string().nullable(),
  status: z.enum(["open", "claimed", "expired"]),
  expires_at: IsoDateTimeSchema,
});

const tokenParams = z.object({ token: InviteTokenSchema });

export const inviteRoutes = defineRoutes({
  get: defineRoute({
    id: "invites.get",
    method: "GET",
    path: "/invites/:token",
    auth: ["public"],
    summary: "The invite landing page data. Records the first click.",
    params: tokenParams,
    response: z.object({ invite: InviteSchema }),
  }),
  claim: defineRoute({
    id: "invites.claim",
    method: "POST",
    path: "/invites/:token/claim",
    auth: ["session"],
    summary: "Claim the invite: copies the pre-built kit into a run owned by the caller.",
    params: tokenParams,
    response: z.object({ run_id: RunIdSchema }),
  }),
  create: defineRoute({
    id: "invites.create",
    method: "POST",
    path: "/admin/invites",
    auth: ["admin"],
    summary: "Mint an invite for a lead (the URL goes into the outreach email).",
    body: z.object({
      lead_id: LeadIdSchema,
      kit_id: KitIdSchema.optional(),
      expires_in_days: z.int().min(1).max(90).default(30),
    }),
    status: 201,
    response: z.object({ token: InviteTokenSchema, url: z.url(), expires_at: IsoDateTimeSchema }),
  }),
});
