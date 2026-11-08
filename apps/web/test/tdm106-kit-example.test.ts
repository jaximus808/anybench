import { DriverTypeSchema, safeParseKitSpec } from "@anybench/core";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { MINIMAL_KIT_YAML } from "../components/docs/kit-example";
import { DRIVER_DOCS, driverRows } from "../components/docs/kit-reference";

describe("docs kit example (TDM-106)", () => {
  it("the minimal anybench.yaml on /docs/kits validates against KitSpec v2", () => {
    const r = safeParseKitSpec(parse(MINIMAL_KIT_YAML));
    expect(r.success ? [] : r.errors).toEqual([]);
    if (!r.success) return;
    // It exercises the layers the page talks about, not just the required minimum.
    expect(r.data.requirements.every((q) => q.type !== "measured" || q.gate_id)).toBe(true);
    expect(r.data.proof.oracle).toBeDefined();
    expect(r.data.proof.do_less.length).toBeGreaterThan(0);
    expect(r.data.proof.regression).toBeDefined();
  });

  it("still fails validation when a measured requirement drops its gate (the rule shown on the page)", () => {
    const doc = parse(MINIMAL_KIT_YAML) as { requirements: Record<string, unknown>[] };
    delete doc.requirements[0]!.gate_id;
    const r = safeParseKitSpec(doc);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.errors.join("\n")).toMatch(/correctness gate/);
  });

  it("documents every driver type in the schema", () => {
    expect(Object.keys(DRIVER_DOCS).sort()).toEqual([...DriverTypeSchema.options].sort());
    expect(driverRows().map((d) => d.type)).toEqual([...DriverTypeSchema.options]);
    expect(driverRows()).toHaveLength(9);
  });
});
