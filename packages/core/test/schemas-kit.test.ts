// TDM-7: KitSpec v2 schema, the correctness-gate rule, and path-based errors.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DRIVER_DEFAULT_COLLECTORS,
  DRIVER_DEFAULT_PROFILE,
  DriverTypeSchema,
  GateResultSchema,
  KitSpecSchema,
  RequirementSchema,
  formatIssuePath,
  safeParseKitSpec,
  type KitSpec,
} from "../src/index.js";

const KIT_FIXTURES = [
  "kit-agent",
  "kit-harness-tandem",
  "kit-software-cli",
  "kit-terminal-pty",
] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadKitFixtureTdm7(name: (typeof KIT_FIXTURES)[number]): any {
  const url = new URL(`./fixtures/kits/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}

function errorsFor(input: unknown): string[] {
  const r = safeParseKitSpec(input);
  if (r.success) throw new Error("expected the kit to fail validation");
  return r.errors;
}

describe("KitSpec v2 fixtures", () => {
  it.each(KIT_FIXTURES)("%s validates", (name) => {
    const r = safeParseKitSpec(loadKitFixtureTdm7(name));
    if (!r.success) throw new Error(r.errors.join("\n"));
    expect(r.data.schema_version).toBe(2);
  });

  it("covers the agent, harness, CLI and pty driver classes", () => {
    const types = KIT_FIXTURES.flatMap((n) =>
      KitSpecSchema.parse(loadKitFixtureTdm7(n)).contenders.map((c) => c.driver.type),
    );
    expect(new Set(types)).toEqual(new Set(["coding-agent", "harness", "cli", "pty"]));
  });

  it("applies defaults", () => {
    const kit: KitSpec = KitSpecSchema.parse(loadKitFixtureTdm7("kit-software-cli"));
    expect(kit.vary).toEqual({});
    expect(kit.secrets).toEqual([]);
    expect(kit.transfer).toEqual({ max_mb: 512 });
    expect(kit.contenders[0]?.install).toEqual({});
    expect(kit.env?.network).toEqual({ allow: [] });
    const tandem = KitSpecSchema.parse(loadKitFixtureTdm7("kit-harness-tandem"));
    const quality = tandem.requirements.find((r) => r.id === "quality");
    expect(quality).toMatchObject({
      type: "reviewed",
      rubric: "rubric.md",
      scale: { min: 1, max: 4 },
    });
    const pty = KitSpecSchema.parse(loadKitFixtureTdm7("kit-terminal-pty"));
    const kitty = pty.contenders[1]?.driver;
    expect(kitty?.type === "pty" && kitty.screen_dump).toBe("native");
  });
});

describe("the correctness-gate rule", () => {
  it("rejects a measured requirement without gate_id, at its path", () => {
    const kit = loadKitFixtureTdm7("kit-agent");
    delete kit.requirements[1].gate_id;
    const errors = errorsFor(kit);
    expect(errors).toContain(
      "requirements[1].gate_id: measured requirement must name a gate_id: no speed or quality number without a correctness gate",
    );
  });

  it("rejects a gate_id that names no gate", () => {
    const kit = loadKitFixtureTdm7("kit-software-cli");
    kit.requirements[0].gate_id = "nope";
    expect(errorsFor(kit)).toContain(
      "requirements[0].gate_id: gate 'nope' is not defined in gates[]",
    );
  });

  it("rejects a measured gate with no proof.oracle", () => {
    const kit = loadKitFixtureTdm7("kit-terminal-pty");
    delete kit.proof.oracle;
    const errors = errorsFor(kit);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(
      /^proof\.oracle: measured gate 'reference-grid' \(used by requirements\[0\]\) has no oracle/,
    );
  });

  it("rejects a kit with no proof at all when a requirement is measured", () => {
    const kit = loadKitFixtureTdm7("kit-software-cli");
    delete kit.proof;
    expect(errorsFor(kit)[0]).toMatch(/^proof\.oracle: measured gate 'same-matches'/);
  });

  it("rejects an oracle that does not cover a measured gate", () => {
    const kit = loadKitFixtureTdm7("kit-harness-tandem");
    kit.gates.push({ id: "api-latency", kind: "response-diff" });
    kit.requirements[1].gate_id = "api-latency";
    expect(errorsFor(kit)).toContain(
      "proof.oracle.gates: measured gate 'api-latency' (used by requirements[1]) is not covered by proof.oracle.gates",
    );
  });

  it("does not demand an oracle when every requirement is reviewed", () => {
    const kit = loadKitFixtureTdm7("kit-agent");
    kit.requirements = [kit.requirements[3]];
    kit.scoring.weights = { quality: 100 };
    delete kit.proof;
    expect(safeParseKitSpec(kit).success).toBe(true);
  });

  it("a measured requirement parses on its own only with gate_id", () => {
    const base = { id: "wall", type: "measured", title: "Wall", metric: "wall_s", better: "lower" };
    expect(RequirementSchema.safeParse(base).success).toBe(false);
    expect(RequirementSchema.safeParse({ ...base, gate_id: "g" }).success).toBe(true);
  });
});

describe("other kit rules", () => {
  it("requires weights for every requirement, summing to 100", () => {
    const kit = loadKitFixtureTdm7("kit-agent");
    kit.scoring.weights = { "tests-pass": 50, wall: 15, cost: 15, ghost: 10 };
    const errors = errorsFor(kit);
    expect(errors).toContain(
      "scoring.weights.ghost: requirement 'ghost' is not defined in requirements[]",
    );
    expect(errors).toContain("scoring.weights: requirements[3] 'quality' has no weight");
    expect(errors).toContain("scoring.weights: weights must sum to 100, got 90");
  });

  it("rejects non-integer weights", () => {
    const kit = loadKitFixtureTdm7("kit-software-cli");
    kit.scoring.weights = { wall: 69.5, rss: 30.5 };
    expect(errorsFor(kit).some((e) => e.startsWith("scoring.weights.wall:"))).toBe(true);
  });

  it("requires human_in_loop for a harness driver", () => {
    const kit = loadKitFixtureTdm7("kit-harness-tandem");
    delete kit.human_in_loop;
    expect(errorsFor(kit)).toContain(
      "contenders[0].driver.type: contender 'tandem' uses a harness driver, which needs human_in_loop {kind, policy}",
    );
  });

  it("only accepts secret names, never values", () => {
    const kit = loadKitFixtureTdm7("kit-agent");
    kit.secrets = ["sk-ant-api03-abcdef"];
    expect(errorsFor(kit)[0]).toMatch(
      /^secrets\[0\]: must be an UPPER_SNAKE_CASE environment variable name/,
    );
  });

  it("rejects duplicate ids and unknown contender references", () => {
    const kit = loadKitFixtureTdm7("kit-terminal-pty");
    kit.workloads[1].id = "cat-150mb";
    kit.proof.regression.contender = "alacritty";
    const errors = errorsFor(kit);
    expect(errors).toContain("workloads[1].id: id 'cat-150mb' is already used by workloads[0]");
    expect(errors).toContain(
      "proof.regression.contender: contender 'alacritty' is not defined in contenders[]",
    );
  });

  it("rejects unknown keys and unknown driver types", () => {
    const kit = loadKitFixtureTdm7("kit-software-cli");
    kit.contenders[0].driver.gateid = "x";
    kit.contenders[1].driver.type = "gui";
    const errors = errorsFor(kit);
    expect(errors.some((e) => e.startsWith("contenders[0].driver"))).toBe(true);
    expect(errors.some((e) => e.startsWith("contenders[1].driver.type"))).toBe(true);
  });

  it("requires a subject and pty geometry", () => {
    const kit = loadKitFixtureTdm7("kit-terminal-pty");
    kit.contenders[0].role = "baseline";
    delete kit.contenders[1].driver.rows;
    // Field errors come first; cross-field rules run once every field is well-formed.
    expect(errorsFor(kit)).toEqual([
      "contenders[1].driver.rows: Invalid input: expected number, received undefined",
    ]);
    kit.contenders[1].driver.rows = 50;
    expect(errorsFor(kit)).toEqual(["contenders: at least one contender must have role 'subject'"]);
  });

  it("rejects kit paths that escape the kit", () => {
    const kit = loadKitFixtureTdm7("kit-agent");
    kit.workloads[0].instruction = "../../etc/passwd";
    kit.collect = ["/home/naive/.anybench/env"];
    const errors = errorsFor(kit);
    expect(errors.some((e) => e.startsWith("workloads[0].instruction:"))).toBe(true);
    expect(errors.some((e) => e.startsWith("collect[0]:"))).toBe(true);
  });

  it("rejects a wrong schema_version", () => {
    const kit = loadKitFixtureTdm7("kit-agent");
    kit.schema_version = 1;
    expect(errorsFor(kit)).toContain("schema_version: schema_version must be 2");
  });
});

describe("driver tables and helpers", () => {
  it("maps every driver type to a profile and collectors", () => {
    for (const t of DriverTypeSchema.options) {
      expect(DRIVER_DEFAULT_PROFILE[t]).toBeTypeOf("string");
      expect(DRIVER_DEFAULT_COLLECTORS[t]).toContain("machine");
    }
    expect(DRIVER_DEFAULT_PROFILE.pty).toBe("tui");
    expect(DRIVER_DEFAULT_PROFILE.harness).toBe("agent-cc");
  });

  it("formats issue paths", () => {
    expect(formatIssuePath([])).toBe("(root)");
    expect(formatIssuePath(["requirements", 2, "gate_id"])).toBe("requirements[2].gate_id");
    expect(formatIssuePath(["scoring", "weights", "tests-pass"])).toBe(
      'scoring.weights["tests-pass"]',
    );
  });

  it("validates gate.json", () => {
    expect(
      GateResultSchema.parse({ pass: true, reason: "42/42", evidence: ["out/tests.xml"] }),
    ).toEqual({ pass: true, reason: "42/42", evidence: ["out/tests.xml"] });
    expect(GateResultSchema.safeParse({ pass: "yes", reason: "" }).success).toBe(false);
  });
});
