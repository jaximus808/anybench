import { describe, expect, it } from "vitest";
import type { Requirement } from "@anybench/core";
import {
  encodeMetricsJsonl,
  gatedMetrics,
  linkGates,
  metric,
  MetricSchema,
  parseMetricsJsonl,
  trialMetricRecord,
  usdTextToMicro,
} from "../../src/metric.js";
import {
  collect,
  collectorMetrics,
  isParsedCollector,
  PARSED_COLLECTORS,
} from "../../src/collectors/index.js";
import { fixture } from "./fixture.js";

describe("MetricSchema", () => {
  it("holds micro-USD as bigint and every other unit as a number", () => {
    expect(
      metric({
        name: "cost_micro_usd",
        value: "1500",
        unit: "micro_usd",
        level: "trial",
        collector: "stream-json",
      }).value,
    ).toBe(1500n);
    expect(
      MetricSchema.safeParse({
        name: "cost_micro_usd",
        value: 0.0015,
        unit: "micro_usd",
        level: "trial",
        collector: "stream-json",
      }).success,
    ).toBe(false);
    expect(
      MetricSchema.safeParse({
        name: "wall_s",
        value: 1n,
        unit: "s",
        level: "trial",
        collector: "time",
      }).success,
    ).toBe(false);
    expect(
      MetricSchema.safeParse({
        name: "wall_s",
        value: Number.NaN,
        unit: "s",
        level: "trial",
        collector: "time",
      }).success,
    ).toBe(false);
  });

  it("requires a sample index exactly on sample-level rows", () => {
    expect(
      MetricSchema.safeParse({
        name: "t",
        value: 1,
        unit: "s",
        level: "sample",
        collector: "hyperfine",
      }).success,
    ).toBe(false);
    expect(
      MetricSchema.safeParse({
        name: "t",
        value: 1,
        unit: "s",
        level: "trial",
        sample: 0,
        collector: "hyperfine",
      }).success,
    ).toBe(false);
  });

  it("round-trips metrics.jsonl with bigint money as a decimal string", () => {
    const rows = collectorMetrics({
      collector: "stream-json",
      raw: fixture("stream-json/success.synthetic.jsonl"),
    });
    const text = encodeMetricsJsonl(rows);
    expect(text).toContain('"value":"123457"');
    const back = parseMetricsJsonl(text + "garbage\n");
    expect(back.metrics).toEqual(rows);
    expect(back.errors).toEqual([expect.stringMatching(/^line \d+: invalid JSON/)]);
  });
});

describe("usdTextToMicro", () => {
  it.each([
    ["0", 0n],
    ["12", 12_000_000n],
    ["0.1234567", 123_457n],
    ["0.1234564", 123_456n],
    ["2.5e-2", 25_000n],
    ["1E+2", 100_000_000n],
    ["-0.0000005", -1n],
    ["0.0000004", 0n],
  ])("%s USD -> %s micro-USD", (text, micro) => {
    expect(usdTextToMicro(text)).toBe(micro);
  });

  it("refuses non-numbers", () => {
    expect(() => usdTextToMicro("$1")).toThrow();
  });
});

describe("linkGates and collect", () => {
  const requirements: Requirement[] = [
    {
      id: "speed",
      type: "measured",
      title: "Fast",
      metric: "wall_s",
      better: "lower",
      gate_id: "output-matches",
    },
    {
      id: "cheap",
      type: "measured",
      title: "Cheap",
      metric: "cost_micro_usd",
      better: "lower",
      gate_id: "tests-pass",
    },
    {
      id: "p95",
      type: "measured",
      title: "Tail",
      metric: "p95_ms",
      better: "lower",
      gate_id: "responses-match",
    },
    {
      id: "style",
      type: "reviewed",
      title: "Readable",
      rubric: "rubric.md",
      scale: { min: 1, max: 4 },
    },
  ];

  it("stamps gate_id on rows that feed a measured requirement and reports missing metrics", () => {
    const res = collect(
      [
        { collector: "time", raw: fixture("time/time-v.txt") },
        { collector: "stream-json", raw: fixture("stream-json/success.synthetic.jsonl") },
        { collector: "hyperfine", raw: "{not json" },
      ],
      requirements,
    );
    expect(res.metrics.find((m) => m.name === "wall_s")?.gate_id).toBe("output-matches");
    expect(res.metrics.find((m) => m.name === "cost_micro_usd")?.gate_id).toBe("tests-pass");
    expect(res.metrics.find((m) => m.name === "peak_rss_bytes")?.gate_id).toBeUndefined();
    expect(
      gatedMetrics(res.metrics)
        .map((m) => m.name)
        .sort(),
    ).toEqual(["cost_micro_usd", "wall_s"]);
    expect(res.missing).toEqual([
      { requirement_id: "p95", metric: "p95_ms", gate_id: "responses-match" },
    ]);
    expect(res.errors).toEqual([expect.stringMatching(/^hyperfine: /)]);
  });

  it("refuses one metric vouched for by two gates", () => {
    const rows = [
      metric({
        name: "wall_s",
        value: 1,
        unit: "s",
        level: "trial",
        collector: "time",
        gate_id: "other",
      }),
    ];
    expect(() => linkGates(rows, requirements)).toThrow(/already names gate/);
  });

  it("knows which collectors it can parse", () => {
    expect(PARSED_COLLECTORS).toContain("proxy-calls");
    expect(isParsedCollector("machine")).toBe(true);
    expect(isParsedCollector("screenshot")).toBe(false);
  });
});

describe("trialMetricRecord (scorer input)", () => {
  it("keeps unlabelled trial rows and turns micro-USD into an exact integer", () => {
    const rows = [
      ...collectorMetrics({ collector: "time", raw: fixture("time/time-v.txt") }),
      ...collectorMetrics({ collector: "hyperfine", raw: fixture("hyperfine/hyperfine.json") }),
      ...collectorMetrics({
        collector: "stream-json",
        raw: fixture("stream-json/success.synthetic.jsonl"),
      }),
    ];
    const rec = trialMetricRecord(rows);
    expect(rec.wall_s).toBe(0.69);
    expect(rec.cost_micro_usd).toBe(123457);
    expect(rec.hyperfine_time_s).toBeUndefined(); // sample-level
    expect(rec.hyperfine_mean_s).toBeUndefined(); // labelled by command
    expect(rec.tool_calls_by_name).toBeUndefined();
  });

  it("refuses two collectors disagreeing on one name", () => {
    const a = metric({ name: "p95_ms", value: 10, unit: "ms", level: "trial", collector: "hey" });
    const b = metric({ name: "p95_ms", value: 12, unit: "ms", level: "trial", collector: "k6" });
    expect(() => trialMetricRecord([a, b])).toThrow(/hey .* and k6/);
  });
});
