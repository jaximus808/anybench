import { sql } from "drizzle-orm";
import { index, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, idPk, tstz } from "./_shared.js";
import { users } from "./users.js";

/** Scoped API keys (`ab_live_` / `ab_test_`), sha256-hashed, shown once. */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: idPk(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    hash: text("hash").notNull().unique(),
    scopes: text("scopes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** NULL = every run the owner has; otherwise the key only sees these runs. */
    runIds: uuid("run_ids").array(),
    expiresAt: tstz("expires_at"),
    lastUsedAt: tstz("last_used_at"),
    revokedAt: tstz("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [index("api_keys_owner_id_idx").on(t.ownerId)],
);
