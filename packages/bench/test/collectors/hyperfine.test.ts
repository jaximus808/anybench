import { describe, expect, it } from "vitest";
import { collectHyperfine } from "../../src/collectors/hyperfine.js";
import { fixture, value } from "./fixture.js";

describe("hyperfine collector (real hyperfine 1.19.0 --export-json)", () => {
  const rows = collectHyperfine(fixture("hyperfine/hyperfine.json"));
  const sleep = { command: "sleep 0.05" };

  it("emits a trial-level summary per command", () => {
    expect(value(rows, "hyperfine_mean_s", sleep)).toBeCloseTo(0.05416545250666668, 12);
    expect(value(rows, "hyperfine_median_s", sleep)).toBeCloseTo(0.054600091340000004, 12);
    expect(value(rows, "hyperfine_runs", sleep)).toBe(6);
    expect(value(rows, "hyperfine_failed_runs", sleep)).toBe(0);
    expect(
      value(rows, "hyperfine_min_s", { command: "seq 1 200000 | sort -n > /dev/null" }),
    ).toBeCloseTo(0.05770986184, 12);
  });

  it("emits one sample-level row per timed run", () => {
    const samples = rows.filter(
      (m) => m.name === "hyperfine_time_s" && m.labels?.command === "sleep 0.05",
    );
    expect(samples).toHaveLength(6);
    expect(samples.map((m) => m.sample)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(samples.every((m) => m.level === "sample" && m.unit === "s")).toBe(true);
    expect(samples[0]!.value).toBeCloseTo(0.051959028840000004, 12);
  });

  it("counts failed runs from exit_codes (--ignore-failure)", () => {
    const failed = collectHyperfine(fixture("hyperfine/hyperfine-failures.json"));
    expect(value(failed, "hyperfine_failed_runs")).toBe(4);
    expect(
      failed.filter((m) => m.name === "hyperfine_time_s").every((m) => m.labels?.exit_code === "2"),
    ).toBe(true);
  });

  it("rejects an export with no results", () => {
    expect(() => collectHyperfine({ results: [] })).toThrow();
  });
});
