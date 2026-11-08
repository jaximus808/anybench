// TDM-178 [16.7]: seeded per-round contender order, and wall metrics flagged when a trial saw 429s.
import { readFileSync } from "node:fs";
import { KitSpecSchema } from "@anybench/core";
import { describe, expect, it } from "vitest";
import {
  contenderOrders,
  expandTrials,
  flagRateLimitedWall,
  metric,
  schedulableFromKit,
  type Metric,
  type TrialPlan,
} from "../src/index.js";

/** Contender order of each round (warm-up flag × repeat × workload), in launch order. */
function roundsTdm178(plans: readonly TrialPlan[], n: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < plans.length; i += n)
    out.push(plans.slice(i, i + n).map((p) => p.contender_id));
  return out;
}

describe("contender order rotation (schedule.order_seed)", () => {
  const kit = {
    contenders: ["a", "b", "c"],
    workloads: ["w1", "w2"],
    repeats: 3,
    warmups: 0,
    est_trial_seconds: 60,
  };

  it("keeps kit order every round without a seed", () => {
    const plans = expandTrials({ run_id: "r", kit });
    expect(roundsTdm178(plans, 3)).toEqual(Array.from({ length: 6 }, () => ["a", "b", "c"]));
  });

  it("rotates per round from the seed: each contender takes each position once per n rounds", () => {
    const plans = expandTrials({ run_id: "r", kit: { ...kit, order_seed: 178 } });
    const rounds = roundsTdm178(plans, 3);
    expect(rounds).toHaveLength(6);
    for (const r of rounds) expect([...r].sort()).toEqual(["a", "b", "c"]);
    for (let start = 0; start + 3 <= rounds.length; start += 3) {
      for (let pos = 0; pos < 3; pos++) {
        expect(new Set(rounds.slice(start, start + 3).map((r) => r[pos])).size).toBe(3);
      }
    }
    // Same seed, same plan; another seed, another base order.
    const again = expandTrials({ run_id: "r", kit: { ...kit, order_seed: 178 } });
    expect(roundsTdm178(again, 3)).toEqual(rounds);
    const orders = new Set(
      Array.from({ length: 20 }, (_, s) => contenderOrders(["a", "b", "c"], 1, s)[0]!.join("")),
    );
    expect(orders.size).toBeGreaterThan(1);
    // Every trial is still planned exactly once.
    expect(plans).toHaveLength(3 * 2 * 3);
    expect(new Set(plans.map((p) => `${p.contender_id}/${p.workload_id}/${p.repeat}`)).size).toBe(
      18,
    );
  });

  it("schedulableFromKit carries schedule.order_seed", () => {
    const url = new URL("../../core/test/fixtures/kits/kit-agent.json", import.meta.url);
    const raw = JSON.parse(readFileSync(url, "utf8"));
    expect(schedulableFromKit(KitSpecSchema.parse(raw)).order_seed).toBeUndefined();
    raw.schedule = { order_seed: 7 };
    expect(schedulableFromKit(KitSpecSchema.parse(raw)).order_seed).toBe(7);
  });
});

describe("flagRateLimitedWall", () => {
  const row = (name: string, value: number, collector: Metric["collector"], unit: Metric["unit"]) =>
    metric({ name, value, unit, level: "trial", collector });

  it("flags every wall metric of a trial that saw a 429", () => {
    const flags = flagRateLimitedWall([
      row("wall_s", 812, "time", "s"),
      row("agent_duration_ms", 790_000, "stream-json", "ms"),
      row("http_429", 3, "stream-json", "count"),
      row("turns", 40, "stream-json", "count"),
    ]);
    expect(flags.map((f) => [f.metric, f.http_429])).toEqual([
      ["wall_s", 3],
      ["agent_duration_ms", 3],
    ]);
    expect(flags[0]!.message).toMatch(/wall_s is rate-limited: the trial saw 3 HTTP 429 responses/);
  });

  it("flags nothing without 429s", () => {
    expect(
      flagRateLimitedWall([
        row("wall_s", 812, "time", "s"),
        row("http_429", 0, "stream-json", "count"),
      ]),
    ).toEqual([]);
    expect(flagRateLimitedWall([row("wall_s", 812, "time", "s")])).toEqual([]);
  });
});
