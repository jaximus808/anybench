// TDM-247: the runner reports the commit it was built from: `runner --version`, status.json,
// machine.json, the driver's env and the trial's versions.json. vitest.config.ts defines the same
// `__ANYBENCH_RUNNER_BUILD__` that build-bin.mjs passes to `bun build --define`.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readRunnerBuild } from "@anybench/envs";
import { afterEach, describe, expect, it } from "vitest";
import { RUNNER_EXIT, RunnerStatusSchema, runnerPaths, runTrial } from "../src/index.js";
import { RUNNER_COMMIT, RUNNER_VERSION, RUNNER_VERSION_LINE } from "../src/version.js";
import { stampVersionsJson } from "../src/versions.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const pkgDir = fileURLToPath(new URL("..", import.meta.url));
const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("TDM-247 runner commit", () => {
  it("the compiled-in build is the runner's commit and `--version` prints it", () => {
    expect(RUNNER_COMMIT).toBe(COMMIT);
    expect(RUNNER_VERSION_LINE).toBe(`${RUNNER_VERSION} ${COMMIT}`);
  });

  const bun = [process.env.BUN, "bun", join(homedir(), ".bun", "bin", "bun")].find(
    (b) => b && spawnSync(b, ["--version"]).status === 0,
  );
  it.skipIf(!bun)(
    "bun build --define (as build-bin.mjs runs it) reaches `runner --version` and the bytes",
    () => {
      const out = join(tmp("tdm247-bun-"), "cli.js");
      const sha = "fedcba9876543210fedcba9876543210fedcba98";
      const b = spawnSync(
        bun!,
        [
          "build",
          "src/cli.ts",
          "--minify",
          "--target=bun",
          "--define",
          `__ANYBENCH_RUNNER_BUILD__=${JSON.stringify(`anybench-runner-build:${sha}-dirty`)}`,
          "--outfile",
          out,
        ],
        { cwd: pkgDir, encoding: "utf8" },
      );
      expect(b.status, b.stderr).toBe(0);
      const v = spawnSync(bun!, [out, "--version"], { encoding: "utf8" });
      expect(v.stdout.trim()).toBe(`${RUNNER_VERSION} ${sha}-dirty`);
      return readRunnerBuild(out).then((got) => expect(got).toEqual({ commit: sha, dirty: true }));
    },
    60_000,
  );

  it("a trial's versions.json, status.json and machine.json carry runner_commit", async () => {
    const home = tmp("tdm247-home-");
    const p = runnerPaths(home);
    await mkdir(p.configDir, { recursive: true });
    await mkdir(p.inDir, { recursive: true });
    await writeFile(p.envFile, "", { mode: 0o600 });
    await writeFile(
      p.trialJson,
      JSON.stringify({
        version: 1,
        trial_id: "trial-tdm247",
        run_id: "run-tdm247",
        attempt: 1,
        driver: {
          type: "cli",
          // The driver writes its own versions.json (like every kit adapter) and sees the commit.
          run: `printf '{"setup":"solo","claude_code":"2.1.319"}\\n' > "$2/versions.json"; echo "$ANYBENCH_RUNNER_COMMIT" > "$2/seen-commit.txt"`,
        },
        warmup_runs: 0,
        wall_clock_s: 30,
        heartbeat_s: 1,
        collect: [],
        ingest: null,
      }),
    );
    const r = await runTrial({
      trialId: "trial-tdm247",
      home,
      log: () => undefined,
      stealWindowMs: 10,
    });
    expect(r.exitCode).toBe(RUNNER_EXIT.ok);

    const versions = JSON.parse(await readFile(join(p.outDir, "versions.json"), "utf8"));
    expect(versions).toEqual({ setup: "solo", claude_code: "2.1.319", runner_commit: COMMIT });
    expect((await readFile(join(p.outDir, "seen-commit.txt"), "utf8")).trim()).toBe(COMMIT);
    const status = RunnerStatusSchema.parse(JSON.parse(await readFile(p.statusJson, "utf8")));
    expect(status.runner_commit).toBe(COMMIT);
    expect(JSON.parse(await readFile(p.machineJson, "utf8"))).toMatchObject({
      runner_commit: COMMIT,
    });
    // The frozen bundle has the stamped versions.json (its manifest hash is of the stamped file).
    const manifest = JSON.parse(await readFile(p.manifestJson, "utf8")) as {
      files: { path: string }[];
    };
    expect(manifest.files.map((f) => f.path)).toContain("versions.json");
    const t = spawnSync("tar", ["-xzOf", p.bundle, "versions.json"], { encoding: "utf8" });
    expect(JSON.parse(t.stdout)).toMatchObject({ runner_commit: COMMIT });
  });

  it("stampVersionsJson leaves a missing or non-object versions.json alone", async () => {
    const d = tmp("tdm247-v-");
    expect(await stampVersionsJson(join(d, "versions.json"), COMMIT)).toBe(false);
    writeFileSync(join(d, "versions.json"), "[1]");
    expect(await stampVersionsJson(join(d, "versions.json"), COMMIT)).toBe(false);
    expect(await readFile(join(d, "versions.json"), "utf8")).toBe("[1]");
  });
});
