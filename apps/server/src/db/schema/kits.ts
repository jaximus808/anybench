import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { createdAt, idPk } from "./_shared.js";
import { runs } from "./runs.js";
import { users } from "./users.js";

/** A versioned eval kit for a run. RLS: owner only (owner_id mirrors runs.owner_id). */
export const kits = pgTable(
  "kits",
  {
    id: idPk(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references((): AnyPgColumn => runs.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    /** Parsed anybench.yaml (packages/kit). */
    spec: jsonb("spec").notNull(),
    filesUrl: text("files_url"),
    /** Proof check results. */
    proof: jsonb("proof"),
    hash: text("hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("kits_run_version_uq").on(t.runId, t.version),
    index("kits_owner_id_idx").on(t.ownerId),
  ],
);
