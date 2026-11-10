// TDM-252 [21.12]: a trial's cost_micro_usd equals what the registry bills for its computer.
// League run 1 stored 55,200 where computer.destroyed said blocks_billed 2: the registry priced
// a 4 vCPU / 8 GiB computer at the flat 2 vCPU / 4 GiB block (27,600), so the trial was charged
// 2 blocks at half price. The computer's block price now follows its size, and a trial that ends
// with its computer is charged at the cost the registry closed it at.
import { createComputerRegistry, MemoryComputerStore } from "@anybench/envs";
import { describe, expect, it } from "vitest";
import { executeTrial } from "../src/index.js";
import { harnessTdm49, installFakeRunnerTdm49, preparedTdm49 } from "./executor-tdm49-fakes.js";

/** Naïve's rate card: 8,400 per vCPU + 2,700 per GiB a block. */
const rateCard = (s: { vcpu: number; memoryMb: number }) =>
  BigInt(s.vcpu) * 8_400n + (BigInt(s.memoryMb) * 2_700n) / 1_024n;

function destroyedEvent(h: ReturnType<typeof harnessTdm49>, trialId: string) {
  const ev = h.store.events.find((e) => e.type === "computer.destroyed");
  expect(ev).toBeDefined();
  expect((ev!.payload as { trial_id: string }).trial_id).toBe(trialId);
  return ev!.payload as { blocks_billed: number };
}

describe("executor: the trial's compute share is the registry's bill (TDM-252)", () => {
  it("a 4 vCPU / 8 GiB computer costs its size's block price, not the flat one", async () => {
    const base = harnessTdm49();
    const computers = new MemoryComputerStore();
    const registry = createComputerRegistry({
      provider: base.fake,
      store: computers,
      pricing: { pricePerBlockMicroUsd: 27_600n, blockPriceFor: rateCard },
    });
    installFakeRunnerTdm49(base.fake, () => "ok");
    const trialId = base.newTrial();
    const big = { ...preparedTdm49(), computer: { vcpu: 4, memoryMb: 8192 } };

    const out = await executeTrial(
      base.deps({ registry, source: { prepare: async () => big } }),
      trialId,
    );

    expect(out.kind).toBe("collected");
    const [row] = [...computers.rows.values()];
    expect(row!.pricePerBlockMicroUsd).toBe(55_200n);
    expect(row!.status).toBe("destroyed");
    const t = (await base.store.get(trialId))!;
    expect(destroyedEvent(base, trialId).blocks_billed).toBe(row!.blocksBilled);
    expect(t.cost_micro_usd).toBe(row!.costMicroUsd);
    expect(t.cost_micro_usd).toBe(55_200n); // one block at 4 vCPU / 8 GiB
  });

  it("a block boundary between the cost read and the destroy is charged to the trial", async () => {
    const h = harnessTdm49();
    const computers = new MemoryComputerStore();
    // The registry runs on the executor's clock, and the destroy takes us past the first block.
    const registry = createComputerRegistry({
      provider: h.fake,
      store: computers,
      pricing: { pricePerBlockMicroUsd: 27_600n },
      now: () => new Date(h.clock.now()),
    });
    const destroy = h.fake.destroy.bind(h.fake);
    h.fake.destroy = async (id: string) => {
      h.clock.skewMs += 10 * 60_000;
      await destroy(id);
    };
    installFakeRunnerTdm49(h.fake, () => "ok");
    const trialId = h.newTrial();

    await executeTrial(h.deps({ registry }), trialId);

    const [row] = [...computers.rows.values()];
    expect(row!.blocksBilled).toBe(2);
    expect(destroyedEvent(h, trialId).blocks_billed).toBe(2);
    const t = (await h.store.get(trialId))!;
    expect(t.cost_micro_usd).toBe(row!.costMicroUsd);
    expect(t.cost_micro_usd).toBe(55_200n);
  });
});
