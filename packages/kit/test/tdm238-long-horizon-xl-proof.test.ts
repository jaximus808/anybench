// TDM-238 [18.17]: the project-tracker-xl oracle and its proof. The reference app in
// proof/oracle/project-tracker-xl/ is zero-dependency erasable TypeScript with its own tests (no
// import of the hidden tests); the partial oracle cuts its webhook routes; PROOF.md records the
// Docker run (oracle 600/600 three times, do-nothing under 1%, the partial oracle failing the gate).
// The full 600-test gate runs only in scripts/verify-proof.sh (Docker), not here.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const KIT_TDM238 = join(dirname(fileURLToPath(import.meta.url)), "../../../kits/tandem-long-horizon");
const ORACLE_TDM238 = join(KIT_TDM238, "proof/oracle/project-tracker-xl");
const WL_TDM238 = join(KIT_TDM238, "workloads/project-tracker-xl");

const walkTdm238 = (d: string): string[] =>
  readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walkTdm238(join(d, n)) : [join(d, n)]));

describe("kits/tandem-long-horizon project-tracker-xl oracle (TDM-238)", () => {
  it("is zero-dependency, erasable TypeScript with its own tests; it leaves package.json and the fixture alone", () => {
    const files = walkTdm238(ORACLE_TDM238).map((f) => relative(ORACLE_TDM238, f));
    expect(files).not.toContain("package.json");
    expect(files.some((f) => f.startsWith("fixtures/"))).toBe(false);
    expect(files).toContain("src/app.ts");
    expect(files.filter((f) => f.startsWith("test/") && f.endsWith(".test.ts")).length).toBeGreaterThanOrEqual(4);
    for (const f of files.filter((x) => x.endsWith(".ts"))) {
      const src = readFileSync(join(ORACLE_TDM238, f), "utf8");
      // Static imports (`import … from "x"`, `import "x"`) and dynamic `import("x")`; not route strings.
      for (const imp of src.matchAll(/^\s*import\b[^;"]*?(?:from\s*)?"([^"]+)"|\bimport\(\s*"([^"]+)"/gm)) {
        const spec = imp[1] ?? imp[2]!;
        expect(spec, `${f} imports ${spec}`).toMatch(/^(node:[a-z/_]+|\.\.?\/[\w./-]+\.ts)$/);
        expect(spec, `${f} imports the hidden tests`).not.toMatch(/hidden/);
      }
      expect(src, f).not.toMatch(/^\s*(export\s+)?(const\s+)?enum\s/m);
      expect(src, f).not.toMatch(/^\s*(export\s+)?(namespace|module)\s+\w+\s*\{/m);
      expect(src, f).not.toMatch(/constructor\([^)]*\b(private|public|protected|readonly)\s/);
    }
    // The skeleton's router and JSON helpers are replaced; no file is a copy of the starting repo's.
    expect(readFileSync(join(ORACLE_TDM238, ".oracle-delete"), "utf8").split("\n").filter(Boolean)).toEqual(["src/http.ts", "src/router.ts"]);
    for (const f of files) {
      let same = false;
      try {
        same = readFileSync(join(WL_TDM238, "input", f)).equals(readFileSync(join(ORACLE_TDM238, f)));
      } catch {
        same = false;
      }
      expect(same, `${f} is identical to the starting repo's`).toBe(false);
    }
  });

  it("instruction.md settles the points the hidden tests leave open, one sentence each", () => {
    const doc = readFileSync(join(WL_TDM238, "instruction.md"), "utf8").replace(/\s+/g, " ");
    for (const sentence of [
      "A header sent with an empty value, or with any other character (a non-ASCII one included), is present, so it answers `400 invalid_header` too.",
      "and keep their `completedAt` whatever that column's category (section 31 sets it when they are restored).",
      "A saved view's `label` values are not sorted: the name is replaced where it stands, a value repeated after its first occurrence is dropped, and a view whose `label` values do not hold the name is left as it is.",
      "the value's own rule runs first (step 7), so a `sprintId` naming a completed sprint answers `400 invalid_body` on such a card too.",
      "except that for `contains` and `not_contains` on a `multiselect` field it is one option (a string equal to one of `options`, not an array)",
      "For `is_set` and `is_not_set` (on `dueDate` too), `value` may be absent or `null`; any other `value` is `400 invalid_body`.",
      "while a `title` value is kept and compared as given, untrimmed.",
      "When the header has an error, the answer lists only the header errors: no data row is checked.",
      "A row whose `number` is `not_found` or `duplicate_row` still has its other cells checked (their errors are reported too), but never gets `field_required`",
      "A created card goes to the end of its column, with `createdBy` = the caller;",
    ]) {
      expect(doc, sentence).toContain(sentence);
    }
  });
});

describe("kits/tandem-long-horizon partial oracle on project-tracker-xl (TDM-238)", () => {
  const root = mkdtempSync(join(tmpdir(), "tdm238-po-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const workspace = (name: string): string => {
    const ws = join(root, name, "workspace");
    const setup = spawnSync(join(WL_TDM238, "setup.sh"), [ws], { encoding: "utf8" });
    expect(setup.status, setup.stderr).toBe(0);
    return ws;
  };

  it("applies the xl oracle with its webhook routes cut out, and exits 2 when the cut does not apply", () => {
    const env = { ...process.env, WORKLOAD: "project-tracker-xl" };
    const ws = workspace("cut");
    const d = spawnSync(join(KIT_TDM238, "proof/do_less/partial-oracle/driver.sh"), ["run", "x", ws], { encoding: "utf8", env });
    expect(d.status, d.stderr).toBe(0);
    const basics = readFileSync(join(ws, "src/r_basics.ts"), "utf8");
    expect(basics).not.toContain('"/teams/:teamId/webhooks"');
    expect(basics).toContain("// ---- 8. webhooks: cut by proof/do_less/partial-oracle");
    expect(basics).toContain('"/teams/:teamId/audit"');
    const kit = join(root, "kit");
    cpSync(KIT_TDM238, kit, { recursive: true });
    const file = join(kit, "proof/oracle/project-tracker-xl/src/r_basics.ts");
    writeFileSync(file, readFileSync(file, "utf8").replace("  // ---- 8. webhooks\n", "  // webhooks\n"));
    const nocut = spawnSync(join(kit, "proof/do_less/partial-oracle/driver.sh"), ["run", "x", workspace("nocut")], { encoding: "utf8", env });
    expect(nocut.status).toBe(2);
    expect(nocut.stderr).toMatch(/markers are not in .* exactly once/);
  }, 60_000);
});

describe("kits/tandem-long-horizon PROOF.md on project-tracker-xl (TDM-238)", () => {
  const all = readFileSync(join(KIT_TDM238, "PROOF.md"), "utf8");
  const xl = all.slice(all.indexOf("### project-tracker-xl\n"), all.indexOf("Overall:"));

  it("records the oracle at 600/600 on 3 runs, do-nothing under 1%, the partial oracle failing with at least 480", () => {
    expect(all).toContain("`docker run --network none`");
    expect(all).toContain("Overall: RESULT: PASS");
    const oracle = [...xl.matchAll(/^\| oracle \| \d+ \| \w+ \| (\d+)\/(\d+) \| \d+ \| (true|false) \|/gm)];
    expect(oracle.length).toBe(3);
    for (const r of oracle) expect([r[1], r[2], r[3]]).toEqual(["600", "600", "true"]);
    const dn = /^\| do-nothing \| 1 \| \w+ \| (\d+)\/(\d+) \| \d+ \| (true|false) \|/m.exec(xl);
    expect(dn).not.toBeNull();
    expect(Number(dn![1]) * 100).toBeLessThan(600);
    expect([dn![2], dn![3]]).toEqual(["600", "false"]);
    const po = /^\| partial-oracle \| 1 \| \w+ \| (\d+)\/(\d+) \| \d+ \| (true|false) \|/m.exec(xl);
    expect(po).not.toBeNull();
    expect(Number(po![1])).toBeGreaterThanOrEqual(480);
    expect(Number(po![1])).toBeLessThan(600);
    expect([po![2], po![3]]).toEqual(["600", "false"]);
    expect(all).toMatch(/^Totals: oracle 120\/120, 120\/120, 120\/120 hidden tests passed \(3 runs\), 600\/600, 600\/600, 600\/600 on project-tracker-xl \(3 runs\); do-nothing \d\/120 passed, \d\/600 on project-tracker-xl; partial-oracle \d+\/120 passed, gate failed, \d+\/600 on project-tracker-xl, gate failed\.$/m);
  });
});
