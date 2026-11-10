// Drizzle implementation of the @anybench/envs ComputerStore port (TDM-31): the `computers` table.
// The registry writes through this before and after every provider create/destroy. Worker-only
// (system actor): `computers` carries no owner_id and no RLS.
import type {
  ComputerPricing,
  ComputerRecord,
  ComputerRecordPatch,
  ComputerStore,
} from "@anybench/envs";
import {
  NAIVE_PROVIDER_NAME,
  naiveBlockPriceMicroUsd,
  type ComputeProvider,
} from "@anybench/providers";
import { and, eq } from "drizzle-orm";
import type { Database, DbTx } from "../db/client.js";
import { computers } from "../db/schema/computers.js";

type Row = typeof computers.$inferSelect;

/**
 * TDM-252: the registry's pricing for `provider`. A Naïve computer costs a block at Naïve's rate
 * card for its size (8,400 per vCPU + 2,700 per GiB: 2 vCPU / 4 GiB = 27,600, 4 vCPU / 8 GiB =
 * 55,200), the price Naïve debits; `flat` (COMPUTER_BLOCK_PRICE_MICRO_USD) is the price of any
 * other provider's block and of a row written before the size was priced.
 */
export function computerPricing(
  provider: Pick<ComputeProvider, "name">,
  flat: bigint,
): ComputerPricing {
  return provider.name === NAIVE_PROVIDER_NAME
    ? { pricePerBlockMicroUsd: flat, blockPriceFor: naiveBlockPriceMicroUsd }
    : { pricePerBlockMicroUsd: flat };
}

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
    pricePerBlockMicroUsd: r.pricePerBlockMicroUsd,
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
