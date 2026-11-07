import {
  check,
  index,
  integer,
  pgTable,
  text,
  unique,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { COMPUTER_STATUSES } from "./_enums.js";
import { idPk, inList, microUsdZero, tstz } from "./_shared.js";
import { runs } from "./runs.js";
import { trials } from "./trials.js";

/** Every eval computer we create, so the reaper can find leaks. */
export const computers = pgTable(
  "computers",
  {
    id: idPk(),
    provider: text("provider").notNull(),
    /** The provider's own id; NULL until the create call returns. */
    providerId: text("provider_id"),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    trialId: uuid("trial_id").references((): AnyPgColumn => trials.id, { onDelete: "set null" }),
    snapshotId: text("snapshot_id"),
    status: text("status", { enum: COMPUTER_STATUSES }).notNull().default("creating"),
    createdAt: tstz("created_at").notNull().defaultNow(),
    destroyedAt: tstz("destroyed_at"),
    blocksBilled: integer("blocks_billed").notNull().default(0),
    costMicroUsd: microUsdZero("cost_micro_usd"),
    lastSeenAt: tstz("last_seen_at"),
  },
  (t) => [
    unique("computers_provider_id_uq").on(t.provider, t.providerId),
    index("computers_status_idx").on(t.status),
    check("computers_status_check", inList(t.status, COMPUTER_STATUSES)),
  ],
);
