// TDM-174 [16.3]: scorer v2 (plan.md 17.2 rule 1). N/A gates leave the tally, every contender is
// scored over the same workloads, a zero-pass cell is 0 (not a missing total), cost is all spend
// ÷ solved tasks, and time-to-solve counts failures at the cap.
import { describe, expect, it } from "vitest";
import {
  GATE_PASS_RATE_METRIC,
  NO_SCORE_REASONS,
  parseTarget,
  scoreKit,
  type ContenderScore,
  type RequirementScore,
  type ScoreKitInput,
  type ScoredContender,
  type ScoredRequirement,
  type TrialResult,
} from "../src/index.js";

type Req = ScoreKitInput["requirements"][number];

const timeReqTdm174: Req = {
  id: "time",
  type: "measured",
  title: "time",
  metric: "wall_s",
  unit: "s",
  better: "lower",
  gate_id: "g",
};
const passRateReqTdm174: Req = {
  id: "solved",
  type: "measured",
  title: "solved",
  metric: GATE_PASS_RATE_METRIC,
  better: "higher",
  gate_id: "g",
};
const costReqTdm174: Req = {
  id: "cost",
  type: "measured",
  title: "cost per solved task",
  metric: "cost_micro_usd",
  unit: "micro-USD",
  better: "lower",
  gate_id: "g",
};

function kitTdm174(
  reqs: Req[],
  weights: Record<string, number>,
  extra: Partial<ScoreKitInput> = {},
) {
  return { requirements: reqs, scoring: { weights }, ...extra } satisfies ScoreKitInput;
}

interface TrialSpecTdm174 {
  c: string;
  w: string;
  pass?: boolean;
  wall?: number;
  cost?: number;
  repeat?: number;
  gates?: TrialResult["gates"];
}

function tTdm174(s: TrialSpecTdm174): TrialResult {
  const metrics: Record<string, number> = {};
  if (s.wall !== undefined) metrics.wall_s = s.wall;
  if (s.cost !== undefined) metrics.cost_micro_usd = s.cost;
  return {
    contenderId: s.c,
    workloadId: s.w,
    repeat: s.repeat ?? 0,
    metrics,
    gates: s.gates ?? { g: { pass: s.pass ?? true, reason: "", evidence: [] } },
  };
}

/** `n` repeats; the first `passes` pass. */
function repeatsTdm174(base: Omit<TrialSpecTdm174, "repeat" | "pass">, n: number, passes: number) {
  return Array.from({ length: n }, (_, repeat) =>
    tTdm174({ ...base, repeat, pass: repeat < passes }),
  );
}

function scoredTdm174(c: ContenderScore | undefined): ScoredContender {
  if (!c?.scored) throw new Error(`expected a total for ${c?.contenderId}: ${JSON.stringify(c)}`);
  return c;
}
function reqTdm174(c: ContenderScore, id: string): ScoredRequirement {
  const r: RequirementScore | undefined = c.requirements.find((x) => x.requirementId === id);
  if (!r?.scored) throw new Error(`expected ${id} to be scored: ${JSON.stringify(r)}`);
  return r;
}
const byIdTdm174 = (r: ReturnType<typeof scoreKit>, id: string) =>
  r.contenders.find((c) => c.contenderId === id)!;

describe("a contender that fails a workload ranks below an equally fast one that solves it", () => {
  it("time only: the failed workload is a 0 cell, not a dropped one", () => {
    // `fails` is a bit faster where it passes and fails fast on w2; `solves` solves both.
    const trials = [
      tTdm174({ c: "fails", w: "w1", wall: 90 }),
      tTdm174({ c: "fails", w: "w2", wall: 5, pass: false }),
      tTdm174({ c: "solves", w: "w1", wall: 100 }),
      tTdm174({ c: "solves", w: "w2", wall: 100 }),
    ];
    const r = scoreKit(kitTdm174([timeReqTdm174], { time: 100 }), trials);
    expect(r.ranking).toEqual(["solves", "fails"]);
    const fails = reqTdm174(byIdTdm174(r, "fails"), "time");
    expect(fails.workloads).toEqual(["w1", "w2"]);
    expect(fails.byWorkload.map((c) => [c.workloadId, c.status, c.fraction])).toEqual([
      ["w1", "measured", 1],
      ["w2", "unsolved", 0],
    ]);
    expect(scoredTdm174(byIdTdm174(r, "fails")).total).toBe(50);
    expect(scoredTdm174(byIdTdm174(r, "solves")).total).toBeCloseTo(100 * ((0.9 + 1) / 2), 9);
  });

  it("time-to-solve with a cap: failing 3 of 5 at equal speed puts the median at the cap", () => {
    const kit = kitTdm174([timeReqTdm174], { time: 100 }, {
      workloads: [{ id: "w1", instruction: "w1.md", timeout_s: 600 }],
    } as Partial<ScoreKitInput>);
    const trials = [
      ...repeatsTdm174({ c: "flaky", w: "w1", wall: 100 }, 5, 2),
      ...repeatsTdm174({ c: "steady", w: "w1", wall: 100 }, 5, 5),
    ];
    const r = scoreKit(kit, trials);
    expect(r.ranking).toEqual(["steady", "flaky"]);
    const flaky = reqTdm174(byIdTdm174(r, "flaky"), "time");
    expect(flaky.aggregate).toBe("censored");
    expect(flaky.byWorkload[0]).toMatchObject({
      status: "measured",
      value: 600,
      cap: 600,
      samples: [100, 100, 600, 600, 600],
      trials: 5,
      solved: 2,
      n: 5,
    });
  });

  it("with pass rate, time and cost, one failed workload is enough to rank lower", () => {
    const kit = kitTdm174([passRateReqTdm174, timeReqTdm174, costReqTdm174], {
      solved: 50,
      time: 25,
      cost: 25,
    });
    const trials = ["w1", "w2", "w3"].flatMap((w) => [
      ...repeatsTdm174({ c: "a", w, wall: 100, cost: 1_000_000 }, 5, w === "w3" ? 0 : 5),
      ...repeatsTdm174({ c: "b", w, wall: 100, cost: 1_000_000 }, 5, 5),
    ]);
    const r = scoreKit(kit, trials);
    expect(r.ranking).toEqual(["b", "a"]);
    expect(scoredTdm174(byIdTdm174(r, "b")).total).toBe(100);
    expect(scoredTdm174(byIdTdm174(r, "a")).total).toBeCloseTo(100 * (2 / 3), 9);
  });
});

describe("a gate that doesn't apply leaves the tally instead of failing it", () => {
  const apiReq: Req = {
    id: "p95",
    type: "measured",
    title: "API p95",
    metric: "api_p95_ms",
    unit: "ms",
    better: "lower",
    target: "under 120 ms",
    gate_id: "api",
  };
  const apiRate: Req = { ...passRateReqTdm174, id: "api-ok", gate_id: "api" };
  const na = { pass: false, reason: "not applicable", evidence: [], applicable: false };
  const ok = { pass: true, reason: "p95 measured", evidence: [] };
  const trials: TrialResult[] = [
    {
      contenderId: "a",
      workloadId: "todo-api",
      repeat: 0,
      metrics: { api_p95_ms: 96 },
      gates: { api: ok },
    },
    { contenderId: "a", workloadId: "bug-hunt", repeat: 0, metrics: {}, gates: { api: na } },
  ];

  it("applicable: false is neither a pass nor a fail", () => {
    const r = scoreKit(kitTdm174([apiReq, apiRate], { p95: 50, "api-ok": 50 }), trials);
    const a = scoredTdm174(r.contenders[0]);
    expect(a.gates.api).toEqual({ passed: 1, failed: 0, missing: 0, total: 1 });
    expect(a.gatesNotApplicable.api).toBe(1);
    expect(reqTdm174(a, "p95").workloads).toEqual(["todo-api"]);
    expect(reqTdm174(a, "api-ok").byWorkload).toMatchObject([{ workloadId: "todo-api", value: 1 }]);
    expect(a.total).toBe(100);
  });

  it("the same trials counted as failures would have halved the pass rate", () => {
    const asFail = trials.map((t) =>
      t.workloadId === "bug-hunt" ? { ...t, gates: { api: { ...na, applicable: undefined } } } : t,
    );
    const a = scoredTdm174(
      scoreKit(kitTdm174([apiReq, apiRate], { p95: 50, "api-ok": 50 }), asFail).contenders[0],
    );
    expect(a.gates.api).toEqual({ passed: 1, failed: 1, missing: 0, total: 2 });
    expect(reqTdm174(a, "api-ok").fraction).toBe(0.5);
  });

  it("a requirement scoped to some workloads ignores the others, even with no gate result", () => {
    const scoped: Req = { ...apiReq, workloads: ["todo-api"] };
    const noGate = trials.map((t) => (t.workloadId === "bug-hunt" ? { ...t, gates: {} } : t));
    const a = scoredTdm174(scoreKit(kitTdm174([scoped], { p95: 100 }), noGate).contenders[0]);
    expect(a.total).toBe(100);
    expect(a.gates.api).toEqual({ passed: 1, failed: 0, missing: 0, total: 1 });
    expect(a.gatesNotApplicable.api).toBe(1);
  });
});

describe("a weighted requirement with zero passes scores 0 for that cell", () => {
  it("keeps the total instead of deleting it", () => {
    const apiReq: Req = {
      id: "p95",
      type: "measured",
      title: "API p95",
      metric: "api_p95_ms",
      better: "lower",
      gate_id: "api",
      workloads: ["todo-api"],
    };
    const g = (pass: boolean) => ({ pass, reason: "", evidence: [] });
    const trials: TrialResult[] = [
      // a builds a correct API; b's never passes the load gate.
      {
        contenderId: "a",
        workloadId: "todo-api",
        repeat: 0,
        metrics: { wall_s: 100, api_p95_ms: 90 },
        gates: { g: g(true), api: g(true) },
      },
      {
        contenderId: "b",
        workloadId: "todo-api",
        repeat: 0,
        metrics: { wall_s: 100 },
        gates: { g: g(true), api: g(false) },
      },
    ];
    const r = scoreKit(kitTdm174([timeReqTdm174, apiReq], { time: 70, p95: 30 }), trials);
    const b = scoredTdm174(byIdTdm174(r, "b"));
    expect(b.total).toBe(70);
    expect(reqTdm174(b, "p95")).toMatchObject({
      points: 0,
      byWorkload: [
        {
          workloadId: "todo-api",
          status: "unsolved",
          value: null,
          fraction: 0,
          trials: 1,
          solved: 0,
        },
      ],
    });
    expect(r.ranking).toEqual(["a", "b"]);
  });

  it("a contender missing a workload others solved gets a no_trials 0 cell", () => {
    const trials = [
      tTdm174({ c: "a", w: "w1", wall: 10 }),
      tTdm174({ c: "a", w: "w2", wall: 10 }),
      tTdm174({ c: "b", w: "w1", wall: 10 }),
    ];
    const b = scoredTdm174(
      scoreKit(kitTdm174([timeReqTdm174], { time: 100 }), trials).contenders[1],
    );
    expect(b.total).toBe(50);
    expect(reqTdm174(b, "time").byWorkload[1]).toMatchObject({
      workloadId: "w2",
      status: "no_trials",
      n: 0,
    });
  });

  it("a workload nobody solved is left out of everyone's time average", () => {
    const trials = [
      tTdm174({ c: "a", w: "w1", wall: 10 }),
      tTdm174({ c: "a", w: "hard", wall: 10, pass: false }),
      tTdm174({ c: "b", w: "w1", wall: 20 }),
      tTdm174({ c: "b", w: "hard", wall: 10, pass: false }),
    ];
    const r = scoreKit(
      kitTdm174([timeReqTdm174, passRateReqTdm174], { time: 50, solved: 50 }),
      trials,
    );
    const a = scoredTdm174(r.contenders[0]);
    expect(reqTdm174(a, "time").workloads).toEqual(["w1"]);
    expect(reqTdm174(a, "solved").workloads).toEqual(["w1", "hard"]); // the pass rate counts it
    expect(a.total).toBe(50 + 25);
  });

  it("gate missing still blocks the total (a partial total would hide it)", () => {
    const trials = [
      tTdm174({ c: "a", w: "w1", wall: 10 }),
      tTdm174({ c: "a", w: "w2", gates: {} }),
    ];
    const a = scoreKit(kitTdm174([timeReqTdm174], { time: 100 }), trials).contenders[0]!;
    expect(a).toMatchObject({ scored: false, total: null, reason: NO_SCORE_REASONS.gate_missing });
  });
});

describe("cost is all spend ÷ solved tasks; time-to-solve counts failures at the cap", () => {
  it("cost per solved task charges the failed trials too", () => {
    const trials = [
      // a: 4 trials, 2 pass, spends 100 in all → 50 per solve; cheaper per trial but not per solve.
      ...[10, 20, 30, 40].map((cost, repeat) =>
        tTdm174({ c: "a", w: "w1", cost, repeat, pass: repeat < 2 }),
      ),
      // b: 4 trials, all pass, 30 each → 30 per solve.
      ...[30, 30, 30, 30].map((cost, repeat) => tTdm174({ c: "b", w: "w1", cost, repeat })),
    ];
    const r = scoreKit(kitTdm174([costReqTdm174], { cost: 100 }), trials);
    const a = reqTdm174(byIdTdm174(r, "a"), "cost");
    expect(a.aggregate).toBe("per_solved");
    expect(a.byWorkload[0]).toMatchObject({
      value: 50,
      samples: [10, 20, 30, 40],
      trials: 4,
      solved: 2,
    });
    expect(reqTdm174(byIdTdm174(r, "b"), "cost").byWorkload[0]!.value).toBe(30);
    expect(r.ranking).toEqual(["b", "a"]);
    expect(a.points).toBeCloseTo(100 * (30 / 50), 9);
  });

  it("integer micro-USD stays integer (rounded half up)", () => {
    const trials = [100, 100, 101].map((cost, repeat) =>
      tTdm174({ c: "a", w: "w1", cost, repeat, pass: repeat < 3 }),
    );
    trials.push(tTdm174({ c: "a", w: "w1", cost: 0, repeat: 3, pass: false }));
    const a = reqTdm174(
      scoreKit(kitTdm174([costReqTdm174], { cost: 100 }), trials).contenders[0]!,
      "cost",
    );
    expect(a.byWorkload[0]!.value).toBe(100); // 301 / 3 = 100.33 → 100
    expect(Number.isInteger(a.byWorkload[0]!.value)).toBe(true);
  });

  it("a cost cell with no solve is 0, and a failed trial missing its spend blocks the total", () => {
    const zero = scoreKit(kitTdm174([costReqTdm174], { cost: 100 }), [
      tTdm174({ c: "a", w: "w1", cost: 5 }),
      tTdm174({ c: "b", w: "w1", cost: 1, pass: false }),
    ]);
    expect(reqTdm174(zero.contenders[1]!, "cost").byWorkload[0]).toMatchObject({
      status: "unsolved",
      fraction: 0,
    });
    const missing = scoreKit(kitTdm174([costReqTdm174], { cost: 100 }), [
      tTdm174({ c: "a", w: "w1", cost: 5 }),
      tTdm174({ c: "a", w: "w1", pass: false, repeat: 1 }),
    ]);
    expect(missing.contenders[0]).toMatchObject({
      scored: false,
      reason: NO_SCORE_REASONS.metric_missing,
    });
  });

  it("time-to-solve: a fast failure counts at the cap, from requirement.cap or the contenders' cap", () => {
    const capped: Req = { ...timeReqTdm174, aggregate: "censored", cap: 1000 };
    const trials = [
      tTdm174({ c: "a", w: "w1", wall: 100, repeat: 0 }),
      tTdm174({ c: "a", w: "w1", wall: 2, repeat: 1, pass: false }),
      tTdm174({ c: "a", w: "w1", wall: 3, repeat: 2, pass: false }),
    ];
    const a = reqTdm174(
      scoreKit(kitTdm174([capped], { time: 100 }), trials).contenders[0]!,
      "time",
    );
    expect(a.byWorkload[0]).toMatchObject({ samples: [100, 1000, 1000], value: 1000, cap: 1000 });

    // No requirement cap: the largest contender wall_clock_cap_s (seconds, converted to ms).
    const ms: Req = { ...timeReqTdm174, metric: "wall_ms", unit: "ms", aggregate: "censored" };
    const kit = kitTdm174([ms], { time: 100 }, {
      contenders: [{ driver: { wall_clock_cap_s: 60 } }, { driver: { wall_clock_cap_s: 90 } }],
    } as unknown as Partial<ScoreKitInput>);
    const msTrials = trials.map((t) => ({ ...t, metrics: { wall_ms: t.metrics.wall_s! } }));
    const b = reqTdm174(scoreKit(kit, msTrials).contenders[0]!, "time");
    expect(b.byWorkload[0]).toMatchObject({ cap: 90_000, value: 90_000 });
  });

  it("wall_s without any cap falls back to the median of passing trials; explicit censored refuses", () => {
    const trials = [
      tTdm174({ c: "a", w: "w1", wall: 100 }),
      tTdm174({ c: "a", w: "w1", wall: 1, repeat: 1, pass: false }),
    ];
    const median = reqTdm174(
      scoreKit(kitTdm174([timeReqTdm174], { time: 100 }), trials).contenders[0]!,
      "time",
    );
    expect(median).toMatchObject({
      aggregate: "median",
      byWorkload: [{ value: 100, samples: [100] }],
    });
    const explicit: Req = { ...timeReqTdm174, aggregate: "censored" };
    const r = scoreKit(kitTdm174([explicit], { time: 100 }), trials);
    expect(r.contenders[0]).toMatchObject({ scored: false, reason: NO_SCORE_REASONS.no_cap });
  });
});

describe("parseTarget is unit-aware", () => {
  it("converts into the requirement's unit and rejects mismatches", () => {
    expect(parseTarget("under 2 min", "s")).toEqual({ op: "le", value: 120 });
    expect(parseTarget("under 120 ms", "s")).toEqual({ op: "le", value: 0.12 });
    expect(parseTarget("at least 90%", "ratio")).toEqual({ op: "ge", value: 0.9 });
    expect(() => parseTarget("under 120 ms", "bytes")).toThrow(RangeError);
  });

  it("scores against the converted bound", () => {
    const req: Req = { ...timeReqTdm174, target: "under 2 min" };
    const r = scoreKit(kitTdm174([req], { time: 100 }), [
      tTdm174({ c: "a", w: "w1", wall: 110 }),
      tTdm174({ c: "b", w: "w1", wall: 240 }),
    ]);
    expect(r.contenders.map((c) => scoredTdm174(c).total)).toEqual([100, 50]);
    const bad: Req = { ...timeReqTdm174, target: "under 300 MB" };
    expect(() =>
      scoreKit(kitTdm174([bad], { time: 100 }), [tTdm174({ c: "a", w: "w1", wall: 1 })]),
    ).toThrow(RangeError);
  });
});
