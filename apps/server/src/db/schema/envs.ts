import { jsonb, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { tstz } from "./_shared.js";

/** Snapshot cache: one built environment per EnvSpec hash and provider. */
export const envs = pgTable(
  "envs",
  {
    specHash: text("spec_hash").notNull(),
    profile: text("profile").notNull(),
    provider: text("provider").notNull(),
    snapshotId: text("snapshot_id"),
    builtAt: tstz("built_at"),
    expiresAt: tstz("expires_at"),
    health: jsonb("health"),
  },
  (t) => [primaryKey({ name: "envs_pk", columns: [t.specHash, t.provider] })],
);
