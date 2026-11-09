// TDM-175 [16.4]: the decision rule and the power plan (plan.md 17.2 rules 2, 3, 7 and 10).
//
// Every comparison of a contender with the baseline on a requirement ends in a verdict:
// `better | worse | indistinguishable`. Nothing else may claim "beats", "faster" or "cheaper".
//
// Tests (all two-sided, 95% intervals, Holm across the whole report):
// - Pass rates, software kits: Newcombe's hybrid score CI on the difference of the two Wilson
//   intervals; the p-value inverts that CI, so a significant result always has a CI without 0.
// - Continuous metrics, software kits: Mann–Whitney (exact for small n) with p < α AND
//   |Cliff's δ| ≥ 0.33, with a Hodges–Lehmann CI on the shift in the metric's unit.
// - Agent and harness kits: repeats of one task are not independent (a hard task is hard for
//   every repeat), so the unit is the TASK. The statistic is the mean over tasks of the per-task
//   difference (pass rate) or of the per-task Cliff's δ (continuous metrics, which are on
//   different scales per task), and its CI and p-value come from a two-stage bootstrap: resample
//   tasks, then trials within each task. Seeded, so the same trials give the same verdict.
// - Cost per solved task (`per_solved`) compares trials with a failed trial counted as infinitely
//   expensive (it bought no solve), the same idea as time-to-solve counting failures at the cap.
//   Cost per hidden test passed (`per_test_passed`, TDM-210) does the same per trial: spend ÷ the
//   tests it passed, ∞ when it passed none.
// - Mean hidden-test fraction (kind `mean`, TDM-210): a bounded 0–1 value on the same scale on
//   every task, so the effect is the DIFFERENCE IN MEANS (in points, like a pass rate), not a rank
//   statistic. Agent kits: task-paired like a pass rate (per-task mean difference, the exact
//   sign-flip test over tasks and the two-stage task bootstrap). One task's repeats (per task) or
//   software cells: the exact permutation test on the difference in means, with a Welch t CI.
//   No |δ| floor, like pass rates.
//
// Verdict rule: `pAdjusted < α` (Holm) and, for continuous metrics, |δ| ≥ 0.33; the sign of the
// oriented effect (positive = the candidate is better) says better or worse. Otherwise the
// verdict is `indistinguishable`, phrased "no detectable difference at n=…, smallest detectable
// difference=…", where the smallest detectable difference is at 80% power and α / (family size).
//
// Too small to tell (TDM-210): when the test's exact floor (2 / 2^T over T tasks, 2 / C(n1+n2, n1)
// for an exact two-sample test) is at least α, no data at this n could be significant, and the
// statement says "not significant" with the n that could be.
//
// Honesty rules on top:
// - A requirement scored as a median over solved trials only (`survivorship: true`) can never be
//   `better`: a contender that solves 1/5 fast would win on speed by failing. It is reported as
//   indistinguishable with the reason.
// - An agent/harness `better` on fewer than 20 tasks is a claim about those tasks only
//   (`claim: "these_tasks"`, "better on these 3 tasks: …").
import { formatUsd, type MicroUsd, type SubjectKind, type Verdict } from "@anybench/core";
import {
  cliffsDelta,
  effectMagnitude,
  fisherExact,
  hodgesLehmannCi,
  holmAdjust,
  mannWhitney,
  mdeCliffsDelta,
  mdeTwoProportions,
  minMannWhitneyP,
  mulberry32,
  newcombeCi,
  newcombePValue,
  normalQuantile,
  permutationMeanTest,
  robustSd,
  shiftForCliffsDelta,
  signFlipTest,
  welchDiffCi,
  type EffectMagnitude,
} from "./stats.js";

/** `better | worse | indistinguishable`, as in core's report schema (`VerdictSchema`). */
export type { Verdict };

/** The decision rule's constants (plan.md 17.2 rules 2 and 3). */
export const DECISION_RULE = {
  /** Family-wise error rate, Holm-controlled across the report. */
  alpha: 0.05,
  /** Power for the smallest detectable difference. */
  power: 0.8,
  /** Two-sided interval level printed next to every effect. */
  level: 0.95,
  /** Continuous metrics need |Cliff's δ| at least this ("medium", Romano et al. 2006). */
  minCliffsDelta: 0.33,
  /** An agent/harness "beats" claim needs this many tasks, else it is "on these N tasks". */
  minTasksForClaim: 20,
  bootstrapIterations: 2000,
  /** Default bootstrap seed. */
  seed: 0x16_04_175,
} as const;

/** Default repeats per contender × workload (plan.md 17.2 rule 3). */
export const DEFAULT_REPEATS: Readonly<Record<SubjectKind, number>> = {
  software: 5,
  agent: 10,
  harness: 10,
};
/** No plan recommends fewer repeats than this. */
export const REPEATS_FLOOR = 4;
/** Software repeats are each a hyperfine run of at least this many iterations. */
export const HYPERFINE_MIN_RUNS = 10;
/**
 * Intra-task correlation assumed for agent/harness pass rates until a pilot measures it: how much
 * more alike two repeats of one task are than two trials of different tasks. With 0.3, extra
 * repeats help little past ~10 and more tasks help a lot, which is what the data usually show.
 */
export const DEFAULT_AGENT_ICC = 0.3;
/** The kit schema's ceiling on `repeats`. */
const MAX_REPEATS = 100;

/**
 * `task_paired`: agent/harness kits; per-task differences, p = max(exact sign-flip test over
 * tasks, two-stage task bootstrap), CI from the bootstrap.
 */
export type ComparisonTest =
  | "newcombe"
  | "fisher_exact"
  | "mann_whitney_exact"
  | "mann_whitney_asymptotic"
  | "task_paired"
  /** TDM-210: difference in mean hidden-test fraction, one cell per arm. */
  | "permutation_exact"
  | "permutation_monte_carlo";

/** The over-tasks detail of a `task_paired` comparison. */
export interface TaskPairing {
  /** Oriented per-task difference (pass-rate difference, or Cliff's δ), positive = better. */
  perTask: { workloadId: string; diff: number }[];
  signFlipP: number;
  signFlipMethod: "exact" | "monte_carlo";
  bootstrapP: number;
}

export interface DiffInterval {
  lo: number;
  hi: number;
  /** Coverage the interval has (below `requestedLevel` only when `attained` is false). */
  level: number;
  requestedLevel: number;
  attained: boolean;
  method: "newcombe" | "hodges_lehmann" | "task_bootstrap" | "welch_t";
  /**
   * `rate`: difference of two 0–1 quantities, in points: pass rates, or (effect `mean_diff`,
   * TDM-210) mean hidden-test fractions; `cliffs_delta`: Cliff's δ (task-averaged in clustered
   * kits). Both oriented so positive means the candidate is better. `metric`: Hodges–Lehmann
   * shift in the requirement's unit, raw candidate − baseline (lower is better for a time).
   */
  unit: "rate" | "metric" | "cliffs_delta";
}

export interface Effect {
  /**
   * `rate_diff`: candidate − baseline pass rate. `cliffs_delta`: P(cand better) − P(base better).
   * `mean_diff` (TDM-210): candidate − baseline mean of a 0–1 metric (hidden_test_fraction).
   */
  measure: "rate_diff" | "cliffs_delta" | "mean_diff";
  /** Oriented: positive means the candidate is better. */
  value: number;
  /** Cliff's δ magnitude (continuous only). */
  magnitude: EffectMagnitude | null;
  /** Hodges–Lehmann shift, candidate − baseline, in the metric's unit (software, finite data). */
  hodgesLehmann: number | null;
  /** Pass rates (rate_diff) or mean fractions (mean_diff); null for cliffs_delta. */
  candidateRate: number | null;
  baselineRate: number | null;
}

export interface SmallestDetectable {
  /** In `unit`; null when no difference is detectable at this n. */
  value: number | null;
  unit: "rate" | "cliffs_delta";
  /** Continuous: the δ translated into the metric's unit, from the pooled spread (≈). */
  metricShift: number | null;
  /** The per-comparison α it was computed at (α / family size). */
  alpha: number;
  power: number;
}

export type DowngradeReason = "survivorship" | "effect_size" | "multiplicity";

export interface Comparison {
  baseline: string;
  verdict: Verdict;
  test: ComparisonTest;
  /** Unadjusted two-sided p. */
  p: number;
  /** Holm-adjusted across `family` comparisons. */
  pAdjusted: number;
  alpha: number;
  family: number;
  effect: Effect;
  ci: DiffInterval;
  n: { candidate: number; baseline: number; tasks: number };
  clustered: boolean;
  /** Agent/harness kits: the per-task differences and both tests over them; else null. */
  tasks: TaskPairing | null;
  mde: SmallestDetectable;
  /** `these_tasks`: an agent/harness result on fewer than 20 tasks speaks only for them. */
  claim: "general" | "these_tasks";
  /** Why the verdict is not `better`/`worse` although the data lean that way. */
  downgraded: DowngradeReason | null;
  /** One line for the report: "better on these 3 tasks: …", "no detectable difference at n=…". */
  statement: string;
}

// ---------------------------------------------------------------------------------------------
// Inputs (built by score.ts from WorkloadCells).

export interface ArmCell {
  workloadId: string;
  /** Per-trial values, as in WorkloadCell.samples (rate: 1/0 per trial). */
  samples: readonly number[];
  trials: number;
  solved: number;
}

/** `mean` (TDM-210): a 0–1 metric compared by its mean (hidden_test_fraction). */
export type ComparisonKind = "rate" | "continuous" | "mean";

export interface ComparisonSpec {
  kind: ComparisonKind;
  better: "higher" | "lower";
  /** Same workloads, same order. */
  candidate: readonly ArmCell[];
  baseline: readonly ArmCell[];
  clustered: boolean;
  /** Survivorship-biased requirement: never `better`. */
  survivorship: boolean;
  /**
   * Unclustered pass rates: `newcombe` (default; software kits) or `fisher_exact` (one task's
   * repeats in an agent kit, E18: exact at any n). The CI is Newcombe's either way.
   */
  rateTest?: "newcombe" | "fisher_exact";
  /** The requirement's unit, for the statement ("s", "ms"). */
  unit?: string | undefined;
  seed: number;
  iterations?: number;
  level?: number;
  power?: number;
}

/** A comparison before multiplicity: everything but the verdict. */
export interface RawComparison {
  spec: ComparisonSpec;
  test: ComparisonTest;
  p: number;
  effect: Effect;
  ci: DiffInterval;
  n: { candidate: number; baseline: number; tasks: number };
  tasks?: TaskPairing;
  /** Smallest detectable difference at a per-comparison α. */
  mdeAt: (alpha: number) => SmallestDetectable;
}

const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);
const mean = (xs: readonly number[]) => (xs.length === 0 ? 0 : sum(xs) / xs.length);

function percentile(sortedXs: readonly number[], p: number): number {
  const h = (sortedXs.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  const a = sortedXs[lo]!;
  const b = sortedXs[hi]!;
  if (a === b) return a;
  return a + (h - lo) * (b - a);
}

/** FNV-1a over the parts, mixed into `base`: a stable seed per comparison. */
export function seedFor(base: number, ...parts: string[]): number {
  let h = (0x811c9dc5 ^ base) >>> 0;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      h ^= part.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Bootstrap p-value: the doubled smaller tail of the resampled statistic around 0. */
function bootstrapP(stats: readonly number[]): number {
  let le = 0;
  let ge = 0;
  for (const s of stats) {
    if (s <= 0) le++;
    if (s >= 0) ge++;
  }
  const b = stats.length;
  return Math.min(1, 2 * Math.min((le + 1) / (b + 1), (ge + 1) / (b + 1)));
}

function sd(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1));
}

/**
 * One-way ANOVA intra-class correlation of `groups` (each a list of values), clamped to [0, 1].
 * 0 when it can't be estimated.
 */
export function intraClassCorrelation(groups: readonly (readonly number[])[]): number {
  const gs = groups.filter((g) => g.length > 0);
  const k = gs.length;
  const N = sum(gs.map((g) => g.length));
  if (k < 2 || N - k < 1) return 0;
  const grand = sum(gs.map((g) => sum(g))) / N;
  const msb = sum(gs.map((g) => g.length * (mean(g) - grand) ** 2)) / (k - 1);
  const msw = sum(gs.map((g) => sum(g.map((x) => (x - mean(g)) ** 2)))) / (N - k);
  const n0 = (N - sum(gs.map((g) => g.length ** 2)) / N) / (k - 1);
  const denom = msb + (n0 - 1) * msw;
  if (!(denom > 0)) return msb > 0 ? 1 : 0;
  return Math.min(1, Math.max(0, (msb - msw) / denom));
}

const orient = (better: "higher" | "lower") => (better === "lower" ? -1 : 1);

/** Zero, never −0. */
const z0 = (x: number) => (x === 0 ? 0 : x);

// ---------------------------------------------------------------------------------------------
// Unclustered (software): one comparison per workload cell.

function compareRateCell(spec: ComparisonSpec): RawComparison {
  const c = spec.candidate[0]!;
  const b = spec.baseline[0]!;
  const level = spec.level ?? DECISION_RULE.level;
  const power = spec.power ?? DECISION_RULE.power;
  const sign = orient(spec.better);
  const ci = newcombeCi(c.solved, c.trials, b.solved, b.trials, level);
  const fisher = spec.rateTest === "fisher_exact";
  const p = fisher
    ? fisherExact(c.solved, c.trials, b.solved, b.trials)
    : newcombePValue(c.solved, c.trials, b.solved, b.trials);
  const pooled = (c.solved + b.solved) / (c.trials + b.trials);
  return {
    spec,
    test: fisher ? "fisher_exact" : "newcombe",
    p,
    effect: {
      measure: "rate_diff",
      value: z0(sign * ci.estimate),
      magnitude: null,
      hodgesLehmann: null,
      candidateRate: c.solved / c.trials,
      baselineRate: b.solved / b.trials,
    },
    ci: {
      lo: z0(sign > 0 ? ci.lo : -ci.hi),
      hi: z0(sign > 0 ? ci.hi : -ci.lo),
      level,
      requestedLevel: level,
      attained: true,
      method: "newcombe",
      unit: "rate",
    },
    n: { candidate: c.trials, baseline: b.trials, tasks: 1 },
    mdeAt: (alpha) => ({
      // Fisher can't go below 2 / C(n1+n2, n1) (a full split), the same floor as Mann–Whitney.
      value:
        fisher && minMannWhitneyP(c.trials, b.trials) >= alpha
          ? null
          : mdeTwoProportions(c.trials, b.trials, { alpha, power, rate: pooled }),
      unit: "rate",
      metricShift: null,
      alpha,
      power,
    }),
  };
}

function compareContinuousCell(spec: ComparisonSpec): RawComparison {
  const x = spec.candidate[0]!.samples;
  const y = spec.baseline[0]!.samples;
  const level = spec.level ?? DECISION_RULE.level;
  const power = spec.power ?? DECISION_RULE.power;
  const sign = orient(spec.better);
  const mw = mannWhitney(x, y);
  const delta = z0(sign * cliffsDelta(x, y));
  const finite = [...x, ...y].every(Number.isFinite);
  const hl = finite ? hodgesLehmannCi(x, y, level) : null;
  const finiteAll = [...x, ...y].filter(Number.isFinite);
  const spread = finiteAll.length >= 2 ? robustSd(finiteAll) : 0;
  return {
    spec,
    test: mw.method === "exact" ? "mann_whitney_exact" : "mann_whitney_asymptotic",
    p: mw.p,
    effect: {
      measure: "cliffs_delta",
      value: delta,
      magnitude: effectMagnitude(delta),
      hodgesLehmann: hl ? z0(hl.estimate) : null,
      candidateRate: null,
      baselineRate: null,
    },
    ci: hl
      ? {
          lo: hl.lo,
          hi: hl.hi,
          level: hl.level,
          requestedLevel: hl.requestedLevel,
          attained: hl.attained,
          method: "hodges_lehmann",
          unit: "metric",
        }
      : // Infinite values (failures counted as never solved) have no finite shift: report δ's
        // own range instead, which is honest and wide.
        {
          lo: -1,
          hi: 1,
          level: 1,
          requestedLevel: level,
          attained: true,
          method: "hodges_lehmann",
          unit: "cliffs_delta",
        },
    n: { candidate: x.length, baseline: y.length, tasks: 1 },
    mdeAt: (alpha) => {
      const raw = mdeCliffsDelta(x.length, y.length, { alpha, power });
      const value = raw === null ? null : Math.max(raw, DECISION_RULE.minCliffsDelta);
      return {
        value,
        unit: "cliffs_delta",
        metricShift:
          value !== null && value < 1 && spread > 0 ? shiftForCliffsDelta(value, spread) : null,
        alpha,
        power,
      };
    },
  };
}

/** z for a two-sided test at `alpha` with `power`. */
const zFor = (alpha: number, power: number) =>
  normalQuantile(1 - alpha / 2) + normalQuantile(power);

/**
 * Smallest detectable difference in mean of 0–1 values with `nC` and `nB` effectively
 * independent trials and spread `sd` (when the data show none, the worst case for [0, 1]: 0.5).
 * Null when it is above 1 (nothing on the scale is detectable).
 */
function mdeMean(nC: number, nB: number, sd: number, alpha: number, power: number): number | null {
  const s = sd > 0 ? sd : 0.5;
  const v = zFor(alpha, power) * s * Math.sqrt(1 / nC + 1 / nB);
  return v > 1 ? null : v;
}

function compareMeanCell(spec: ComparisonSpec): RawComparison {
  const x = spec.candidate[0]!.samples;
  const y = spec.baseline[0]!.samples;
  const level = spec.level ?? DECISION_RULE.level;
  const power = spec.power ?? DECISION_RULE.power;
  const sign = orient(spec.better);
  const perm = permutationMeanTest(x, y, { seed: spec.seed });
  const w = welchDiffCi(x, y, level);
  const pooledSd = Math.sqrt(
    (sum(x.map((v) => (v - mean(x)) ** 2)) + sum(y.map((v) => (v - mean(y)) ** 2))) /
      Math.max(1, x.length + y.length - 2),
  );
  return {
    spec,
    test: perm.method === "exact" ? "permutation_exact" : "permutation_monte_carlo",
    p: perm.p,
    effect: {
      measure: "mean_diff",
      value: z0(sign * w.estimate),
      magnitude: null,
      hodgesLehmann: null,
      candidateRate: mean(x),
      baselineRate: mean(y),
    },
    ci: {
      lo: z0(sign > 0 ? w.lo : -w.hi),
      hi: z0(sign > 0 ? w.hi : -w.lo),
      level,
      requestedLevel: level,
      attained: true,
      method: "welch_t",
      unit: "rate",
    },
    n: { candidate: x.length, baseline: y.length, tasks: 1 },
    mdeAt: (alpha) => ({
      // The permutation test can't go below 2 / C(n1+n2, n1), like exact Mann–Whitney.
      value:
        minMannWhitneyP(x.length, y.length) >= alpha
          ? null
          : mdeMean(x.length, y.length, pooledSd, alpha, power),
      unit: "rate",
      metricShift: null,
      alpha,
      power,
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Clustered (agent, harness): one comparison per requirement, tasks as the unit.

function resample(xs: readonly number[], rand: () => number): number[] {
  const out = new Array<number>(xs.length);
  for (let i = 0; i < xs.length; i++) out[i] = xs[Math.floor(rand() * xs.length)]!;
  return out;
}

function compareClustered(spec: ComparisonSpec): RawComparison {
  const level = spec.level ?? DECISION_RULE.level;
  const power = spec.power ?? DECISION_RULE.power;
  const iterations = spec.iterations ?? DECISION_RULE.bootstrapIterations;
  const sign = orient(spec.better);
  // Tasks where both arms have data.
  const paired = spec.candidate
    .map((c, i) => ({ id: c.workloadId, c: c.samples, b: spec.baseline[i]!.samples }))
    .filter(({ c, b }) => c.length > 0 && b.length > 0);
  const pairs = paired.map(({ c, b }) => [c, b] as const);
  const T = pairs.length;
  const rate = spec.kind === "rate";
  // A mean of 0–1 values is on one scale on every task: per-task mean difference, like a rate.
  const byMean = rate || spec.kind === "mean";

  const perTask = (c: readonly number[], b: readonly number[]) =>
    byMean ? sign * (mean(c) - mean(b)) : sign * cliffsDelta(c, b);
  const diffs = pairs.map(([c, b]) => z0(perTask(c, b)));
  const statistic = z0(mean(diffs));
  // Exact over tasks: the per-task differences' signs under "no difference" are coin flips.
  const flip = signFlipTest(diffs, { seed: spec.seed ^ 0x5f1b });

  const rand = mulberry32(spec.seed);
  const boot = new Array<number>(iterations);
  for (let it = 0; it < iterations; it++) {
    let acc = 0;
    for (let t = 0; t < T; t++) {
      const [c, b] = pairs[Math.floor(rand() * T)]!;
      acc += perTask(resample(c, rand), resample(b, rand));
    }
    boot[it] = acc / T;
  }
  const sortedBoot = [...boot].sort((a, b) => a - b);
  const alphaCi = 1 - level;
  const se = sd(boot);
  const nC = sum(pairs.map(([c]) => c.length));
  const nB = sum(pairs.map(([, b]) => b.length));

  let effect: Effect;
  let mdeAt: RawComparison["mdeAt"];
  if (rate) {
    const cRate = sum(pairs.map(([c]) => sum(c))) / nC;
    const bRate = sum(pairs.map(([, b]) => sum(b))) / nB;
    effect = {
      measure: "rate_diff",
      value: statistic,
      magnitude: null,
      hodgesLehmann: null,
      candidateRate: cRate,
      baselineRate: bRate,
    };
    const groups = pairs.flatMap(([c, b]) => [c, b]);
    const icc = intraClassCorrelation(groups);
    const mBar = (nC + nB) / Math.max(1, groups.length);
    const deff = 1 + (mBar - 1) * icc;
    const pooled = (cRate * nC + bRate * nB) / (nC + nB);
    mdeAt = (alpha) => {
      const analytic = mdeTwoProportions(nC / deff, nB / deff, { alpha, power, rate: pooled });
      const z = normalQuantile(1 - alpha / 2) + normalQuantile(power);
      const fromBoot = z * se;
      const value =
        analytic === null || fromBoot > 1 || flip.minP >= alpha
          ? null
          : Math.max(analytic, fromBoot);
      return { value, unit: "rate", metricShift: null, alpha, power };
    };
  } else if (byMean) {
    const cMean = sum(pairs.map(([c]) => sum(c))) / nC;
    const bMean = sum(pairs.map(([, b]) => sum(b))) / nB;
    effect = {
      measure: "mean_diff",
      value: statistic,
      magnitude: null,
      hodgesLehmann: null,
      candidateRate: cMean,
      baselineRate: bMean,
    };
    const groups = pairs.flatMap(([c, b]) => [c, b]);
    const icc = intraClassCorrelation(groups);
    const mBar = (nC + nB) / Math.max(1, groups.length);
    const deff = 1 + (mBar - 1) * icc;
    const spread = sd(groups.flat());
    mdeAt = (alpha) => {
      const analytic = mdeMean(nC / deff, nB / deff, spread, alpha, power);
      const fromBoot = zFor(alpha, power) * se;
      const value =
        analytic === null || fromBoot > 1 || flip.minP >= alpha
          ? null
          : Math.max(analytic, fromBoot);
      return { value, unit: "rate", metricShift: null, alpha, power };
    };
  } else {
    effect = {
      measure: "cliffs_delta",
      value: statistic,
      magnitude: effectMagnitude(statistic),
      hodgesLehmann: null,
      candidateRate: null,
      baselineRate: null,
    };
    mdeAt = (alpha) => {
      const z = normalQuantile(1 - alpha / 2) + normalQuantile(power);
      const noether = (2 * z) / Math.sqrt((12 * nC * nB) / (nC + nB));
      const raw = Math.max(noether, z * se, DECISION_RULE.minCliffsDelta);
      const value = raw > 1 || flip.minP >= alpha ? null : raw;
      return { value, unit: "cliffs_delta", metricShift: null, alpha, power };
    };
  }
  return {
    spec,
    test: "task_paired",
    // The more conservative of the exact test over tasks (tasks are the unit) and the two-stage
    // bootstrap (which also sees the noise within a task).
    p: T === 0 ? 1 : Math.max(bootstrapP(boot), flip.p),
    tasks: {
      perTask: paired.map(({ id }, i) => ({ workloadId: id, diff: diffs[i]! })),
      signFlipP: flip.p,
      signFlipMethod: flip.method,
      bootstrapP: T === 0 ? 1 : bootstrapP(boot),
    },
    effect,
    ci: {
      lo: T === 0 ? -1 : percentile(sortedBoot, alphaCi / 2),
      hi: T === 0 ? 1 : percentile(sortedBoot, 1 - alphaCi / 2),
      level,
      requestedLevel: level,
      attained: true,
      method: "task_bootstrap",
      unit: byMean ? "rate" : "cliffs_delta",
    },
    n: { candidate: nC, baseline: nB, tasks: T },
    mdeAt,
  };
}

/**
 * Compare a candidate with the baseline (before multiplicity). Clustered specs use every cell;
 * unclustered specs must have exactly one cell per arm. Returns null when there is nothing to
 * compare (an arm without samples).
 */
export function compareArms(spec: ComparisonSpec): RawComparison | null {
  if (spec.candidate.length !== spec.baseline.length)
    throw new RangeError("candidate and baseline need the same workloads");
  if (spec.clustered) {
    const any = spec.candidate.some(
      (c, i) => c.samples.length > 0 && spec.baseline[i]!.samples.length > 0,
    );
    return any ? compareClustered(spec) : null;
  }
  if (spec.candidate.length !== 1)
    throw new RangeError("an unclustered comparison is one workload cell per arm");
  const c = spec.candidate[0]!;
  const b = spec.baseline[0]!;
  if (spec.kind === "rate") {
    if (c.trials < 1 || b.trials < 1) return null;
    return compareRateCell(spec);
  }
  if (c.samples.length === 0 || b.samples.length === 0) return null;
  return spec.kind === "mean" ? compareMeanCell(spec) : compareContinuousCell(spec);
}

// ---------------------------------------------------------------------------------------------
// Verdicts with Holm across the family.

export interface DecideOptions {
  alpha?: number;
  baseline: string;
  /** Tasks needed for a general agent claim. Default 20. */
  minTasksForClaim?: number;
}

const pts = (d: number) => `${Math.round(d * 100)} pts`;
const signedPts = (d: number) =>
  `${d > 0 ? "+" : d < 0 ? "−" : ""}${Math.abs(Math.round(d * 100))} pts`;
const fmtDelta = (d: number) => `${d > 0 ? "+" : d < 0 ? "−" : ""}${Math.abs(d).toFixed(2)}`;
const fmtP = (p: number) => (p < 0.001 ? "<0.001" : p.toFixed(3));

function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return v > 0 ? "∞" : "−∞";
  const abs = Math.abs(v);
  const s = abs >= 100 ? abs.toFixed(0) : abs >= 10 ? abs.toFixed(1) : abs.toPrecision(3);
  return `${v < 0 ? "−" : ""}${s}`;
}
const withUnit = (v: number, unit?: string) => `${fmtNum(v)}${unit ? ` ${unit}` : ""}`;

function nText(r: RawComparison): string {
  const trials = `${r.n.candidate} vs ${r.n.baseline}`;
  return r.spec.clustered
    ? `${r.n.tasks} task${r.n.tasks === 1 ? "" : "s"} (${trials} trials)`
    : trials;
}

function mdeText(m: SmallestDetectable, unit?: string): string {
  if (m.value === null) return "none reachable at this n";
  if (m.unit === "rate") return pts(m.value);
  const shift = m.metricShift === null ? "" : ` (≈${withUnit(m.metricShift, unit)})`;
  return `|δ| ${m.value.toFixed(2)}${shift}`;
}

function effectText(r: RawComparison): string {
  const e = r.effect;
  const method = {
    newcombe: "Newcombe score",
    hodges_lehmann: r.test === "mann_whitney_exact" ? "exact Hodges–Lehmann" : "Hodges–Lehmann",
    task_bootstrap: "task-bootstrap",
    welch_t: "Welch t",
  }[r.ci.method];
  const lvl = `${Math.round(r.ci.level * 1000) / 10}% ${method} CI${r.ci.attained ? "" : `, the most this n attains`}`;
  if (e.measure === "rate_diff") {
    return `${signedPts(e.value)} pass rate (${lvl} ${signedPts(r.ci.lo)} to ${signedPts(r.ci.hi)})`;
  }
  if (e.measure === "mean_diff") {
    const means =
      e.candidateRate !== null && e.baselineRate !== null
        ? `, ${pts(e.candidateRate)} vs ${pts(e.baselineRate)}`
        : "";
    return `${signedPts(e.value)} mean fraction${means} (${lvl} ${signedPts(r.ci.lo)} to ${signedPts(r.ci.hi)})`;
  }
  const delta = `Cliff's δ ${fmtDelta(e.value)}`;
  if (r.ci.unit === "metric" && e.hodgesLehmann !== null) {
    const u = r.spec.unit;
    return `${delta}, shift ${withUnit(e.hodgesLehmann, u)} (${lvl} ${withUnit(r.ci.lo, u)} to ${withUnit(r.ci.hi, u)})`;
  }
  if (r.ci.unit === "cliffs_delta" && r.spec.clustered) {
    return `${delta} averaged over tasks (${lvl} ${fmtDelta(r.ci.lo)} to ${fmtDelta(r.ci.hi)})`;
  }
  return delta;
}

/**
 * The smallest p the comparison's test can give at its n, whatever the data: 2 / 2^T for the exact
 * sign-flip test over T tasks, 2 / C(n1+n2, n1) for an exact two-sample test (Fisher, exact
 * Mann–Whitney, permutation), 0 for an asymptotic one.
 */
function attainableFloor(r: RawComparison): number {
  switch (r.test) {
    case "task_paired":
      return Math.min(1, 2 / 2 ** r.n.tasks);
    case "fisher_exact":
    case "mann_whitney_exact":
    case "permutation_exact":
      return minMannWhitneyP(r.n.candidate, r.n.baseline);
    default:
      return 0;
  }
}

/**
 * Turn raw comparisons into verdicts: Holm-adjust their p-values as one family, apply the effect
 * size and survivorship rules, and phrase each one. Same order as the input.
 */
export function decide(raws: readonly RawComparison[], opts: DecideOptions): Comparison[] {
  const alpha = opts.alpha ?? DECISION_RULE.alpha;
  const minTasks = opts.minTasksForClaim ?? DECISION_RULE.minTasksForClaim;
  const m = raws.length;
  const adjusted = holmAdjust(raws.map((r) => r.p));
  return raws.map((r, i) => {
    const pAdjusted = adjusted[i]!;
    const mde = r.mdeAt(alpha / Math.max(1, m));
    const continuous = r.effect.measure === "cliffs_delta";
    const bigEnough = !continuous || Math.abs(r.effect.value) >= DECISION_RULE.minCliffsDelta;
    const significant = pAdjusted < alpha;
    let verdict: Verdict = "indistinguishable";
    let downgraded: DowngradeReason | null = null;
    if (significant && bigEnough && r.effect.value !== 0) {
      verdict = r.effect.value > 0 ? "better" : "worse";
    } else if (significant && !bigEnough) {
      downgraded = "effect_size";
    } else if (!significant && r.p < alpha) {
      downgraded = "multiplicity";
    }
    if (verdict === "better" && r.spec.survivorship) {
      verdict = "indistinguishable";
      downgraded = "survivorship";
    }
    const claim: Comparison["claim"] =
      r.spec.clustered && r.n.tasks < minTasks ? "these_tasks" : "general";

    let statement: string;
    if (verdict === "indistinguishable") {
      statement = `no detectable difference at n=${nText(r)}, smallest detectable difference=${mdeText(mde, r.spec.unit)}`;
      if (downgraded === "survivorship")
        statement += `; it leans better, but the value is a median over solved trials only, so it can't show better (${effectText(r)})`;
      else statement += `; observed ${effectText(r)}`;
      if (downgraded === "effect_size")
        statement += `; significant but |δ| ${Math.abs(r.effect.value).toFixed(2)} < ${DECISION_RULE.minCliffsDelta}`;
      else if (downgraded === "multiplicity")
        statement += `; p=${fmtP(r.p)} is not significant after Holm correction across ${m} comparisons`;
      // Tasks are the unit: too few of them and no data can show a general difference.
      const floor = attainableFloor(r);
      if (r.spec.clustered && floor >= alpha / Math.max(1, m))
        statement += `; ${floor >= alpha ? "not significant: " : ""}insufficient tasks for a general claim: the exact test over ${r.n.tasks} task${r.n.tasks === 1 ? "" : "s"} can't go below p=${fmtP(floor)}, ≥${minTasksForSignificance(alpha / Math.max(1, m))} tasks needed`;
      else if (!r.spec.clustered && floor >= alpha)
        // TDM-210: too few trials for ANY result to be significant, whatever they show.
        statement += `; not significant: n=${nText(r)} is too small for any difference to be significant (the exact test can't go below p=${fmtP(floor)}), ≥${minRepeatsForPerTask(m, alpha)} trials per setup needed across ${m} comparison${m === 1 ? "" : "s"}`;
    } else {
      const where =
        claim === "these_tasks" ? ` on these ${r.n.tasks} task${r.n.tasks === 1 ? "" : "s"}` : "";
      statement = `${verdict}${where}: ${effectText(r)}, Holm p=${fmtP(pAdjusted)}, n=${nText(r)}`;
    }
    return {
      baseline: opts.baseline,
      verdict,
      test: r.test,
      p: r.p,
      pAdjusted,
      alpha,
      family: m,
      effect: r.effect,
      ci: r.ci,
      n: r.n,
      clustered: r.spec.clustered,
      tasks: r.tasks ?? null,
      mde,
      claim,
      downgraded,
      statement,
    };
  });
}

/**
 * The verdict of a requirement compared per workload (software kits): better when some workload
 * is better and none worse, worse the other way round, otherwise indistinguishable.
 */
export function combineVerdicts(verdicts: readonly Verdict[]): Verdict {
  const better = verdicts.includes("better");
  const worse = verdicts.includes("worse");
  if (better && !worse) return "better";
  if (worse && !better) return "worse";
  return "indistinguishable";
}

// ---------------------------------------------------------------------------------------------
// Power plan for the test plan screen (plan.md 17.2 rule 3).

export interface PowerPlanInput {
  kind: SubjectKind;
  /** Workloads (tasks) in the kit. */
  tasks: number;
  /** Setups compared (contenders × vary values), including the baseline. */
  contenders: number;
  /** Repeats the kit asks for. Default: the recommendation. */
  repeats?: number;
  /** Comparisons in the report's Holm family. Default (contenders − 1) × requirements (× tasks for software). */
  comparisons?: number;
  /** Requirements with weight > 0 (for the default family size). Default 1. */
  requirements?: number;
  /** Agent/harness intra-task correlation. Default DEFAULT_AGENT_ICC. */
  icc?: number;
  /** Expected pass rate on the primary requirement. Default 0.5 (the worst case). */
  baselineRate?: number;
  /** Pass-rate difference (0–1) the plan should be able to detect, if the buyer named one. */
  targetMde?: number;
  alpha?: number;
  power?: number;
  /** Discarded warm-ups per contender × workload. Default 0. */
  warmups?: number;
  /** Estimated cost of one trial, integer micro-USD. */
  estTrialCostMicroUsd?: MicroUsd;
}

export interface PowerAtRepeats {
  repeats: number;
  /** Effective independent trials per arm on one comparison. */
  effectiveN: number;
  /** Smallest detectable pass-rate difference (0–1) on the primary comparison; null = none. */
  passRate: number | null;
  /** Smallest detectable |Cliff's δ| on a continuous metric (≥ 0.33); null = none. */
  cliffsDelta: number | null;
}

export interface PowerPlan {
  kind: SubjectKind;
  tasks: number;
  contenders: number;
  alpha: number;
  power: number;
  comparisons: number;
  /** α / comparisons: what the first Holm step needs. */
  perComparisonAlpha: number;
  icc: number;
  /** Software: each repeat is a hyperfine run of at least this many iterations. */
  hyperfineMinRuns: number | null;
  planned: PowerAtRepeats;
  recommendedRepeats: number;
  recommended: PowerAtRepeats;
  /** Measured trials plus warm-ups at the recommended repeats. */
  trials: { perContender: number; total: number };
  estimatedCostMicroUsd: MicroUsd | null;
  /** Agent/harness kits with fewer than 20 tasks can only claim "on these N tasks". */
  claim: "general" | "these_tasks";
  /** Tasks needed to reach `targetMde` at the recommended repeats (agent kits), if it is not. */
  tasksForTarget: number | null;
  notes: string[];
}

function powerAt(
  input: Required<Pick<PowerPlanInput, "kind" | "tasks">> & {
    repeats: number;
    icc: number;
    rate: number;
    alpha: number;
    power: number;
  },
): PowerAtRepeats {
  const clustered = input.kind !== "software";
  // Software compares per workload (one task's repeats); agents pool tasks with a design effect.
  const n = clustered ? input.tasks * input.repeats : input.repeats;
  const deff = clustered ? 1 + (input.repeats - 1) * input.icc : 1;
  const effectiveN = n / deff;
  const passRate = mdeTwoProportions(effectiveN, effectiveN, {
    alpha: input.alpha,
    power: input.power,
    rate: input.rate,
  });
  let delta: number | null;
  if (clustered) {
    const z = normalQuantile(1 - input.alpha / 2) + normalQuantile(input.power);
    const d = (2 * z) / Math.sqrt((12 * effectiveN * effectiveN) / (2 * effectiveN));
    delta = d > 1 ? null : Math.max(d, DECISION_RULE.minCliffsDelta);
  } else {
    const d = mdeCliffsDelta(input.repeats, input.repeats, {
      alpha: input.alpha,
      power: input.power,
    });
    delta = d === null ? null : Math.max(d, DECISION_RULE.minCliffsDelta);
  }
  // Agent kits test over tasks exactly (sign flips): T tasks can't give p below 2 / 2^T.
  if (clustered && 2 / 2 ** input.tasks >= input.alpha) {
    return { repeats: input.repeats, effectiveN, passRate: null, cliffsDelta: null };
  }
  return { repeats: input.repeats, effectiveN, passRate, cliffsDelta: delta };
}

/**
 * E18: fewest repeats per arm × task at which a per-task result can be significant at all after
 * Holm across `family` task × requirement tests: an exact test on r vs r repeats can't go below
 * 2 / C(2r, r) (a full split), and Holm's first step needs p < α / family. Below this every
 * per-task verdict is "no detectable difference" whatever the data.
 */
export function minRepeatsForPerTask(family: number, alpha: number = DECISION_RULE.alpha): number {
  let r = 1;
  while (r < MAX_REPEATS && minMannWhitneyP(r, r) >= alpha / Math.max(1, family)) r++;
  return r;
}

/** Fewest tasks whose exact sign-flip test can reach `alpha` (2 / 2^T < alpha). */
export function minTasksForSignificance(alpha: number): number {
  let t = 1;
  while (2 / 2 ** t >= alpha) t++;
  return t;
}

/**
 * The test plan's power estimate: the smallest difference the planned repeats can detect, the
 * repeats we recommend, and what they cost. Recommended repeats are the largest of: the kind's
 * default (software 5, agents 10), the floor (4), the fewest at which the exact test can reach
 * significance across the report's comparisons at all (software), and the fewest that reach
 * `targetMde` (when given and reachable by repeats). Capped at 100 (the kit schema's limit).
 */
export function powerPlan(input: PowerPlanInput): PowerPlan {
  if (!Number.isInteger(input.tasks) || input.tasks < 1)
    throw new RangeError("tasks must be a positive integer");
  if (!Number.isInteger(input.contenders) || input.contenders < 2)
    throw new RangeError("a comparison needs at least 2 contenders");
  const alpha = input.alpha ?? DECISION_RULE.alpha;
  const power = input.power ?? DECISION_RULE.power;
  const software = input.kind === "software";
  const requirements = input.requirements ?? 1;
  const comparisons =
    input.comparisons ?? (input.contenders - 1) * requirements * (software ? input.tasks : 1);
  const perAlpha = alpha / Math.max(1, comparisons);
  const icc = software ? 0 : (input.icc ?? DEFAULT_AGENT_ICC);
  const rate = input.baselineRate ?? 0.5;
  const at = (repeats: number) =>
    powerAt({ kind: input.kind, tasks: input.tasks, repeats, icc, rate, alpha: perAlpha, power });
  const notes: string[] = [];

  let recommended = Math.max(DEFAULT_REPEATS[input.kind], REPEATS_FLOOR);
  if (software) {
    let r = recommended;
    while (r < MAX_REPEATS && minMannWhitneyP(r, r) >= perAlpha) r++;
    if (r > recommended) {
      notes.push(
        `${recommended} repeats can't reach significance across ${comparisons} comparisons (the best possible exact p is ${fmtP(minMannWhitneyP(recommended, recommended))}); ${r} can.`,
      );
      recommended = r;
    }
  }
  if (!software && 2 / 2 ** input.tasks >= perAlpha) {
    notes.push(
      `${input.tasks} task${input.tasks === 1 ? "" : "s"} can't show any difference: the exact test over tasks needs at least ${minTasksForSignificance(perAlpha)} tasks at α=${fmtP(perAlpha)} (${comparisons} comparisons). More repeats don't fix this.`,
    );
  }
  let tasksForTarget: number | null = null;
  if (input.targetMde !== undefined) {
    let r = recommended;
    while (r < MAX_REPEATS && !((at(r).passRate ?? 2) <= input.targetMde)) r++;
    if ((at(r).passRate ?? 2) <= input.targetMde) recommended = r;
    else if (!software) {
      // Repeats alone can't get there (the design effect caps it): more tasks can.
      let t = input.tasks;
      const fits = (tasks: number) =>
        (powerAt({
          kind: input.kind,
          tasks,
          repeats: recommended,
          icc,
          rate,
          alpha: perAlpha,
          power,
        }).passRate ?? 2) <= input.targetMde!;
      while (t < 10_000 && !fits(t)) t++;
      tasksForTarget = fits(t) ? t : null;
      notes.push(
        `repeats alone can't detect ${pts(input.targetMde)} at ${input.tasks} tasks; ${tasksForTarget ?? "more than 10000"} tasks at ${recommended} repeats can.`,
      );
    } else {
      notes.push(`${pts(input.targetMde)} isn't detectable within ${MAX_REPEATS} repeats.`);
    }
  }
  recommended = Math.min(recommended, MAX_REPEATS);

  const planned = at(input.repeats ?? recommended);
  const rec = at(recommended);
  const warmups = input.warmups ?? 0;
  const perContender = input.tasks * (recommended + warmups);
  const total = perContender * input.contenders;
  const claim: PowerPlan["claim"] =
    !software && input.tasks < DECISION_RULE.minTasksForClaim ? "these_tasks" : "general";
  if (claim === "these_tasks")
    notes.push(
      `with ${input.tasks} task${input.tasks === 1 ? "" : "s"} a win is reported as "on these ${input.tasks} tasks"; a general claim needs ≥${DECISION_RULE.minTasksForClaim} tasks stratified by shape and difficulty.`,
    );
  if (input.repeats !== undefined && input.repeats < REPEATS_FLOOR)
    notes.push(`${input.repeats} repeats is below the floor of ${REPEATS_FLOOR}.`);
  if (!software && icc > 0 && input.icc === undefined)
    notes.push(
      `assumes repeats of one task correlate at ${icc} (a pilot run replaces this with the measured value).`,
    );
  return {
    kind: input.kind,
    tasks: input.tasks,
    contenders: input.contenders,
    alpha,
    power,
    comparisons,
    perComparisonAlpha: perAlpha,
    icc,
    hyperfineMinRuns: software ? HYPERFINE_MIN_RUNS : null,
    planned,
    recommendedRepeats: recommended,
    recommended: rec,
    trials: { perContender, total },
    estimatedCostMicroUsd:
      input.estTrialCostMicroUsd === undefined ? null : input.estTrialCostMicroUsd * BigInt(total),
    claim,
    tasksForTarget,
    notes,
  };
}

/**
 * The parts of a kit the power plan reads (a KitSpec satisfies it). Setups = contenders × every
 * `vary` value; comparisons = (setups − 1) × weighted requirements (× workloads for software).
 */
export interface PowerPlanKit {
  subject: { kind: SubjectKind };
  contenders: readonly unknown[];
  workloads: readonly unknown[];
  requirements: readonly { id: string }[];
  scoring: { weights: Record<string, number> };
  repeats: number;
  vary?: Record<string, readonly unknown[]>;
  schedule?: { warmups?: number };
}

export function powerPlanForKit(
  kit: PowerPlanKit,
  opts: Pick<
    PowerPlanInput,
    "icc" | "baselineRate" | "targetMde" | "alpha" | "power" | "estTrialCostMicroUsd"
  > = {},
): PowerPlan {
  const setups =
    kit.contenders.length *
    Object.values(kit.vary ?? {}).reduce((p, values) => p * Math.max(1, values.length), 1);
  const weighted = kit.requirements.filter((r) => (kit.scoring.weights[r.id] ?? 0) > 0).length;
  return powerPlan({
    kind: kit.subject.kind,
    tasks: kit.workloads.length,
    contenders: Math.max(2, setups),
    repeats: kit.repeats,
    requirements: Math.max(1, weighted),
    warmups: kit.schedule?.warmups ?? 0,
    ...opts,
  });
}

/** The test plan's lines: what this many repeats can and can't detect, and what we recommend. */
export function formatPowerPlan(plan: PowerPlan): string[] {
  const det = (p: PowerAtRepeats) =>
    p.passRate === null ? "no pass-rate difference" : `${pts(p.passRate)} in pass rate`;
  const delta = (p: PowerAtRepeats) =>
    p.cliffsDelta === null
      ? "none on continuous metrics"
      : `|δ| ${p.cliffsDelta.toFixed(2)} on continuous metrics`;
  const shape = `${plan.tasks} task${plan.tasks === 1 ? "" : "s"} × ${plan.planned.repeats} repeats`;
  const lines = [
    `Smallest detectable difference at ${shape}: ${det(plan.planned)}, ${delta(plan.planned)} (${Math.round(plan.power * 100)}% power, α=${plan.alpha} Holm-corrected across ${plan.comparisons} comparison${plan.comparisons === 1 ? "" : "s"}).`,
    `Recommended: ${plan.recommendedRepeats} repeats per contender × task${plan.hyperfineMinRuns ? ` (each a hyperfine run of ≥${plan.hyperfineMinRuns} iterations)` : ""} → detects ${det(plan.recommended)}; ${plan.trials.total} trials${plan.estimatedCostMicroUsd === null ? "" : `, est. ${formatUsd(plan.estimatedCostMicroUsd)}`}.`,
  ];
  for (const n of plan.notes) lines.push(`Note: ${n}`);
  return lines;
}
