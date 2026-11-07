import { bigserial, integer, jsonb, pgTable, text, unique } from "drizzle-orm/pg-core";
import { tstz } from "./_shared.js";

/** Idempotent inbox for inbound webhooks (Naïve, AgentMail, ...): insert first, process after. */
export const webhookInbox = pgTable(
  "webhook_inbox",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    receivedAt: tstz("received_at").notNull().defaultNow(),
    processedAt: tstz("processed_at"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    payload: jsonb("payload").notNull(),
  },
  (t) => [unique("webhook_inbox_provider_event_uq").on(t.provider, t.eventId)],
);
