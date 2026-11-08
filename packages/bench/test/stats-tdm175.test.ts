// TDM-175 [16.4]: inference primitives, checked against reference values.
//
// Reference values were computed with scipy 1.18.1 and statsmodels 0.15.0
// (`uv run --with scipy --with statsmodels python refs.py`, see docs/findings/stats-references.md):
// norm.ppf / norm.cdf, proportion_confint(method="wilson"),
// confint_proportions_2indep(method="newcomb", compare="diff"), mannwhitneyu(method="exact" |
// PermutationMethod(n_resamples=inf) | "asymptotic"), multipletests(method="holm"), binom.cdf, and
// R's wilcox.test(conf.int=TRUE) Hodges–Lehmann algorithm on scipy's exact U distribution.
import { describe, expect, it } from "vitest";
import {
  clopperPearsonCi,
  signFlipTest,
  hodgesLehmannCi,
  holmAdjust,
  mannWhitney,
  mdeCliffsDelta,
  mdeTwoProportions,
  medianCi,
  minMannWhitneyP,
  newcombeCi,
  newcombePValue,
  normalCdf,
  normalQuantile,
  wilsonCi,
} from "../src/index.js";

describe("normal distribution (scipy.stats.norm)", () => {
  it("quantile", () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959963984540054, 13);
    expect(normalQuantile(0.001)).toBeCloseTo(-3.090232306167813, 12);
    expect(normalQuantile(1e-10)).toBeCloseTo(-6.361340902404056, 11);
    expect(normalQuantile(0.5)).toBe(0);
  });
  it("cdf", () => {
    expect(normalCdf(1.2345)).toBeCloseTo(0.8914916766373298, 14);
    expect(normalCdf(-3.1)).toBeCloseTo(0.0009676032132183562, 15);
    // Far tail: relative error ~1e-8 (absolute ~1e-25).
    expect(normalCdf(-8.5) / 9.479534822203251e-18).toBeCloseTo(1, 7);
  });
});

describe("Wilson and Newcombe (statsmodels)", () => {
  it.each([
    [11, 15, 0.48049565944019423, 0.8910254667430763],
    [9, 15, 0.35746830120624595, 0.8017550385865843],
    [0, 10, 0, 0.27753279986288926],
    [10, 10, 0.7224672001371106, 1],
    [3, 7, 0.15821985525146964, 0.7495416354723428],
  ])("wilson %i/%i", (x, n, lo, hi) => {
    const ci = wilsonCi(x, n);
    expect(ci.lo).toBeCloseTo(lo, 12);
    expect(ci.hi).toBeCloseTo(hi, 12);
  });

  it.each([
    [11, 15, 9, 15, -0.19013534356563233, 0.42262286625683954],
    [15, 15, 5, 15, 0.344433498191572, 0.8482367556028528],
    [3, 7, 6, 8, -0.6454033307481577, 0.14666875403733665],
  ])("newcombe %i/%i − %i/%i", (x1, n1, x2, n2, lo, hi) => {
    const ci = newcombeCi(x1, n1, x2, n2);
    expect(ci.lo).toBeCloseTo(lo, 12);
    expect(ci.hi).toBeCloseTo(hi, 12);
  });

  it("the Newcombe p-value is the inversion of its CI", () => {
    const p = newcombePValue(15, 15, 5, 15);
    expect(p).toBeLessThan(0.05);
    // At level 1 − p the bound touches 0.
    expect(newcombeCi(15, 15, 5, 15, 1 - p).lo).toBeCloseTo(0, 9);
    expect(newcombePValue(11, 15, 9, 15)).toBeGreaterThan(0.3);
    expect(newcombePValue(7, 10, 7, 10)).toBe(1);
  });
});

describe("Mann–Whitney (scipy.stats.mannwhitneyu)", () => {
  it("exact, no ties", () => {
    const x = [1.83, 0.5, 1.62, 2.48, 1.68, 1.88, 1.55];
    const y = [0.878, 0.647, 0.598, 2.05, 1.06, 1.29];
    const r = mannWhitney(x, y);
    expect(r).toMatchObject({ u: 31, method: "exact", ties: false });
    expect(r.p).toBeCloseTo(0.18065268065268064, 12);
  });
  it("exact, separated 5 vs 5: the smallest p there is", () => {
    const r = mannWhitney([10.1, 10.4, 9.8, 10.0, 10.3], [12.2, 11.9, 12.5, 12.0, 12.4]);
    expect(r.u).toBe(0);
    expect(r.p).toBeCloseTo(0.007936507936507936, 14);
    expect(minMannWhitneyP(5, 5)).toBeCloseTo(2 / 252, 14);
  });
  it("exact with ties = scipy's exact permutation test", () => {
    const r = mannWhitney([1, 2, 2, 3, 3, 3, 5], [2, 3, 4, 4, 5, 6]);
    expect(r).toMatchObject({ u: 10, method: "exact", ties: true });
    expect(r.p).toBeCloseTo(0.13286713286713286, 12);
    // Failures at the cap tie with each other.
    const c = mannWhitney([100, 120, 3600, 3600, 110], [3600, 3600, 3600, 200, 3600]);
    expect(c.u).toBe(6);
    expect(c.p).toBeCloseTo(0.16666666666666666, 12);
  });
  it("asymptotic with tie correction", () => {
    const r = mannWhitney([1, 2, 2, 3, 3, 3, 5], [2, 3, 4, 4, 5, 6], { method: "asymptotic" });
    expect(r.p).toBeCloseTo(0.125006218529338, 12);
    // Above EXACT_MAX_N it switches on its own.
    const xa = [
      0.35, 0.82, 0.33, -1.3, 0.91, 0.45, -0.54, 0.58, 0.36, 0.29, 0.03, 0.55, -0.74, -0.16, -0.48,
      0.6, 0.04, -0.29, -0.78, -0.26, 0.01, -0.28, 1.29, 1.01, -2.71, -1.89, -0.17, -0.42, 0.21,
      0.22, 2.12, -1.11, -0.38, 2.04, 0.65, 0.66, -0.51, -1.65, 0.17, 0.11,
    ];
    const ya = [
      -0.73, -0.18, 0.43, -0.44, 0.4, 0.6, 0.54, -0.01, 1.09, 1.39, 0.82, -0.32, 1.23, -0, 1.38,
      -0.57, 1.41, 0.48, -0.75, 0.19, 0.55, 0.77, -0.48, -0.61, 0.7, 0.03, 0.74, 1.26, -1.15, 0.75,
      1.72, 0.2, -0.31, 1.25, 0.75,
    ];
    const big = mannWhitney(xa, ya);
    expect(big).toMatchObject({ u: 534.5, method: "asymptotic" });
    expect(big.p).toBeCloseTo(0.07971264883121788, 12);
  });
  it("all-equal samples give p = 1", () => {
    expect(mannWhitney([1, 1, 1], [1, 1, 1]).p).toBe(1);
    expect(mannWhitney([1, 1, 1], [1, 1, 1], { method: "asymptotic" }).p).toBe(1);
  });
});

describe("Hodges–Lehmann CI (R's wilcox.test conf.int algorithm)", () => {
  it("7 vs 6 reaches 95% (attains 96.5%)", () => {
    const ci = hodgesLehmannCi(
      [1.83, 0.5, 1.62, 2.48, 1.68, 1.88, 1.55],
      [0.878, 0.647, 0.598, 2.05, 1.06, 1.29],
    );
    expect(ci.estimate).toBeCloseTo(0.707, 12);
    expect(ci.lo).toBeCloseTo(-0.37, 12);
    expect(ci.hi).toBeCloseTo(1.232, 12);
    expect(ci.level).toBeCloseTo(0.965034965034965, 12);
    expect(ci.attained).toBe(true);
  });
  it("5 vs 5 attains 96.8%", () => {
    const ci = hodgesLehmannCi([10.1, 10.4, 9.8, 10.0, 10.3], [12.2, 11.9, 12.5, 12.0, 12.4]);
    expect(ci.estimate).toBeCloseTo(-2.1, 12);
    expect([ci.lo, ci.hi]).toEqual([expect.closeTo(-2.5, 12), expect.closeTo(-1.6, 12)]);
    expect(ci.level).toBeCloseTo(0.9682539682539683, 12);
  });
  it("3 vs 3 can't reach 95%: the widest interval, labelled 90%", () => {
    const ci = hodgesLehmannCi([1, 2, 3], [2.5, 3.5, 4.5]);
    expect(ci).toMatchObject({ estimate: -1.5, lo: -3.5, hi: 0.5, requestedLevel: 0.95 });
    expect(ci.level).toBeCloseTo(0.9, 12);
    expect(ci.attained).toBe(false);
  });
});

describe("median CI from order statistics (binomial)", () => {
  it("n = 5: no 95% distribution-free interval exists, so [min, max] at 93.75%", () => {
    const ci = medianCi([12, 10, 14, 11, 13]);
    expect(ci).toMatchObject({
      estimate: 12,
      lo: 10,
      hi: 14,
      requestedLevel: 0.95,
      attained: false,
    });
    expect(ci.level).toBe(0.9375);
  });
  it("n = 6 reaches it (96.875%), n = 10 uses x(2)..x(9) at 97.85%", () => {
    expect(medianCi([1, 2, 3, 4, 5, 6])).toMatchObject({
      lo: 1,
      hi: 6,
      level: 0.96875,
      attained: true,
    });
    const ten = medianCi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(ten).toMatchObject({ lo: 2, hi: 9, attained: true });
    expect(ten.level).toBeCloseTo(0.978515625, 12);
  });
  it("n = 20 at 95% uses x(6)..x(15)", () => {
    const xs = Array.from({ length: 20 }, (_, i) => i + 1);
    const ci = medianCi(xs);
    // 1 − 2·P(B ≤ 5), B ~ Bin(20, ½) = 0.9586; k = 7 would be 0.8847.
    expect(ci).toMatchObject({ lo: 6, hi: 15, attained: true });
    expect(ci.level).toBeCloseTo(0.9586105346679688, 12);
  });
});

describe("Holm (statsmodels multipletests)", () => {
  it("matches the reference", () => {
    expect(holmAdjust([0.01, 0.04, 0.03, 0.005])).toEqual([
      expect.closeTo(0.03, 14),
      expect.closeTo(0.06, 14),
      expect.closeTo(0.06, 14),
      expect.closeTo(0.02, 14),
    ]);
    expect(holmAdjust([])).toEqual([]);
    expect(holmAdjust([0.9, 0.8])).toEqual([1, 1]); // statsmodels: [1, 1]
  });
});

describe("power", () => {
  it("15 trials per arm detect only ~45-50 pts at 80% power", () => {
    const mde = mdeTwoProportions(15, 15, { rate: 0.5 })!;
    expect(mde).toBeGreaterThan(0.45);
    expect(mde).toBeLessThan(0.5);
    // At the pooled rate of 11/15 vs 9/15 (2/3): 46 pts (Fleiss solve, checked in Python).
    expect(mdeTwoProportions(15, 15, { rate: 2 / 3 })!).toBeCloseTo(0.4635263357405247, 8);
    // 4× the trials halves it.
    expect(mdeTwoProportions(60, 60)! / mde).toBeCloseTo(0.5, 1);
    expect(mdeTwoProportions(1, 1)).toBeNull();
  });
  it("Cliff's δ: 5 vs 5 detects nothing short of separation; 20 vs 20 detects ~0.51", () => {
    expect(mdeCliffsDelta(5, 5)).toBeNull();
    expect(mdeCliffsDelta(3, 3)).toBeNull(); // the exact test can't go below p = 0.1
    expect(mdeCliffsDelta(20, 20)).toBeCloseTo((2 * 2.8015852) / Math.sqrt(120), 5);
  });
});

describe("small n: exact intervals and exact tests over tasks (Bowyer et al. 2025)", () => {
  it.each([
    [11, 15, 0.4489967589630295, 0.9221284537089565],
    [9, 15, 0.3228697662062816, 0.8366356761404865],
    [0, 10, 0, 0.30849710781876083],
    [10, 10, 0.6915028921812392, 1],
    [3, 7, 0.09898827844250786, 0.815948432359917],
  ])("Clopper–Pearson %i/%i (statsmodels method='beta')", (x, n, lo, hi) => {
    const ci = clopperPearsonCi(x, n);
    expect(ci.lo).toBeCloseTo(lo, 10);
    expect(ci.hi).toBeCloseTo(hi, 10);
  });

  it("sign flip over tasks: exact, and 3 tasks can never go below p = 0.25", () => {
    expect(signFlipTest([0.4, 0.6, 0.2])).toMatchObject({ p: 0.25, method: "exact", minP: 0.25 });
    // 6 tasks all the same way: 2/64.
    expect(signFlipTest([1, 1, 1, 1, 1, 1]).p).toBeCloseTo(2 / 64, 14);
    // Mixed signs: |Σ| = 1 for [2, -1]: patterns ±2±1 → |3|,|1|,|1|,|3| all ≥ 1 → p = 1.
    expect(signFlipTest([2, -1]).p).toBe(1);
    expect(signFlipTest([0, 0]).p).toBe(1);
    // Above 16 tasks it samples, seeded.
    const big = Array.from({ length: 24 }, (_, i) => (i % 5 === 0 ? -0.1 : 0.3));
    const a = signFlipTest(big, { seed: 7 });
    expect(a.method).toBe("monte_carlo");
    expect(a).toEqual(signFlipTest(big, { seed: 7 }));
    expect(a.p).toBeLessThan(0.001);
  });
});
