// TDM-236 [18.15]: the hidden tests of project-tracker-xl, first half of the areas (the areas.json
// entries with half: 1). They live in kits/tandem-long-horizon/gates/hidden-tests/project-tracker-xl/,
// one <area>.test.ts per area, listed in tests.json (generated from the files by
// scripts/gen-hidden-tests-manifest.mjs, so the second half, TDM-237, extends it by regenerating).
// Graded by the shared grade.mjs; against the skeleton every test reports and fewer than 1% pass.
// This test checks the owned (half 1) areas only; the full area list is TDM-237's to check.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HIDDEN_TEST_FRACTION_METRIC, HIDDEN_TESTS_PASSED_METRIC, HIDDEN_TESTS_TOTAL_METRIC } from "@anybench/core";
import { afterAll, describe, expect, it } from "vitest";

const KIT_TDM236 = join(dirname(fileURLToPath(import.meta.url)), "../../../kits/tandem-long-horizon");
const GATE_TDM236 = join(KIT_TDM236, "gates/hidden-tests");
const TESTS_TDM236 = join(GATE_TDM236, "project-tracker-xl");
const WL_TDM236 = join(KIT_TDM236, "workloads/project-tracker-xl");

interface ManifestTdm236 {
  workload: string;
  areas: string[];
  tests: { file: string; name: string; area: string }[];
}
interface AreaTdm236 {
  id: string;
  half: 1 | 2;
  tests_target: number;
}
const manifestTdm236 = (): ManifestTdm236 => JSON.parse(readFileSync(join(TESTS_TDM236, "tests.json"), "utf8"));
const areasTdm236 = (): AreaTdm236[] => JSON.parse(readFileSync(join(WL_TDM236, "areas.json"), "utf8")).areas;
const halfOneTdm236 = (): AreaTdm236[] => areasTdm236().filter((a) => a.half === 1);

interface GradeModuleTdm236 {
  summarize(o: { workload: string; areas: string[]; tests: { area: string; status: string }[] }): any;
  hiddenTestsMetrics(summary: any): { metric: string; value: number; unit: string }[];
  manifestOf(workload: string): ManifestTdm236;
}
const gradeTdm236 = async (): Promise<GradeModuleTdm236> =>
  (await import(pathToFileURL(join(GATE_TDM236, "grade.mjs")).href)) as GradeModuleTdm236;
const genTdm236 = async (): Promise<{ buildManifest(workload: string): ManifestTdm236 }> =>
  (await import(pathToFileURL(join(KIT_TDM236, "scripts/gen-hidden-tests-manifest.mjs")).href)) as { buildManifest(workload: string): ManifestTdm236 };

const GATE_METRIC_NAME_TDM236 = /^[a-z][a-z0-9_.]{0,127}$/;

describe("kits/tandem-long-horizon hidden tests (project-tracker-xl, half 1)", () => {
  it("tests.json is what the generator makes from the test files: every top-level test(), one file per area", async () => {
    const m = manifestTdm236();
    expect(m.workload).toBe("project-tracker-xl");
    expect(m).toEqual((await genTdm236()).buildManifest("project-tracker-xl"));
    for (const file of readdirSync(TESTS_TDM236).filter((f) => f.endsWith(".test.ts"))) {
      const src = readFileSync(join(TESTS_TDM236, file), "utf8");
      const names = [...src.matchAll(/^test\("((?:[^"\\]|\\.)*)"/gm)].map((x) => JSON.parse(`"${x[1]}"`) as string);
      expect(new Set(names).size, `${file}: duplicate test names`).toBe(names.length);
      expect(m.tests.filter((t) => t.file === file).map((t) => t.name), file).toEqual(names);
      // No test hides inside describe() or an indented test(): each one is a scored manifest entry.
      expect(src.match(/\btest\(/g)?.length ?? 0, `${file}: every test() is top level`).toBe(names.length);
      expect(src, file).not.toMatch(/\bdescribe\(|\.only\(|\.skip\(|\btodo\(/);
    }
  });

  it("hits the areas.json target of every half-1 area, and lists areas in areas.json order", () => {
    const m = manifestTdm236();
    const all = areasTdm236().map((a) => a.id);
    expect(m.areas).toEqual(all.filter((id) => m.areas.includes(id)));
    for (const a of halfOneTdm236()) {
      expect(m.areas, a.id).toContain(a.id);
      expect(m.tests.filter((t) => t.area === a.id).length, a.id).toBe(a.tests_target);
      for (const t of m.tests.filter((x) => x.area === a.id)) expect(t.file).toBe(`${a.id}.test.ts`);
    }
    expect(halfOneTdm236().reduce((n, a) => n + a.tests_target, 0)).toBe(298);
  });

  it("carries its own copy of the 1.x fixture, byte-identical to the workspace's", () => {
    expect(readFileSync(join(TESTS_TDM236, "fixtures/tracker-v1.json")).equals(readFileSync(join(WL_TDM236, "input/fixtures/tracker-v1.json")))).toBe(true);
  });

  it("the tests import only node: modules and the helpers; helpers.ts loads the app lazily and documents the extension point", () => {
    for (const f of readdirSync(TESTS_TDM236).filter((x) => x.endsWith(".ts"))) {
      const src = readFileSync(join(TESTS_TDM236, f), "utf8");
      for (const imp of src.matchAll(/from "([^"]+)"/g)) expect(imp[1], `${f} imports ${imp[1]}`).toMatch(/^(node:|\.\/helpers(-[a-z0-9-]+)?\.ts$)/);
    }
    const helpers = readFileSync(join(TESTS_TDM236, "helpers.ts"), "utf8");
    expect(helpers).toContain('import("../src/app.ts")');
    expect(helpers).toContain('join(dirname(fileURLToPath(import.meta.url)), "fixtures", "tracker-v1.json")');
    expect(helpers).toMatch(/EXTENSION POINT/);
    expect(helpers).toContain("helpers-<concern>.ts");
    // The hidden tests never ship in the starting repo.
    const input = readdirSync(join(WL_TDM236, "input"));
    expect(input).not.toContain(".hidden-tests");
  });

  it("the grader loads the manifest and scores only the areas that have tests", async () => {
    const g = await gradeTdm236();
    const m = g.manifestOf("project-tracker-xl");
    expect(m.tests.length).toBeGreaterThanOrEqual(298);
    for (const a of m.areas) expect(`area_pass.${a}`).toMatch(GATE_METRIC_NAME_TDM236);
    // An area listed before its tests land (a half not written yet) gets no area_pass metric.
    const s = g.summarize({ workload: "w", areas: ["auth", "checklists"], tests: [{ area: "auth", status: "pass" }] });
    expect(s.areas).toEqual({ auth: { passed: 1, total: 1 } });
    expect(g.hiddenTestsMetrics(s).map((r) => r.metric)).toEqual([HIDDEN_TEST_FRACTION_METRIC, HIDDEN_TESTS_PASSED_METRIC, HIDDEN_TESTS_TOTAL_METRIC, "area_pass.auth"]);
  });
});

describe("kits/tandem-long-horizon hidden-tests gate against the project-tracker-xl skeleton", () => {
  const root = mkdtempSync(join(tmpdir(), "tdm236-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("every listed test reports, the skeleton scores under 1%, and the verdict fails", () => {
    const runDir = join(root, "run");
    const out = join(root, "out");
    const setup = spawnSync(join(WL_TDM236, "setup.sh"), [join(runDir, "workspace")], { encoding: "utf8" });
    expect(setup.status, setup.stderr).toBe(0);
    const r = spawnSync(join(GATE_TDM236, "check.sh"), [out, "project-tracker-xl", join(root, "gate.json")], {
      encoding: "utf8",
      env: { ...process.env, AB_RUN: join(KIT_TDM236, "scripts/ab-run-local.sh"), AB_RUN_DIR: runDir },
      timeout: 400_000,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const gate = JSON.parse(readFileSync(join(root, "gate.json"), "utf8"));
    expect(gate.pass).toBe(false);
    const summary = JSON.parse(readFileSync(join(out, "hidden-tests.json"), "utf8"));
    const m = manifestTdm236();
    expect(summary.total).toBe(m.tests.length);
    const halfOne = new Set(halfOneTdm236().map((a) => a.id));
    const owned = summary.tests.filter((t: { area: string }) => halfOne.has(t.area));
    expect(owned).toHaveLength(298);
    const unreported = owned.filter((t: { error?: string }) => /did not report|timed out/.test(t.error ?? ""));
    expect(unreported, "every half-1 hidden test reports a result").toEqual([]);
    const metrics = Object.fromEntries(
      readFileSync(join(out, "hidden-tests.metrics.jsonl"), "utf8")
        .trimEnd()
        .split("\n")
        .map((l) => JSON.parse(l))
        .map((x: { metric: string; value: number }) => [x.metric, x.value]),
    );
    expect(metrics[HIDDEN_TESTS_TOTAL_METRIC]).toBe(m.tests.length);
    expect(metrics[HIDDEN_TEST_FRACTION_METRIC]).toBeLessThan(0.01);
    expect(owned.filter((t: { status: string }) => t.status === "pass").length / owned.length).toBeLessThan(0.01);
    expect(Object.keys(metrics).filter((k) => k.startsWith("area_pass.")).sort()).toEqual(m.areas.map((a) => `area_pass.${a}`).sort());
  }, 450_000);
});
