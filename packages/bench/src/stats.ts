// TDM-53 [5.8]: trial statistics (plan.md P3 "Stats"). Pure functions, no I/O, no Math.random.
//
// Conventions:
// - Quantiles use linear interpolation between order statistics (Hyndman–Fan type 7, the
//   default in R and NumPy), so `median` and `iqr` agree with what a reader gets from either.
// - Randomness only comes from `mulberry32(seed)`: the same seed gives the same CI, so a report
//   regenerated from the same trials prints the same interval.
// - Effect size vs the baseline is Cliff's delta plus the Hodges–Lehmann shift. Both are rank
//   based: trial timings are skewed and have outliers (a cold npm cache, one slow VM), and with
//   3–10 repeats per cell a mean/SD effect size (Cohen's d) is dominated by a single trial.
//   Cliff's delta answers "how often does the candidate beat the baseline" on a fixed [-1, 1]
//   scale; Hodges–Lehmann gives the typical difference in the metric's own unit (e.g. "-9 s").
// - Invalid input (empty sample, non-finite value, k out of range) throws a RangeError. These
//   are programmer errors: the scorer only calls them on gated, non-empty samples.

function assertSample(xs: readonly number[], name = "sample"): void {
  if (xs.length === 0) throw new RangeError(`${name} must not be empty`);
  for (const x of xs) {
    if (!Number.isFinite(x)) throw new RangeError(`${name} contains a non-finite value: ${x}`);
  }
}

function sorted(xs: readonly number[]): number[] {
  return [...xs].sort((a, b) => a - b);
}

/** Quantile of an already-sorted sample, type 7. `p` in [0, 1]. */
function quantileSorted(s: readonly number[], p: number): number {
  const h = (s.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  const a = s[lo]!;
  const b = s[hi]!;
  return a + (h - lo) * (b - a);
}

/** Quantile of a sample (type 7, linear interpolation). `p` in [0, 1]. */
export function quantile(xs: readonly number[], p: number): number {
  assertSample(xs);
  if (!(p >= 0 && p <= 1)) throw new RangeError(`quantile p must be in [0, 1], got ${p}`);
  return quantileSorted(sorted(xs), p);
}

export function median(xs: readonly number[]): number {
  return quantile(xs, 0.5);
}

export interface Iqr {
  q1: number;
  q3: number;
  iqr: number;
}

/** Interquartile range: Q3 − Q1 (type 7 quartiles). */
export function iqr(xs: readonly number[]): Iqr {
  assertSample(xs);
  const s = sorted(xs);
  const q1 = quantileSorted(s, 0.25);
  const q3 = quantileSorted(s, 0.75);
  return { q1, q3, iqr: q3 - q1 };
}

/** Deterministic 32-bit PRNG (mulberry32). Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BootstrapOptions {
  /** PRNG seed. Required, so every interval in a report is reproducible. */
  seed: number;
  /** Resamples. Default 2000. */
  iterations?: number;
  /** Confidence level. Default 0.95. */
  level?: number;
  /** Statistic to bootstrap. Default `median`. */
  statistic?: (xs: readonly number[]) => number;
}

export interface ConfidenceInterval {
  lo: number;
  hi: number;
  level: number;
  /** The statistic on the original sample. */
  estimate: number;
}

/**
 * Percentile bootstrap CI: resample with replacement `iterations` times, take the
 * (α/2, 1−α/2) quantiles of the statistic. A sample of one gives a zero-width interval.
 */
export function bootstrapCi(xs: readonly number[], opts: BootstrapOptions): ConfidenceInterval {
  assertSample(xs);
  const iterations = opts.iterations ?? 2000;
  const level = opts.level ?? 0.95;
  const statistic = opts.statistic ?? median;
  if (!Number.isInteger(iterations) || iterations < 1)
    throw new RangeError(`iterations must be a positive integer, got ${iterations}`);
  if (!(level > 0 && level < 1)) throw new RangeError(`level must be in (0, 1), got ${level}`);

  const rand = mulberry32(opts.seed);
  const n = xs.length;
  const stats = new Array<number>(iterations);
  const buf = new Array<number>(n);
  for (let i = 0; i < iterations; i++) {
    for (let j = 0; j < n; j++) buf[j] = xs[Math.floor(rand() * n)]!;
    stats[i] = statistic(buf);
  }
  stats.sort((a, b) => a - b);
  const alpha = 1 - level;
  return {
    lo: quantileSorted(stats, alpha / 2),
    hi: quantileSorted(stats, 1 - alpha / 2),
    level,
    estimate: statistic(xs),
  };
}

export interface Summary extends Iqr {
  n: number;
  median: number;
  min: number;
  max: number;
  ci: ConfidenceInterval;
}

/** Median, IQR, range and a seeded bootstrap CI of the median. */
export function summarize(xs: readonly number[], opts: BootstrapOptions): Summary {
  assertSample(xs);
  const s = sorted(xs);
  const q1 = quantileSorted(s, 0.25);
  const q3 = quantileSorted(s, 0.75);
  return {
    n: s.length,
    median: quantileSorted(s, 0.5),
    q1,
    q3,
    iqr: q3 - q1,
    min: s[0]!,
    max: s[s.length - 1]!,
    ci: bootstrapCi(xs, opts),
  };
}

function assertCounts(n: number, c: number, k: number): void {
  for (const [name, v] of [
    ["n", n],
    ["c", c],
    ["k", k],
  ] as const) {
    if (!Number.isInteger(v) || v < 0)
      throw new RangeError(`${name} must be a non-negative integer`);
  }
  if (c > n) throw new RangeError(`c (${c}) must be <= n (${n})`);
  if (k < 1 || k > n) throw new RangeError(`k must be in [1, n=${n}], got ${k}`);
}

/**
 * pass@k: probability that at least one of k attempts passes, unbiased estimate from n trials
 * with c passes (Chen et al. 2021): 1 − C(n−c, k) / C(n, k). Computed as a product so it never
 * forms a large binomial.
 */
export function passAtK(n: number, c: number, k: number): number {
  assertCounts(n, c, k);
  if (n - c < k) return 1;
  let fail = 1;
  for (let i = n - c + 1; i <= n; i++) fail *= 1 - k / i;
  return 1 - fail;
}

/**
 * pass^k: probability that all k attempts pass (consistency, as in τ-bench), unbiased estimate
 * C(c, k) / C(n, k).
 */
export function passHatK(n: number, c: number, k: number): number {
  assertCounts(n, c, k);
  if (c < k) return 0;
  let p = 1;
  for (let i = 0; i < k; i++) p *= (c - i) / (n - i);
  return p;
}

export type EffectMagnitude = "negligible" | "small" | "medium" | "large";

export interface EffectSize {
  /** Cliff's delta, P(candidate > baseline) − P(candidate < baseline), in [-1, 1]. */
  cliffsDelta: number;
  /** Romano et al. (2006) thresholds on |δ|: 0.147, 0.33, 0.474. */
  magnitude: EffectMagnitude;
  /** Hodges–Lehmann shift: median of all pairwise (candidate − baseline), in the metric's unit. */
  hodgesLehmann: number;
  nCandidate: number;
  nBaseline: number;
}

/** Cliff's δ. Rank based, so ±Infinity (a failure counted as worse than anything) is allowed. */
export function cliffsDelta(candidate: readonly number[], baseline: readonly number[]): number {
  assertOrdered(candidate, "candidate");
  assertOrdered(baseline, "baseline");
  let gt = 0;
  let lt = 0;
  for (const x of candidate) {
    for (const y of baseline) {
      if (x > y) gt++;
      else if (x < y) lt++;
    }
  }
  return (gt - lt) / (candidate.length * baseline.length);
}

export function hodgesLehmann(candidate: readonly number[], baseline: readonly number[]): number {
  assertSample(candidate, "candidate");
  assertSample(baseline, "baseline");
  const diffs: number[] = [];
  for (const x of candidate) for (const y of baseline) diffs.push(x - y);
  return median(diffs);
}

export function effectMagnitude(delta: number): EffectMagnitude {
  const d = Math.abs(delta);
  if (d < 0.147) return "negligible";
  if (d < 0.33) return "small";
  if (d < 0.474) return "medium";
  return "large";
}

/**
 * Effect size of a candidate vs the baseline on one metric. Raw orientation: a positive delta
 * means the candidate's values are larger. Pass `better` to orient it so positive always means
 * "the candidate is better" (for `lower`, both numbers flip sign).
 */
export function effectSize(
  candidate: readonly number[],
  baseline: readonly number[],
  better?: "higher" | "lower",
): EffectSize {
  const sign = better === "lower" ? -1 : 1;
  const delta = sign * cliffsDelta(candidate, baseline);
  return {
    cliffsDelta: delta === 0 ? 0 : delta,
    magnitude: effectMagnitude(delta),
    hodgesLehmann: sign * hodgesLehmann(candidate, baseline) || 0,
    nCandidate: candidate.length,
    nBaseline: baseline.length,
  };
}

// ---------------------------------------------------------------------------------------------
// TDM-175 [16.4]: inference for the decision rule (plan.md 17.2 rules 2 and 3).
//
// - Normal distribution: Φ by Hart's algorithm as given by West (2005), Φ⁻¹ by Wichura's AS 241
//   (PPND16); both are accurate to ~1e-15, far below anything a report prints.
// - Pass rates: Wilson score interval per arm, Newcombe's hybrid score interval (method 10) on the
//   difference, and a p-value that is the exact inversion of that interval (the α at which the
//   interval first touches 0), so the verdict and the printed CI can never disagree.
// - Continuous metrics: Mann–Whitney U. Exact (the permutation distribution of the rank sum,
//   conditional on ties, by dynamic programming over doubled mid-ranks) up to EXACT_MAX_N
//   observations; the normal approximation with tie and continuity correction above that (as
//   scipy's `method="asymptotic"`). Hodges–Lehmann CI by inverting the exact U distribution (as
//   R's `wilcox.test(conf.int = TRUE)`).
// - Small samples are reported honestly: a distribution-free interval has a discrete set of
//   attainable levels, so when the requested level isn't attainable (a median at n=5: the widest
//   interval [min, max] covers 93.75%) the interval comes back at the level it does attain, with
//   `attained: false`. It is never silently called 95%.
// - Holm's step-down correction across every comparison in a report.
// - Power: smallest detectable differences for two proportions (normal approximation, Fleiss)
//   and for Cliff's δ (Noether 1987), at a given α and power.

/** Standard normal CDF Φ(z). */
export function normalCdf(z: number): number {
  if (Number.isNaN(z)) return NaN;
  const x = Math.abs(z);
  let c: number;
  if (x > 37) c = 0;
  else {
    const e = Math.exp((-x * x) / 2);
    if (x < 7.07106781186547) {
      let b = 3.52624965998911e-2 * x + 0.700383064443688;
      b = b * x + 6.37396220353165;
      b = b * x + 33.912866078383;
      b = b * x + 112.079291497871;
      b = b * x + 221.213596169931;
      b = b * x + 220.206867912376;
      c = e * b;
      b = 8.83883476483184e-2 * x + 1.75566716318264;
      b = b * x + 16.064177579207;
      b = b * x + 86.7807322029461;
      b = b * x + 296.564248779674;
      b = b * x + 637.333633378831;
      b = b * x + 793.826512519948;
      b = b * x + 440.413735824752;
      c /= b;
    } else {
      let b = x + 0.65;
      b = x + 4 / b;
      b = x + 3 / b;
      b = x + 2 / b;
      b = x + 1 / b;
      c = e / b / 2.506628274631;
    }
  }
  return z > 0 ? 1 - c : c;
}

/** Standard normal quantile Φ⁻¹(p), AS 241. ±Infinity at 0 and 1. */
export function normalQuantile(p: number): number {
  if (Number.isNaN(p) || p < 0 || p > 1) throw new RangeError(`p must be in [0, 1], got ${p}`);
  if (p === 0) return -Infinity;
  if (p === 1) return Infinity;
  const q = p - 0.5;
  if (Math.abs(q) <= 0.425) {
    const r = 0.180625 - q * q;
    return (
      (q *
        (((((((2509.0809287301227 * r + 33430.57558358813) * r + 67265.7709270087) * r +
          45921.95393154987) *
          r +
          13731.69376550946) *
          r +
          1971.5909503065513) *
          r +
          133.14166789178438) *
          r +
          3.3871328727963665)) /
      (((((((5226.495278852546 * r + 28729.085735721943) * r + 39307.89580009271) * r +
        21213.794301586597) *
        r +
        5394.196021424751) *
        r +
        687.1870074920579) *
        r +
        42.31333070160091) *
        r +
        1)
    );
  }
  let r = Math.sqrt(-Math.log(q < 0 ? p : 1 - p));
  let val: number;
  if (r <= 5) {
    r -= 1.6;
    val =
      (((((((0.0007745450142783414 * r + 0.022723844989269184) * r + 0.2417807251774506) * r +
        1.2704582524523684) *
        r +
        3.6478483247632045) *
        r +
        5.769497221460691) *
        r +
        4.630337846156546) *
        r +
        1.4234371107496835) /
      (((((((1.0507500716444169e-9 * r + 0.0005475938084995345) * r + 0.015198666563616457) * r +
        0.14810397642748008) *
        r +
        0.6897673349851) *
        r +
        1.6763848301838038) *
        r +
        2.053191626637759) *
        r +
        1);
  } else {
    r -= 5;
    val =
      (((((((2.0103343992922881e-7 * r + 2.7115555687434876e-5) * r + 0.0012426609473880784) * r +
        0.026532189526576124) *
        r +
        0.29656057182850487) *
        r +
        1.7848265399172913) *
        r +
        5.463784911164114) *
        r +
        6.657904643501103) /
      (((((((2.0442631033899397e-15 * r + 1.421511758316446e-7) * r + 1.8463183175100548e-5) * r +
        0.0007868691311456133) *
        r +
        0.014875361290850615) *
        r +
        0.1369298809227358) *
        r +
        0.599832206555888) *
        r +
        1);
  }
  return q < 0 ? -val : val;
}

function assertLevel(level: number): void {
  if (!(level > 0 && level < 1)) throw new RangeError(`level must be in (0, 1), got ${level}`);
}

/** z for a two-sided interval at `level` (1.959964 at 0.95). */
function zFor(level: number): number {
  return normalQuantile(1 - (1 - level) / 2);
}

/**
 * A distribution-free interval: `level` is the coverage it actually has, `requestedLevel` what
 * was asked for. `attained` is false when no interval of this kind reaches the requested level
 * at this n (then the interval is the widest one and `level` says what it covers).
 */
export interface AttainedInterval {
  lo: number;
  hi: number;
  level: number;
  requestedLevel: number;
  attained: boolean;
}

export interface RateInterval {
  /** x / n. */
  estimate: number;
  lo: number;
  hi: number;
  level: number;
}

function assertRate(x: number, n: number): void {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`n must be a positive integer, got ${n}`);
  if (!Number.isInteger(x) || x < 0 || x > n)
    throw new RangeError(`x must be an integer in [0, n=${n}], got ${x}`);
}

function wilsonAt(x: number, n: number, z: number): [number, number] {
  const p = x / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  // Exact at the boundaries (the formula gives 0 / 1 up to rounding).
  return [x === 0 ? 0 : Math.max(0, center - half), x === n ? 1 : Math.min(1, center + half)];
}

/** Wilson score interval for a pass rate x/n (no continuity correction). */
export function wilsonCi(x: number, n: number, level = 0.95): RateInterval {
  assertRate(x, n);
  assertLevel(level);
  const [lo, hi] = wilsonAt(x, n, zFor(level));
  return { estimate: x / n, lo, hi, level };
}

export interface RateDiffInterval {
  /** p1 − p2. */
  estimate: number;
  lo: number;
  hi: number;
  level: number;
}

function newcombeAt(
  x1: number,
  n1: number,
  x2: number,
  n2: number,
  z: number,
): [lo: number, hi: number] {
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const [l1, u1] = wilsonAt(x1, n1, z);
  const [l2, u2] = wilsonAt(x2, n2, z);
  const d = p1 - p2;
  return [d - Math.hypot(p1 - l1, u2 - p2), d + Math.hypot(u1 - p1, p2 - l2)];
}

/**
 * Newcombe's hybrid score interval (1998, method 10) for p1 − p2 = x1/n1 − x2/n2, built from the
 * two Wilson intervals. Good coverage at small n, unlike the Wald interval.
 */
export function newcombeCi(
  x1: number,
  n1: number,
  x2: number,
  n2: number,
  level = 0.95,
): RateDiffInterval {
  assertRate(x1, n1);
  assertRate(x2, n2);
  assertLevel(level);
  const [lo, hi] = newcombeAt(x1, n1, x2, n2, zFor(level));
  return { estimate: x1 / n1 - x2 / n2, lo, hi, level };
}

/**
 * Two-sided p-value of "p1 = p2" by inverting the Newcombe interval: the α at which the (1 − α)
 * interval first touches 0. So `p < α` exactly when the (1 − α) Newcombe CI excludes 0.
 */
export function newcombePValue(x1: number, n1: number, x2: number, n2: number): number {
  assertRate(x1, n1);
  assertRate(x2, n2);
  const d = x1 / n1 - x2 / n2;
  if (d === 0) return 1;
  // The bound nearest 0 moves toward 0 as z grows; find the z where it reaches 0.
  const bound = (z: number) => {
    const [lo, hi] = newcombeAt(x1, n1, x2, n2, z);
    return d > 0 ? lo : -hi;
  };
  let a = 0;
  let b = 1;
  while (bound(b) > 0 && b < 64) b *= 2;
  if (bound(b) > 0) return 0;
  for (let i = 0; i < 200 && b - a > 1e-12; i++) {
    const m = (a + b) / 2;
    if (bound(m) > 0) a = m;
    else b = m;
  }
  return Math.min(1, 2 * (1 - normalCdf((a + b) / 2)));
}

// --- Mann–Whitney ------------------------------------------------------------------------------

/** Above this many observations (both groups) Mann–Whitney uses the normal approximation. */
export const EXACT_MAX_N = 60;

function assertOrdered(xs: readonly number[], name: string): void {
  if (xs.length === 0) throw new RangeError(`${name} must not be empty`);
  for (const x of xs) {
    if (Number.isNaN(x)) throw new RangeError(`${name} contains NaN`);
  }
}

/** Mid-ranks (1-based) of `values`, plus the tie groups' sizes. ±Infinity ranks like any value. */
function midRanks(values: readonly number[]): { ranks: number[]; ties: number[] } {
  const idx = values
    .map((v, i) => [v, i] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const ranks = new Array<number>(values.length);
  const ties: number[] = [];
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
    const r = (i + j + 2) / 2;
    for (let k = i; k <= j; k++) ranks[idx[k]![1]] = r;
    if (j > i) ties.push(j - i + 1);
    i = j + 1;
  }
  return { ranks, ties };
}

/**
 * Probability of each sum of `k` items drawn without replacement from `weights` (non-negative
 * integers), all C(N, k) subsets equally likely. Index = sum.
 */
function subsetSumDistribution(weights: readonly number[], k: number): Float64Array {
  const total = weights.reduce((s, w) => s + w, 0);
  const width = total + 1;
  const dp = new Float64Array((k + 1) * width);
  dp[0] = 1;
  let seen = 0;
  let maxSum = 0;
  for (const w of weights) {
    seen++;
    maxSum += w;
    for (let j = Math.min(seen, k); j >= 1; j--) {
      const row = j * width;
      const prev = (j - 1) * width;
      for (let s = maxSum; s >= w; s--) dp[row + s]! += dp[prev + s - w]!;
    }
  }
  const out = dp.slice(k * width, (k + 1) * width);
  let sum = 0;
  for (const v of out) sum += v;
  for (let s = 0; s < out.length; s++) out[s]! /= sum;
  return out;
}

export interface MannWhitneyResult {
  /** U of the first sample: #(x > y) + ½ #(x = y). */
  u: number;
  /** Two-sided p-value. */
  p: number;
  method: "exact" | "asymptotic";
  /** Whether the samples share any value (the exact test is then conditional on the ties). */
  ties: boolean;
}

/**
 * Two-sided Mann–Whitney U test of x vs y. Exact up to EXACT_MAX_N total observations (with ties,
 * the exact permutation distribution conditional on them, like scipy's PermutationMethod); the
 * doubled smaller tail, capped at 1. Above that, the normal approximation with tie correction
 * and continuity correction (scipy `method="asymptotic"`). Values may be ±Infinity (a failed
 * trial counted as worse than any solved one), never NaN.
 */
export function mannWhitney(
  x: readonly number[],
  y: readonly number[],
  opts: { method?: "auto" | "exact" | "asymptotic" } = {},
): MannWhitneyResult {
  assertOrdered(x, "x");
  assertOrdered(y, "y");
  const n1 = x.length;
  const n2 = y.length;
  const N = n1 + n2;
  const { ranks, ties } = midRanks([...x, ...y]);
  let r1 = 0;
  for (let i = 0; i < n1; i++) r1 += ranks[i]!;
  const u = r1 - (n1 * (n1 + 1)) / 2;
  const method =
    opts.method === undefined || opts.method === "auto"
      ? N <= EXACT_MAX_N
        ? "exact"
        : "asymptotic"
      : opts.method;
  if (method === "exact") {
    // Doubled mid-ranks are integers, so the rank sum's distribution is a subset-sum DP.
    const doubled = ranks.map((r) => Math.round(2 * r));
    const dist = subsetSumDistribution(doubled, n1);
    const s = Math.round(2 * r1);
    let le = 0;
    let ge = 0;
    for (let k = 0; k < dist.length; k++) {
      if (k <= s) le += dist[k]!;
      if (k >= s) ge += dist[k]!;
    }
    return { u, p: Math.min(1, 2 * Math.min(le, ge)), method, ties: ties.length > 0 };
  }
  const mu = (n1 * n2) / 2;
  const tieSum = ties.reduce((s, t) => s + (t * t * t - t), 0);
  const sigma = Math.sqrt(((n1 * n2) / 12) * (N + 1 - tieSum / (N * (N - 1))));
  if (sigma === 0) return { u, p: 1, method, ties: ties.length > 0 };
  const z = (Math.abs(u - mu) - 0.5) / sigma;
  return {
    u,
    p: Math.min(1, 2 * (1 - normalCdf(Math.max(z, 0)))),
    method,
    ties: ties.length > 0,
  };
}

/**
 * Fisher's exact test on a 2×2 table (x1 of n1 vs x2 of n2 successes), two-sided: the sum of the
 * hypergeometric probabilities of every table with the same margins that is no more likely than
 * the observed one (R's `fisher.test`, with its 1e-7 relative tolerance). Exact at any n, so it is
 * the pass-rate test for one task's repeats (E18).
 */
export function fisherExact(x1: number, n1: number, x2: number, n2: number): number {
  for (const [v, name] of [
    [x1, "x1"],
    [n1, "n1"],
    [x2, "x2"],
    [n2, "n2"],
  ] as const) {
    if (!Number.isInteger(v) || v < 0)
      throw new RangeError(`${name} must be a non-negative integer`);
  }
  if (x1 > n1 || x2 > n2) throw new RangeError("successes can't exceed trials");
  const k = x1 + x2;
  const N = n1 + n2;
  if (N === 0) return 1;
  const lnC = (n: number, r: number) => lnFactorial(n) - lnFactorial(r) - lnFactorial(n - r);
  const lnTotal = lnC(N, k);
  const prob = (a: number) => Math.exp(lnC(n1, a) + lnC(n2, k - a) - lnTotal);
  const lo = Math.max(0, k - n2);
  const hi = Math.min(n1, k);
  const observed = prob(x1);
  let p = 0;
  for (let a = lo; a <= hi; a++) {
    const q = prob(a);
    if (q <= observed * (1 + 1e-7)) p += q;
  }
  return Math.min(1, p);
}

function lnFactorial(n: number): number {
  let s = 0;
  for (let i = 2; i <= n; i++) s += Math.log(i);
  return s;
}

/** C(n1+n2, n1): the number of ways to split n1 + n2 trials into groups of n1 and n2. */
export function splitCount(n1: number, n2: number): number {
  let c = 1;
  for (let i = 1; i <= n1; i++) c = (c * (n2 + i)) / i;
  return c;
}

/**
 * Smallest two-sided exact Mann–Whitney p-value any n1 vs n2 data can reach: 2 / C(n1+n2, n1).
 * The rank-sum distribution is symmetric at any n1, n2, so the most extreme split always has an
 * equally extreme mirror (both tails count).
 */
export function minMannWhitneyP(n1: number, n2: number): number {
  return Math.min(1, 2 / splitCount(n1, n2));
}

/**
 * Smallest two-sided p-value any n1 vs n2 data can reach in the exact two-sample permutation test
 * on the difference in means (`permutationMeanTest`) and in Fisher's exact test (TDM-251).
 * With n1 = n2 the most extreme split's mirror (the groups swapped) is as extreme, so the floor is
 * 2 / C(n1+n2, n1). With n1 ≠ n2 the mirror has a different difference in means (and a different
 * table), so data can make one split the only one as extreme: the floor is 1 / C(n1+n2, n1).
 * 3 vs 4: 1/35 = 0.0286 (harness league run 1, Tandem vs solo), not 2/35.
 */
export function minPermutationP(n1: number, n2: number): number {
  return Math.min(1, (n1 === n2 ? 2 : 1) / splitCount(n1, n2));
}

/**
 * The smallest Holm-adjusted p each comparison of a family can reach, whatever the data, given
 * every comparison's own floor (TDM-251). Comparison i does best when it and the comparisons with
 * the smallest floors (no larger than its own) all sit at their floors and come first: with r − 1
 * of them ahead of it, its adjusted p is max((m − j + 1)·g_j for j < r, (m − r + 1)·f_i). This is
 * the minimum over r. At least α means no result at these n's can be significant after Holm.
 */
export function holmFloors(floors: readonly number[]): number[] {
  const m = floors.length;
  return floors.map((f, i) => {
    const ahead = floors.filter((g, j) => j !== i && g <= f).sort((a, b) => a - b);
    let best = Math.min(1, m * f);
    let running = 0;
    for (let r = 2; r <= ahead.length + 1; r++) {
      running = Math.max(running, (m - r + 2) * ahead[r - 2]!);
      best = Math.min(best, Math.min(1, Math.max(running, (m - r + 1) * f)));
    }
    return best;
  });
}

/** P(U ≤ u) for every u = 0..n1·n2, continuous data (no ties). */
function uCdfNoTies(n1: number, n2: number): Float64Array {
  const weights = Array.from({ length: n1 + n2 }, (_, i) => i + 1);
  const dist = subsetSumDistribution(weights, n1);
  const offset = (n1 * (n1 + 1)) / 2;
  const cdf = new Float64Array(n1 * n2 + 1);
  let acc = 0;
  for (let u = 0; u <= n1 * n2; u++) {
    acc += dist[u + offset] ?? 0;
    cdf[u] = acc;
  }
  return cdf;
}

export interface ShiftInterval extends AttainedInterval {
  /** Hodges–Lehmann estimate: median of all pairwise differences x − y. */
  estimate: number;
  method: "exact" | "asymptotic";
}

/**
 * Hodges–Lehmann shift x − y with its distribution-free CI, by inverting the Mann–Whitney test
 * (Bauer 1972; R's `wilcox.test(x, y, conf.int = TRUE)` with `exact = TRUE`): the interval is
 * [D(k), D(mn − k + 1)] over the sorted pairwise differences, k from the exact U distribution.
 * Small samples cannot reach every level (3 vs 3: the widest interval covers 90%), so `level` is
 * the attained coverage and `attained` is false when it falls short of `requestedLevel`.
 */
export function hodgesLehmannCi(
  x: readonly number[],
  y: readonly number[],
  level = 0.95,
): ShiftInterval {
  assertSample(x, "x");
  assertSample(y, "y");
  assertLevel(level);
  const m = x.length;
  const n = y.length;
  const diffs: number[] = [];
  for (const a of x) for (const b of y) diffs.push(a - b);
  diffs.sort((a, b) => a - b);
  const mn = m * n;
  const alpha = 1 - level;
  const estimate = quantileSorted(diffs, 0.5);
  let k: number;
  let attainedLevel: number;
  let method: "exact" | "asymptotic";
  if (m + n <= EXACT_MAX_N) {
    method = "exact";
    const cdf = uCdfNoTies(m, n);
    // qwilcox(α/2): the smallest q with P(U ≤ q) ≥ α/2.
    let q = 0;
    while (q < mn && cdf[q]! < alpha / 2 - 1e-12) q++;
    k = Math.max(q, 1);
    attainedLevel = 1 - 2 * (k - 1 >= 0 ? cdf[k - 1]! : 0);
  } else {
    method = "asymptotic";
    const z = zFor(level);
    k = Math.max(1, Math.floor(mn / 2 - z * Math.sqrt((mn * (m + n + 1)) / 12)));
    attainedLevel = level;
  }
  k = Math.min(k, Math.ceil(mn / 2));
  return {
    estimate,
    lo: diffs[k - 1]!,
    hi: diffs[mn - k]!,
    level: attainedLevel,
    requestedLevel: level,
    attained: attainedLevel >= level - 1e-12,
    method,
  };
}

// --- Median CI -------------------------------------------------------------------------------

/** P(B ≤ k) for B ~ Binomial(n, 1/2), k = 0..n. */
function binomHalfCdf(n: number): Float64Array {
  const cdf = new Float64Array(n + 1);
  let logPmf = -n * Math.LN2;
  let acc = 0;
  for (let k = 0; k <= n; k++) {
    acc += Math.exp(logPmf);
    cdf[k] = Math.min(1, acc);
    logPmf += Math.log(n - k) - Math.log(k + 1);
  }
  return cdf;
}

/**
 * Distribution-free CI for a median from order statistics: [x(k), x(n−k+1)] with the largest k
 * whose coverage 1 − 2·P(B ≤ k−1), B ~ Bin(n, ½), reaches `level`. Below n=6 no such interval
 * reaches 95% (n=5: [min, max] covers 93.75%), so the widest one is returned with its true
 * `level` and `attained: false`, never a narrower interval labelled 95%.
 */
export function medianCi(
  xs: readonly number[],
  level = 0.95,
): AttainedInterval & { estimate: number } {
  assertSample(xs);
  assertLevel(level);
  const s = sorted(xs);
  const n = s.length;
  const cdf = binomHalfCdf(n);
  const coverage = (k: number) => 1 - 2 * (k >= 1 ? cdf[k - 1]! : 0);
  let k = 1;
  while (k + 1 <= Math.floor((n + 1) / 2) && coverage(k + 1) >= level - 1e-12) k++;
  const cov = Math.max(0, coverage(k));
  return {
    estimate: quantileSorted(s, 0.5),
    lo: s[k - 1]!,
    hi: s[n - k]!,
    level: cov,
    requestedLevel: level,
    attained: cov >= level - 1e-12,
  };
}

// --- Multiplicity ----------------------------------------------------------------------------

/**
 * Holm (1979) step-down adjusted p-values, in the input order. Controls the family-wise error
 * rate at α: reject H_i when `adjusted[i] < α`.
 */
export function holmAdjust(ps: readonly number[]): number[] {
  for (const p of ps) {
    if (!(p >= 0 && p <= 1)) throw new RangeError(`p-values must be in [0, 1], got ${p}`);
  }
  const m = ps.length;
  const order = ps.map((p, i) => [p, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(m);
  let running = 0;
  order.forEach(([p, i], rank) => {
    running = Math.max(running, Math.min(1, (m - rank) * p));
    out[i] = running;
  });
  return out;
}

// --- Power -----------------------------------------------------------------------------------

export interface PowerOptions {
  /** Two-sided significance level (already divided for multiplicity if you want that). Default 0.05. */
  alpha?: number;
  /** Default 0.8. */
  power?: number;
}

/**
 * Smallest difference in pass rate (0–1) a two-sided two-proportion test at `alpha` detects with
 * `power`, with n1 and n2 (effective) trials per arm, for rates centred on `rate` (default 0.5,
 * the worst case). Normal approximation with the pooled variance under H0 and the unpooled one
 * under H1 (Fleiss): d = z_{1−α/2}·σ0 + z_power·σ1, solved for d. Null when no difference up to
 * 1 (0% vs 100%) is detectable at this n.
 */
export function mdeTwoProportions(
  n1: number,
  n2: number,
  opts: PowerOptions & { rate?: number } = {},
): number | null {
  const alpha = opts.alpha ?? 0.05;
  const power = opts.power ?? 0.8;
  if (!(n1 > 0 && n2 > 0)) throw new RangeError("n1 and n2 must be positive");
  const za = normalQuantile(1 - alpha / 2);
  const zb = normalQuantile(power);
  const rate = Math.min(1, Math.max(0, opts.rate ?? 0.5));
  const gap = (d: number) => {
    const c = Math.min(1 - d / 2, Math.max(d / 2, rate));
    const p1 = c + d / 2;
    const p2 = c - d / 2;
    const s0 = Math.sqrt(c * (1 - c) * (1 / n1 + 1 / n2));
    const s1 = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);
    return d - (za * s0 + zb * s1);
  };
  if (gap(1) < 0) return null;
  let a = 0;
  let b = 1;
  for (let i = 0; i < 100 && b - a > 1e-10; i++) {
    const m = (a + b) / 2;
    if (gap(m) >= 0) b = m;
    else a = m;
  }
  return b;
}

/**
 * Smallest |Cliff's δ| a two-sided Mann–Whitney test at `alpha` detects with `power` (Noether
 * 1987: P(X > Y) − ½ = (z_{1−α/2} + z_power) / √(12·n1·n2 / (n1 + n2))). Null when it exceeds 1,
 * or when no data at this n can reach `alpha` with the exact test (`minMannWhitneyP`).
 */
export function mdeCliffsDelta(n1: number, n2: number, opts: PowerOptions = {}): number | null {
  const alpha = opts.alpha ?? 0.05;
  const power = opts.power ?? 0.8;
  if (!(n1 > 0 && n2 > 0)) throw new RangeError("n1 and n2 must be positive");
  if (Number.isInteger(n1) && Number.isInteger(n2) && n1 + n2 <= EXACT_MAX_N) {
    if (minMannWhitneyP(n1, n2) >= alpha) return null;
  }
  const z = normalQuantile(1 - alpha / 2) + normalQuantile(power);
  const d = (2 * z) / Math.sqrt((12 * n1 * n2) / (n1 + n2));
  return d > 1 ? null : d;
}

/**
 * The location shift (in the metric's unit) that corresponds to Cliff's δ between two normal
 * samples with standard deviation `sd`: P(X > Y) = Φ(Δ / (σ√2)), so Δ = σ√2·Φ⁻¹((1 + δ)/2).
 * Used only to translate a detectable δ into "≈ 12 s" on the test plan.
 */
export function shiftForCliffsDelta(delta: number, sd: number): number {
  if (!(delta >= 0 && delta < 1)) throw new RangeError(`delta must be in [0, 1), got ${delta}`);
  return sd * Math.SQRT2 * normalQuantile((1 + delta) / 2);
}

/** A robust standard deviation: IQR / 1.349 (exact for a normal distribution). */
export function robustSd(xs: readonly number[]): number {
  return iqr(xs).iqr / 1.349;
}

// --- Small-n intervals and tests over tasks (TDM-175, Bowyer et al. 2025) -------------------
//
// With few trials the normal approximation (CLT) misstates uncertainty, so per-arm pass rates
// below SMALL_N_RATE trials use the exact Clopper–Pearson interval, and comparisons over tasks
// use an exact sign-flip permutation test instead of a z-test. Every interval says which method
// made it.

/** Below this many trials a pass rate's interval is exact (Clopper–Pearson), not Wilson. */
export const SMALL_N_RATE = 30;

/** P(X ≥ x) for X ~ Binomial(n, p). */
function binomUpperTail(x: number, n: number, p: number): number {
  if (x <= 0) return 1;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const lp = Math.log(p);
  const lq = Math.log1p(-p);
  // log C(n, k) by accumulation.
  let logC = 0;
  let acc = 0;
  for (let k = 0; k <= n; k++) {
    if (k > 0) logC += Math.log(n - k + 1) - Math.log(k);
    if (k >= x) acc += Math.exp(logC + k * lp + (n - k) * lq);
  }
  return Math.min(1, acc);
}

/**
 * Clopper–Pearson "exact" interval for x/n: the p's whose binomial tails at x are ≥ α/2. Never
 * undercovers (it is conservative), which is the right failure mode at small n.
 */
export function clopperPearsonCi(x: number, n: number, level = 0.95): RateInterval {
  assertRate(x, n);
  assertLevel(level);
  const a = (1 - level) / 2;
  const solve = (f: (p: number) => number, target: number) => {
    // f is increasing in p.
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 200 && hi - lo > 1e-15; i++) {
      const m = (lo + hi) / 2;
      if (f(m) < target) lo = m;
      else hi = m;
    }
    return (lo + hi) / 2;
  };
  // lower: P(X ≥ x | p) = α/2; upper: P(X ≤ x | p) = α/2 ⇔ P(X ≥ x+1 | p) = 1 − α/2.
  const lo = x === 0 ? 0 : solve((p) => binomUpperTail(x, n, p), a);
  const hi = x === n ? 1 : solve((p) => binomUpperTail(x + 1, n, p), 1 - a);
  return { estimate: x / n, lo, hi, level };
}

export interface SignFlipResult {
  /** Two-sided p of "the per-task differences are symmetric about 0". */
  p: number;
  method: "exact" | "monte_carlo";
  /** The smallest p this many non-zero tasks can give (exact: 2 / 2^T). */
  minP: number;
}

/** Up to this many tasks the sign-flip test enumerates all 2^T sign patterns. */
export const SIGN_FLIP_EXACT_MAX = 16;

/**
 * Paired permutation (sign-flip) test over tasks: under "no difference", each task's difference
 * is as likely positive as negative, so flip signs and see how often |Σ d| is at least the
 * observed one. Exact for up to SIGN_FLIP_EXACT_MAX tasks, else `samples` seeded random flips
 * (p = (hits + 1) / (samples + 1)). Tasks with a zero difference carry no information.
 */
export function signFlipTest(
  diffs: readonly number[],
  opts: { seed?: number; samples?: number } = {},
): SignFlipResult {
  for (const d of diffs) if (!Number.isFinite(d)) throw new RangeError("diffs must be finite");
  const ds = diffs.filter((d) => d !== 0).map(Math.abs);
  const T = ds.length;
  const observed = Math.abs(diffs.reduce((s, d) => s + d, 0));
  if (T === 0) return { p: 1, method: "exact", minP: 1 };
  const eps = 1e-12 * Math.max(1, observed);
  const minP = Math.min(1, 2 / 2 ** T);
  if (T <= SIGN_FLIP_EXACT_MAX) {
    let hits = 0;
    const total = 2 ** T;
    for (let mask = 0; mask < total; mask++) {
      let s = 0;
      for (let i = 0; i < T; i++) s += mask & (1 << i) ? -ds[i]! : ds[i]!;
      if (Math.abs(s) >= observed - eps) hits++;
    }
    return { p: Math.min(1, hits / total), method: "exact", minP };
  }
  const samples = opts.samples ?? 20_000;
  const rand = mulberry32(opts.seed ?? 0);
  let hits = 0;
  for (let k = 0; k < samples; k++) {
    let s = 0;
    for (let i = 0; i < T; i++) s += rand() < 0.5 ? -ds[i]! : ds[i]!;
    if (Math.abs(s) >= observed - eps) hits++;
  }
  return { p: Math.min(1, (hits + 1) / (samples + 1)), method: "monte_carlo", minP };
}

// --- Means of bounded values (TDM-210: hidden_test_fraction) ----------------------------------

/**
 * P(|T| < t) for Student's t with integer `df` ≥ 1, exactly (Abramowitz & Stegun 26.7.3–26.7.4:
 * the finite trigonometric series in θ = atan(t / √df)).
 */
function studentTCentral(t: number, df: number): number {
  const theta = Math.atan(t / Math.sqrt(df));
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const c2 = c * c;
  if (df % 2 === 1) {
    let term = c;
    let acc = df > 1 ? c : 0;
    for (let k = 3; k <= df - 2; k += 2) {
      term *= (c2 * (k - 1)) / k;
      acc += term;
    }
    return (2 / Math.PI) * (theta + s * acc);
  }
  let term = 1;
  let acc = 1;
  for (let k = 2; k <= df - 2; k += 2) {
    term *= (c2 * (k - 1)) / k;
    acc += term;
  }
  return s * acc;
}

/**
 * Student-t quantile t⁻¹(p; df), by bisection on the exact distribution function (integer df; a
 * non-integer df, from Welch, is rounded DOWN, which widens the interval: conservative). Above
 * 1000 df the normal quantile is used. df ≥ 1.
 */
export function studentTQuantile(p: number, df: number): number {
  if (Number.isNaN(p) || p <= 0 || p >= 1) throw new RangeError(`p must be in (0, 1), got ${p}`);
  if (!(df >= 1)) throw new RangeError(`df must be at least 1, got ${df}`);
  if (p < 0.5) return -studentTQuantile(1 - p, df);
  if (p === 0.5) return 0;
  const d = Math.floor(df);
  if (d > 1000) return normalQuantile(p);
  if (d === 1) return Math.tan(Math.PI * (p - 0.5));
  const target = 2 * p - 1; // P(|T| < t)
  let lo = 0;
  let hi = 1;
  while (studentTCentral(hi, d) < target) hi *= 2;
  for (let i = 0; i < 200 && hi - lo > 1e-12 * hi; i++) {
    const m = (lo + hi) / 2;
    if (studentTCentral(m, d) < target) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}

export interface MeanInterval {
  estimate: number;
  lo: number;
  hi: number;
  level: number;
}

const meanOf = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
function variance(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = meanOf(xs);
  return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
}

/**
 * Student-t CI of the mean of values in [lo, hi] (default [0, 1]), clipped to that range. One
 * value has no spread to estimate: the interval is the whole range. With no spread at n ≥ 2 the
 * interval is the point (the data can't say more).
 */
export function meanCi(
  xs: readonly number[],
  level = 0.95,
  range: readonly [number, number] = [0, 1],
): MeanInterval {
  assertSample(xs);
  if (!(level > 0 && level < 1)) throw new RangeError(`level must be in (0, 1), got ${level}`);
  const m = meanOf(xs);
  const n = xs.length;
  if (n < 2) return { estimate: m, lo: range[0], hi: range[1], level };
  const half = studentTQuantile(1 - (1 - level) / 2, n - 1) * Math.sqrt(variance(xs) / n);
  return {
    estimate: m,
    lo: Math.max(range[0], m - half),
    hi: Math.min(range[1], m + half),
    level,
  };
}

/**
 * Welch's t CI of mean(x) − mean(y) (Welch–Satterthwaite df), clipped to [−width, width]. Either
 * sample with one value leaves the spread unknown: the interval is the whole range.
 */
export function welchDiffCi(
  x: readonly number[],
  y: readonly number[],
  level = 0.95,
  width = 1,
): MeanInterval {
  assertSample(x, "x");
  assertSample(y, "y");
  const d = meanOf(x) - meanOf(y);
  if (x.length < 2 || y.length < 2) return { estimate: d, lo: -width, hi: width, level };
  const vx = variance(x) / x.length;
  const vy = variance(y) / y.length;
  const se = Math.sqrt(vx + vy);
  if (se === 0) return { estimate: d, lo: d, hi: d, level };
  const df = (vx + vy) ** 2 / (vx ** 2 / (x.length - 1) + vy ** 2 / (y.length - 1));
  const half = studentTQuantile(1 - (1 - level) / 2, Math.max(1, df)) * se;
  return { estimate: d, lo: Math.max(-width, d - half), hi: Math.min(width, d + half), level };
}

/** Up to this many splits the permutation test enumerates every one. */
export const PERMUTATION_EXACT_MAX = 50_000;

export interface PermutationResult {
  /** Two-sided p of "x and y come from the same distribution", on the difference in means. */
  p: number;
  method: "exact" | "monte_carlo";
}

/**
 * Two-sample permutation (Fisher–Pitman) test on mean(x) − mean(y), two-sided: the share of the
 * C(n1+n2, n1) relabellings whose |difference| is at least the observed one. Exact up to
 * PERMUTATION_EXACT_MAX splits, else `samples` seeded random relabellings
 * (p = (hits + 1) / (samples + 1)). Its floor (`minPermutationP`) is 2 / C(n1+n2, n1) when
 * n1 = n2 (3 vs 3 can't go below 0.1, so no result at that n is significant) and 1 / C(n1+n2, n1)
 * when n1 ≠ n2, where one tail can be the only split that extreme (3 vs 4: 1/35 = 0.0286).
 */
export function permutationMeanTest(
  x: readonly number[],
  y: readonly number[],
  opts: { seed?: number; samples?: number } = {},
): PermutationResult {
  assertSample(x, "x");
  assertSample(y, "y");
  const all = [...x, ...y];
  const n1 = x.length;
  const N = all.length;
  const total = all.reduce((s, v) => s + v, 0);
  const diffOf = (s1: number) => s1 / n1 - (total - s1) / (N - n1);
  const observed = Math.abs(diffOf(x.reduce((s, v) => s + v, 0)));
  const eps = 1e-12 * Math.max(1, Math.abs(total));
  let splits = 1;
  for (let i = 1; i <= n1; i++) splits = (splits * (N - n1 + i)) / i;
  if (splits <= PERMUTATION_EXACT_MAX) {
    let hits = 0;
    let count = 0;
    const walk = (start: number, left: number, s1: number) => {
      if (left === 0) {
        count++;
        if (Math.abs(diffOf(s1)) >= observed - eps) hits++;
        return;
      }
      for (let i = start; i <= N - left; i++) walk(i + 1, left - 1, s1 + all[i]!);
    };
    walk(0, n1, 0);
    return { p: Math.min(1, hits / count), method: "exact" };
  }
  const samples = opts.samples ?? 20_000;
  const rand = mulberry32(opts.seed ?? 0);
  const idx = all.map((_, i) => i);
  let hits = 0;
  for (let k = 0; k < samples; k++) {
    // Partial Fisher–Yates: the first n1 slots are a uniform random subset.
    let s1 = 0;
    for (let i = 0; i < n1; i++) {
      const j = i + Math.floor(rand() * (N - i));
      [idx[i], idx[j]] = [idx[j]!, idx[i]!];
      s1 += all[idx[i]!]!;
    }
    if (Math.abs(diffOf(s1)) >= observed - eps) hits++;
  }
  return { p: Math.min(1, (hits + 1) / (samples + 1)), method: "monte_carlo" };
}
