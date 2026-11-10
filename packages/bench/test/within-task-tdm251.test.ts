// TDM-251 [21.11]: a single-task kit compares each setup with the baseline WITHIN its one task:
// the exact two-sample permutation test on the trials' values (difference in means), Holm across
// the family, the floor at these n's, the effect, and "on this task only". The task-paired test
// over tasks can't go below p = 1 at one task, so it is not run there (it stays for multi-task
// kits). And the permutation floor is 1 / C(n1+n2, n1) when n1 ≠ n2, not 2 / C.
//
// The numbers are harness league run 1's (run 01a1c202, docs/findings/harness-league-run-1.md
// section 5): per-trial wall_s and cost (compute share + metered tokens) of the gated setups.
import type { Requirement } from "@anybench/core";
import { RequirementSchema } from "@anybench/core";
import { describe, expect, it } from "vitest";
import {
  attainableFloor,
  fisherExact,
  holmAdjust,
  holmFloors,
  mannWhitney,
  minMannWhitneyP,
  minPermutationP,
  permutationMeanTest,
  scoreKit,
  type ScoreKitInput,
  type ScoredRequirement,
  type TrialResult,
} from "../src/index.js";

/** Run 01a1c202, the gated setups (B is out: none of its trials has a passing gate). */
const LEAGUE_01A1C202 = {
  "A solo": {
    wall_s: [642.446, 630.258, 701.467, 652.07],
    cost_reported: [2625662, 2657213, 2939402, 2513841],
    cost_claude_code: [2625661, 2657212, 2939401, 2513840],
  },
  "G gstack": {
    wall_s: [664.573, 653.856, 720.227, 625.482, 695.648],
    cost_reported: [2788141, 2798629, 2696436, 2421832, 2986190],
    cost_claude_code: [2788141, 2798628, 2696436, 2421832, 2986189],
  },
  "D tandem": {
    wall_s: [1267.814, 1615.147, 1337.608],
    cost_reported: [17135140, 21390834, 13712507],
    cost_claude_code: [12335519, 11048565, 8602066],
  },
  "S superpowers": {
    wall_s: [646.02, 704.697, 622.406, 651.233],
    cost_reported: [2857636, 2944093, 2694169, 2581673],
    cost_claude_code: [2857635, 2944092, 2694169, 2581672],
  },
} as const;
type Setup251 = keyof typeof LEAGUE_01A1C202;
const SETUPS_251: Setup251[] = ["G gstack", "D tandem", "S superpowers"];
const BASE_251: Setup251 = "A solo";

describe("the permutation test's floor (TDM-251)", () => {
  it("is 1 / C(n1+n2, n1) at n1 ≠ n2 and 2 / C at n1 = n2; Mann–Whitney's is always 2 / C", () => {
    // The league's pairs vs solo (n=4): G 5, S 4, D 3 trials.
    expect(minPermutationP(5, 4)).toBeCloseTo(1 / 126, 12); // 0.0079
    expect(minPermutationP(4, 4)).toBeCloseTo(2 / 70, 12); // 0.0286
    expect(minPermutationP(3, 4)).toBeCloseTo(1 / 35, 12); // 0.0286, not 2/35
    expect(minMannWhitneyP(5, 4)).toBeCloseTo(2 / 126, 12); // 0.0159
    expect(minMannWhitneyP(4, 4)).toBeCloseTo(2 / 70, 12);
    expect(minMannWhitneyP(3, 4)).toBeCloseTo(2 / 35, 12); // 0.0571
    expect(minPermutationP(3, 3)).toBeCloseTo(0.1, 12);
    expect(minPermutationP(1, 1)).toBe(1);
  });

  it("the floor is reached: 3 vs 4 at total separation, permutation and Fisher both give 1/35", () => {
    const d = LEAGUE_01A1C202["D tandem"].wall_s;
    const a = LEAGUE_01A1C202["A solo"].wall_s;
    expect(permutationMeanTest(d, a)).toEqual({ p: 1 / 35, method: "exact" });
    // Mann–Whitney's rank sums are symmetric, so the same data give 2/35.
    expect(mannWhitney(d, a).p).toBeCloseTo(2 / 35, 12);
    // 3 of 3 vs 0 of 4: the only table that extreme with these margins.
    expect(fisherExact(3, 3, 0, 4)).toBeCloseTo(1 / 35, 12);
    // The floor decide() states and checks "too small" against is the test's own.
    const n = { candidate: 3, baseline: 4, tasks: 1 };
    expect(attainableFloor({ test: "permutation_exact", n })).toBeCloseTo(1 / 35, 12);
    expect(attainableFloor({ test: "fisher_exact", n })).toBeCloseTo(1 / 35, 12);
    expect(attainableFloor({ test: "mann_whitney_exact", n })).toBeCloseTo(2 / 35, 12);
  });

  it("Holm floors: the smallest adjusted p each comparison can reach given the family's floors", () => {
    // The league's family of 6: G wall, G cost (5 vs 4), D × 2 (3 vs 4), S × 2 (4 vs 4).
    const floors = [1 / 126, 1 / 126, 1 / 35, 1 / 35, 2 / 70, 2 / 70];
    const hf = holmFloors(floors);
    // G could reach 6 × 1/126 = 0.048 < 0.05: the only pair that could be significant at all.
    expect(hf[0]).toBeCloseTo(6 / 126, 12);
    expect(hf[0]).toBeLessThan(0.05);
    // D and S: best with both G comparisons ahead at their floors: max(6/126, 5/126, 4/35).
    expect(hf[2]).toBeCloseTo(4 / 35, 12);
    expect(hf[4]).toBeCloseTo(4 / 35, 12);
    for (const f of hf.slice(2)) expect(f).toBeGreaterThanOrEqual(0.05);
    // As the findings' table puts it: m × floor if a comparison is the family's smallest p.
    expect(6 * minPermutationP(3, 4)).toBeCloseTo(0.1714, 4);
    expect(6 * minPermutationP(4, 4)).toBeCloseTo(0.1714, 4);
    expect(6 * minPermutationP(5, 4)).toBeCloseTo(0.0476, 4);
    // A single comparison's Holm floor is its floor; a floor-0 (asymptotic) peer costs nothing.
    expect(holmFloors([0.1])).toEqual([0.1]);
    expect(holmFloors([0, 0.02])[1]).toBeCloseTo(0.02, 12);
  });
});

describe("TDM-229's within-task numbers, reproduced from run 01a1c202's values", () => {
  const mean = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const family = (cost: "cost_reported" | "cost_claude_code") =>
    SETUPS_251.flatMap((setup) =>
      (["wall_s", cost] as const).map((metric) => {
        const x = LEAGUE_01A1C202[setup][metric];
        const y = LEAGUE_01A1C202[BASE_251][metric];
        return {
          key: `${setup} ${metric}`,
          ratio: mean(x) / mean(y),
          p: permutationMeanTest(x, y).p,
          mw: mannWhitney(x, y).p,
          floor: minPermutationP(x.length, y.length),
        };
      }),
    );

  it("wall + reported cost: the table in section 5 (6 comparisons vs A solo, Holm)", () => {
    const rows = family("cost_reported");
    const holm = holmAdjust(rows.map((r) => r.p));
    const got = Object.fromEntries(
      rows.map((r, i) => [
        r.key,
        [+r.ratio.toFixed(3), +r.p.toFixed(4), +r.mw.toFixed(4), +holm[i]!.toFixed(4)],
      ]),
    );
    expect(got).toEqual({
      "G gstack wall_s": [1.023, 0.5079, 0.5556, 1],
      "G gstack cost_reported": [1.02, 0.6825, 0.5556, 1],
      "D tandem wall_s": [2.143, 0.0286, 0.0571, 0.1714],
      "D tandem cost_reported": [6.488, 0.0286, 0.0571, 0.1714],
      "S superpowers wall_s": [0.999, 0.9714, 1, 1],
      "S superpowers cost_reported": [1.032, 0.5429, 0.4857, 1],
    });
  });

  it("wall + Claude Code's own cost: Tandem's cost is still p=0.0286, Holm 0.171", () => {
    const rows = family("cost_claude_code");
    const holm = holmAdjust(rows.map((r) => r.p));
    const i = rows.findIndex((r) => r.key === "D tandem cost_claude_code");
    expect(rows[i]!.ratio).toBeCloseTo(3.972, 3);
    expect(rows[i]!.p).toBeCloseTo(0.0286, 4);
    expect(holm[i]).toBeCloseTo(0.1714, 4);
  });
});

// ---------------------------------------------------------------------------------------------
// The scorer on a one-task harness kit with the league's two speed/cost requirements.

const req251 = (r: unknown): Requirement => RequirementSchema.parse(r);
const WALL_251 = req251({
  id: "wall",
  type: "measured",
  title: "wall-clock time to solve",
  metric: "wall_s",
  unit: "s",
  better: "lower",
  gate_id: "hidden-tests",
  cap: 10_800,
});
const COST_251 = req251({
  id: "cost",
  type: "measured",
  title: "cost per solved task",
  metric: "cost_micro_usd",
  unit: "micro-USD",
  better: "lower",
  gate_id: "hidden-tests",
});

function kit251(workloads: string[] = ["project-tracker"]): ScoreKitInput {
  return {
    requirements: [WALL_251, COST_251],
    scoring: { weights: { wall: 50, cost: 50 }, primary: "wall" },
    subject: { kind: "harness" },
    workloads: workloads.map((id) => ({ id, timeout_s: 10_800 })),
    contenders: (["A solo", ...SETUPS_251] as const).map((id) => ({
      id,
      role: id === BASE_251 ? ("baseline" as const) : ("subject" as const),
      driver: { type: "harness" as const },
    })),
  } as ScoreKitInput;
}

function trials251(workloads: string[] = ["project-tracker"]): TrialResult[] {
  const out: TrialResult[] = [];
  for (const w of workloads) {
    for (const setup of [BASE_251, ...SETUPS_251]) {
      const v = LEAGUE_01A1C202[setup];
      v.wall_s.forEach((wall, repeat) =>
        out.push({
          contenderId: setup,
          workloadId: w,
          repeat,
          metrics: { wall_s: wall, cost_micro_usd: v.cost_reported[repeat]! },
          gates: { "hidden-tests": { pass: true, reason: "120/120", evidence: [] } },
        }),
      );
    }
  }
  return out;
}

const reqOf251 = (ks: ReturnType<typeof scoreKit>, c: string, id: string) => {
  const r = ks.contenders
    .find((x) => x.contenderId === c)!
    .requirements.find((x) => x.requirementId === id)!;
  if (!r.scored) throw new Error(`${c}/${id} unscored: ${r.reason}`);
  return r as ScoredRequirement;
};

describe("a single-task kit reports within-task verdicts (TDM-251)", () => {
  const ks = scoreKit(kit251(), trials251(), { baseline: BASE_251 });

  it("every comparison is the exact permutation test on the trials, Holm across the 6", () => {
    expect(ks.stats.singleTask).toBe(true);
    expect(ks.stats.family).toBe(6);
    expect(ks.stats.perTask!.family).toBe(6);
    for (const setup of SETUPS_251) {
      for (const id of ["wall", "cost"]) {
        const c = reqOf251(ks, setup, id).comparison!;
        expect(c.test, `${setup}/${id}`).toBe("permutation_exact");
        expect(c.claim).toBe("these_tasks");
        expect(c.family).toBe(6);
        expect(c.n.tasks).toBe(1);
        // The requirement's comparison IS the task's: no task-paired p=1.
        expect(reqOf251(ks, setup, id).byWorkload[0]!.taskComparison).toEqual(c);
        expect(c.statement).not.toMatch(/insufficient tasks|over 1 task/);
      }
    }
  });

  it("Tandem: p=0.0286 raw, 0.171 Holm, floor 1/35; slower and dearer but not significant after Holm", () => {
    for (const id of ["wall", "cost"]) {
      const c = reqOf251(ks, "D tandem", id).comparison!;
      expect(c.p).toBeCloseTo(0.0286, 4);
      expect(c.pAdjusted).toBeCloseTo(0.1714, 4);
      expect(c.pFloor).toBeCloseTo(1 / 35, 12);
      expect(c.pAdjustedFloor).toBeCloseTo(4 / 35, 12);
      expect(c.verdict).toBe("indistinguishable");
      expect(c.downgraded).toBe("multiplicity");
      // The effect: every Tandem trial slower and dearer than every solo trial.
      expect(c.effect).toMatchObject({ measure: "cliffs_delta", value: -1 });
    }
    const wall = reqOf251(ks, "D tandem", "wall").comparison!;
    expect(wall.effect.candidateMean! / wall.effect.baselineMean!).toBeCloseTo(2.143, 3);
    expect(wall.statement).toMatch(/^no detectable difference at n=3 vs 4/);
    expect(wall.statement).toContain("mean 1407 s vs 657 s (2.14×)");
    expect(wall.statement).toContain(
      "exact permutation p=0.029 is not significant after Holm correction across 6 tests (Holm p=0.171)",
    );
    expect(wall.statement).toContain(
      "too small for any difference to be significant after Holm across 6 comparisons (the exact test can't go below p=0.029, Holm p below 0.114)",
    );
    const cost = reqOf251(ks, "D tandem", "cost").comparison!;
    expect(cost.statement).toContain("mean $17.41 vs $2.68 (6.49×)");
  });

  it("gstack and Superpowers: the run's p's; gstack's floor is the only one Holm could pass", () => {
    const p = (setup: Setup251, id: string) => reqOf251(ks, setup, id).comparison!;
    expect(p("G gstack", "wall").p).toBeCloseTo(0.5079, 4);
    expect(p("G gstack", "cost").p).toBeCloseTo(0.6825, 4);
    expect(p("S superpowers", "wall").p).toBeCloseTo(0.9714, 4);
    expect(p("S superpowers", "cost").p).toBeCloseTo(0.5429, 4);
    for (const s of ["G gstack", "S superpowers"] as const)
      for (const id of ["wall", "cost"]) expect(p(s, id).pAdjusted).toBe(1);
    expect(p("G gstack", "wall").pFloor).toBeCloseTo(1 / 126, 12);
    expect(p("G gstack", "wall").pAdjustedFloor).toBeCloseTo(6 / 126, 12);
    expect(p("S superpowers", "wall").pFloor).toBeCloseTo(2 / 70, 12);
    // gstack could have been significant: its statement states the floor, not "too small".
    expect(p("G gstack", "wall").statement).toContain(
      "exact permutation p=0.508, Holm p=1.000 across 6 tests; at n=5 vs 4 the exact test can't go below p=0.008",
    );
    expect(p("S superpowers", "wall").statement).toContain("Holm p below 0.114");
  });

  it("the scope line: on this task only, no general claim from 1 task", () => {
    expect(ks.stats.perTask!.scope).toMatch(
      /^On this task only \(project-tracker\); no general claim from 1 task: ≥\d+ tasks needed for one\.$/,
    );
    expect(ks.stats.headline.map((h) => h.contenderId)).toEqual(SETUPS_251);
    for (const h of ks.stats.headline)
      expect(h.statement).not.toMatch(/insufficient tasks|over 1 task|can't go below p=1\.000/);
  });

  it("a clear within-task difference at 5 vs 5 is a verdict 'on this task', with the test and floor", () => {
    const trials: TrialResult[] = [];
    for (let r = 0; r < 5; r++) {
      for (const [c, k] of [
        ["A solo", 1],
        ["D tandem", 2],
      ] as const) {
        trials.push({
          contenderId: c,
          workloadId: "project-tracker",
          repeat: r,
          metrics: { wall_s: (640 + 10 * r) * k, cost_micro_usd: (2_600_000 + 50_000 * r) * k },
          gates: { "hidden-tests": { pass: true, reason: "120/120", evidence: [] } },
        });
      }
    }
    const kit = kit251();
    kit.contenders = kit.contenders!.filter((c) => c.id === "A solo" || c.id === "D tandem");
    const s = scoreKit(kit, trials, { baseline: BASE_251 });
    const wall = reqOf251(s, "D tandem", "wall").comparison!;
    expect(wall.p).toBeCloseTo(2 / 252, 12); // 5 vs 5: 2 / C(10, 5)
    expect(wall.pAdjusted).toBeCloseTo(4 / 252, 12); // Holm × 2
    expect(wall.verdict).toBe("worse");
    expect(wall.statement).toMatch(
      /^worse on this task: Cliff's δ −1\.00, mean 1320 s vs 660 s \(2\.00×\), shift .*, exact permutation p=0\.008, Holm p=0\.016 across 2 tests, n=5 vs 5$/,
    );
    expect(s.stats.perTask!.headline[0]!.where).toBe("on this task");
    expect(s.stats.perTask!.headline.map((h) => h.adjective)).toEqual(["slower", "more expensive"]);
  });

  it("a failed trial's spend (∞) falls back to exact Mann–Whitney; a multi-task kit stays task-paired", () => {
    const trials = trials251().map((t) =>
      t.contenderId === "D tandem" && t.repeat === 0
        ? { ...t, gates: { "hidden-tests": { pass: false, reason: "119/120", evidence: [] } } }
        : t,
    );
    const s = scoreKit(kit251(), trials, { baseline: BASE_251 });
    expect(reqOf251(s, "D tandem", "cost").comparison!.test).toBe("mann_whitney_exact");
    // Wall counts the failure at the cap (finite): still the permutation test.
    expect(reqOf251(s, "D tandem", "wall").comparison!.test).toBe("permutation_exact");

    const two = scoreKit(kit251(["a", "b"]), trials251(["a", "b"]), { baseline: BASE_251 });
    expect(two.stats.singleTask).toBeUndefined();
    const c = reqOf251(two, "D tandem", "wall");
    expect(c.comparison!.test).toBe("task_paired");
    expect(c.byWorkload[0]!.taskComparison!.test).toBe("permutation_exact");
    expect(two.stats.perTask!.family).toBe(12);
  });
});
