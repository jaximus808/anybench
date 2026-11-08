// Regression (run 01a1bae4, the first real head-to-head, delivered 2026-11-08): Tandem ×3 took
// 2–6× the wall time and 6–10× the cost of Claude Code solo on every task, yet the report's
// per-task headline was empty. The headline only spoke when EVERY task's own verdict agreed, and
// todo-api is "no detectable difference" after Holm (each side failed a trial there: a failure
// counts at the cap / as unsolved spend, so its δ is −0.72, p=0.041 > Holm's 0.05/6). The four
// significant per-task verdicts (wall and cost on auth-refactor and bug-hunt, Holm p=0.022) never
// reached the answer. These are that run's real per-trial numbers (trials.metrics.wall_s,
// trials.cost_micro_usd, and each trial's gate verdicts).
import path from "node:path";
import { ReportSchema, type KitSpec } from "@anybench/core";
import { loadKit } from "@anybench/kit";
import { describe, expect, it } from "vitest";
import {
  CURATED_TANDEM_KIT,
  defaultKitsDir,
  headToHeadProfile,
} from "../src/orchestrator/curated.js";
import type { StageContext, StageTrial } from "../src/orchestrator/ports.js";
import { renderRunEmail } from "../src/lib/run-email.js";
import { buildSummary, kitScore, TANDEM_DISCLOSURE } from "../src/orchestrator/proof-score.js";

const IDS_01A1: Record<string, string> = {
  "claude-code-solo": "0190f5a0-0000-7000-8000-00000001a1a1",
  tandem: "0190f5a0-0000-7000-8000-00000001a1c3",
};

/** [setup, task, repeat, wall_s, cost micro-USD, hidden-tests pass, api-load pass (null = n/a), api_p95_ms] */
type Row01a1 = [string, string, number, number, number, boolean, boolean | null, number | null];
const RUN_01A1: Row01a1[] = [
  ["claude-code-solo", "auth-refactor", 0, 94.931, 499772, true, null, null],
  ["claude-code-solo", "auth-refactor", 1, 101.392, 375428, true, null, null],
  ["claude-code-solo", "auth-refactor", 2, 82.432, 279480, true, null, null],
  ["claude-code-solo", "auth-refactor", 3, 109.552, 417340, true, null, null],
  ["claude-code-solo", "auth-refactor", 4, 100.53, 516670, true, null, null],
  ["claude-code-solo", "auth-refactor", 5, 96.623, 509232, true, null, null],
  ["tandem", "auth-refactor", 0, 263.653, 2527406, true, null, null],
  ["tandem", "auth-refactor", 1, 227.921, 2187588, true, null, null],
  ["tandem", "auth-refactor", 2, 313.961, 2613323, true, null, null],
  ["tandem", "auth-refactor", 3, 240.927, 2487384, true, null, null],
  ["tandem", "auth-refactor", 4, 272.232, 2292025, true, null, null],
  ["tandem", "auth-refactor", 5, 251.057, 2312124, true, null, null],
  ["claude-code-solo", "bug-hunt", 0, 44.109, 232857, true, null, null],
  ["claude-code-solo", "bug-hunt", 1, 38.264, 119880, true, null, null],
  ["claude-code-solo", "bug-hunt", 2, 41.553, 120152, true, null, null],
  ["claude-code-solo", "bug-hunt", 3, 39.09, 135915, true, null, null],
  ["claude-code-solo", "bug-hunt", 4, 36.044, 218929, true, null, null],
  ["claude-code-solo", "bug-hunt", 5, 47.156, 139420, true, null, null],
  ["tandem", "bug-hunt", 0, 241.972, 1869859, true, null, null],
  ["tandem", "bug-hunt", 1, 173.81, 1743256, true, null, null],
  ["tandem", "bug-hunt", 2, 184.476, 1783802, true, null, null],
  ["tandem", "bug-hunt", 3, 222.271, 2124647, true, null, null],
  ["tandem", "bug-hunt", 4, 267.791, 1800037, true, null, null],
  ["tandem", "bug-hunt", 5, 201.141, 1862258, true, null, null],
  ["claude-code-solo", "todo-api", 0, 76.668, 280274, true, true, 2.21],
  ["claude-code-solo", "todo-api", 1, 86.901, 408696, false, false, null],
  ["claude-code-solo", "todo-api", 2, 87.85, 278726, true, true, 2.196],
  ["claude-code-solo", "todo-api", 3, 97.943, 332588, true, true, 2.121],
  ["claude-code-solo", "todo-api", 4, 79.705, 384680, true, true, 2.172],
  ["claude-code-solo", "todo-api", 5, 85.778, 386511, true, true, 2.045],
  ["tandem", "todo-api", 0, 218.358, 3247863, true, true, 2.461],
  ["tandem", "todo-api", 1, 255.699, 2800340, false, false, null],
  ["tandem", "todo-api", 2, 291.815, 2447238, true, true, 2.234],
  ["tandem", "todo-api", 3, 260.794, 2696357, true, true, 2.332],
  ["tandem", "todo-api", 4, 225.466, 2357225, false, false, null],
  ["tandem", "todo-api", 5, 246.304, 2603389, true, true, 2.082],
];

function trials01a1(): StageTrial[] {
  return RUN_01A1.map(([contender, workload, repeat, wall, cost, hidden, api, p95]) => ({
    id: `${contender}-${workload}-${repeat}`,
    contender,
    contender_id: IDS_01A1[contender]!,
    workload_id: workload,
    repeat,
    state: "done",
    attempt: 1,
    metrics: { wall_s: wall, ...(p95 === null ? {} : { api_p95_ms: p95 }) },
    gate: {
      "hidden-tests": {
        pass: hidden,
        reason: hidden ? "pass" : "15/16 hidden tests passed",
        evidence: [],
      },
      "api-load":
        api === null
          ? { pass: false, applicable: false, reason: "not applicable", evidence: [] }
          : {
              pass: api,
              reason: api ? "p95 measured" : "no latency without correctness",
              evidence: [],
            },
    },
    cost_micro_usd: BigInt(cost),
  }));
}

async function summary01a1() {
  const full = (await loadKit(path.join(defaultKitsDir(), CURATED_TANDEM_KIT))).spec;
  const h2h = headToHeadProfile(full);
  if (!h2h.ok) throw new Error(h2h.reason);
  const kit: KitSpec = h2h.spec;
  const trials = trials01a1();
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
  return r.analysis;
}

const HEADLINE_01A1 =
  "Tandem ×3 was slower and more expensive on 2 of 3 tasks tested (auth-refactor and bug-hunt; no detectable difference on todo-api)";

describe("run 01a1bae4: per-task wall/cost findings reach the headline", () => {
  it("the fixture is the run: 36 trials, 2 setups × 3 tasks × 6 repeats, 3 failures on todo-api", () => {
    expect(RUN_01A1).toHaveLength(36);
    expect(RUN_01A1.filter((r) => !r[5]).map((r) => `${r[0]}/${r[1]}/${r[2]}`)).toEqual([
      "claude-code-solo/todo-api/1",
      "tandem/todo-api/1",
      "tandem/todo-api/4",
    ]);
  });

  it("headline: Tandem ×3 slower and more expensive where it is significant, todo-api named as inconclusive", async () => {
    const { report, md } = await summary01a1();
    expect(report.per_task!.headline).toEqual([HEADLINE_01A1]);
    expect(report.per_task!.family).toBe(10);
    expect(
      report.answer.startsWith(`On the tasks tested: ${HEADLINE_01A1}. Result on tests-pass`),
    ).toBe(true);

    const tandem = report.contenders.find((c) => c.name === "Tandem ×3")!;
    const byTask = (id: string) =>
      Object.fromEntries(
        tandem.requirements
          .find((r) => r.requirement_id === id)!
          .by_task!.map((t) => [t.workload_id, t.comparison.verdict]),
      );
    for (const id of ["wall", "cost"]) {
      expect(byTask(id)).toEqual({
        "todo-api": "indistinguishable",
        "auth-refactor": "worse",
        "bug-hunt": "worse",
      });
    }
    // Honesty rules hold: pass rate is no detectable difference, overall and on every task.
    expect(byTask("tests-pass")).toEqual({
      "todo-api": "indistinguishable",
      "auth-refactor": "indistinguishable",
      "bug-hunt": "indistinguishable",
    });
    expect(report.answer).toContain(
      "Result on tests-pass (the primary requirement): tandem vs claude-code-solo: no detectable difference at n=3 tasks (18 vs 18 trials)",
    );
    expect(report.answer).toContain("insufficient tasks for a general claim");
    // No general claim from 3 tasks: wall and cost stay task-paired "no detectable difference".
    for (const id of ["wall", "cost"])
      expect(tandem.requirements.find((r) => r.requirement_id === id)!.comparison!.verdict).toBe(
        "indistinguishable",
      );
    expect(tandem.wins).toEqual([]);
    expect(tandem.losses).toEqual([]);
    expect(md).toMatch(/- Tandem ×3 on bug-hunt: worse: Cliff's δ −1\.00, shift 170 s/);
    expect(
      ReportSchema.safeParse({
        ...report,
        run_id: "0190f5a0-0000-7000-8000-00000001a1ff",
        kit_id: null,
        comped: true,
      }).success,
    ).toBe(true);
  });

  it("the run-finished email leads with the per-task finding, inconclusive task included", async () => {
    const { report } = await summary01a1();
    const full = ReportSchema.parse({
      ...report,
      run_id: "0190f5a0-0000-7000-8000-00000001a1ff",
      kit_id: null,
      comped: true,
    });
    const m = renderRunEmail({
      runId: full.run_id,
      state: "delivered",
      question: "Is Tandem ×3 faster or cheaper than plain Claude Code?",
      report: full,
      reason: null,
      nothingBilled: true,
      webUrl: "https://anybench.vercel.app/",
      postalAddress: null,
    });
    expect(m.subject).toBe(`Your Anybench result: ${HEADLINE_01A1}`);
    expect(m.text).toContain(`On the tasks tested: ${HEADLINE_01A1}.`);
    expect(m.text).toContain("no detectable difference at n=3 tasks (18 vs 18 trials)");
  });
});
