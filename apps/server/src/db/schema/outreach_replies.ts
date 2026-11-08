import { sql } from "drizzle-orm";
import { boolean, check, index, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { OUTREACH_REPLY_CATEGORIES, OUTREACH_REPLY_CLASSIFIERS } from "./_enums.js";
import { createdAt, idPk, inList, microUsdZero, tstz } from "./_shared.js";
import { leads } from "./leads.js";
import { outreachMessages } from "./outreach_messages.js";

/**
 * Inbound mail polled from our AgentMail inbox (TDM-167 [15.8a]), one row per AgentMail message,
 * classified. Nothing here is ever sent: a reply that needs an answer gets `needs_founder`.
 * `lead_id`/`message_id` are null when the sender matched no lead (still recorded, so it is
 * classified once and an unsubscribe from any address is honoured).
 */
export const outreachReplies = pgTable(
  "outreach_replies",
  {
    id: idPk(),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
    /** The outbound outreach_messages row this answers (matched by In-Reply-To/References). */
    messageId: uuid("message_id").references(() => outreachMessages.id, { onDelete: "set null" }),
    agentmailMessageId: text("agentmail_message_id").notNull().unique(),
    threadId: text("thread_id").notNull(),
    /** Bare sender address, lowercased. */
    fromEmail: text("from_email").notNull(),
    subject: text("subject"),
    /** The new text of the reply (quoted history stripped), truncated. */
    text: text("text"),
    receivedAt: tstz("received_at").notNull(),
    category: text("category", { enum: OUTREACH_REPLY_CATEGORIES }).notNull(),
    classifiedBy: text("classified_by", { enum: OUTREACH_REPLY_CLASSIFIERS }).notNull(),
    reason: text("reason"),
    /** The address this reply put on the suppression list, if any. */
    suppressedEmail: text("suppressed_email"),
    needsFounder: boolean("needs_founder").notNull().default(false),
    handledAt: tstz("handled_at"),
    /** Naïve spend on classifying this reply (0 for rules). */
    costMicroUsd: microUsdZero("cost_micro_usd"),
    createdAt: createdAt(),
  },
  (t) => [
    index("outreach_replies_lead_id_idx").on(t.leadId),
    index("outreach_replies_received_at_idx").on(t.receivedAt),
    index("outreach_replies_needs_founder_idx")
      .on(t.needsFounder)
      .where(sql`${t.needsFounder} and ${t.handledAt} is null`),
    check("outreach_replies_category_check", inList(t.category, OUTREACH_REPLY_CATEGORIES)),
    check(
      "outreach_replies_classified_by_check",
      inList(t.classifiedBy, OUTREACH_REPLY_CLASSIFIERS),
    ),
  ],
);
