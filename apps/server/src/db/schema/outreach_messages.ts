import { check, index, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { OUTREACH_MESSAGE_KINDS, OUTREACH_MESSAGE_STATUSES } from "./_enums.js";
import { createdAt, idPk, inList, tstz } from "./_shared.js";
import { leads } from "./leads.js";

export const outreachMessages = pgTable(
  "outreach_messages",
  {
    id: idPk(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: OUTREACH_MESSAGE_KINDS }).notNull(),
    subject: text("subject"),
    html: text("html"),
    text: text("text"),
    status: text("status", { enum: OUTREACH_MESSAGE_STATUSES }).notNull().default("draft"),
    agentmailMessageId: text("agentmail_message_id").unique(),
    approvedBy: text("approved_by"),
    sentAt: tstz("sent_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("outreach_messages_lead_id_idx").on(t.leadId),
    check("outreach_messages_kind_check", inList(t.kind, OUTREACH_MESSAGE_KINDS)),
    check("outreach_messages_status_check", inList(t.status, OUTREACH_MESSAGE_STATUSES)),
  ],
);
