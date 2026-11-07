import { boolean, check, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { ALERT_SCOPES, ALERT_SEVERITIES } from "./_enums.js";
import { createdAt, inList, updatedAt } from "./_shared.js";

/** Alert rule definitions (plan.md section 7), keyed by a stable string. */
export const alertRules = pgTable(
  "alert_rules",
  {
    key: text("key").primaryKey(),
    scope: text("scope", { enum: ALERT_SCOPES }).notNull(),
    condition: jsonb("condition").notNull(),
    severity: text("severity", { enum: ALERT_SEVERITIES }).notNull(),
    cooldownS: integer("cooldown_s").notNull().default(0),
    autoAction: text("auto_action"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("alert_rules_scope_check", inList(t.scope, ALERT_SCOPES)),
    check("alert_rules_severity_check", inList(t.severity, ALERT_SEVERITIES)),
  ],
);
