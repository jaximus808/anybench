// TDM-233 [18.12]: the long-horizon kit's partial oracle (proof.do_less 'partial-oracle'): the
// reference solution with feature area 8 (webhooks) cut out of src/app.ts. Through the real
// hidden-tests gate it must fail, with every webhooks test failing and the rest of the app still
// passing (a near miss, which the no-op alone never showed). PROOF.md records the Docker run.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const KIT_TDM233 = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../kits/tandem-long-horizon",
);
const WL_TDM233 = join(KIT_TDM233, "workloads/project-tracker");
const DRIVER_TDM233 = "proof/do_less/partial-oracle/driver.sh";

describe("kits/tandem-long-horizon partial oracle (TDM-233)", () => {
  const root = mkdtempSync(join(tmpdir(), "tdm233-po-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const workspace = (name: string): string => {
    const ws = join(root, name, "run", "workspace");
    const setup = spawnSync(join(WL_TDM233, "setup.sh"), [ws], { encoding: "utf8" });
    expect(setup.status, setup.stderr).toBe(0);
    return ws;
  };

  it("fails the hidden-tests gate: every webhooks test fails, at least 100 of 120 still pass", () => {
    const ws = workspace("gate");
    const d = spawnSync(
      join(KIT_TDM233, DRIVER_TDM233),
      ["run", join(WL_TDM233, "instruction.md"), ws],
      {
        encoding: "utf8",
        env: { ...process.env, WORKLOAD: "project-tracker" },
      },
    );
    expect(d.status, d.stderr).toBe(0);
    expect(readFileSync(join(ws, "src/app.ts"), "utf8")).not.toContain('"/teams/:teamId/webhooks"');
    const out = join(root, "gate", "out");
    const r = spawnSync(
      join(KIT_TDM233, "gates/hidden-tests/check.sh"),
      [out, "project-tracker", join(root, "gate", "gate.json")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          AB_RUN: join(KIT_TDM233, "scripts/ab-run-local.sh"),
          AB_RUN_DIR: join(root, "gate", "run"),
        },
        timeout: 240_000,
      },
    );
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(root, "gate", "gate.json"), "utf8")).pass).toBe(false);
    const summary = JSON.parse(readFileSync(join(out, "hidden-tests.json"), "utf8"));
    const areas = JSON.parse(
      readFileSync(join(KIT_TDM233, "gates/hidden-tests/project-tracker/tests.json"), "utf8"),
    );
    const areaOf = new Map<string, string>(
      areas.tests.map((t: { name: string; area: string }) => [t.name, t.area]),
    );
    const passed = summary.tests.filter((t: { status: string }) => t.status === "pass");
    expect(summary.total).toBe(120);
    expect(passed.length).toBeGreaterThanOrEqual(100);
    expect(passed.length).toBeLessThan(120);
    expect(passed.filter((t: { name: string }) => areaOf.get(t.name) === "webhooks")).toEqual([]);
  }, 300_000);

  it("exits 2 instead of becoming the full oracle when the cut does not apply; refuses an unknown workload", () => {
    const kit = join(root, "kit");
    cpSync(KIT_TDM233, kit, { recursive: true });
    const app = join(kit, "proof/oracle/project-tracker/src/app.ts");
    writeFileSync(
      app,
      readFileSync(app, "utf8").replace("  // ---- 8. webhooks\n", "  // webhooks\n"),
    );
    const ws = workspace("nocut");
    const env = { ...process.env, WORKLOAD: "project-tracker" };
    expect(
      spawnSync(join(kit, DRIVER_TDM233), ["run", "x", ws], { encoding: "utf8", env }).status,
    ).toBe(2);
    const other = spawnSync(join(KIT_TDM233, DRIVER_TDM233), ["run", "x", ws], {
      encoding: "utf8",
      env: { ...process.env, WORKLOAD: "todo-api" },
    });
    expect(other.status).toBe(2);
    expect(other.stderr).toMatch(/no partial oracle for workload 'todo-api'/);
  }, 60_000);

  it("PROOF.md records it: the partial oracle fails the gate with at least 100/120 passing", () => {
    const proof = readFileSync(join(KIT_TDM233, "PROOF.md"), "utf8");
    const row = /^\| partial-oracle \| 1 \| \w+ \| (\d+)\/(\d+) \| \d+ \| (true|false) \|/m.exec(
      proof,
    );
    expect(row).not.toBeNull();
    expect(Number(row![1])).toBeGreaterThanOrEqual(100);
    expect(Number(row![1])).toBeLessThan(120);
    expect([row![2], row![3]]).toEqual(["120", "false"]);
    expect(proof).toContain("Overall: RESULT: PASS");
    expect(proof).toMatch(/^Totals: .*; partial-oracle \d+\/120 passed, gate failed\.$/m);
  });
});
