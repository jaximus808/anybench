// TDM-208 [18.1]: kits/tandem-long-horizon/workloads/project-tracker, the whole-app workload.
// Setup builds a deterministic one-commit workspace, the skeleton's own tests pass, areas.json
// (the area ids the hidden tests are tagged with) agrees with instruction.md route for route,
// the seeded 1.x fixture matches its generator and its documented passwords, and the README holds
// the founder's pre-registered prediction.
import { spawnSync } from "node:child_process";
import { scryptSync } from "node:crypto";
import {
  accessSync,
  constants,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const KIT_TDM208 = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../kits/tandem-long-horizon",
);
const WL_TDM208 = join(KIT_TDM208, "workloads/project-tracker");

interface AreaTdm208 {
  id: string;
  title: string;
  section: string;
  tests_target: number;
  depends_on: string[];
  routes: string[];
  must_cover: string[];
}
const areasTdm208 = (): { workload: string; tests_total: number; areas: AreaTdm208[] } =>
  JSON.parse(readFileSync(join(WL_TDM208, "areas.json"), "utf8"));
const instructionTdm208 = (): string => readFileSync(join(WL_TDM208, "instruction.md"), "utf8");

/** Rows of the route tables (tables whose header starts with `| Route |`), not the audit table. */
function routeRowsTdm208(): string[] {
  const rows: string[] = [];
  let inRouteTable = false;
  for (const line of instructionTdm208().split("\n")) {
    if (!line.startsWith("|")) inRouteTable = false;
    else if (line.startsWith("| Route |")) inRouteTable = true;
    else if (inRouteTable && /^\| `(GET|POST|PATCH|DELETE) \//.test(line)) rows.push(line);
  }
  return rows;
}

function walkTdm208(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walkTdm208(p) : [p];
  });
}

describe("kits/tandem-long-horizon project-tracker workload", () => {
  const root = mkdtempSync(join(tmpdir(), "tdm208-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function setupTdm208(name: string): string {
    const ws = join(root, name);
    const r = spawnSync(join(WL_TDM208, "setup.sh"), [ws], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    return ws;
  }
  const git = (ws: string, ...args: string[]): string =>
    spawnSync("git", ["-C", ws, ...args], { encoding: "utf8" }).stdout.trim();

  it("setup.sh builds the same one-commit workspace every time, without kit-side files", () => {
    const a = setupTdm208("a");
    const b = setupTdm208("b");
    expect(git(a, "rev-parse", "HEAD")).toMatch(/^[0-9a-f]{40}$/);
    expect(git(a, "rev-parse", "HEAD")).toBe(git(b, "rev-parse", "HEAD"));
    expect(git(a, "rev-list", "--count", "HEAD")).toBe("1");
    expect(git(a, "status", "--porcelain")).toBe("");
    const files = git(a, "ls-files").split("\n").sort();
    expect(files).toEqual([
      ".gitignore",
      "README.md",
      "fixtures/tracker-v1.json",
      "package.json",
      "src/app.ts",
      "src/http.ts",
      "src/main.ts",
      "src/router.ts",
      "test/health.test.ts",
      "tsconfig.json",
    ]);
  });

  it("refuses a workspace that is not empty", () => {
    const ws = setupTdm208("taken");
    const r = spawnSync(join(WL_TDM208, "setup.sh"), [ws], { encoding: "utf8" });
    expect(r.status).toBe(2);
  });

  it("the skeleton's own tests pass offline under node --test", () => {
    const ws = setupTdm208("skeleton");
    const r = spawnSync(process.execPath, ["--test", "test/**/*.test.ts"], {
      cwd: ws,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/pass 2/);
  }, 90_000);

  it("scripts are executable", () => {
    for (const s of [
      join(WL_TDM208, "setup.sh"),
      join(KIT_TDM208, "scripts/setup-workspace.sh"),
      join(KIT_TDM208, "scripts/gen-seed-v1.mjs"),
    ])
      expect(() => accessSync(s, constants.X_OK), relative(KIT_TDM208, s)).not.toThrow();
  });
});

describe("kits/tandem-long-horizon areas.json and instruction.md", () => {
  it("has unique area ids whose targets sum to 120, with known dependencies", () => {
    const { workload, tests_total, areas } = areasTdm208();
    expect(workload).toBe("project-tracker");
    const ids = areas.map((a) => a.id);
    expect(ids).toEqual([
      "auth",
      "teams",
      "projects",
      "boards",
      "cards",
      "comments",
      "search",
      "webhooks",
      "ratelimit",
      "persistence",
      "migration",
      "audit",
    ]);
    expect(areas.reduce((n, a) => n + a.tests_target, 0)).toBe(120);
    expect(tests_total).toBe(120);
    for (const a of areas) {
      expect(a.id).toMatch(/^[a-z]+$/);
      expect(a.tests_target, a.id).toBeGreaterThan(0);
      expect(a.must_cover.length, a.id).toBeGreaterThan(0);
      for (const d of a.depends_on) expect(ids, `${a.id} depends on ${d}`).toContain(d);
    }
  });

  it("every area's section is a heading of instruction.md that names the area id", () => {
    const headings = instructionTdm208()
      .split("\n")
      .filter((l) => l.startsWith("#"));
    for (const a of areasTdm208().areas) {
      expect(headings, a.id).toContain(a.section);
      expect(a.section, a.id).toContain(`\`${a.id}\``);
    }
  });

  it("the route tables of instruction.md and the areas' routes are the same set, each route in one area", () => {
    const inDoc = routeRowsTdm208().map((row) => /^\| `([^`]+)`/.exec(row)![1]!);
    expect(new Set(inDoc).size, "a route is listed twice in instruction.md").toBe(inDoc.length);
    const inAreas = areasTdm208().areas.flatMap((a) => a.routes);
    expect(new Set(inAreas).size, "a route belongs to two areas").toBe(inAreas.length);
    expect([...inAreas].sort()).toEqual([...inDoc].sort());
    expect(inDoc.length).toBeGreaterThanOrEqual(45);
  });

  it("every error code a route table uses is in the error catalogue (section 0.2)", () => {
    const doc = instructionTdm208();
    const catalogue = doc.slice(doc.indexOf("### 0.2 Errors"), doc.indexOf("### 0.3"));
    const declared = new Set([...catalogue.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!));
    const tableRows = routeRowsTdm208();
    expect(tableRows.length).toBeGreaterThanOrEqual(45);
    for (const row of tableRows) {
      const errors = row.split("|").at(-2)!;
      for (const m of errors.matchAll(/\b\d{3} ([a-z_]+)/g))
        expect(declared.has(m[1]!), `${m[1]} in: ${row}`).toBe(true);
    }
  });

  it("nothing the agent sees points at a grader or a solution", () => {
    const visible = [join(WL_TDM208, "instruction.md"), ...walkTdm208(join(WL_TDM208, "input"))];
    for (const f of visible)
      expect(readFileSync(f, "utf8"), relative(KIT_TDM208, f)).not.toMatch(
        /hidden-tests|proof\/oracle|gates\/|areas\.json|tests_target/,
      );
  });
});

describe("kits/tandem-long-horizon seeded 1.x fixture", () => {
  const fixture = (): {
    version: number;
    users: { id: string; passwordHash: string }[];
    cards: unknown[];
    comments: unknown[];
  } => JSON.parse(readFileSync(join(WL_TDM208, "input/fixtures/tracker-v1.json"), "utf8"));

  it("is exactly what scripts/gen-seed-v1.mjs generates", () => {
    const r = spawnSync(
      process.execPath,
      [join(KIT_TDM208, "scripts/gen-seed-v1.mjs"), "--check"],
      {
        encoding: "utf8",
      },
    );
    expect(r.status, r.stderr).toBe(0);
  });

  it("is version 1 and every password instruction.md documents verifies against its hash", () => {
    const f = fixture();
    expect(f.version).toBe(1);
    const rows = [
      ...instructionTdm208().matchAll(/^\| `(u\d+)` \| `[^`]+` \| `([^`]+)` \|$/gm),
    ].map((m) => [m[1]!, m[2]!] as const);
    expect(rows.map(([id]) => id)).toEqual(f.users.map((u) => u.id));
    for (const [id, password] of rows) {
      const [scheme, salt, key] = f.users.find((u) => u.id === id)!.passwordHash.split("$");
      expect(scheme).toBe("scrypt");
      expect(scryptSync(password, Buffer.from(salt!, "hex"), 64).toString("hex"), id).toBe(key);
    }
    expect(f.cards.length).toBeGreaterThanOrEqual(15);
    expect(f.comments.length).toBeGreaterThanOrEqual(10);
  });
});

describe("kits/tandem-long-horizon README", () => {
  it("records the founder's prediction verbatim, dated before any trial, and the first run's result", () => {
    const readme = readFileSync(join(KIT_TDM208, "README.md"), "utf8");
    expect(readme).toContain(
      '"Tandem\'s strength is building entire applications, which a single raw Claude Code, even with subagents, will probably struggle with."',
    );
    expect(readme).toMatch(/2026-11-08, before any trial/);
    expect(readme).toMatch(/01a1bae4/);
    expect(readme).toMatch(/Solo Claude Code won/);
  });

  it("carries no secret values", () => {
    const secretish =
      /(sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{32,}|ANTHROPIC_API_KEY\s*=\s*\S+|ghp_[A-Za-z0-9]{20,})/;
    for (const f of walkTdm208(KIT_TDM208))
      expect(secretish.test(readFileSync(f, "utf8")), relative(KIT_TDM208, f)).toBe(false);
  });
});
