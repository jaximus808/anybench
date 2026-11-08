// TDM-128 [14.2]: kits/tandem-vs-claude-code validates against KitSpecSchema, every path it
// names exists, and its hidden tests (42) stay outside the starting repos.
// The executable proof (oracle 100%, do-nothing 0%) is kits/tandem-vs-claude-code/scripts/verify-proof.sh.
import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { safeParseKitSpec, type KitSpec } from "@anybench/core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { validateKitDir } from "../src/index.js";

const KIT_DIR_TDM128 = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../kits/tandem-vs-claude-code",
);
const WORKLOADS_TDM128 = ["todo-api", "auth-refactor", "bug-hunt"] as const;

function loadKitTdm128(): KitSpec {
  const r = safeParseKitSpec(parse(readFileSync(join(KIT_DIR_TDM128, "anybench.yaml"), "utf8")));
  if (!r.success) throw new Error(r.errors.join("\n"));
  return r.data;
}

function walkTdm128(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walkTdm128(p) : [p];
  });
}

interface ManifestTdm128 {
  workload: string;
  tests: { file: string; name: string }[];
}
const manifestTdm128 = (w: string): ManifestTdm128 =>
  JSON.parse(readFileSync(join(KIT_DIR_TDM128, "gates/hidden-tests", w, "tests.json"), "utf8"));

describe("kits/tandem-vs-claude-code anybench.yaml", () => {
  it("validates against KitSpecSchema", () => {
    expect(loadKitTdm128().schema_version).toBe(2);
  });

  // TDM-178 [16.7]: the schema accepts the kit, but the setups are not comparable yet (unpinned
  // model, claude-code@latest, ref main, 8M vs 5M token caps, reviewer only for Tandem, A still
  // has the `Agent` tool). TDM-184 [16.13] fixes the kit; then this flips to ok.
  it("fails the comparability rules until TDM-184 [16.13] pins it", async () => {
    const r = await validateKitDir(KIT_DIR_TDM128);
    expect(r.ok).toBe(false);
    expect([...new Set(r.errors.map((e) => e.code))].sort()).toEqual([
      "assist_unequal",
      "caps_unequal",
      "model_unpinned",
      "ref_unpinned",
      "subagents_not_disabled",
      "version_unpinned",
    ]);
    // Every error is a comparability error: the files and the schema are fine.
    expect(r.errors.filter((e) => e.code === "schema" || e.code === "missing_file")).toEqual([]);
  });

  it("declares A solo, B subagents, and Tandem varied to ×3 (C) and ×5 (D)", () => {
    const kit = loadKitTdm128();
    expect(kit.subject.kind).toBe("harness");
    expect(kit.contenders.map((c) => [c.id, c.role, c.driver.type])).toEqual([
      ["claude-code-solo", "baseline", "coding-agent"],
      ["claude-code-subagents", "competitor", "coding-agent"],
      ["tandem", "subject", "harness"],
    ]);
    expect(kit.vary).toEqual({ TANDEM_WORKERS: [3, 5] });
    const tandem = kit.contenders.find((c) => c.id === "tandem")!;
    expect(tandem.driver.env).toHaveProperty("TANDEM_WORKERS");
    // A has subagents disabled; B ships its subagent definitions.
    expect(kit.contenders[0]!.driver.env).toMatchObject({ CC_DISALLOWED_TOOLS: "Task" });
    expect(kit.contenders[1]!.source).toEqual({
      upload: [
        "adapters/claude-code-subagents/CLAUDE.md",
        "adapters/claude-code-subagents/.claude/",
      ],
    });
    expect(kit.human_in_loop).toEqual({ kind: "tandem", policy: "llm-reviewer" });
  });

  it("has the three workloads, gated measured requirements and a reviewed rubric, weights 100", () => {
    const kit = loadKitTdm128();
    expect(kit.workloads.map((w) => w.id)).toEqual([...WORKLOADS_TDM128]);
    const byId = Object.fromEntries(kit.requirements.map((r) => [r.id, r]));
    expect(byId["tests-pass"]).toMatchObject({
      type: "measured",
      metric: "gate_pass_rate",
      gate_id: "hidden-tests",
    });
    expect(byId["api-p95"]).toMatchObject({
      type: "measured",
      metric: "api_p95_ms",
      target: "under 120 ms",
      gate_id: "api-load",
    });
    expect(byId["wall"]).toMatchObject({
      type: "measured",
      metric: "wall_s",
      gate_id: "hidden-tests",
    });
    expect(byId["cost"]).toMatchObject({
      type: "measured",
      metric: "cost_micro_usd",
      gate_id: "hidden-tests",
    });
    expect(byId["quality"]).toMatchObject({
      type: "reviewed",
      rubric: "rubric.md",
      gate_id: "hidden-tests",
      scale: { min: 1, max: 4 },
    });
    expect(kit.scoring.weights).toEqual({
      "tests-pass": 50,
      "api-p95": 10,
      wall: 10,
      cost: 10,
      quality: 20,
    });
    expect(Object.values(kit.scoring.weights).reduce((a, b) => a + b, 0)).toBe(100);
    expect(kit.proof.oracle?.gates).toEqual(["hidden-tests", "api-load"]);
    expect(kit.proof.do_less.map((d) => d.id)).toEqual(["do-nothing"]);
    expect(kit.secrets).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("every path the kit names exists, and every script is executable", () => {
    const kit = loadKitTdm128();
    const paths: string[] = [
      "rubric.md",
      "scripts/verify-proof.sh",
      "scripts/proof-in-container.sh",
      "PROOF.md",
    ];
    for (const c of kit.contenders) {
      if ("upload" in c.source) paths.push(...c.source.upload);
      if (c.install.script) paths.push(c.install.script);
      if (c.install.healthcheck) paths.push(c.install.healthcheck);
      if (c.driver.script) paths.push(c.driver.script);
    }
    for (const w of kit.workloads) paths.push(w.input!, w.instruction!, w.setup!);
    for (const g of kit.gates) paths.push(g.check!, g.reference!);
    for (const r of kit.requirements) if (r.type === "reviewed") paths.push(r.rubric);
    const overlays = [kit.proof.oracle!, ...kit.proof.do_less, kit.proof.regression!];
    for (const o of overlays) {
      paths.push(o.dir);
      if (o.driver_patch) paths.push(o.driver_patch);
    }
    paths.push(kit.proof.regression!.env!.CLAUDE_MD_OVERLAY!);
    for (const p of paths) expect(existsSync(join(KIT_DIR_TDM128, p)), p).toBe(true);

    const scripts = walkTdm128(KIT_DIR_TDM128).filter((f) => f.endsWith(".sh"));
    expect(scripts.length).toBeGreaterThanOrEqual(15);
    for (const s of scripts)
      expect(() => accessSync(s, constants.X_OK), relative(KIT_DIR_TDM128, s)).not.toThrow();
  });
});

describe("kits/tandem-vs-claude-code hidden tests and oracles", () => {
  it("has 42 hidden tests: todo-api 16, auth-refactor 14, bug-hunt 12", () => {
    const counts = WORKLOADS_TDM128.map((w) => manifestTdm128(w).tests.length);
    expect(counts).toEqual([16, 14, 12]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(42);
  });

  it.each(WORKLOADS_TDM128)(
    "%s: tests.json lists exactly the test() calls in the hidden test files",
    (w) => {
      const dir = join(KIT_DIR_TDM128, "gates/hidden-tests", w);
      const found: { file: string; name: string }[] = [];
      for (const f of readdirSync(dir)
        .filter((f) => f.endsWith(".test.ts"))
        .sort()) {
        for (const m of readFileSync(join(dir, f), "utf8").matchAll(
          /^test\("((?:[^"\\]|\\.)*)"/gm,
        )) {
          found.push({ file: f, name: JSON.parse(`"${m[1]!}"`) as string });
        }
      }
      const manifest = manifestTdm128(w);
      expect(manifest.workload).toBe(w);
      expect(manifest.tests).toEqual(found);
      expect(new Set(found.map((t) => `${t.file}::${t.name}`)).size).toBe(found.length);
    },
  );

  it.each(WORKLOADS_TDM128)(
    "%s: hidden tests and the oracle stay outside the starting repo",
    (w) => {
      const input = join(KIT_DIR_TDM128, "workloads", w, "input");
      const inputFiles = walkTdm128(input).map((f) => relative(input, f));
      expect(inputFiles).toContain("package.json");
      expect(inputFiles.some((f) => f.startsWith(".hidden-tests"))).toBe(false);
      const hiddenNames = readdirSync(join(KIT_DIR_TDM128, "gates/hidden-tests", w)).filter((f) =>
        f.endsWith(".test.ts"),
      );
      for (const name of hiddenNames) expect(inputFiles).not.toContain(join("test", name));
      // Nothing the agent sees points at the grader or the solution.
      const visible = [
        join(KIT_DIR_TDM128, "workloads", w, "instruction.md"),
        ...walkTdm128(input),
      ];
      for (const f of visible)
        expect(readFileSync(f, "utf8"), relative(KIT_DIR_TDM128, f)).not.toMatch(
          /hidden-tests|proof\/oracle|gates\//,
        );
      expect(existsSync(join(KIT_DIR_TDM128, "proof/oracle", w))).toBe(true);
    },
  );

  it("bug-hunt documents where its grader came from", () => {
    const prov = readFileSync(join(KIT_DIR_TDM128, "workloads/bug-hunt/PROVENANCE.md"), "utf8");
    expect(prov).toMatch(/reverted/);
    expect(prov).toMatch(/csv-quoting\.test\.ts/);
  });

  it("carries no secret values", () => {
    const secretish =
      /(sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{32,}|ANTHROPIC_API_KEY\s*=\s*\S+|ghp_[A-Za-z0-9]{20,})/;
    for (const f of walkTdm128(KIT_DIR_TDM128)) {
      expect(secretish.test(readFileSync(f, "utf8")), relative(KIT_DIR_TDM128, f)).toBe(false);
    }
  });
});
