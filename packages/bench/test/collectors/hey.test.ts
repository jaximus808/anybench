import { describe, expect, it } from "vitest";
import { collectHey, parseHey } from "../../src/collectors/hey.js";
import { fixture, value } from "./fixture.js";

describe("hey collector (real hey v0.1.4 summary)", () => {
  it("parses RPS, latency percentiles and status codes", () => {
    const rows = collectHey(fixture("hey/hey.txt"));
    expect(value(rows, "rps")).toBe(630.7939);
    expect(value(rows, "http_requests")).toBe(400);
    expect(value(rows, "http_failed")).toBe(0);
    expect(value(rows, "error_rate")).toBe(0);
    expect(value(rows, "p50_ms")).toBe(0.3);
    expect(value(rows, "p95_ms")).toBe(53.1);
    expect(value(rows, "p99_ms")).toBe(334);
    expect(value(rows, "latency_mean_ms")).toBe(13.5);
    expect(value(rows, "latency_max_ms")).toBe(369.3);
    expect(value(rows, "load_duration_s")).toBe(0.6341);
    expect(value(rows, "http_status", { status: "200" })).toBe(400);
    expect(value(rows, "http_data_bytes")).toBe(246000);
    expect(rows.every((m) => m.collector === "hey" && m.level === "trial")).toBe(true);
  });

  it("counts 4xx responses as failed", () => {
    const rows = collectHey(fixture("hey/hey-404.txt"));
    expect(value(rows, "http_failed")).toBe(200);
    expect(value(rows, "error_rate")).toBe(1);
    expect(value(rows, "http_status", { status: "404" })).toBe(200);
  });

  it("counts transport errors from the error distribution", () => {
    const text = fixture("hey/hey.txt").replace(
      "Status code distribution:\n  [200]\t400 responses",
      'Status code distribution:\n  [200]\t390 responses\n\nError distribution:\n  [10]\tGet "http://web/": dial tcp: connection refused',
    );
    const r = parseHey(text);
    expect(r.errors.size).toBe(1);
    const rows = collectHey(text);
    expect(value(rows, "http_requests")).toBe(400);
    expect(value(rows, "http_failed")).toBe(10);
    expect(value(rows, "http_errors")).toBe(10);
  });

  it("refuses output that is not hey's summary", () => {
    expect(() => collectHey("response-time,DNS+dialup\n0.1,0.0\n")).toThrow(/Requests\/sec/);
  });
});
