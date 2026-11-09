// The run orchestrator (TDM-54, plan.md section 5): one `advanceRun` call drives a run as far as
// it can go right now, then stops and says when to look again.
//
//   intake → understand → research → kit_draft → env_build → proof → awaiting_go
//          → (Go) → running (trials, their gates) → scoring → analyzing → delivered
//
// Per call: take the run's advance lease (store.ts), then loop: re-read the run, do the current
// stage's work through the ports (ports.ts) outside any transaction, and commit its output with
// the state change and the run.state_changed event in one guarded transaction (lease + expected
// state re-checked under a row lock). The loop continues into the next stage until the run waits
// (awaiting_go without auto-go, trials in flight, a hold) or ends.
//
// Crash safety: every stage is rerunnable. Its output is written only together with the state
// change, or (proof results, the estimate) before the decision that reads them, so a crash re-does
// at most one stage; agent ports get a stable `idempotencyKey` so Naïve replays the session.
// Trials are inserted once per (run, contender, workload, repeat) slot (trials_slot_uq), so a
// re-expanded run never duplicates them, and trial.execute is enqueued only for queued trials with
// no live job. A dead worker's lease becomes takeable once its heartbeat is stale; run.sweep
// (jobs/run-advance.ts) re-enqueues run.advance for every active run with no pending job.
//
// Cancellation and kill switches (plan section 5): checked at every stage boundary and on every
// lease refresh (which aborts the running stage's signal). A user cancel is moved by the API
// (cancel_cause `user`); a kill switch or ANYBENCH_PAUSE=1 is cancelled here (cancel_cause `ours`).
// Terminal cleanup ("finalize"): cancel live Naïve sessions, cancel queued trials (running trials
// see cancel_requested_at and stop themselves), wait until every trial settled, then the billing
// hook, then `stage_outputs.finalized_at`.
//
// No speed or quality number without a correctness gate: only proven kits leave proof (all six
// checks, or a curated kit's signed-off offline proof accepted for that kit row: proof-score.ts
// proofAccepted; the checks it did not run stay `pass: false`), and the analyst's report must parse with ReportSchema, whose refinements refuse a
// measured value without a passing gate.
//
// An uploaded kit (TDM-218, runs.intake.kit_origin = `uploaded`, source {kind: 'kit'}): intake,
// understand and research pass straight through and kit_draft never calls the kit designer, so no
// Naïve agent runs before proof. The kit then goes through env_build and the six proof checks on
// our computers like any other; a curated sign-off never applies to it, and a failed proof holds
// the run for the user (no designer repair: their own agent fixes the kit) instead of repairing.
import { randomBytes } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  isTerminalRunState,
  RUN_MAX_PROOF_REPAIRS,
  RUN_PAUSE_BUDGET_FROM,
  safeParseKitSpec,
  formatSchemaIssues,
  frozenGradingPending,
  KitIdSchema,
  newId,
  toJsonValue,
  TrialIdSchema,
  ProjectDigestSchema,
  type AnybenchEvent,
  type EventActor,
  type KitSpec,
  type ProjectDigest,
  type ProofCheckResult,
  type RunCommand,
  type RunId,
  type RunState,
} from "@anybench/core";
import { expandTrials, expandTrialsInputFromKit, TRIAL_MAX_ATTEMPTS } from "@anybench/bench";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { contenders } from "../db/schema/contenders.js";
import { kits } from "../db/schema/kits.js";
import { PreregSchema, preregMismatch, preregistrationOf } from "./prereg.js";
import { projects } from "../db/schema/projects.js";
import { reports } from "../db/schema/reports.js";
import { runs } from "../db/schema/runs.js";
import { trials } from "../db/schema/trials.js";
import type { BillingGate } from "../lib/billing-gate.js";
import { appendEvents } from "../lib/events.js";
import { WORKER_MAX_TICK_AGE_MS } from "../lib/worker-health.js";
import { kitSpecHash, proofOf } from "../routes/kits.js";
import { proofAccepted } from "./proof-score.js";
import {
  launchHeldReason,
  limitWords,
  readRunBudget,
  storeRunBudget,
  terminalRunBudget,
  usd,
  type BudgetPricing,
  type RunBudget,
} from "./budget.js";
import {
  AnalysisSchema,
  EnvBuildSchema,
  isUploadedKitRun,
  ProofResultsSchema,
  CuratedProofSchema,
  type ProofBasis,
  ResearchSchema,
  RunIntakeSchema,
  RunStageOutputsShape,
  UnderstandingSchema,
  type AgentStagePort,
  type EnvBuild,
  type KitDesign,
  type PipelinePort,
  type Research,
  type RunStageOutputs,
  type SessionCanceller,
  type StageContext,
  type StageEventDraft,
  type StageResult,
  type StageRun,
  type StageTrial,
  type Understanding,
} from "./ports.js";
import {
  actorOf,
  cancelQueuedTrials,
  ensureKitContenders,
  kitContenderSlugs,
  nextKitVersion,
  orchestratorStore,
  stageOutputsOf,
  type CommitOptions,
  type KitRow,
  type OrchestratorStore,
  type OrchestratorStoreOptions,
  type RunRow,
  type TrialRow,
} from "./store.js";

export const RUN_ADVANCE_JOB = "run.advance";
export const TRIAL_EXECUTE_TASK = "trial.execute";

/** `trials:<id>:<attempt>`, the key trial.execute uses (jobs/trial-execute.ts). */
export const trialJobKey = (trialId: string, attempt: number) => `trials:${trialId}:${attempt}`;
/** jobs/trial-execute.ts TRIAL_GATE_JOB / trialGateJobKey (not imported: jobs → orchestrator). */
export const TRIAL_GATE_TASK = "trial.gate";
export const trialGateKey = (trialId: string, attempt: number) =>
  `trials:${trialId}:${attempt}:gate`;

export interface OrchestratorTiming {
  /** run.advance lease length. */
  leaseMs: number;
  /** Lease refresh, and the cancel / kill switch check that aborts a running stage. */
  leaseRefreshMs: number;
  /** Look again this long after waiting on trials (running, or a terminal run's cleanup). */
  trialPollMs: number;
  /** Another live worker holds the lease: look again after this. */
  busyRetryMs: number;
}

export const DEFAULT_ORCHESTRATOR_TIMING: OrchestratorTiming = {
  leaseMs: 90_000,
  leaseRefreshMs: 30_000,
  trialPollMs: 15_000,
  busyRetryMs: 30_000,
};

/** graphile-worker, as the orchestrator needs it. */
export interface JobsPort {
  add(
    task: string,
    payload: Record<string, unknown>,
    spec: { jobKey: string; runAt?: Date; maxAttempts?: number },
  ): Promise<void>;
  /** Which of `keys` belong to a job that is waiting to run (or was just picked up). */
  pendingKeys(keys: readonly string[]): Promise<Set<string>>;
  /** Pending job keys starting with `prefix`. */
  pendingKeysWithPrefix(prefix: string): Promise<string[]>;
}

export type CancelCause = "user" | "ours";

/**
 * The run-terminal billing hook (default: packages/billing ledger.recordRunCharges, defaults.ts).
 * Called once every trial of a terminal run settled; must be idempotent.
 */
export interface RunChargesHook {
  recordRunCharges(input: {
    runId: string;
    userId: string;
    state: "delivered" | "failed" | "cancelled";
    cancelCause: CancelCause | null;
    /** TDM-218: an uploaded kit's run pays no kit-generation fee (billing runFeeForKit). */
    kitOrigin: "generated" | "uploaded";
  }): Promise<unknown>;
}

export interface OrchestratorLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface OrchestratorDeps {
  db: Database;
  jobs: JobsPort;
  agents: AgentStagePort;
  pipeline: PipelinePort;
  sessions: SessionCanceller;
  billingGate: BillingGate;
  /** Null = terminal runs are logged, not charged (tests, tools). */
  charges: RunChargesHook | null;
  /** `<worker id>~<worker started ms>` (leaseOwnerBase); a nonce is added per call. */
  owner: string;
  /** ANYBENCH_PAUSE=1: a global kill switch (plan section 5). */
  paused: boolean;
  logger?: OrchestratorLogger;
  timing?: Partial<OrchestratorTiming>;
  workerMaxTickAgeMs?: number;
  /** Test hook: runs before each non-terminal step, with an abort signal (crash simulation). */
  beforeStage?: (state: RunState, signal: AbortSignal) => Promise<void>;
  /** In each state change's transaction (run-email: enqueue run.notify). */
  onStateChange?: OrchestratorStoreOptions["onStateChange"];
  /**
   * TDM-242: enforce the run's budget (orchestrator/budget.ts): keep runs.spent_micro_usd and
   * committed_micro_usd current, launch only the trials whose worst case fits, hold the run in
   * paused_budget when none fits. A free starter run is held to FREE_RUN_CAP_MICRO_USD at our
   * cost (`freeRunCapMicroUsd` here), the same mechanism (TDM-224's free-run hold folded in).
   * Unset = only the legacy spent >= budget check (tests, tools).
   */
  budget?: BudgetPricing;
}

export interface AdvanceOptions {
  /** The worker is going away: stop at once, touch nothing, keep the lease. */
  signal?: AbortSignal;
  /** The job's last attempt: an unexpected error fails the run instead of throwing. */
  lastAttempt?: boolean;
}

export type AdvanceOutcome =
  | { kind: "busy" }
  | { kind: "gone" }
  | { kind: "aborted" }
  | { kind: "lease_lost" }
  /** Nothing to do until someone acts: awaiting_go, needs_human, paused_budget. */
  | { kind: "waiting"; state: RunState; reason?: string }
  /** Trials in flight: run.advance is scheduled again at `at`. */
  | { kind: "polling"; state: RunState; at: Date }
  | { kind: "finalized"; state: RunState };

const MAX_STEPS = 64;
/** TDM-242: stages that can spend before any trial exists (an uploaded kit's proof computers). */
const BEFORE_TRIALS: readonly RunState[] = [
  "understand",
  "research",
  "kit_draft",
  "env_build",
  "proof",
];
const ORCHESTRATOR_MAX_ATTEMPTS = 5;

/** Stages that the sweep re-drives (awaiting_go only with auto-go; terminal until finalized). */
export const ACTIVE_RUN_STATES = [
  "intake",
  "understand",
  "research",
  "kit_draft",
  "env_build",
  "proof",
  "running",
  "scoring",
  "analyzing",
] as const satisfies readonly RunState[];

class Stop extends Error {
  constructor(readonly kind: "aborted" | "lease_lost" | "gone") {
    super(kind);
    this.name = "Stop";
  }
}

type Step =
  | { next: "continue" }
  | { next: "stop"; outcome: Exclude<AdvanceOutcome, { kind: "busy" | "gone" }> };

const CONTINUE: Step = { next: "continue" };

/**
 * kits.files_url for a designed kit (TDM-44 contract C1): `file://<files_dir>` when the designer
 * wrote the kit to disk (env_build and proof need it), else `upload:<id>`, else null.
 */
export function kitFilesUrl(
  design: Pick<KitDesign, "files_dir" | "files_upload_id">,
): string | null {
  if (design.files_dir) return pathToFileURL(path.resolve(design.files_dir)).href;
  return design.files_upload_id ? `upload:${design.files_upload_id}` : null;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A trial that will not change any more on its own. TDM-232: a failed_subject trial whose frozen
 * workspace is still waiting for its gate is not settled yet (the run scores it once graded).
 */
export function trialSettled(
  t: Pick<TrialRow, "state" | "attempt"> & { frozenWorkspace?: unknown },
): boolean {
  if (t.state === "failed_subject") return !frozenGradingPending(t.state, t.frozenWorkspace);
  if (t.state === "done" || t.state === "cancelled") return true;
  return t.state === "failed_infra" && t.attempt >= TRIAL_MAX_ATTEMPTS;
}

export function stageTrialOf(t: TrialRow, slugs: Map<string, string>): StageTrial {
  return {
    id: t.id,
    contender: slugs.get(t.contenderId) ?? t.contenderId,
    contender_id: t.contenderId,
    workload_id: t.workloadId,
    repeat: t.repeat,
    state: t.state,
    attempt: t.attempt,
    metrics: t.metrics,
    gate: t.gate,
    cost_micro_usd: t.costMicroUsd,
    failure_class: t.failureClass,
    frozen_workspace: t.frozenWorkspace,
  };
}

/** Warm-ups share the slot table with measured repeats: warm-up n is stored as repeat -(n+1). */
export function storedRepeat(plan: { repeat: number; warmup: boolean }): number {
  return plan.warmup ? -(plan.repeat + 1) : plan.repeat;
}

export async function advanceRun(
  deps: OrchestratorDeps,
  runId: string,
  opts: AdvanceOptions = {},
): Promise<AdvanceOutcome> {
  return new RunAdvance(deps, runId, opts).run();
}

class RunAdvance {
  private readonly t: OrchestratorTiming;
  private readonly store: OrchestratorStore;
  private readonly owner: string;
  private readonly actor: EventActor;
  private readonly halt = new AbortController();
  private haltKind: "aborted" | "lease_lost" | null = null;
  private stage: AbortController | null = null;

  constructor(
    private readonly deps: OrchestratorDeps,
    private readonly runId: string,
    private readonly opts: AdvanceOptions,
  ) {
    this.t = { ...DEFAULT_ORCHESTRATOR_TIMING, ...deps.timing };
    this.store = orchestratorStore(deps.db, {
      maxTickAgeMs: deps.workerMaxTickAgeMs ?? WORKER_MAX_TICK_AGE_MS,
      ...(deps.onStateChange ? { onStateChange: deps.onStateChange } : {}),
    });
    this.owner = `${deps.owner}~${randomBytes(6).toString("hex")}`;
    this.actor = actorOf(this.owner);
  }

  async run(): Promise<AdvanceOutcome> {
    if (this.opts.signal?.aborted) return { kind: "aborted" };
    const leased = await this.store.acquireLease(this.runId, this.owner, this.t.leaseMs);
    if (!leased) {
      if (!(await this.store.get(this.runId))) return { kind: "gone" };
      // The holder may have missed this wake (a cancel or a kit edit): look again shortly.
      await this.deps.jobs.add(
        RUN_ADVANCE_JOB,
        { run_id: this.runId, reason: "busy" },
        {
          jobKey: `runs:${this.runId}:busy`,
          runAt: new Date(Date.now() + this.t.busyRetryMs),
          maxAttempts: ORCHESTRATOR_MAX_ATTEMPTS,
        },
      );
      return { kind: "busy" };
    }

    const onAbort = () => this.stopWith("aborted");
    this.opts.signal?.addEventListener("abort", onAbort, { once: true });
    const refresher = this.startRefresher();
    let outcome: AdvanceOutcome;
    try {
      outcome = await this.loop();
    } catch (err) {
      clearInterval(refresher);
      if (err instanceof Stop) {
        outcome = { kind: err.kind };
      } else if (this.haltKind) {
        // Aborted (shutdown) or lease lost, then something failed: touch nothing, keep the lease.
        outcome = { kind: this.haltKind };
      } else if (this.opts.lastAttempt) {
        outcome = await this.failAfterLastAttempt(err);
      } else {
        await this.store.releaseLease(this.runId, this.owner).catch(() => {});
        throw err;
      }
    } finally {
      clearInterval(refresher);
      this.opts.signal?.removeEventListener("abort", onAbort);
    }
    if (outcome.kind === "aborted" || outcome.kind === "lease_lost" || outcome.kind === "gone") {
      return outcome;
    }
    try {
      if (outcome.kind === "polling") {
        await this.deps.jobs.add(
          RUN_ADVANCE_JOB,
          { run_id: this.runId, reason: "poll" },
          {
            jobKey: `runs:${this.runId}:poll`,
            runAt: outcome.at,
            maxAttempts: ORCHESTRATOR_MAX_ATTEMPTS,
          },
        );
      }
    } finally {
      await this.store.releaseLease(this.runId, this.owner);
    }
    return outcome;
  }

  // ----- lease, cancel watch -----

  private stopWith(kind: "aborted" | "lease_lost"): void {
    if (this.haltKind) return;
    this.haltKind = kind;
    this.halt.abort();
    this.stage?.abort();
  }

  private checkHalt(): void {
    if (this.haltKind) throw new Stop(this.haltKind);
  }

  private startRefresher(): ReturnType<typeof setInterval> {
    let busy = false;
    let lastOk = Date.now();
    const timer = setInterval(() => {
      if (busy || this.haltKind) return;
      busy = true;
      void (async () => {
        try {
          const ok = await this.store.refreshLease(this.runId, this.owner, this.t.leaseMs);
          if (!ok) return this.stopWith("lease_lost");
          lastOk = Date.now();
          // Cancel / kill switch while a stage runs: abort it; the loop then cancels the run.
          if (this.stage && !this.stage.signal.aborted) {
            const run = await this.store.get(this.runId);
            if (!run) return this.stopWith("lease_lost");
            if (await this.interruptReason(run)) this.stage.abort();
          }
        } catch (err) {
          this.deps.logger?.warn({ err, runId: this.runId }, "run.advance lease refresh failed");
          if (Date.now() - lastOk >= this.t.leaseMs) this.stopWith("lease_lost");
        } finally {
          busy = false;
        }
      })();
    }, this.t.leaseRefreshMs);
    timer.unref?.();
    return timer;
  }

  /** Why the run must stop what it is doing, or null. */
  private async interruptReason(run: RunRow): Promise<string | null> {
    if (isTerminalRunState(run.state)) return `run is ${run.state}`;
    if (run.cancelRequestedAt) return "run cancel requested";
    if (this.deps.paused) return "ANYBENCH_PAUSE=1";
    const kill = await this.store.killSwitch(run);
    return kill ? `kill switch ${kill}` : null;
  }

  // ----- the loop -----

  private async loop(): Promise<AdvanceOutcome> {
    for (let i = 0; i < MAX_STEPS; i++) {
      this.checkHalt();
      const run = await this.store.get(this.runId);
      if (!run) throw new Stop("gone");
      if (run.advanceLeaseOwner !== this.owner) throw new Stop("lease_lost");
      const step = await this.step(run);
      if (step.next === "stop") return step.outcome;
    }
    this.deps.logger?.warn({ runId: this.runId }, "run.advance step limit reached");
    return { kind: "polling", state: "running", at: new Date(Date.now() + this.t.trialPollMs) };
  }

  private async step(run: RunRow): Promise<Step> {
    if (isTerminalRunState(run.state)) return this.finalize(run);

    // Kill switch / pause: we cancel (cause `ours`). A user cancel normally arrives already
    // moved by the API; one that did not (an older API) is moved here with cause `user`.
    const kill = this.deps.paused ? "ANYBENCH_PAUSE=1" : await this.store.killSwitch(run);
    if (kill) return this.cancel(run, "ours", `kill switch ${kill}`);
    if (run.cancelRequestedAt)
      return this.cancel(run, run.cancelCause ?? "user", "cancel requested");

    if (run.state === "needs_human") return this.wait(run.state, run.pausedReason ?? undefined);
    if (run.state === "paused_budget") return this.pausedBudget(run);

    // TDM-242: keep the run's spent / committed current while it can spend, and hold it before
    // the trials (stages before `running`: an uploaded kit's proof computers bill with the run).
    let budget: RunBudget | null = null;
    if ((RUN_PAUSE_BUDGET_FROM as readonly RunState[]).includes(run.state)) {
      if (this.deps.budget) {
        budget = await readRunBudget(this.deps.db, run.id, this.deps.budget);
        if (budget) await storeRunBudget(this.deps.db, budget, this.actor);
        if (budget && BEFORE_TRIALS.includes(run.state) && budget.spent.total > budget.limit) {
          return this.hold(
            run,
            "pause_budget",
            `spent ${usd(budget.spent.total)}, past ${limitWords(budget)}, before any trial ran`,
          );
        }
      } else if (
        run.spentMicroUsd >= run.budgetMicroUsd &&
        run.state !== "scoring" &&
        run.state !== "analyzing"
      ) {
        return this.hold(run, "pause_budget", "the run spent its budget");
      }
    }

    if (this.deps.beforeStage) {
      const ctl = new AbortController();
      this.stage = ctl;
      try {
        await this.deps.beforeStage(run.state, ctl.signal);
      } catch (err) {
        this.checkHalt();
        if (ctl.signal.aborted) return CONTINUE; // interrupted by a cancel: re-read
        throw err;
      } finally {
        this.stage = null;
      }
      this.checkHalt();
    }

    switch (run.state) {
      case "intake":
        return this.intake(run);
      case "understand":
        return this.understand(run);
      case "research":
        return this.research(run);
      case "kit_draft":
        return this.kitDraft(run);
      case "env_build":
        return this.envBuild(run);
      case "proof":
        return this.proof(run);
      case "awaiting_go":
        return this.awaitingGo(run);
      case "running":
        return this.running(run, budget);
      case "scoring":
        return this.scoring(run);
      case "analyzing":
        return this.analyzing(run);
      default:
        return this.wait(run.state);
    }
  }

  // ----- helpers -----

  private wait(state: RunState, reason?: string): Step {
    return { next: "stop", outcome: { kind: "waiting", state, ...(reason ? { reason } : {}) } };
  }

  private poll(state: RunState): Step {
    return {
      next: "stop",
      outcome: { kind: "polling", state, at: new Date(Date.now() + this.t.trialPollMs) },
    };
  }

  private async commit(
    run: RunRow,
    command: RunCommand,
    options: CommitOptions = {},
  ): Promise<Step> {
    const r = await this.store.commit(this.runId, this.owner, run.state, command, options);
    if (r === "lease_lost") throw new Stop("lease_lost");
    if (r === "gone") throw new Stop("gone");
    return CONTINUE; // "ok" → the next stage; "moved" → someone else moved it: re-read
  }

  private async save(run: RunRow, options: Omit<CommitOptions, "reason">): Promise<Step> {
    const r = await this.store.save(this.runId, this.owner, run.state, options);
    if (r === "lease_lost") throw new Stop("lease_lost");
    if (r === "gone") throw new Stop("gone");
    return CONTINUE;
  }

  private advance(run: RunRow, options: CommitOptions = {}): Promise<Step> {
    return this.commit(run, { type: "advance" }, options);
  }

  private async hold(
    run: RunRow,
    type: "needs_human" | "pause_budget",
    reason: string,
    extra: Record<string, unknown> = {},
  ): Promise<Step> {
    const command: RunCommand =
      type === "needs_human" ? { type, reason } : { type: "pause_budget", reason };
    await this.commit(run, command, {
      reason,
      set: { pausedReason: reason.slice(0, 2000) },
      outputs: { held_from: run.state, hold_reason: reason, ...extra },
    });
    this.deps.logger?.warn({ runId: run.id, from: run.state, reason }, `run held: ${type}`);
    return CONTINUE; // re-read: the hold state stops the loop
  }

  private async fail(run: RunRow, reason: string): Promise<Step> {
    this.deps.logger?.warn({ runId: run.id, from: run.state, reason }, "run failed");
    return this.commit(
      run,
      { type: "fail", reason },
      {
        reason,
        // Running trials see cancel_requested_at and stop; the cause stays null (not a cancel).
        set: { cancelRequestedAt: sql`coalesce(${runs.cancelRequestedAt}, now())` },
        outputs: { failure: { stage: run.state, reason } },
      },
    );
  }

  private async cancel(run: RunRow, cause: CancelCause, reason: string): Promise<Step> {
    this.deps.logger?.warn({ runId: run.id, from: run.state, cause, reason }, "cancelling run");
    return this.commit(
      run,
      { type: "cancel", reason },
      {
        reason,
        set: {
          cancelRequestedAt: sql`coalesce(${runs.cancelRequestedAt}, now())`,
          cancelCause: sql`coalesce(${runs.cancelCause}, ${cause})`,
        },
      },
    );
  }

  private stageRun(run: RunRow): StageRun {
    return {
      id: run.id,
      owner_id: run.ownerId,
      project_id: run.projectId,
      question: run.question,
      intake: RunIntakeSchema.parse(run.intake ?? {}),
      budget_micro_usd: run.budgetMicroUsd,
      spent_micro_usd: run.spentMicroUsd,
    };
  }

  /**
   * Run one stage's port call with the stage abort signal. A cancel / kill switch seen meanwhile
   * aborts it and surfaces as Interrupted (the loop re-reads the run and cancels it).
   */
  private async callStage<T>(
    run: RunRow,
    fn: (ctx: StageContext) => Promise<StageResult<T>>,
  ): Promise<StageResult<T> | "interrupted"> {
    this.checkHalt();
    const visit = await this.store.visits(run.id, run.state);
    const ctl = new AbortController();
    this.stage = ctl;
    const ctx: StageContext = {
      run: this.stageRun(run),
      idempotencyKey: `${run.id}:${run.state}:${visit}`,
      signal: ctl.signal,
      emit: (drafts: StageEventDraft[]) => this.emit(drafts),
    };
    try {
      const result = await fn(ctx);
      this.checkHalt();
      if (ctl.signal.aborted) return "interrupted";
      return result;
    } catch (err) {
      this.checkHalt();
      if (ctl.signal.aborted) return "interrupted";
      throw err;
    } finally {
      this.stage = null;
    }
  }

  private async emit(drafts: StageEventDraft[]): Promise<void> {
    if (drafts.length === 0) return;
    const evs = drafts.map((d) => ({ ...d, run_id: this.runId, seq: 0 }) as AnybenchEvent);
    await appendEvents(this.deps.db, this.runId as RunId, evs);
  }

  /** A port said no: hold or fail the run with its reason. */
  private async refused(
    run: RunRow,
    r: { outcome: "needs_human" | "fail"; reason: string },
  ): Promise<Step> {
    return r.outcome === "fail"
      ? this.fail(run, r.reason)
      : this.hold(run, "needs_human", r.reason);
  }

  /** Validate a port's value; a bad value holds the run for a human (it is an agent bug). */
  private async parsed<S extends z.ZodType>(
    run: RunRow,
    schema: S,
    value: unknown,
    what: string,
  ): Promise<{ ok: true; value: z.output<S> } | { ok: false; step: Step }> {
    const r = schema.safeParse(value);
    if (r.success) return { ok: true, value: r.data };
    const issues = formatSchemaIssues(r.error).slice(0, 5).join("; ");
    return {
      ok: false,
      step: await this.hold(run, "needs_human", `${what} is invalid: ${issues}`),
    };
  }

  private outputs(run: RunRow): RunStageOutputs {
    const r = RunStageOutputsShape.safeParse(stageOutputsOf(run));
    return r.success ? r.data : {};
  }

  private async loadDigest(run: RunRow): Promise<ProjectDigest | null> {
    const raw = await this.store.digest(run);
    const r = ProjectDigestSchema.safeParse(raw);
    return r.success ? r.data : null;
  }

  private async loadKit(run: RunRow): Promise<{ row: KitRow; spec: KitSpec } | null> {
    const row = await this.store.kit(run);
    if (!row) return null;
    const r = safeParseKitSpec(row.spec);
    return r.success ? { row, spec: r.data } : null;
  }

  private isRerun(run: RunRow): boolean {
    return this.stageRun(run).intake.source.kind === "kit";
  }

  /** TDM-218: the user uploaded this run's kit (never designed, repaired or curated by us). */
  private isUploaded(run: RunRow): boolean {
    return isUploadedKitRun(run.intake);
  }

  private skipReason(run: RunRow): string {
    return this.isUploaded(run) ? "uploaded kit: no kit generation" : "rerun of a saved kit";
  }

  // ----- stages -----

  private async intake(run: RunRow): Promise<Step> {
    if (this.isRerun(run) || (await this.loadDigest(run))) {
      return this.advance(run, { reason: this.isRerun(run) ? this.skipReason(run) : undefined });
    }
    const r = await this.callStage(run, (ctx) => this.deps.pipeline.ingest(ctx));
    if (r === "interrupted") return CONTINUE;
    if (!r.ok) return this.refused(run, r);
    const digest = await this.parsed(run, ProjectDigestSchema, r.value, "the project digest");
    if (!digest.ok) return digest.step;
    if (!run.projectId) return this.hold(run, "needs_human", "the run has no project to digest");
    const projectId = run.projectId;
    return this.advance(run, {
      writes: async (tx) => {
        await tx
          .update(projects)
          .set({ digest: toJsonValue(digest.value), kind: digest.value.kind })
          .where(eq(projects.id, projectId));
      },
    });
  }

  private async understand(run: RunRow): Promise<Step> {
    if (this.isRerun(run)) return this.advance(run, { reason: this.skipReason(run) });
    const digest = await this.loadDigest(run);
    if (!digest) return this.hold(run, "needs_human", "no project digest to understand");
    const r = await this.callStage(run, (ctx) => this.deps.agents.understand(ctx, { digest }));
    if (r === "interrupted") return CONTINUE;
    if (!r.ok) return this.refused(run, r);
    const u = await this.parsed(run, UnderstandingSchema, r.value, "the understander's output");
    if (!u.ok) return u.step;
    if (u.value.benchable === "skip") {
      return this.fail(run, `not benchable: ${u.value.reason || u.value.summary}`);
    }
    if (u.value.benchable === "needs_hardware") {
      return this.hold(run, "needs_human", `needs hardware: ${u.value.reason || u.value.summary}`);
    }
    return this.advance(run, { outputs: { understand: u.value } });
  }

  private async research(run: RunRow): Promise<Step> {
    if (this.isRerun(run)) return this.advance(run, { reason: this.skipReason(run) });
    const digest = await this.loadDigest(run);
    const understanding = this.outputs(run).understand;
    if (!digest || !understanding) {
      return this.hold(run, "needs_human", "research needs the digest and the understanding");
    }
    const r = await this.callStage(run, (ctx) =>
      this.deps.agents.research(ctx, { digest, understanding }),
    );
    if (r === "interrupted") return CONTINUE;
    if (!r.ok) return this.refused(run, r);
    const research = await this.parsed(run, ResearchSchema, r.value, "the researcher's output");
    if (!research.ok) return research.step;
    return this.advance(run, {
      outputs: { research: research.value },
      writes: async (tx) => {
        if (research.value.baselines.length === 0) return;
        await tx.insert(contenders).values(
          research.value.baselines.map((b) => ({
            runId: run.id,
            source: JSON.stringify({ name: b.name, source: b.source }),
            role: b.role,
            status: "candidate" as const,
            reason: b.why,
            foundBy: "researcher",
          })),
        );
      },
    });
  }

  private async kitDraft(run: RunRow): Promise<Step> {
    const current = await this.store.kit(run);
    // A version nobody has proven yet (the designer's, a user edit, a rerun's copy): prove it.
    if (current && current.proof === null) return this.advance(run);
    // An uploaded kit is the user's: our kit designer never drafts or repairs it (no agent spend).
    if (this.isUploaded(run)) {
      return this.hold(
        run,
        "needs_human",
        current
          ? "the uploaded kit did not pass its proof; fix it locally and upload a new version"
          : "the run's uploaded kit is missing",
      );
    }
    const outputs = this.outputs(run);
    const previous = current ? { spec: current.spec, proof: proofOf(current.proof) } : null;
    const r = await this.callStage(run, async (ctx) =>
      this.deps.agents.designKit(ctx, {
        digest: await this.loadDigest(run),
        understanding: outputs.understand ?? null,
        research: outputs.research ?? null,
        previous,
      }),
    );
    if (r === "interrupted") return CONTINUE;
    if (!r.ok) return this.refused(run, r);
    const spec = safeParseKitSpec(r.value.spec);
    if (!spec.success) {
      const issues = formatSchemaIssues(spec.error).slice(0, 5).join("; ");
      return this.hold(run, "needs_human", `the kit designer's kit is invalid: ${issues}`);
    }
    const filesUrl = kitFilesUrl(r.value);
    const draftedFrom = current?.id ?? null;
    return this.advance(run, {
      writes: async (tx, locked) => {
        // The user saved a kit edit while the designer worked: their version wins.
        if (locked.kitId !== draftedFrom) return;
        const id = newId(KitIdSchema);
        await tx.insert(kits).values({
          id,
          ownerId: run.ownerId,
          runId: run.id,
          version: await nextKitVersion(tx, run.id),
          spec: toJsonValue(spec.data),
          filesUrl,
          proof: null,
          hash: kitSpecHash(spec.data),
        });
        await tx.update(runs).set({ kitId: id }).where(eq(runs.id, run.id));
      },
    });
  }

  private async envBuild(run: RunRow): Promise<Step> {
    const kit = await this.loadKit(run);
    if (!kit) return this.hold(run, "needs_human", "env build needs a valid kit");
    const r = await this.callStage(run, (ctx) =>
      this.deps.pipeline.buildEnv(ctx, { kit_id: kit.row.id, kit: kit.spec }),
    );
    if (r === "interrupted") return CONTINUE;
    if (!r.ok) return this.refused(run, r);
    const env = await this.parsed(run, EnvBuildSchema, r.value, "the env build result");
    if (!env.ok) return env.step;
    return this.advance(run, { outputs: { env: env.value } });
  }

  /** Run the proof suite on the run's kit and store the results on the kit row. */
  private async prove(run: RunRow, kit: { row: KitRow; spec: KitSpec }): Promise<Step> {
    const env: EnvBuild | null = this.outputs(run).env ?? null;
    const r = await this.callStage(run, (ctx) =>
      this.deps.pipeline.prove(ctx, { kit_id: kit.row.id, kit: kit.spec, env }),
    );
    if (r === "interrupted") return CONTINUE;
    if (!r.ok) return this.refused(run, r);
    const proof = await this.parsed(
      run,
      z.union([ProofResultsSchema, CuratedProofSchema]),
      r.value,
      "the proof results",
    );
    if (!proof.ok) return proof.step;
    if (!Array.isArray(proof.value) && this.isUploaded(run)) {
      // Never: a curated sign-off is for our own curated kit, not a kit someone uploaded.
      return this.hold(
        run,
        "needs_human",
        "an uploaded kit is never accepted on a curated sign-off: it needs all six proof checks",
      );
    }
    const kitId = kit.row.id;
    // A curated kit's signed-off offline proof: its checks go on the kit row as they are (the
    // ones not run say so), and the sign-off it was accepted on goes in stage_outputs.
    const checks = Array.isArray(proof.value) ? proof.value : proof.value.checks;
    const basis: ProofBasis | null = Array.isArray(proof.value)
      ? null
      : {
          basis: proof.value.basis,
          label: proof.value.label,
          source: proof.value.source,
          commit: proof.value.commit,
          sha256: proof.value.sha256,
          verified: proof.value.verified,
          kit_id: kitId,
        };
    return this.save(run, {
      ...(basis ? { outputs: { proof_basis: basis } } : {}),
      writes: async (tx) => {
        await tx
          .update(kits)
          .set({ proof: toJsonValue(checks) })
          .where(eq(kits.id, kitId));
      },
    });
  }

  private async estimate(
    run: RunRow,
    kit: { row: KitRow; spec: KitSpec },
    then: (estimate: bigint) => Promise<Step>,
  ): Promise<Step> {
    if (run.estimateMicroUsd !== null) return then(run.estimateMicroUsd);
    const r = await this.callStage(run, (ctx) =>
      this.deps.pipeline.estimate(ctx, { kit_id: kit.row.id, kit: kit.spec }),
    );
    if (r === "interrupted") return CONTINUE;
    if (!r.ok) return this.refused(run, r);
    if (typeof r.value !== "bigint" || r.value < 0n) {
      return this.hold(
        run,
        "needs_human",
        "the cost estimate is not a non-negative micro-USD integer",
      );
    }
    return then(r.value);
  }

  private async proof(run: RunRow): Promise<Step> {
    const kit = await this.loadKit(run);
    if (!kit) return this.hold(run, "needs_human", "proof needs a valid kit");
    if (kit.row.proof === null) return this.prove(run, kit);
    if (proofAccepted(kit.row, run.stageOutputs, run.intake)) {
      return this.estimate(run, kit, (estimate) =>
        this.advance(run, { set: { estimateMicroUsd: estimate } }),
      );
    }
    // Name each failing check with its (check-level, score-free) reason, so a human reading
    // needs_human knows what to fix: "do_less_fails (do-less passed the gate: ...)".
    const failed = proofOf(kit.row.proof).filter((p: ProofCheckResult) => !p.pass);
    const named = failed.map((p) => `${p.check} (${p.reason.replace(/\s+/g, " ").slice(0, 400)})`);
    const what = (named.length > 0 ? named.join("; ") : "missing checks").slice(0, 1700);
    if (this.isUploaded(run)) {
      // No designer repair for an uploaded kit: the user's own agent fixes it and re-uploads.
      return this.hold(run, "needs_human", `the uploaded kit failed its proof: ${what}`);
    }
    const repairs = await this.store.repairs(run.id);
    if (repairs < RUN_MAX_PROOF_REPAIRS) {
      return this.commit(
        run,
        { type: "repair", repairs_so_far: repairs },
        { reason: `proof failed: ${what}` },
      );
    }
    return this.hold(
      run,
      "needs_human",
      `proof failed after ${RUN_MAX_PROOF_REPAIRS} repairs: ${what}`,
    );
  }

  private async awaitingGo(run: RunRow): Promise<Step> {
    const kit = await this.loadKit(run);
    if (!kit) return this.wait(run.state, "no valid kit");
    // A kit edited in awaiting_go starts unproven: rerun the proof here (no edge back to proof).
    if (kit.row.proof === null) return this.prove(run, kit);
    if (!proofAccepted(kit.row, run.stageOutputs, run.intake)) {
      return this.wait(run.state, "the kit has not passed its proof");
    }
    if (run.estimateMicroUsd === null) {
      return this.estimate(run, kit, (estimate) =>
        this.save(run, { set: { estimateMicroUsd: estimate } }),
      );
    }
    if (!this.stageRun(run).intake.auto_go) return this.wait(run.state, "waiting for Go");
    if (run.estimateMicroUsd > run.budgetMicroUsd) {
      return this.wait(run.state, "estimate exceeds the run budget");
    }
    const gate = await this.deps.billingGate(
      { userId: run.ownerId, runId: run.id },
      run.estimateMicroUsd,
    );
    if (!gate.allowed) return this.wait(run.state, `billing gate: ${gate.reason}`);
    // Plan 17.2 rule 6: freeze the kit (hash, files, weights, primary, repeats) at Go.
    const prereg = await preregistrationOf(kit.row, kit.spec);
    return this.commit(
      run,
      { type: "go", estimate_fits_budget: true, billing_gate_passed: true },
      { reason: "auto-go", outputs: { prereg } },
    );
  }

  private async running(run: RunRow, budgetIn: RunBudget | null = null): Promise<Step> {
    const kit = await this.loadKit(run);
    if (!kit) return this.hold(run, "needs_human", "running needs a valid kit");
    let all = await this.store.trials(run.id);
    if (all.length < this.plan(run, kit.spec).length) {
      // Before any contender trial exists: freeze the kit (auto-go froze it at Go; a Go through
      // the API is frozen here), and refuse a kit that changed since it was frozen.
      const now = await preregistrationOf(kit.row, kit.spec);
      const frozen = PreregSchema.safeParse(this.outputs(run).prereg);
      if (!frozen.success) return this.save(run, { outputs: { prereg: now } });
      const changed = preregMismatch(frozen.data, now);
      if (changed) {
        return this.hold(
          run,
          "needs_human",
          `the kit changed after it was preregistered at Go (${changed}): prove it again before Go`,
        );
      }
      const created = await this.ensureTrials(run, kit);
      if (created === null) return CONTINUE; // the run moved: re-read
      all = await this.store.trials(run.id);
    }
    if (this.deps.budget) {
      // The trials were just expanded: read the budget again so they are in its queue.
      const budget =
        budgetIn && budgetIn.queued.length + budgetIn.inFlight.length > 0
          ? budgetIn
          : await readRunBudget(this.deps.db, run.id, this.deps.budget);
      if (budget) {
        const held = await this.budgetHold(run, budget);
        if (held) return held;
        await this.enqueueTrialJobs(all, this.launchable(budget));
      } else {
        await this.enqueueTrialJobs(all);
      }
    } else {
      await this.enqueueTrialJobs(all);
    }
    if (all.length > 0 && all.every(trialSettled)) {
      return this.advance(run, { reason: `${all.length} trials settled` });
    }
    return this.poll(run.state);
  }

  /**
   * TDM-242: the queued trials that may launch now, in order: each one's worst case must fit on
   * top of spent, committed and the ones before it. The trial store admits each launch again
   * under the run's lock, so this only avoids launching jobs that would be held.
   */
  private launchable(b: RunBudget): Set<string> {
    const out = new Set<string>();
    let room = b.limit - b.spent.total - b.committed;
    for (const q of b.queued) {
      if (q.cap > room) break;
      out.add(q.id);
      room -= q.cap;
    }
    return out;
  }

  /**
   * TDM-242: hold a running run for its budget, or null.
   * - spent alone passed the limit while trials run (one overran its cap): hold, and stop the
   *   running trials' subjects (budget_stop): their work so far is collected and graded.
   * - queued trials remain, none fits, nothing is in flight: hold (running trials finish first,
   *   since their committed worst case may come in lower and free the room).
   */
  private async budgetHold(run: RunRow, b: RunBudget): Promise<Step | null> {
    const finished = (await this.store.trials(run.id)).filter(
      (t) => t.state === "done" || t.state === "failed_subject",
    ).length;
    // What the user can do: raise the budget (a free run's cap is ours: only settle or cancel).
    const options =
      b.basis === "free_run"
        ? `Settle to score the ${finished} finished, or cancel`
        : `Raise the budget to run them, or settle to score the ${finished} finished`;
    if (b.spent.total > b.limit && b.inFlight.length > 0) {
      const reason =
        `spent ${usd(b.spent.total)}, past ${limitWords(b)}: stopping the ${b.inFlight.length} ` +
        `running trial(s); what they did so far is graded. ${b.queued.length} trial(s) not ` +
        `started. ${options}`;
      return this.hold(run, "pause_budget", reason, {
        budget_stop: {
          at: new Date().toISOString(),
          reason: `spent ${usd(b.spent.total)}, past ${limitWords(b)}`,
        },
      });
    }
    const next = b.queued[0];
    if (!next || b.inFlight.length > 0 || this.launchable(b).size > 0) return null;
    const reason = `${launchHeldReason(b, next.cap)}. ${b.queued.length} trial(s) not started. ${options}`;
    return this.hold(run, "pause_budget", reason);
  }

  /**
   * TDM-242: a run held for its budget. Keep its numbers current (trials stopped by a budget stop
   * are still finishing); once every trial has settled (the user settled the rest, or the budget
   * stop ended them all and none is queued), the trials are paid for: resume into running, which
   * scores the run. Otherwise wait for the user (resume with a higher budget, settle, cancel).
   */
  private async pausedBudget(run: RunRow): Promise<Step> {
    let inFlight = 0;
    if (this.deps.budget) {
      const b = await readRunBudget(this.deps.db, run.id, this.deps.budget);
      if (b) {
        await storeRunBudget(this.deps.db, b, this.actor);
        inFlight = b.inFlight.length;
      }
    }
    const from = this.outputs(run).held_from;
    const all = await this.store.trials(run.id);
    if (from === "running" && all.length > 0 && all.every(trialSettled)) {
      const reason = `every trial settled (${all.length}): scoring what the budget paid for`;
      return this.commit(
        run,
        { type: "resume", to: "running" },
        { reason, set: { pausedReason: null }, outputs: { budget_stop: null } },
      );
    }
    if (inFlight > 0) return this.poll(run.state);
    return this.wait(run.state, run.pausedReason ?? undefined);
  }

  /**
   * Insert the kit's trial plan once: (run, contender, workload, repeat) is unique, so a crashed
   * or repeated expansion inserts nothing new. Each new trial gets its {null → queued} event.
   * Returns how many were created, or null when the guard failed.
   */
  private async ensureTrials(
    run: RunRow,
    kit: { row: KitRow; spec: KitSpec },
  ): Promise<number | null> {
    // TODO([5.3] scheduler): packed blocks (reuse_computer_id / keep_computer), the
    // max_computers / per-user / per-run caps and the per-launch budget check. Until then every
    // trial gets its own computer and graphile-worker's concurrency bounds parallelism.
    const plan = this.plan(run, kit.spec);
    let created = 0;
    const r = await this.store.save(this.runId, this.owner, run.state, {
      writes: async (tx) => {
        const slugs = await ensureKitContenders(
          tx,
          run.id,
          kit.row.id,
          kit.spec.contenders.map((c) => ({ id: c.id, role: c.role })),
        );
        const rows = plan.map((p) => ({
          id: p.trial_id,
          ownerId: run.ownerId,
          runId: run.id,
          contenderId: slugs.get(p.contender_id)!,
          workloadId: p.workload_id,
          repeat: storedRepeat(p),
        }));
        const inserted: { id: string; attempt: number }[] = [];
        for (let i = 0; i < rows.length; i += 500) {
          const chunk = await tx
            .insert(trials)
            .values(rows.slice(i, i + 500))
            .onConflictDoNothing({
              target: [trials.runId, trials.contenderId, trials.workloadId, trials.repeat],
            })
            .returning({ id: trials.id, attempt: trials.attempt });
          inserted.push(...chunk);
        }
        created = inserted.length;
        if (inserted.length > 0) {
          const at = new Date().toISOString();
          await appendEvents(
            tx,
            run.id as RunId,
            inserted.map((t): AnybenchEvent => ({
              run_id: run.id,
              seq: 0,
              type: "trial.phase",
              source: "trial",
              source_id: t.id,
              severity: "info",
              actor: this.actor,
              cost_delta_micro_usd: 0n,
              at,
              payload: { from: null, to: "queued", attempt: t.attempt },
            })),
          );
        }
      },
    });
    if (r === "lease_lost") throw new Stop("lease_lost");
    if (r === "gone") throw new Stop("gone");
    return r === "ok" ? created : null;
  }

  private plan(run: RunRow, spec: KitSpec) {
    return expandTrials(expandTrialsInputFromKit(run.id, spec), {
      newTrialId: () => newId(TrialIdSchema),
    });
  }

  /**
   * trial.execute for every trial that should run and has no live job (lost enqueues too).
   * `launchable` (TDM-242): only these queued trials get a launch job (the budget's pick).
   */
  private async enqueueTrialJobs(all: TrialRow[], launchable?: Set<string>): Promise<void> {
    const wanted: { task: string; key: string; payload: Record<string, unknown> }[] = [];
    for (const t of all) {
      if (t.leaseOwner) continue; // an executor holds it (trial.reattach covers a dead one)
      if (t.state === "queued") {
        if (launchable && !launchable.has(t.id)) continue;
        wanted.push({
          task: TRIAL_EXECUTE_TASK,
          key: trialJobKey(t.id, t.attempt),
          payload: { trial_id: t.id },
        });
      } else if (frozenGradingPending(t.state, t.frozenWorkspace)) {
        // TDM-232: the executor enqueues this grade itself; this only replaces one that was lost.
        wanted.push({
          task: TRIAL_GATE_TASK,
          key: trialGateKey(t.id, t.attempt),
          payload: { trial_id: t.id, attempt: t.attempt },
        });
      } else if (t.state === "failed_infra" && t.attempt < TRIAL_MAX_ATTEMPTS) {
        // The executor schedules this retry itself; this only replaces one that was lost.
        wanted.push({
          task: TRIAL_EXECUTE_TASK,
          key: trialJobKey(t.id, t.attempt + 1),
          payload: { trial_id: t.id, retry: true },
        });
      }
    }
    if (wanted.length === 0) return;
    const pending = await this.deps.jobs.pendingKeys(wanted.map((w) => w.key));
    for (const w of wanted) {
      if (pending.has(w.key)) continue;
      await this.deps.jobs.add(w.task, w.payload, { jobKey: w.key });
    }
  }

  private async stageTrials(run: RunRow): Promise<StageTrial[]> {
    const slugs = await kitContenderSlugs(this.deps.db, run.id);
    return (await this.store.trials(run.id)).map((t) => stageTrialOf(t, slugs));
  }

  private async scoring(run: RunRow): Promise<Step> {
    const kit = await this.loadKit(run);
    if (!kit) return this.hold(run, "needs_human", "scoring needs a valid kit");
    const trialsIn = await this.stageTrials(run);
    const r = await this.callStage(run, (ctx) =>
      this.deps.pipeline.score(ctx, { kit_id: kit.row.id, kit: kit.spec, trials: trialsIn }),
    );
    if (r === "interrupted") return CONTINUE;
    if (!r.ok) return this.refused(run, r);
    return this.advance(run, { outputs: { score: toJsonValue(r.value) } });
  }

  private async analyzing(run: RunRow): Promise<Step> {
    const kit = await this.loadKit(run);
    if (!kit) return this.hold(run, "needs_human", "analysis needs a valid kit");
    const trialsIn = await this.stageTrials(run);
    const proof = proofOf(kit.row.proof);
    const outputs = this.outputs(run);
    const score = outputs.score ?? null;
    const basis =
      !this.isUploaded(run) && outputs.proof_basis?.kit_id === kit.row.id
        ? outputs.proof_basis
        : null;
    const r = await this.callStage(run, (ctx) =>
      this.deps.agents.analyze(ctx, {
        kit_id: kit.row.id,
        kit: kit.spec,
        score,
        proof,
        proof_basis: basis,
        trials: trialsIn,
      }),
    );
    if (r === "interrupted") return CONTINUE;
    if (!r.ok) return this.refused(run, r);
    // The run, kit and comp flag are ours, not the analyst's to claim.
    const raw = r.value as { report?: Record<string, unknown> } | null;
    const candidate =
      raw && typeof raw === "object" && raw.report && typeof raw.report === "object"
        ? {
            ...raw,
            report: {
              ...raw.report,
              run_id: run.id,
              kit_id: kit.row.id,
              comped: run.compedBy !== null,
            },
          }
        : raw;
    // ReportSchema refuses a measured value without a passing gate (the correctness rule).
    const analysis = await this.parsed(run, AnalysisSchema, candidate, "the report");
    if (!analysis.ok) return analysis.step;
    const json = toJsonValue(analysis.value.report);
    return this.advance(run, {
      writes: async (tx) => {
        await tx
          .insert(reports)
          .values({ ownerId: run.ownerId, runId: run.id, json, md: analysis.value.md })
          .onConflictDoUpdate({
            target: reports.runId,
            set: { json, md: analysis.value.md, updatedAt: sql`now()` },
          });
      },
    });
  }

  // ----- terminal -----

  private async finalize(run: RunRow): Promise<Step> {
    const outputs = this.outputs(run);
    if (outputs.finalized_at)
      return { next: "stop", outcome: { kind: "finalized", state: run.state } };
    if (run.state !== "delivered") {
      // Running trials stop on cancel_requested_at (trial executor); make sure it is set.
      if (!run.cancelRequestedAt) {
        await this.save(run, {
          set: { cancelRequestedAt: sql`coalesce(${runs.cancelRequestedAt}, now())` },
        });
        return CONTINUE;
      }
      const sessions = await this.deps.sessions.cancelRunSessions(run.id);
      const cancelled = await cancelQueuedTrials(
        this.deps.db,
        run.id,
        this.actor,
        `run ${run.state}`,
      );
      if (sessions > 0 || cancelled.length > 0) {
        this.deps.logger?.info(
          { runId: run.id, sessions, trials: cancelled.length },
          "stopped the run's sessions and queued trials",
        );
      }
    }
    const open = (await this.store.trials(run.id)).filter((t) => !trialSettled(t));
    if (open.length > 0) return this.poll(run.state);

    const state = run.state as "delivered" | "failed" | "cancelled";
    const cancelCause = state === "cancelled" ? (run.cancelCause ?? "user") : null;
    if (this.deps.charges) {
      await this.deps.charges.recordRunCharges({
        runId: run.id,
        userId: run.ownerId,
        state,
        cancelCause,
        kitOrigin: this.isUploaded(run) ? "uploaded" : "generated",
      });
    } else {
      this.deps.logger?.info({ runId: run.id, state, cancelCause }, "run ended (no billing hook)");
    }
    if (this.deps.budget) {
      // TDM-242: the run's spent becomes what the ledger actually charged; nothing is committed.
      const b = await terminalRunBudget(this.deps.db, run.id, this.deps.budget);
      if (b) await storeRunBudget(this.deps.db, b, this.actor);
    }
    await this.save(run, { outputs: { finalized_at: new Date().toISOString() } });
    return { next: "stop", outcome: { kind: "finalized", state: run.state } };
  }

  private async failAfterLastAttempt(err: unknown): Promise<AdvanceOutcome> {
    const reason = `run.advance gave up: ${errMessage(err)}`;
    this.deps.logger?.error({ err, runId: this.runId }, reason);
    const run = await this.store.get(this.runId);
    if (run && !isTerminalRunState(run.state)) {
      const r = await this.store.commit(
        this.runId,
        this.owner,
        run.state,
        { type: "fail", reason },
        {
          reason,
          set: { cancelRequestedAt: sql`coalesce(${runs.cancelRequestedAt}, now())` },
          outputs: { failure: { stage: run.state, reason } },
        },
      );
      if (r === "ok") {
        // Clean up in the background of the next wake: the sweep finalizes failed runs.
        return { kind: "polling", state: "failed", at: new Date(Date.now() + this.t.trialPollMs) };
      }
    }
    return { kind: "waiting", state: run?.state ?? "failed", reason };
  }
}

export type { Understanding, Research };
