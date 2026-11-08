// TDM-175 [16.4]: scoring.primary, metric units only for known collector metrics, and the
// report's comparison schema (verdicts that can't contradict their numbers).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  KNOWN_METRIC_UNITS,
  RequirementComparisonSchema,
  RequirementResultSchema,
  metricUnit,
  parseRequirementTarget,
  safeParseKitSpec,
} from "../src/index.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function harnessKitTdm175(): any {
  const url = new URL("./fixtures/kits/kit-harness-tandem.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}

describe("scoring.primary", () => {
  it("is optional and must name a weighted requirement", () => {
    const kit = harnessKitTdm175();
    expect(safeParseKitSpec(kit).success).toBe(true);
    kit.scoring.primary = "tests-pass";
    expect(safeParseKitSpec(kit).success).toBe(true);
    kit.scoring.primary = "nope";
    const bad = safeParseKitSpec(kit);
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.errors.join("\n")).toMatch(/scoring\.primary: requirement 'nope'/);
    kit.scoring.weights = { ...kit.scoring.weights, wall: 0, "tests-pass": 60 };
    kit.scoring.primary = "wall";
    const zero = safeParseKitSpec(kit);
    expect(zero.success).toBe(false);
    if (!zero.success) expect(zero.errors.join("\n")).toMatch(/needs a weight above 0/);
  });
});

describe("metricUnit infers only for known collector metrics", () => {
  it("knows the collectors' metrics", () => {
    expect(metricUnit("wall_s")).toBe("s");
    expect(metricUnit("peak_rss_bytes")).toBe("bytes");
    expect(metricUnit("p95_ms")).toBe("ms");
    expect(metricUnit("cost_micro_usd")).toBe("micro-USD");
    expect(metricUnit("gate_pass_rate")).toBe("ratio");
    expect(metricUnit("constructor")).toBeUndefined(); // not an inherited property
    expect(Object.keys(KNOWN_METRIC_UNITS).length).toBeGreaterThan(30);
  });

  it("no longer misreads rates and look-alike suffixes (TDM-174 review)", () => {
    expect(metricUnit("throughput_ops_s")).toBeUndefined();
    expect(metricUnit("requests_s")).toBeUndefined();
    expect(metricUnit("bonus_us")).toBeUndefined();
    // A declared unit is used as is: "at least 500" ops/s on a rate metric.
    expect(parseRequirementTarget("at least 500", "ops/s", "throughput_ops_s")).toEqual({
      ok: true,
      bound: { op: "ge", value: 500 },
    });
    expect(parseRequirementTarget("under 3 ms", "ms", "bonus_us")).toEqual({
      ok: true,
      bound: { op: "le", value: 3 },
    });
    // Without a unit, a unit word in the target can't be checked: refused, not guessed.
    const r = parseRequirementTarget("under 3 ms", undefined, "bonus_us");
    expect(r.ok).toBe(false);
  });
});

describe("RequirementComparisonSchema", () => {
  const ok = {
    baseline_id: "claude-code-solo",
    verdict: "indistinguishable",
    test: "newcombe",
    p: 0.42,
    p_adjusted: 0.42,
    alpha: 0.05,
    family: 1,
    effect: { measure: "rate_diff", value: 0.133, hodges_lehmann: null },
    diff_ci: {
      lo: -0.19,
      hi: 0.42,
      level: 0.95,
      requested_level: 0.95,
      attained: true,
      unit: "rate",
    },
    n: { candidate: 15, baseline: 15, tasks: 1 },
    mde: { value: 0.46, unit: "rate", metric_shift: null },
    claim: "general",
    downgraded: null,
    statement: "no detectable difference at n=15 vs 15, smallest detectable difference=46 pts",
  } as const;

  it("accepts an honest comparison", () => {
    expect(RequirementComparisonSchema.safeParse(ok).success).toBe(true);
  });

  it("refuses a 'better' without significance or with the wrong sign", () => {
    expect(
      RequirementComparisonSchema.safeParse({ ...ok, verdict: "better", statement: "better: x" })
        .success,
    ).toBe(false);
    expect(
      RequirementComparisonSchema.safeParse({
        ...ok,
        verdict: "better",
        p_adjusted: 0.01,
        effect: { ...ok.effect, value: -0.2 },
        statement: "better: x",
      }).success,
    ).toBe(false);
  });

  it("an indistinguishable result must read 'no detectable difference at n=…'", () => {
    expect(
      RequirementComparisonSchema.safeParse({ ...ok, statement: "about the same" }).success,
    ).toBe(false);
  });

  it("a survivorship requirement can't carry a 'better'", () => {
    const row = {
      requirement_id: "lat",
      type: "measured",
      title: "latency",
      value: 10,
      unit: "ms",
      ci95: null,
      gate_id: "g",
      gate_pass_rate: 0.6,
      score: null,
      survivorship: true,
      comparison: {
        ...ok,
        verdict: "better",
        p_adjusted: 0.01,
        statement: "better: Cliff's δ +0.9",
      },
    };
    expect(RequirementResultSchema.safeParse(row).success).toBe(false);
    expect(RequirementResultSchema.safeParse({ ...row, survivorship: false }).success).toBe(true);
  });
});
