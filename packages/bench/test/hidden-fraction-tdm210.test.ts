// TDM-210 [18.3]: hidden_test_fraction is a correctness metric. It is averaged over EVERY trial
// (partial progress counts, no passing gate needed), compared by the difference in means
// (task-paired in agent kits, an exact permutation test per task), Holm-corrected with the rest,
// and at n=3 per setup the report says "not significant". Time and cost stay gated, and cost per
// hidden test passed (all spend ÷ Σ tests passed) is integer micro-USD.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RequirementResultSchema,
  RequirementSchema,
  safeParseKitSpec,
  type KitSpec,
} from "@anybench/core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  compareArms,
  decide,
  meanCi,
  minMannWhitneyP,
  permutationMeanTest,
  scoreKit,
  studentTQuantile,
  welchDiffCi,
  type ScoreKitInput,
  type ScoredRequirement,
  type TrialResult,
} from "../src/index.js";

const req = (r: unknown) => RequirementSchema.parse(r);

const fractionReqTdm210 = req({
  id: "tests",
  type: "measured",
  title: "share of hidden tests passed",
  metric: "hidden_test_fraction",
  better: "higher",
  gate_id: "hidden-tests",
});
const solvedReqTdm210 = req({
  id: "solved",
  type: "measured",
  title: "every hidden test passed",
  metric: "gate_pass_rate",
  better: "higher",
  gate_id: "hidden-tests",
});
const wallReqTdm210 = req({
  id: "wall",
  type: "measured",
  title: "time to solve",
  metric: "wall_s",
  unit: "s",
  better: "lower",
  gate_id: "hidden-tests",
  cap: 10_800,
});
const costReqTdm210 = req({
  id: "cost",
  type: "measured",
  title: "cost per solved task",
  metric: "cost_micro_usd",
  better: "lower",
  gate_id: "hidden-tests",
});
const perTestReqTdm210 = req({
  id: "cost-per-test",
  type: "measured",
  title: "cost per hidden test passed",
  metric: "cost_micro_usd",
  better: "lower",
  gate_id: "hidden-tests",
  aggregate: "per_test_passed",
});

function kitTdm210(
  reqs = [fractionReqTdm210, solvedReqTdm210, wallReqTdm210, costReqTdm210, perTestReqTdm210],
): ScoreKitInput {
  return {
    requirements: reqs,
    scoring: {
      weights: Object.fromEntries(
        reqs.map((r, i) => [r.id, i === 0 ? 100 - (reqs.length - 1) * 10 : 10]),
      ),
      primary: reqs[0]!.id,
    },
    subject: { kind: "harness" },
  };
}

interface T210 {
  c: string;
  w?: string;
  /** Hidden tests passed of `total`. The gate passes only at 100%. */
  passed: number;
  total?: number;
  wall?: number;
  cost?: number;
  /** Leave hidden_test_fraction out (an older grader). */
  noFraction?: boolean;
}

function trialsTdm210(specs: T210[]): TrialResult[] {
  const repeats = new Map<string, number>();
  return specs.map((t) => {
    const w = t.w ?? "app";
    const key = `${t.c}/${w}`;
    const repeat = repeats.get(key) ?? 0;
    repeats.set(key, repeat + 1);
    const total = t.total ?? 40;
    const pass = t.passed === total;
    return {
      contenderId: t.c,
      workloadId: w,
      repeat,
      metrics: {
        wall_s: t.wall ?? 3600,
        cost_micro_usd: t.cost ?? 10_000_000,
        hidden_tests_passed: t.passed,
        hidden_tests_total: total,
        ...(t.noFraction ? {} : { hidden_test_fraction: t.passed / total }),
      },
      gates: {
        "hidden-tests": {
          pass,
          reason: pass ? "all hidden tests pass" : `${t.passed}/${total}`,
          evidence: [],
        },
      },
    };
  });
}

const reqOf = (score: ReturnType<typeof scoreKit>, c: string, id: string) => {
  const r = score.contenders
    .find((x) => x.contenderId === c)!
    .requirements.find((x) => x.requirementId === id)!;
  if (!r.scored) throw new Error(`${c}/${id} unscored: ${r.reason}`);
  return r as ScoredRequirement;
};

describe("TDM-210 hidden_test_fraction: correctness over every trial", () => {
  it("is the mean over every trial, failed ones included, with no passing trial needed", () => {
    // Nobody passes every hidden test (the gate verdict stays 100%-only), but A gets further.
    const trials = trialsTdm210([
      { c: "A", passed: 30 },
      { c: "A", passed: 34 },
      { c: "A", passed: 38 },
      { c: "B", passed: 10 },
      { c: "B", passed: 20 },
      { c: "B", passed: 12 },
    ]);
    const s = scoreKit(kitTdm210(), trials, { baseline: "B" });
    const a = reqOf(s, "A", "tests");
    expect(a.aggregate).toBe("all_trials");
    expect(a.survivorship).toBe(false);
    expect(a.byWorkload[0]).toMatchObject({ status: "measured", trials: 3, solved: 0, n: 3 });
    expect(a.byWorkload[0]!.samples).toEqual([0.75, 0.85, 0.95]);
    expect(a.byWorkload[0]!.value).toBeCloseTo(0.85, 12);
    expect(a.fraction).toBeCloseTo(0.85, 12);
    expect(reqOf(s, "B", "tests").byWorkload[0]!.value).toBeCloseTo(42 / 120, 12);
    // The cell's own interval: Student t at n=3, clipped to [0, 1].
    expect(a.byWorkload[0]!.ci).toMatchObject({ method: "student_t", attained: true });
    const ci = a.byWorkload[0]!.ci!;
    expect(ci.lo).toBeLessThan(0.85);
    expect(ci.hi).toBeLessThanOrEqual(1);
    // The pass rate is still 0/3 for both: the 100%-only verdict is untouched.
    expect(reqOf(s, "A", "solved").byWorkload[0]).toMatchObject({ value: 0, solved: 0 });
  });

  it("time and cost stay gated: no wall_s or cost number from a failed trial", () => {
    const trials = trialsTdm210([
      { c: "A", passed: 40, wall: 1000, cost: 3_000_000 },
      { c: "A", passed: 39, wall: 100, cost: 1_000_000 },
      { c: "B", passed: 40, wall: 2000, cost: 2_000_000 },
      { c: "B", passed: 40, wall: 2000, cost: 2_000_000 },
    ]);
    const s = scoreKit(kitTdm210(), trials, { baseline: "B" });
    const wall = reqOf(s, "A", "wall").byWorkload[0]!;
    // The failed trial counts at the 3 h cap, never at its own 100 s.
    expect(wall.samples).toEqual([1000, 10_800]);
    const cost = reqOf(s, "A", "cost").byWorkload[0]!;
    // All spend ÷ solved tasks: 4,000,000 ÷ 1.
    expect(cost.value).toBe(4_000_000);
    // The fraction still credits the failed trial's 39/40.
    expect(reqOf(s, "A", "tests").byWorkload[0]!.value).toBeCloseTo((1 + 39 / 40) / 2, 12);
  });

  it("an older grader without the fraction falls back to the gate verdict (pass 1, fail 0)", () => {
    const trials = trialsTdm210([
      { c: "A", passed: 40, noFraction: true },
      { c: "A", passed: 30, noFraction: true },
      { c: "B", passed: 40 },
    ]);
    const s = scoreKit(kitTdm210([fractionReqTdm210]), trials, { baseline: "B" });
    expect(reqOf(s, "A", "tests").byWorkload[0]!.samples).toEqual([1, 0]);
  });

  it("refuses a fraction outside [0, 1], and a trial without the gate is 'gate missing'", () => {
    const bad = trialsTdm210([{ c: "A", passed: 10 }]);
    bad[0]!.metrics.hidden_test_fraction = 1.5;
    const s1 = scoreKit(kitTdm210([fractionReqTdm210]), bad);
    expect(s1.contenders[0]!.requirements[0]).toMatchObject({
      scored: false,
      code: "metric_invalid",
    });
    const noGate = trialsTdm210([{ c: "A", passed: 10 }]);
    noGate[0]!.gates = {};
    const s2 = scoreKit(kitTdm210([fractionReqTdm210]), noGate);
    expect(s2.contenders[0]!.requirements[0]).toMatchObject({
      scored: false,
      code: "gate_missing",
    });
  });

  it("scores every covered task, a 0 on a task nobody progressed on (never a gap)", () => {
    const trials = trialsTdm210([
      { c: "A", w: "app", passed: 20 },
      { c: "A", w: "cli", passed: 0 },
      { c: "B", w: "app", passed: 10 },
      { c: "B", w: "cli", passed: 0 },
    ]);
    const s = scoreKit(kitTdm210([fractionReqTdm210]), trials, { baseline: "B" });
    const a = reqOf(s, "A", "tests");
    expect(a.workloads).toEqual(["app", "cli"]);
    expect(a.fraction).toBeCloseTo((0.5 + 0) / 2, 12);
  });
});

describe("TDM-210 cost per hidden test passed", () => {
  it("is all spend ÷ Σ hidden tests passed, integer micro-USD rounded half up", () => {
    // Spend 1 + 2 + 2 = 5,000,001 µ$ over 10 + 20 + 0 = 30 tests (the third trial passed none).
    const trials = trialsTdm210([
      { c: "A", passed: 10, cost: 1_000_000 },
      { c: "A", passed: 20, cost: 2_000_000 },
      { c: "A", passed: 0, cost: 2_000_001 },
      { c: "B", passed: 40, cost: 9_000_000 },
    ]);
    const s = scoreKit(kitTdm210([fractionReqTdm210, perTestReqTdm210]), trials, {
      baseline: "B",
    });
    const cell = reqOf(s, "A", "cost-per-test").byWorkload[0]!;
    expect(cell.status).toBe("measured");
    expect(cell.testsPassed).toBe(30);
    // 5,000,001 / 30 = 166,666.7 → 166,667 (an integer: money is never a float).
    expect(cell.value).toBe(166_667);
    expect(Number.isInteger(cell.value)).toBe(true);
    // A half rounds up: 15 µ$ over 2 tests is 8.
    const half = scoreKit(
      kitTdm210([fractionReqTdm210, perTestReqTdm210]),
      trialsTdm210([{ c: "A", passed: 2, cost: 15 }]),
    );
    expect(reqOf(half, "A", "cost-per-test").byWorkload[0]!.value).toBe(8);
    // B: 9,000,000 / 40.
    expect(reqOf(s, "B", "cost-per-test").byWorkload[0]!.value).toBe(225_000);
  });

  it("no hidden test passed anywhere is 'unsolved' (no price), never a division by zero", () => {
    const trials = trialsTdm210([
      { c: "A", passed: 0, cost: 1_000_000 },
      { c: "B", passed: 5, cost: 1_000_000 },
    ]);
    const s = scoreKit(kitTdm210([fractionReqTdm210, perTestReqTdm210]), trials, {
      baseline: "B",
    });
    const cell = reqOf(s, "A", "cost-per-test").byWorkload[0]!;
    expect(cell).toMatchObject({ status: "unsolved", value: null, fraction: 0, testsPassed: 0 });
    expect(reqOf(s, "B", "cost-per-test").byWorkload[0]!.value).toBe(200_000);
  });

  it("counts tests from fraction × total when hidden_tests_passed is absent", () => {
    const trials = trialsTdm210([{ c: "A", passed: 25, total: 50, cost: 1_000_000 }]);
    delete trials[0]!.metrics.hidden_tests_passed;
    const s = scoreKit(kitTdm210([fractionReqTdm210, perTestReqTdm210]), trials);
    expect(reqOf(s, "A", "cost-per-test").byWorkload[0]).toMatchObject({
      testsPassed: 25,
      value: 40_000,
    });
  });
});

describe("TDM-210 statistics on the fraction", () => {
  it("studentTQuantile matches the t table (exact distribution function)", () => {
    expect(studentTQuantile(0.975, 1)).toBeCloseTo(12.7062, 4);
    expect(studentTQuantile(0.975, 2)).toBeCloseTo(4.3027, 4);
    expect(studentTQuantile(0.975, 3)).toBeCloseTo(3.1824, 4);
    expect(studentTQuantile(0.975, 4)).toBeCloseTo(2.7764, 4);
    expect(studentTQuantile(0.975, 10)).toBeCloseTo(2.2281, 4);
    expect(studentTQuantile(0.975, 30)).toBeCloseTo(2.0423, 4);
    expect(studentTQuantile(0.95, 5)).toBeCloseTo(2.015, 3);
    // Welch's non-integer df rounds down (wider).
    expect(studentTQuantile(0.975, 3.7)).toBe(studentTQuantile(0.975, 3));
    expect(studentTQuantile(0.025, 5)).toBeCloseTo(-studentTQuantile(0.975, 5), 12);
  });

  it("meanCi and welchDiffCi: t intervals, clipped, the whole range at n=1", () => {
    const m = meanCi([0.5, 0.6, 0.7]);
    // 0.6 ± 4.303 · 0.1 / √3
    expect(m.lo).toBeCloseTo(0.6 - (4.303 * 0.1) / Math.sqrt(3), 3);
    expect(meanCi([0.9, 1, 1]).hi).toBe(1);
    expect(meanCi([0.4])).toMatchObject({ lo: 0, hi: 1 });
    const w = welchDiffCi([0.8, 0.9, 1], [0.2, 0.3, 0.4]);
    expect(w.estimate).toBeCloseTo(0.6, 12);
    expect(w.lo).toBeGreaterThan(0);
    expect(welchDiffCi([1], [0])).toMatchObject({ lo: -1, hi: 1 });
  });

  it("the permutation test is exact and its floor at 3 vs 3 is 0.1", () => {
    const r = permutationMeanTest([0.8, 0.9, 1], [0.1, 0.2, 0.3]);
    expect(r).toEqual({ p: 0.1, method: "exact" });
    expect(minMannWhitneyP(3, 3)).toBeCloseTo(0.1, 12);
    // 6 vs 6, total separation: 2 / C(12, 6) = 2 / 924.
    const six = permutationMeanTest(
      [0.7, 0.75, 0.8, 0.85, 0.9, 0.95],
      [0.1, 0.15, 0.2, 0.25, 0.3, 0.35],
    );
    expect(six.p).toBeCloseTo(2 / 924, 12);
    expect(permutationMeanTest([0.5, 0.5], [0.5, 0.5]).p).toBe(1);
  });

  it("a per-task comparison is the difference in means with a permutation p", () => {
    const rc = compareArms({
      kind: "mean",
      better: "higher",
      candidate: [
        { workloadId: "app", samples: [0.7, 0.75, 0.8, 0.85, 0.9, 0.95], trials: 6, solved: 0 },
      ],
      baseline: [
        { workloadId: "app", samples: [0.1, 0.15, 0.2, 0.25, 0.3, 0.35], trials: 6, solved: 0 },
      ],
      clustered: false,
      survivorship: false,
      seed: 1,
    })!;
    expect(rc.test).toBe("permutation_exact");
    expect(rc.effect).toMatchObject({ measure: "mean_diff", magnitude: null });
    expect(rc.effect.value).toBeCloseTo(0.6, 12);
    expect(rc.effect.candidateRate).toBeCloseTo(0.825, 12);
    expect(rc.ci).toMatchObject({ method: "welch_t", unit: "rate" });
    const [d] = decide([rc], { baseline: "B" });
    // One comparison, p = 2/924 < 0.05: better, with no |δ| floor (a 0–1 mean, like a pass rate).
    expect(d!.verdict).toBe("better");
    expect(d!.statement).toMatch(
      /^better: \+60 pts mean fraction, 8[23] pts vs 2[23] pts \(95% Welch t CI/,
    );
  });

  it("is Holm-corrected in the same family as the other requirements", () => {
    // 12 tasks × 3 repeats, A clearly ahead on the fraction on every task.
    const specs: T210[] = [];
    for (let t = 0; t < 12; t++) {
      for (let r = 0; r < 3; r++) {
        specs.push({ c: "A", w: `t${t}`, passed: 30 + r + (t % 3) });
        specs.push({ c: "B", w: `t${t}`, passed: 10 + r + (t % 4) });
      }
    }
    const s = scoreKit(kitTdm210(), trialsTdm210(specs), { baseline: "B", iterations: 500 });
    const a = reqOf(s, "A", "tests");
    const cmp = a.comparison!;
    expect(cmp.test).toBe("task_paired");
    expect(cmp.effect.measure).toBe("mean_diff");
    expect(cmp.ci.unit).toBe("rate");
    // Every scored requirement of A vs B is one comparison in the family; the fraction is in it.
    const compared = s.contenders
      .find((c) => c.contenderId === "A")!
      .requirements.filter((r) => r.scored && r.comparison !== null);
    expect(compared.map((r) => r.requirementId)).toContain("tests");
    expect(cmp.family).toBe(s.stats.family);
    expect(s.stats.family).toBe(compared.length);
    expect(cmp.pAdjusted).toBeGreaterThanOrEqual(cmp.p);
    // 12 tasks, every per-task difference positive: exact sign-flip p = 2/4096, Holm × ≤5.
    expect(a.verdict).toBe("better");
    expect(cmp.claim).toBe("these_tasks");
    expect(s.stats.headline[0]).toMatchObject({ contenderId: "A", verdict: "better" });
    // The per-task headline names the fraction in plain words.
    expect(s.stats.perTask!.family).toBeGreaterThan(0);
  });
});

describe("TDM-210 n=3 per setup: 'not significant', never a winner", () => {
  // The long-horizon kit: one whole-app task, 3 repeats per setup. A looks much better.
  const n3 = trialsTdm210([
    { c: "A", passed: 36, wall: 5000, cost: 30_000_000 },
    { c: "A", passed: 38, wall: 5200, cost: 31_000_000 },
    { c: "A", passed: 40, wall: 5400, cost: 29_000_000 },
    { c: "B", passed: 12, wall: 9000, cost: 50_000_000 },
    { c: "B", passed: 15, wall: 9500, cost: 52_000_000 },
    { c: "B", passed: 21, wall: 9900, cost: 51_000_000 },
  ]);
  const s = scoreKit(kitTdm210(), n3, { baseline: "B" });

  it("the verdict on the fraction says not significant at n=3 (TDM-251: 1 task, so the within-task test)", () => {
    const a = reqOf(s, "A", "tests");
    expect(a.verdict).toBe("indistinguishable");
    expect(s.stats.singleTask).toBe(true);
    expect(a.comparison!.test).toBe("permutation_exact");
    expect(a.comparison!.claim).toBe("these_tasks");
    const st = a.comparison!.statement;
    expect(st).toMatch(/^no detectable difference at n=3 vs 3/);
    expect(st).toContain("not significant");
    expect(st).toMatch(/\+55 pts mean fraction, 95 pts vs 40 pts/);
    expect(s.stats.headline[0]!.verdict).toBe("indistinguishable");
    expect(s.stats.headline[0]!.statement).toContain("not significant");
  });

  it("each per-task test says not significant: 3 vs 3 can't go below p=0.1", () => {
    for (const id of ["tests", "solved", "wall", "cost", "cost-per-test"]) {
      const cell = reqOf(s, "A", id).byWorkload[0]!;
      const tc = cell.taskComparison!;
      expect(tc.verdict, id).toBe("indistinguishable");
      expect(tc.statement, id).toMatch(/^no detectable difference at n=3 vs 3/);
      expect(tc.statement, id).toContain(
        "not significant: n=3 vs 3 is too small for any difference to be significant (the exact test can't go below p=0.100)",
      );
    }
    expect(reqOf(s, "A", "tests").byWorkload[0]!.taskComparison!.test).toBe("permutation_exact");
    // Nothing reaches the per-task headline either: no "passed more hidden tests" claim.
    expect(s.stats.perTask!.headline).toEqual([]);
  });

  it("the report schema accepts the fraction without a passing trial, and only in [0, 1]", () => {
    const row = {
      requirement_id: "tests",
      type: "measured",
      title: "share of hidden tests passed",
      value: 0.95,
      unit: "ratio",
      ci95: null,
      gate_id: "hidden-tests",
      gate_pass_rate: 0,
      score: null,
      aggregate: "all_trials",
    };
    expect(RequirementResultSchema.safeParse(row).success).toBe(true);
    expect(RequirementResultSchema.safeParse({ ...row, value: 1.2 }).success).toBe(false);
    // A speed number still needs a passing trial.
    expect(
      RequirementResultSchema.safeParse({ ...row, aggregate: "censored", unit: "s", value: 9000 })
        .success,
    ).toBe(false);
    expect(RequirementResultSchema.safeParse({ ...row, aggregate: undefined }).success).toBe(false);
  });
});

describe("TDM-210 KitSpec rules for the fraction", () => {
  const KIT = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../kits/tandem-vs-claude-code/anybench.yaml",
  );
  const base = parse(readFileSync(KIT, "utf8")) as KitSpec;
  const withReqs = (extra: unknown[]) => {
    const k = structuredClone(base) as unknown as {
      requirements: unknown[];
      scoring: { weights: Record<string, number> };
    };
    k.requirements.push(...extra);
    for (const r of extra as { id: string }[]) k.scoring.weights[r.id] = 0;
    return safeParseKitSpec(k);
  };
  const fraction = {
    id: "tests-share",
    type: "measured",
    title: "share of hidden tests passed",
    metric: "hidden_test_fraction",
    better: "higher",
    gate_id: "hidden-tests",
  };

  it("accepts hidden_test_fraction and cost per test passed on the hidden-tests gate", () => {
    const r = withReqs([
      fraction,
      { ...perTestReqTdm210, id: "cost-per-test", target: "under $1 per test" },
    ]);
    expect(r.success, r.success ? "" : r.errors.join("\n")).toBe(true);
  });

  it("refuses all_trials on a speed metric, and any other aggregate on the fraction", () => {
    const r1 = withReqs([
      {
        id: "wall-all",
        type: "measured",
        title: "t",
        metric: "wall_s",
        unit: "s",
        better: "lower",
        gate_id: "hidden-tests",
        aggregate: "all_trials",
      },
    ]);
    expect(r1.success).toBe(false);
    if (!r1.success) expect(r1.errors.join("\n")).toMatch(/only for correctness metrics/);
    const r2 = withReqs([{ ...fraction, aggregate: "median" }]);
    expect(r2.success).toBe(false);
    if (!r2.success) expect(r2.errors.join("\n")).toMatch(/correctness itself/);
    const r3 = withReqs([{ ...perTestReqTdm210, id: "x", metric: "wall_s", unit: "s" }]);
    expect(r3.success).toBe(false);
    if (!r3.success) expect(r3.errors.join("\n")).toMatch(/must be money/);
  });

  it("refuses the fraction on a gate that is not hidden-tests", () => {
    const k = structuredClone(base) as unknown as {
      requirements: unknown[];
      gates: { id: string; kind: string }[];
      scoring: { weights: Record<string, number> };
    };
    const other = k.gates.find((g) => g.kind !== "hidden-tests");
    if (!other) return; // the kit has only the hidden-tests gate
    k.requirements.push({ ...fraction, gate_id: other.id });
    k.scoring.weights[fraction.id] = 0;
    const r = safeParseKitSpec(k);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.errors.join("\n")).toMatch(/reads the hidden-tests gate's counts/);
  });
});
