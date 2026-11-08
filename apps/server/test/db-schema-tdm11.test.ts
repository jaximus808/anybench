// TDM-11: schema shape checks that need no database.
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "../src/db/schema/index.js";

const PLAN_TABLES = [
  // identity
  "users",
  "sessions",
  "api_keys",
  "user_secrets",
  // benchmarks
  "projects",
  "runs",
  "kits",
  "contenders",
  "envs",
  "trials",
  "reviews",
  "reports",
  "bottlenecks",
  "scans", // TDM-67: GitHub scan requests (contract apiRoutes.scan)
  // agents
  "agent_sessions",
  "agent_events",
  // compute
  "computers",
  // observability and alerts
  "events",
  "alert_rules",
  "alerts",
  "alert_channels",
  "alert_deliveries",
  "kill_switches",
  "webhook_inbox",
  "worker_heartbeats", // TDM-14: worker liveness for /health/worker
  "provider_breakers", // worker-hardening: the shared provider-outage circuit breaker
  // billing
  "billing_accounts",
  "usage_entries",
  "credit_grants",
  "stripe_events",
  "cost_entries",
  // publish
  "published_benchmarks",
  "publish_versions",
  "embed_views",
  // company
  "interventions",
  // outreach
  "leads",
  "outreach_messages",
  "outreach_replies", // TDM-167: polled inbound replies, classified
  "invites",
  "suppressions",
];

const tables: PgTable[] = (Object.values(schema) as unknown[]).filter((v): v is PgTable =>
  is(v, PgTable),
);

describe("db schema (TDM-11)", () => {
  it("defines every table in plan.md section 10, and nothing else", () => {
    expect(tables.map((t) => getTableName(t)).sort()).toEqual([...PLAN_TABLES].sort());
  });

  it("stores every money column as bigint with a bigint TS type (never a float)", () => {
    const money = tables.flatMap((t) =>
      Object.values(getTableColumns(t))
        .filter((c) => c.name.endsWith("_micro_usd"))
        .map((c) => ({
          col: `${getTableName(t)}.${c.name}`,
          type: c.columnType,
          sql: c.getSQLType(),
        })),
    );
    expect(money.length).toBeGreaterThanOrEqual(14);
    for (const m of money) expect(m, m.col).toMatchObject({ type: "PgBigInt64", sql: "bigint" });
  });

  it("gives every RLS tenant table an owner_id", () => {
    for (const name of ["runs", "kits", "trials", "reviews", "reports", "events", "user_secrets"]) {
      const t = tables.find((x) => getTableName(x) === name)!;
      expect(
        Object.values(getTableColumns(t)).map((c) => c.name),
        name,
      ).toContain("owner_id");
    }
  });
});
