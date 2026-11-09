import { sql } from "drizzle-orm";
import { check, pgTable, text } from "drizzle-orm/pg-core";
import { microUsdZero, updatedAt } from "./_shared.js";

/**
 * The global free-starter-run pool (TDM-223, E20), one row (`id = 'global'`). Its size is config
 * (FREE_RUN_POOL_MICRO_USD), never stored, so raising it needs no migration; the row only holds
 * what is out: `reserved` (starter estimates of runs past Go, at our cost) and `spent` (what settled
 * free runs actually cost us). Go reserves with one conditional UPDATE
 * (`reserved + spent + estimate <= pool`), so concurrent presses can never oversubscribe it.
 * packages/billing free-run.ts owns every write. Not tenant data (no RLS).
 */
export const freeRunPool = pgTable(
  "free_run_pool",
  {
    id: text("id").primaryKey().default("global"),
    reservedMicroUsd: microUsdZero("reserved_micro_usd"),
    spentMicroUsd: microUsdZero("spent_micro_usd"),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("free_run_pool_singleton", sql`${t.id} = 'global'`),
    check("free_run_pool_reserved_nonneg", sql`${t.reservedMicroUsd} >= 0`),
    check("free_run_pool_spent_nonneg", sql`${t.spentMicroUsd} >= 0`),
  ],
);
