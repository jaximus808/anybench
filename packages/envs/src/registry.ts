// Computer registry (TDM-31, plan.md P1 / section 5): wraps any ComputeProvider so every eval
// computer has a `computers` row BEFORE the provider is asked to create it, and the row is closed
// (destroyed_at, blocks_billed, cost_micro_usd) AFTER the provider confirms the destroy.
//
// - The database is an injected port (ComputerStore): envs never imports apps/server. The server
//   implements it with Drizzle in apps/server/src/lib/computer-store.ts.
// - Create order: insert row (status creating, provider_id NULL) → provider.create/fork → set
//   provider_id. A crash in between leaves a row the reaper can still match by trial tag, and a
//   computer that carries the tag, so nothing is ever unaccounted for.
// - Destroy order: status destroying → provider.destroy → status destroyed + cost. If the provider
//   call fails the row stays `destroying` and the error is rethrown; the reaper retries it.
// - Cost: Naïve bills 10-minute blocks in advance, the first block at create. blocks billed =
//   max(1, ceil(lifetime / block)); cost = blocks × price per block. Integer micro-USD (bigint).
//   TDM-252: the price per block follows the computer's size. `pricing.blockPriceFor` prices it
//   (Naïve's rate card in the server) and the row keeps it (`pricePerBlockMicroUsd`), so a
//   4 vCPU / 8 GiB computer costs 55,200 a block, not the flat 2 vCPU / 4 GiB 27,600. A row
//   without one (written before TDM-252) costs at `pricing.pricePerBlockMicroUsd`.
import { ComputerIdSchema, mulMicro, newId, RunIdSchema, TrialIdSchema } from "@anybench/core";
import {
  trialTag,
  type ComputeProvider,
  type ComputerInfo,
  type ComputerSpecInput,
  type ProviderCapabilities,
  type WaitReadyOptions,
} from "@anybench/providers";
import { z } from "zod";

/** Mirrors COMPUTER_STATUSES in apps/server/src/db/schema/_enums.ts (the `computers.status` CHECK). */
export const REGISTRY_COMPUTER_STATUSES = [
  "creating",
  "running",
  "destroying",
  "destroyed",
  "leaked",
  "error",
] as const;
export const RegistryComputerStatusSchema = z.enum(REGISTRY_COMPUTER_STATUSES);
export type RegistryComputerStatus = z.infer<typeof RegistryComputerStatusSchema>;

/**
 * Tag prefix for our own infrastructure computers (e.g. the always-on worker host on the same Naïve
 * account). The reaper never touches a computer carrying a tag that starts with it. Trial tags are
 * `ab-<32 hex>-<32 hex>`, so they can never collide with it.
 */
export const INFRA_COMPUTER_TAG_PREFIX = "ab-infra-";

/** Naïve's billing block. Used when the provider bills per second/hour, so cost is still blocky. */
export const DEFAULT_BLOCK_SECONDS = 600;

/** One `computers` row, in the registry's own (camelCase) terms. */
export const ComputerRecordSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  providerId: z.string().min(1).nullable(),
  runId: z.string().min(1).nullable(),
  trialId: z.string().min(1).nullable(),
  snapshotId: z.string().min(1).nullable(),
  status: RegistryComputerStatusSchema,
  createdAt: z.date(),
  destroyedAt: z.date().nullable(),
  blocksBilled: z.int().nonnegative(),
  costMicroUsd: z.bigint().nonnegative(),
  lastSeenAt: z.date().nullable(),
  /**
   * TDM-252: what one block of THIS computer costs (its size at the provider's rate), fixed at
   * create. Null or absent: the registry's flat `pricing.pricePerBlockMicroUsd`.
   */
  pricePerBlockMicroUsd: z.bigint().nonnegative().nullish(),
});
export type ComputerRecord = z.infer<typeof ComputerRecordSchema>;

export type ComputerRecordPatch = Partial<Omit<ComputerRecord, "id" | "provider">>;

/** The DB port. Implementations must write synchronously (resolve only once the row is stored). */
export interface ComputerStore {
  insert(row: ComputerRecord): Promise<void>;
  update(id: string, patch: ComputerRecordPatch): Promise<void>;
  get(id: string): Promise<ComputerRecord | null>;
  findByProviderId(provider: string, providerId: string): Promise<ComputerRecord | null>;
}

/** A computer's size, as the provider reports it (ComputerInfo) or as it was asked for. */
export interface ComputerSize {
  vcpu: number;
  memoryMb: number;
}

export const ComputerPricingSchema = z.object({
  /**
   * Price of one billing block, integer micro-USD: for a computer of unknown size (a row written
   * before TDM-252), or every computer when there is no `blockPriceFor`.
   */
  pricePerBlockMicroUsd: z.bigint().nonnegative(),
  /**
   * TDM-252: the price of one block of a computer this size (the provider's rate card). The
   * registry stores it on the row at create, so the computer's cost follows its size.
   */
  blockPriceFor: z
    .custom<(size: ComputerSize) => bigint>((v) => typeof v === "function")
    .optional(),
  /** Override the block length; default the provider's (block billing) or 600 s. */
  blockSeconds: z.int().positive().optional(),
});
export type ComputerPricing = z.infer<typeof ComputerPricingSchema>;

export class ComputerRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComputerRegistryError";
  }
}

// ---------- cost (pure) ----------

/** Blocks billed for a lifetime: the first block is paid at create, so never less than 1. */
export function blocksBilled(createdAt: Date, endedAt: Date, blockSeconds: number): number {
  if (!Number.isInteger(blockSeconds) || blockSeconds <= 0) {
    throw new ComputerRegistryError(`blockSeconds must be a positive integer, got ${blockSeconds}`);
  }
  const ms = Math.max(0, endedAt.getTime() - createdAt.getTime());
  return Math.max(1, Math.ceil(ms / (blockSeconds * 1000)));
}

/** blocks × price per block, integer micro-USD. */
export function computerCostMicroUsd(blocks: number, pricePerBlockMicroUsd: bigint): bigint {
  return mulMicro(pricePerBlockMicroUsd, blocks);
}

/**
 * What one computer cost from `createdAt` to `endedAt` on this provider. A `free` provider
 * (docker-local) still counts blocks, at price 0.
 */
export function computerCost(
  record: Pick<ComputerRecord, "createdAt" | "pricePerBlockMicroUsd">,
  endedAt: Date,
  caps: ProviderCapabilities,
  pricing: ComputerPricing,
): { blocksBilled: number; costMicroUsd: bigint } {
  const blockSeconds =
    pricing.blockSeconds ??
    (caps.billing.kind === "block" ? caps.billing.blockSeconds : DEFAULT_BLOCK_SECONDS);
  const blocks = blocksBilled(record.createdAt, endedAt, blockSeconds);
  const price =
    caps.billing.kind === "free"
      ? 0n
      : (record.pricePerBlockMicroUsd ?? pricing.pricePerBlockMicroUsd);
  return { blocksBilled: blocks, costMicroUsd: computerCostMicroUsd(blocks, price) };
}

/** ComputerSpecSchema's defaults, for a spec that leaves the size out. */
const DEFAULT_SIZE: ComputerSize = { vcpu: 2, memoryMb: 4096 };

/**
 * TDM-252: the price of one block of a computer this size: `pricing.blockPriceFor` when set,
 * else the flat `pricePerBlockMicroUsd`. A free provider is 0 whatever the size.
 */
export function blockPriceOf(
  size: Partial<ComputerSize>,
  caps: ProviderCapabilities,
  pricing: ComputerPricing,
): bigint {
  if (caps.billing.kind === "free") return 0n;
  if (!pricing.blockPriceFor) return pricing.pricePerBlockMicroUsd;
  const price = pricing.blockPriceFor({
    vcpu: size.vcpu ?? DEFAULT_SIZE.vcpu,
    memoryMb: size.memoryMb ?? DEFAULT_SIZE.memoryMb,
  });
  if (typeof price !== "bigint" || price < 0n) {
    throw new ComputerRegistryError(`blockPriceFor returned ${String(price)}, not a bigint >= 0`);
  }
  return price;
}

// ---------- registry ----------

export const RegistryCreateInputSchema = z.object({
  runId: RunIdSchema,
  trialId: TrialIdSchema,
  spec: z.custom<ComputerSpecInput>((v) => typeof v === "object" && v !== null).optional(),
});
export type RegistryCreateInput = z.input<typeof RegistryCreateInputSchema>;

export interface RegisteredComputer {
  /** Our `computers.id` (UUIDv7): store it on `trials.computer_id`. */
  computerId: string;
  info: ComputerInfo;
}

export interface DestroyedComputer {
  computerId: string;
  blocksBilled: number;
  costMicroUsd: bigint;
}

export interface ComputerRegistry {
  readonly provider: ComputeProvider;
  /** Insert the row, then create (or fork, if spec.snapshotId) with the trial tag added. */
  create(input: RegistryCreateInput): Promise<RegisteredComputer>;
  /** provider.waitReady, then status running + last_seen_at. */
  waitReady(computerId: string, opts?: WaitReadyOptions): Promise<ComputerInfo>;
  /** Record activity (heartbeat, exec) so the reaper's idle clock restarts. */
  touch(computerId: string): Promise<void>;
  /**
   * Status destroying → provider.destroy → destroyed + blocks/cost. Rethrows provider errors.
   * On a row already `destroyed` it still calls provider.destroy (idempotent) but returns the
   * stored blocks/cost unchanged, unless `recost` asks to re-cost up to now.
   */
  destroy(computerId: string, opts?: { recost?: boolean }): Promise<DestroyedComputer>;
  /** Track a provider computer that has no row (found by the reaper), so it can be destroyed and costed. */
  adopt(
    info: ComputerInfo,
    ctx: { runId: string | null; trialId: string | null },
  ): Promise<ComputerRecord>;
  /** Flag a row as leaked (a destroy that failed; the reaper retries it next tick). */
  markLeaked(computerId: string): Promise<void>;
  /** Blocks billed and cost from the row's created_at until `at` (default now), at its price. */
  costOf(
    record: Pick<ComputerRecord, "createdAt" | "pricePerBlockMicroUsd">,
    at?: Date,
  ): { blocksBilled: number; costMicroUsd: bigint };
  findByProviderId(providerId: string): Promise<ComputerRecord | null>;
}

export interface ComputerRegistryOptions {
  provider: ComputeProvider;
  store: ComputerStore;
  pricing: ComputerPricing;
  now?: () => Date;
  /** Id for new rows; default UUIDv7. */
  newComputerId?: () => string;
}

export function createComputerRegistry(options: ComputerRegistryOptions): ComputerRegistry {
  const { provider, store } = options;
  const pricing = ComputerPricingSchema.parse(options.pricing);
  const now = options.now ?? (() => new Date());
  const nextId = options.newComputerId ?? (() => newId(ComputerIdSchema));

  async function mustGet(computerId: string): Promise<ComputerRecord> {
    const row = await store.get(computerId);
    if (!row) throw new ComputerRegistryError(`computer ${computerId} is not in the registry`);
    if (row.provider !== provider.name) {
      throw new ComputerRegistryError(
        `computer ${computerId} belongs to provider ${row.provider}, not ${provider.name}`,
      );
    }
    return row;
  }

  return {
    provider,

    async create(rawInput) {
      const input = RegistryCreateInputSchema.parse(rawInput);
      const spec: ComputerSpecInput = input.spec ?? {};
      const tag = trialTag(input.runId, input.trialId);
      const tags = [...(spec.tags ?? [])];
      if (!tags.includes(tag)) tags.push(tag);
      const computerId = nextId();
      const createdAt = now();
      const caps = provider.capabilities;

      // BEFORE the provider call: a row exists even if we crash mid-create.
      await store.insert({
        id: computerId,
        provider: provider.name,
        providerId: null,
        runId: input.runId,
        trialId: input.trialId,
        snapshotId: spec.snapshotId ?? null,
        status: "creating",
        createdAt,
        destroyedAt: null,
        blocksBilled: 0,
        costMicroUsd: 0n,
        lastSeenAt: createdAt,
        // The size asked for; corrected to the size the provider reports once it answers.
        pricePerBlockMicroUsd: blockPriceOf(spec, caps, pricing),
      });

      let info: ComputerInfo;
      try {
        if (spec.snapshotId !== undefined) {
          const { snapshotId, ...rest } = spec;
          info = await provider.fork(snapshotId, { ...rest, tags });
        } else {
          info = await provider.create({ ...spec, tags });
        }
      } catch (err) {
        await store.update(computerId, { status: "error", destroyedAt: now() });
        throw err;
      }

      // AFTER: the provider id, so destroy and the reaper can match it.
      await store.update(computerId, {
        providerId: info.id,
        status: info.status === "running" ? "running" : "creating",
        lastSeenAt: now(),
        pricePerBlockMicroUsd: blockPriceOf(info, caps, pricing),
      });
      return { computerId, info };
    },

    async waitReady(computerId, opts) {
      const row = await mustGet(computerId);
      if (!row.providerId) {
        throw new ComputerRegistryError(`computer ${computerId} has no provider id yet`);
      }
      const info = await provider.waitReady(row.providerId, opts);
      await store.update(computerId, { status: "running", lastSeenAt: now() });
      return info;
    },

    async touch(computerId) {
      await store.update(computerId, { lastSeenAt: now() });
    },

    async destroy(computerId, opts = {}) {
      const row = await mustGet(computerId);
      if (row.status === "destroyed" && !opts.recost) {
        // Already closed and costed: make sure it is gone, but never bill it twice.
        if (row.providerId) await provider.destroy(row.providerId);
        return { computerId, blocksBilled: row.blocksBilled, costMicroUsd: row.costMicroUsd };
      }
      // BEFORE the provider call.
      await store.update(computerId, { status: "destroying" });
      if (row.providerId) await provider.destroy(row.providerId);
      const at = now();
      const cost = computerCost(row, at, provider.capabilities, pricing);
      // AFTER: closed and costed.
      await store.update(computerId, {
        status: "destroyed",
        destroyedAt: at,
        blocksBilled: cost.blocksBilled,
        costMicroUsd: cost.costMicroUsd,
      });
      return { computerId, ...cost };
    },

    async adopt(info, ctx) {
      const existing = await store.findByProviderId(provider.name, info.id);
      if (existing) return existing;
      const createdAt = new Date(info.createdAt);
      const row: ComputerRecord = {
        id: nextId(),
        provider: provider.name,
        providerId: info.id,
        runId: ctx.runId,
        trialId: ctx.trialId,
        snapshotId: info.snapshotId,
        status: "leaked",
        createdAt,
        destroyedAt: null,
        blocksBilled: 0,
        costMicroUsd: 0n,
        lastSeenAt: null,
        pricePerBlockMicroUsd: blockPriceOf(info, provider.capabilities, pricing),
      };
      await store.insert(row);
      return row;
    },

    async markLeaked(computerId) {
      await store.update(computerId, { status: "leaked" });
    },

    costOf(record, at) {
      return computerCost(record, at ?? now(), provider.capabilities, pricing);
    },

    findByProviderId(providerId) {
      return store.findByProviderId(provider.name, providerId);
    },
  };
}

/** An in-memory ComputerStore for unit tests and local tools. */
export class MemoryComputerStore implements ComputerStore {
  readonly rows = new Map<string, ComputerRecord>();

  async insert(row: ComputerRecord): Promise<void> {
    const parsed = ComputerRecordSchema.parse(row);
    if (this.rows.has(parsed.id)) throw new ComputerRegistryError(`duplicate id ${parsed.id}`);
    this.rows.set(parsed.id, parsed);
  }

  async update(id: string, patch: ComputerRecordPatch): Promise<void> {
    const row = this.rows.get(id);
    if (!row) throw new ComputerRegistryError(`no computer ${id}`);
    this.rows.set(id, ComputerRecordSchema.parse({ ...row, ...patch }));
  }

  async get(id: string): Promise<ComputerRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async findByProviderId(provider: string, providerId: string): Promise<ComputerRecord | null> {
    for (const r of this.rows.values()) {
      if (r.provider === provider && r.providerId === providerId) return r;
    }
    return null;
  }
}
