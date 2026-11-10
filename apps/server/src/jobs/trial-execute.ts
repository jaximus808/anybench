// trial.execute (TDM-49, plan.md P3 "Trial executor", section 5 "Leases" and "Cancellation"): the
// graphile-worker job around packages/bench executeTrial, plus its Postgres ports.
//
//   trial.execute  {trial_id, retry?, reuse_computer_id?, keep_computer?}
//     job_key `trials:<id>:<attempt>`. One attempt of one trial: lease → fork → secrets +
//     trial.json by fs.write → detached runner → watch → collected (enqueue trial.gate, key
//     `trials:<id>:<attempt>:gate`) | final (a failed_subject trial that froze a workspace is
//     graded too, TDM-232: trial.gate with the same key) | failed_infra with tries left (enqueue the next
//     attempt at now + trialRetryDelayMs, key `trials:<id>:<attempt+1>`, payload retry=true).
//     Both follow-up jobs are enqueued while the lease is still held, so a crash in between is
//     picked up by trial.reattach and the enqueue repeats (job keys dedupe it).
//   trial.reattach  every 60 s: trials mid-execution whose lease is held but takeable (expired, or
//     its owner's worker_heartbeats row is stale or from an older process) are enqueued again;
//     the new execution re-attaches to the computer and the detached runner.
//   trial.gate  STUB until [5.6] (gate runner on the scoring computer) merges: logs and leaves the
//     trial in `collecting`. [5.6] replaces it (drop the stub from jobs/index.ts).
//
// Leases: `lease_owner = <worker id>~<worker started ms>~<nonce>`. The runner ingest extends
// lease_until on every heartbeat while lease_owner is set (routes/runner.ts), so an expired
// lease alone cannot detect a dead worker while its runner is healthy: a lease is also takeable
// when no worker_heartbeats row for that worker id and start time ticked in the last
// WORKER_MAX_TICK_AGE_MS. trial.execute writes this worker's heartbeat before it starts.
//
// Attempts: core allows 3 infra retries, trials_attempt_check allows attempt 1..3, so a trial
// gets at most 3 tries (TRIAL_MAX_ATTEMPTS in packages/bench; see executor.ts).
import {
  AnybenchEventSchema,
  frozenWorkspaceOf,
  RunIdSchema,
  safeParseKitSpec,
  TrialStateSchema,
  type EventActor,
  type TrialState,
} from "@anybench/core";
import {
  EXECUTING_TRIAL_STATES,
  executeTrial,
  gradesFrozenWorkspace,
  kitCostBasis,
  leaseOwnerBase,
  planTransition,
  reattachOrphans,
  type CancelState,
  type ExecEventDraft,
  type ExecTrial,
  type ExecuteOutcome,
  type ExecutorDeps,
  type ExecutorTiming,
  type IngestPort,
  type LaunchBreaker,
  type OrphanedTrial,
  type RunnerEdge,
  type TransitionOutcome,
  type TrialExecStore,
  type TrialPatch,
  type TrialSource,
} from "@anybench/bench";
import { createComputerRegistry, type ComputerStore } from "@anybench/envs";
import type { ProxySpendSource } from "@anybench/naive";
import type { ComputeProvider } from "@anybench/providers";
import { and, asc, eq, sql } from "drizzle-orm";
import type { JobHelpers } from "graphile-worker";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Database, DbTx } from "../db/client.js";
import { events } from "../db/schema/events.js";
import { kits } from "../db/schema/kits.js";
import { runs } from "../db/schema/runs.js";
import { trials } from "../db/schema/trials.js";
import {
  artifactStoreFromEnv,
  computeProviderFromConfig,
  fallbackBundleUpload,
  proxyDepsFromConfig,
} from "../lib/compute.js";
import { computerPricing, drizzleComputerStore } from "../lib/computer-store.js";
import { breakerConfigFrom, dbLaunchBreaker } from "../lib/provider-breaker.js";
import { appendEvents } from "../lib/events.js";
import { mintRunnerToken } from "../lib/runner-token.js";
import { byokLookup } from "../lib/byok.js";
import { WORKER_MAX_TICK_AGE_MS } from "../lib/worker-health.js";
import {
  budgetPricingFromConfig,
  launchRefusal,
  readRunBudget,
  storeRunBudget,
  type BudgetPricing,
  type RunBudget,
} from "../orchestrator/budget.js";
import { kitTrialSource } from "../orchestrator/defaults.js";
import {
  attemptProxySpend,
  readSessionSpend,
  recordTrialMetrics,
  tokenSpendColumns,
} from "../orchestrator/trial-metrics.js";
import { artifactBundleSource, type BundleSource } from "../lib/trial-trace/store.js";
import { writeHeartbeat } from "./heartbeat.js";
import { defineJob, type JobContext } from "./types.js";

export const TRIAL_EXECUTE_JOB = "trial.execute";
export const TRIAL_GATE_JOB = "trial.gate";
export const TRIAL_REATTACH_JOB = "trial.reattach";
/** orchestrator/advance.ts RUN_ADVANCE_JOB (not imported: trial-execute → advance is a cycle). */
const RUN_ADVANCE_JOB = "run.advance";
/** plan.md section 5: the reaper sweeps every 60 s. */
export const TRIAL_REATTACH_INTERVAL_MS = 60_000;

/** job_key convention `<table>:<id>:<attempt>`. */
export function trialExecuteJobKey(trialId: string, attempt: number): string {
  return `trials:${trialId}:${attempt}`;
}
/** Distinct from trial.execute's key: graphile job keys are global across tasks. */
export function trialGateJobKey(trialId: string, attempt: number): string {
  return `trials:${trialId}:${attempt}:gate`;
}

export const TrialExecutePayloadSchema = z.object({
  trial_id: z.uuid(),
  /** The delayed retry of a failed_infra trial: retry now (it was scheduled at its backoff). */
  retry: z.boolean().default(false),
  /** Packed block: the computer a previous trial of the block kept running. */
  reuse_computer_id: z.uuid().optional(),
  /** Packed block: another trial follows on this computer. */
  keep_computer: z.boolean().default(false),
});
export type TrialExecutePayload = z.infer<typeof TrialExecutePayloadSchema>;

export const TrialGatePayloadSchema = z.object({
  trial_id: z.uuid(),
  attempt: z.int().positive(),
  /** worker-hardening: provider outage errors this gate absorbed (trial-gate.ts). */
  outage_pauses: z.int().nonnegative().optional(),
});

// ---------- the Postgres store ----------

type TrialRow = typeof trials.$inferSelect;

function toExec(r: TrialRow): ExecTrial {
  return {
    id: r.id,
    run_id: r.runId,
    owner_id: r.ownerId,
    state: r.state,
    attempt: r.attempt,
    computer_id: r.computerId,
    provider: r.provider,
    lease_owner: r.leaseOwner,
    lease_until: r.leaseUntil,
    started_at: r.startedAt,
    ended_at: r.endedAt,
    failure_class: r.failureClass,
    exit_code: r.exitCode,
    logs_url: r.logsUrl,
    machine: r.machine,
    cost_micro_usd: r.costMicroUsd,
    log_offset: r.logOffset,
    outage_pauses: r.outagePauses,
    frozen_workspace: frozenWorkspaceOf(r.frozenWorkspace),
    token_spend_micro_usd: r.tokenSpendMicroUsd,
  };
}

function toColumns(p: TrialPatch): Partial<typeof trials.$inferInsert> {
  const c: Partial<typeof trials.$inferInsert> = {};
  if (p.attempt !== undefined) c.attempt = p.attempt;
  if (p.computer_id !== undefined) c.computerId = p.computer_id;
  if (p.provider !== undefined) c.provider = p.provider;
  if (p.started_at !== undefined) c.startedAt = p.started_at;
  if (p.ended_at !== undefined) c.endedAt = p.ended_at;
  if (p.failure_class !== undefined) c.failureClass = p.failure_class;
  if (p.exit_code !== undefined) c.exitCode = p.exit_code;
  if (p.logs_url !== undefined) c.logsUrl = p.logs_url;
  if (p.machine !== undefined) c.machine = p.machine;
  if (p.cost_micro_usd !== undefined) c.costMicroUsd = p.cost_micro_usd;
  if (p.log_offset !== undefined) c.logOffset = p.log_offset;
  if (p.outage_pauses !== undefined) c.outagePauses = p.outage_pauses;
  if (p.frozen_workspace !== undefined) c.frozenWorkspace = p.frozen_workspace;
  if (p.token_spend_micro_usd !== undefined)
    Object.assign(c, tokenSpendColumns(p.token_spend_micro_usd));
  return c;
}

/** TDM-246: defined with the trial metrics (TDM-250 writes it from trial.gate too). */
export { tokenSpendColumns };

/** SQL: the lease holder's worker ticked within WORKER_MAX_TICK_AGE_MS, as the same process. */
function holderAlive(maxTickAgeMs: number) {
  return sql`exists (
    select 1 from worker_heartbeats w
    where w.worker_id = split_part(${trials.leaseOwner}, '~', 1)
      and floor(extract(epoch from w.started_at) * 1000)::bigint::text = split_part(${trials.leaseOwner}, '~', 2)
      and w.last_tick_at > now() - (${maxTickAgeMs} * interval '1 millisecond'))`;
}

/** SQL: the lease may be taken by someone else (free, expired, or a dead holder). */
function leaseFree(maxTickAgeMs: number) {
  return sql`(${trials.leaseOwner} is null or ${trials.leaseUntil} is null or ${trials.leaseUntil} <= now() or not ${holderAlive(maxTickAgeMs)})`;
}

const RunnerPhasePayloadSchema = z.object({
  from: TrialStateSchema.nullable(),
  to: TrialStateSchema,
  attempt: z.int().positive(),
  reason: z.string().optional(),
  failure_class: z.string().optional(),
});
const ActorKindSchema = z.object({ kind: z.string() });

export interface DrizzleTrialExecStoreOptions {
  /** `ANYBENCH_PAUSE=1` cancels like a global kill switch. */
  paused?: boolean;
  /**
   * TDM-242: admit each launch (queued → forking) against the run's budget under the run's row
   * lock (orchestrator/budget.ts). Unset = no admission check (tools, tests of other behaviour).
   */
  budget?: BudgetPricing;
  workerMaxTickAgeMs?: number;
}

export type DrizzleTrialExecStore = TrialExecStore & {
  listOrphaned(): Promise<OrphanedTrial[]>;
};

/** TrialExecStore on `trials` (system actor: the worker's direct connection, like computer.reap). */
export function drizzleTrialExecStore(
  db: Database,
  options: DrizzleTrialExecStoreOptions = {},
): DrizzleTrialExecStore {
  const maxAge = options.workerMaxTickAgeMs ?? WORKER_MAX_TICK_AGE_MS;

  async function appendTo(tx: Database | DbTx, runId: string, drafts: ExecEventDraft[]) {
    if (drafts.length === 0) return;
    const run = RunIdSchema.parse(runId);
    const evs = drafts.map((d) => AnybenchEventSchema.parse({ ...d, run_id: run, seq: 0 }));
    await appendEvents(tx, run, evs);
  }

  return {
    async get(id) {
      const [r] = await db.select().from(trials).where(eq(trials.id, id));
      return r ? toExec(r) : null;
    },

    async acquireLease(id, owner, leaseMs) {
      const [r] = await db
        .update(trials)
        .set({
          leaseOwner: owner,
          leaseUntil: sql`now() + (${leaseMs} * interval '1 millisecond')`,
          updatedAt: sql`now()`,
        })
        .where(
          and(eq(trials.id, id), sql`(${trials.leaseOwner} = ${owner} or ${leaseFree(maxAge)})`),
        )
        .returning();
      return r ? toExec(r) : null;
    },

    async refreshLease(id, owner, leaseMs) {
      const r = await db
        .update(trials)
        .set({
          leaseUntil: sql`greatest(coalesce(${trials.leaseUntil}, now()), now() + (${leaseMs} * interval '1 millisecond'))`,
        })
        .where(and(eq(trials.id, id), eq(trials.leaseOwner, owner)))
        .returning({ id: trials.id });
      return r.length > 0;
    },

    async releaseLease(id, owner) {
      await db
        .update(trials)
        .set({ leaseOwner: null, leaseUntil: null, updatedAt: sql`now()` })
        .where(and(eq(trials.id, id), eq(trials.leaseOwner, owner)));
    },

    async transition(id, owner, req): Promise<TransitionOutcome> {
      return db.transaction(async (tx) => {
        // TDM-242: a launch is admitted under the run's row lock, taken before the trial's (the
        // orchestrator's lock order: run, then trials), so concurrent launches serialize.
        let budget: RunBudget | null = null;
        if (options.budget && req.command.type === "advance") {
          const [peek] = await tx
            .select({ runId: trials.runId, state: trials.state })
            .from(trials)
            .where(eq(trials.id, id));
          if (peek?.state === "queued") {
            budget = await readRunBudget(tx, peek.runId, options.budget, { lock: true });
          }
        }
        const [r] = await tx.select().from(trials).where(eq(trials.id, id)).for("update");
        if (!r) return { ok: false, reason: "not_found", message: `no trial ${id}`, trial: null };
        // transitionTrial runs on the row's state, locked: never on what a runner claimed.
        const plan = planTransition(toExec(r), owner, req);
        if (!plan.ok) return plan;
        const launching = budget !== null && r.state === "queued" && plan.to === "forking";
        const trialCap = launching ? budget!.capOf(r.id) : null;
        const cap = trialCap?.total ?? 0n;
        if (launching) {
          const b = budget!;
          // TDM-245: the BYOK token limit too (launchRefusal: the budget first, then BYOK).
          const why =
            b.state === "paused_budget"
              ? "the run is paused for its budget"
              : launchRefusal(b, trialCap!);
          if (why) return { ok: false, reason: "held", message: why, trial: toExec(r) };
        }
        const [u] = await tx
          .update(trials)
          .set({
            ...toColumns({ ...req.patch, attempt: plan.next.attempt }),
            state: plan.to,
            updatedAt: sql`now()`,
          })
          .where(eq(trials.id, id))
          .returning();
        if (plan.event) await appendTo(tx, r.runId, [plan.event]);
        if (launching) {
          // The launched trial's worst case is committed from now on.
          budget!.committed += cap;
          if (trialCap!.byokTokens !== null) budget!.byok.committed += trialCap!.byokTokens;
          await storeRunBudget(tx, budget!, req.actor);
        }
        return { ok: true, trial: toExec(u!), from: plan.from, to: plan.to };
      });
    },

    async patch(id, owner, patch) {
      const r = await db
        .update(trials)
        .set({ ...toColumns(patch), updatedAt: sql`now()` })
        .where(and(eq(trials.id, id), eq(trials.leaseOwner, owner)))
        .returning({ id: trials.id });
      return r.length > 0;
    },

    async runnerEdges(trial): Promise<RunnerEdge[]> {
      const rows = await db
        .select({ actor: events.actor, payload: events.payload })
        .from(events)
        .where(
          and(
            eq(events.runId, trial.run_id),
            eq(events.sourceId, trial.id),
            eq(events.type, "trial.phase"),
          ),
        )
        .orderBy(asc(events.seq));
      const out: RunnerEdge[] = [];
      for (const row of rows) {
        let actor: unknown;
        try {
          actor = row.actor ? JSON.parse(row.actor) : null;
        } catch {
          continue;
        }
        if (ActorKindSchema.safeParse(actor).data?.kind !== "runner") continue;
        const p = RunnerPhasePayloadSchema.safeParse(row.payload);
        if (!p.success || p.data.attempt !== trial.attempt) continue;
        out.push({
          from: p.data.from,
          to: p.data.to,
          ...(p.data.reason ? { reason: p.data.reason } : {}),
          ...(p.data.failure_class ? { failure_class: p.data.failure_class } : {}),
        });
      }
      return out;
    },

    async cancelState(trial): Promise<CancelState> {
      if (options.paused) return { cancelled: true, reason: "ANYBENCH_PAUSE=1" };
      const res = await db.execute(sql`
        select
          (select cancel_requested_at from runs where id = ${trial.run_id}) as cancel_requested_at,
          (select stage_outputs->'budget_stop'->>'reason' from runs
            where id = ${trial.run_id} and state = 'paused_budget') as budget_stop,
          (select scope || ': ' || reason from kill_switches
            where cleared_at is null
              and (scope = 'global'
                or (scope = 'run' and scope_id = ${trial.run_id})
                or (scope = 'user' and scope_id = ${trial.owner_id}))
            order by set_at limit 1) as kill`);
      const row = (
        res as unknown as {
          rows: { cancel_requested_at: unknown; kill: string | null; budget_stop: string | null }[];
        }
      ).rows[0];
      if (row?.kill) return { cancelled: true, reason: `kill switch ${row.kill}` };
      if (row?.cancel_requested_at) return { cancelled: true, reason: "run cancel requested" };
      // TDM-242: the run spent its budget: the runner stops the subject, the gate grades its work.
      if (row?.budget_stop) return { cancelled: false, budget_stop: row.budget_stop };
      return { cancelled: false };
    },

    async emit(trial, drafts) {
      await appendTo(db, trial.run_id, drafts);
    },

    async listOrphaned() {
      const states = EXECUTING_TRIAL_STATES as readonly TrialState[];
      const rows = await db
        .select({ id: trials.id, attempt: trials.attempt, state: trials.state })
        .from(trials)
        .where(
          and(
            sql`${trials.state} in (${sql.join(
              states.map((s) => sql`${s}`),
              sql`, `,
            )})`,
            sql`${trials.leaseOwner} is not null`,
            leaseFree(maxAge),
          ),
        );
      return rows;
    },
  };
}

/**
 * The registry's ComputerStore, linking `trials.computer_id` in the same transaction as the
 * `computers` insert: the trial names its computer before the provider is even asked for it,
 * so a retry never double-creates (only while the trial has no computer yet).
 */
export function trialLinkedComputerStore(db: Database): ComputerStore {
  const base = drizzleComputerStore(db);
  return {
    ...base,
    async insert(row) {
      await db.transaction(async (tx) => {
        await drizzleComputerStore(tx).insert(row);
        if (row.trialId) {
          await tx
            .update(trials)
            .set({ computerId: row.id, provider: row.provider, updatedAt: sql`now()` })
            .where(and(eq(trials.id, row.trialId), sql`${trials.computerId} is null`));
        }
      });
    },
  };
}

// ---------- jobs ----------

export interface TrialExecuteJobOptions {
  /** The compute provider eval computers run on (naive in prod, docker-local in dev). */
  provider?: (ctx: JobContext) => ComputeProvider | null;
  /** Kit → TrialJob, computer spec, secrets, files ([3.8] env build / [5.9] orchestrator). */
  source?: (ctx: JobContext) => TrialSource;
  fallbackUpload?: (ctx: JobContext) => ExecutorDeps["fallbackUpload"];
  timing?: Partial<ExecutorTiming>;
  runnerBin?: ExecutorDeps["runnerBin"];
  /** Per-trial Naïve proxy keys (TDM-16/TDM-39): liveProxyKeys + liveLedgerSpend in production. */
  naiveProxy?: (ctx: JobContext) => ExecutorDeps["naiveProxy"] | null;
  /**
   * worker-hardening: the provider-outage breaker. Default: the shared Postgres one for the
   * provider (lib/provider-breaker.ts). Return null to run without one.
   */
  breaker?: (ctx: JobContext, provider: ComputeProvider) => LaunchBreaker | null;
  /** TDM-242: admit every launch against the run's budget (production: from config). */
  budget?: (ctx: JobContext) => BudgetPricing | null;
  /**
   * TDM-250: stored trial bundles, to settle a failed_subject trial's BYOK spend from Claude
   * Code's session totals (production: the artifact store). Unset: the runner's meter stands.
   */
  bundles?: (ctx: JobContext) => BundleSource | null;
}

/** The shared breaker for `provider` (production default). */
export function defaultLaunchBreaker(ctx: JobContext, provider: ComputeProvider): LaunchBreaker {
  return dbLaunchBreaker(ctx.db, provider.name, {
    config: breakerConfigFrom(ctx.config),
    logger: ctx.logger,
  });
}

/** Record the attempt's proxy key id and creation time on the trial (never the secret). */
export function recordProxyKey(db: Database): NonNullable<ExecutorDeps["onProxyKeyMinted"]> {
  return async (trial, key) => {
    await db
      .update(trials)
      .set({
        proxyKeyId: key.keyId,
        proxyKeyCreatedAt: new Date(key.createdAt),
        proxyKeyAttempt: trial.attempt,
        updatedAt: sql`now()`,
      })
      .where(eq(trials.id, trial.id));
  };
}

/** Until [3.8] / [5.9] wire a real one: every prepare fails (failed_infra, retried, then final). */
export const unconfiguredTrialSource: TrialSource = {
  async prepare() {
    throw new Error("no trial source configured (env build [3.8] / run orchestrator [5.9])");
  },
};

/** Runner ingest for trial.json: PUBLIC_API_URL + per-attempt tokens. Null (file-only) when unset. */
export function ingestFromConfig(config: Config): IngestPort | null {
  const secret = config.RUNNER_TOKEN_SECRET;
  if (!config.PUBLIC_API_URL || !secret) return null;
  return {
    url: config.PUBLIC_API_URL,
    token: (trialId, attempt) => mintRunnerToken(secret, trialId, attempt),
  };
}

/** Enqueue what follows an outcome, while the lease is still held. */
export async function enqueueFollowUp(
  addJob: JobHelpers["addJob"],
  outcome: ExecuteOutcome,
  payload?: TrialExecutePayload,
): Promise<void> {
  if (outcome.kind === "held") {
    // TDM-242: the budget held the launch; the trial stays queued with no job. Wake the run, which
    // launches it once the budget allows or holds the run in paused_budget.
    const runId = outcome.trial.run_id;
    await addJob(
      RUN_ADVANCE_JOB,
      { run_id: runId, reason: "budget" },
      { jobKey: `runs:${runId}:budget` },
    );
    return;
  }
  if (outcome.kind === "paused") {
    // Same attempt, same job key: graphile gives a key held by this (locked) job to a new job.
    const t = outcome.trial;
    await addJob(
      TRIAL_EXECUTE_JOB,
      { ...(payload ?? { trial_id: t.id }), trial_id: t.id, retry: false },
      { jobKey: trialExecuteJobKey(t.id, t.attempt), runAt: new Date(outcome.retry_at) },
    );
    return;
  }
  // TDM-232: a failed_subject trial that froze a workspace is graded on it (it keeps its outcome).
  if (
    outcome.kind === "collected" ||
    (outcome.kind === "final" && gradesFrozenWorkspace(outcome.trial))
  ) {
    const t = outcome.trial;
    await addJob(
      TRIAL_GATE_JOB,
      { trial_id: t.id, attempt: t.attempt },
      { jobKey: trialGateJobKey(t.id, t.attempt) },
    );
  } else if (outcome.kind === "retry") {
    const t = outcome.trial;
    await addJob(
      TRIAL_EXECUTE_JOB,
      { trial_id: t.id, retry: true },
      { jobKey: trialExecuteJobKey(t.id, outcome.next_attempt), runAt: new Date(outcome.retry_at) },
    );
  }
}

/**
 * A failed_subject trial with nothing to grade never reaches trial.gate: record its cost (compute +
 * proxy spend) and wall here, so "all spend ÷ solved" counts it (orchestrator/trial-metrics.ts).
 * One that froze a workspace is graded, and trial.gate records them with the verdict (TDM-232):
 * writing them here too would race the gate's own write. TDM-250: with `bundles`, its BYOK spend
 * is settled from the bundle's Claude Code session totals (the runner's meter stands where a
 * session never reported).
 */
export async function recordFailedSubjectMetrics(
  db: Database,
  trialId: string,
  spend: ProxySpendSource | null,
  bundles?: BundleSource | null,
): Promise<void> {
  const [row] = await db.select().from(trials).where(eq(trials.id, trialId));
  if (!row || row.state !== "failed_subject") return;
  if (gradesFrozenWorkspace({ state: row.state, frozen_workspace: row.frozenWorkspace })) return;
  // TDM-246: the kit's cost basis, recorded on the trial with its metrics.
  const [kit] = await db
    .select({ spec: kits.spec })
    .from(runs)
    .innerJoin(kits, eq(kits.id, runs.kitId))
    .where(eq(runs.id, row.runId))
    .limit(1);
  const spec = kit ? safeParseKitSpec(kit.spec) : null;
  const sessions =
    row.proxyKeyId === null ? await readSessionSpend(bundles, row.runId, row.id) : undefined;
  await recordTrialMetrics(db, row, await attemptProxySpend(spend, row), {
    ...(spec?.success ? { costBasis: kitCostBasis(spec.data) } : {}),
    ...(sessions !== undefined ? { sessions } : {}),
  });
}

export function createTrialExecuteJob(options: TrialExecuteJobOptions = {}) {
  return defineJob({
    name: TRIAL_EXECUTE_JOB,
    payload: TrialExecutePayloadSchema,
    async run(payload, ctx, helpers) {
      const log = ctx.logger.child({ job: TRIAL_EXECUTE_JOB, trialId: payload.trial_id });
      const provider = options.provider?.(ctx) ?? null;
      if (!provider) {
        // Throw: graphile retries with backoff, so the trial resumes once a provider is configured.
        throw new Error("trial.execute: no compute provider configured");
      }
      // Our liveness row must exist before we hold a lease, or a sweep would think us dead.
      await writeHeartbeat(ctx);
      const budget = options.budget?.(ctx) ?? null;
      const store = drizzleTrialExecStore(ctx.db, {
        paused: ctx.config.ANYBENCH_PAUSE,
        ...(budget ? { budget } : {}),
      });
      const breaker =
        options.breaker === undefined
          ? defaultLaunchBreaker(ctx, provider)
          : options.breaker(ctx, provider);
      // worker-hardening: a provider outage parks trials that have not started yet right here
      // (still `queued`, attempt untouched); the executor checks again before every create / mint.
      const blocked = breaker ? await breaker.blockedUntil() : null;
      if (blocked !== null) {
        const t = await store.get(payload.trial_id);
        if (t && t.state === "queued" && !t.lease_owner) {
          await helpers.addJob(
            TRIAL_EXECUTE_JOB,
            { ...payload, retry: false },
            { jobKey: trialExecuteJobKey(t.id, t.attempt), runAt: new Date(blocked) },
          );
          log.info({ until: new Date(blocked).toISOString() }, "provider outage: trial waits");
          return;
        }
      }
      const registry = createComputerRegistry({
        provider,
        store: trialLinkedComputerStore(ctx.db),
        pricing: computerPricing(provider, ctx.config.COMPUTER_BLOCK_PRICE_MICRO_USD),
      });
      const ingest = ingestFromConfig(ctx.config);
      if (!ingest) log.warn("PUBLIC_API_URL or RUNNER_TOKEN_SECRET unset: runner is file-only");
      const actor: EventActor = { kind: "worker", id: ctx.workerId };
      const fallbackUpload = options.fallbackUpload?.(ctx);
      const naiveProxy = options.naiveProxy?.(ctx) ?? null;
      const deps: ExecutorDeps = {
        store,
        registry,
        source: options.source?.(ctx) ?? unconfiguredTrialSource,
        ingest,
        owner: leaseOwnerBase(ctx.workerId, ctx.workerStartedAt),
        actor,
        logger: log,
        ...(options.timing ? { timing: options.timing } : {}),
        ...(options.runnerBin ? { runnerBin: options.runnerBin } : {}),
        ...(fallbackUpload ? { fallbackUpload } : {}),
        ...(naiveProxy ? { naiveProxy, onProxyKeyMinted: recordProxyKey(ctx.db) } : {}),
        ...(breaker ? { breaker } : {}),
      };
      const outcome = await executeTrial(deps, payload.trial_id, {
        retryNow: payload.retry,
        keepComputer: payload.keep_computer,
        ...(payload.reuse_computer_id ? { reuseComputerId: payload.reuse_computer_id } : {}),
        signal: helpers.abortSignal,
        beforeRelease: (o) => enqueueFollowUp(helpers.addJob, o, payload),
      });
      if (outcome.kind === "final" && outcome.state === "failed_subject") {
        await recordFailedSubjectMetrics(
          ctx.db,
          payload.trial_id,
          naiveProxy?.spend ?? null,
          options.bundles?.(ctx) ?? null,
        ).catch((err: unknown) =>
          log.warn({ err }, "trial.execute: could not record trial metrics"),
        );
      }
      const summary =
        outcome.kind === "final"
          ? { kind: outcome.kind, state: outcome.state }
          : outcome.kind === "paused"
            ? { kind: outcome.kind, resumeAt: new Date(outcome.retry_at).toISOString() }
            : outcome.kind === "held"
              ? { kind: outcome.kind, reason: outcome.reason }
              : outcome.kind === "retry"
                ? {
                    kind: outcome.kind,
                    nextAttempt: outcome.next_attempt,
                    retryAt: new Date(outcome.retry_at).toISOString(),
                  }
                : { kind: outcome.kind };
      log.info(summary, "trial.execute finished");
    },
  });
}

/**
 * Production wiring: NaiveProvider when NAIVE_API_KEY is set (else the job refuses to run; tests
 * pass a FakeProvider), the kit-backed source with per-trial Naïve proxy keys, and the fs/read
 * bundle fallback into the artifact store when S3_BUCKET is set.
 */
export function defaultTrialExecuteOptions(): TrialExecuteJobOptions {
  return {
    provider: (ctx) => computeProviderFromConfig(ctx.config),
    budget: (ctx) => budgetPricingFromConfig(ctx.config),
    source: (ctx) => {
      const byok = byokLookup(ctx.db, {
        current: ctx.config.ANYBENCH_KEK,
        previous: ctx.config.ANYBENCH_KEK_PREVIOUS,
      });
      return kitTrialSource(ctx.db, {
        proxyCapMicroUsd: ctx.config.TRIAL_PROXY_CAP_MICRO_USD,
        ...(byok ? { byok } : {}),
      });
    },
    naiveProxy: (ctx) => proxyDepsFromConfig(ctx.config),
    fallbackUpload: () => {
      const store = artifactStoreFromEnv();
      return store ? fallbackBundleUpload(store) : undefined;
    },
    bundles: () => {
      const store = artifactStoreFromEnv();
      return store ? artifactBundleSource(store) : null;
    },
  };
}

export const trialExecuteJob = createTrialExecuteJob(defaultTrialExecuteOptions());

/** trial.reattach: hand every orphaned mid-execution trial to a new trial.execute. */
export function createTrialReattachJob() {
  return defineJob({
    name: TRIAL_REATTACH_JOB,
    payload: z.object({}),
    everyMs: TRIAL_REATTACH_INTERVAL_MS,
    jobKey: () => "trials:reattach",
    async run(_payload, ctx, helpers) {
      const store = drizzleTrialExecStore(ctx.db);
      const log = ctx.logger.child({ job: TRIAL_REATTACH_JOB });
      const enqueued = await reattachOrphans({
        listOrphaned: () => store.listOrphaned(),
        enqueue: async (o) => {
          await helpers.addJob(
            TRIAL_EXECUTE_JOB,
            // failed_infra: the dead worker never scheduled the retry; the new execution does.
            { trial_id: o.id },
            { jobKey: trialExecuteJobKey(o.id, o.attempt) },
          );
        },
        logger: log,
      });
      if (enqueued.length > 0) {
        log.warn({ trials: enqueued }, "re-attaching orphaned trials");
      }
    },
  });
}

export const trialReattachJob = createTrialReattachJob();
