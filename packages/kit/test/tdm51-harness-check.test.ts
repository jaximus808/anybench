// TDM-51 [5.6] review round 3: the harness example's hidden-tests check.sh is hardened against
// outputs that try to break it. Run on the host with a pass-through $AB_RUN (the scoring
// computer's uid split is covered by packages/bench gate-docker-tdm51); this pins the script's
// own logic: whatever the outputs do, it writes a FAIL verdict and exits 0, never a verdict-less
// exit that would read as a broken check.
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HARNESS = join(dirname(fileURLToPath(import.meta.url)), "..", "examples", "harness");
const CHECK = join(HARNESS, "gates", "hidden-tests", "check.sh");

describe("harness hidden-tests check.sh (TDM-51)", () => {
  let root = "";
  let abRun = "";

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "tdm51-harness-"));
    abRun = join(root, "ab-run");
    await writeFile(abRun, '#!/usr/bin/env bash\nexec "$@"\n');
    await chmod(abRun, 0o755);
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function run(name: string, ws: (dir: string) => Promise<void> | void, env = true) {
    const out = join(root, name, "out");
    const runDir = join(root, name, "run");
    await mkdir(out, { recursive: true });
    await mkdir(runDir, { recursive: true });
    await ws(runDir);
    const verdict = join(root, name, "gate.json");
    const r = spawnSync("bash", [CHECK, out, "bug-hunt", verdict], {
      env: {
        PATH: process.env.PATH,
        ...(env ? { AB_RUN: abRun, AB_RUN_DIR: runDir } : {}),
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    let gate: unknown = null;
    try {
      gate = JSON.parse(await readFile(verdict, "utf8"));
    } catch {
      gate = null;
    }
    return { status: r.status, gate };
  }

  it("passes the oracle", async () => {
    const r = await run("oracle", async (d) => {
      await mkdir(join(d, "workspace"));
      await copyFile(
        join(HARNESS, "proof", "oracle", "bug-hunt", "dates.js"),
        join(d, "workspace", "dates.js"),
      );
    });
    expect(r).toEqual({
      status: 0,
      gate: { pass: true, reason: "all hidden tests pass", evidence: ["hidden-tests.txt"] },
    });
  }, 60_000);

  it("a planted .hidden-tests FILE is replaced by the real tests, and the wrong answer FAILs", async () => {
    const r = await run("planted", async (d) => {
      await mkdir(join(d, "workspace"));
      await writeFile(join(d, "workspace", ".hidden-tests"), "not a directory\n");
      await writeFile(join(d, "workspace", "dates.js"), "export const isLeap = () => true;\n");
    });
    expect(r.status).toBe(0);
    expect(r.gate).toMatchObject({ pass: false, reason: "hidden tests failed" });
  }, 60_000);

  it("planted fake tests are replaced too (a passing decoy doesn't count)", async () => {
    const r = await run("decoy", async (d) => {
      await mkdir(join(d, "workspace", ".hidden-tests"), { recursive: true });
      await writeFile(
        join(d, "workspace", ".hidden-tests", "dates.test.js"),
        'import { test } from "node:test"; test("ok", () => {});\n',
      );
      await writeFile(join(d, "workspace", "dates.js"), "export const isLeap = () => true;\n");
    });
    expect(r.gate).toMatchObject({ pass: false, reason: "hidden tests failed" });
  }, 60_000);

  it("no workspace (or a workspace that is a file) is a FAIL verdict, exit 0", async () => {
    const none = await run("none", () => undefined);
    expect(none).toEqual({
      status: 0,
      gate: { pass: false, reason: "the outputs have no workspace/", evidence: [] },
    });
    const file = await run("file", (d) => writeFile(join(d, "workspace"), "x"));
    expect(file.status).toBe(0);
    expect(file.gate).toMatchObject({ pass: false });
  }, 60_000);

  it("without $AB_RUN the check refuses to run contender code at all (a kit error, no verdict)", async () => {
    const r = await run(
      "no-ab-run",
      async (d) => {
        await mkdir(join(d, "workspace"));
      },
      false,
    );
    expect(r.status).not.toBe(0);
    expect(r.gate).toBeNull();
  });
});
