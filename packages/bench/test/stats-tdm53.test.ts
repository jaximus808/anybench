// TDM-53 [5.8]: stats against known distributions, plus fast-check properties.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  bootstrapCi,
  cliffsDelta,
  effectMagnitude,
  effectSize,
  hodgesLehmann,
  iqr,
  median,
  mulberry32,
  passAtK,
  passHatK,
  quantile,
  summarize,
} from "../src/index.js";

const finiteArr = (min = 1) =>
  fc.array(fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true }), {
    minLength: min,
    maxLength: 30,
  });

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

describe("median, quantile, IQR (type 7)", () => {
  it("matches R/NumPy on known samples", () => {
    expect(median([5])).toBe(5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    const oneToTen = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    // numpy.percentile(range(1, 11), [25, 75]) → [3.25, 7.75]
    expect(iqr(oneToTen)).toEqual({ q1: 3.25, q3: 7.75, iqr: 4.5 });
    expect(quantile(oneToTen, 0)).toBe(1);
    expect(quantile(oneToTen, 1)).toBe(10);
    expect(quantile([1, 2, 3, 4, 5], 0.9)).toBeCloseTo(4.6, 12);
  });

  it("rejects empty and non-finite samples", () => {
    expect(() => median([])).toThrow(RangeError);
    expect(() => median([1, Number.NaN])).toThrow(RangeError);
    expect(() => quantile([1], 1.5)).toThrow(RangeError);
  });

  it("property: min ≤ q1 ≤ median ≤ q3 ≤ max, IQR ≥ 0, order-independent", () => {
    fc.assert(
      fc.property(finiteArr(), (xs) => {
        const m = median(xs);
        const { q1, q3, iqr: r } = iqr(xs);
        expect(Math.min(...xs)).toBeLessThanOrEqual(q1);
        expect(q1).toBeLessThanOrEqual(m);
        expect(m).toBeLessThanOrEqual(q3);
        expect(q3).toBeLessThanOrEqual(Math.max(...xs));
        expect(r).toBeGreaterThanOrEqual(0);
        expect(median([...xs].reverse())).toBe(m);
      }),
    );
  });
});

describe("mulberry32 and the seeded bootstrap", () => {
  it("same seed, same stream; values in [0, 1)", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const c = mulberry32(43);
    const sa = Array.from({ length: 100 }, a);
    expect(Array.from({ length: 100 }, b)).toEqual(sa);
    expect(Array.from({ length: 100 }, c)).not.toEqual(sa);
    for (const x of sa) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it("brackets the median of a uniform sample and is reproducible", () => {
    const xs = Array.from({ length: 101 }, (_, i) => i + 1); // median 51
    const ci = bootstrapCi(xs, { seed: 7 });
    expect(ci.estimate).toBe(51);
    expect(ci.level).toBe(0.95);
    expect(ci.lo).toBeLessThan(51);
    expect(ci.hi).toBeGreaterThan(51);
    // SE of the median of U(1,101), n=101: ≈ 1.2533·σ/√n ≈ 3.6 → 95% half-width ≈ 7.
    expect(ci.hi - ci.lo).toBeGreaterThan(6);
    expect(ci.hi - ci.lo).toBeLessThan(25);
    expect(bootstrapCi(xs, { seed: 7 })).toEqual(ci);
  });

  it("narrows with more data and is zero-width on a constant sample", () => {
    const rand = mulberry32(1);
    const normal = () => {
      // Box–Muller, deterministic
      const u = 1 - rand();
      const v = rand();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    const small = Array.from({ length: 10 }, normal);
    const big = Array.from({ length: 400 }, normal);
    const ciSmall = bootstrapCi(small, { seed: 3, iterations: 500 });
    const ciBig = bootstrapCi(big, { seed: 3, iterations: 500 });
    expect(ciBig.hi - ciBig.lo).toBeLessThan(ciSmall.hi - ciSmall.lo);
    // Median of N(0,1), n=400: SE ≈ 1.2533/√400 ≈ 0.063, so the 95% CI sits near 0.
    expect(ciBig.lo).toBeGreaterThan(-0.25);
    expect(ciBig.hi).toBeLessThan(0.25);
    expect(bootstrapCi([4, 4, 4], { seed: 9 })).toEqual({ lo: 4, hi: 4, level: 0.95, estimate: 4 });
  }, 30_000);

  it("property: lo ≤ hi, both within the sample range, deterministic per seed", () => {
    fc.assert(
      fc.property(finiteArr(), fc.integer(), (xs, seed) => {
        const ci = bootstrapCi(xs, { seed, iterations: 200 });
        expect(ci.lo).toBeLessThanOrEqual(ci.hi);
        expect(ci.lo).toBeGreaterThanOrEqual(Math.min(...xs));
        expect(ci.hi).toBeLessThanOrEqual(Math.max(...xs));
        expect(bootstrapCi(xs, { seed, iterations: 200 })).toEqual(ci);
      }),
      { numRuns: 50 },
    );
  });

  it("summarize bundles median, IQR, range and CI", () => {
    const s = summarize([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], { seed: 1 });
    expect(s).toMatchObject({ n: 10, median: 5.5, q1: 3.25, q3: 7.75, iqr: 4.5, min: 1, max: 10 });
    expect(s.ci.estimate).toBe(5.5);
  });
});

describe("pass@k and pass^k (unbiased)", () => {
  it("known values", () => {
    expect(passAtK(5, 2, 2)).toBeCloseTo(1 - choose(3, 2) / choose(5, 2), 12); // 0.7
    expect(passAtK(5, 2, 2)).toBeCloseTo(0.7, 12);
    expect(passHatK(5, 3, 2)).toBeCloseTo(0.3, 12); // C(3,2)/C(5,2)
    expect(passAtK(10, 0, 5)).toBe(0);
    expect(passAtK(10, 10, 1)).toBe(1);
    expect(passAtK(10, 6, 5)).toBe(1); // n − c < k: some passing trial is always in the draw
    expect(passHatK(10, 4, 5)).toBe(0);
    expect(passHatK(10, 10, 10)).toBe(1);
  });

  it("rejects bad counts", () => {
    expect(() => passAtK(5, 6, 1)).toThrow(RangeError);
    expect(() => passAtK(5, 2, 0)).toThrow(RangeError);
    expect(() => passHatK(5, 2, 6)).toThrow(RangeError);
    expect(() => passHatK(5, 2.5, 1)).toThrow(RangeError);
  });

  const counts = fc
    .integer({ min: 1, max: 40 })
    .chain((n) =>
      fc.tuple(fc.constant(n), fc.integer({ min: 0, max: n }), fc.integer({ min: 1, max: n })),
    );

  it("property: matches the binomial formulas", () => {
    fc.assert(
      fc.property(counts, ([n, c, k]) => {
        expect(passAtK(n, c, k)).toBeCloseTo(1 - choose(n - c, k) / choose(n, k), 9);
        expect(passHatK(n, c, k)).toBeCloseTo(choose(c, k) / choose(n, k), 9);
      }),
    );
  });

  it("property: k=1 both equal c/n; pass^k ≤ pass@k; pass@k rises and pass^k falls with k", () => {
    fc.assert(
      fc.property(counts, ([n, c, k]) => {
        expect(passAtK(n, c, 1)).toBeCloseTo(c / n, 12);
        expect(passHatK(n, c, 1)).toBeCloseTo(c / n, 12);
        expect(passHatK(n, c, k)).toBeLessThanOrEqual(passAtK(n, c, k) + 1e-12);
        if (k < n) {
          expect(passAtK(n, c, k + 1)).toBeGreaterThanOrEqual(passAtK(n, c, k) - 1e-12);
          expect(passHatK(n, c, k + 1)).toBeLessThanOrEqual(passHatK(n, c, k) + 1e-12);
        }
      }),
    );
  });
});

describe("effect size vs baseline: Cliff's delta + Hodges–Lehmann", () => {
  it("known values", () => {
    expect(cliffsDelta([4, 5, 6], [1, 2, 3])).toBe(1);
    expect(cliffsDelta([1, 2, 3], [1, 2, 3])).toBe(0);
    expect(cliffsDelta([1, 2, 3], [2, 3, 4])).toBeCloseTo(-5 / 9, 12);
    expect(hodgesLehmann([11, 12, 13], [1, 2, 3])).toBe(10);
    expect(effectMagnitude(0.1)).toBe("negligible");
    expect(effectMagnitude(-0.2)).toBe("small");
    expect(effectMagnitude(0.4)).toBe("medium");
    expect(effectMagnitude(0.9)).toBe("large");
  });

  it("orients by `better`: a faster candidate on a lower-is-better metric is positive", () => {
    const candidate = [10, 11, 12]; // seconds
    const baseline = [20, 21, 22];
    const raw = effectSize(candidate, baseline);
    expect(raw.cliffsDelta).toBe(-1);
    expect(raw.hodgesLehmann).toBe(-10);
    const oriented = effectSize(candidate, baseline, "lower");
    expect(oriented).toEqual({
      cliffsDelta: 1,
      magnitude: "large",
      hodgesLehmann: 10,
      nCandidate: 3,
      nBaseline: 3,
    });
  });

  it("property: δ ∈ [-1,1], antisymmetric; HL recovers a pure shift", () => {
    fc.assert(
      fc.property(
        finiteArr(),
        finiteArr(),
        fc.integer({ min: -1000, max: 1000 }),
        (xs, ys, shift) => {
          const d = cliffsDelta(xs, ys);
          expect(d).toBeGreaterThanOrEqual(-1);
          expect(d).toBeLessThanOrEqual(1);
          expect(cliffsDelta(ys, xs)).toBeCloseTo(-d, 12);
          const ints = xs.map((x) => Math.round(x));
          const shifted = ints.map((x) => x + shift);
          expect(hodgesLehmann(shifted, ints)).toBe(shift);
          if (shift > 0) expect(cliffsDelta(shifted, ints)).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });
});
