// TDM-247: the worker deploy ships only runner binaries built from the deploying checkout. A stale
// binary (another commit, or none compiled in: the Nov 7 runner production ran) is rebuilt; if it
// is still stale, or the deploy runs with --skip-build, it is refused, and bundleWorkerRelease
// refuses it too. The successor must report the manifest's runner commit before anything stops.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureRunnerBins,
  inspectRunnerBins,
  judgeRunnerBins,
  runnerBinPath,
  RUNNER_ARCHES,
} from "../lib/runner-bins.js";
import { bundleWorkerRelease } from "../lib/worker-bundle.js";
import { bootstrapCommand, hostRunnerProblem, renderBootstrap } from "../lib/worker-plan.js";

const OLD = "1111111111111111111111111111111111111111";
const NEW = "2222222222222222222222222222222222222222";
const want = { commit: NEW, dirty: false };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A checkout with runner binaries stamped `build` ("none": no marker; null: no file). */
function checkout(build: string | "none" | null): string {
  const root = mkdtempSync(join(tmpdir(), "tdm247-deploy-"));
  dirs.push(root);
  mkdirSync(join(root, "packages/runner/dist/bin"), { recursive: true });
  for (const d of ["kits/k", "packages/envs/recipes", "packages/agents/understander"]) {
    mkdirSync(join(root, d), { recursive: true });
  }
  writeFileSync(join(root, "kits/k/kit.yaml"), "name: k\n");
  writeFileSync(join(root, "packages/envs/recipes/r.sh"), "# r\n");
  writeFileSync(join(root, "packages/agents/understander/config.json"), "{}");
  writeFileSync(join(root, "worker.mjs"), "console.log('worker');\n");
  writeFileSync(join(root, "rotate.mjs"), "console.log('rotate');\n");
  if (build !== null) stamp(root, build);
  return root;
}
function stamp(root: string, build: string | "none"): void {
  for (const a of RUNNER_ARCHES) {
    const marker = build === "none" ? "token cap crossed" : `anybench-runner-build:${build}`;
    writeFileSync(runnerBinPath(root, a), `\x7fELF ${a}\0${marker}\0`);
  }
}

describe("judgeRunnerBins", () => {
  it("names every binary that is missing, unstamped or from another commit", async () => {
    expect(judgeRunnerBins(await inspectRunnerBins(checkout(NEW)), want)).toEqual({
      ok: true,
      problems: [],
    });
    expect(judgeRunnerBins(await inspectRunnerBins(checkout(OLD)), want).problems).toEqual([
      `runner-linux-x64 was built from ${OLD}, not ${NEW}`,
      `runner-linux-arm64 was built from ${OLD}, not ${NEW}`,
    ]);
    expect(judgeRunnerBins(await inspectRunnerBins(checkout("none")), want).problems[0]).toMatch(
      /no build commit \(pre-TDM-247\)/,
    );
    expect(judgeRunnerBins(await inspectRunnerBins(checkout(null)), want).problems[0]).toMatch(
      /missing/,
    );
    expect(
      judgeRunnerBins(await inspectRunnerBins(checkout(`${NEW}-dirty`)), want).problems[0],
    ).toMatch(/-dirty, not/);
  });
});

describe("ensureRunnerBins (scripts/deploy/worker.ts)", () => {
  const deps = (root: string, rebuildTo: string | null) => {
    const calls: string[] = [];
    return {
      calls,
      d: {
        inspect: () => inspectRunnerBins(root),
        build: () => {
          calls.push("build:bin");
          if (rebuildTo) stamp(root, rebuildTo);
        },
        log: (step: string) => calls.push(step),
      },
    };
  };

  it("a stale binary (the Nov 7 case: present, older commit) is rebuilt, not shipped", async () => {
    const root = checkout(OLD);
    const { calls, d } = deps(root, NEW);
    expect(await ensureRunnerBins(d, want, { allowBuild: true })).toEqual({ rebuilt: true });
    expect(calls).toEqual(["rebuild runner binaries", "build:bin", "runner binaries rebuilt"]);
    expect(judgeRunnerBins(await inspectRunnerBins(root), want).ok).toBe(true);
  });

  it("an unstamped binary is rebuilt too", async () => {
    const { calls, d } = deps(checkout("none"), NEW);
    await ensureRunnerBins(d, want, { allowBuild: true });
    expect(calls).toContain("build:bin");
  });

  it("current binaries are not rebuilt (the release id stays the same)", async () => {
    const { calls, d } = deps(checkout(NEW), NEW);
    expect(await ensureRunnerBins(d, want, { allowBuild: true })).toEqual({ rebuilt: false });
    expect(calls).not.toContain("build:bin");
  });

  it("refuses when the rebuild still yields another commit", async () => {
    const { d } = deps(checkout(OLD), OLD);
    await expect(ensureRunnerBins(d, want, { allowBuild: true })).rejects.toThrow(
      /still not built from this checkout: runner-linux-x64 was built from 1{40}/,
    );
  });

  it("--skip-build: a stale binary is refused, never shipped", async () => {
    const { calls, d } = deps(checkout(OLD), NEW);
    await expect(ensureRunnerBins(d, want, { allowBuild: false })).rejects.toThrow(
      /stale runner binaries, refusing to ship them \(--skip-build\)/,
    );
    expect(calls).not.toContain("build:bin");
  });
});

describe("bundleWorkerRelease refuses a stale runner", () => {
  const bundle = (root: string) =>
    bundleWorkerRelease({
      repoRoot: root,
      workerEntry: join(root, "worker.mjs"),
      rotateEntry: join(root, "rotate.mjs"),
      runnerBuild: want,
    });

  it("ships binaries built from the checkout's runner commit", async () => {
    const r = await bundle(checkout(NEW));
    expect(r.entries.map((e) => e.path).filter((p) => p.startsWith("bin/"))).toEqual([
      "bin/runner-linux-x64",
      "bin/runner-linux-arm64",
    ]);
  });

  it("refuses binaries from another commit or with none compiled in", async () => {
    await expect(bundle(checkout(OLD))).rejects.toThrow(
      new RegExp(`built from ${OLD}, not ${NEW}: refusing to ship a stale runner`),
    );
    await expect(bundle(checkout("none"))).rejects.toThrow(/unknown commit \(pre-TDM-247\)/);
  });
});

describe("host post-check: bootstrap.sh runner-version", () => {
  it("is a bootstrap phase that runs the installed release's runner for this arch", () => {
    expect(bootstrapCommand("runner-version")).toMatch(/bootstrap\.sh" runner-version$/);
    const sh = renderBootstrap();
    expect(sh).toContain("runner-version)");
    expect(sh).toContain('"$ROOT/current/bin/runner-linux-$a" --version');
  });

  it("passes only when the host's runner reports the manifest's runner commit", () => {
    expect(hostRunnerProblem(`0.1.0 ${NEW}\n`, NEW)).toBeNull();
    expect(hostRunnerProblem(`0.1.0 ${OLD}\n`, NEW)).toBe(
      `the host's runner was built from ${OLD}, not ${NEW}`,
    );
    expect(hostRunnerProblem("0.1.0\n", NEW)).toMatch(/with no build commit/);
    expect(hostRunnerProblem(`0.1.0 ${NEW}-dirty`, NEW)).toMatch(/-dirty, not/);
  });
});
