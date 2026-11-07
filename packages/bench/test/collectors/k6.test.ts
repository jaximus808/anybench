import { describe, expect, it } from "vitest";
import { collectK6 } from "../../src/collectors/k6.js";
import { fixture, value } from "./fixture.js";

describe("k6 collector (real grafana/k6 1.3.0 --summary-export)", () => {
  const rows = collectK6(fixture("k6/k6-summary.json"));

  it("maps the http_req_duration trend to the shared load metrics", () => {
    expect(value(rows, "p50_ms")).toBe(0.688);
    expect(value(rows, "p90_ms")).toBe(8.443);
    expect(value(rows, "p95_ms")).toBe(16.947);
    expect(value(rows, "latency_mean_ms")).toBe(4.202);
    expect(value(rows, "latency_max_ms")).toBe(191.404);
    expect(value(rows, "rps")).toBeCloseTo(883.7643158715508, 9);
    expect(value(rows, "http_requests")).toBe(2732);
  });

  it("reads http_req_failed.passes as the failed count (k6 Rate semantics)", () => {
    expect(value(rows, "http_failed")).toBe(1366);
    expect(value(rows, "error_rate")).toBe(0.5);
  });

  it("reports checks, iterations and thresholds", () => {
    expect(value(rows, "checks_passed")).toBe(2732);
    expect(value(rows, "checks_failed")).toBe(0);
    expect(value(rows, "iterations")).toBe(1366);
    expect(
      value(rows, "k6_threshold_failed", { metric: "http_req_duration", threshold: "p(95)<500" }),
    ).toBe(0);
    expect(rows.every((m) => m.collector === "k6")).toBe(true);
  });

  it("rejects a summary without http metrics", () => {
    expect(() => collectK6({ metrics: { vus: { value: 1 } } })).toThrow();
  });
});
