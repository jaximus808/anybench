import { integer, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, idPk, tstz, updatedAt } from "./_shared.js";
import { users } from "./users.js";

/**
 * BYOK model keys, envelope-encrypted (AES-256-GCM, per-secret DEK wrapped by ANYBENCH_KEK).
 * Binary values are base64 text. RLS: owner only.
 */
export const userSecrets = pgTable(
  "user_secrets",
  {
    id: idPk(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    tag: text("tag").notNull(),
    wrappedDek: text("wrapped_dek").notNull(),
    kekVersion: integer("kek_version").notNull(),
    last4: text("last4").notNull(),
    lastUsedAt: tstz("last_used_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("user_secrets_owner_provider_uq").on(t.ownerId, t.provider)],
);
