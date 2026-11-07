import { check, date, integer, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { EMBED_VIEW_KINDS } from "./_enums.js";
import { inList } from "./_shared.js";
import { publishedBenchmarks } from "./published_benchmarks.js";

/** Daily view counters for badges, embeds and public pages. referrer_host '' = none. */
export const embedViews = pgTable(
  "embed_views",
  {
    benchmarkId: uuid("benchmark_id")
      .notNull()
      .references(() => publishedBenchmarks.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: EMBED_VIEW_KINDS }).notNull(),
    referrerHost: text("referrer_host").notNull().default(""),
    day: date("day", { mode: "string" }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [
    primaryKey({
      name: "embed_views_pk",
      columns: [t.benchmarkId, t.kind, t.referrerHost, t.day],
    }),
    check("embed_views_kind_check", inList(t.kind, EMBED_VIEW_KINDS)),
  ],
);
