import { sql } from "drizzle-orm";
import { check, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { KILL_SWITCH_SCOPES } from "./_enums.js";
import { idPk, inList, tstz } from "./_shared.js";

/** Kill switches, checked at every phase boundary and heartbeat. Active while cleared_at IS NULL. */
export const killSwitches = pgTable(
  "kill_switches",
  {
    id: idPk(),
    scope: text("scope", { enum: KILL_SWITCH_SCOPES }).notNull(),
    /** NULL for global; the run or user id otherwise. */
    scopeId: text("scope_id"),
    reason: text("reason").notNull(),
    setBy: text("set_by").notNull(),
    setAt: tstz("set_at").notNull().defaultNow(),
    clearedAt: tstz("cleared_at"),
  },
  (t) => [
    uniqueIndex("kill_switches_active_uq")
      .on(t.scope, sql`coalesce(${t.scopeId}, '')`)
      .where(sql`${t.clearedAt} is null`),
    check("kill_switches_scope_check", inList(t.scope, KILL_SWITCH_SCOPES)),
    check("kill_switches_scope_id_check", sql`(${t.scope} = 'global') = (${t.scopeId} is null)`),
  ],
);
