// TDM-247: which commit a runner binary was built from.
//
// `packages/runner/scripts/build-bin.mjs` compiles the commit into the binary as the string
// `anybench-runner-build:<40 hex>[-dirty]` (bun --define). The runner prints it with `--version`
// and records it in status.json, machine.json and versions.json. The deploy and the env build read
// it back from the binary's bytes (a linux binary cannot be run on the deploying Mac), so a runner
// left over from an older checkout is rebuilt or refused instead of shipped (docs/findings/
// harness-league-run-1.md §2: production ran the Nov 7 runner for two days).
//
// The commit is the newest commit that changed the runner's build inputs (its source, the source
// of the workspace packages it bundles, the lockfile), not HEAD: a docs-only commit then leaves
// the binary, the worker release id and every cached env snapshot as they are.
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const RUNNER_BUILD_PREFIX = "anybench-runner-build:";
const BUILD_RE = /anybench-runner-build:([0-9a-f]{40})(-dirty)?/;
const BARE_RE = /(?:^|\s)([0-9a-f]{40})(-dirty)?(?:\s|$)/;

export interface RunnerBuild {
  /** 40 hex: the newest commit that changed the runner's build inputs. */
  commit: string;
  /** Built with uncommitted changes to those inputs: the commit does not identify the code. */
  dirty: boolean;
}

/** `<commit>` or `<commit>-dirty`: what `runner --version` prints after the version. */
export function formatRunnerBuild(b: RunnerBuild): string {
  if (!/^[0-9a-f]{40}$/.test(b.commit))
    throw new Error(`runner commit must be 40 hex: ${b.commit}`);
  return `${b.commit}${b.dirty ? "-dirty" : ""}`;
}

/** The string compiled into the binary. */
export function runnerBuildMarker(b: RunnerBuild): string {
  return `${RUNNER_BUILD_PREFIX}${formatRunnerBuild(b)}`;
}

/** The build in a marker, in `runner --version` output, or in a bare `<commit>[-dirty]`. */
export function parseRunnerBuild(s: string): RunnerBuild | null {
  const m = (s.includes(RUNNER_BUILD_PREFIX) ? BUILD_RE : BARE_RE).exec(s);
  return m ? { commit: m[1]!, dirty: m[2] !== undefined } : null;
}

/** Scan a binary for its build marker. null: no marker (built before TDM-247 or by hand). */
export async function readRunnerBuild(file: string): Promise<RunnerBuild | null> {
  // The bare prefix also occurs in the binary (this module is bundled into it), so only a full
  // marker counts. latin1 maps every byte to one char; the tail catches a marker split by a chunk.
  const keep = RUNNER_BUILD_PREFIX.length + 46;
  let tail = "";
  const stream = createReadStream(file, { encoding: "latin1", highWaterMark: 1 << 20 });
  try {
    for await (const chunk of stream as AsyncIterable<string>) {
      const text = tail + chunk;
      const m = BUILD_RE.exec(text);
      if (m) return { commit: m[1]!, dirty: m[2] !== undefined };
      tail = text.slice(-keep);
    }
  } finally {
    stream.destroy();
  }
  return null;
}

/** Same as readRunnerBuild, for bytes already in memory. */
export function runnerBuildOf(bytes: Uint8Array): RunnerBuild | null {
  const m = BUILD_RE.exec(
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1"),
  );
  return m ? { commit: m[1]!, dirty: m[2] !== undefined } : null;
}

// ---------- the commit a checkout's runner should carry ----------

interface Pkg {
  dir: string;
  deps: string[];
}

function workspacePackages(repoRoot: string): Map<string, Pkg> {
  const out = new Map<string, Pkg>();
  for (const group of ["packages", "apps"]) {
    const base = join(repoRoot, group);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const pj = join(base, name, "package.json");
      if (!existsSync(pj)) continue;
      const p = JSON.parse(readFileSync(pj, "utf8")) as {
        name?: string;
        dependencies?: Record<string, string>;
      };
      if (!p.name) continue;
      const deps = Object.entries(p.dependencies ?? {})
        .filter(([, v]) => v.startsWith("workspace:"))
        .map(([k]) => k);
      out.set(p.name, { dir: `${group}/${name}`, deps });
    }
  }
  return out;
}

/**
 * The paths (repo-relative) whose content goes into the runner binary: `src/` and `package.json`
 * of @anybench/runner and of every workspace package it depends on (runtime deps, transitively),
 * the build script, and the lockfile. Tests and docs are not inputs.
 */
export function runnerBuildInputs(repoRoot: string): string[] {
  const pkgs = workspacePackages(repoRoot);
  const seen = new Set<string>();
  const queue = ["@anybench/runner"];
  while (queue.length > 0) {
    const n = queue.shift()!;
    if (seen.has(n)) continue;
    const p = pkgs.get(n);
    if (!p) throw new Error(`workspace package ${n} not found under ${repoRoot}`);
    seen.add(n);
    queue.push(...p.deps);
  }
  const paths = [...seen]
    .map((n) => pkgs.get(n)!.dir)
    .sort()
    .flatMap((d) => [`${d}/src`, `${d}/package.json`]);
  return [...paths, "packages/runner/scripts", "pnpm-lock.yaml"];
}

function git(repoRoot: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr ?? "").trim()}`);
  return r.stdout;
}

export interface RunnerSource extends RunnerBuild {
  inputs: string[];
  /** The uncommitted input files (git status --porcelain), when dirty. */
  changed: string[];
}

/** The build the checkout's runner binaries must carry (git log/status over runnerBuildInputs). */
export function runnerSourceBuild(repoRoot: string): RunnerSource {
  const inputs = runnerBuildInputs(repoRoot);
  const commit = git(repoRoot, ["log", "-1", "--format=%H", "HEAD", "--", ...inputs]).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("no commit touches the runner's inputs");
  const changed = git(repoRoot, ["status", "--porcelain", "--", ...inputs])
    .split("\n")
    .map((l) => l.slice(3).trim()) // "XY path"
    .filter(Boolean);
  return { commit, dirty: changed.length > 0, inputs, changed };
}
