// TDM-252 [21.12]: a trial's compute share "missed its computer's last block" in league run 1
// (55,200 recorded where computer.destroyed said blocks_billed 2; the ledger showed $1.13 at cost
// against $2.37 of blocks). The blocks were right; the price was not: the registry costed every
// computer at the flat COMPUTER_BLOCK_PRICE_MICRO_USD (27,600, a 2 vCPU / 4 GiB block) and the
// league kit runs 4 vCPU / 8 GiB, which Naïve bills 55,200 a block. 55,200 = 2 x 27,600, and
// $1.13 = 41 blocks x 27,600. A Naïve computer now costs its size's rate-card block (stored on its
// row), the trial's share and the ledger read that cost, and the budget counts it the same way.
// The budget half runs against local Postgres (skips without it).
import { createComputerRegistry, MemoryComputerStore, type ComputerStore } from "@anybench/envs";
import { EnvSpecSchema, newId, RunIdSchema, TrialIdSchema, type KitSpec } from "@anybench/core";
import { FakeProvider, naiveBlockPriceMicroUsd } from "@anybench/providers";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computers, contenders, kits, runs, trials, users } from "../src/db/schema/index.js";
import { drizzleComputerStore, computerPricing } from "../src/lib/computer-store.js";
import { readRunBudget, trialCap, type BudgetPricing } from "../src/orchestrator/budget.js";
import { kitTdm54 } from "./helpers/orchestrator-tdm54.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";

const FLAT = 27_600n;
const BIG = { vcpu: 4, memoryMb: 8192 };
const PRICING: BudgetPricing = {
  runFeeMicroUsd: 2_000_000n,
  uploadedKitRunFeeMicroUsd: 0n,
  computeMarkupBps: 5000n,
  managedTokenMarkupBps: 2000n,
  blockPriceMicroUsd: FLAT,
  proxyCapCeilingMicroUsd: 3_000_000n,
};

/** A registry on a fake provider named `name`, its clock under the test's control. */
function registryTdm252(name: string, store: ComputerStore = new MemoryComputerStore()) {
  const clock = { at: new Date("2026-11-09T21:00:00.000Z") };
  const provider = new FakeProvider({ name, now: () => clock.at.getTime() });
  const registry = createComputerRegistry({
    provider,
    store,
    pricing: computerPricing(provider, FLAT),
    now: () => clock.at,
  });
  return { registry, store, clock };
}

function bigKit(): KitSpec {
  return {
    ...kitTdm54(),
    env: EnvSpecSchema.parse({
      profile: "base",
      resources: { vcpu: 4, memory_gb: 8, disk_gb: 20 },
    }),
  };
}

describe("a computer's block price follows its size (TDM-252)", () => {
  it("Naïve's rate card: 2 vCPU / 4 GiB = 27,600, 4 vCPU / 8 GiB = 55,200", () => {
    expect(naiveBlockPriceMicroUsd({ vcpu: 2, memoryMb: 4096 })).toBe(27_600n);
    expect(naiveBlockPriceMicroUsd(BIG)).toBe(55_200n);
  });

  it("a Naïve 4 vCPU / 8 GiB computer alive 15 minutes bills 2 blocks at 55,200", async () => {
    const { registry, store, clock } = registryTdm252("naive");
    const created = await registry.create({
      runId: newId(RunIdSchema),
      trialId: newId(TrialIdSchema),
      spec: BIG,
    });
    const row = await store.get(created.computerId);
    expect(row!.pricePerBlockMicroUsd).toBe(55_200n);
    clock.at = new Date(clock.at.getTime() + 15 * 60_000);
    // The trial's share reads costOf before the destroy: the same price.
    expect(registry.costOf(row!)).toEqual({ blocksBilled: 2, costMicroUsd: 110_400n });
    const closed = await registry.destroy(created.computerId);
    expect(closed).toMatchObject({ blocksBilled: 2, costMicroUsd: 110_400n });
    const done = await store.get(created.computerId);
    expect(done).toMatchObject({ blocksBilled: 2, costMicroUsd: 110_400n });
  });

  it("another provider, and a row written before the price was stored, cost the flat block", async () => {
    const { registry, store, clock } = registryTdm252("fake");
    const created = await registry.create({
      runId: newId(RunIdSchema),
      trialId: newId(TrialIdSchema),
      spec: BIG,
    });
    expect((await store.get(created.computerId))!.pricePerBlockMicroUsd).toBe(FLAT);

    const naive = registryTdm252("naive");
    const legacy = { createdAt: naive.clock.at, pricePerBlockMicroUsd: null };
    naive.clock.at = new Date(naive.clock.at.getTime() + 15 * 60_000);
    expect(naive.registry.costOf(legacy)).toEqual({ blocksBilled: 2, costMicroUsd: 2n * FLAT });
    clock.at = new Date(clock.at.getTime() + 60_000);
    expect((await registry.destroy(created.computerId)).costMicroUsd).toBe(FLAT);
  });

  it("an adopted (leaked) Naïve computer is priced by the size the provider reports", async () => {
    const { registry } = registryTdm252("naive");
    const provider = registry.provider;
    const info = await provider.create({ ...BIG, tags: [] });
    const row = await registry.adopt(info, { runId: null, trialId: null });
    expect(row.pricePerBlockMicroUsd).toBe(55_200n);
  });

  it("the budget's worst case for a trial prices the kit's machine the same way", () => {
    const spec = bigKit();
    const c = spec.contenders[0]!.id;
    const w = spec.workloads[0]!.id;
    // kitTdm54's cli trial at its cap: 9 blocks.
    const atCost = 9n * 55_200n;
    expect(trialCap(spec, c, w, "free_run", PRICING).compute).toBe(atCost);
    expect(trialCap(spec, c, w, "billed", PRICING).compute).toBe(atCost + atCost / 2n);
  });
});

const available = await pgAvailableTdm11();

describe.skipIf(!available)("the budget counts a live computer at its own price (TDM-252)", () => {
  let h: FreshDbTdm11;

  beforeAll(async () => {
    h = await freshMigratedDbTdm11({ max: 4 });
  }, 60_000);

  afterAll(async () => {
    await h?.drop();
  });

  it("the drizzle store keeps the price; readRunBudget's live compute uses it", async () => {
    const [u] = await h.db
      .insert(users)
      .values({ githubLogin: "price-252", githubId: 252_000 })
      .returning();
    const [run] = await h.db
      .insert(runs)
      .values({
        ownerId: u!.id,
        question: "dearer?",
        budgetMicroUsd: 20_000_000n,
        state: "running",
      })
      .returning();
    const spec = bigKit();
    const [kit] = await h.db
      .insert(kits)
      .values({ ownerId: u!.id, runId: run!.id, version: 1, spec, hash: `h-${run!.id}` })
      .returning();
    await h.db.update(runs).set({ kitId: kit!.id }).where(eq(runs.id, run!.id));
    const [c] = await h.db
      .insert(contenders)
      .values({
        runId: run!.id,
        kitId: kit!.id,
        source: spec.contenders[0]!.id,
        role: "subject",
        foundBy: "kit",
      })
      .returning();
    const trialId = newId(TrialIdSchema);
    await h.db.insert(trials).values({
      id: trialId,
      ownerId: u!.id,
      runId: run!.id,
      contenderId: c!.id,
      workloadId: spec.workloads[0]!.id,
      repeat: 0,
      state: "running",
    });

    // The registry writes the row through the server's store, 15 minutes ago.
    const store = drizzleComputerStore(h.db);
    const { registry } = registryTdm252("naive", store);
    const created = await registry.create({ runId: run!.id, trialId, spec: BIG });
    await h.db
      .update(computers)
      .set({ createdAt: new Date(Date.now() - 15 * 60_000) })
      .where(eq(computers.id, created.computerId));
    await h.db.update(trials).set({ computerId: created.computerId }).where(eq(trials.id, trialId));
    const row = await store.get(created.computerId);
    expect(row!.pricePerBlockMicroUsd).toBe(55_200n);

    const budget = await readRunBudget(h.db, run!.id, PRICING);
    // 2 blocks so far at 55,200, + 50% markup.
    const live = 2n * 55_200n;
    expect(budget!.spent.compute).toBe(live + live / 2n);
  });
});
