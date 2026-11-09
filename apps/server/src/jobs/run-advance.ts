// run.advance and run.sweep (TDM-54, plan.md section 5): the run orchestrator's jobs.
//
//   run.advance {run_id, reason}
//     The API enqueues it in the same transaction that creates a run, passes Go, saves a kit edit
//     or cancels (lib/job-queue.ts; keys `runs:<id>:created|go|cancelled`, `kits:<kit>:1`). The
//     orchestrator enqueues it too: `runs:<id>:poll` (trials in flight, a terminal run's cleanup),
//     `runs:<id>:busy` (another live worker held the run), `runs:<id>:sweep`. Each one drives the
//     run as far as it can go (orchestrator/advance.ts). On the job's last attempt an unexpected
//     error fails the run instead of being retried forever.
//   run.sweep  every 60 s: crash recovery. Every run that should be moving (an active stage,
//     awaiting_go with auto-go, or terminal but not finalized) whose advance lease is free and
//     that has no pending run.advance job gets one (`runs:<id>:sweep`). A worker that died mid
//     stage leaves its lease held; it becomes takeable once that worker's heartbeat is stale.
//
// Ports (orchestrator/ports.ts): the E6 agent roles are not built yet. Default agents are the
// CuratedKitStage (orchestrator/curated.ts): the Tandem repo gets the curated Tandem kit, any other
// repo holds in `needs_human` at kit design (TODO [6.6] TDM-60); the Tandem kit's analyst is the
// deterministic summary (proof-score.ts), others are not built ([6.8]). Proof is the curated kit's
// signed-off offline proof (others hold: [4.12]); scoring is scoreKit. GitHub ingest, the cost estimate,
// Naïve session cancel and the billing hook (ledger.recordRunCharges) are real. Pass `createRunAdvanceJob({agents, pipeline, ...})` to plug real ones in.
import { leaseOwnerBase } from "@anybench/bench";
import { createNaiveClient } from "@anybench/naive";
import type { JobHelpers } from "graphile-worker";
import { z } from "zod";
import { defaultBillingGate, type BillingGate } from "../lib/billing-gate.js";
import {
  artifactStoreFromEnv,
  computeProviderFromConfig,
  proxyDepsFromConfig,
} from "../lib/compute.js";
import {
  defaultRunnerBinDir,
  providerEnvBuild,
  runnerInstaller,
} from "../orchestrator/env-build.js";
import { WORKER_MAX_TICK_AGE_MS } from "../lib/worker-health.js";
import {
  ACTIVE_RUN_STATES,
  advanceRun,
  RUN_ADVANCE_JOB,
  type JobsPort,
  type OrchestratorDeps,
  type OrchestratorTiming,
  type RunChargesHook,
} from "../orchestrator/advance.js";
import {
  billingEstimate,
  githubIngest,
  graphileJobsPort,
  ledgerCharges,
  naiveSessionCanceller,
} from "../orchestrator/defaults.js";
import { budgetPricingFromConfig, type BudgetPricing } from "../orchestrator/budget.js";
import { defaultAgentStages } from "../orchestrator/kit-builder.js";
import { kitScore } from "../orchestrator/proof-score.js";
import {
  noSessionCanceller,
  unbuiltPipeline,
  type AgentStagePort,
  type PipelinePort,
  type SessionCanceller,
} from "../orchestrator/ports.js";
import { sweepCandidates } from "../orchestrator/store.js";
import { writeHeartbeat } from "./heartbeat.js";
import { notifySettings, runNotifyEnqueuer } from "./run-notify.js";
import { configuredSecretValues, proofStage } from "./proof.js";
import { workerKitDir } from "../orchestrator/kit-files.js";
import { defineJob, type JobContext } from "./types.js";

export { RUN_ADVANCE_JOB } from "../orchestrator/advance.js";
export const RUN_SWEEP_JOB = "run.sweep";
/** plan.md section 5: sweeps run every 60 s. */
export const RUN_SWEEP_INTERVAL_MS = 60_000;
const SWEEP_MAX_ATTEMPTS = 5;

export const RunAdvancePayloadSchema = z.object({
  run_id: z.uuid(),
  /** Why the orchestrator was woken. */
  reason: z.enum([
    "created",
    "go",
    "kit_edited",
    "cancelled",
    "poll",
    "busy",
    "sweep",
    "settled",
    // TDM-242: a trial launch was held for the budget, or the run was resumed.
    "budget",
    "resumed",
  ]),
  kit_id: z.uuid().optional(),
});
export type RunAdvancePayload = z.infer<typeof RunAdvancePayloadSchema>;

export interface RunAdvanceJobOptions {
  agents?: (ctx: JobContext) => AgentStagePort;
  pipeline?: (ctx: JobContext) => PipelinePort;
  sessions?: (ctx: JobContext) => SessionCanceller;
  billingGate?: (ctx: JobContext) => BillingGate;
  /** Default: packages/billing ledger.recordRunCharges (TDM-171). */
  charges?: (ctx: JobContext) => RunChargesHook | null;
  jobs?: (ctx: JobContext, helpers: JobHelpers) => JobsPort;
  timing?: Partial<OrchestratorTiming>;
  workerMaxTickAgeMs?: number;
  beforeStage?: OrchestratorDeps["beforeStage"];
  /** TDM-242: the run budget's pricing. Default: from config; return null to turn it off. */
  budget?: (ctx: JobContext) => BudgetPricing | null;
  /** run-email: enqueue run.notify with each state change. Default: on when notifySettings is. */
  onStateChange?: (ctx: JobContext) => OrchestratorDeps["onStateChange"] | null;
}

/** Production pipeline: real GitHub ingest and estimate, the rest held until its ticket lands. */
export function defaultPipeline(ctx: JobContext): PipelinePort {
  const provider = computeProviderFromConfig(ctx.config);
  // TDM-218: an uploaded kit's files (artifact: in R2) unpacked on this worker for env build and proof.
  const kitDir = workerKitDir(artifactStoreFromEnv());
  return {
    ...unbuiltPipeline,
    ingest: githubIngest(ctx.config.GITHUB_TOKEN ? { githubToken: ctx.config.GITHUB_TOKEN } : {}),
    estimate: billingEstimate(ctx.config),
    // TDM-44 [4.12]: the curated kit's signed-off offline proof; any other kit runs the six
    // proof checks on the run's env (trials fork env_id, gates fork the scoring image).
    prove: proofStage({
      db: ctx.db,
      provider,
      ...(ctx.config.ANYBENCH_KITS_DIR ? { kitsDir: ctx.config.ANYBENCH_KITS_DIR } : {}),
      secretValues: () => configuredSecretValues(ctx.config as unknown as Record<string, unknown>),
      pricePerBlockMicroUsd: ctx.config.COMPUTER_BLOCK_PRICE_MICRO_USD,
      ...(proxyDepsFromConfig(ctx.config) ? { naiveProxy: proxyDepsFromConfig(ctx.config)! } : {}),
      proxyCapMicroUsd: ctx.config.TRIAL_PROXY_CAP_MICRO_USD,
      kitDir,
      log: (msg, data) => ctx.logger.info({ job: RUN_ADVANCE_JOB, ...data }, msg),
    }),
    score: kitScore(),
    // [3.8] env build on the trials' provider (Naïve), when there is one.
    ...(provider
      ? {
          buildEnv: providerEnvBuild({
            db: ctx.db,
            provider,
            runner: () =>
              runnerInstaller({
                binDir: defaultRunnerBinDir(ctx.config.ANYBENCH_RUNNER_BIN_DIR),
                artifacts: artifactStoreFromEnv(),
              }),
            kitDir,
            log: (msg, data) => ctx.logger.info({ job: RUN_ADVANCE_JOB, ...data }, msg),
          }),
        }
      : {}),
  };
}

/** Naïve session cancel when NAIVE_API_KEY is set (a live call happens only for a live session). */
export function defaultSessions(ctx: JobContext): SessionCanceller {
  if (!ctx.config.NAIVE_API_KEY) return noSessionCanceller;
  return naiveSessionCanceller(
    ctx.db,
    createNaiveClient({
      apiKey: ctx.config.NAIVE_API_KEY,
      ...(ctx.config.NAIVE_BASE_URL ? { baseUrl: ctx.config.NAIVE_BASE_URL } : {}),
    }),
  );
}

export function orchestratorDeps(
  options: RunAdvanceJobOptions,
  ctx: JobContext,
  helpers: JobHelpers,
): OrchestratorDeps {
  return {
    db: ctx.db,
    jobs: options.jobs?.(ctx, helpers) ?? graphileJobsPort(ctx.db, helpers.addJob),
    agents: options.agents?.(ctx) ?? defaultAgentStages(ctx),
    pipeline: options.pipeline?.(ctx) ?? defaultPipeline(ctx),
    sessions: options.sessions?.(ctx) ?? defaultSessions(ctx),
    billingGate: options.billingGate?.(ctx) ?? defaultBillingGate(ctx.config, ctx.db),
    charges: options.charges
      ? options.charges(ctx)
      : ledgerCharges(ctx.db, ctx.config, {
          proxySpend: proxyDepsFromConfig(ctx.config)?.spend ?? null,
        }),
    owner: leaseOwnerBase(ctx.workerId, ctx.workerStartedAt),
    paused: ctx.config.ANYBENCH_PAUSE,
    // TDM-242: every run's budget (a free starter run: FREE_RUN_CAP_MICRO_USD at our cost).
    ...budgetDeps(options, ctx),
    logger: ctx.logger.child({ job: RUN_ADVANCE_JOB }),
    ...(options.timing ? { timing: options.timing } : {}),
    ...(options.workerMaxTickAgeMs !== undefined
      ? { workerMaxTickAgeMs: options.workerMaxTickAgeMs }
      : {}),
    ...(options.beforeStage ? { beforeStage: options.beforeStage } : {}),
    ...notifyHook(options, ctx),
  };
}

function budgetDeps(
  options: RunAdvanceJobOptions,
  ctx: JobContext,
): Pick<OrchestratorDeps, "budget"> {
  const budget =
    options.budget === undefined ? budgetPricingFromConfig(ctx.config) : options.budget(ctx);
  return budget ? { budget } : {};
}

function notifyHook(
  options: RunAdvanceJobOptions,
  ctx: JobContext,
): Pick<OrchestratorDeps, "onStateChange"> {
  const hook = options.onStateChange
    ? options.onStateChange(ctx)
    : notifySettings(ctx.config).enabled
      ? runNotifyEnqueuer()
      : null;
  return hook ? { onStateChange: hook } : {};
}

/** graphile's job row: the last attempt is when attempts reached max_attempts. */
function isLastAttempt(helpers: JobHelpers): boolean {
  const job = helpers.job as { attempts?: number; max_attempts?: number } | undefined;
  return (
    job?.attempts !== undefined &&
    job.max_attempts !== undefined &&
    job.attempts >= job.max_attempts
  );
}

export function createRunAdvanceJob(options: RunAdvanceJobOptions = {}) {
  return defineJob({
    name: RUN_ADVANCE_JOB,
    payload: RunAdvancePayloadSchema,
    async run(payload, ctx, helpers) {
      // Our liveness row must exist before we hold a lease, or a sweep would think us dead.
      await writeHeartbeat(ctx);
      const deps = orchestratorDeps(options, ctx, helpers);
      const outcome = await advanceRun(deps, payload.run_id, {
        ...(helpers.abortSignal ? { signal: helpers.abortSignal } : {}),
        lastAttempt: isLastAttempt(helpers),
      });
      deps.logger?.info(
        { runId: payload.run_id, reason: payload.reason, outcome },
        "run.advance finished",
      );
    },
  });
}

export const runAdvanceJob = createRunAdvanceJob();

/** One sweep: enqueue run.advance for every run that should move and has nothing pending. */
export async function sweepRuns(
  deps: Pick<OrchestratorDeps, "db" | "jobs"> & { workerMaxTickAgeMs?: number },
): Promise<string[]> {
  const candidates = await sweepCandidates(deps.db, {
    maxTickAgeMs: deps.workerMaxTickAgeMs ?? WORKER_MAX_TICK_AGE_MS,
    active: ACTIVE_RUN_STATES,
    terminal: ["delivered", "failed", "cancelled"],
  });
  if (candidates.length === 0) return [];
  // `runs:<run id>:<step>` (and `kits:<kit id>:1`, which wakes the same run, is covered next sweep).
  const pending = new Set(
    (await deps.jobs.pendingKeysWithPrefix("runs:")).map((k) => k.split(":")[1]),
  );
  const woken: string[] = [];
  for (const c of candidates) {
    if (pending.has(c.id)) continue;
    await deps.jobs.add(
      RUN_ADVANCE_JOB,
      { run_id: c.id, reason: "sweep" },
      { jobKey: `runs:${c.id}:sweep`, maxAttempts: SWEEP_MAX_ATTEMPTS },
    );
    woken.push(c.id);
  }
  return woken;
}

export function createRunSweepJob(
  options: Pick<RunAdvanceJobOptions, "jobs" | "workerMaxTickAgeMs"> = {},
) {
  return defineJob({
    name: RUN_SWEEP_JOB,
    payload: z.object({}),
    everyMs: RUN_SWEEP_INTERVAL_MS,
    jobKey: () => "runs:sweep",
    async run(_payload, ctx, helpers) {
      const log = ctx.logger.child({ job: RUN_SWEEP_JOB });
      const woken = await sweepRuns({
        db: ctx.db,
        jobs: options.jobs?.(ctx, helpers) ?? graphileJobsPort(ctx.db, helpers.addJob),
        ...(options.workerMaxTickAgeMs !== undefined
          ? { workerMaxTickAgeMs: options.workerMaxTickAgeMs }
          : {}),
      });
      if (woken.length > 0) log.warn({ runs: woken }, "re-driving runs with no pending job");
    },
  });
}

export const runSweepJob = createRunSweepJob();
