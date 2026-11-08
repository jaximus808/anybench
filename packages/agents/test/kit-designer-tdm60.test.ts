// TDM-60 [6.6]: the kit-designer role folder and its input builders.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cliKitDraftJsonSchema } from "@anybench/kit";
import { describe, expect, it } from "vitest";
import {
  buildKitDesignerFixInput,
  buildKitDesignerRepairInput,
  KIT_DESIGNER_ROLE,
  listRoles,
  loadRole,
  roleAgentSpec,
  scrubMeasurements,
} from "../src/index.js";

describe("kit-designer role (TDM-60)", () => {
  it("loads with a strong pinned model, no tools, a bigint per-task cap", () => {
    expect(listRoles()).toContain(KIT_DESIGNER_ROLE);
    const role = loadRole(KIT_DESIGNER_ROLE);
    expect(role.config.model).toBe("anthropic/claude-sonnet-5.5");
    expect(role.config.budget.max_task_micro_usd).toBe(800_000n);
    expect(role.prompt).toContain("{extra_args}");
    const spec = roleAgentSpec(KIT_DESIGNER_ROLE);
    expect(spec.outputSchema).toBeTruthy();
  });

  it("output.schema.json is exactly the draft schema (regenerate it from cliKitDraftJsonSchema)", () => {
    const file = fileURLToPath(new URL("../kit-designer/output.schema.json", import.meta.url));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(cliKitDraftJsonSchema());
  });

  it("fix input carries the draft and the capped issues", () => {
    const m = buildKitDesignerFixInput({ draft: { a: 1 }, issues: Array(30).fill("x") });
    expect(m.mode).toBe("fix");
    expect((m.issues as string[]).length).toBe(20);
  });

  it("repair input scrubs measurements and refuses extra fields", () => {
    expect(
      scrubMeasurements("wall_s=0.123 and 42 ms, median 9.5 s; got 1 line(s), expected 4"),
    ).toBe(
      "[measurement withheld] and [measurement withheld], [measurement withheld]; got 1 line(s), expected 4",
    );
    const m = buildKitDesignerRepairInput({
      previous_spec: { a: 1 },
      previous_draft: null,
      proof: [
        { check: "smoke_passes", pass: false, reason: "peak_rss_bytes: 1234 bytes", evidence: [] },
      ],
    });
    expect(JSON.stringify(m)).not.toContain("1234");
    expect(() =>
      buildKitDesignerRepairInput({
        previous_spec: {},
        previous_draft: null,
        proof: [],
        trials: [],
      } as never),
    ).toThrow();
  });
});
