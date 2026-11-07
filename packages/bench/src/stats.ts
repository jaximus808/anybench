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

export function cliffsDelta(candidate: readonly number[], baseline: readonly number[]): number {
  assertSample(candidate, "candidate");
  assertSample(baseline, "baseline");
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
