// TDM-53 [5.8]: weighted 0–100 scoring over gated metrics, and the core rule.
import { KitSpecSchema, type KitSpec } from "@anybench/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  GATE_PASS_RATE_METRIC,
  median,
  mulberry32,
  parseTarget,
  scoreKit,
  type ContenderScore,
  type ScoredContender,
  type TrialResult,
} from "../src/index.js";

// ---------------------------------------------------------------------------------------------
// The product page's example run: 4 setups × 3 tasks × 5 runs = 60 trials (plus a do-less
// cheater that must get no score). Numbers are made up; only the table's shape matters.

function kitTdm53(): KitSpec {
  return KitSpecSchema.parse({
    schema_version: 2,
    subject: {
      kind: "harness",
      name: "tandem",
      summary: "Tandem vs plain Claude Code",
      better_means: ["more tasks solved", "faster"],
    },
    contenders: [
      {
        id: "tandem",
        role: "subject",
        source: { github: "jaximus808/tandem", ref: "main" },
        driver: { type: "harness", verbs: { run: "eval/run.sh {task} {workspace}" } },
      },
      {
        id: "claude-code",
        role: "baseline",
        source: { upload: ["baselines/claude-code/CLAUDE.md"] },
        driver: { type: "coding-agent", verbs: { run: "claude -p" } },
      },
    ],
    workloads: [
      { id: "todo-api", instruction: "workloads/todo-api/instruction.md" },
      { id: "auth-refactor", instruction: "workloads/auth-refactor/instruction.md" },
      { id: "bug-hunt", instruction: "workloads/bug-hunt/instruction.md" },
    ],
    gates: [{ id: "hidden-tests", kind: "hidden-tests" }],
    requirements: [
      {
        id: "tests",
        type: "measured",
        title: "Tasks solved",
        metric: GATE_PASS_RATE_METRIC,
        better: "higher",
        gate_id: "hidden-tests",
      },
      {
        id: "latency",
        type: "measured",
        title: "API p95",
        metric: "p95_ms",
        unit: "ms",
        better: "lower",
        target: "under 100 ms",
        gate_id: "hidden-tests",
      },
      {
        id: "time",
        type: "measured",
        title: "Median time",
        metric: "wall_s",
        unit: "s",
        better: "lower",
        gate_id: "hidden-tests",
      },
      {
        id: "cost",
        type: "measured",
        title: "Cost per solved task",
        metric: "cost_micro_usd",
        better: "lower",
        gate_id: "hidden-tests",
      },
      { id: "quality", type: "reviewed", title: "Code quality", gate_id: "hidden-tests" },
    ],
    proof: { oracle: { id: "ref", dir: "proof/oracle/" } },
    human_in_loop: { kind: "tandem", policy: "llm-reviewer" },
    scoring: { weights: { tests: 50, latency: 10, time: 10, cost: 10, quality: 20 } },
    repeats: 5,
  });
}

interface SetupTdm53 {
  id: string;
  /** passes per workload, out of 5: [todo-api, auth-refactor, bug-hunt] */
  passes: [number, number, number];
  p95: number;
  wallS: number;
  costUsdCents: number;
  review: number;
}

const SETUPS_TDM53: SetupTdm53[] = [
  {
    id: "claude-code-solo",
    passes: [3, 3, 2],
    p95: 140,
    wallS: 31 * 60,
    costUsdCents: 510,
    review: 2,
  },
  {
    id: "claude-code-subagents",
    passes: [3, 3, 3],
    p95: 118,
    wallS: 22 * 60,
    costUsdCents: 580,
    review: 2.5,
  },
  { id: "tandem-x3", passes: [5, 2, 4], p95: 96, wallS: 13 * 60, costUsdCents: 490, review: 2.5 },
  { id: "tandem-x5", passes: [5, 2, 3], p95: 101, wallS: 12 * 60, costUsdCents: 670, review: 2.5 },
];
const WORKLOADS_TDM53 = ["todo-api", "auth-refactor", "bug-hunt"] as const;

function trialsTdm53(seed = 2026): TrialResult[] {
  const rand = mulberry32(seed);
  const jitter = (x: number, pct: number) => x * (1 + (rand() * 2 - 1) * pct);
  const out: TrialResult[] = [];
  for (const s of SETUPS_TDM53) {
    WORKLOADS_TDM53.forEach((workloadId, w) => {
      for (let repeat = 0; repeat < 5; repeat++) {
        const pass = repeat < s.passes[w]!;
        out.push({
          contenderId: s.id,
          workloadId,
          repeat,
          metrics: {
            p95_ms: Math.round(jitter(s.p95, 0.05)),
            wall_s: Math.round(jitter(s.wallS, 0.15)),
            cost_micro_usd: Math.round(jitter(s.costUsdCents, 0.1)) * 10_000,
          },
          gates: {
            "hidden-tests": {
              pass,
              reason: pass ? "all hidden tests pass" : "3 tests failed",
              evidence: ["gate.json"],
            },
          },
          reviews: pass ? { quality: s.review + (repeat % 2 === 0 ? 0 : 0.5) } : {},
        });
      }
    });
  }
  return out;
}

/** The do-less cheater: drops the work, so it is very fast and cheap, and fails every gate. */
function cheaterTdm53(): TrialResult[] {
  return WORKLOADS_TDM53.flatMap((workloadId) =>
    [0, 1, 2, 3, 4].map((repeat) => ({
      contenderId: "do-less",
      workloadId,
      repeat,
      metrics: { p95_ms: 5, wall_s: 30, cost_micro_usd: 100_000 },
      gates: {
        "hidden-tests": { pass: false, reason: "0/42 tests pass", evidence: ["gate.json"] },
      },
    })),
  );
}

function scored(s: ContenderScore | undefined): ScoredContender {
  if (!s?.scored) throw new Error(`expected a score for ${s?.contenderId}`);
  return s;
}

describe("fixture run: the product page's example table shape", () => {
  const kit = kitTdm53();
  const trials = [...trialsTdm53(), ...cheaterTdm53()];
  const result = scoreKit(kit, trials);
  const byId = new Map(result.contenders.map((c) => [c.contenderId, c]));

  it("renders Setup | Score | Tasks solved | API p95 | Median time | Cost per solved task", () => {
    const rows = SETUPS_TDM53.map((s) => {
      const c = scored(byId.get(s.id));
      const passing = trials.filter((t) => t.contenderId === s.id && t.gates["hidden-tests"]!.pass);
      const solved = c.gates["hidden-tests"]!;
      const costSum = passing.reduce((a, t) => a + BigInt(t.metrics.cost_micro_usd!), 0n);
      return {
        setup: s.id,
        score: c.totalRounded,
        tasksSolved: `${solved.passed}/${solved.total}`,
        p95: `${median(passing.map((t) => t.metrics.p95_ms!))} ms`,
        time: `${Math.round(median(passing.map((t) => t.metrics.wall_s!)) / 60)} min`,
        costPerSolved: costSum / BigInt(solved.passed), // integer micro-USD
      };
    });
    expect(rows.map((r) => r.tasksSolved)).toEqual(["8/15", "9/15", "11/15", "10/15"]);
    for (const r of rows) {
      expect(Number.isInteger(r.score)).toBe(true);
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
      expect(r.p95).toMatch(/^\d+(\.\d+)? ms$/);
      expect(r.time).toMatch(/^\d+ min$/);
      expect(typeof r.costPerSolved).toBe("bigint");
    }
    // Same ordering as the example: C > D > B > A, and the do-less cheater last with 0 (TDM-174).
    expect(result.ranking).toEqual([
      "tandem-x3",
      "tandem-x5",
      "claude-code-subagents",
      "claude-code-solo",
      "do-less",
    ]);
  });

  it("breaks each total down per requirement: points within 0..weight, summing to the total", () => {
    for (const s of SETUPS_TDM53) {
      const c = scored(byId.get(s.id));
      expect(c.requirements.map((r) => r.requirementId)).toEqual([
        "tests",
        "latency",
        "time",
        "cost",
        "quality",
      ]);
      let sum = 0;
      for (const r of c.requirements) {
        if (!r.scored) throw new Error("all requirements should be scored");
        expect(r.points).toBeGreaterThanOrEqual(0);
        expect(r.points).toBeLessThanOrEqual(r.weight);
        expect(r.byWorkload.length).toBeGreaterThan(0);
        sum += r.points;
      }
      expect(sum).toBeCloseTo(c.total, 9);
    }
    // "How C got N: tests a/50 · latency b/10 · …": tests is the absolute pass rate.
    const c = scored(byId.get("tandem-x3"));
    const tests = c.requirements[0]!;
    expect(tests.scored && tests.points).toBeCloseTo((50 * (5 / 5 + 2 / 5 + 4 / 5)) / 3, 9);
    // On auth-refactor (tightly coupled), C solves fewer than B: visible per workload.
    const bTests = scored(byId.get("claude-code-subagents")).requirements[0]!;
    const cell = (r: typeof tests, w: string) =>
      r.scored ? r.byWorkload.find((x) => x.workloadId === w)?.value : undefined;
    expect(cell(tests, "auth-refactor")).toBeLessThan(cell(bTests, "auth-refactor")!);
  });

  // TDM-174: a cheater solves nothing, so every cell is a 0 (plan.md 17.2 rule 9: it scores 0).
  it("the do-less cheater scores 0, ranks last, and does not move anyone else's score", () => {
    const cheater = scored(byId.get("do-less"));
    expect(cheater.total).toBe(0);
    expect(result.ranking.at(-1)).toBe("do-less");
    for (const r of cheater.requirements) {
      expect(r).toMatchObject({ scored: true, points: 0 });
      if (!r.scored) continue;
      expect(r.byWorkload.map((c) => c.status)).toEqual(
        r.aggregate === "rate"
          ? ["measured", "measured", "measured"]
          : ["unsolved", "unsolved", "unsolved"],
      );
    }

    const without = scoreKit(kit, trialsTdm53());
    for (const c of without.contenders) {
      expect(scored(byId.get(c.contenderId)).total).toBe(scored(c).total);
    }
  });

  it("is deterministic", () => {
    expect(scoreKit(kit, trials)).toEqual(result);
  });
});

// ---------------------------------------------------------------------------------------------
// Rules, one at a time.

function miniKitTdm53(
  overrides: Partial<Pick<KitSpec, "requirements" | "scoring">> = {},
): Pick<KitSpec, "requirements" | "scoring"> {
  return {
    requirements: [
      {
        id: "time",
        type: "measured",
        title: "time",
        metric: "wall_s",
        better: "lower",
        gate_id: "g",
      },
      {
        id: "quality",
        type: "reviewed",
        title: "quality",
        rubric: "rubric.md",
        scale: { min: 1, max: 4 },
        gate_id: "g",
      },
    ],
    scoring: { weights: { time: 60, quality: 40 } },
    ...overrides,
  };
}

function trial(
  contenderId: string,
  wall: number | undefined,
  pass: boolean | undefined,
  review?: number,
  workloadId = "w1",
): TrialResult {
  return {
    contenderId,
    workloadId,
    repeat: 0,
    metrics: wall === undefined ? {} : { wall_s: wall },
    gates: pass === undefined ? {} : { g: { pass, reason: "", evidence: [] } },
    reviews: review === undefined ? {} : { quality: review },
  };
}

describe("scoring rules", () => {
  it("relative to the best gated contender when there is no target", () => {
    const r = scoreKit(miniKitTdm53(), [trial("a", 10, true, 4), trial("b", 20, true, 1)]);
    const [a, b] = r.contenders.map(scored);
    expect(a!.total).toBe(100);
    expect(b!.total).toBeCloseTo(60 * 0.5 + 0, 12); // 10/20 of time, review at scale.min
    expect(r.ranking).toEqual(["a", "b"]);
  });

  it("uses a parsed target threshold in the metric's unit", () => {
    const kit = miniKitTdm53({
      requirements: [
        {
          id: "time",
          type: "measured",
          title: "t",
          metric: "wall_s",
          better: "lower",
          target: "under 100 s",
          gate_id: "g",
        },
      ],
      scoring: { weights: { time: 100 } },
    });
    const r = scoreKit(kit, [trial("a", 80, true), trial("b", 125, true)]);
    expect(r.contenders.map((c) => scored(c).total)).toEqual([100, 80]);
  });

  it("gate missing on any trial: no score for the requirement and no total", () => {
    const r = scoreKit(miniKitTdm53(), [trial("a", 10, true, 3), trial("a", 11, undefined, 3)]);
    const a = r.contenders[0]!;
    expect(a.scored).toBe(false);
    if (a.scored) return;
    expect(a.reason).toBe("no score: gate missing");
    expect(a.requirements[0]).toMatchObject({ scored: false, code: "gate_missing" });
    expect(a.gates.g).toEqual({ passed: 1, failed: 0, missing: 1, total: 2 });
    expect(r.ranking).toEqual([]);
  });

  it("a gate-failed trial's metric is never used", () => {
    const r = scoreKit(miniKitTdm53(), [
      trial("a", 10, true, 4),
      trial("b", 1, false, 4), // fast but wrong
      trial("b", 20, true, 4),
    ]);
    const time = scored(r.contenders[1]).requirements[0]!;
    expect(time.scored && time.byWorkload[0]).toMatchObject({ value: 20, n: 1, fraction: 0.5 });
  });

  it("metric missing, not reviewed, no trials", () => {
    const r = scoreKit(miniKitTdm53(), [trial("a", undefined, true, 3), trial("b", 5, true)], {
      contenders: ["a", "b", "c"],
    });
    const codes = r.contenders.map((c) => c.requirements.map((x) => (x.scored ? "ok" : x.code)));
    expect(codes).toEqual([
      ["metric_missing", "ok"],
      ["ok", "not_reviewed"],
      ["no_trials", "no_trials"],
    ]);
    expect(r.contenders.every((c) => !c.scored)).toBe(true);
  });

  it("an unscored weight-0 requirement does not block the total", () => {
    const kit = miniKitTdm53({ scoring: { weights: { time: 100, quality: 0 } } });
    const a = scored(scoreKit(kit, [trial("a", 10, true)]).contenders[0]);
    expect(a.total).toBe(100);
    expect(a.requirements[1]).toMatchObject({ scored: false, code: "not_reviewed", weight: 0 });
  });

  it("rejects malformed trial results", () => {
    expect(() =>
      scoreKit(miniKitTdm53(), [{ contenderId: "a" } as unknown as TrialResult]),
    ).toThrow();
  });

  it("parseTarget", () => {
    expect(parseTarget("under 120 ms")).toEqual({ op: "le", value: 120 });
    expect(parseTarget("≤ 30")).toEqual({ op: "le", value: 30 });
    expect(parseTarget("at least 0.9")).toEqual({ op: "ge", value: 0.9 });
    expect(parseTarget("all pass")).toBeUndefined();
    expect(parseTarget("$5 per task")).toBeUndefined();
    expect(parseTarget(undefined)).toBeUndefined();
  });
});

describe("scoring properties", () => {
  const trialArb = fc.record({
    contenderId: fc.constantFrom("a", "b", "c"),
    workloadId: fc.constantFrom("w1", "w2"),
    repeat: fc.nat(4),
    wall: fc.option(fc.double({ min: -50, max: 1000, noNaN: true, noDefaultInfinity: true }), {
      nil: undefined,
    }),
    pass: fc.option(fc.boolean(), { nil: undefined, freq: 8 }),
    review: fc.option(fc.double({ min: 0, max: 5, noNaN: true, noDefaultInfinity: true }), {
      nil: undefined,
    }),
  });
  const trialsArb = fc
    .array(trialArb, { maxLength: 30 })
    .map((ts) => ts.map((t) => trial(t.contenderId, t.wall, t.pass, t.review, t.workloadId)));

  it("totals in [0, 100], points in [0, weight], and only fully gated contenders get one", () => {
    fc.assert(
      fc.property(trialsArb, (ts) => {
        const r = scoreKit(miniKitTdm53(), ts);
        for (const c of r.contenders) {
          const mine = ts.filter((t) => t.contenderId === c.contenderId);
          const allGated = mine.every((t) => t.gates.g !== undefined);
          const anyPass = mine.some((t) => t.gates.g?.pass === true);
          if (!allGated) expect(c.scored).toBe(false);
          if (!c.scored) continue;
          if (!anyPass) expect(c.total).toBe(0); // TDM-174: 0 cells, not a missing total
          expect(c.total).toBeGreaterThanOrEqual(0);
          expect(c.total).toBeLessThanOrEqual(100 + 1e-9);
          for (const req of c.requirements) {
            if (!req.scored) continue;
            expect(req.points).toBeGreaterThanOrEqual(0);
            expect(req.points).toBeLessThanOrEqual(req.weight + 1e-9);
          }
        }
        expect(new Set(r.ranking).size).toBe(r.ranking.length);
        expect(scoreKit(miniKitTdm53(), ts)).toEqual(r);
      }),
    );
  });

  it("adding a contender whose gate always fails scores it 0 and never changes the other scores", () => {
    fc.assert(
      fc.property(
        trialsArb,
        fc.array(fc.double({ min: 0, max: 1000, noNaN: true }), { minLength: 1, maxLength: 5 }),
        (ts, walls) => {
          const before = scoreKit(miniKitTdm53(), ts);
          const cheat = walls.map((w, i) => trial("cheat", w, false, 4, i % 2 ? "w1" : "w2"));
          const after = scoreKit(miniKitTdm53(), [...ts, ...cheat]);
          expect(after.contenders.at(-1)).toMatchObject({
            contenderId: "cheat",
            scored: true,
            total: 0,
          });
          expect(after.contenders.slice(0, -1)).toEqual(before.contenders);
          expect(after.ranking).toEqual([...before.ranking, "cheat"]);
        },
      ),
    );
  });
});
