import { integer, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, idPk } from "./_shared.js";
import { publishedBenchmarks } from "./published_benchmarks.js";

/** Immutable, signed versions of a published benchmark. */
export const publishVersions = pgTable(
  "publish_versions",
  {
    id: idPk(),
    benchmarkId: uuid("benchmark_id")
      .notNull()
      .references(() => publishedBenchmarks.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    reportJson: jsonb("report_json").notNull(),
    attestation: jsonb("attestation").notNull(),
    signature: text("signature").notNull(),
    keyId: text("key_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique("publish_versions_benchmark_version_uq").on(t.benchmarkId, t.version)],
);
