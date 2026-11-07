import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { ALERT_SEVERITIES, ALERT_STATUSES } from "./_enums.js";
import { idPk, inList, tstz } from "./_shared.js";
import { alertRules } from "./alert_rules.js";
import { runs } from "./runs.js";
import { users } from "./users.js";

/** Fired alerts. Deduped by fingerprint (rule_key + scope_id) while not resolved. */
export const alerts = pgTable(
  "alerts",
  {
    id: idPk(),
    ruleKey: text("rule_key")
      .notNull()
      .references(() => alertRules.key),
    fingerprint: text("fingerprint").notNull(),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    severity: text("severity", { enum: ALERT_SEVERITIES }).notNull(),
    status: text("status", { enum: ALERT_STATUSES }).notNull().default("open"),
    firstSeen: tstz("first_seen").notNull().defaultNow(),
    lastSeen: tstz("last_seen").notNull().defaultNow(),
    count: integer("count").notNull().default(1),
    ackedBy: text("acked_by"),
    ackedAt: tstz("acked_at"),
    resolvedAt: tstz("resolved_at"),
    payload: jsonb("payload")
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (t) => [
    uniqueIndex("alerts_fingerprint_unresolved_uq")
      .on(t.fingerprint)
      .where(sql`${t.status} <> 'resolved'`),
    index("alerts_run_id_idx").on(t.runId),
    check("alerts_severity_check", inList(t.severity, ALERT_SEVERITIES)),
    check("alerts_status_check", inList(t.status, ALERT_STATUSES)),
  ],
);
