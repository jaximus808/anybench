// The columns of the billing tables that the ledger reads and writes (TDM-87).
//
// The real schema, migrations and triggers belong to apps/server (TDM-11,
// apps/server/src/db/schema/{billing_accounts,usage_entries,credit_grants,cost_entries,trials}.ts).
// apps/server depends on @anybench/billing, so this package cannot import that schema without a
// dependency cycle. These are partial mirrors that use the same table and column names. The ledger
// tests run against the migrated database and check every column below exists with the same type
// (test/ledger-tdm87.test.ts, "schema mirror"), so any drift fails CI. Defaults are declared only
// so the insert types know which columns may be omitted; the database applies its own.
//
// Money columns are `bigint` in mode "bigint": no money value ever becomes a JS number.
import { RUN_STATES, TRIAL_STATES } from "@anybench/core";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const microUsd = (name: string) => bigint(name, { mode: "bigint" });
const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const PAYMENT_STATUSES = ["none", "ok", "past_due", "blocked"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const USAGE_TYPES = [
  "run_fee",
  "compute",
  "managed_tokens",
  "adjustment",
  "refund",
] as const;
export type UsageType = (typeof USAGE_TYPES)[number];
export const CREDIT_GRANT_CATEGORIES = ["promotional", "paid"] as const;
export type CreditGrantCategory = (typeof CREDIT_GRANT_CATEGORIES)[number];
export const CREDIT_GRANT_SOURCES = ["signup", "admin", "free_run"] as const;
export type CreditGrantSource = (typeof CREDIT_GRANT_SOURCES)[number];
export const COST_SOURCES = ["naive", "vm", "storage", "vercel"] as const;
export const FREE_STARTER_RUN_STATES = ["reserved", "consumed", "released"] as const;
export type FreeStarterRunState = (typeof FREE_STARTER_RUN_STATES)[number];
export type CostSource = (typeof COST_SOURCES)[number];

export const billingAccounts = pgTable("billing_accounts", {
  userId: uuid("user_id").primaryKey(),
  paymentStatus: text("payment_status", { enum: PAYMENT_STATUSES }).notNull().default("none"),
  hasPaymentMethod: boolean("has_payment_method").notNull().default(false),
  unbilledMicroUsd: microUsd("unbilled_micro_usd")
    .notNull()
    .default(sql`0`),
  grantedRemainingMicroUsd: microUsd("granted_remaining_micro_usd")
    .notNull()
    .default(sql`0`),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
});

export const usageEntries = pgTable("usage_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  runId: uuid("run_id"),
  trialId: uuid("trial_id"),
  type: text("type", { enum: USAGE_TYPES }).notNull(),
  amountMicroUsd: microUsd("amount_micro_usd").notNull(),
  stripeMeterEventId: text("stripe_meter_event_id"),
  reportedAt: tstz("reported_at"),
  idempotencyKey: text("idempotency_key").notNull(),
  compedBy: text("comped_by"),
  interventionId: uuid("intervention_id"),
  createdAt: tstz("created_at").notNull().defaultNow(),
});

export const creditGrants = pgTable("credit_grants", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  stripeCreditGrantId: text("stripe_credit_grant_id"),
  amountMicroUsd: microUsd("amount_micro_usd").notNull(),
  category: text("category", { enum: CREDIT_GRANT_CATEGORIES }).notNull(),
  source: text("source", { enum: CREDIT_GRANT_SOURCES }).notNull(),
  reason: text("reason").notNull(),
  interventionId: uuid("intervention_id"),
  expiresAt: tstz("expires_at"),
  createdAt: tstz("created_at").notNull().defaultNow(),
});

export const costEntries = pgTable("cost_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  source: text("source", { enum: COST_SOURCES }).notNull(),
  runId: uuid("run_id"),
  amountMicroUsd: microUsd("amount_micro_usd").notNull(),
  ref: text("ref"),
  at: tstz("at").notNull().defaultNow(),
});

/**
 * Read-only. The ledger reads a run's trials (owner, state, computer) in the same transaction as
 * the charge (FOR SHARE), so only what the DATABASE says is billable gets billed.
 */
export const trials = pgTable("trials", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull(),
  runId: uuid("run_id").notNull(),
  state: text("state", { enum: TRIAL_STATES }).notNull(),
  /** The computer the trial runs on (packed trials share one); moves on a failed_infra retry. */
  computerId: uuid("computer_id"),
  /** The current attempt (a failed_infra retry bumps it). */
  attempt: integer("attempt").notNull().default(1),
  /** TDM-244: the attempt's Naïve proxy key (our model tokens); null = BYOK or no model. */
  proxyKeyId: text("proxy_key_id"),
  /** Which attempt that key belongs to: its spend counts only when it is the current attempt. */
  proxyKeyAttempt: integer("proxy_key_attempt"),
  /**
   * What the trial measured (apps/server orchestrator/trial-metrics.ts). The ledger reads one key:
   * `proxy_cost_micro_usd`, the current attempt's proxy key spend from Naïve's credits ledger.
   */
  metrics: jsonb("metrics"),
});

/**
 * Read-only. Comp status comes from the run (set by the admin comp action, 10.8, with its
 * interventions row), never from the caller; so does the state that decides the run fee.
 */
export const runs = pgTable("runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull(),
  state: text("state", { enum: RUN_STATES }).notNull(),
  compedBy: text("comped_by"),
  compInterventionId: uuid("comp_intervention_id"),
  /** `user` | `ours` (TDM-54, set by the cancel route and the orchestrator); null = not cancelled. */
  cancelCause: text("cancel_cause"),
  /** POST /runs' request; free-run.ts reads `kit_origin` (TDM-218) from it. */
  intake: jsonb("intake"),
  /**
   * The orchestrator's stage outputs; free-run.ts reads `cancelled_from` (TDM-243: the cancel
   * route stamps `awaiting_go` when the user cancels before Go).
   */
  stageOutputs: jsonb("stage_outputs").notNull(),
});

/**
 * Read-only. The computers registry (TDM-31) writes blocks_billed and cost_micro_usd when it
 * destroys a computer; the ledger bills that cost plus COMPUTE_MARKUP_BPS.
 */
export const computers = pgTable("computers", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id"),
  trialId: uuid("trial_id"),
  status: text("status").notNull(),
  blocksBilled: integer("blocks_billed").notNull(),
  costMicroUsd: microUsd("cost_micro_usd").notNull(),
});

/** The global free-run pool (TDM-223): one row, `global`. free-run.ts owns every write. */
export const freeRunPool = pgTable("free_run_pool", {
  id: text("id").primaryKey().default("global"),
  reservedMicroUsd: microUsd("reserved_micro_usd")
    .notNull()
    .default(sql`0`),
  spentMicroUsd: microUsd("spent_micro_usd")
    .notNull()
    .default(sql`0`),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
});

/** The free starter run entitlement, one row per Go of a free run (TDM-223). */
export const freeStarterRuns = pgTable("free_starter_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  runId: uuid("run_id").notNull(),
  state: text("state", { enum: FREE_STARTER_RUN_STATES }).notNull().default("reserved"),
  reservedMicroUsd: microUsd("reserved_micro_usd").notNull(),
  agentAllowanceMicroUsd: microUsd("agent_allowance_micro_usd")
    .notNull()
    .default(sql`0`),
  poolSpentMicroUsd: microUsd("pool_spent_micro_usd")
    .notNull()
    .default(sql`0`),
  coveredMicroUsd: microUsd("covered_micro_usd")
    .notNull()
    .default(sql`0`),
  releaseReason: text("release_reason"),
  settledAt: tstz("settled_at"),
  createdAt: tstz("created_at").notNull().defaultNow(),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
});

/** Read-only. Free-run eligibility reads the GitHub account age (TDM-223). */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  githubCreatedAt: tstz("github_created_at"),
});

/** Read-only. Which model keys (BYOK) a user has stored; never the secret itself. */
export const userSecrets = pgTable("user_secrets", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull(),
  provider: text("provider").notNull(),
});

/** Every mirrored table, for the drift test. */
export const LEDGER_TABLES = {
  billingAccounts,
  usageEntries,
  creditGrants,
  costEntries,
  trials,
  runs,
  computers,
  freeRunPool,
  freeStarterRuns,
  users,
  userSecrets,
};
