// TDM-248 [21.8]: when the runner stops the subject (token cap, the run's budget stop, wall-clock
// cap), the driver is killed before it copies EVAL_WS into EVAL_OUT/workspace/, so the runner
// freezes it itself. Harness league run 1 lost every "Claude Code + subagents" trial this way.
//
// The driver below is a stand-in for kits/*/adapters/claude-code/driver.sh: it writes the
// workspace while streaming Claude Code's stream-json, and copies the workspace only after its
// "claude" exits. The bundle is then graded with the coding-agent example kit's real hidden-tests
// check (packages/kit/examples/coding-agent), as the scoring computer would.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  freezeWorkspace,
  RUNNER_EXIT,
  RunnerStatusSchema,
  runnerPaths,
  runTrial,
  STOP_FREEZE_DIR,
  type TrialJobInput,
  type WorkspaceFreeze,
} from "../src/index.js";

const HERE_TDM248 = dirname(fileURLToPath(import.meta.url));
const CHECK_TDM248 = join(
  HERE_TDM248,
  "../../kit/examples/coding-agent/gates/hidden-tests/check.sh",
);
const quiet = () => undefined;

const SLUG_TDM248 = [
  "export function slugify(s) {",
  '  const out = s.normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").toLowerCase()',
  '    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");',
  '  return out || "untitled";',
  "}",
].join("\n");

const homes: string[] = [];
afterEach(async () => {
  for (const h of homes.splice(0)) await rm(h, { recursive: true, force: true });
});

async function setupHomeTdm248(job: Partial<TrialJobInput>) {
  const home = mkdtempSync(join(tmpdir(), "tdm248-home-"));
  homes.push(home);
  const p = runnerPaths(home);
  await mkdir(p.configDir, { recursive: true });
  await mkdir(p.inDir, { recursive: true });
  await writeFile(p.envFile, "", { mode: 0o600 });
  await writeFile(join(p.inDir, "slug.js"), SLUG_TDM248);
  const full: TrialJobInput = {
    version: 1,
    trial_id: "trial-tdm248",
    run_id: "run-tdm248",
    attempt: 1,
    driver: { type: "coding-agent", run: "true" },
    wall_clock_s: 60,
    heartbeat_s: 1,
    ingest: null,
    ...job,
  };
  await writeFile(p.trialJson, JSON.stringify(full));
  return { home, paths: p };
}

/**
 * The driver: "claude" writes the workspace (src/slug.js, package.json, a node_modules and a .git
 * the freeze leaves out) and streams assistant messages; only after it exits does the driver copy
 * the workspace, as driver.sh does.
 */
function driverTdm248(messages: number, sleepS: number): string {
  return [
    'cd "$EVAL_WS"; mkdir -p src node_modules/dep .git;',
    `printf '{"type":"module"}\\n' > package.json; cp "$EVAL_IN/slug.js" src/slug.js;`,
    "echo dep > node_modules/dep/index.js; echo ref > .git/HEAD;",
    'echo stream > "$EVAL_OUT/stream.jsonl"; echo "{}" > "$EVAL_OUT/versions.json";',
    `i=1; while [ $i -le ${messages} ]; do`,
    `printf '{"type":"assistant","message":{"id":"msg_%s","usage":{"input_tokens":100000,"output_tokens":10000}}}\\n' $i;`,
    `sleep ${sleepS}; i=$((i+1)); done;`,
    'rm -rf "$EVAL_OUT/workspace" && mkdir -p "$EVAL_OUT/workspace";',
    '(cd "$EVAL_WS" && tar --exclude=.git --exclude=node_modules -cf - .) | tar -C "$EVAL_OUT/workspace" -xf -',
  ].join(" ");
}

interface ManifestTdm248 {
  files: { path: string }[];
  workspace_freeze?: WorkspaceFreeze;
}

async function manifestOf(path: string): Promise<ManifestTdm248> {
  return JSON.parse(await readFile(path, "utf8")) as ManifestTdm248;
}

/** Extract the bundle and run the coding-agent kit's hidden-tests check on it, as scoring does. */
async function gradeTdm248(bundle: string): Promise<{ pass: boolean; reason: string }> {
  const dir = mkdtempSync(join(tmpdir(), "tdm248-grade-"));
  homes.push(dir);
  const out = join(dir, "out");
  await mkdir(out);
  execFileSync("tar", ["-xzf", bundle, "-C", out]);
  const verdict = join(dir, "gate.json");
  const r = spawnSync("bash", [CHECK_TDM248, out, "slugify", verdict], {
    env: { ...process.env, AB_RUN: "env", AB_RUN_DIR: out },
    encoding: "utf8",
  });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(await readFile(verdict, "utf8")) as { pass: boolean; reason: string };
}

describe("a runner stop keeps the workspace (TDM-248)", () => {
  it("a token-cap stop freezes EVAL_WS into the bundle's workspace/, and the gate grades it", async () => {
    // $0.45 a message at the default prices: a $1.00 cap is crossed on the third, long before the
    // driver's own copy at the end.
    const { home, paths } = await setupHomeTdm248({
      driver: { type: "coding-agent", run: driverTdm248(20, 0.3) },
      token_cap_micro_usd: "1000000",
    });
    const r = await runTrial({ trialId: "trial-tdm248", home, log: quiet, stealWindowMs: 10 });
    expect(r.exitCode).toBe(RUNNER_EXIT.failed_subject);
    const status = RunnerStatusSchema.parse(JSON.parse(await readFile(paths.statusJson, "utf8")));
    expect(status.result).toMatchObject({ outcome: "failed_subject", failure_class: "budget" });

    const m = await manifestOf(paths.manifestJson);
    const listed = m.files.map((f) => f.path);
    expect(listed).toEqual(
      expect.arrayContaining(["workspace/package.json", "workspace/src/slug.js", "stream.jsonl"]),
    );
    // Left out as the drivers' tar does.
    expect(listed.some((f) => f.includes("node_modules") || f.includes(".git"))).toBe(false);
    expect(m.workspace_freeze).toMatchObject({
      by: "runner",
      trigger: "budget",
      dir: STOP_FREEZE_DIR,
      files: 2,
      skipped: 0,
      error: null,
    });
    const tarList = execFileSync("tar", ["-tzf", paths.bundle], { encoding: "utf8" }).split("\n");
    expect(tarList).toContain("workspace/src/slug.js");

    const gate = await gradeTdm248(paths.bundle);
    expect(gate.reason).toMatch(/hidden-tests: 7\/7 hidden tests pass on slugify/);
    expect(gate.pass).toBe(true);
  }, 60_000);

  it("the run's budget stop and the wall-clock cap freeze it too", async () => {
    const budget = await setupHomeTdm248({
      driver: { type: "coding-agent", run: driverTdm248(40, 0.25) },
    });
    const stop = setTimeout(() => {
      void writeFile(budget.paths.budgetStopFile, "spent $20.40, past the $20.00 budget\n");
    }, 1500);
    const rb = await runTrial({
      trialId: "trial-tdm248",
      home: budget.home,
      log: quiet,
      stealWindowMs: 10,
    });
    clearTimeout(stop);
    expect(rb.exitCode).toBe(RUNNER_EXIT.failed_subject);
    expect((await manifestOf(budget.paths.manifestJson)).workspace_freeze).toMatchObject({
      trigger: "budget",
      files: 2,
    });

    const wall = await setupHomeTdm248({
      driver: { type: "coding-agent", run: driverTdm248(40, 0.25) },
      wall_clock_s: 2,
    });
    const rw = await runTrial({
      trialId: "trial-tdm248",
      home: wall.home,
      log: quiet,
      stealWindowMs: 10,
    });
    expect(rw.exitCode).toBe(RUNNER_EXIT.failed_subject);
    const status = RunnerStatusSchema.parse(
      JSON.parse(await readFile(wall.paths.statusJson, "utf8")),
    );
    expect(status.result?.failure_class).toBe("wall_clock_exceeded");
    const m = await manifestOf(wall.paths.manifestJson);
    expect(m.workspace_freeze).toMatchObject({ trigger: "wall_clock", files: 2, error: null });
    expect((await gradeTdm248(wall.paths.bundle)).pass).toBe(true);
  }, 60_000);

  it("a driver that ends on its own freezes its own workspace: no runner freeze", async () => {
    const { home, paths } = await setupHomeTdm248({
      driver: { type: "coding-agent", run: `${driverTdm248(1, 0)}; exit 1` },
    });
    const r = await runTrial({ trialId: "trial-tdm248", home, log: quiet, stealWindowMs: 10 });
    expect(r.exitCode).toBe(RUNNER_EXIT.failed_subject);
    const m = await manifestOf(paths.manifestJson);
    expect(m.workspace_freeze).toBeUndefined();
    expect(m.files.map((f) => f.path)).toContain("workspace/src/slug.js");
  }, 30_000);
});

describe("freezeWorkspace (TDM-248)", () => {
  it("replaces a partial copy, skips symlinks and files past the transfer cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdm248-freeze-"));
    homes.push(dir);
    const ws = join(dir, "ws");
    const dest = join(dir, "out", "workspace");
    await mkdir(join(ws, "src"), { recursive: true });
    await mkdir(join(ws, "deep", "node_modules"), { recursive: true });
    await writeFile(join(ws, "src", "a.ts"), "aaaa");
    await writeFile(join(ws, "big.bin"), "x".repeat(100));
    await writeFile(join(ws, "deep", "node_modules", "x.js"), "x");
    execFileSync("ln", ["-s", "/etc/hosts", join(ws, "link")]);
    // The driver's interrupted copy.
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, "half-copied"), "stale");

    const f = await freezeWorkspace(ws, dest, {
      trigger: "budget",
      dir: "workspace",
      maxBytes: 50,
    });
    expect(f).toEqual({
      by: "runner",
      trigger: "budget",
      dir: "workspace",
      files: 1,
      bytes: 4,
      skipped: 1,
      error: null,
    });
    expect(await readFile(join(dest, "src", "a.ts"), "utf8")).toBe("aaaa");
    await expect(readFile(join(dest, "half-copied"))).rejects.toThrow();
    await expect(readFile(join(dest, "link"))).rejects.toThrow();
  });
});
