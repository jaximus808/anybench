// [3.8] env_build stage (minimal path to real trials): PipelinePort.buildEnv on a real provider.
//
//   kit.env.profile → recipes (base | agent-cc; anything else holds for its ticket)
//   + the runner binary (~/.anybench/bin/runner)
//   + the kit's subject files under ~/kit (adapters/, workloads/, scripts/setup-workspace.sh;
//     never gates/, reference/ or proof/)
//   + every contender's L1 install.sh (+ healthcheck), e.g. the Tandem adapter's install-tandem.sh
//     into ~/.anybench/tandem
//   → snapshot. The snapshot id goes on the run (stage_outputs.env.env_id) and every trial forks it.
//
// Snapshot cache: `envs` (spec_hash, provider). The hash covers the provider, the profile's
// recipes with their pinned versions, the runner binary's sha256, the build size and the subject
// files + installs (their sha256s and staged modes), so a kit re-run with nothing changed forks
// the cached image.
//
// A build failure is OUR failure: the run holds in needs_human with the reason, and nothing is
// billed (the build computer is infrastructure, tagged ab-infra-envbuild-*, outside the registry).
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { KitSpec } from "@anybench/core";
import {
  ArtifactTransferError,
  BASE_RECIPES,
  buildEnvSnapshot,
  envBuildHash,
  EnvBuildError,
  KIT_DIR_REL,
  loadRecipeCatalog,
  recipesForProfile,
  formatRunnerBuild,
  readRunnerBuild,
  resolvedRecipeVersions,
  runnerFromBytes,
  runnerSourceBuild,
  runnerFromUrl,
  sha256File,
  uploadFileWithPlan,
  type ArtifactStore,
  type EnvBuildFile,
  type EnvBuildInstall,
  type RecipeArch,
  type RecipeCatalog,
  type RunnerBuild,
  type RunnerInstaller,
  toolchainRecipes,
  withRecipes,
} from "@anybench/envs";
import { hashKitPaths, KIT_LAYOUT } from "@anybench/kit";
import type { ComputeProvider } from "@anybench/providers";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { envs } from "../db/schema/envs.js";
import { kits } from "../db/schema/kits.js";
import { localKitDir, type KitDirResult } from "./kit-files.js";
import { stageHold, stageOk, type EnvBuild, type PipelinePort } from "./ports.js";

/** Bump to invalidate every cached env image (a change in how images are built). */
export const ENV_BUILD_VERSION = 1;

/**
 * Subject files (plan 17.2 rule 5: answers and gates never reach a subject computer): the
 * adapters, the workloads (input, instruction, setup; answers never live there) and the shared
 * workspace setup script the workloads' setup.sh calls, when the kit has one.
 */
export const SUBJECT_KIT_PATHS = [
  KIT_LAYOUT.adaptersDir,
  KIT_LAYOUT.workloadsDir,
  "scripts/setup-workspace.sh",
] as const;

/** EnvBuild.detail as kitTrialSource reads it back. */
export interface EnvBuildDetail {
  spec_hash: string;
  provider: string;
  profile: string;
  recipes: string[];
  arch: RecipeArch;
  /** Recipe env every trial gets (non-secret). */
  env: Record<string, string>;
  /** PATH prefix from the recipes. */
  path: string[];
  /** Home-relative directory holding the kit's subject files (driver.cwd). */
  kit_dir: string;
  /** The scoring computer's image: the base recipes only (trial.gate forks it). */
  scoring_snapshot_id?: string;
  cached: boolean;
  build_ms?: number;
  /** TDM-247: the commit compiled into the image's runner (part of spec_hash). */
  runner_commit?: string;
}

/** The kit's computer size (env.resources; Naïve's 2 vCPU / 4 GiB / 20 GB when the kit has no env). */
export function kitComputerSize(kit: KitSpec): { vcpu: number; memoryMb: number; diskGb: number } {
  const r = kit.env?.resources;
  return {
    vcpu: r?.vcpu ?? 2,
    memoryMb: (r?.memory_gb ?? 4) * 1024,
    diskGb: r?.disk_gb ?? 20,
  };
}

/** Where the bun-compiled runners are (`pnpm --filter @anybench/runner build:bin`). */
export function defaultRunnerBinDir(override?: string): string {
  if (override) return path.resolve(override);
  // apps/server/{src,dist}/orchestrator → packages/runner/dist/bin
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../packages/runner/dist/bin",
  );
}

const ARCHES: RecipeArch[] = ["x64", "arm64"];

/**
 * TDM-247: the build a worker running from a git checkout must find in packages/runner/dist/bin
 * (the newest commit that changed the runner's inputs). null when the bin dir is overridden (the
 * deployed worker: scripts/deploy/worker.ts checked its release's binaries) or there is no checkout.
 */
export function checkoutRunnerBuild(binDirOverride?: string): RunnerBuild | null {
  if (binDirOverride) return null;
  const repoRoot = path.resolve(defaultRunnerBinDir(), "../../../..");
  if (!existsSync(path.join(repoRoot, ".git"))) return null;
  try {
    return runnerSourceBuild(repoRoot);
  } catch {
    return null;
  }
}

/**
 * The runner for the image. With an artifact store, each binary is uploaded once (keyed by its
 * sha256) and fetched by the computer from a presigned GET; without one it goes by putFile.
 *
 * TDM-247: throws (the stage holds with the message) when a binary carries no build stamp (built
 * before TDM-247, e.g. the Nov 7 runner production ran for two days) or, with `expect`, a build
 * other than the checkout's: a stale runner must not be baked into a cached image.
 */
export async function runnerInstaller(opts: {
  binDir: string;
  artifacts?: Pick<ArtifactStore, "createUpload" | "completeUpload" | "createDownload"> | null;
  expect?: RunnerBuild | null;
}): Promise<RunnerInstaller | null> {
  const files: Partial<Record<RecipeArch, string>> = {};
  const shas: Partial<Record<RecipeArch, string>> = {};
  const builds: Partial<Record<RecipeArch, RunnerBuild>> = {};
  for (const arch of ARCHES) {
    const f = path.join(opts.binDir, `runner-linux-${arch}`);
    try {
      shas[arch] = (await sha256File(f)).sha256;
      files[arch] = f;
    } catch {
      continue; // that arch was not built
    }
    const b = await readRunnerBuild(f);
    const rebuild = "rebuild it: pnpm --filter @anybench/runner build:bin";
    if (!b)
      throw new Error(`env build: ${f} carries no build commit (built before TDM-247); ${rebuild}`);
    if (opts.expect && formatRunnerBuild(b) !== formatRunnerBuild(opts.expect)) {
      throw new Error(
        `env build: ${f} was built from ${formatRunnerBuild(b)}, but this checkout's runner is ${formatRunnerBuild(opts.expect)}; ${rebuild}`,
      );
    }
    builds[arch] = b;
  }
  if (Object.keys(files).length === 0) return null;
  const store = opts.artifacts;
  if (!store) {
    const bins: Partial<Record<RecipeArch, Uint8Array>> = {};
    for (const arch of ARCHES) {
      if (files[arch]) bins[arch] = new Uint8Array(await readFile(files[arch]!));
    }
    return runnerFromBytes(bins);
  }
  return runnerFromUrl({
    sha256: shas,
    build: builds,
    async url(arch) {
      const sha = shas[arch];
      const file = files[arch];
      if (!sha || !file) throw new Error(`no runner binary for ${arch}`);
      const ref = {
        runId: "infra",
        trialId: `runner-${sha.slice(0, 32)}`,
        name: `runner-linux-${arch}`,
      };
      const get = () => store.createDownload({ ...ref, expiresInSec: 3600 });
      try {
        return (await get()).url;
      } catch (err) {
        if (!(err instanceof ArtifactTransferError) || err.code !== "not_found") throw err;
      }
      const size = (await stat(file)).size;
      const plan = await store.createUpload({
        ...ref,
        sizeBytes: size,
        sha256: sha,
        maxBytes: 512 * 1024 * 1024,
      });
      await uploadFileWithPlan(plan, file);
      await store.completeUpload(plan);
      return (await get()).url;
    },
  });
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    (s) => s.isFile(),
    () => false,
  );
}

/**
 * The mode a kit file is staged with (TDM-249): 0755 when it is executable in the kit (any `x`
 * bit: the git checkout's 100755, an uploaded tarball's mode) or is a `.sh` script, else 0644.
 * Every file keeps its bit, whatever its name: `adapters/headless-policy/bin/claude` (a bash
 * script with no suffix) was staged 0644 by the suffix rule alone, so PATH skipped it.
 */
export function stagedMode(relPath: string, fsMode: number): 0o755 | 0o644 {
  return (fsMode & 0o111) !== 0 || relPath.endsWith(".sh") ? 0o755 : 0o644;
}

/**
 * The kit's subject files (adapters/), staged under ~/kit with their modes, and its contenders'
 * installs. `sha256` (the snapshot cache key's subject part) covers the bytes and the modes.
 */
export async function subjectPlan(
  kitDir: string,
  spec: KitSpec,
): Promise<{ files: EnvBuildFile[]; installs: EnvBuildInstall[]; sha256: string }> {
  const present: string[] = [];
  for (const p of SUBJECT_KIT_PATHS) {
    if (
      await stat(path.join(kitDir, p)).then(
        () => true,
        () => false,
      )
    )
      present.push(p);
  }
  const { hash, problems } = await hashKitPaths(kitDir, present);
  if (problems.length > 0) {
    throw new Error(
      `kit subject files: ${problems.map((p) => `${p.path} (${p.kind})`).join(", ")}`,
    );
  }
  const files: EnvBuildFile[] = [];
  const modes: string[] = [];
  for (const f of hash.files) {
    for (const bad of [KIT_LAYOUT.gatesDir, KIT_LAYOUT.referenceDir, KIT_LAYOUT.proofDir]) {
      if (f.path === bad || f.path.startsWith(`${bad}/`)) {
        throw new Error(`refusing to put ${f.path} on a subject computer`);
      }
    }
    const abs = path.join(kitDir, f.path);
    const mode = stagedMode(f.path, (await stat(abs)).mode);
    modes.push(`${mode.toString(8)}  ${f.path}\n`);
    files.push({
      path: `${KIT_DIR_REL}/${f.path}`,
      content: new Uint8Array(await readFile(abs)),
      mode,
    });
  }
  const installs: EnvBuildInstall[] = [];
  const seen = new Set<string>();
  for (const c of spec.contenders) {
    const script = c.install.script ?? KIT_LAYOUT.installScript(c.id);
    if (!(await exists(path.join(kitDir, script)))) continue; // nothing to install
    let healthcheck = c.install.healthcheck;
    if (
      healthcheck === undefined &&
      (await exists(path.join(kitDir, KIT_LAYOUT.healthcheckScript(c.id))))
    ) {
      healthcheck = KIT_LAYOUT.healthcheckScript(c.id);
    }
    const env = { ...(c.versions ?? {}) };
    const key = JSON.stringify([script, healthcheck, env]);
    if (seen.has(key)) continue;
    seen.add(key);
    installs.push({
      name: c.id,
      script: `${KIT_DIR_REL}/${script}`,
      ...(healthcheck ? { healthcheck: `${KIT_DIR_REL}/${healthcheck}` } : {}),
      env,
    });
  }
  // The kit hash leaves modes out (a copy hashes the same anywhere); the image's does not, so a
  // file that gains or loses its executable bit builds a new snapshot (TDM-249).
  const sha256 = createHash("sha256")
    .update(`${hash.sha256}\nmodes\n${modes.join("")}`)
    .digest("hex");
  return { files, installs, sha256 };
}

/** The scoring image: base recipes (Node for the gates), no runner, no kit file, ever. */
export const SCORING_RECIPES = BASE_RECIPES;

function buildErrorText(err: unknown): string {
  if (err instanceof EnvBuildError) {
    return `${err.message}${err.output ? `\n${err.output.slice(-1500)}` : ""}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export interface EnvBuildDeps {
  db: Database;
  provider: ComputeProvider;
  runner: () => Promise<RunnerInstaller | null>;
  catalog?: () => Promise<RecipeCatalog>;
  /**
   * The kit's files as a local directory (TDM-218: an uploaded kit's artifact: tarball is
   * unpacked). Default: localKitDir with no artifact store (file:// only).
   */
  kitDir?: (filesUrl: string) => Promise<KitDirResult>;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

/** A user-facing line for an envs build log message, or null for the ones not worth showing. */
export function envBuildProgressText(msg: string, data?: Record<string, unknown>): string | null {
  switch (msg) {
    case "env build computer created":
      return "booted a Naïve computer";
    case "env build create retry":
      return "Naïve is at capacity; retrying";
    case "recipes installed":
      return "installed the base toolchain";
    case "runner installed":
      return "installed the Anybench runner";
    case "subject files staged":
      return "staged the kit files";
    case "contender installed":
      return `installed ${typeof data?.name === "string" ? data.name : "a contender"}`;
    case "snapshot taken":
      return "snapshot saved; every trial forks from it";
    default:
      return null;
  }
}

/** PipelinePort.buildEnv on a real provider with the envs snapshot cache. */
export function providerEnvBuild(deps: EnvBuildDeps): PipelinePort["buildEnv"] {
  return async (ctx, input) => {
    // Progress the live run page can show (agent card "env_builder"); never fails the build.
    const say = async (text: string): Promise<void> => {
      if (typeof ctx.emit !== "function") return;
      await ctx
        .emit([
          {
            type: "agent.message",
            source: "agent_session",
            source_id: "env_build:env_builder",
            severity: "info",
            actor: { kind: "system" },
            cost_delta_micro_usd: 0n,
            at: new Date().toISOString(),
            payload: {
              agent_role: "env_builder",
              naive_seq: 0,
              message_role: "system",
              text,
              truncated: false,
            },
          },
        ])
        .catch(() => undefined);
    };
    const progress =
      (image: string) =>
      (msg: string, data?: Record<string, unknown>): void => {
        deps.log?.(image === "trial image" ? msg : `${image}: ${msg}`, data);
        const text = envBuildProgressText(msg, data);
        if (text) void say(`${image}: ${text}`);
      };
    const kit = input.kit;
    const profile = kit.env?.profile ?? "base";
    const profileRecipes = recipesForProfile(profile);
    if (!profileRecipes) {
      return stageHold(`env profile '${profile}' is not built yet ([3.9]); base and agent-cc are`);
    }
    const [row] = await deps.db
      .select({ filesUrl: kits.filesUrl })
      .from(kits)
      .where(eq(kits.id, input.kit_id));
    if (!row?.filesUrl) {
      return stageHold(`env build: kit ${input.kit_id} has no files_url (none)`);
    }
    const local = await (deps.kitDir ?? ((u: string) => localKitDir(u)))(row.filesUrl);
    if (!local.ok) return stageHold(`env build: kit ${input.kit_id}: ${local.reason}`);
    const kitDir = local.dir;
    const catalog = await (deps.catalog ?? (() => loadRecipeCatalog()))();
    // TDM-60: the kit's declared toolchains go on BOTH images: the subject runs the project's
    // tests while it works, and the scoring image runs the hidden tests. Unknown → hold.
    const tools = toolchainRecipes(catalog, kit.env?.toolchains ?? []);
    if (!tools.ok) return stageHold(`env build: ${tools.reason}`);
    const requested = withRecipes(profileRecipes, tools.recipes);
    const scoringRecipes = withRecipes(SCORING_RECIPES, tools.recipes);
    let runner: RunnerInstaller | null;
    try {
      runner = await deps.runner();
    } catch (err) {
      return stageHold(err instanceof Error ? err.message : String(err));
    }
    if (!runner) {
      return stageHold(
        "env build: no runner binary (pnpm --filter @anybench/runner build:bin, or ANYBENCH_RUNNER_BIN_DIR)",
      );
    }
    let subject: Awaited<ReturnType<typeof subjectPlan>>;
    try {
      subject = await subjectPlan(kitDir, kit);
    } catch (err) {
      return stageHold(`env build: ${err instanceof Error ? err.message : String(err)}`);
    }
    const recipes = resolvedRecipeVersions(catalog, requested);
    const spec = kitComputerSize(kit);
    // Every arch's runner sha: the image's arch is only known once the computer is up.
    const runnerShas = ARCHES.flatMap((a) => {
      try {
        return [`${a}:${runner.sha256(a)}`];
      } catch {
        return [];
      }
    });
    // TDM-247: the runner's commit is in the key too (the sha already changes with it): an image
    // baked with an older runner is never forked for a trial that needs the current one.
    const runnerCommits = ARCHES.flatMap((a) => {
      if (!runnerShas.some((s) => s.startsWith(`${a}:`))) return [];
      const b = runner.build?.(a);
      return b ? [`${a}:${formatRunnerBuild(b)}`] : [];
    });
    const runnerCommitOn = (arch: RecipeArch) => {
      const hit = runnerCommits.find((c) => c.startsWith(`${arch}:`));
      return hit ? { runner_commit: hit.slice(arch.length + 1) } : {};
    };
    const specHash = envBuildHash({
      v: ENV_BUILD_VERSION,
      provider: deps.provider.name,
      profile,
      recipes,
      runner: runnerShas,
      ...(runnerCommits.length > 0 ? { runner_commit: runnerCommits } : {}),
      spec,
      subject: subject.sha256,
      installs: subject.installs,
    });

    const scoringHash = envBuildHash({
      v: ENV_BUILD_VERSION,
      provider: deps.provider.name,
      scoring: true,
      recipes: resolvedRecipeVersions(catalog, scoringRecipes),
    });
    const cachedSnapshot = async (hash: string) => {
      const [row] = await deps.db
        .select()
        .from(envs)
        .where(
          and(
            eq(envs.specHash, hash),
            eq(envs.provider, deps.provider.name),
            isNotNull(envs.snapshotId),
          ),
        );
      return row ?? null;
    };
    const saveSnapshot = async (hash: string, prof: string, snapshotId: string, health: object) => {
      await deps.db
        .insert(envs)
        .values({
          specHash: hash,
          profile: prof,
          provider: deps.provider.name,
          snapshotId,
          builtAt: new Date(),
          health,
        })
        .onConflictDoUpdate({
          target: [envs.specHash, envs.provider],
          set: { snapshotId, builtAt: sql`now()`, health },
        });
    };
    /** The scoring image, cached; built alongside the subject image when missing. */
    const scoringImage = async (): Promise<string> => {
      const hit = await cachedSnapshot(scoringHash);
      if (hit?.snapshotId) return hit.snapshotId;
      const b = await buildEnvSnapshot({
        provider: deps.provider,
        spec: { vcpu: 2, memoryMb: 4096, diskGb: 20 },
        label: `scoring-${scoringHash.slice(0, 12)}`,
        recipes: scoringRecipes,
        catalog,
        runId: ctx.run.id,
        signal: ctx.signal,
        log: progress("scoring image"),
      });
      await saveSnapshot(scoringHash, "scoring", b.snapshotId, { recipes: scoringRecipes });
      return b.snapshotId;
    };

    const cached = await cachedSnapshot(specHash);
    if (cached?.snapshotId) {
      const health = (cached.health ?? {}) as Partial<EnvBuildDetail>;
      let scoringSnapshotId: string;
      try {
        scoringSnapshotId = await scoringImage();
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        return stageHold(
          `env build failed (ours, not billed): scoring image: ${buildErrorText(err)}`,
        );
      }
      deps.log?.("env build: cache hit", { specHash, snapshotId: cached.snapshotId });
      void say("trial image: already built for this kit; reusing the snapshot");
      const detail: EnvBuildDetail = {
        spec_hash: specHash,
        provider: deps.provider.name,
        profile,
        recipes,
        arch: health.arch ?? "x64",
        env: health.env ?? {},
        path: health.path ?? [],
        kit_dir: KIT_DIR_REL,
        scoring_snapshot_id: scoringSnapshotId,
        ...runnerCommitOn(health.arch ?? "x64"),
        cached: true,
      };
      return stageOk<EnvBuild>({ env_id: cached.snapshotId, detail: { ...detail } });
    }

    // Both images at once; wait for BOTH to settle (each destroys its own computer) before answering.
    const [subjectRes, scoringRes] = await Promise.allSettled([
      buildEnvSnapshot({
        provider: deps.provider,
        spec,
        label: specHash.slice(0, 12),
        recipes: requested,
        catalog,
        runner,
        files: subject.files,
        installs: subject.installs,
        runId: ctx.run.id,
        signal: ctx.signal,
        log: progress("trial image"),
      }),
      scoringImage(),
    ]);
    if (ctx.signal.aborted) throw new Error("env build aborted");
    if (subjectRes.status === "rejected" || scoringRes.status === "rejected") {
      if (subjectRes.status === "fulfilled") {
        // Keep the good image: the retry after a human resumes the run hits the cache.
        await saveSnapshot(specHash, profile, subjectRes.value.snapshotId, {
          spec_hash: specHash,
          arch: subjectRes.value.arch,
          env: subjectRes.value.recipes.env,
          path: subjectRes.value.recipes.path,
        });
      }
      const why = [subjectRes, scoringRes]
        .map((r, i) =>
          r.status === "rejected"
            ? `${i === 0 ? "" : "scoring image: "}${buildErrorText(r.reason)}`
            : null,
        )
        .filter(Boolean)
        .join("; ");
      // Our failure: hold for a human, never bill the user.
      return stageHold(`env build failed (ours, not billed): ${why}`);
    }
    const built = subjectRes.value;
    const scoringSnapshotId = scoringRes.value;
    const detail: EnvBuildDetail = {
      spec_hash: specHash,
      provider: deps.provider.name,
      profile,
      recipes,
      arch: built.arch,
      env: built.recipes.env,
      path: built.recipes.path,
      kit_dir: KIT_DIR_REL,
      scoring_snapshot_id: scoringSnapshotId,
      cached: false,
      build_ms: built.durationMs,
      ...runnerCommitOn(built.arch),
    };
    await saveSnapshot(specHash, profile, built.snapshotId, { ...detail });
    return stageOk<EnvBuild>({ env_id: built.snapshotId, detail: { ...detail } });
  };
}
