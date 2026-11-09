#!/usr/bin/env node
// Compile the runner into standalone binaries (no Node needed on the eval computer):
//   dist/bin/runner-linux-x64, dist/bin/runner-linux-arm64
// Uses `bun` from PATH, or ~/.bun/bin/bun. Run `pnpm -r build` first so workspace deps have dist/.
// Usage: node scripts/build-bin.mjs [x64|arm64 ...]
//
// TDM-247: the binary carries `anybench-runner-build:<commit>[-dirty]` (bun --define), the newest
// commit that changed the runner's build inputs (@anybench/envs runnerSourceBuild). `runner
// --version` prints it; scripts/deploy/worker.ts and the env build read it back from the bytes
// and rebuild or refuse a binary whose commit is not the checkout's.

/* global process, console */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runnerBuildMarker, runnerSourceBuild } from "@anybench/envs";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = join(homedir(), ".bun", "bin", "bun");
const bun = process.env.BUN ?? (spawnSync("bun", ["--version"]).status === 0 ? "bun" : home);
if (bun === home && !existsSync(home)) {
  console.error("bun not found: install it (curl -fsSL https://bun.sh/install | bash) or set BUN");
  process.exit(1);
}

const repoRoot = join(pkgDir, "..", "..");
const source = runnerSourceBuild(repoRoot);
const marker = runnerBuildMarker(source);
console.log(
  `runner build ${marker.slice("anybench-runner-build:".length)}` +
    (source.dirty ? ` (uncommitted: ${source.changed.slice(0, 5).join(", ")})` : ""),
);

const targets = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["x64", "arm64"];
mkdirSync(join(pkgDir, "dist", "bin"), { recursive: true });
for (const arch of targets) {
  const outfile = join(pkgDir, "dist", "bin", `runner-linux-${arch}`);
  const args = [
    "build",
    "src/cli.ts",
    "--compile",
    "--minify",
    `--target=bun-linux-${arch}`,
    "--define",
    `__ANYBENCH_RUNNER_BUILD__=${JSON.stringify(marker)}`,
    "--outfile",
    outfile,
  ];
  console.log(`$ ${bun} ${args.join(" ")}`);
  const r = spawnSync(bun, args, { cwd: pkgDir, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
