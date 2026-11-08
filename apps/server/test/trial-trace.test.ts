// Trial traces: the parser on fixtures cut from real bundles of run 01a1bae4 (scrubbed: board
// session tokens and the worker hostname replaced; only the transcript, board and event files kept).
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { RunTraceSummarySchema, stringifyJson, TrialTraceSchema } from "@anybench/core";
import { describe, expect, it } from "vitest";
import {
  traceFromBundle,
  usdNumberToMicro,
  testSummary,
  failureTerms,
} from "../src/lib/trial-trace/parse.js";
import { readTarGz } from "../src/lib/trial-trace/tar.js";
import { summarizeRunTraces } from "../src/lib/trial-trace/summary.js";

const fx = (name: string) => new URL(`./fixtures/trial-trace/${name}`, import.meta.url);
const SOLO_ID = "01a1bae4-5066-7da3-bc5f-40ea32b25644";
const TANDEM_ID = "01a1bae4-5066-7dc0-b1fb-be46663700e2";
const solo = () => new Uint8Array(readFileSync(fx("solo-todo-api.tar.gz")));
const tandem = () => new Uint8Array(readFileSync(fx("tandem-todo-api-failed.tar.gz")));
const tandemGate = () => JSON.parse(readFileSync(fx("tandem-todo-api-failed.gate.json"), "utf8"));
const NOW = () => new Date("2026-11-08T12:00:00Z");

describe("trial trace: tar reader", () => {
  it("reads the real bundle's files", () => {
    const names = readTarGz(tandem()).map((e) => e.name);
    expect(names).toContain("tandem/streams/worker-3.jsonl");
    expect(names).toContain("events.jsonl");
  });

  it("refuses an entry that runs past the archive", () => {
    const h = new Uint8Array(512);
    h.set(new TextEncoder().encode("a.txt"), 0);
    h.set(new TextEncoder().encode("00000001000\0"), 124); // 512 bytes, none present
    h[156] = 0x30;
    expect(() => readTarGz(gzipSync(h))).toThrow(/past the end/);
  });
});

describe("trial trace: solo Claude Code", () => {
  const trace = traceFromBundle(solo(), { trialId: SOLO_ID, gate: null, now: NOW });

  it("validates against the core contract and survives a JSON round trip", () => {
    expect(TrialTraceSchema.parse(JSON.parse(stringifyJson(trace)))).toEqual(trace);
  });

  it("has one lane with its model turns and tool calls", () => {
    expect(trace.setup).toBe("claude-code-solo");
    expect(trace.actors.map((a) => a.id)).toEqual(["agent"]);
    const a = trace.actors[0]!;
    expect(a.role).toBe("solo");
    expect(a.totals.turns).toBe(4);
    expect(a.totals.tool_calls).toBe(3);
    expect(a.totals.test_runs).toBe(1);
    // From the session's result line (the proxy streams zero per-turn usage).
    expect(a.totals.tokens).toEqual({
      input: 10,
      output: 9018,
      cache_read: 95993,
      cache_write: 10615,
    });
    expect(a.totals.cost_micro_usd).toBe(252674n);
    expect(trace.notes.join(" ")).toMatch(/per session/);
    const test = a.steps.find((s) => s.test)!;
    expect(test.test_summary).toBe("pass 6 · fail 0");
    expect(a.steps.filter((s) => s.files?.includes("src/store.ts")).length).toBeGreaterThan(0);
  });

  it("times are from the running phase and the wall split adds up", () => {
    expect(trace.started_at).toBe("2026-11-08T11:23:41.700Z");
    const a = trace.actors[0]!;
    // Session start = last line − result.duration_ms (73.71 s).
    expect(a.end_ms - a.start_ms).toBe(73_710);
    const w = trace.wall;
    const sum = w.model_ms + w.tool_ms + w.coordination_ms + w.idle_ms;
    expect(Math.abs(sum - trace.duration_ms)).toBeLessThanOrEqual(20);
    expect(w.coordination_ms).toBe(0);
    expect(trace.failure).toBeNull();
    for (const s of a.steps) expect(s.end_ms).toBeGreaterThanOrEqual(s.start_ms);
  });
});

describe("trial trace: Tandem ×3, failed hidden test", () => {
  const trace = traceFromBundle(tandem(), { trialId: TANDEM_ID, gate: tandemGate(), now: NOW });

  it("has the planner and three workers, with session totals", () => {
    expect(trace.setup).toBe("tandem");
    expect(trace.actors.map((a) => a.id)).toEqual(["planner", "worker-1", "worker-2", "worker-3"]);
    expect(trace.actors.map((a) => a.role)).toEqual(["planner", "worker", "worker", "worker"]);
    const w2 = trace.actors[2]!;
    // worker-2 sat in queue_wait for its 60 s timeout.
    expect(w2.totals.wait_ms).toBeGreaterThanOrEqual(60_000);
    expect(w2.steps.some((s) => s.kind === "wait" && s.name === "queue_wait")).toBe(true);
    // Turns that only drove the board are attributed, and never exceed model time.
    for (const a of trace.actors)
      expect(a.totals.model_board_ms).toBeLessThanOrEqual(a.totals.model_ms + 10);
    expect(trace.actors[0]!.totals.model_board_ms).toBeGreaterThan(0);
  });

  it("never stores a board session token", () => {
    expect(stringifyJson(trace)).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    expect(stringifyJson(trace)).not.toMatch(/"session"/);
  });

  it("has the board's coordination events and the planning phase", () => {
    const kinds = trace.coordination.map((c) => c.kind);
    expect(kinds).toContain("epic_proposed");
    expect(kinds).toContain("approved");
    expect(kinds.filter((k) => k === "task_done")).toHaveLength(4);
    expect(kinds.filter((k) => k === "lost_claim").length).toBeGreaterThanOrEqual(3);
    expect(trace.phases.map((p) => p.name)).toEqual(["setup", "planning", "work", "teardown"]);
    const planning = trace.phases.find((p) => p.name === "planning")!;
    expect(planning.end_ms - planning.start_ms).toBeGreaterThan(30_000);
  });

  it("explains the failure from the gate record and points at the store", () => {
    const f = trace.failure!;
    expect(f.passed).toBe(15);
    expect(f.total).toBe(16);
    expect(f.tests).toEqual([
      expect.objectContaining({
        gate: "hidden-tests",
        file: "persistence.test.ts",
        name: "the data file stores a password hash, never the password",
      }),
    ]);
    expect(f.tests[0]!.message).toMatch(/ENOENT/);
    expect(f.files).toContain("src/store.ts");
    const first = f.related[0]!;
    const step = trace.actors.find((a) => a.id === first.actor)!.steps[first.step]!;
    expect(step.files).toContain("src/store.ts");
    expect(trace.notes.join(" ")).toMatch(/first failing hidden test/);
  });
});

describe("trial trace: helpers", () => {
  it("converts Claude Code's USD to integer micro-USD without float money", () => {
    expect(usdNumberToMicro(0.35508300000000004)).toBe(355083n);
    expect(usdNumberToMicro(0.2526736)).toBe(252674n);
    expect(usdNumberToMicro(-1)).toBeNull();
    expect(usdNumberToMicro("1")).toBeNull();
  });

  it("reads test summaries", () => {
    expect(testSummary("# tests 6\n# pass 6\n# fail 0\n")).toBe("pass 6 · fail 0");
    expect(testSummary(" Tests  2 failed | 8 passed (10)")).toBe("pass 8 · fail 2");
    expect(testSummary("nothing here")).toBeUndefined();
  });

  it("takes terms from a failing test", () => {
    expect(failureTerms(["persistence.test.ts", "the data file stores a password hash"])).toEqual([
      "persist",
      "data",
      "store",
      "password",
      "hash",
    ]);
  });
});

describe("trial trace: run summary", () => {
  it("averages per setup and task, with n, and counts trials without a trace", () => {
    const s = traceFromBundle(solo(), { trialId: SOLO_ID, now: NOW });
    const t = traceFromBundle(tandem(), { trialId: TANDEM_ID, gate: tandemGate(), now: NOW });
    const sum = summarizeRunTraces("01a1bae4-3254-7ab0-a68a-46d90aa060f7", [
      {
        contenderId: "27e77fea-3fb1-497d-8c1b-8f2306cfa7ac",
        workloadId: "todo-api",
        passed: true,
        trace: s,
      },
      {
        contenderId: "af031210-9606-493d-8567-54c54bf690b2",
        workloadId: "todo-api",
        passed: false,
        trace: t,
      },
      {
        contenderId: "af031210-9606-493d-8567-54c54bf690b2",
        workloadId: "todo-api",
        passed: true,
        trace: null,
      },
    ]);
    const parsed = RunTraceSummarySchema.parse(JSON.parse(stringifyJson(sum)));
    const [soloSetup, tandemSetup] = parsed.setups;
    expect(soloSetup!.all.n).toBe(1);
    expect(soloSetup!.all.sessions).toBe(1);
    expect(tandemSetup!.missing).toBe(1);
    expect(tandemSetup!.all.n).toBe(1);
    expect(tandemSetup!.all.passed).toBe(0);
    expect(tandemSetup!.all.sessions).toBe(4);
    expect(tandemSetup!.by_task.map((b) => b.workload_id)).toEqual(["todo-api"]);
    expect(tandemSetup!.all.tokens!.cache_read).toBeGreaterThan(soloSetup!.all.tokens!.cache_read);
  });
});
