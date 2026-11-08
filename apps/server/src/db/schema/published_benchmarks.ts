import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { PUBLISH_VISIBILITIES } from "./_enums.js";
import { createdAt, idPk, inList, tstz, updatedAt } from "./_shared.js";
import { runs } from "./runs.js";
import { users } from "./users.js";

export const publishedBenchmarks = pgTable(
  "published_benchmarks",
  {
    id: idPk(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    slug: text("slug").notNull().unique(),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    visibility: text("visibility", { enum: PUBLISH_VISIBILITIES }).notNull().default("unlisted"),
    pinnedVersion: integer("pinned_version"),
    autoPublish: boolean("auto_publish").notNull().default(false),
    /** Set when the owner withdraws it (visibility 'withdrawn'); cleared on publish again. */
    withdrawnAt: tstz("withdrawn_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("published_benchmarks_owner_id_idx").on(t.ownerId),
    // One publication per run (publish again = a new version under the same slug).
    uniqueIndex("published_benchmarks_run_id_uq")
      .on(t.runId)
      .where(sql`${t.runId} is not null`),
    check("published_benchmarks_visibility_check", inList(t.visibility, PUBLISH_VISIBILITIES)),
  ],
);
