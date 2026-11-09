// Deploy the graphile worker to a long-lived Naïve computer (worker-naive). Idempotent; re-run any
// time, and it doubles as the backstop if the on-host rotator ever misses the 12 h limit:
//
//   pnpm tsx scripts/deploy/worker.ts [--dry-run] [--status] [--down] [--force]
//                                     [--skip-build] [--skip-migrate]
//
// Steps: read .env (never printed) → build server and its workspace deps → rebuild the runner
// binaries unless they carry this checkout's runner commit (TDM-247) → bundle the release
// (dist/worker.js + dist/rotate.js + kits, recipes, agent roles, runner binaries, package.json) →
// migrate DATABASE_URL_DIRECT (dev) → put the release tarball in the artifact store (once per
// release id) → keep the newest worker computer if it runs this release and env and heartbeats,
// else hand off to a new one (worker-reconcile.ts: provision, stop old, start new, heartbeat,
// delete old). The worker runs under systemd (Restart=always) with a 15 min rotator timer that
// hands off to a successor at 10 h, before Naïve destroys the computer at 12 h.
//
//   --dry-run   build + bundle, print the plan (secret NAMES only), cost per day; no network.
//   --status    list worker computers, their supervisor state and heartbeat; no writes.
//   --down      stop and delete every worker computer (back to running the worker elsewhere).
//   --force     replace the worker computer even when nothing changed.
//   --skip-build  no build; the runner binaries must already carry this checkout's runner commit.
//
// TDM-247: the runner commit is the newest commit that changed the runner's build inputs
// (@anybench/envs runnerSourceBuild). A deploy with uncommitted changes to them is refused; a
// binary built from another commit is rebuilt, and refused if it still differs. The successor
// must report the same commit from `runner --version` before the old worker is stopped.
//
// Safety: BILLING_MODE must be test or live; the Neon URLs must not be the prod branch's. Secrets reach the
// computer only as an fs write body (~/.anybench/worker.env, mode 600), never argv or a log line.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatUsd } from "@anybench/core";
import { formatRunnerBuild, runnerSourceBuild, type RunnerSource } from "@anybench/envs";
import { findEnvFile, readEnvFile } from "./lib/api-plan.js";
import { ensureRunnerBins, inspectRunnerBins } from "./lib/runner-bins.js";
import { bundleWorkerRelease, writeReleaseTarball } from "./lib/worker-bundle.js";
import {
  liveNaive,
  liveReconcileDeps,
  releaseStore,
  storedRelease,
  uploadRelease,
} from "./lib/worker-deps.js";
import {
  BOOTSTRAP_PHASES,
  bootstrapCommand,
  envFingerprint,
  parseWorkerDeployEnv,
  planWorkerEnv,
  workerEnvPlanSummary,
  releaseArtifactRef,
  renderBootstrap,
  renderEnvFile,
  workerComputerName,
  workerCost,
  WorkerManifestSchema,
  type WorkerManifest,
} from "./lib/worker-plan.js";
import {
  hostStatus,
  listWorkerComputers,
  reconcileDeploy,
  type ReconcileDeps,
} from "./lib/worker-reconcile.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const FLAGS = ["dry-run", "status", "down", "force", "skip-build", "skip-migrate"] as const;
const args = new Set(process.argv.slice(2));
for (const a of args) {
  if (!FLAGS.map((f) => `--${f}`).includes(a)) throw new Error(`unknown argument ${a}`);
}
const flag = (name: (typeof FLAGS)[number]) => args.has(`--${name}`);

const say = (step: string, data?: Record<string, unknown>) =>
  console.log(`[deploy:worker] ${step}${data ? ` ${JSON.stringify(data)}` : ""}`);
const usd = (m: bigint) => formatUsd(m, { decimals: 4 });

function sh(cmd: string, argv: string[]): string {
  const r = spawnSync(cmd, argv, { cwd: repoRoot, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

function buildRunnerBins(): void {
  say("build runner binaries", { cmd: "pnpm --filter @anybench/runner build:bin" });
  const b = spawnSync("pnpm", ["--filter", "@anybench/runner", "build:bin"], {
    cwd: repoRoot,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (b.status !== 0) throw new Error(`runner build:bin failed (exit ${b.status})`);
}

/** TDM-247: rebuild or refuse runner binaries that are not this checkout's runner build. */
async function ensureRunner(source: RunnerSource, allowBuild: boolean): Promise<void> {
  await ensureRunnerBins(
    { inspect: () => inspectRunnerBins(repoRoot), build: buildRunnerBins, log: say },
    source,
    { allowBuild },
  );
}

function buildWorkspace(): void {
  say("build", { cmd: "pnpm -r --workspace-concurrency=2 --filter server... build" });
  // process.env never holds the .env values (they stay in `raw` below), so nothing leaks here.
  const r = spawnSync(
    "pnpm",
    ["-r", "--workspace-concurrency=2", "--filter", "server...", "build"],
    {
      cwd: repoRoot,
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  if (r.status !== 0) throw new Error(`build failed (exit ${r.status})`);
}

async function main(): Promise<void> {
  const envFile = findEnvFile(repoRoot, process.env.ANYBENCH_ENV_FILE);
  const env = parseWorkerDeployEnv(readEnvFile(envFile));
  const size = {
    vcpu: env.DEPLOY_WORKER_VCPU,
    memoryMb: env.DEPLOY_WORKER_MEMORY_MB,
    diskGb: env.DEPLOY_WORKER_DISK_GB,
  };
  const rotateAfterMs = env.DEPLOY_WORKER_ROTATE_AFTER_HOURS * 3600_000;
  say("env", { file: envFile, size, rotate_after_h: env.DEPLOY_WORKER_ROTATE_AFTER_HOURS });

  const workerVars = planWorkerEnv(env);
  const workerEnvFile = renderEnvFile(workerVars as Record<string, string>);
  const bootstrap = renderBootstrap();
  const cost = workerCost(size, rotateAfterMs);

  const naive = () => liveNaive(env.NAIVE_API_KEY, env.NAIVE_BASE_URL);
  const store = () => releaseStore(env);
  const deps = (): ReconcileDeps =>
    liveReconcileDeps({
      naive: naive(),
      databaseUrlDirect: env.DATABASE_URL_DIRECT,
      store: store(),
      log: say,
    });

  if (flag("status") || flag("down")) {
    const d = deps();
    const workers = await listWorkerComputers(d.computers);
    say("worker computers", { count: workers.length });
    for (const w of workers) {
      const st = await hostStatus(d, w.id).catch((e: unknown) => ({ error: (e as Error).message }));
      const beat = "host" in st ? await d.heartbeat(st.host, 0).catch(() => undefined) : undefined;
      say("worker", { ...w, ...st, ...(beat ?? {}) });
      if (flag("down")) {
        await d.computers
          .exec(w.id, bootstrapCommand("stop"), { timeoutMs: 300_000 })
          .catch(() => undefined);
        await d.computers.delete(w.id);
        say("deleted", { id: w.id });
      }
    }
    return;
  }

  // The env build ships the runner binaries into every trial image (gitignored output, needs bun).
  const runnerSource = runnerSourceBuild(repoRoot);
  say("runner source", {
    commit: formatRunnerBuild(runnerSource),
    ...(runnerSource.dirty ? { uncommitted: runnerSource.changed } : {}),
  });
  if (runnerSource.dirty && !flag("dry-run")) {
    throw new Error(
      `uncommitted changes to the runner's inputs (${runnerSource.changed.slice(0, 5).join(", ")}): commit them first, so the runner reports the commit it was built from`,
    );
  }
  if (!flag("skip-build")) buildWorkspace();
  await ensureRunner(runnerSource, !flag("skip-build"));
  const release = await bundleWorkerRelease({
    repoRoot,
    workerEntry: join(repoRoot, "apps/server/dist/worker.js"),
    rotateEntry: join(here, "worker-rotate.ts"),
    runnerBuild: runnerSource,
  });
  for (const w of release.warnings) say("warning", { bundle: w });
  const files = release.entries.length;
  say("release", {
    id: release.id,
    files,
    bytes: release.totalBytes,
    top: [...new Set(release.entries.map((e) => e.path.split("/")[0]))].sort(),
    dependencies: release.dependencies,
  });
  const commit = sh("git", ["rev-parse", "--short=12", "HEAD"]) || "unknown";
  const ref = releaseArtifactRef(release.id);

  if (flag("dry-run")) {
    const bashCheck = spawnSync("bash", ["-n"], { input: bootstrap, encoding: "utf8" });
    say("dry run: worker env file (names only)", workerEnvPlanSummary(workerVars, workerEnvFile));
    say("dry run: computer", {
      name: workerComputerName(release.id, envFingerprint(workerEnvFile)),
      ...size,
      rotate_after_h: env.DEPLOY_WORKER_ROTATE_AFTER_HOURS,
      naive_lifetime_h: 12,
    });
    say("dry run: release artifact", {
      ...ref,
      commit,
      runner_commit: formatRunnerBuild(runnerSource),
    });
    say("dry run: bootstrap.sh", {
      phases: BOOTSTRAP_PHASES,
      bytes: bootstrap.length,
      bash_n: bashCheck.status === 0 ? "ok" : bashCheck.stderr.trim(),
      supervisor:
        "systemd anybench-worker.service (Restart=always) + anybench-worker-rotate.timer (15 min); setsid loop without systemd",
    });
    say("dry run: steps", {
      steps: [
        "migrate DATABASE_URL_DIRECT (dev)",
        `artifact store: upload the release tarball unless ${ref.trialId} exists`,
        "list ab-infra-worker computers; keep the newest if release+env match, age < rotation and it heartbeats",
        "else: create successor → fs write env/curl/manifest/bootstrap → bootstrap install → runner-version must print runner_commit",
        "stop old worker (SIGTERM, 120 s drain) → copy generated kits → start successor",
        "wait for the successor's worker_heartbeats row (ticks ≥ 2, age < 60 s) → delete old computer",
      ],
    });
    say("dry run: cost (integer micro-USD)", {
      per_block_10min: String(cost.perBlockMicroUsd),
      compute_per_day: String(cost.computePerDayMicroUsd),
      handoffs_per_day: cost.handoffsPerDay,
      handoff_overhead_per_day_max: String(cost.handoffPerDayMicroUsd),
      total_per_day: `${cost.totalPerDayMicroUsd} (${usd(cost.totalPerDayMicroUsd)})`,
      total_per_30_days: `${cost.totalPer30DaysMicroUsd} (${usd(cost.totalPer30DaysMicroUsd)})`,
    });
    return;
  }

  if (!flag("skip-migrate")) {
    const server = await import("server");
    say("migrate", { host: new URL(env.DATABASE_URL_DIRECT).hostname });
    await server.db.runMigrations(env.DATABASE_URL_DIRECT);
    say("migrate done");
  }

  const client = naive();
  const before = await client.credits.show().catch(() => undefined);
  if (before) say("credits before", { balance: usd(before.balanceMicroUsd) });

  const s3 = store();
  let stored = await storedRelease(s3, ref);
  if (!stored) {
    const dir = mkdtempSync(join(tmpdir(), "anybench-worker-tgz-"));
    try {
      const tgz = join(dir, "release.tar.gz");
      const meta = await writeReleaseTarball(release, tgz);
      say("release tarball", meta);
      await uploadRelease(s3, ref, tgz, meta);
      stored = meta;
      say("release uploaded", { ...ref });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } else {
    say("release already stored", { ...ref, ...stored });
  }
  const manifest: WorkerManifest = WorkerManifestSchema.parse({
    version: 1,
    release: { id: release.id, sha256: stored.sha256, sizeBytes: stored.sizeBytes, artifact: ref },
    size,
    rotateAfterMs,
    commit,
    runnerCommit: formatRunnerBuild(runnerSource),
    builtAt: new Date().toISOString(),
  });

  const result = await reconcileDeploy(
    deps(),
    {
      manifest,
      envFile: workerEnvFile,
      bootstrap,
    },
    { force: flag("force") },
  );
  say("done", {
    decision: result.decision.kind,
    ...(result.handoff ? { successor: result.handoff.successor, host: result.handoff.host } : {}),
  });

  const after = await client.credits.show().catch(() => undefined);
  if (before && after) {
    say("credits after", {
      balance: usd(after.balanceMicroUsd),
      spent_micro_usd: String(before.balanceMicroUsd - after.balanceMicroUsd),
    });
  }
}

main().catch((err: unknown) => {
  // Messages come from our own validation, Naïve error codes or bootstrap.sh; none carries a value.
  console.error(`[deploy:worker] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
