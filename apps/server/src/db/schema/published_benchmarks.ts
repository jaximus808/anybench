import { boolean, check, index, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { PUBLISH_VISIBILITIES } from "./_enums.js";
import { createdAt, idPk, inList, updatedAt } from "./_shared.js";
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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("published_benchmarks_owner_id_idx").on(t.ownerId),
    check("published_benchmarks_visibility_check", inList(t.visibility, PUBLISH_VISIBILITIES)),
  ],
);
