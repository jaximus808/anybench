import { sql } from "drizzle-orm";
import { check, integer, pgTable, text } from "drizzle-orm/pg-core";
import { tstz } from "./_shared.js";

/**
 * worker-hardening: the provider-outage circuit breaker, one row per compute provider, shared by
 * every job and worker process (lib/provider-breaker.ts; transitions in packages/bench
 * breaker.ts). Not tenant data (no RLS).
 */
export const providerBreakers = pgTable(
  "provider_breakers",
  {
    provider: text("provider").primaryKey(),
    status: text("status", { enum: ["closed", "open"] })
      .notNull()
      .default("closed"),
    failures: integer("failures").notNull().default(0),
    windowStartedAt: tstz("window_started_at"),
    openedAt: tstz("opened_at"),
    nextProbeAt: tstz("next_probe_at"),
    lastError: text("last_error"),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [check("provider_breakers_status_check", sql`${t.status} in ('closed', 'open')`)],
);
