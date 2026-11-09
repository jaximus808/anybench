// TDM-218 (E19): a run from an uploaded kit pays no kit-generation fee. Pure, no database.
import { withMarkupBps, type KitSpecInput } from "@anybench/core";
import { describe, expect, it } from "vitest";
import { estimateRunCost, runFeeForKit } from "../src/index.js";

function kit(): KitSpecInput {
  return {
    schema_version: 2,
    subject: { kind: "software", name: "tool", summary: "A CLI", better_means: ["faster"] },
    contenders: [
      {
        id: "new",
        role: "subject",
        source: { github: "example/tool", ref: "v2" },
        driver: { type: "cli", verbs: { run: "run {in} {out}" } },
      },
      {
        id: "old",
        role: "baseline",
        source: { github: "example/tool", ref: "v1" },
        driver: { type: "cli", verbs: { run: "run {in} {out}" } },
      },
    ],
    workloads: [{ id: "small" }, { id: "large" }],
    gates: [{ id: "same-output", kind: "output-diff" }],
    requirements: [
      {
        id: "wall",
        type: "measured",
        title: "Wall time",
        metric: "wall_s",
        better: "lower",
        gate_id: "same-output",
      },
    ],
    proof: { oracle: { id: "reference", dir: "proof/oracle/" } },
    scoring: { weights: { wall: 100 } },
    repeats: 3,
  } as KitSpecInput;
}

const PRICING = {
  runFeeMicroUsd: 2_000_000n,
  computeMarkupBps: 5000,
  defaultBlockPriceMicroUsd: 27_600n,
};

describe("uploaded kit run fee (TDM-218)", () => {
  it("runFeeForKit: RUN_FEE for a generated kit, UPLOADED_KIT_RUN_FEE (default 0) for an upload", () => {
    expect(runFeeForKit("generated", { runFeeMicroUsd: 2_000_000n })).toBe(2_000_000n);
    expect(runFeeForKit("uploaded", { runFeeMicroUsd: 2_000_000n })).toBe(0n);
    expect(
      runFeeForKit("uploaded", { runFeeMicroUsd: 2_000_000n, uploadedKitRunFeeMicroUsd: 250_000n }),
    ).toBe(250_000n);
    expect(() =>
      runFeeForKit("uploaded", {
        runFeeMicroUsd: 2_000_000n,
        uploadedKitRunFeeMicroUsd: 0.5 as unknown as bigint,
      }),
    ).toThrow();
    expect(() => runFeeForKit("bogus" as never, { runFeeMicroUsd: 1n })).toThrow();
  });

  it("the estimate for an uploaded kit is lower by exactly the run fee: same trial compute", () => {
    const generated = estimateRunCost(kit(), PRICING);
    const uploaded = estimateRunCost(kit(), PRICING, { kitOrigin: "uploaded" });
    expect(generated.kitOrigin).toBe("generated");
    expect(uploaded.kitOrigin).toBe("uploaded");
    // Trial compute is identical: 16 computers, 1 block each, cost + 50%.
    expect(uploaded.compute).toEqual(generated.compute);
    expect(uploaded.compute.chargeMicroUsd).toBe(16n * withMarkupBps(27_600n, 5000));
    expect(generated.runFeeMicroUsd).toBe(2_000_000n);
    expect(uploaded.runFeeMicroUsd).toBe(0n);
    expect(uploaded.totalMicroUsd).toBe(uploaded.compute.chargeMicroUsd);
    expect(generated.totalMicroUsd - uploaded.totalMicroUsd).toBe(2_000_000n);
    expect(uploaded.totalMicroUsd).toBeLessThan(generated.totalMicroUsd);
  });

  it("an uploaded kit pays UPLOADED_KIT_RUN_FEE when one is configured", () => {
    const e = estimateRunCost(
      kit(),
      { ...PRICING, uploadedKitRunFeeMicroUsd: 300_000n },
      { kitOrigin: "uploaded" },
    );
    expect(e.runFeeMicroUsd).toBe(300_000n);
    expect(e.totalMicroUsd).toBe(300_000n + e.compute.chargeMicroUsd);
  });
});
