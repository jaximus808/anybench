// TDM-237 [18.16]: the hidden tests of project-tracker-xl, second half of the areas (the areas.json
// entries with half: 2), next to the first half (TDM-236). With both halves in, this test checks the
// FULL areas.json: every area has its <area>.test.ts, hits its tests_target, and the total is 600.
// The second half's own helpers live in helpers-pipeline.ts (the extension point of helpers.ts).
// Against the skeleton every one of the 600 tests reports and fewer than 1% pass.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HIDDEN_TEST_FRACTION_METRIC, HIDDEN_TESTS_TOTAL_METRIC } from "@anybench/core";
import { afterAll, describe, expect, it } from "vitest";

const KIT_TDM237 = join(dirname(fileURLToPath(import.meta.url)), "../../../kits/tandem-long-horizon");
const GATE_TDM237 = join(KIT_TDM237, "gates/hidden-tests");
const TESTS_TDM237 = join(GATE_TDM237, "project-tracker-xl");
const WL_TDM237 = join(KIT_TDM237, "workloads/project-tracker-xl");

interface ManifestTdm237 {
  workload: string;
  areas: string[];
  tests: { file: string; name: string; area: string }[];
}
interface AreaTdm237 {
  id: string;
  half: 1 | 2;
  tests_target: number;
}
const manifestTdm237 = (): ManifestTdm237 => JSON.parse(readFileSync(join(TESTS_TDM237, "tests.json"), "utf8"));
const areasFileTdm237 = (): { tests_total: number; halves: Record<string, number>; areas: AreaTdm237[] } => JSON.parse(readFileSync(join(WL_TDM237, "areas.json"), "utf8"));
const genTdm237 = async (): Promise<{ buildManifest(workload: string): ManifestTdm237 }> =>
  (await import(pathToFileURL(join(KIT_TDM237, "scripts/gen-hidden-tests-manifest.mjs")).href)) as { buildManifest(workload: string): ManifestTdm237 };

describe("kits/tandem-long-horizon hidden tests (project-tracker-xl, both halves)", () => {
  it("tests.json is the generator's output and lists every area of areas.json, in its order", async () => {
    const m = manifestTdm237();
    expect(m).toEqual((await genTdm237()).buildManifest("project-tracker-xl"));
    expect(m.areas).toEqual(areasFileTdm237().areas.map((a) => a.id));
  });

  it("every area has its <area>.test.ts and hits its tests_target exactly; the halves and the total match areas.json (600)", () => {
    const af = areasFileTdm237();
    const m = manifestTdm237();
    for (const a of af.areas) {
      expect(existsSync(join(TESTS_TDM237, `${a.id}.test.ts`)), `${a.id}.test.ts`).toBe(true);
      const owned = m.tests.filter((t) => t.area === a.id);
      expect(owned.length, a.id).toBe(a.tests_target);
      for (const t of owned) expect(t.file).toBe(`${a.id}.test.ts`);
    }
    const files = readdirSync(TESTS_TDM237).filter((f) => f.endsWith(".test.ts"));
    expect(files.sort()).toEqual(af.areas.map((a) => `${a.id}.test.ts`).sort());
    for (const half of ["1", "2"]) {
      const ids = new Set(af.areas.filter((a) => String(a.half) === half).map((a) => a.id));
      expect(m.tests.filter((t) => ids.has(t.area)).length, `half ${half}`).toBe(af.halves[half]);
    }
    expect(af.halves["2"]).toBe(302);
    expect(m.tests.length).toBe(af.tests_total);
    expect(m.tests.length).toBe(600);
  });

  it("the half-2 test files are flat: top-level test() calls with unique names, nothing skipped or nested", () => {
    for (const a of areasFileTdm237().areas.filter((x) => x.half === 2)) {
      const src = readFileSync(join(TESTS_TDM237, `${a.id}.test.ts`), "utf8");
      const names = [...src.matchAll(/^test\("((?:[^"\\]|\\.)*)"/gm)].map((x) => x[1]);
      expect(new Set(names).size, `${a.id}: duplicate names`).toBe(names.length);
      expect(src.match(/\btest\(/g)?.length ?? 0, `${a.id}: every test() is top level`).toBe(names.length);
      expect(src, a.id).not.toMatch(/\bdescribe\(|\.only\(|\.skip\(|\btodo\(/);
    }
  });

  it("the second half extends helpers.ts through helpers-pipeline.ts, which imports it and starts apps with a long token lifetime", () => {
    const pipeline = readFileSync(join(TESTS_TDM237, "helpers-pipeline.ts"), "utf8");
    expect(pipeline).toMatch(/from "\.\/helpers\.ts"/);
    expect(pipeline).toMatch(/tokenTtlMs: LONG_TTL/);
    for (const f of readdirSync(TESTS_TDM237).filter((x) => x.endsWith(".ts"))) {
      const src = readFileSync(join(TESTS_TDM237, f), "utf8");
      for (const imp of src.matchAll(/from "([^"]+)"/g)) expect(imp[1], `${f} imports ${imp[1]}`).toMatch(/^(node:|\.\/helpers(-[a-z0-9-]+)?\.ts$)/);
    }
    for (const a of areasFileTdm237().areas.filter((x) => x.half === 2)) {
      const src = readFileSync(join(TESTS_TDM237, `${a.id}.test.ts`), "utf8");
      // Half-2 tests move the fake clock by days: they start apps through helpers-pipeline's startApp.
      expect(src, a.id).toMatch(/import \{[^}]*\bstartApp\b[^}]*\} from "\.\/helpers-pipeline\.ts"/);
    }
  });
});

describe("kits/tandem-long-horizon hidden-tests gate against the project-tracker-xl skeleton, all 600 tests", () => {
  const root = mkdtempSync(join(tmpdir(), "tdm237-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("every test of every area reports, the skeleton scores under 1%, and the verdict fails", () => {
    const runDir = join(root, "run");
    const out = join(root, "out");
    const setup = spawnSync(join(WL_TDM237, "setup.sh"), [join(runDir, "workspace")], { encoding: "utf8" });
    expect(setup.status, setup.stderr).toBe(0);
    const r = spawnSync(join(GATE_TDM237, "check.sh"), [out, "project-tracker-xl", join(root, "gate.json")], {
      encoding: "utf8",
      env: { ...process.env, AB_RUN: join(KIT_TDM237, "scripts/ab-run-local.sh"), AB_RUN_DIR: runDir },
      timeout: 400_000,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(root, "gate.json"), "utf8")).pass).toBe(false);
    const summary = JSON.parse(readFileSync(join(out, "hidden-tests.json"), "utf8"));
    expect(summary.total).toBe(600);
    const unreported = summary.tests.filter((t: { error?: string }) => /did not report|timed out/.test(t.error ?? ""));
    expect(unreported, "every hidden test reports a result").toEqual([]);
    const halfTwo = new Set(areasFileTdm237().areas.filter((a) => a.half === 2).map((a) => a.id));
    const owned = summary.tests.filter((t: { area: string }) => halfTwo.has(t.area));
    expect(owned).toHaveLength(302);
    const metrics = Object.fromEntries(
      readFileSync(join(out, "hidden-tests.metrics.jsonl"), "utf8")
        .trimEnd()
        .split("\n")
        .map((l) => JSON.parse(l))
        .map((x: { metric: string; value: number }) => [x.metric, x.value]),
    );
    expect(metrics[HIDDEN_TESTS_TOTAL_METRIC]).toBe(600);
    expect(metrics[HIDDEN_TEST_FRACTION_METRIC]).toBeLessThan(0.01);
    expect(Object.keys(metrics).filter((k) => k.startsWith("area_pass.")).sort()).toEqual(areasFileTdm237().areas.map((a) => `area_pass.${a.id}`).sort());
  }, 450_000);
});
