// TDM-174 [16.3]: GateResult.applicable, per-workload requirement scope, measured aggregates and
// unit-aware targets in KitSpec.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  GateResultSchema,
  KitSpecSchema,
  RequirementSchema,
  convertUnit,
  parseRequirementTarget,
  safeParseKitSpec,
} from "../src/index.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function harnessKitTdm174(): any {
  const url = new URL("./fixtures/kits/kit-harness-tandem.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}

function errorsTdm174(input: unknown): string[] {
  const r = safeParseKitSpec(input);
  if (r.success) throw new Error("expected the kit to fail validation");
  return r.errors;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function req(kit: any, id: string): any {
  return kit.requirements.find((r: { id: string }) => r.id === id);
}

describe("GateResult.applicable", () => {
  it("is optional and boolean", () => {
    expect(GateResultSchema.parse({ pass: true, reason: "ok", evidence: [] })).toEqual({
      pass: true,
      reason: "ok",
      evidence: [],
    });
    expect(
      GateResultSchema.parse({ pass: false, reason: "n/a", evidence: [], applicable: false }),
    ).toMatchObject({ applicable: false });
    expect(
      GateResultSchema.safeParse({ pass: false, reason: "", evidence: [], applicable: "no" })
        .success,
    ).toBe(false);
  });
});

describe("requirement scope and aggregates", () => {
  it("accepts workloads, aggregate and cap on a measured requirement", () => {
    const r = RequirementSchema.parse({
      id: "wall",
      type: "measured",
      title: "t",
      metric: "wall_s",
      unit: "s",
      better: "lower",
      gate_id: "g",
      workloads: ["todo-api"],
      aggregate: "censored",
      cap: 600,
    });
    expect(r).toMatchObject({ workloads: ["todo-api"], aggregate: "censored", cap: 600 });
    for (const bad of [{ workloads: [] }, { aggregate: "mean" }, { cap: 0 }]) {
      expect(
        RequirementSchema.safeParse({
          id: "x",
          type: "measured",
          title: "t",
          metric: "m",
          better: "lower",
          gate_id: "g",
          ...bad,
        }).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });

  it("the fixture kit with a scoped, censored requirement validates", () => {
    const kit = harnessKitTdm174();
    req(kit, "wall").aggregate = "censored"; // contenders all have wall_clock_cap_s
    req(kit, "cost").aggregate = "per_solved";
    req(kit, "conflicts").workloads = ["todo-api", "bug-hunt"];
    req(kit, "quality").workloads = ["todo-api"];
    const parsed = KitSpecSchema.parse(kit);
    expect(parsed.requirements.find((r) => r.id === "conflicts")!.workloads).toEqual([
      "todo-api",
      "bug-hunt",
    ]);
  });

  it("scoped workloads must exist, once each", () => {
    const kit = harnessKitTdm174();
    req(kit, "conflicts").workloads = ["todo-api", "nope", "todo-api"];
    expect(errorsTdm174(kit)).toEqual([
      "requirements[3].workloads[1]: workload 'nope' is not defined in workloads[]",
      "requirements[3].workloads[2]: workload 'todo-api' is listed twice",
    ]);
  });

  it("gate_pass_rate takes no aggregate or cap; cap goes only with censored", () => {
    const kit = harnessKitTdm174();
    req(kit, "tests-pass").metric = "gate_pass_rate";
    req(kit, "tests-pass").aggregate = "median";
    req(kit, "tests-pass").cap = 1;
    req(kit, "cost").aggregate = "per_solved";
    req(kit, "cost").cap = 5;
    expect(errorsTdm174(kit)).toEqual([
      "requirements[0].aggregate: gate_pass_rate is always a rate: drop aggregate",
      "requirements[0].cap: gate_pass_rate has no cap",
      "requirements[2].cap: cap only applies to aggregate 'censored'",
    ]);
  });

  it("censored needs a cap it can find", () => {
    const kit = harnessKitTdm174();
    delete kit.contenders[1].driver.wall_clock_cap_s;
    req(kit, "wall").aggregate = "censored";
    req(kit, "conflicts").aggregate = "censored";
    expect(errorsTdm174(kit)).toEqual([
      "requirements[1].cap: aggregate 'censored' counts failed trials at the cap: set cap, every workload's timeout_s, or every contender's wall_clock_cap_s",
      // `merge_conflicts` has no unit and its name implies none: a time cap can't apply.
      "requirements[3].cap: aggregate 'censored' on a metric in 'no unit' needs an explicit cap in that unit",
    ]);
    req(kit, "wall").cap = 3600;
    req(kit, "conflicts").unit = "count";
    expect(errorsTdm174(kit)).toEqual([
      "requirements[3].cap: aggregate 'censored' on a metric in 'count' needs an explicit cap in that unit",
    ]);
    // Workload timeouts are enough on their own.
    delete req(kit, "wall").cap;
    for (const w of kit.workloads) w.timeout_s = 1800;
    req(kit, "conflicts").cap = 20;
    expect(safeParseKitSpec(kit).success).toBe(true);
  });

  it("agent and harness kits refuse wall_s without a findable cap, or as a median", () => {
    const kit = harnessKitTdm174(); // no aggregate on `wall`: the scorer would pick censored
    expect(safeParseKitSpec(kit).success).toBe(true);
    delete kit.contenders[1].driver.wall_clock_cap_s;
    expect(errorsTdm174(kit)).toEqual([
      "requirements[1].cap: wall_s in agent and harness kits counts failed trials at the cap: set cap, every workload's timeout_s, or every contender's wall_clock_cap_s",
    ]);
    req(kit, "wall").aggregate = "median";
    expect(errorsTdm174(kit)).toEqual([
      "requirements[1].aggregate: harness kits score wall_s as time-to-solve: a median over solved trials only hides failures; use 'censored'",
    ]);
    // Software kits may still take the median of passing runs.
    const cli = JSON.parse(
      readFileSync(new URL("./fixtures/kits/kit-software-cli.json", import.meta.url), "utf8"),
    );
    expect(safeParseKitSpec(cli).success).toBe(true);
  });
});

describe("unit-aware targets", () => {
  const bound = (target: string, unit?: string, metric?: string) => {
    const r = parseRequirementTarget(target, unit, metric);
    if (!r.ok) throw new Error(r.error);
    return r.bound;
  };
  const error = (target: string, unit?: string, metric?: string) => {
    const r = parseRequirementTarget(target, unit, metric);
    if (r.ok) throw new Error(`expected '${target}' on ${unit ?? metric} to be rejected`);
    return r.error;
  };

  it("parses bounds and converts within a dimension", () => {
    expect(bound("under 120 ms", "ms")).toEqual({ op: "le", value: 120 });
    expect(bound("under 120 ms", "s")).toEqual({ op: "le", value: 0.12 });
    expect(bound("under 2 min", "s")).toEqual({ op: "le", value: 120 });
    expect(bound("at least 90%", "ratio")).toEqual({ op: "ge", value: 0.9 });
    expect(bound("at least 1.0 (every trial passes)", "ratio")).toEqual({ op: "ge", value: 1 });
    expect(bound("under $5 per task", "micro-USD")).toEqual({ op: "le", value: 5_000_000 });
    expect(bound("under 2 GiB", "bytes")).toEqual({ op: "le", value: 2 * 1024 ** 3 });
    expect(bound("≤ 30", "s")).toEqual({ op: "le", value: 30 });
    expect(bound("at least 0.9 of trials", "ratio")).toEqual({ op: "ge", value: 0.9 });
    expect(bound("at least 100 requests", "Requests")).toEqual({ op: "ge", value: 100 });
    expect(bound("under 120")).toEqual({ op: "le", value: 120 });
    expect(bound("lower is better", "s")).toBeUndefined();
    expect(bound("all pass")).toBeUndefined();
    expect(parseRequirementTarget(undefined, "s")).toEqual({ ok: true, bound: undefined });
    expect(convertUnit(1, "MB", "KB")).toBe(1000);
    expect(convertUnit(1, "s", "bytes")).toBeUndefined();
  });

  it("reads thousands separators, and rejects ambiguous numbers", () => {
    expect(bound("under 1,000 ms", "ms")).toEqual({ op: "le", value: 1000 });
    expect(bound("under 1,000,000 bytes", "bytes")).toEqual({ op: "le", value: 1e6 });
    expect(bound("under 1,000.5 ms", "ms")).toEqual({ op: "le", value: 1000.5 });
    for (const t of ["under 1,5 s", "under 1,0000 ms", "under 1.5.3 s"]) {
      expect(error(t, "s")).toMatch(/ambiguous number/);
    }
  });

  it("gate_pass_rate targets are always ratios", () => {
    const rate = "gate_pass_rate";
    expect(bound("at least 90%", undefined, rate)).toEqual({ op: "ge", value: 0.9 });
    expect(bound("at least 90 %", "ratio", rate)).toEqual({ op: "ge", value: 0.9 });
    expect(bound("at least 0.9", undefined, rate)).toEqual({ op: "ge", value: 0.9 });
    expect(bound("at least 1.0 (all)", "ratio", rate)).toEqual({ op: "ge", value: 1 });
    expect(error("at least 90", undefined, rate)).toMatch(/pass rate is in \[0, 1\]/);
    expect(error("at least 0.9", "s", rate)).toMatch(/unit must be ratio/);
    expect(error("at least 3 s", undefined, rate)).toMatch(/does not convert/);
  });

  it("a requirement without a unit takes the metric's, or rejects a unit it can't check", () => {
    expect(bound("under 2 min", undefined, "wall_s")).toEqual({ op: "le", value: 120 });
    expect(bound("under 0.5 s", undefined, "p95_ms")).toEqual({ op: "le", value: 500 });
    expect(bound("under $2", undefined, "cost_micro_usd")).toEqual({ op: "le", value: 2e6 });
    expect(error("under 2 min", undefined, "merge_conflicts")).toMatch(/has no unit/);
    expect(error("under 2 min")).toMatch(/has no unit/);
    // A declared unit must agree with the one the metric's name implies.
    expect(error("under 2", "ms", "wall_s")).toMatch(
      /metric 'wall_s' is in 's', but unit says 'ms'/,
    );
    // `bytes_per_s` is a rate, not seconds.
    expect(bound("at least 5 MB", "MB", "bytes_per_s")).toEqual({ op: "ge", value: 5 });
  });

  it("data units are case-sensitive: Mb is not MB", () => {
    expect(bound("under 2 MB", "bytes")).toEqual({ op: "le", value: 2e6 });
    expect(error("under 2 Mb", "bytes")).toMatch(/does not convert/);
    expect(error("under 2 mB", "bytes")).toMatch(/does not convert/);
  });

  it("rejects a bound in a unit that does not match", () => {
    for (const [target, unit] of [
      ["under 120 ms", "bytes"],
      ["under 5 tasks", "ms"],
      ["under $5", "s"],
      ["at least 90%", "count"],
    ] as const) {
      expect(parseRequirementTarget(target, unit).ok, `${target} on ${unit}`).toBe(false);
    }
  });

  it("KitSpecSchema refuses a kit whose target unit does not match", () => {
    const kit = harnessKitTdm174();
    req(kit, "wall").target = "under 300 MB";
    expect(errorsTdm174(kit)).toEqual([
      "requirements[1].target: target 'under 300 MB' is in 'MB', which does not convert to the requirement's unit 's'",
    ]);
    req(kit, "wall").target = "under 30 min";
    expect(safeParseKitSpec(kit).success).toBe(true);
    req(kit, "cost").target = "under 1,5 USD";
    expect(errorsTdm174(kit)[0]).toMatch(/^requirements\[2\]\.target: .*ambiguous number/);
  });
});
