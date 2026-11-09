// TDM-233 [18.12]: the two skeptic declarations in KitSpec: workloads[].instruction_kind
// (`contract`: the instruction is the contract the hidden tests check) and gates[].fixtures (the
// grader's own copies of workload inputs), which must live under the gate's own directory.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { safeParseKitSpec } from "../src/index.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function agentKitTdm233(): any {
  return JSON.parse(
    readFileSync(new URL("./fixtures/kits/kit-agent.json", import.meta.url), "utf8"),
  );
}

describe("KitSpec skeptic declarations (TDM-233)", () => {
  it("accepts instruction_kind task | contract and fixtures under the gate's dir", () => {
    const k = agentKitTdm233();
    k.workloads[0].instruction_kind = "contract";
    const g = k.gates[0];
    g.fixtures = [`gates/${g.id}/seed.json`, `gates/${g.id}/*/fixtures/`];
    const r = safeParseKitSpec(k);
    if (!r.success) throw new Error(r.errors.join("\n"));
    expect(r.data.workloads[0]!.instruction_kind).toBe("contract");
    expect(r.data.gates[0]!.fixtures).toHaveLength(2);
    // Omitted: a plain task, no fixtures.
    const plain = safeParseKitSpec(agentKitTdm233());
    expect(plain.success && plain.data.workloads[0]!.instruction_kind).toBeUndefined();
  });

  it("refuses an unknown instruction_kind", () => {
    const k = agentKitTdm233();
    k.workloads[0].instruction_kind = "spec";
    const r = safeParseKitSpec(k);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.errors.join("\n")).toMatch(/workloads\[0\]\.instruction_kind/);
  });

  it("refuses a fixture outside the gate's own directory, or a ** pattern", () => {
    for (const bad of [
      "workloads/x/input/seed.json",
      "gates/other-gate/seed.json",
      "gates/G/**/x.json",
    ]) {
      const k = agentKitTdm233();
      const g = k.gates[0];
      g.fixtures = [bad.replace("G", g.id)];
      const r = safeParseKitSpec(k);
      expect(r.success, bad).toBe(false);
      if (!r.success) expect(r.errors.join("\n")).toMatch(/must be a path under gates\//);
    }
  });
});
