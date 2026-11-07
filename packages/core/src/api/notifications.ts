// Notification channels and preferences (plan.md section 7, ticket 9.5): where alerts and
// run-finished notices go. In-app is always on and is not a channel row.
import { z } from "zod";
import { AlertSeveritySchema } from "./alerts.js";
import { IsoDateTimeSchema, OkSchema, uuidSchema } from "./common.js";
import { defineRoute, defineRoutes } from "./route.js";

export const AlertChannelIdSchema = uuidSchema<"AlertChannelId">();

const ChannelTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("email"), email: z.email() }),
  /** Slack incoming webhook. Stored encrypted; only the host is ever returned. */
  z.object({
    kind: z.literal("slack"),
    webhook_url: z.url({ protocol: /^https$/, hostname: /^hooks\.slack\.com$/ }),
  }),
]);

export const AlertChannelSchema = z.object({
  id: AlertChannelIdSchema,
  kind: z.enum(["email", "slack"]),
  /** `you@example.com`, or `hooks.slack.com/…/abcd` (redacted). */
  display: z.string(),
  min_severity: AlertSeveritySchema,
  run_finished: z.boolean(),
  verified: z.boolean(),
  created_at: IsoDateTimeSchema,
});
export type AlertChannel = z.infer<typeof AlertChannelSchema>;

export const NotificationPreferencesSchema = z.object({
  /** "Send results to Email and Slack" when a run is delivered or fails. */
  run_finished: z.boolean(),
  /** In-app alerts at or above this severity also go to every channel. */
  alert_min_severity: AlertSeveritySchema,
});

const channelParams = z.object({ id: AlertChannelIdSchema });

export const notificationRoutes = defineRoutes({
  channels: defineRoute({
    id: "notifications.channels",
    method: "GET",
    path: "/notifications/channels",
    auth: ["session"],
    summary: "The caller's email and Slack channels.",
    response: z.object({ items: z.array(AlertChannelSchema) }),
  }),
  addChannel: defineRoute({
    id: "notifications.addChannel",
    method: "POST",
    path: "/notifications/channels",
    auth: ["session"],
    summary: "Add an email or Slack channel.",
    body: z.object({
      target: ChannelTargetSchema,
      min_severity: AlertSeveritySchema.default("warn"),
      run_finished: z.boolean().default(true),
    }),
    status: 201,
    response: z.object({ channel: AlertChannelSchema }),
  }),
  deleteChannel: defineRoute({
    id: "notifications.deleteChannel",
    method: "DELETE",
    path: "/notifications/channels/:id",
    auth: ["session"],
    summary: "Remove a channel.",
    params: channelParams,
    response: OkSchema,
  }),
  testChannel: defineRoute({
    id: "notifications.testChannel",
    method: "POST",
    path: "/notifications/channels/:id/test",
    auth: ["session"],
    summary: "Send a test notice through a channel.",
    params: channelParams,
    response: z.object({ delivered: z.boolean(), error: z.string().nullable() }),
  }),
  preferences: defineRoute({
    id: "notifications.preferences",
    method: "GET",
    path: "/notifications/preferences",
    auth: ["session"],
    summary: "The caller's notification preferences.",
    response: z.object({ preferences: NotificationPreferencesSchema }),
  }),
  updatePreferences: defineRoute({
    id: "notifications.updatePreferences",
    method: "PUT",
    path: "/notifications/preferences",
    auth: ["session"],
    summary: "Replace the caller's notification preferences.",
    body: NotificationPreferencesSchema,
    response: z.object({ preferences: NotificationPreferencesSchema }),
  }),
});
