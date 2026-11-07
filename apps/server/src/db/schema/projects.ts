import { index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, idPk } from "./_shared.js";
import { users } from "./users.js";

/** The thing being benchmarked: a GitHub repo, an upload, a binary, a Claude Code setup. */
export const projects = pgTable(
  "projects",
  {
    id: idPk(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    url: text("url"),
    /** ProjectDigest (packages/core) as produced by ingest. */
    digest: jsonb("digest"),
    kind: text("kind"),
    createdAt: createdAt(),
  },
  (t) => [index("projects_owner_id_idx").on(t.ownerId)],
);
