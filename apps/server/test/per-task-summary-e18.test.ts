// E18: the head-to-head profile's per-task results end to end without a DB: settled trials →
// kitScore → buildSummary → the report JSON GET /runs/:id/report serves (ReportSchema).
import path from "node:path";
import { mulberry32 } from "@anybench/bench";
import { ReportSchema, type KitSpec } from "@anybench/core";
import { loadKit } from "@anybench/kit";
import { describe, expect, it } from "vitest";
import {
  CURATED_TANDEM_KIT,
  defaultKitsDir,
  HEAD_TO_HEAD_TANDEM_NAME,
  headToHeadProfile,
} from "../src/orchestrator/curated.js";
import type { StageContext, StageTrial } from "../src/orchestrator/ports.js";
import { buildSummary, kitScore, TANDEM_DISCLOSURE } from "../src/orchestrator/proof-score.js";

const IDS_E18PT: Record<string, string> = {
  "claude-code-solo": "0190f5a0-0000-7000-8000-0000000e18a1",
  tandem: "0190f5a0-0000-7000-8000-0000000e18c3",
};

async function h2hE18pt(): Promise<KitSpec> {
  const full = (await loadKit(path.join(defaultKitsDir(), CURATED_TANDEM_KIT))).spec;
  const r = headToHeadProfile(full);
  if (!r.ok) throw new Error(r.reason);
  return r.spec;
}

/** Settled trials: per-task difficulty shared by both arms; Tandem `speed`× the time and cost. */
function trialsE18pt(kit: KitSpec, seed: number, speed: number): StageTrial[] {
  const rand = mulberry32(seed);
  const out: StageTrial[] = [];
  for (const w of kit.workloads) {
    const wall = 600 + 1500 * rand();
    const cost = 400_000 + 1_000_000 * rand();
    for (const c of kit.contenders) {
      const k = c.id === "tandem" ? speed : 1;
      for (let repeat = 0; repeat < kit.repeats; repeat++) {
        const api = w.id === "todo-api";
        out.push({
          id: `${c.id}-${w.id}-${repeat}`,
          contender: c.id,
          contender_id: IDS_E18PT[c.id]!,
          workload_id: w.id,
          repeat,
          state: "done",
          attempt: 1,
          metrics: {
            wall_s: wall * k * (0.85 + 0.3 * rand()),
            ...(api ? { api_p95_ms: 90 + 20 * rand() } : {}),
          },
          gate: {
            "hidden-tests": { pass: true, reason: "all hidden tests pass", evidence: [] },
            "api-load": api
              ? { pass: true, reason: "p95 measured", evidence: [] }
              : { pass: false, applicable: false, reason: "not applicable", evidence: [] },
          },
          cost_micro_usd: BigInt(Math.round(cost * k * (0.85 + 0.3 * rand()))),
        });
      }
    }
  }
  return out;
}

async function summaryE18pt(seed: number, speed: number) {
  const kit = await h2hE18pt();
  const trials = trialsE18pt(kit, seed, speed);
  const score = await kitScore()({} as StageContext, { kit_id: "k", kit, trials });
  if (!score.ok) throw new Error(score.reason);
  const r = buildSummary({
    kit,
    score: score.value,
    proof: [],
    trials,
    disclosure: TANDEM_DISCLOSURE,
  });
  if (!r.ok) throw new Error(r.reason);
  return { kit, ...r.analysis };
}

const SCOPE_E18PT =
  "3 tasks: this doesn't generalise to other tasks; ≥8 tasks needed for a general claim.";

describe("head-to-head per-task results in the report (E18)", () => {
  it("the profile runs 6 repeats (the fewest a per-task verdict can reach) and names Tandem ×3", async () => {
    const kit = await h2hE18pt();
    expect(kit.repeats).toBe(6);
    expect(kit.contenders.find((c) => c.id === "tandem")!.name).toBe(HEAD_TO_HEAD_TANDEM_NAME);
  });

  it("Tandem 2.5× faster and cheaper: the headline says so per task, with the scope line", async () => {
    const { md, report } = await summaryE18pt(11, 0.4);
    expect(report.answer).toMatch(
      /^On the tasks tested: Tandem ×3 was faster on all 3 tasks tested; Tandem ×3 was cheaper on all 3 tasks tested\. Result on tests-pass/,
    );
    expect(report.answer).toContain(SCOPE_E18PT);
    // The general claim stays task-paired and says why it can't conclude.
    expect(report.answer).toContain("insufficient tasks for a general claim");
    // 10 tests: tests-pass, wall and cost on 3 tasks, api-p95 on todo-api; quality isn't reviewed
    // (no reviewer yet), so it is unscored and out of the family.
    expect(report.per_task).toMatchObject({
      tasks: ["todo-api", "auth-refactor", "bug-hunt"],
      family: 10,
      scope: SCOPE_E18PT,
    });
    const tandem = report.contenders.find((c) => c.name === HEAD_TO_HEAD_TANDEM_NAME)!;
    const wall = tandem.requirements.find((r) => r.requirement_id === "wall")!;
    expect(wall.comparison!.test).toBe("task_paired");
    expect(wall.comparison!.verdict).toBe("indistinguishable");
    expect(wall.by_task!.map((t) => [t.workload_id, t.comparison.verdict])).toEqual([
      ["todo-api", "better"],
      ["auth-refactor", "better"],
      ["bug-hunt", "better"],
    ]);
    for (const t of wall.by_task!) {
      expect(t.comparison).toMatchObject({ claim: "these_tasks", family: 10, n: { tasks: 1 } });
      // At 6 vs 6 and α/10 no |δ| ≤ 1 has 80% power (a full split is significant, nothing less
      // reliably is): the MDE says so rather than inventing one.
      expect(t.comparison.mde).toMatchObject({ value: null, unit: "cliffs_delta" });
    }
    // The baseline carries no per-task results; the report is valid as GET /runs/:id/report serves it.
    const solo = report.contenders.find((c) => c.role === "baseline")!;
    expect(solo.requirements.every((r) => r.by_task === undefined)).toBe(true);
    expect(
      ReportSchema.safeParse({
        ...report,
        run_id: "0190f5a0-0000-7000-8000-0000000e18ff",
        kit_id: null,
        comped: true,
      }).success,
    ).toBe(true);
    expect(md).toContain(
      "Per task (each task's repeats as the unit; Holm across 10 task × requirement tests; 3 tasks:",
    );
    expect(md).toMatch(/- Tandem ×3 on todo-api: better: Cliff's δ \+1\.00/);
  });

  it("A/A: no per-task headline, every task 'no detectable difference', the scope line still there", async () => {
    const { report } = await summaryE18pt(5, 1);
    expect(report.per_task!.headline).toEqual([]);
    expect(report.answer).toMatch(/^Result on tests-pass/);
    expect(report.answer).toContain(SCOPE_E18PT);
    const tandem = report.contenders.find((c) => c.role !== "baseline")!;
    for (const r of tandem.requirements)
      for (const t of r.by_task ?? [])
        expect(t.comparison.statement).toMatch(/^no detectable difference at n=/);
  });
});
