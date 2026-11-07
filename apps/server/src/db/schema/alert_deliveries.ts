import { check, integer, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { ALERT_DELIVERY_STATUSES } from "./_enums.js";
import { createdAt, idPk, inList, tstz } from "./_shared.js";
import { alertChannels } from "./alert_channels.js";
import { alerts } from "./alerts.js";

/** One delivery of one alert to one channel, with retry state. */
export const alertDeliveries = pgTable(
  "alert_deliveries",
  {
    id: idPk(),
    alertId: uuid("alert_id")
      .notNull()
      .references(() => alerts.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => alertChannels.id, { onDelete: "cascade" }),
    status: text("status", { enum: ALERT_DELIVERY_STATUSES }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: tstz("next_attempt_at"),
    sentAt: tstz("sent_at"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("alert_deliveries_alert_channel_uq").on(t.alertId, t.channelId),
    check("alert_deliveries_status_check", inList(t.status, ALERT_DELIVERY_STATUSES)),
  ],
);
