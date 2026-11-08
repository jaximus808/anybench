import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, idPk, inList, microUsdZero, tstz, updatedAt } from "./_shared.js";
import { users } from "./users.js";

export const SCAN_STATUSES = ["queued", "running", "done", "failed"] as const;

/**
 * A GitHub scan request (TDM-67, contract core apiRoutes.scan). The API stores the request; the
 * understander ([6.2], scan UI [11.7]) fills `repos` with one verdict per repo later.
 * RLS: owner only.
 */
export const scans = pgTable(
  "scans",
  {
    id: idPk(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    githubOwner: text("github_owner").notNull(),
    status: text("status", { enum: SCAN_STATUSES }).notNull().default("queued"),
    /** `owner/repo` names the caller asked for; NULL = list the owner's public repos. */
    requestedRepos: jsonb("requested_repos"),
    maxRepos: integer("max_repos").notNull().default(20),
    /** core ScanRepo[]: one row per repo, filled in by the understander. */
    repos: jsonb("repos")
      .notNull()
      .default(sql`'[]'::jsonb`),
    costMicroUsd: microUsdZero("cost_micro_usd"),
    finishedAt: tstz("finished_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("scans_owner_id_idx").on(t.ownerId),
    check("scans_status_check", inList(t.status, SCAN_STATUSES)),
    check("scans_cost_nonneg", sql`${t.costMicroUsd} >= 0`),
  ],
);
