import { sql } from "drizzle-orm";
import {
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, idPk, updatedAt } from "./_shared.js";
import { kits } from "./kits.js";

/** Outreach leads (E15). */
export const leads = pgTable(
  "leads",
  {
    id: idPk(),
    source: text("source").notNull(),
    query: text("query"),
    company: text("company"),
    contact: text("contact"),
    email: text("email"),
    githubUrl: text("github_url"),
    signals: jsonb("signals"),
    fit: doublePrecision("fit"),
    status: text("status").notNull().default("new"),
    /** ProjectDigest reference produced for this lead (no FK: digests live in object storage). */
    digestId: uuid("digest_id"),
    kitId: uuid("kit_id").references(() => kits.id, { onDelete: "set null" }),
    brief: jsonb("brief"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("leads_status_idx").on(t.status),
    index("leads_email_idx").on(t.email),
    // One lead per person and per repo, enforced by the DB so concurrent sourcing/import runs can't
    // both insert (and later both email) the same lead (TDM-163). Case-insensitive, NULLs allowed.
    uniqueIndex("leads_email_lower_uniq")
      .on(sql`lower(${t.email})`)
      .where(sql`${t.email} is not null`),
    uniqueIndex("leads_github_url_lower_uniq")
      .on(sql`lower(${t.githubUrl})`)
      .where(sql`${t.githubUrl} is not null`),
  ],
);
