// TDM-215 [18.8]: the skeptic's horizon_mismatch check. A kit whose subject coordinates agents and
// whose every workload is short measures the harness's overhead and never its point.
//
// It must never fire on kits/tandem-long-horizon (3 h whole-app workload, subject.horizon long);
// a copy of kits/tandem-vs-claude-code with one long workload checks the rule on its own.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { decideSkepticVerdict, isCoordinationKit, runSkepticChecks } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const TANDEM_KIT = path.join(here, "..", "..", "..", "kits", "tandem-vs-claude-code");
const LONG_KIT = path.join(here, "..", "..", "..", "kits", "tandem-long-horizon");
const EXAMPLES = path.join(here, "..", "examples");
const tmpRoots: string[] = [];

afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

/** A copy of a kit in a temp dir with its anybench.yaml edited. */
function kitCopyTdm215(src: string, edit: (yaml: string) => string): string {
  const root = mkdtempSync(path.join(tmpdir(), "tdm215-horizon-"));
  tmpRoots.push(root);
  const dir = path.join(root, path.basename(src));
  cpSync(src, dir, { recursive: true });
  const file = path.join(dir, "anybench.yaml");
  const before = readFileSync(file, "utf8");
  const after = edit(before);
  if (after === before) throw new Error("fixture edit did not apply");
  writeFileSync(file, after);
  return dir;
}

/** todo-api becomes a 3 h whole-app workload (wall caps raised to match, as the long kit does). */
const withLongWorkloadTdm215 = (y: string): string =>
  y
    .replace(/wall_clock_cap_s: 3600/g, "wall_clock_cap_s: 10800")
    .replace(
      /(- id: todo-api\n(?:.*\n)*?\s+timeout_s: )3600/,
      (_m, head: string) => `${head}10800`,
    );

const horizon = <F extends { check: string }>(fs: readonly F[]): F[] =>
  fs.filter((f) => f.check === "horizon_mismatch");

describe("skeptic horizon_mismatch (TDM-215)", () => {
  it("fires on kits/tandem-vs-claude-code: a coordination harness on three short tasks", async () => {
    const r = await runSkepticChecks(TANDEM_KIT);
    expect(isCoordinationKit(r.material!.spec)).toBe(true);
    const f = horizon(r.findings);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "warn", check: "horizon_mismatch", source: "code" });
    expect(f[0]!.evidence).toMatch(/^anybench\.yaml:\d+$/);
    expect(f[0]!.why).toMatch(/none of its 3 workload\(s\) has a wall cap of at least 7200 s/);
    expect(f[0]!.why).toMatch(/"on short tasks"/);
  });

  it("does not fire on kits/tandem-long-horizon, which records horizon long and runs a 3 h workload", async () => {
    const r = await runSkepticChecks(LONG_KIT);
    const spec = r.material!.spec;
    expect(isCoordinationKit(spec)).toBe(true);
    expect(spec.subject.horizon?.horizon).toBe("long");
    expect(spec.workloads.some((w) => (w.timeout_s ?? 0) >= 7_200)).toBe(true);
    expect(horizon(r.findings)).toEqual([]);
  });

  it("does not fire on a coordination kit with a long-horizon workload (fixture for kits/tandem-long-horizon)", async () => {
    const dir = kitCopyTdm215(TANDEM_KIT, withLongWorkloadTdm215);
    const r = await runSkepticChecks(dir);
    const todo = r.material!.spec.workloads.find((w) => w.id === "todo-api")!;
    expect(todo.timeout_s).toBe(10_800);
    expect(horizon(r.findings)).toEqual([]);
  });

  it("blocks a kit whose own subject.horizon says long but ships only short workloads", async () => {
    const dir = kitCopyTdm215(TANDEM_KIT, (y) =>
      y.replace(
        "  better_means:\n    - more trials pass every hidden test",
        "  horizon:\n    horizon: long\n    rationale: Tandem coordinates parallel workers, so it must be tested on a whole-app build.\n  better_means:\n    - more trials pass every hidden test",
      ),
    );
    const r = await runSkepticChecks(dir);
    const f = horizon(r.findings);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "block", check: "horizon_mismatch" });
    expect(f[0]!.why).toMatch(/judges its subject's horizon long/);
    const line = Number(f[0]!.evidence.split(":")[1]);
    expect(readFileSync(path.join(dir, "anybench.yaml"), "utf8").split("\n")[line - 1]).toMatch(
      /horizon:/,
    );
    expect(decideSkepticVerdict(r.findings)).toBe("repair");
  });

  it("the same kit with its long workload passes the horizon check even with horizon long", async () => {
    const dir = kitCopyTdm215(TANDEM_KIT, (y) =>
      withLongWorkloadTdm215(y).replace(
        "  better_means:\n    - more trials pass every hidden test",
        "  horizon:\n    horizon: long\n    rationale: whole-app work is where coordination can pay off.\n  better_means:\n    - more trials pass every hidden test",
      ),
    );
    expect(horizon((await runSkepticChecks(dir)).findings)).toEqual([]);
  });

  it("never fires on a single coding agent or a CLI kit (no coordination, no long judgement)", async () => {
    for (const ex of ["coding-agent", "cli"]) {
      const r = await runSkepticChecks(path.join(EXAMPLES, ex));
      expect(isCoordinationKit(r.material!.spec), ex).toBe(false);
      expect(horizon(r.findings), ex).toEqual([]);
    }
    // The harness example coordinates workers on a short task: it is flagged.
    const h = await runSkepticChecks(path.join(EXAMPLES, "harness"));
    expect(horizon(h.findings).map((f) => f.severity)).toEqual(["warn"]);
  });
});
