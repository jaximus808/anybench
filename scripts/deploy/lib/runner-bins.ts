// TDM-247: the worker release ships only runner binaries built from the deploying checkout.
//
// Until TDM-247 the deploy ran `build:bin` only when a binary was missing, so every deploy from
// Nov 7 on shipped the Nov 7 runner (docs/findings/harness-league-run-1.md §2): the TDM-231 and
// TDM-239 meter fixes never reached a trial. Now each binary's compiled-in build (packages/envs
// runner-stamp.ts) must equal the checkout's runner build. If one does not, the deploy rebuilds it;
// if it still does not (or --skip-build), the deploy refuses, and so does bundleWorkerRelease.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { formatRunnerBuild, readRunnerBuild, type RunnerBuild } from "@anybench/envs";

export const RUNNER_ARCHES = ["x64", "arm64"] as const;
export type RunnerArch = (typeof RUNNER_ARCHES)[number];

export interface RunnerBinState {
  arch: RunnerArch;
  file: string;
  /** null: no binary; "unstamped": a binary without a build (built before TDM-247). */
  build: RunnerBuild | "unstamped" | null;
}

export interface RunnerBinsVerdict {
  ok: boolean;
  /** One line per binary that is not the checkout's build. */
  problems: string[];
}

export function runnerBinPath(repoRoot: string, arch: RunnerArch): string {
  return join(repoRoot, `packages/runner/dist/bin/runner-linux-${arch}`);
}

/** What each runner binary in the checkout carries. */
export async function inspectRunnerBins(repoRoot: string): Promise<RunnerBinState[]> {
  return Promise.all(
    RUNNER_ARCHES.map(async (arch) => {
      const file = runnerBinPath(repoRoot, arch);
      if (!existsSync(file)) return { arch, file, build: null };
      return { arch, file, build: (await readRunnerBuild(file)) ?? "unstamped" };
    }),
  );
}

/** Every arch present and built from `want` (the checkout's runnerSourceBuild). */
export function judgeRunnerBins(
  bins: readonly RunnerBinState[],
  want: RunnerBuild,
): RunnerBinsVerdict {
  const w = formatRunnerBuild(want);
  const problems: string[] = [];
  for (const b of bins) {
    const name = `runner-linux-${b.arch}`;
    if (b.build === null) problems.push(`${name} is missing`);
    else if (b.build === "unstamped")
      problems.push(`${name} carries no build commit (pre-TDM-247)`);
    else if (formatRunnerBuild(b.build) !== w)
      problems.push(`${name} was built from ${formatRunnerBuild(b.build)}, not ${w}`);
  }
  return { ok: problems.length === 0, problems };
}

export interface EnsureRunnerBinsDeps {
  inspect: () => Promise<RunnerBinState[]>;
  /** `pnpm --filter @anybench/runner build:bin`; throws on failure. */
  build: () => void;
  log: (step: string, data?: Record<string, unknown>) => void;
}

/**
 * Rebuild the runner binaries unless every one already carries `want`, then check again and throw
 * if any still does not. `allowBuild: false` (--skip-build) only checks.
 */
export async function ensureRunnerBins(
  deps: EnsureRunnerBinsDeps,
  want: RunnerBuild,
  opts: { allowBuild: boolean },
): Promise<{ rebuilt: boolean }> {
  const before = judgeRunnerBins(await deps.inspect(), want);
  if (before.ok) {
    deps.log("runner binaries current", { build: formatRunnerBuild(want) });
    return { rebuilt: false };
  }
  if (!opts.allowBuild) {
    throw new Error(
      `stale runner binaries, refusing to ship them (--skip-build): ${before.problems.join("; ")}`,
    );
  }
  deps.log("rebuild runner binaries", { reasons: before.problems });
  deps.build();
  const after = judgeRunnerBins(await deps.inspect(), want);
  if (!after.ok) {
    throw new Error(
      `runner binaries still not built from this checkout: ${after.problems.join("; ")}`,
    );
  }
  deps.log("runner binaries rebuilt", { build: formatRunnerBuild(want) });
  return { rebuilt: true };
}
