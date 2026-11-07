// TDM-31: the computer registry writes the store before/after every provider call and costs blocks.
import { newId, RunIdSchema, TrialIdSchema } from "@anybench/core";
import {
  FakeProvider,
  ProviderUnavailableError,
  trialTag,
  type ComputeProvider,
} from "@anybench/providers";
import { describe, expect, it } from "vitest";
import {
  blocksBilled,
  computerCost,
  createComputerRegistry,
  MemoryComputerStore,
  type ComputerRecord,
  type ComputerRecordPatch,
  type ComputerStore,
} from "../src/registry.js";

const T0 = Date.parse("2026-11-07T12:00:00.000Z");

function clockTdm31(start = T0) {
  let t = start;
  return {
    now: () => new Date(t),
    nowMs: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

/** Records the order of store writes and provider calls. */
function tracedTdm31(provider: FakeProvider, store: ComputerStore, log: string[]) {
  const tracedStore: ComputerStore = {
    async insert(row: ComputerRecord) {
      log.push(`store.insert:${row.status}`);
      return store.insert(row);
    },
    async update(id: string, patch: ComputerRecordPatch) {
      log.push(`store.update:${patch.status ?? "-"}`);
      return store.update(id, patch);
    },
    get: (id) => store.get(id),
    findByProviderId: (p, id) => store.findByProviderId(p, id),
  };
  const tracedProvider = new Proxy(provider, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (typeof v === "function" && ["create", "fork", "destroy"].includes(String(prop))) {
        return async (...args: unknown[]) => {
          log.push(`provider.${String(prop)}`);
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof v === "function" ? (v as () => unknown).bind(target) : v;
    },
  }) as ComputeProvider;
  return { tracedStore, tracedProvider };
}

describe("blocksBilled / computerCost (TDM-31)", () => {
  it("bills at least one block and rounds up partial blocks", () => {
    const c = new Date(T0);
    expect(blocksBilled(c, new Date(T0), 600)).toBe(1);
    expect(blocksBilled(c, new Date(T0 + 599_000), 600)).toBe(1);
    expect(blocksBilled(c, new Date(T0 + 600_000), 600)).toBe(1);
    expect(blocksBilled(c, new Date(T0 + 600_001), 600)).toBe(2);
    expect(blocksBilled(c, new Date(T0 + 25 * 60_000), 600)).toBe(3);
  });

  it("costs blocks × price in bigint micro-USD; free providers cost 0", () => {
    const fake = new FakeProvider();
    const r = { createdAt: new Date(T0) };
    expect(
      computerCost(r, new Date(T0 + 21 * 60_000), fake.capabilities, {
        pricePerBlockMicroUsd: 12_345n,
      }),
    ).toEqual({ blocksBilled: 3, costMicroUsd: 37_035n });
    const free = new FakeProvider({ capabilities: { billing: { kind: "free" } } });
    expect(
      computerCost(r, new Date(T0 + 21 * 60_000), free.capabilities, {
        pricePerBlockMicroUsd: 12_345n,
      }),
    ).toEqual({ blocksBilled: 3, costMicroUsd: 0n });
  });
});

describe("ComputerRegistry (TDM-31, FakeProvider)", () => {
  const runId = newId(RunIdSchema);
  const trialId = newId(TrialIdSchema);

  it("inserts the row before create and sets provider_id after; tags the computer", async () => {
    const clock = clockTdm31();
    const fake = new FakeProvider({ now: clock.nowMs });
    const store = new MemoryComputerStore();
    const log: string[] = [];
    const { tracedStore, tracedProvider } = tracedTdm31(fake, store, log);
    const reg = createComputerRegistry({
      provider: tracedProvider,
      store: tracedStore,
      pricing: { pricePerBlockMicroUsd: 20_000n },
      now: clock.now,
    });

    const { computerId, info } = await reg.create({ runId, trialId, spec: { vcpu: 2 } });
    expect(log).toEqual(["store.insert:creating", "provider.create", "store.update:running"]);
    expect(info.tags).toContain(trialTag(runId, trialId));
    const row = await store.get(computerId);
    expect(row).toMatchObject({
      provider: "fake",
      providerId: info.id,
      runId,
      trialId,
      status: "running",
    });
  });

  it("marks the row error when the provider create fails, and rethrows", async () => {
    const fake = new FakeProvider();
    fake.failNext("create", new ProviderUnavailableError("down"));
    const store = new MemoryComputerStore();
    const reg = createComputerRegistry({
      provider: fake,
      store,
      pricing: { pricePerBlockMicroUsd: 1n },
    });
    await expect(reg.create({ runId, trialId })).rejects.toThrow("down");
    const [row] = [...store.rows.values()];
    expect(row).toMatchObject({ status: "error", providerId: null });
    expect(row!.destroyedAt).toBeInstanceOf(Date);
  });

  it("forks when the spec names a snapshot", async () => {
    const fake = new FakeProvider();
    const base = await fake.create({});
    const snap = await fake.snapshot(base.id);
    const store = new MemoryComputerStore();
    const log: string[] = [];
    const { tracedStore, tracedProvider } = tracedTdm31(fake, store, log);
    const reg = createComputerRegistry({
      provider: tracedProvider,
      store: tracedStore,
      pricing: { pricePerBlockMicroUsd: 1n },
    });
    const { computerId } = await reg.create({
      runId,
      trialId,
      spec: { snapshotId: snap.snapshotId },
    });
    expect(log).toContain("provider.fork");
    expect((await store.get(computerId))!.snapshotId).toBe(snap.snapshotId);
  });

  it("destroy: status destroying before, destroyed + cost after", async () => {
    const clock = clockTdm31();
    const fake = new FakeProvider({ now: clock.nowMs });
    const store = new MemoryComputerStore();
    const log: string[] = [];
    const { tracedStore, tracedProvider } = tracedTdm31(fake, store, log);
    const reg = createComputerRegistry({
      provider: tracedProvider,
      store: tracedStore,
      pricing: { pricePerBlockMicroUsd: 20_000n },
      now: clock.now,
    });
    const { computerId, info } = await reg.create({ runId, trialId });
    log.length = 0;
    clock.advance(11 * 60_000);
    const out = await reg.destroy(computerId);
    expect(log).toEqual(["store.update:destroying", "provider.destroy", "store.update:destroyed"]);
    expect(out).toEqual({ computerId, blocksBilled: 2, costMicroUsd: 40_000n });
    expect(await store.get(computerId)).toMatchObject({
      status: "destroyed",
      blocksBilled: 2,
      costMicroUsd: 40_000n,
      destroyedAt: new Date(T0 + 11 * 60_000),
    });
    expect(await fake.list()).toEqual([]);
    expect(info.id).toBeTruthy();
  });

  it("a failed provider destroy leaves the row destroying and rethrows", async () => {
    const fake = new FakeProvider();
    const store = new MemoryComputerStore();
    const reg = createComputerRegistry({
      provider: fake,
      store,
      pricing: { pricePerBlockMicroUsd: 1n },
    });
    const { computerId } = await reg.create({ runId, trialId });
    fake.failNext("destroy", new ProviderUnavailableError("busy"));
    await expect(reg.destroy(computerId)).rejects.toThrow("busy");
    expect((await store.get(computerId))!.status).toBe("destroying");
    expect(await fake.list()).toHaveLength(1);
    await reg.destroy(computerId);
    expect((await store.get(computerId))!.status).toBe("destroyed");
  });

  it("destroy on an already-destroyed row never re-costs unless asked", async () => {
    const clock = clockTdm31();
    const fake = new FakeProvider({ now: clock.nowMs });
    const store = new MemoryComputerStore();
    const reg = createComputerRegistry({
      provider: fake,
      store,
      pricing: { pricePerBlockMicroUsd: 100n },
      now: clock.now,
    });
    const { computerId, info } = await reg.create({ runId, trialId });
    clock.advance(5 * 60_000);
    expect(await reg.destroy(computerId)).toMatchObject({ blocksBilled: 1, costMicroUsd: 100n });
    const closed = await store.get(computerId);

    clock.advance(60 * 60_000);
    const log: string[] = [];
    const { tracedStore, tracedProvider } = tracedTdm31(fake, store, log);
    const again = createComputerRegistry({
      provider: tracedProvider,
      store: tracedStore,
      pricing: { pricePerBlockMicroUsd: 100n },
      now: clock.now,
    });
    expect(await again.destroy(computerId)).toEqual({
      computerId,
      blocksBilled: 1,
      costMicroUsd: 100n,
    });
    expect(log).toEqual(["provider.destroy"]); // idempotent provider call, no store writes
    expect(await store.get(computerId)).toEqual(closed);
    expect((await fake.list({ includeDestroyed: true }))[0]!.id).toBe(info.id);

    expect(await again.destroy(computerId, { recost: true })).toMatchObject({
      blocksBilled: 7,
      costMicroUsd: 700n,
    });
  });

  it("adopt tracks an unknown provider computer once", async () => {
    const fake = new FakeProvider();
    const store = new MemoryComputerStore();
    const reg = createComputerRegistry({
      provider: fake,
      store,
      pricing: { pricePerBlockMicroUsd: 1n },
    });
    const stray = await fake.create({ tags: [trialTag(runId, trialId)] });
    const a = await reg.adopt(stray, { runId, trialId });
    const b = await reg.adopt(stray, { runId, trialId });
    expect(a.id).toBe(b.id);
    expect(a).toMatchObject({ status: "leaked", providerId: stray.id });
    expect(store.rows.size).toBe(1);
  });
});
