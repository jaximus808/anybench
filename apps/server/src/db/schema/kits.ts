import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { KIT_ORIGINS } from "./_enums.js";
import { createdAt, idPk, inList } from "./_shared.js";
import { runs } from "./runs.js";
import { users } from "./users.js";

/**
 * A versioned eval kit for a run. RLS: owner only (owner_id mirrors runs.owner_id).
 *
 * TDM-217 [19.1]: an `uploaded` kit (POST /kits/uploads/:id/complete) is owned by the uploader and
 * has no run (`run_id` null) until a run is created from it; `upload_id` makes completing the
 * same upload twice return the same row. Every other origin keeps a run.
 */
export const kits = pgTable(
  "kits",
  {
    id: idPk(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Null only for an uploaded kit no run uses yet (kits_run_unless_uploaded_check). */
    runId: uuid("run_id").references((): AnyPgColumn => runs.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    /** Parsed anybench.yaml (packages/kit). */
    spec: jsonb("spec").notNull(),
    /**
     * Where the kit's files are: a `file://` directory on the worker host (generated, curated),
     * or `artifact:<key>` in the artifact store (uploaded: envs kitFilesKey, a .tar.gz).
     */
    filesUrl: text("files_url"),
    /** Proof check results. */
    proof: jsonb("proof"),
    hash: text("hash").notNull(),
    origin: text("origin", { enum: KIT_ORIGINS }).notNull().default("generated"),
    /** The kit upload this row was created from (POST /kits/uploads); null for every other kit. */
    uploadId: uuid("upload_id"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("kits_run_version_uq").on(t.runId, t.version),
    unique("kits_upload_id_uq").on(t.uploadId),
    index("kits_owner_id_idx").on(t.ownerId),
    check("kits_origin_check", inList(t.origin, KIT_ORIGINS)),
    check("kits_run_unless_uploaded_check", sql`"run_id" IS NOT NULL OR "origin" = 'uploaded'`),
    check("kits_upload_id_uploaded_check", sql`"upload_id" IS NULL OR "origin" = 'uploaded'`),
  ],
);
