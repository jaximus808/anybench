// TDM-235 [18.14]: kits/tandem-long-horizon/workloads/project-tracker-xl, the v2 whole-app workload
// (about 5x project-tracker). Setup builds a deterministic one-commit workspace, the skeleton's own
// tests pass, areas.json (the area ids the hidden tests are tagged with, split into two halves)
// agrees with instruction.md route for route, every error code is in the catalogue, the options
// table matches the skeleton's AppOptions, the 1.x fixture is v1's byte for byte, nothing the agent
// sees points at a grader, and the README records why v2 exists.
import { spawnSync } from "node:child_process";
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

const KIT_TDM235 = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../kits/tandem-long-horizon",
);
const WL_TDM235 = join(KIT_TDM235, "workloads/project-tracker-xl");
const WL_V1_TDM235 = join(KIT_TDM235, "workloads/project-tracker");

interface AreaTdm235 {
  id: string;
  title: string;
  section: string;
  half: 1 | 2;
  tests_target: number;
  depends_on: string[];
  routes: string[];
  must_cover: string[];
}
const areasTdm235 = (): {
  workload: string;
  tests_total: number;
  halves: Record<string, number>;
  areas: AreaTdm235[];
} => JSON.parse(readFileSync(join(WL_TDM235, "areas.json"), "utf8"));
const instructionTdm235 = (): string => readFileSync(join(WL_TDM235, "instruction.md"), "utf8");

const METHOD_TDM235 = "(?:GET|POST|PUT|PATCH|DELETE)";

/** Rows of the route tables (tables whose header starts with `| Route |`), not the audit table. */
function routeRowsTdm235(): string[] {
  const rows: string[] = [];
  let inRouteTable = false;
  const row = new RegExp(`^\\| \`${METHOD_TDM235} \\/`);
  for (const line of instructionTdm235().split("\n")) {
    if (!line.startsWith("|")) inRouteTable = false;
    else if (line.startsWith("| Route |")) inRouteTable = true;
    else if (inRouteTable && row.test(line)) rows.push(line);
  }
  return rows;
}

function catalogueTdm235(): Map<string, string> {
  const doc = instructionTdm235();
  const catalogue = doc.slice(doc.indexOf("### 0.2 Errors"), doc.indexOf("### 0.3"));
  const codes = new Map<string, string>();
  for (const line of catalogue.split("\n")) {
    const m = /^\| (\d{3}) \| (.+) \|$/.exec(line);
    if (m) for (const c of m[2]!.matchAll(/`([a-z_]+)`/g)) codes.set(c[1]!, m[1]!);
  }
  return codes;
}

function walkTdm235(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walkTdm235(p) : [p];
  });
}

describe("kits/tandem-long-horizon project-tracker-xl workload", () => {
  const root = mkdtempSync(join(tmpdir(), "tdm235-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function setupTdm235(name: string): string {
    const ws = join(root, name);
    const r = spawnSync(join(WL_TDM235, "setup.sh"), [ws], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    return ws;
  }
  const git = (ws: string, ...args: string[]): string =>
    spawnSync("git", ["-C", ws, ...args], { encoding: "utf8" }).stdout.trim();

  it("setup.sh builds the same one-commit workspace every time, without kit-side files", () => {
    const a = setupTdm235("a");
    const b = setupTdm235("b");
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
    const ws = setupTdm235("taken");
    const r = spawnSync(join(WL_TDM235, "setup.sh"), [ws], { encoding: "utf8" });
    expect(r.status).toBe(2);
  });

  it("the skeleton's own tests pass offline under node --test", () => {
    const ws = setupTdm235("skeleton");
    const r = spawnSync(process.execPath, ["--test", "test/**/*.test.ts"], {
      cwd: ws,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/pass 2/);
  }, 90_000);

  it("setup.sh is executable", () => {
    expect(() => accessSync(join(WL_TDM235, "setup.sh"), constants.X_OK)).not.toThrow();
  });

  it("the 1.x fixture is project-tracker's, byte for byte (gen-seed-v1.mjs --check covers that one)", () => {
    expect(readFileSync(join(WL_TDM235, "input/fixtures/tracker-v1.json"))).toEqual(
      readFileSync(join(WL_V1_TDM235, "input/fixtures/tracker-v1.json")),
    );
    const rows = (doc: string): string[] =>
      [...doc.matchAll(/^\| `(u\d+)` \| `[^`]+` \| `([^`]+)` \|$/gm)].map((m) => m[0]);
    const v1 = rows(readFileSync(join(WL_V1_TDM235, "instruction.md"), "utf8"));
    expect(v1.length).toBe(7);
    expect(rows(instructionTdm235())).toEqual(v1);
  });

  it("the options table of section 0.6 and the skeleton's AppOptions name the same options", () => {
    const doc = instructionTdm235();
    const table = doc.slice(doc.indexOf("### 0.6 Options"), doc.indexOf("### 0.7"));
    const documented = [...table.matchAll(/^\| `([a-zA-Z.]+)` \|/gm)].map((m) => m[1]!.split(".")[0]!);
    const appTs = readFileSync(join(WL_TDM235, "input/src/app.ts"), "utf8");
    const iface = appTs.slice(appTs.indexOf("export interface AppOptions"));
    const declared = [...iface.slice(0, iface.indexOf("\n}")).matchAll(/^ {2}(\w+)\?:/gm)].map(
      (m) => m[1]!,
    );
    expect([...new Set(documented)].sort()).toEqual([...declared].sort());
  });
});

describe("kits/tandem-long-horizon project-tracker-xl areas.json and instruction.md", () => {
  it("has unique area ids (v1's twelve first), targets summing to about 600, in two halves of about equal size", () => {
    const { workload, tests_total, halves, areas } = areasTdm235();
    expect(workload).toBe("project-tracker-xl");
    const ids = areas.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.slice(0, 12)).toEqual([
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
    const total = areas.reduce((n, a) => n + a.tests_target, 0);
    expect(total).toBe(tests_total);
    expect(total).toBeGreaterThanOrEqual(550);
    expect(total).toBeLessThanOrEqual(650);
    for (const h of [1, 2] as const) {
      const n = areas.filter((a) => a.half === h).reduce((s, a) => s + a.tests_target, 0);
      expect(halves[String(h)], `half ${h}`).toBe(n);
      expect(Math.abs(n - total / 2), `half ${h} is ${n} of ${total}`).toBeLessThanOrEqual(total * 0.05);
    }
    for (const a of areas) {
      expect(a.id).toMatch(/^[a-z]+$/);
      expect([1, 2], a.id).toContain(a.half);
      expect(a.tests_target, a.id).toBeGreaterThan(0);
      expect(a.must_cover.length, a.id).toBeGreaterThan(0);
      for (const d of a.depends_on) expect(ids, `${a.id} depends on ${d}`).toContain(d);
    }
  });

  it("every area's section is a heading of instruction.md that names the area id, one area per heading", () => {
    const headings = instructionTdm235()
      .split("\n")
      .filter((l) => l.startsWith("#"));
    const sections = areasTdm235().areas.map((a) => a.section);
    expect(new Set(sections).size).toBe(sections.length);
    for (const a of areasTdm235().areas) {
      expect(headings, a.id).toContain(a.section);
      expect(a.section, a.id).toContain(`\`${a.id}\``);
    }
  });

  it("the route tables of instruction.md and the areas' routes are the same set, each route in one area", () => {
    const inDoc = routeRowsTdm235().map((row) => /^\| `([^`]+)`/.exec(row)![1]!);
    expect(new Set(inDoc).size, "a route is listed twice in instruction.md").toBe(inDoc.length);
    const inAreas = areasTdm235().areas.flatMap((a) => a.routes);
    expect(new Set(inAreas).size, "a route belongs to two areas").toBe(inAreas.length);
    expect([...inAreas].sort()).toEqual([...inDoc].sort());
    expect(inDoc.length).toBeGreaterThanOrEqual(150);
  });

  it("contains every route of project-tracker (v1), so v1's contract is part of v2's", () => {
    const v1 = JSON.parse(readFileSync(join(WL_V1_TDM235, "areas.json"), "utf8")) as {
      areas: { routes: string[] }[];
    };
    const v2 = new Set(areasTdm235().areas.flatMap((a) => a.routes));
    for (const r of v1.areas.flatMap((a) => a.routes)) expect(v2.has(r), r).toBe(true);
  });

  it("every error code a route table or the text uses is in the catalogue (section 0.2), with its status", () => {
    const catalogue = catalogueTdm235();
    expect(catalogue.size).toBeGreaterThanOrEqual(45);
    const tableRows = routeRowsTdm235();
    for (const row of tableRows) {
      const errors = row.split("|").at(-2)!;
      for (const m of errors.matchAll(/\b(\d{3}) ([a-z_]+)/g))
        expect(catalogue.get(m[2]!), `${m[1]} ${m[2]} in: ${row}`).toBe(m[1]);
    }
    const doc = instructionTdm235();
    const body = doc.slice(doc.indexOf("### 0.3"));
    for (const m of body.matchAll(/`(\d{3}) ([a-z_]+)`/g))
      expect(catalogue.get(m[2]!), `\`${m[1]} ${m[2]}\` in the text`).toBe(m[1]);
  });

  it("every catalogued code is used somewhere outside the catalogue", () => {
    const doc = instructionTdm235();
    const rest = doc
      .split("\n")
      .filter((l) => !/^\| \d{3} \| /.test(l))
      .join("\n");
    for (const code of catalogueTdm235().keys())
      expect(rest.includes(code), `${code} is catalogued but never used`).toBe(true);
  });

  it("every event of the section 0.8 table is a valid webhook event and appears in the audit or a feature section", () => {
    const doc = instructionTdm235();
    const s08 = doc.slice(doc.indexOf("### 0.8"), doc.indexOf("### 0.9"));
    const events = [...s08.matchAll(/^\| `([a-z]+\.[a-z_]+)` \|/gm)].map((m) => m[1]!);
    expect(events.length).toBeGreaterThanOrEqual(14);
    expect(events).toContain("card.created");
    expect(events).toContain("checklist.completed");
    const rest = doc.slice(doc.indexOf("### 0.9"));
    for (const e of events) expect(rest.includes(`\`${e}\``), e).toBe(true);
  });

  it("nothing the agent sees points at a grader, hidden tests or a solution", () => {
    const visible = [join(WL_TDM235, "instruction.md"), ...walkTdm235(join(WL_TDM235, "input"))];
    for (const f of visible) {
      const text = readFileSync(f, "utf8");
      expect(text, relative(KIT_TDM235, f)).not.toMatch(
        /hidden-tests|proof\/oracle|gates\/|areas\.json|tests_target|\bhidden\b|\bgrad(e|ed|er|ing)\b|\boracle\b/i,
      );
    }
  });
});

describe("kits/tandem-long-horizon README on project-tracker-xl", () => {
  it("records, dated, why v2 was added and that the prediction text is unchanged", () => {
    const readme = readFileSync(join(KIT_TDM235, "README.md"), "utf8");
    expect(readme).toContain(
      '"Tandem\'s strength is building entire applications, which a single raw Claude Code, even with subagents, will probably struggle with."',
    );
    expect(readme).toMatch(/2026-11-08.*project-tracker-xl|project-tracker-xl.*2026-11-08/s);
    expect(readme).toMatch(/120\/120/);
    expect(readme).toMatch(/724 s/);
    expect(readme).toMatch(/prediction text is unchanged/i);
    expect(readme).toContain("workloads/project-tracker-xl/areas.json");
  });
});
