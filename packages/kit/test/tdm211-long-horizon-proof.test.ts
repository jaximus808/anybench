// TDM-211 [18.4]: the oracle (reference solution) and proof of kits/tandem-long-horizon. The
// reference app in proof/oracle/project-tracker/ is written from instruction.md alone, has no
// dependencies and only erasable TypeScript, and passes all 120 hidden tests through the real gate;
// the do-nothing overlay passes only GET /health. PROOF.md records a real Docker run of
// scripts/verify-proof.sh (node:22, --network none). validateKitDir needs anybench.yaml, which
// TDM-212 [18.5] writes: until it exists that one test skips and says why.
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { validateKitDir } from "../src/index.js";

const KIT_TDM211 = join(dirname(fileURLToPath(import.meta.url)), "../../../kits/tandem-long-horizon");
const TEMPLATE_TDM211 = join(KIT_TDM211, "../tandem-vs-claude-code");
const ORACLE_TDM211 = join(KIT_TDM211, "proof/oracle/project-tracker");
const WL_TDM211 = join(KIT_TDM211, "workloads/project-tracker");
const HAS_KIT_FILE_TDM211 = existsSync(join(KIT_TDM211, "anybench.yaml"));

const walkTdm211 = (d: string): string[] =>
  readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walkTdm211(join(d, n)) : [join(d, n)]));

describe("kits/tandem-long-horizon proof layout", () => {
  it.skipIf(!HAS_KIT_FILE_TDM211)(
    HAS_KIT_FILE_TDM211
      ? "passes validateKitDir with no errors"
      : "passes validateKitDir with no errors (SKIPPED: kits/tandem-long-horizon/anybench.yaml does not exist yet; TDM-212 writes it)",
    async () => {
      const r = await validateKitDir(KIT_TDM211);
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
    },
  );

  it("has the oracle and do-nothing drivers of kits/tandem-vs-claude-code, the planted regression, and the proof scripts", () => {
    for (const p of ["proof/oracle/driver.sh", "proof/do_less/do-nothing/driver.sh", "proof/regression/skip-tests/CLAUDE.md"]) {
      expect(readFileSync(join(KIT_TDM211, p), "utf8"), p).toBe(readFileSync(join(TEMPLATE_TDM211, p), "utf8"));
    }
    for (const p of [
      "proof/oracle/driver.sh",
      "proof/do_less/do-nothing/driver.sh",
      "scripts/verify-proof.sh",
      "scripts/proof-in-container.sh",
    ]) {
      expect(() => accessSync(join(KIT_TDM211, p), constants.X_OK), p).not.toThrow();
    }
    const verify = readFileSync(join(KIT_TDM211, "scripts/verify-proof.sh"), "utf8");
    expect(verify).toContain("--network none");
    expect(verify).toMatch(/trap cleanup EXIT/);
  });

  it("the oracle is zero-dependency, erasable TypeScript that leaves package.json and the 1.x fixture alone", () => {
    const files = walkTdm211(ORACLE_TDM211).map((f) => relative(ORACLE_TDM211, f));
    expect(files).not.toContain("package.json");
    expect(files.some((f) => f.startsWith("fixtures/"))).toBe(false);
    expect(files).toContain("src/app.ts");
    for (const f of files.filter((x) => x.endsWith(".ts"))) {
      const src = readFileSync(join(ORACLE_TDM211, f), "utf8");
      for (const imp of src.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)) {
        expect(imp[1], `${f} imports ${imp[1]}`).toMatch(/^(node:[a-z/_]+|\.\.?\/[\w./-]+\.ts)$/);
      }
      // Type stripping rejects these (instruction.md "erasable TypeScript only").
      expect(src, f).not.toMatch(/^\s*(export\s+)?(const\s+)?enum\s/m);
      expect(src, f).not.toMatch(/^\s*(export\s+)?(namespace|module)\s+\w+\s*\{/m);
      expect(src, f).not.toMatch(/constructor\([^)]*\b(private|public|protected|readonly)\s/);
    }
  });

  it("PROOF.md records a passing Docker run: oracle 120/120 on every run, do-nothing at most 1/120 (GET /health)", () => {
    const all = readFileSync(join(KIT_TDM211, "PROOF.md"), "utf8");
    expect(all).toContain("`docker run --network none`");
    // The project-tracker section (TDM-238 added a project-tracker-xl section after it).
    const proof = all.slice(all.indexOf("### project-tracker\n"), all.indexOf("### project-tracker-xl\n"));
    expect(all).toContain("Overall: RESULT: PASS");
    const oracleRows = [...proof.matchAll(/^\| oracle \| \d+ \| \w+ \| (\d+)\/(\d+) \|/gm)];
    expect(oracleRows.length).toBeGreaterThanOrEqual(1);
    for (const r of oracleRows) expect([r[1], r[2]]).toEqual(["120", "120"]);
    const dn = /^\| do-nothing \| 1 \| \w+ \| (\d+)\/(\d+) \|/m.exec(proof);
    expect(dn).not.toBeNull();
    expect(Number(dn![1])).toBeLessThanOrEqual(1);
    expect(dn![2]).toBe("120");
  });
});

describe("kits/tandem-long-horizon oracle through the hidden-tests gate", () => {
  const root = mkdtempSync(join(tmpdir(), "tdm211-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("passes 120/120 hidden tests, its own npm test passes, and the verdict passes", () => {
    const runDir = join(root, "run");
    const ws = join(runDir, "workspace");
    const out = join(root, "out");
    const setup = spawnSync(join(WL_TDM211, "setup.sh"), [ws], { encoding: "utf8" });
    expect(setup.status, setup.stderr).toBe(0);
    const driver = spawnSync(join(KIT_TDM211, "proof/oracle/driver.sh"), ["run", join(WL_TDM211, "instruction.md"), ws], {
      encoding: "utf8",
      env: { ...process.env, WORKLOAD: "project-tracker" },
    });
    expect(driver.status, driver.stderr).toBe(0);
    const own = spawnSync(process.execPath, ["--test", "test/**/*.test.ts"], { cwd: ws, encoding: "utf8", timeout: 120_000 });
    expect(own.status, own.stdout + own.stderr).toBe(0);
    const r = spawnSync(join(KIT_TDM211, "gates/hidden-tests/check.sh"), [out, "project-tracker", join(root, "gate.json")], {
      encoding: "utf8",
      env: { ...process.env, AB_RUN: join(KIT_TDM211, "scripts/ab-run-local.sh"), AB_RUN_DIR: runDir },
      timeout: 240_000,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const summary = JSON.parse(readFileSync(join(out, "hidden-tests.json"), "utf8"));
    const failing = summary.tests.filter((t: { status: string }) => t.status !== "pass").map((t: { name: string }) => t.name);
    expect(failing).toEqual([]);
    expect([summary.passed, summary.total]).toEqual([120, 120]);
    expect(JSON.parse(readFileSync(join(root, "gate.json"), "utf8")).pass).toBe(true);
  }, 300_000);
});
