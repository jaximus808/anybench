// E18 [18.1] null pilot: an A/A test of the decision rule (TDM-175) through scoreKit.
//
// Both arms are draws from the SAME distribution (same per-task pass probability, wall time,
// cost and review score), so every verdict must be "indistinguishable". Over many seeds the
// share of runs where ANY requirement is called better or worse (the family-wise false-positive
// rate after Holm) must be at or below α. A planted-difference control on the same generator
// shows the check is not vacuous: the rule does fire when the arms really differ.
import { describe, expect, it } from "vitest";
import {
  DECISION_RULE,
  GATE_PASS_RATE_METRIC,
  mulberry32,
  powerPlanForKit,
  scoreKit,
  type ScoreKitInput,
  type ScoredRequirement,
  type TrialResult,
} from "../src/index.js";

type ReqE18 = ScoreKitInput["requirements"][number];

const CAP_S_E18 = 3600;

/** The curated Tandem kit's requirement shapes: pass rate, time-to-solve, cost per solve, review. */
const REQUIREMENTS_E18: ReqE18[] = [
  {
    id: "tests-pass",
    type: "measured",
    title: "hidden tests pass",
    metric: GATE_PASS_RATE_METRIC,
    better: "higher",
    gate_id: "hidden-tests",
  },
  {
    id: "wall",
    type: "measured",
    title: "wall clock",
    metric: "wall_s",
    unit: "s",
    better: "lower",
    gate_id: "hidden-tests",
    cap: CAP_S_E18,
  },
  {
    id: "cost",
    type: "measured",
    title: "cost per task",
    metric: "cost_micro_usd",
    unit: "micro-USD",
    better: "lower",
    gate_id: "hidden-tests",
  },
  {
    id: "quality",
    type: "reviewed",
    title: "code quality",
    rubric: "rubric.md",
    criterion: "code-quality",
    scale: { min: 1, max: 4 },
    gate_id: "hidden-tests",
  },
];

function kitE18(kind: "harness" | "software"): ScoreKitInput {
  return {
    subject: { kind },
    requirements: REQUIREMENTS_E18,
    scoring: { weights: { "tests-pass": 50, wall: 20, cost: 10, quality: 20 } },
  };
}

interface ShapeE18 {
  kind: "harness" | "software";
  tasks: number;
  repeats: number;
}

/** A planted difference for the power control (zero for the A/A runs). */
interface LiftE18 {
  /** Added to the twin's per-task pass probability. */
  pass: number;
  /** Multiplies the twin's wall time and cost. */
  speed: number;
}
const NO_LIFT_E18: LiftE18 = { pass: 0, speed: 1 };

const BASE_E18 = "claude-code-solo";
const TWIN_E18 = "claude-code-solo-twin";

/** One synthetic run: both arms from one generator per task (task effects make repeats cluster). */
function runE18(shape: ShapeE18, seed: number, lift: LiftE18 = NO_LIFT_E18): TrialResult[] {
  const rand = mulberry32(seed);
  const normal = () => {
    const u = Math.max(rand(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };
  const out: TrialResult[] = [];
  for (let t = 0; t < shape.tasks; t++) {
    const workloadId = `task-${t}`;
    // Task difficulty: some tasks are hard for every repeat of every arm.
    const pTask = 0.15 + 0.75 * rand();
    const wallTask = 300 + 2400 * rand();
    const costTask = 200_000 + 2_000_000 * rand();
    const qualityTask = 1.5 + 2 * rand();
    for (const contenderId of [BASE_E18, TWIN_E18]) {
      const twin = contenderId === TWIN_E18;
      const p = Math.min(0.99, pTask + (twin ? lift.pass : 0));
      const k = twin ? lift.speed : 1;
      for (let repeat = 0; repeat < shape.repeats; repeat++) {
        const pass = rand() < p;
        const wall = Math.min(CAP_S_E18, wallTask * k * Math.exp(0.35 * normal()));
        const cost = Math.round(costTask * k * Math.exp(0.35 * normal()));
        const quality = Math.min(4, Math.max(1, Math.round(qualityTask + 0.7 * normal())));
        out.push({
          contenderId,
          workloadId,
          repeat,
          metrics: { wall_s: wall, cost_micro_usd: cost },
          gates: { "hidden-tests": { pass, reason: pass ? "pass" : "fail", evidence: [] } },
          reviews: pass ? { quality } : {},
        });
      }
    }
  }
  return out;
}

function twinVerdictsE18(shape: ShapeE18, seed: number, lift?: LiftE18) {
  const r = scoreKit(kitE18(shape.kind), runE18(shape, seed, lift), {
    contenders: [BASE_E18, TWIN_E18],
    baseline: BASE_E18,
    seed,
  });
  const twin = r.contenders.find((c) => c.contenderId === TWIN_E18)!;
  return twin.requirements.filter((q): q is ScoredRequirement => q.scored);
}

/** Share of seeds where any requirement of the twin is called better or worse. */
function falsePositiveRateE18(shape: ShapeE18, seeds: number) {
  let positives = 0;
  let compared = 0;
  const minP: number[] = [];
  for (let s = 1; s <= seeds; s++) {
    const reqs = twinVerdictsE18(shape, 0x18_1 * 1000 + s);
    compared += reqs.filter((q) => q.verdict !== null).length;
    if (reqs.some((q) => q.verdict === "better" || q.verdict === "worse")) positives++;
    const ps = reqs.flatMap((q) =>
      q.comparison ? [q.comparison.p] : q.byWorkload.flatMap((c) => c.comparison?.p ?? []),
    );
    minP.push(Math.min(...ps));
  }
  return { rate: positives / seeds, positives, compared, minP: Math.min(...minP) };
}

const ALPHA_E18 = DECISION_RULE.alpha;

describe("null pilot (E18 18.1): A/A data never calls a winner more often than α", () => {
  it("the curated null pilot's shape (harness, 3 tasks × the power plan's repeats): 0 false positives", () => {
    // The pilot's repeats come from the power plan, as in apps/server nullPilotProfile.
    const plan = powerPlanForKit({
      subject: { kind: "harness" },
      contenders: [BASE_E18, TWIN_E18],
      workloads: [1, 2, 3],
      requirements: REQUIREMENTS_E18,
      scoring: { weights: { "tests-pass": 50, wall: 20, cost: 10, quality: 20 } },
      repeats: 10,
    });
    expect(plan.recommendedRepeats).toBe(10);
    const shape: ShapeE18 = { kind: "harness", tasks: 3, repeats: plan.recommendedRepeats };
    const fpr = falsePositiveRateE18(shape, 50);
    expect(fpr.compared).toBeGreaterThan(0);
    expect(fpr.rate).toBe(0);
    // Structural: the exact sign-flip test over 3 tasks can't go below 2/2^3 = 0.25, so at 3
    // tasks the pilot can't call a winner at all (the power plan says so on the test plan).
    expect(fpr.minP).toBeGreaterThanOrEqual(0.25);
  }, 60_000);

  it("harness, 10 tasks × 4 repeats (where the task-paired test can fire): FPR ≤ α", () => {
    const fpr = falsePositiveRateE18({ kind: "harness", tasks: 10, repeats: 4 }, 200);
    expect(fpr.compared).toBeGreaterThan(200 * 3);
    // 2/2^10 is far below α/4, so a false positive is possible here; the rule must keep it rare.
    expect(fpr.minP).toBeLessThan(ALPHA_E18);
    expect(fpr.rate).toBeLessThanOrEqual(ALPHA_E18);
  }, 120_000);

  it("harness, 20 tasks × 4 repeats (a general-claim kit): FPR ≤ α", () => {
    const fpr = falsePositiveRateE18({ kind: "harness", tasks: 20, repeats: 4 }, 100);
    expect(fpr.rate).toBeLessThanOrEqual(ALPHA_E18);
  }, 120_000);

  it("software, 2 workloads × 10 repeats (Newcombe, exact Mann–Whitney + |δ|, Holm over cells): FPR ≤ α", () => {
    const fpr = falsePositiveRateE18({ kind: "software", tasks: 2, repeats: 10 }, 300);
    expect(fpr.compared).toBeGreaterThan(300 * 3);
    expect(fpr.rate).toBeLessThanOrEqual(ALPHA_E18);
  }, 60_000);

  it("control: the same generator with a planted difference is detected (the A/A check is not vacuous)", () => {
    const lift: LiftE18 = { pass: 0.45, speed: 0.4 };
    let harnessBetter = 0;
    let softwareBetter = 0;
    const seeds = 40;
    for (let s = 1; s <= seeds; s++) {
      const h = twinVerdictsE18({ kind: "harness", tasks: 10, repeats: 4 }, s, lift);
      if (h.some((q) => q.verdict === "better")) harnessBetter++;
      const w = twinVerdictsE18({ kind: "software", tasks: 2, repeats: 10 }, s, lift);
      if (w.some((q) => q.verdict === "better")) softwareBetter++;
    }
    expect(harnessBetter / seeds).toBeGreaterThan(0.5);
    expect(softwareBetter / seeds).toBeGreaterThan(0.5);
  }, 60_000);
});
