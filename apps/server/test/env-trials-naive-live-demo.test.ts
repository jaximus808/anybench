// demo-env-trials LIVE: one real trial on Naïve, end to end through the real jobs.
//   env_build (providerEnvBuild: base recipes + runner + kit subject files + contender install
//   → snapshot) → trial.execute (default options: NaiveProvider, kitTrialSource, fs/read bundle
//   fallback to S3) → trial.gate (default options: scoring computer on Naïve, bundle from S3).
// The kit is the curated Tandem kit's smoke profile (todo-api, 1 repeat) and the trial is contender
// A (claude-code-solo: headless Claude Code 2.1.319, anthropic/claude-sonnet-4.6 through the Naïve
// model proxy, a per-trial proxy:write key minted, enforced and revoked by the executor).
//
// Spends Naïve credit (model tokens capped by TRIAL_PROXY_CAP_MICRO_USD, default here $2, plus the
// computers): runs only with NAIVE_LIVE=1, a key, S3 and local Postgres.
//   cd apps/server && NAIVE_LIVE=1 node --env-file=<repo>/.env ../../node_modules/vitest/vitest.mjs \
//     run test/env-trials-naive-live-demo.test.ts --reporter=verbose
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadKit } from "@anybench/kit";
import { createNaiveClient, liveProxyKeys } from "@anybench/naive";
import { trialTag } from "@anybench/providers";
import { eq } from "drizzle-orm";
import type { JobHelpers } from "graphile-worker";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { computers, contenders, kits, runs, trials } from "../src/db/schema/index.js";
import { defaultTrialExecuteOptions, createTrialExecuteJob } from "../src/jobs/trial-execute.js";
import { trialGateJob } from "../src/jobs/trial-gate.js";
import type { JobContext } from "../src/jobs/types.js";
import { artifactStoreFromEnv, computeProviderFromConfig } from "../src/lib/compute.js";
import {
  defaultRunnerBinDir,
  providerEnvBuild,
  runnerInstaller,
} from "../src/orchestrator/env-build.js";
import { freshMigratedDbTdm11, pgAvailableTdm11 } from "./helpers/pg-tdm11.js";
import { seedUserTdm67 } from "./helpers/runs-tdm67.js";
import { createLogger } from "../src/lib/logger.js";
import { smokeProfile } from "../src/orchestrator/curated.js";
import { recordingSentryTdm14 } from "./helpers/server-tdm14.js";

const LIVE =
  process.env.NAIVE_LIVE === "1" && !!process.env.NAIVE_API_KEY && !!process.env.S3_BUCKET;
const TANDEM_KIT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../kits/tandem-vs-claude-code",
);
const CONTENDER = process.env.DEMO_CONTENDER ?? "claude-code-solo";
const PROXY_CAP = process.env.DEMO_PROXY_CAP_MICRO_USD ?? "2000000";
const log = (msg: string, data: unknown = {}) =>
  console.log(
    `DEMO-LIVE ${msg} ${JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`,
  );

describe.skipIf(!LIVE)("env build + trial on Naïve (live)", () => {
  const cleanups: (() => Promise<unknown>)[] = [];
  afterAll(async () => {
    for (const c of cleanups.reverse())
      await c().catch((e: unknown) => log("cleanup failed", String(e)));
  });

  it(
    "builds the env, runs one trial through gating, revokes its proxy key, leaves nothing running",
    async () => {
      expect(await pgAvailableTdm11()).toBe(true);
      const h = await freshMigratedDbTdm11();
      cleanups.push(() => h.drop());
      const config = loadConfig({
        DATABASE_URL: h.url,
        DATABASE_URL_DIRECT: h.url,
        LOG_LEVEL: "info",
        NAIVE_API_KEY: process.env.NAIVE_API_KEY!,
        TRIAL_PROXY_CAP_MICRO_USD: PROXY_CAP,
        ...(process.env.NAIVE_BASE_URL ? { NAIVE_BASE_URL: process.env.NAIVE_BASE_URL } : {}),
      });
      const naive = createNaiveClient({
        apiKey: config.NAIVE_API_KEY!,
        ...(config.NAIVE_BASE_URL ? { baseUrl: config.NAIVE_BASE_URL } : {}),
      });
      const before = await naive.credits.show();
      log("balance before", before);

      // The kit: the curated Tandem kit, smoke profile (what CuratedKitStage gives the Tandem repo).
      const loaded = await loadKit(TANDEM_KIT);
      const smoke = smokeProfile(loaded.spec);
      if (!smoke.ok) throw new Error(smoke.reason);
      const spec = smoke.spec;

      const db = h.db;
      const userId = await seedUserTdm67(db, "demo-live");
      const [run] = await db
        .insert(runs)
        .values({
          ownerId: userId,
          question: "demo-env-trials live",
          state: "running",
          budgetMicroUsd: 5_000_000n,
        })
        .returning();
      const [kit] = await db
        .insert(kits)
        .values({
          ownerId: userId,
          runId: run!.id,
          version: 1,
          spec,
          filesUrl: pathToFileURL(TANDEM_KIT).href,
          hash: "d".repeat(64),
        })
        .returning();
      await db.update(runs).set({ kitId: kit!.id }).where(eq(runs.id, run!.id));
      const [cont] = await db
        .insert(contenders)
        .values({
          runId: run!.id,
          kitId: kit!.id,
          source: CONTENDER,
          role: "baseline",
          foundBy: "kit",
          status: "kept",
        })
        .returning();
      const [trial] = await db
        .insert(trials)
        .values({
          ownerId: userId,
          runId: run!.id,
          contenderId: cont!.id,
          workloadId: "todo-api",
          repeat: 0,
        })
        .returning();
      const tag = trialTag(run!.id, trial!.id);

      const provider = computeProviderFromConfig(config)!;
      const artifacts = artifactStoreFromEnv()!;

      // 1. env_build.
      const t0 = Date.now();
      const build = providerEnvBuild({
        db,
        provider,
        runner: () => runnerInstaller({ binDir: defaultRunnerBinDir(), artifacts }),
        log: (m, d) => log(`env: ${m}`, d),
      });
      const ac = new AbortController();
      const env = await build(
        {
          run: {
            id: run!.id,
            owner_id: userId,
            project_id: null,
            question: "",
            intake: { source: { kind: "github", github: "x/y" }, contenders: [], auto_go: true },
            budget_micro_usd: 5_000_000n,
            spent_micro_usd: 0n,
          },
          idempotencyKey: `${run!.id}:env_build:1`,
          signal: ac.signal,
          emit: async () => undefined,
        } as never,
        { kit_id: kit!.id, kit: spec },
      );
      log("env build result", { ...env, ms: Date.now() - t0 });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      const envValue = env.value as { env_id: string; detail: Record<string, unknown> };
      cleanups.push(() => provider.deleteSnapshot(envValue.env_id));
      const scoringSnap = envValue.detail.scoring_snapshot_id as string | undefined;
      if (scoringSnap) cleanups.push(() => provider.deleteSnapshot(scoringSnap));
      await db
        .update(runs)
        .set({ stageOutputs: { env: envValue } })
        .where(eq(runs.id, run!.id));
      cleanups.push(async () => {
        for (const c of await provider.list({ tag })) await provider.destroy(c.id);
      });

      // 2. trial.execute with the production options.
      const ctx: JobContext = {
        config,
        logger: createLogger({ level: "info" }),
        db,
        sentry: recordingSentryTdm14(),
        workerId: "demo-live",
        workerStartedAt: new Date(Date.now() - 1000),
      };
      const added: { task: string; payload: unknown }[] = [];
      const helpers = {
        abortSignal: new AbortController().signal,
        job: { attempts: 1, max_attempts: 5 },
        addJob: async (task: string, payload: unknown) => {
          added.push({ task, payload });
          return {} as never;
        },
      } as unknown as JobHelpers;
      const t1 = Date.now();
      await createTrialExecuteJob(defaultTrialExecuteOptions()).run(
        { trial_id: trial!.id, retry: false, keep_computer: false },
        ctx,
        helpers,
      );
      const [afterExec] = await db.select().from(trials).where(eq(trials.id, trial!.id));
      log("trial after execute", {
        state: afterExec!.state,
        attempt: afterExec!.attempt,
        failure: afterExec!.failureClass,
        exit: afterExec!.exitCode,
        logs: afterExec!.logsUrl,
        proxyKeyId: afterExec!.proxyKeyId,
        proxyKeyCreatedAt: afterExec!.proxyKeyCreatedAt,
        ms: Date.now() - t1,
        added,
      });
      expect(["collecting", "failed_subject"]).toContain(afterExec!.state);
      expect(afterExec!.proxyKeyId).toMatch(/.+/);
      // The key is revoked: Naïve no longer lists it.
      const keys = await liveProxyKeys({
        apiKey: config.NAIVE_API_KEY!,
        ...(config.NAIVE_BASE_URL ? { baseUrl: config.NAIVE_BASE_URL } : {}),
      }).list();
      expect(keys.some((k) => k.id === afterExec!.proxyKeyId)).toBe(false);

      // 3. trial.gate with the production options (scoring computer on Naïve).
      const gate = added.find((a) => a.task === "trial.gate");
      if (afterExec!.state === "collecting") {
        expect(gate).toBeDefined();
        const t2 = Date.now();
        await trialGateJob.run(gate!.payload as never, ctx, helpers);
        const [done] = await db.select().from(trials).where(eq(trials.id, trial!.id));
        log("trial after gate", {
          state: done!.state,
          gate: done!.gate,
          metrics: done!.metrics,
          ms: Date.now() - t2,
        });
        expect(["done", "reviewing", "failed_subject"]).toContain(done!.state);
      }

      const rows = await db.select().from(computers).where(eq(computers.runId, run!.id));
      log(
        "computers",
        rows.map((r) => ({
          id: r.providerId,
          snap: r.snapshotId,
          status: r.status,
          cost: r.costMicroUsd,
          trial: r.trialId,
        })),
      );
      expect(rows.every((r) => r.status === "destroyed")).toBe(true);
      const live = await provider.list({ tag });
      expect(live).toHaveLength(0);
      const after = await naive.credits.show();
      log("balance after", after);
    },
    85 * 60_000,
  );
});
