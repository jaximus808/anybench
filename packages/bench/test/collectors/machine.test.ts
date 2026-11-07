import { describe, expect, it } from "vitest";
import { collectMachine, lscpuField, parseMachineJson } from "../../src/collectors/machine.js";
import { fixture, value } from "./fixture.js";

describe("machine collector (machine.json from real debian probe outputs)", () => {
  const text = fixture("machine/machine.json");

  it("emits load, steal, nproc and memory rows", () => {
    const rows = collectMachine(text);
    expect(value(rows, "nproc")).toBe(10);
    expect(value(rows, "load_1m")).toBe(10.67);
    expect(value(rows, "load_15m")).toBe(5.46);
    expect(value(rows, "steal_pct")).toBe(0);
    expect(value(rows, "mem_total_bytes")).toBe(8126672 * 1024);
    expect(value(rows, "mem_available_bytes")).toBe(7034028 * 1024);
    // ARM lscpu prints "Model name: -", so the vendor stands in.
    expect(rows[0]!.labels).toEqual({ cpu_model: "Apple", arch: "arm64" });
  });

  it("skips steal when the probe could not sample it (off Linux)", () => {
    const m = { ...parseMachineJson(text), steal_pct: null, lscpu: null };
    const rows = collectMachine(m);
    expect(rows.some((r) => r.name === "steal_pct")).toBe(false);
    expect(rows[0]!.labels).toEqual({ arch: "arm64" });
  });

  it("reads lscpu fields and rejects a machine.json without nproc", () => {
    expect(lscpuField(parseMachineJson(text).lscpu!, "Architecture")).toBe("aarch64");
    expect(() => collectMachine({ load_1m: 1 })).toThrow();
  });
});
