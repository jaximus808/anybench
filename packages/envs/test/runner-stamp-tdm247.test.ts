// TDM-247: the runner's build commit, read back from the binary's bytes, and the commit a
// checkout's runner must carry (the newest commit that changed the runner's build inputs).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider } from "@anybench/providers";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildEnvSnapshot,
  EnvBuildError,
  formatRunnerBuild,
  parseRunnerBuild,
  readRunnerBuild,
  runnerBuildInputs,
  runnerBuildMarker,
  runnerBuildOf,
  runnerFromBytes,
  runnerSourceBuild,
} from "../src/index.js";

const C = "0123456789abcdef0123456789abcdef01234567";
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "tdm247-stamp-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("runner build stamp", () => {
  it("formats and parses the marker and `runner --version` output", () => {
    expect(runnerBuildMarker({ commit: C, dirty: false })).toBe(`anybench-runner-build:${C}`);
    expect(formatRunnerBuild({ commit: C, dirty: true })).toBe(`${C}-dirty`);
    expect(parseRunnerBuild(`0.1.0 ${C}\n`)).toEqual({ commit: C, dirty: false });
    expect(parseRunnerBuild(`0.1.0 ${C}-dirty`)).toEqual({ commit: C, dirty: true });
    expect(parseRunnerBuild("0.1.0 unknown")).toBeNull();
    expect(parseRunnerBuild("0.1.0")).toBeNull();
    expect(() => formatRunnerBuild({ commit: "abc", dirty: false })).toThrow(/40 hex/);
  });

  it("reads the build out of a binary, past a bare prefix and across a chunk boundary", async () => {
    const d = tmp();
    // The bare prefix comes first (the stamp module is bundled into the runner too).
    const head = Buffer.concat([
      Buffer.from("\x7fELF anybench-runner-build:\0"),
      Buffer.alloc((1 << 20) - 40, 0x41),
    ]);
    const f = join(d, "runner-linux-x64");
    writeFileSync(f, Buffer.concat([head, Buffer.from(`anybench-runner-build:${C}-dirty\0end`)]));
    expect(await readRunnerBuild(f)).toEqual({ commit: C, dirty: true });
    const g = join(d, "old");
    writeFileSync(g, "token cap crossed anybench-runner-build: nothing here");
    expect(await readRunnerBuild(g)).toBeNull();
    expect(runnerBuildOf(new TextEncoder().encode(`xx anybench-runner-build:${C} yy`))).toEqual({
      commit: C,
      dirty: false,
    });
  });

  it("the env build refuses an image whose runner --version is not the binary's build", async () => {
    const p = new FakeProvider();
    p.onExec("uname -m", () => "x86_64\n");
    p.onExec(/runner --version$/, () => `0.1.0 ${"9".repeat(40)}\n`);
    const runner = runnerFromBytes({
      x64: new TextEncoder().encode(`ELF anybench-runner-build:${C}`),
    });
    expect(runner.build!("x64")).toEqual({ commit: C, dirty: false });
    const err = await buildEnvSnapshot({
      provider: p,
      spec: { vcpu: 2, memoryMb: 4096, diskGb: 20 },
      label: "tdm247",
      recipes: [],
      catalog: { recipes: new Map(), lib: "" },
      runner,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvBuildError);
    expect((err as EnvBuildError).step).toBe("runner");
    expect((err as Error).message).toMatch(new RegExp(`not build ${C}`));
  });
});

describe("runnerSourceBuild (the commit a checkout's runner must carry)", () => {
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  function repo(): string {
    const d = tmp();
    const pkg = (dir: string, name: string, deps: Record<string, string> = {}) => {
      mkdirSync(join(d, dir, "src"), { recursive: true });
      writeFileSync(join(d, dir, "package.json"), JSON.stringify({ name, dependencies: deps }));
      writeFileSync(join(d, dir, "src", "index.ts"), `export const n = "${name}";\n`);
    };
    pkg("packages/runner", "@anybench/runner", { "@anybench/envs": "workspace:*", zod: "^4" });
    pkg("packages/envs", "@anybench/envs", { "@anybench/core": "workspace:*" });
    pkg("packages/core", "@anybench/core");
    pkg("packages/report", "@anybench/report", { "@anybench/core": "workspace:*" });
    mkdirSync(join(d, "packages/runner/scripts"));
    writeFileSync(join(d, "packages/runner/scripts/build-bin.mjs"), "// build\n");
    writeFileSync(join(d, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    writeFileSync(join(d, "README.md"), "docs\n");
    git(d, "init", "-q");
    git(d, "-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
    git(d, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    return d;
  }
  const commit = (d: string, file: string, text: string) => {
    writeFileSync(join(d, file), text);
    git(d, "add", file);
    git(d, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", file);
    return git(d, "rev-parse", "HEAD");
  };

  it("inputs: the runner and its workspace deps (transitively), the build script, the lockfile", () => {
    expect(runnerBuildInputs(repo())).toEqual([
      "packages/core/src",
      "packages/core/package.json",
      "packages/envs/src",
      "packages/envs/package.json",
      "packages/runner/src",
      "packages/runner/package.json",
      "packages/runner/scripts",
      "pnpm-lock.yaml",
    ]);
  });

  it("moves with a change to an input, not with docs or an unrelated package; dirty when uncommitted", () => {
    const d = repo();
    const first = runnerSourceBuild(d);
    expect(first).toMatchObject({ commit: git(d, "rev-parse", "HEAD"), dirty: false, changed: [] });
    commit(d, "README.md", "more docs\n");
    commit(d, "packages/report/src/index.ts", "export const r = 1;\n");
    expect(runnerSourceBuild(d).commit).toBe(first.commit);
    const core = commit(d, "packages/core/src/index.ts", "export const n = 2;\n");
    expect(runnerSourceBuild(d)).toMatchObject({ commit: core, dirty: false });
    writeFileSync(join(d, "packages/envs/src/new.ts"), "export {};\n");
    expect(runnerSourceBuild(d)).toMatchObject({
      commit: core,
      dirty: true,
      changed: ["packages/envs/src/new.ts"],
    });
  });
});
