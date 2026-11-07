import { sql } from "drizzle-orm";
import { boolean, check, index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { ALERT_CHANNEL_KINDS, ALERT_SEVERITIES } from "./_enums.js";
import { createdAt, idPk, inList } from "./_shared.js";
import { users } from "./users.js";

/** Where alerts go. owner_id NULL = the founder/platform channel. */
export const alertChannels = pgTable(
  "alert_channels",
  {
    id: idPk(),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ALERT_CHANNEL_KINDS }).notNull(),
    /** Kind-specific settings (email address, Slack webhook URL, Tandem canvas). */
    config: jsonb("config")
      .notNull()
      .default(sql`'{}'::jsonb`),
    minSeverity: text("min_severity", { enum: ALERT_SEVERITIES }).notNull().default("warn"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    index("alert_channels_owner_id_idx").on(t.ownerId),
    check("alert_channels_kind_check", inList(t.kind, ALERT_CHANNEL_KINDS)),
    check("alert_channels_min_severity_check", inList(t.minSeverity, ALERT_SEVERITIES)),
  ],
);
