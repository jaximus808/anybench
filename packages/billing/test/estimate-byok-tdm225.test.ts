// TDM-225: the bound on model tokens spent on the user's own key, shown next to (never inside) the
// run estimate: "billed by your provider". Pure, no database.
import type { KitSpecInput } from "@anybench/core";
import { describe, expect, it } from "vitest";
import { byokTokenCeilingMicroUsd, estimateRunCost } from "../src/index.js";

function agentKit(
  contenders: { id: string; source?: string; cap?: bigint }[],
  repeats = 3,
): KitSpecInput {
  return {
    schema_version: 2,
    subject: { kind: "software", name: "agent", summary: "An agent", better_means: ["faster"] },
    contenders: contenders.map((c, i) => ({
      id: c.id,
      role: i === 0 ? "subject" : "baseline",
      source: { github: "example/agent", ref: c.id },
      driver: {
        type: "coding-agent",
        verbs: { run: "run {task} {workspace}" },
        model: "claude-opus-5-5",
        ...(c.cap !== undefined ? { token_cap_micro_usd: c.cap } : {}),
        env:
          c.source === undefined
            ? { CC_SETUP: c.id }
            : { CC_SETUP: c.id, AB_TOKEN_SOURCE: c.source },
      },
    })),
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
    repeats,
  } as KitSpecInput;
}

describe("byokTokenCeilingMicroUsd", () => {
  it("is every BYOK trial at its contender's spend cap (2 workloads x (3 repeats + 1 warm-up) each)", () => {
    const kit = agentKit([
      { id: "a", source: "anthropic_key", cap: 500_000n },
      { id: "b", source: "openai_key", cap: 250_000n },
    ]);
    expect(byokTokenCeilingMicroUsd(kit)).toBe(8n * 500_000n + 8n * 250_000n);
  });

  it("counts only contenders on the user's key; managed tokens are metered, not bounded here", () => {
    const kit = agentKit([
      { id: "a", source: "anthropic_key", cap: 500_000n },
      { id: "b", source: "naive_proxy", cap: 250_000n },
    ]);
    expect(byokTokenCeilingMicroUsd(kit)).toBe(8n * 500_000n);
  });

  it("is null when a BYOK contender sets no spend cap, or no contender uses the user's key", () => {
    expect(
      byokTokenCeilingMicroUsd(
        agentKit([
          { id: "a", source: "anthropic_key", cap: 500_000n },
          { id: "b", source: "anthropic_key" },
        ]),
      ),
    ).toBeNull();
    expect(
      byokTokenCeilingMicroUsd(agentKit([{ id: "a" }, { id: "b", source: "naive_proxy" }])),
    ).toBeNull();
  });

  it("never enters the run estimate: our price is run fee + computer time only", () => {
    const capped = agentKit([
      { id: "a", source: "anthropic_key", cap: 9_000_000n },
      { id: "b", source: "anthropic_key", cap: 9_000_000n },
    ]);
    const uncapped = agentKit([
      { id: "a", source: "anthropic_key" },
      { id: "b", source: "anthropic_key" },
    ]);
    const pricing = {
      runFeeMicroUsd: 2_000_000n,
      computeMarkupBps: 5000,
      defaultBlockPriceMicroUsd: 27_600n,
    };
    expect(estimateRunCost(capped, pricing).totalMicroUsd).toBe(
      estimateRunCost(uncapped, pricing).totalMicroUsd,
    );
  });
});
