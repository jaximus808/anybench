// metrics-fix: a gate's metric rows (`<gate>.metrics.jsonl` in the check's $1, e.g. api-load's
// api_p95_ms) reach the gate record, only on a passing verdict, and trialGateMetrics hands them to
// trials.metrics. Before the fix the record had no metrics at all, so api-p95 was "metric missing"
// on every run. FakeProvider scoring computer; the real shell wrapper is covered by
// gate-docker-tdm51.test.ts.
import { newId, RunIdSchema, TrialIdSchema, type Gate } from "@anybench/core";
import { createComputerRegistry, MemoryComputerStore } from "@anybench/envs";
import { FakeProvider, type FakeExecContext } from "@anybench/providers";
import { describe, expect, it } from "vitest";
import {
  GATE_METRICS_MAX,
  gateMetricsFile,
  parseGateMetrics,
  runGates,
  SCORE_ROOT,
  trialGateMetrics,
  TrialGateRecordSchema,
} from "../src/index.js";

const enc = new TextEncoder();
const SHA = "c".repeat(64);
const GATES: Gate[] = [
  { id: "hidden-tests", kind: "hidden-tests", timeout_s: 1 },
  { id: "api-load", kind: "custom", timeout_s: 1 },
];
const SCORING = [
  { path: "gates/hidden-tests/check.sh", data: enc.encode("#!/bin/sh\n") },
  { path: "gates/api-load/check.sh", data: enc.encode("#!/bin/sh\n") },
];

type Gs = Record<string, { pass: boolean; metrics?: string }>;

function scoringComputer(gates: Gs) {
  const fake = new FakeProvider({
    name: `fake-metrics-fix-${Math.random().toString(36).slice(2)}`,
  });
  const registry = createComputerRegistry({
    provider: fake,
    store: new MemoryComputerStore(),
    pricing: { pricePerBlockMicroUsd: 1000n },
  });
  const scripts: Record<string, string> = {};
  fake.onExec(/\.anybench\/score\/setup\.sh'$/, () => `AB_SETUP frozen=ok sha256=${SHA}\n`);
  fake.onExec(/bin\/gate-([a-z0-9._-]+)\.sh'/, (ctx: FakeExecContext) => {
    const id = ctx.match![1]!;
    scripts[id] = ctx.readFile(`${ctx.home}/.anybench/score/gate-${id}.sh`) ?? "";
    const g = gates[id]!;
    ctx.writeFile(
      `${SCORE_ROOT}/status/${id}.verdict`,
      JSON.stringify({ pass: g.pass, reason: g.pass ? "ok" : "no", evidence: [] }),
    );
    if (g.metrics !== undefined) ctx.writeFile(`${SCORE_ROOT}/status/${id}.metrics`, g.metrics);
    ctx.writeFile(
      `${SCORE_ROOT}/status/${id}.json`,
      JSON.stringify({ rc: 0, duration_ms: 3, verdict: "present" }),
    );
    return "";
  });
  fake.onExec(/cat '([^']+)'/, (ctx: FakeExecContext) => {
    const text = ctx.readFile(ctx.match![1]!);
    return text === undefined ? { exitCode: 1 } : { stdout: text };
  });
  const run = () =>
    runGates(
      {
        runId: newId(RunIdSchema),
        trialId: newId(TrialIdSchema),
        workloadId: "todo-api",
        gates: GATES,
        frozen: { kind: "bytes", data: enc.encode("tarball"), sha256: SHA },
        scoring: SCORING,
      },
      { registry, pollIntervalMs: 5, graceMs: 0, sleep: async () => undefined },
    );
  return { run, scripts };
}

const API_LOAD_ROWS = [
  { metric: "api_p95_ms", value: 3.612, unit: "ms", source: "gate:api-load" },
  { metric: "api_p50_ms", value: 1.2, unit: "ms", source: "gate:api-load" },
]
  .map((r) => JSON.stringify(r))
  .join("\n");

describe("gate metric rows (metrics-fix)", () => {
  it("a passing api-load verdict carries api_p95_ms into the record and trialGateMetrics", async () => {
    const s = scoringComputer({
      "hidden-tests": {
        pass: true,
        metrics: JSON.stringify({ metric: "hidden_tests_passed", value: 16 }),
      },
      "api-load": { pass: true, metrics: API_LOAD_ROWS },
    });
    const rec = await s.run();
    expect(TrialGateRecordSchema.parse(rec)).toEqual(rec);
    expect(rec.gates["api-load"]!.metrics).toEqual({ api_p95_ms: 3.612, api_p50_ms: 1.2 });
    expect(trialGateMetrics(rec)).toEqual({
      hidden_tests_passed: 16,
      api_p95_ms: 3.612,
      api_p50_ms: 1.2,
    });
    // The wrapper copies the check's own file under the verdict's rules, after dropping one the
    // contender shipped in its outputs.
    const script = s.scripts["api-load"]!;
    expect(script).toContain('rm -rf "$W/out/$G.metrics.jsonl"');
    expect(script).toContain('mf="$W/out/$G.metrics.jsonl"');
    expect(script).toMatch(/\[ ! -L "\$mf" \].*stat -c %U "\$mf"\)" = "\$U"/);
    expect(script.indexOf('rm -rf "$W/out/$G.metrics.jsonl"')).toBeLessThan(
      script.indexOf('bash "$S/kit/$CHECK"'),
    );
    expect(gateMetricsFile("api-load")).toBe("api-load.metrics.jsonl");
  });

  it("a failing verdict never vouches for a number, even when the check wrote one", async () => {
    const s = scoringComputer({
      "hidden-tests": { pass: false, metrics: JSON.stringify({ metric: "x", value: 1 }) },
      "api-load": { pass: false, metrics: API_LOAD_ROWS },
    });
    const rec = await s.run();
    expect(rec.gates["api-load"]!.metrics).toBeUndefined();
    expect(rec.gates["hidden-tests"]!.metrics).toBeUndefined();
    expect(trialGateMetrics(rec)).toEqual({});
  });

  it("records from before gates returned metrics still parse (no metrics key)", async () => {
    const s = scoringComputer({ "hidden-tests": { pass: true }, "api-load": { pass: true } });
    const rec = await s.run();
    expect(rec.gates["api-load"]).not.toHaveProperty("metrics");
    expect(trialGateMetrics(rec)).toEqual({});
  });

  it("parseGateMetrics keeps valid rows only: snake_case names, finite numbers, first wins", () => {
    const text = [
      JSON.stringify({ metric: "api_p95_ms", value: 3.6 }),
      JSON.stringify({ metric: "api_p95_ms", value: 99 }),
      JSON.stringify({ name: "wall_s", value: 12 }),
      JSON.stringify({ metric: "Bad Name", value: 1 }),
      JSON.stringify({ metric: "str_value", value: "3" }),
      "not json",
      "",
    ].join("\n");
    expect(parseGateMetrics(text)).toEqual({ api_p95_ms: 3.6, wall_s: 12 });
    const many = Array.from({ length: GATE_METRICS_MAX + 5 }, (_, i) =>
      JSON.stringify({ metric: `m_${i}`, value: i }),
    ).join("\n");
    expect(Object.keys(parseGateMetrics(many))).toHaveLength(GATE_METRICS_MAX);
  });
});
