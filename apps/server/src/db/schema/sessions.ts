import { index, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, idPk, tstz } from "./_shared.js";
import { users } from "./users.js";

/** Browser sessions: the opaque cookie token is stored only as a hash. */
export const sessions = pgTable(
  "sessions",
  {
    id: idPk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    userAgent: text("user_agent"),
    ip: text("ip"),
    createdAt: createdAt(),
    expiresAt: tstz("expires_at").notNull(),
    lastSeenAt: tstz("last_seen_at"),
    revokedAt: tstz("revoked_at"),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);
