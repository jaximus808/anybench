// Drizzle implementation of the @anybench/envs ComputerStore port (TDM-31): the `computers` table.
// The registry writes through this before and after every provider create/destroy. Worker-only
// (system actor): `computers` carries no owner_id and no RLS.
import type { ComputerRecord, ComputerRecordPatch, ComputerStore } from "@anybench/envs";
import { and, eq } from "drizzle-orm";
import type { Database, DbTx } from "../db/client.js";
import { computers } from "../db/schema/computers.js";

type Row = typeof computers.$inferSelect;

function toRecord(r: Row): ComputerRecord {
  return {
    id: r.id,
    provider: r.provider,
    providerId: r.providerId,
    runId: r.runId,
    trialId: r.trialId,
    snapshotId: r.snapshotId,
    status: r.status,
    createdAt: r.createdAt,
    destroyedAt: r.destroyedAt,
    blocksBilled: r.blocksBilled,
    costMicroUsd: r.costMicroUsd,
    lastSeenAt: r.lastSeenAt,
  };
}

export function drizzleComputerStore(db: Database | DbTx): ComputerStore {
  return {
    async insert(row) {
      await db.insert(computers).values(row);
    },
    async update(id, patch: ComputerRecordPatch) {
      if (Object.keys(patch).length === 0) return;
      const res = await db
        .update(computers)
        .set(patch)
        .where(eq(computers.id, id))
        .returning({ id: computers.id });
      if (res.length === 0) throw new Error(`computers row ${id} not found`);
    },
    async get(id) {
      const [r] = await db.select().from(computers).where(eq(computers.id, id));
      return r ? toRecord(r) : null;
    },
    async findByProviderId(provider, providerId) {
      const [r] = await db
        .select()
        .from(computers)
        .where(and(eq(computers.provider, provider), eq(computers.providerId, providerId)));
      return r ? toRecord(r) : null;
    },
  };
}
