// TDM-175 [16.4]: the decision rule end to end through scoreKit (plan.md 17.2 rules 2, 3, 7, 10).
import { describe, expect, it } from "vitest";
import {
  formatPowerPlan,
  GATE_PASS_RATE_METRIC,
  powerPlan,
  powerPlanForKit,
  scoreKit,
  type ScoreKitInput,
  type ScoredRequirement,
  type TrialResult,
} from "../src/index.js";

type Req = ScoreKitInput["requirements"][number];

const passReq: Req = {
  id: "solved",
  type: "measured",
  title: "solved",
  metric: GATE_PASS_RATE_METRIC,
  better: "higher",
  gate_id: "g",
};
const wallReq: Req = {
  id: "time",
  type: "measured",
  title: "time to solve",
  metric: "wall_s",
  unit: "s",
  better: "lower",
  gate_id: "g",
  cap: 1000,
};

function trialTdm175(
  c: string,
  w: string,
  repeat: number,
  pass: boolean,
  wall = 100,
  extra: Partial<TrialResult> = {},
): TrialResult {
  return {
    contenderId: c,
    workloadId: w,
    repeat,
    metrics: { wall_s: wall },
    gates: { g: { pass, reason: "", evidence: [] } },
    ...extra,
  };
}

/** `n` trials of `c` on `w`; the first `passes` pass. */
function cellTdm175(c: string, w: string, n: number, passes: number, wall: (i: number) => number) {
  return Array.from({ length: n }, (_, i) => trialTdm175(c, w, i, i < passes, wall(i)));
}

function reqOf(r: ReturnType<typeof scoreKit>, contender: string, id: string): ScoredRequirement {
  const c = r.contenders.find((x) => x.contenderId === contender)!;
  const req = c.requirements.find((x) => x.requirementId === id)!;
  if (!req.scored) throw new Error(`${contender}/${id} unscored: ${req.reason}`);
  return req;
}

describe("11/15 vs 9/15 (the product page's example)", () => {
  const kit: ScoreKitInput = {
    subject: { kind: "software" },
    requirements: [passReq],
    scoring: { weights: { solved: 100 } },
  };
  const trials = [
    ...cellTdm175("a", "w", 15, 11, () => 1),
    ...cellTdm175("b", "w", 15, 9, () => 1),
  ];
  const r = scoreKit(kit, trials, { baseline: "b" });
  const a = reqOf(r, "a", "solved");

  it("is indistinguishable, with the smallest detectable difference printed", () => {
    expect(a.verdict).toBe("indistinguishable");
    expect(a.comparison!.test).toBe("newcombe");
    expect(a.comparison!.mde.value).toBeCloseTo(0.4635, 3); // ≈ 46 pts at 80% power
    expect(a.comparison!.statement).toMatch(
      /^no detectable difference at n=15 vs 15, smallest detectable difference=46 pts; observed \+13 pts pass rate \(95% Newcombe score CI −19 pts to \+42 pts\)$/,
    );
    expect(a.ci).toMatchObject({ method: "newcombe", unit: "rate" });
    expect(a.ci!.lo).toBeCloseTo(-0.19013534356563233, 10); // statsmodels
    expect(a.ci!.hi).toBeCloseTo(0.42262286625683954, 10);
    expect(r.stats).toMatchObject({
      baseline: "b",
      family: 1,
      clustered: false,
      primary: "solved",
    });
    expect(r.stats.headline).toEqual([
      { contenderId: "a", verdict: "indistinguishable", statement: a.comparison!.statement },
    ]);
  });

  it("puts an exact interval on each arm at small n, and says so", () => {
    expect(a.byWorkload[0]!.ci).toMatchObject({ method: "clopper_pearson", attained: true });
    expect(a.byWorkload[0]!.ci!.lo).toBeCloseTo(0.4489967589630295, 10);
    // The baseline is not compared with itself.
    expect(reqOf(r, "b", "solved")).toMatchObject({ verdict: null, comparison: null });
  });
});

describe("agent kits: tasks are the unit", () => {
  /** A: 9/10 solved at ~100 s; B: 3/10 at ~300 s, failures at the 1000 s cap. */
  function plantedTdm175(tasks: number) {
    const ts: TrialResult[] = [];
    for (let t = 0; t < tasks; t++) {
      const w = `task-${t}`;
      ts.push(...cellTdm175("a", w, 10, 9, (i) => 90 + ((i * 7 + t) % 20)));
      ts.push(...cellTdm175("b", w, 10, 3, (i) => 290 + ((i * 3 + t) % 20)));
    }
    return ts;
  }
  const kit: ScoreKitInput = {
    subject: { kind: "agent" },
    requirements: [passReq, wallReq],
    scoring: { weights: { solved: 70, time: 30 }, primary: "solved" },
  };

  it("a large planted effect on 20 tasks is better, as a general claim", () => {
    const r = scoreKit(kit, plantedTdm175(20), { baseline: "b" });
    const solved = reqOf(r, "a", "solved");
    expect(solved.verdict).toBe("better");
    expect(solved.comparison).toMatchObject({
      test: "task_paired",
      claim: "general",
      clustered: true,
      n: { candidate: 200, baseline: 200, tasks: 20 },
    });
    expect(solved.effect!.value).toBeCloseTo(0.6, 10);
    expect(solved.comparison!.tasks!.perTask).toHaveLength(20);
    expect(solved.comparison!.tasks!.signFlipMethod).toBe("monte_carlo");
    expect(solved.comparison!.pAdjusted).toBeLessThan(0.05);
    expect(solved.comparison!.statement).toMatch(
      /^better: \+60 pts pass rate \(95% task-bootstrap CI \+\d+ pts to \+\d+ pts\), Holm p=0\.00\d, n=20 tasks \(200 vs 200 trials\)$/,
    );
    const time = reqOf(r, "a", "time");
    expect(time).toMatchObject({ aggregate: "censored", survivorship: false, verdict: "better" });
    // Failures sit at the 1000 s cap: per task (90 A-faster pairs − 3 A-slower) / 100 = 0.87.
    expect(time.effect!.value).toBeCloseTo(0.87, 10);
    expect(r.stats).toMatchObject({ clustered: true, family: 2, primary: "solved" });
    expect(r.stats.headline[0]).toMatchObject({ contenderId: "a", verdict: "better" });
  });

  it("is deterministic: same seed, same comparison", () => {
    const a = scoreKit(kit, plantedTdm175(20), { baseline: "b" });
    const b = scoreKit(kit, plantedTdm175(20), { baseline: "b" });
    expect(reqOf(a, "a", "solved").comparison).toEqual(reqOf(b, "a", "solved").comparison);
  });

  it("on 8 tasks the same effect is better 'on these 8 tasks' only", () => {
    const solved = reqOf(scoreKit(kit, plantedTdm175(8), { baseline: "b" }), "a", "solved");
    expect(solved.verdict).toBe("better");
    expect(solved.comparison!.claim).toBe("these_tasks");
    expect(solved.comparison!.tasks!.signFlipMethod).toBe("exact");
    expect(solved.comparison!.statement).toMatch(/^better on these 8 tasks: /);
  });

  it("3 tasks × 10 repeats can't show anything: the exact test over tasks bottoms out at p = 0.25", () => {
    const solved = reqOf(scoreKit(kit, plantedTdm175(3), { baseline: "b" }), "a", "solved");
    expect(solved.verdict).toBe("indistinguishable");
    expect(solved.comparison!.tasks!.signFlipP).toBe(0.25);
    expect(solved.comparison!.mde.value).toBeNull();
    expect(solved.comparison!.statement).toMatch(
      /^no detectable difference at n=3 tasks \(30 vs 30 trials\), smallest detectable difference=none reachable at this n; observed \+60 pts/,
    );
  });
});

describe("honesty rules", () => {
  it("a median over solved trials only (survivorship) is never better", () => {
    const latency: Req = {
      id: "lat",
      type: "measured",
      title: "latency of solved trials",
      metric: "latency_mean_ms",
      unit: "ms",
      better: "lower",
      gate_id: "g",
      aggregate: "median",
    };
    const kit: ScoreKitInput = {
      subject: { kind: "software" },
      requirements: [latency],
      scoring: { weights: { lat: 100 } },
    };
    const t = (c: string, i: number, pass: boolean, ms: number): TrialResult => ({
      ...trialTdm175(c, "w", i, pass),
      metrics: { latency_mean_ms: ms },
    });
    // A solves 6/10, very fast; B solves 10/10, slower.
    const trials = [
      ...Array.from({ length: 10 }, (_, i) => t("a", i, i < 6, 10 + i)),
      ...Array.from({ length: 10 }, (_, i) => t("b", i, true, 50 + i)),
    ];
    const lat = reqOf(scoreKit(kit, trials, { baseline: "b" }), "a", "lat");
    expect(lat.survivorship).toBe(true);
    expect(lat.comparison!.p).toBeLessThan(0.01);
    expect(lat.verdict).toBe("indistinguishable");
    expect(lat.comparison!.downgraded).toBe("survivorship");
    expect(lat.comparison!.statement).toMatch(
      /median over solved trials only, so it can't show better/,
    );
  });

  it("software timings 5 vs 5, fully separated: better, with an exact HL CI at the level it attains", () => {
    const kit: ScoreKitInput = {
      subject: { kind: "software" },
      requirements: [{ ...wallReq, aggregate: "censored" }],
      scoring: { weights: { time: 100 } },
    };
    const a = [10.1, 10.4, 9.8, 10.0, 10.3];
    const b = [12.2, 11.9, 12.5, 12.0, 12.4];
    const trials = [
      ...a.map((v, i) => trialTdm175("a", "w", i, true, v)),
      ...b.map((v, i) => trialTdm175("b", "w", i, true, v)),
    ];
    const time = reqOf(scoreKit(kit, trials, { baseline: "b" }), "a", "time");
    expect(time.verdict).toBe("better");
    expect(time.comparison).toMatchObject({ test: "mann_whitney_exact", claim: "general" });
    expect(time.comparison!.p).toBeCloseTo(0.007936507936507936, 14); // scipy exact
    expect(time.effect).toMatchObject({ measure: "cliffs_delta", value: 1, magnitude: "large" });
    expect(time.effect!.hodgesLehmann).toBeCloseTo(-2.1, 10);
    expect(time.ci).toMatchObject({ method: "hodges_lehmann", unit: "metric", attained: true });
    expect(time.ci!.level).toBeCloseTo(0.9682539682539683, 12);
    expect(time.comparison!.statement).toMatch(
      /^better: Cliff's δ \+1\.00, shift −2\.10 s \(96\.8% exact Hodges–Lehmann CI −2\.50 s to −1\.60 s\)/,
    );
    // n = 5: the cell's own median CI can't be 95%, and says so.
    expect(time.byWorkload[0]!.ci).toMatchObject({
      method: "order_statistic",
      level: 0.9375,
      attained: false,
    });
  });

  it("Holm runs across every comparison: one real win among several looks", () => {
    const kit: ScoreKitInput = {
      subject: { kind: "software" },
      requirements: [{ ...wallReq, aggregate: "censored" }],
      scoring: { weights: { time: 100 } },
    };
    // Four workloads; only w0 differs. Unadjusted p = 0.0079 < 0.05, Holm ×4 = 0.032 still < 0.05.
    const trials: TrialResult[] = [];
    for (let w = 0; w < 4; w++) {
      for (let i = 0; i < 5; i++) {
        trials.push(trialTdm175("a", `w${w}`, i, true, w === 0 ? 10 + i * 0.1 : 20 + i));
        trials.push(
          trialTdm175("b", `w${w}`, i, true, w === 0 ? 12 + i * 0.1 : 20 + ((i + 2) % 5)),
        );
      }
    }
    const r = scoreKit(kit, trials, { baseline: "b" });
    const time = reqOf(r, "a", "time");
    expect(r.stats.family).toBe(4);
    expect(time.byWorkload.map((c) => c.comparison!.verdict)).toEqual([
      "better",
      "indistinguishable",
      "indistinguishable",
      "indistinguishable",
    ]);
    expect(time.byWorkload[0]!.comparison!.pAdjusted).toBeCloseTo(4 * (2 / 252), 12);
    expect(time.verdict).toBe("better"); // better on one workload, worse on none
    expect(time.comparison).toBeNull(); // several cells: the cells carry the comparisons
  });

  it("no baseline, no verdicts", () => {
    const r = scoreKit({ requirements: [passReq], scoring: { weights: { solved: 100 } } }, [
      ...cellTdm175("a", "w", 5, 5, () => 1),
      ...cellTdm175("b", "w", 5, 0, () => 1),
    ]);
    expect(r.stats.baseline).toBeNull();
    expect(reqOf(r, "a", "solved").verdict).toBeNull();
  });
});

describe("declared scope: N/A is a failure (TDM-174 review)", () => {
  it("a lone contender can't dodge a gate by saying not-applicable on a declared workload", () => {
    const kit: ScoreKitInput = {
      requirements: [{ ...passReq, workloads: ["api"] }],
      scoring: { weights: { solved: 100 } },
    };
    const trials: TrialResult[] = Array.from({ length: 3 }, (_, i) => ({
      contenderId: "solo",
      workloadId: "api",
      repeat: i,
      metrics: {},
      gates: { g: { pass: false, applicable: false, reason: "not applicable", evidence: [] } },
    }));
    const r = scoreKit(kit, trials);
    const c = r.contenders[0]!;
    expect(c.gates.g).toEqual({ passed: 0, failed: 3, missing: 0, total: 3 });
    expect(c.gatesNotApplicable.g).toBe(0);
    expect(reqOf(r, "solo", "solved").byWorkload[0]).toMatchObject({
      workloadId: "api",
      value: 0,
      solved: 0,
      trials: 3,
    });
  });
});

describe("power plan (test plan screen)", () => {
  it("the flagship shape (harness, 3 tasks × 5 repeats, 4 setups) can't detect anything", () => {
    const plan = powerPlanForKit(
      {
        subject: { kind: "harness" },
        contenders: [{}, {}, {}],
        workloads: [{}, {}, {}],
        requirements: [{ id: "tests-pass" }, { id: "wall" }, { id: "cost" }],
        scoring: { weights: { "tests-pass": 60, wall: 20, cost: 20 } },
        repeats: 5,
        vary: { WORKERS: [3, 5] },
        schedule: { warmups: 1 },
      },
      { estTrialCostMicroUsd: 2_500_000n },
    );
    expect(plan).toMatchObject({
      contenders: 6,
      comparisons: 15,
      recommendedRepeats: 10,
      claim: "these_tasks",
      planned: { repeats: 5, passRate: null },
    });
    expect(plan.trials).toEqual({ perContender: 33, total: 198 });
    expect(plan.estimatedCostMicroUsd).toBe(495_000_000n);
    const lines = formatPowerPlan(plan);
    expect(lines[0]).toMatch(
      /^Smallest detectable difference at 3 tasks × 5 repeats: no pass-rate difference/,
    );
    expect(lines[1]).toMatch(
      /^Recommended: 10 repeats per contender × task → .*198 trials, est\. \$495\.00\.$/,
    );
    expect(lines.join("\n")).toMatch(/exact test over tasks needs at least 10 tasks/);
  });

  it("software: 5 repeats can't reach significance across 9 comparisons, so it recommends 6", () => {
    const plan = powerPlan({
      kind: "software",
      tasks: 3,
      contenders: 2,
      requirements: 3,
      repeats: 5,
    });
    expect(plan).toMatchObject({ comparisons: 9, recommendedRepeats: 6, hyperfineMinRuns: 10 });
    expect(plan.planned.cliffsDelta).toBeNull();
    expect(plan.notes[0]).toMatch(/^5 repeats can't reach significance across 9 comparisons/);
    expect(formatPowerPlan(plan)[1]).toMatch(/hyperfine run of ≥10 iterations/);
  });

  it("agents at 20 tasks × 10 repeats: the plan's detectable difference and a general claim", () => {
    const plan = powerPlan({ kind: "agent", tasks: 20, contenders: 2, repeats: 10, icc: 0.3 });
    expect(plan.claim).toBe("general");
    expect(plan.recommendedRepeats).toBe(10);
    // n_eff = 200 / (1 + 9·0.3) ≈ 54 per arm → ≈ 27 pts.
    expect(plan.planned.effectiveN).toBeCloseTo(200 / 3.7, 10);
    expect(plan.planned.passRate!).toBeGreaterThan(0.25);
    expect(plan.planned.passRate!).toBeLessThan(0.29);
  });

  it("a target the repeats can't reach asks for more tasks", () => {
    const plan = powerPlan({ kind: "agent", tasks: 5, contenders: 2, targetMde: 0.2, icc: 0.3 });
    expect(plan.tasksForTarget).toBeGreaterThan(20);
    expect(plan.notes.join(" ")).toMatch(/repeats alone can't detect 20 pts at 5 tasks/);
  });
});
