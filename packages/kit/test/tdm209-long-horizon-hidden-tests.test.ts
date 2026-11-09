// TDM-209 [18.2]: the hidden-tests gate of kits/tandem-long-horizon. 120 hidden tests over HTTP,
// each tagged with a feature area of areas.json, and a partial-credit grader: grade.mjs writes
// hidden_test_fraction, hidden_tests_passed, hidden_tests_total and area_pass.<area> to
// hidden-tests.metrics.jsonl (TDM-210 consumes the first three by these exact names), while the
// verdict stays pass only at 100%. Run against the 18.1 skeleton, only the /health test passes.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  HIDDEN_TEST_FRACTION_METRIC,
  HIDDEN_TESTS_PASSED_METRIC,
  HIDDEN_TESTS_TOTAL_METRIC,
  isCorrectnessMetric,
} from "@anybench/core";
import { afterAll, describe, expect, it } from "vitest";

const KIT_TDM209 = join(dirname(fileURLToPath(import.meta.url)), "../../../kits/tandem-long-horizon");
const GATE_TDM209 = join(KIT_TDM209, "gates/hidden-tests");
const TESTS_TDM209 = join(GATE_TDM209, "project-tracker");
const WL_TDM209 = join(KIT_TDM209, "workloads/project-tracker");

interface ManifestTdm209 {
  workload: string;
  areas: string[];
  tests: { file: string; name: string; area: string }[];
}
const manifestTdm209 = (): ManifestTdm209 => JSON.parse(readFileSync(join(TESTS_TDM209, "tests.json"), "utf8"));
const areasTdm209 = (): { id: string; tests_target: number }[] =>
  JSON.parse(readFileSync(join(WL_TDM209, "areas.json"), "utf8")).areas;

interface GradeModuleTdm209 {
  summarize(o: { workload: string; areas: string[]; tests: { area: string; status: string }[] }): any;
  hiddenTestsMetrics(summary: any): { metric: string; value: number; unit: string }[];
  hiddenTestsMetricsJsonl(summary: any): string;
  hiddenTestsVerdict(summary: any): { pass: boolean; reason: string };
  manifestOf(workload: string): ManifestTdm209;
}
const gradeTdm209 = async (): Promise<GradeModuleTdm209> =>
  (await import(pathToFileURL(join(GATE_TDM209, "grade.mjs")).href)) as GradeModuleTdm209;

/** The same rule packages/bench parseGateMetrics applies to metric names. */
const GATE_METRIC_NAME_TDM209 = /^[a-z][a-z0-9_.]{0,127}$/;

describe("kits/tandem-long-horizon hidden tests (project-tracker)", () => {
  it("tests.json lists exactly the test() calls of the hidden test files, one file per area", () => {
    const m = manifestTdm209();
    expect(m.workload).toBe("project-tracker");
    const files = readdirSync(TESTS_TDM209).filter((f) => f.endsWith(".test.ts")).sort();
    expect(files).toEqual(m.areas.map((a) => `${a}.test.ts`).sort());
    for (const file of files) {
      const src = readFileSync(join(TESTS_TDM209, file), "utf8");
      const inFile = [...src.matchAll(/^test\("((?:[^"\\]|\\.)*)"/gm)].map((x) => JSON.parse(`"${x[1]}"`) as string);
      expect(new Set(inFile).size, `${file}: duplicate test names`).toBe(inFile.length);
      const listed = m.tests.filter((t) => t.file === file);
      expect(listed.map((t) => t.name), file).toEqual(inFile);
      for (const t of listed) expect(t.area, t.name).toBe(file.replace(/\.test\.ts$/, ""));
    }
  });

  it("hits the areas.json targets: 120 tests, every area at its tests_target, areas in areas.json order", () => {
    const m = manifestTdm209();
    const areas = areasTdm209();
    expect(m.areas).toEqual(areas.map((a) => a.id));
    expect(m.tests).toHaveLength(120);
    for (const a of areas) expect(m.tests.filter((t) => t.area === a.id).length, a.id).toBe(a.tests_target);
  });

  it("carries its own copy of the 1.x fixture, byte-identical to the workspace's", () => {
    expect(readFileSync(join(TESTS_TDM209, "fixtures/tracker-v1.json")).equals(readFileSync(join(WL_TDM209, "input/fixtures/tracker-v1.json")))).toBe(
      true,
    );
  });

  it("the hidden tests live outside the starting repo and only import the app and their helpers", () => {
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
    const input = walk(join(WL_TDM209, "input")).map((f) => relative(join(WL_TDM209, "input"), f));
    for (const f of readdirSync(TESTS_TDM209)) expect(input).not.toContain(join("test", f));
    for (const f of readdirSync(TESTS_TDM209).filter((x) => x.endsWith(".ts"))) {
      const src = readFileSync(join(TESTS_TDM209, f), "utf8");
      for (const imp of src.matchAll(/from "([^"]+)"/g)) expect(imp[1], `${f} imports ${imp[1]}`).toMatch(/^(node:|\.\/helpers\.ts$)/);
    }
    const helpers = readFileSync(join(TESTS_TDM209, "helpers.ts"), "utf8");
    expect(helpers).toContain('import("../src/app.ts")');
    expect(helpers).toContain('join(dirname(fileURLToPath(import.meta.url)), "fixtures", "tracker-v1.json")');
  });
});

describe("kits/tandem-long-horizon grade.mjs partial credit", () => {
  const scored = (passing: Record<string, number>, totals: Record<string, number>) =>
    Object.entries(totals).flatMap(([area, n]) =>
      Array.from({ length: n }, (_, i) => ({ area, status: i < (passing[area] ?? 0) ? "pass" : "fail" })),
    );

  it("writes hidden_test_fraction, hidden_tests_passed, hidden_tests_total, then area_pass.<area> per area", async () => {
    const g = await gradeTdm209();
    const summary = g.summarize({
      workload: "project-tracker",
      areas: ["auth", "teams", "search"],
      tests: scored({ auth: 3, teams: 0, search: 4 }, { auth: 4, teams: 2, search: 4 }),
    });
    const text = g.hiddenTestsMetricsJsonl(summary);
    const rows = text.trimEnd().split("\n").map((l) => JSON.parse(l));
    expect(rows).toEqual([
      { metric: "hidden_test_fraction", value: 0.7, unit: "ratio", source: "gate:hidden-tests" },
      { metric: "hidden_tests_passed", value: 7, unit: "count", source: "gate:hidden-tests" },
      { metric: "hidden_tests_total", value: 10, unit: "count", source: "gate:hidden-tests" },
      { metric: "area_pass.auth", value: 0.75, unit: "ratio", source: "gate:hidden-tests" },
      { metric: "area_pass.teams", value: 0, unit: "ratio", source: "gate:hidden-tests" },
      { metric: "area_pass.search", value: 1, unit: "ratio", source: "gate:hidden-tests" },
    ]);
    // The exact names TDM-210 reads, and names the gate runner accepts.
    expect(rows[0].metric).toBe(HIDDEN_TEST_FRACTION_METRIC);
    expect(isCorrectnessMetric(rows[0].metric)).toBe(true);
    expect(rows[1].metric).toBe(HIDDEN_TESTS_PASSED_METRIC);
    expect(rows[2].metric).toBe(HIDDEN_TESTS_TOTAL_METRIC);
    for (const r of rows) expect(r.metric).toMatch(GATE_METRIC_NAME_TDM209);
    expect(summary.areas).toEqual({ auth: { passed: 3, total: 4 }, teams: { passed: 0, total: 2 }, search: { passed: 4, total: 4 } });
  });

  it("the verdict passes only at 100%; partial credit names the weakest areas", async () => {
    const g = await gradeTdm209();
    const all = g.summarize({ workload: "w", areas: ["a", "b"], tests: scored({ a: 2, b: 2 }, { a: 2, b: 2 }) });
    expect(g.hiddenTestsVerdict(all).pass).toBe(true);
    expect(g.hiddenTestsMetrics(all)[0]!.value).toBe(1);
    const almost = g.summarize({
      workload: "w",
      areas: ["a", "b"],
      tests: scored({ a: 2, b: 1 }, { a: 2, b: 2 }).map((t, i) => ({ ...t, file: "x.test.ts", name: `t${i}` })),
    });
    const v = g.hiddenTestsVerdict(almost);
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/^3\/4 hidden tests passed \(b 1\/2\)/);
    const none = g.summarize({ workload: "w", areas: ["a"], tests: [] });
    expect(g.hiddenTestsVerdict(none).pass).toBe(false);
    expect(g.hiddenTestsMetrics(none)[0]!.value).toBe(0);
  });

  it("the manifest of project-tracker loads, and every area id is metric-name safe", async () => {
    const g = await gradeTdm209();
    const m = g.manifestOf("project-tracker");
    expect(m.tests).toHaveLength(120);
    for (const a of m.areas) expect(`area_pass.${a}`).toMatch(GATE_METRIC_NAME_TDM209);
  });
});

describe("kits/tandem-long-horizon hidden-tests gate against the 18.1 skeleton", () => {
  const root = mkdtempSync(join(tmpdir(), "tdm209-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("scores 0 < x < 0.05 (only GET /health), every listed test reports, and the verdict fails", () => {
    const runDir = join(root, "run");
    const out = join(root, "out");
    const setup = spawnSync(join(WL_TDM209, "setup.sh"), [join(runDir, "workspace")], { encoding: "utf8" });
    expect(setup.status, setup.stderr).toBe(0);
    const r = spawnSync(join(GATE_TDM209, "check.sh"), [out, "project-tracker", join(root, "gate.json")], {
      encoding: "utf8",
      env: { ...process.env, AB_RUN: join(KIT_TDM209, "scripts/ab-run-local.sh"), AB_RUN_DIR: runDir },
      timeout: 240_000,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const gate = JSON.parse(readFileSync(join(root, "gate.json"), "utf8"));
    expect(gate.pass).toBe(false);
    const summary = JSON.parse(readFileSync(join(out, "hidden-tests.json"), "utf8"));
    expect(summary.total).toBe(120);
    const unreported = summary.tests.filter((t: { error?: string }) => /did not report|timed out/.test(t.error ?? ""));
    expect(unreported, "every hidden test reports a result").toEqual([]);
    expect(summary.tests.filter((t: { status: string }) => t.status === "pass").map((t: { name: string }) => t.name)).toEqual([
      "GET /health answers { ok: true } without auth and carries no rate-limit headers",
    ]);
    const metrics = Object.fromEntries(
      readFileSync(join(out, "hidden-tests.metrics.jsonl"), "utf8")
        .trimEnd()
        .split("\n")
        .map((l) => JSON.parse(l))
        .map((m: { metric: string; value: number }) => [m.metric, m.value]),
    );
    expect(metrics[HIDDEN_TEST_FRACTION_METRIC]).toBeGreaterThan(0);
    expect(metrics[HIDDEN_TEST_FRACTION_METRIC]).toBeLessThan(0.05);
    expect(metrics[HIDDEN_TESTS_PASSED_METRIC]).toBe(1);
    expect(metrics[HIDDEN_TESTS_TOTAL_METRIC]).toBe(120);
    expect(metrics["area_pass.ratelimit"]).toBeCloseTo(1 / 7);
    expect(metrics["area_pass.auth"]).toBe(0);
    expect(Object.keys(metrics).filter((k) => k.startsWith("area_pass.")).length).toBe(12);
  }, 300_000);
});
