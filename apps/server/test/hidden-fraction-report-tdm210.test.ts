// TDM-210 [18.3]: the hidden-test fraction and cost per hidden test passed reach the report JSON
// (ReportSchema) even when no trial passed every hidden test, while wall time stays gated; at 3
// repeats per setup the report says "not significant" and crowns nobody.
import path from "node:path";
import { ReportSchema, RequirementSchema, type KitSpec } from "@anybench/core";
import { loadKit } from "@anybench/kit";
import { describe, expect, it } from "vitest";
import { CURATED_TANDEM_KIT, defaultKitsDir } from "../src/orchestrator/curated.js";
import type { StageContext, StageTrial } from "../src/orchestrator/ports.js";
import { buildSummary, kitScore } from "../src/orchestrator/proof-score.js";

const IDS_TDM210: Record<string, string> = {
  "claude-code-solo": "0190f5a0-0000-7000-8000-000000021001",
  tandem: "0190f5a0-0000-7000-8000-000000021002",
};

async function kitTdm210(): Promise<KitSpec> {
  const full = (await loadKit(path.join(defaultKitsDir(), CURATED_TANDEM_KIT))).spec;
  const fraction = RequirementSchema.parse({
    id: "tests-share",
    type: "measured",
    title: "Share of hidden tests passed",
    metric: "hidden_test_fraction",
    better: "higher",
    gate_id: "hidden-tests",
  });
  const perTest = RequirementSchema.parse({
    id: "cost-per-test",
    type: "measured",
    title: "Cost per hidden test passed",
    metric: "cost_micro_usd",
    unit: "micro-USD",
    better: "lower",
    gate_id: "hidden-tests",
    aggregate: "per_test_passed",
  });
  const wall = full.requirements.find((r) => r.type === "measured" && r.metric === "wall_s")!;
  return {
    ...full,
    contenders: full.contenders.filter((c) => c.id in IDS_TDM210),
    vary: {},
    workloads: full.workloads.slice(0, 1),
    requirements: [fraction, perTest, wall],
    scoring: { weights: { "tests-share": 80, "cost-per-test": 10, [wall.id]: 10 } },
    repeats: 3,
  } as KitSpec;
}

/** 3 repeats per setup on one task; nobody passes all 40 hidden tests. */
function trialsTdm210(kit: KitSpec): StageTrial[] {
  const passed: Record<string, number[]> = {
    "claude-code-solo": [10, 14, 12],
    tandem: [30, 34, 36],
  };
  const w = kit.workloads[0]!.id;
  return kit.contenders.flatMap((c) =>
    passed[c.id]!.map((k, repeat) => ({
      id: `${c.id}-${repeat}`,
      contender: c.id,
      contender_id: IDS_TDM210[c.id]!,
      workload_id: w,
      repeat,
      state: "done" as const,
      attempt: 1,
      metrics: {
        wall_s: 4000 + 100 * repeat,
        hidden_test_fraction: k / 40,
        hidden_tests_passed: k,
        hidden_tests_total: 40,
      },
      gate: { "hidden-tests": { pass: false, reason: `${k}/40`, evidence: [] } },
      cost_micro_usd: 10_000_001n,
    })),
  );
}

describe("TDM-210 hidden-test fraction in the report", () => {
  it("reports the fraction and cost per test with 0% fully passing, gates the time, and says not significant", async () => {
    const kit = await kitTdm210();
    const trials = trialsTdm210(kit);
    const score = await kitScore()({} as StageContext, { kit_id: "k", kit, trials });
    if (!score.ok) throw new Error(score.reason);
    const r = buildSummary({ kit, score: score.value, proof: [], trials });
    if (!r.ok) throw new Error(r.reason);
    const { report, md } = r.analysis;
    const tandem = report.contenders.find((c) => (c.contender_id as string) === IDS_TDM210.tandem)!;
    const byId = (cid: string, rid: string) =>
      report.contenders
        .find((c) => (c.contender_id as string) === IDS_TDM210[cid])!
        .requirements.find((x) => x.requirement_id === rid)!;
    const share = byId("tandem", "tests-share");
    expect(share).toMatchObject({ aggregate: "all_trials", unit: "ratio", gate_pass_rate: 0 });
    expect(share.value).toBeCloseTo(100 / 120, 12);
    // 3 × 10,000,001 µ$ over 100 tests = 300,000.03 → 300,000 (integer micro-USD).
    expect(byId("tandem", "cost-per-test")).toMatchObject({
      aggregate: "per_test_passed",
      value: 300_000,
    });
    // No speed number without a passing trial.
    const wallId = kit.requirements[2]!.id;
    expect(byId("tandem", wallId).value).toBeNull();
    expect(share.comparison?.verdict).toBe("indistinguishable");
    expect(share.comparison?.statement).toContain("not significant");
    expect(tandem.wins).toEqual([]);
    expect(md).toContain(
      "not significant: n=3 vs 3 is too small for any difference to be significant",
    );
    expect(md).not.toMatch(/\b(beats|better than)\b/i);
    expect(
      ReportSchema.safeParse({
        ...report,
        run_id: "0190f5a0-0000-7000-8000-0000000210ff",
        kit_id: null,
        comped: true,
      }).success,
    ).toBe(true);
  });
});
