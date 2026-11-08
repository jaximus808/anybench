// Trial executor (TDM-49, plan.md P3 "Trial executor" and section 5 "Leases", "Cancellation").
//
// Runs ONE attempt of one trial on an eval computer, provider-agnostic, with every side effect
// behind an injected port:
//   - `store` (TrialExecStore): the `trials` row, its lease, state transitions + trial.phase
//     events (one atomic write each), runner-reported edges, cancel / kill-switch state.
//   - `registry` (@anybench/envs ComputerRegistry): every computer gets a `computers` row BEFORE
//     the provider create, is tagged `ab-<run>-<trial>` (trialTag) and is costed on destroy.
//   - `source` (TrialSource): flattens the kit into the runner's TrialJob, the computer spec
//     (snapshot to fork), secrets and workload files.
//   - `ingest`: the runner ingest URL + a per-attempt token minter (mintRunnerToken), or null for
//     file-only (egress blocked): the executor then follows status.json alone.
//
// Flow of one attempt:
//   lease (lease_owner / lease_until, refreshed every 30 s) → queued → forking: registry.create
//   (fork the snapshot) or reuse the block's computer → installing: clean ~/eval, fs.write
//   ~/.anybench/env (0600, secrets) and ~/.anybench/trial.json (0600, carries the token), start the
//   runner detached (provider.execDetached: setsid nohup with stdin, stdout and stderr redirected;
//   nothing secret on the command line) → watch: runner trial.phase edges from the store and
//   ~/eval/out/status.json, applied with transitionTrial FROM THE STORE's state (payload.from is
//   never trusted: the runner token is readable by the agent under test), liveness from
//   status.json heartbeat changes (worker clock, so VM clock skew does not matter) → runner done:
//   record machine / exit code / bundle key, hand the trial to the gate (`collected`) → destroy
//   the computer, or keep it for the next trial in the same paid block.
//
// Failures and retries. Everything the runner reports (ingest edges, status.json) is writable by
// the agent under test, and failed_infra is retried and never billed, so a runner's word can
// never cause a retry or an unbilled end:
//   - failed_subject (the runner says so, e.g. wall-clock or token cap) is final, never retried.
//   - A failure the RUNNER claims (a failed_infra edge, status.result.outcome failed_infra, or a
//     final phase with no outcome) is final too: failed_subject with failure_class
//     `runner:<class>`.
//   - A `cancelled` the runner claims is honoured only when the run really is cancelled
//     (store.cancelState) or this execution wrote ~/.anybench/cancel; otherwise it is
//     failed_subject with failure_class `unrequested_cancel`.
//   - Only failures the WORKER observes are failed_infra: provider errors, the computer gone or
//     destroyed (provider inspect), the deadline, prepare, heartbeat_lost, runner_start and
//     runner_lost. They destroy the computer and retry after trialRetryDelayMs as a NEW attempt:
//     attempt + 1, so the runner token changes and the old runner's batches are refused.
//     Caveat: heartbeat_lost, runner_start and runner_lost can still be caused by the subject
//     killing the runner (or the whole machine); that costs it a retry, not a free result, and
//     the report shows attempts per trial (follow-up logged).
//   - The deadline runs from trials.started_at (set when the attempt leaves `queued`), so a
//     re-attach never restarts it.
//   - Attempts are clamped to the DB: core allows TRIAL_MAX_INFRA_RETRIES = 3 retries (4 tries),
//     but `trials_attempt_check` is `attempt between 1 and 3`, so TRIAL_MAX_ATTEMPTS = 3 (2
//     retries). Raising the DB check (a migration) lifts the clamp with no change here.
//
// Cancellation: runs.cancel_requested_at or an active kill switch (global | run | user), checked
// at every phase boundary and every watch poll: write ~/.anybench/cancel, give the runner a short
// grace to stop, destroy the computer, trial → cancelled.
//
// Crash recovery: the runner is detached, so a worker that dies mid-trial loses nothing. Its lease
// stops being refreshed; once it is expired (or its owner's worker heartbeat is stale) the lease is
// takeable and `reattachOrphans` hands the trial to a new execution, which finds the computer by
// `trials.computer_id`, reads status.json and carries on watching. It never creates a second
// computer or launches a second runner for the same attempt.
import {
  AnybenchEventSchema,
  isTerminalTrialState,
  TRIAL_MAX_INFRA_RETRIES,
  TRIAL_PHASES,
  transitionTrial,
  trialRetryDelayMs,
  type AnybenchEvent,
  type EventActor,
  type KitSpec,
  type MicroUsd,
  type TrialCommand,
  type TrialState,
} from "@anybench/core";
import type { ComputerRegistry } from "@anybench/envs";
import {
  contenderDriverEnv,
  createProxyKeyGuard,
  DRIVER_TOKEN_CAP_FILE,
  type ProxyKeyGuard,
} from "@anybench/kit";
import {
  decodeText,
  isProviderError,
  shellQuote,
  trialTag,
  type ComputerInfo,
  type ComputerSpecInput,
} from "@anybench/providers";
import {
  isFinalRunnerPhase,
  runnerPaths,
  RunnerStatusSchema,
  TRIAL_JOB_VERSION,
  TRIAL_STATE_BY_RUNNER_PHASE,
  TrialJobSchema,
  type RunnerPaths,
  type RunnerStatus,
  type TrialJob,
  type TrialJobInput,
} from "@anybench/runner";
import { randomBytes } from "node:crypto";
import { z } from "zod";

// ---------- constants ----------

/** plan.md section 5: lease_until = now + 90 s. */
export const EXECUTOR_LEASE_MS = 90_000;
/** plan.md section 5: refreshed every 30 s. */
export const EXECUTOR_LEASE_REFRESH_MS = 30_000;
/** How often the executor reads status.json and the runner's edges. */
export const EXECUTOR_POLL_MS = 5_000;
/** `trials_attempt_check`: attempt between 1 and 3 (apps/server/src/db/schema/trials.ts). */
export const DB_MAX_TRIAL_ATTEMPTS = 3;
/**
 * Tries a trial gets: core's 1 + TRIAL_MAX_INFRA_RETRIES (4) clamped to the DB check (3). So a
 * trial is retried at most twice today; see the header.
 */
export const TRIAL_MAX_ATTEMPTS = Math.min(1 + TRIAL_MAX_INFRA_RETRIES, DB_MAX_TRIAL_ATTEMPTS);
/** Separator in `lease_owner`: `<worker id>~<worker started ms>~<execution nonce>`. */
export const LEASE_OWNER_SEPARATOR = "~";

// ---------- the trial row ----------

/** The part of a `trials` row (plus its run's owner) the executor reads. */
export interface ExecTrial {
  id: string;
  run_id: string;
  owner_id: string;
  state: TrialState;
  attempt: number;
  computer_id: string | null;
  provider: string | null;
  lease_owner: string | null;
  lease_until: Date | null;
  started_at: Date | null;
  ended_at: Date | null;
  failure_class: string | null;
  exit_code: number | null;
  logs_url: string | null;
  machine: unknown;
  cost_micro_usd: MicroUsd;
  log_offset: number;
}

/** Columns the executor writes besides state. */
export type TrialPatch = Partial<
  Pick<
    ExecTrial,
    | "attempt"
    | "computer_id"
    | "provider"
    | "started_at"
    | "ended_at"
    | "failure_class"
    | "exit_code"
    | "logs_url"
    | "machine"
    | "cost_micro_usd"
    | "log_offset"
  >
>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An event before the store assigns `run_id` and the run-wide `seq`. */
export type ExecEventDraft = DistributiveOmit<AnybenchEvent, "seq" | "run_id">;

export interface TransitionRequest {
  command: TrialCommand;
  /** The store refuses the write unless the row's attempt is still this one. */
  expectAttempt: number;
  patch?: TrialPatch;
  /** Write a trial.phase event with the state change (false when the runner already reported it). */
  emit: boolean;
  actor: EventActor;
  at: Date;
}

export type TransitionOutcome =
  | { ok: true; trial: ExecTrial; from: TrialState; to: TrialState }
  | {
      ok: false;
      reason: "not_found" | "lease_lost" | "stale_attempt" | "illegal";
      message: string;
      trial: ExecTrial | null;
    };

/** A trial.phase edge the runner reported through ingest (untrusted: only `to` is used). */
export interface RunnerEdge {
  to: TrialState;
  /** As the runner claimed it. Used only to avoid writing the same edge twice; never applied. */
  from: TrialState | null;
  reason?: string;
  failure_class?: string;
}

export interface CancelState {
  cancelled: boolean;
  reason?: string;
}

/** The DB port (apps/server implements it with Drizzle; MemoryTrialExecStore for tests). */
export interface TrialExecStore {
  get(trialId: string): Promise<ExecTrial | null>;
  /**
   * Take the lease if it is free, already ours, expired, or held by a dead owner. Atomic
   * (compare-and-set). Returns the row on success, null when another live owner holds it.
   */
  acquireLease(trialId: string, owner: string, leaseMs: number): Promise<ExecTrial | null>;
  /** Extend our lease; false when we no longer hold it. */
  refreshLease(trialId: string, owner: string, leaseMs: number): Promise<boolean>;
  /** Clear the lease if we hold it. */
  releaseLease(trialId: string, owner: string): Promise<void>;
  /**
   * Apply one command with transitionTrial from the row's CURRENT state, only while `owner` holds
   * the lease and the attempt matches; state, patch and the trial.phase event in one write.
   */
  transition(trialId: string, owner: string, req: TransitionRequest): Promise<TransitionOutcome>;
  /** Write columns while `owner` holds the lease; false when it does not. */
  patch(trialId: string, owner: string, patch: TrialPatch): Promise<boolean>;
  /** trial.phase edges the runner pushed for this attempt (actor runner), oldest first. */
  runnerEdges(trial: ExecTrial): Promise<RunnerEdge[]>;
  /** runs.cancel_requested_at, kill switches (global | run | user). */
  cancelState(trial: ExecTrial): Promise<CancelState>;
  /** Append events to the trial's run (computer.created / destroyed). */
  emit(trial: ExecTrial, events: ExecEventDraft[]): Promise<void>;
}

/** What the kit says about one trial: the runner job, the computer, secrets, workload files. */
export interface TrialPrepared {
  /** TrialJob minus what the executor fills (identity, attempt, ingest, lease owner). */
  job: Omit<
    TrialJobInput,
    "version" | "trial_id" | "run_id" | "attempt" | "ingest" | "lease_owner"
  >;
  /** The computer to create (snapshotId = the built env to fork). Ignored when reusing one. */
  computer: ComputerSpecInput;
  /** KEY → value, written to ~/.anybench/env (0600). Never logged, never on a command line. */
  secrets: Record<string, string>;
  /** Workload inputs and the like, relative to the computer's home (e.g. `eval/in/words.txt`). */
  files?: { path: string; content: string | Uint8Array; mode?: number }[];
  /** TDM-39: the trial's Naïve proxy key, when its tokens come from the Naïve proxy. */
  proxy_key?: TrialProxyKey;
}

/**
 * TDM-39 [4.7]: a per-trial Naïve `proxy:write` key (TDM-16 `provisionClaudeCodeProxyEnv`). It has
 * no Naïve-side spend cap, so the executor polls `enforce` every heartbeat, revokes the moment a
 * cap is hit (the runner's status.json `token_cap.exceeded`, or the coding-agent driver's
 * EVAL_OUT/coding-agent/token-cap.json), and revokes at the end of the attempt on every path
 * except a worker abort / lost lease (the attempt is still running and gets re-attached).
 * Put the proxy env file itself in `files` (`.anybench/proxy.env`, mode 0o600).
 */
export interface TrialProxyKey {
  /** Revoke the key (TDM-16 `revokeTrialProxyCredential`). Must be idempotent. */
  revoke: () => Promise<void>;
  /** Each poll: TDM-16 `enforceTrialProxyBudget({keyId, capMicroUsd})` (revokes at the cap). */
  enforce?: () => Promise<void>;
  /**
   * The key's secret. Added to ~/.anybench/env as ANYBENCH_PROXY_AUTH_TOKEN so the runner redacts
   * it from every log and event, even when the agent prints its env file into its transcript.
   */
  secret?: string;
}

/** ~/.anybench/env name that carries the proxy secret for the runner's redaction list. */
export const PROXY_SECRET_ENV_NAME = "ANYBENCH_PROXY_AUTH_TOKEN";

export interface TrialSource {
  prepare(trial: ExecTrial): Promise<TrialPrepared>;
}

export interface IngestPort {
  /** Base URL of the runner ingest API (trial.json `ingest.url`). */
  url: string;
  /** mintRunnerToken(secret, trialId, attempt): a new token per attempt. */
  token(trialId: string, attempt: number): string;
  /** Extra IngestConfig fields (flush_ms, batch_max, ...). */
  options?: Partial<Omit<NonNullable<TrialJobInput["ingest"]>, "url" | "token">>;
}

export interface ExecLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface ExecutorTiming {
  leaseMs: number;
  leaseRefreshMs: number;
  pollMs: number;
  /** waitReady timeout for a new computer. */
  readyTimeoutMs: number;
  /** No status.json for this attempt this long after launch (or re-attach) → failed_infra. */
  startTimeoutMs: number;
  /**
   * No change in status.json (heartbeat_at / updated_at / phase) this long → runner presumed dead.
   * Default: 3 heartbeats + 15 s, at least 30 s.
   */
  staleMs?: number;
  /** After writing ~/.anybench/cancel, wait this long for the runner to stop before destroying. */
  cancelGraceMs: number;
  /** Over this since the runner launch → kill, failed_infra (plan: "over 2× its estimate"). */
  deadlineMs?: (job: TrialJob) => number;
}

export const DEFAULT_EXECUTOR_TIMING: ExecutorTiming = {
  leaseMs: EXECUTOR_LEASE_MS,
  leaseRefreshMs: EXECUTOR_LEASE_REFRESH_MS,
  pollMs: EXECUTOR_POLL_MS,
  readyTimeoutMs: 300_000,
  startTimeoutMs: 120_000,
  cancelGraceMs: 15_000,
};

/** 2 × the longest the runner may legitimately take (every run at its cap plus the verbs). */
export function defaultTrialDeadlineMs(job: TrialJob): number {
  const runs = (job.warmup_runs + 1) * job.wall_clock_s;
  const verbs = 4 * job.verb_timeout_s + job.ready_timeout_s;
  return 2 * (runs + verbs) * 1000 + 60_000;
}

export interface ExecutorDeps {
  store: TrialExecStore;
  registry: ComputerRegistry;
  source: TrialSource;
  ingest: IngestPort | null;
  /** This worker's identity: `<worker id>~<worker started ms>`. A nonce is added per execution. */
  owner: string;
  /** Runner binary on the computer; default `<home>/.anybench/bin/runner`. */
  runnerBin?: (home: string) => string;
  /** Upload the frozen bundle when the runner's own upload failed (fs/read fallback). */
  fallbackUpload?: (trial: ExecTrial, bundle: Uint8Array) => Promise<{ key: string } | null>;
  timing?: Partial<ExecutorTiming>;
  actor?: EventActor;
  logger?: ExecLogger;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface ExecuteOptions {
  /**
   * A failed_infra trial with tries left: retry it now (the delayed retry job, or the in-process
   * launcher after its backoff). Default false: report `retry` with the time it is due.
   */
  retryNow?: boolean;
  /** Use this registry computer (the block's) instead of creating one. */
  reuseComputerId?: string;
  /** Leave the computer running at the end: another trial of the same block follows. */
  keepComputer?: boolean;
  /**
   * Abort = the worker is going away (shutdown, or a test killing it): stop at once, touch
   * nothing, keep the lease. The trial is re-attached once the lease is takeable.
   */
  signal?: AbortSignal;
  /** Runs while the lease is still held, before it is released (enqueue trial.gate / the retry). */
  beforeRelease?: (outcome: ExecuteOutcome) => Promise<void>;
}

export type ExecuteOutcome =
  /** The runner finished; the trial is `collecting`, waiting for the gate (trial.gate). */
  | {
      kind: "collected";
      trial: ExecTrial;
      cost_micro_usd: MicroUsd;
      /** The computer, when kept for the next trial of the block. */
      kept_computer_id: string | null;
    }
  /** done | failed_subject | cancelled | failed_infra with no tries left. */
  | {
      kind: "final";
      trial: ExecTrial;
      state: TrialState;
      cost_micro_usd: MicroUsd;
      kept_computer_id: string | null;
    }
  /** failed_infra with tries left: run again (retryNow) at `retry_at` (epoch ms). */
  | {
      kind: "retry";
      trial: ExecTrial;
      retry_at: number;
      /** trialRetryDelayMs(attempt): how long after this outcome the retry is due. */
      delay_ms: number;
      next_attempt: number;
    }
  /** Another live execution holds the lease. */
  | { kind: "busy"; trial: ExecTrial | null }
  /** We lost the lease mid-flight (someone took it over); we stopped without touching anything. */
  | { kind: "lease_lost"; trial: ExecTrial | null }
  /** ExecuteOptions.signal fired. */
  | { kind: "aborted"; trial: ExecTrial | null };

// ---------- pure helpers ----------

/** `<worker id>~<started ms>`: the executor appends `~<nonce>` per execution. */
export function leaseOwnerBase(workerId: string, workerStartedAt: Date): string {
  if (workerId.includes(LEASE_OWNER_SEPARATOR)) {
    throw new Error(
      `worker id ${JSON.stringify(workerId)} may not contain ${LEASE_OWNER_SEPARATOR}`,
    );
  }
  return `${workerId}${LEASE_OWNER_SEPARATOR}${workerStartedAt.getTime()}`;
}

/** Split a lease owner back into its worker id and worker start (ms); null if it is not one. */
export function parseLeaseOwner(owner: string): { workerId: string; startedMs: number } | null {
  const [workerId, started] = owner.split(LEASE_OWNER_SEPARATOR);
  const startedMs = Number(started);
  if (!workerId || !Number.isSafeInteger(startedMs)) return null;
  return { workerId, startedMs };
}

/** Whether `owner` may take the lease of `trial` at `now` (`ownerAlive` for the current holder). */
export function leaseTakeable(
  trial: Pick<ExecTrial, "lease_owner" | "lease_until">,
  owner: string,
  now: number,
  ownerAlive: (holder: string) => boolean,
): boolean {
  if (trial.lease_owner === null || trial.lease_owner === owner) return true;
  if (trial.lease_until === null || trial.lease_until.getTime() <= now) return true;
  return !ownerAlive(trial.lease_owner);
}

/** Trial states an execution may be in the middle of (re-attach candidates when orphaned). */
export const EXECUTING_TRIAL_STATES = [
  "forking",
  "installing",
  "warming",
  "running",
  "collecting",
  "failed_infra",
] as const satisfies readonly TrialState[];

/** The trial.phase event of one transition. Both stores use it, so events look the same. */
export function trialPhaseEvent(
  trial: Pick<ExecTrial, "id" | "attempt">,
  from: TrialState,
  to: TrialState,
  command: TrialCommand,
  actor: EventActor,
  at: Date,
): ExecEventDraft {
  const reason = "reason" in command ? command.reason : undefined;
  const failure_class = "failure_class" in command ? command.failure_class : undefined;
  const draft: ExecEventDraft = {
    type: "trial.phase",
    source: "trial",
    source_id: trial.id,
    severity: to === "failed_infra" || to === "failed_subject" ? "warn" : "info",
    actor,
    cost_delta_micro_usd: 0n,
    at: at.toISOString(),
    payload: {
      from,
      to,
      attempt: trial.attempt,
      ...(reason === undefined ? {} : { reason }),
      ...(failure_class === undefined ? {} : { failure_class }),
    },
  };
  AnybenchEventSchema.parse({ ...draft, run_id: null, seq: 0 });
  return draft;
}

/**
 * The store-side half of `transition`, pure: lease + attempt checks, transitionTrial from the
 * row's state, the patched row and its event. A `retry` bumps the attempt by itself.
 */
export function planTransition(
  row: ExecTrial,
  owner: string,
  req: TransitionRequest,
):
  | { ok: true; next: ExecTrial; from: TrialState; to: TrialState; event: ExecEventDraft | null }
  | Extract<TransitionOutcome, { ok: false }> {
  if (row.lease_owner !== owner) {
    return {
      ok: false,
      reason: "lease_lost",
      message: "lease is held by another owner",
      trial: row,
    };
  }
  if (row.attempt !== req.expectAttempt) {
    return {
      ok: false,
      reason: "stale_attempt",
      message: `trial is on attempt ${row.attempt}, not ${req.expectAttempt}`,
      trial: row,
    };
  }
  const r = transitionTrial(row.state, req.command);
  if (!r.ok) return { ok: false, reason: "illegal", message: r.error.message, trial: row };
  const patch: TrialPatch = { ...req.patch };
  if (req.command.type === "retry") patch.attempt = row.attempt + 1;
  if (patch.attempt !== undefined && patch.attempt > DB_MAX_TRIAL_ATTEMPTS) {
    return {
      ok: false,
      reason: "illegal",
      message: `attempt ${patch.attempt} is over the DB limit of ${DB_MAX_TRIAL_ATTEMPTS}`,
      trial: row,
    };
  }
  const next: ExecTrial = { ...row, ...patch, state: r.to };
  const event = req.emit
    ? trialPhaseEvent(next, r.from, r.to, req.command, req.actor, req.at)
    : null;
  return { ok: true, next, from: r.from, to: r.to, event };
}

/**
 * The trial state a runner status CLAIMS (untrusted: the subject can write status.json). The
 * executor never honours a claimed failed_infra or cancelled as such; see the header.
 */
export function trialTargetOfStatus(status: RunnerStatus): {
  to: TrialState;
  reason?: string;
  failure_class?: string;
} {
  if (isFinalRunnerPhase(status.phase)) {
    const outcome = status.result?.outcome ?? (status.phase === "done" ? "ok" : "failed_infra");
    const extra = {
      ...(status.result?.reason ? { reason: status.result.reason } : {}),
      ...(status.result?.failure_class ? { failure_class: status.result.failure_class } : {}),
    };
    if (status.phase === "done" && outcome === "ok") return { to: "collecting" };
    if (outcome === "failed_subject") return { to: "failed_subject", ...extra };
    if (outcome === "cancelled" || status.phase === "cancelled")
      return { to: "cancelled", ...extra };
    return {
      to: "failed_infra",
      reason: extra.reason ?? `runner ended ${status.phase}`,
      failure_class:
        status.result?.failure_class ?? (status.result ? "failed_infra" : "no_outcome"),
    };
  }
  return {
    to: TRIAL_STATE_BY_RUNNER_PHASE[status.phase as keyof typeof TRIAL_STATE_BY_RUNNER_PHASE],
  };
}

/** `KEY=value` lines the runner's env parser reads back exactly (always double-quoted). */
export function formatEnvFile(secrets: Record<string, string>): string {
  const lines: string[] = ["# written by the Anybench worker; secrets for this trial only"];
  for (const [key, value] of Object.entries(secrets)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid secret name ${key}`);
    const v = value
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"')
      .replaceAll("\n", "\\n")
      .replaceAll("\r", "\\r")
      .replaceAll("\t", "\\t");
    lines.push(`${key}="${v}"`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * KitSpec → the runner part of TrialPrepared for one contender (kit id) × workload. The verbs are
 * passed through as shell commands; the wall-clock cap is the workload's, else the driver's, else
 * one hour. Secrets, files and the computer spec come from the env build (3.8) / orchestrator.
 */
export function trialJobFromKit(
  kit: KitSpec,
  contenderId: string,
  workloadId: string,
  /** One `vary` setup's env (`expandVarySetups` in @anybench/kit), e.g. `{ TANDEM_WORKERS: "3" }`. */
  setup?: Readonly<Record<string, string>>,
): TrialPrepared["job"] {
  const contender = kit.contenders.find((c) => c.id === contenderId);
  if (!contender) throw new Error(`kit has no contender ${contenderId}`);
  const workload = kit.workloads.find((w) => w.id === workloadId);
  if (!workload) throw new Error(`kit has no workload ${workloadId}`);
  const d = contender.driver;
  return {
    contender_id: contender.id,
    workload_id: workload.id,
    driver: {
      type: d.type,
      run: d.verbs.run,
      ...(d.verbs.start ? { start: d.verbs.start } : {}),
      ...(d.verbs.ready ? { ready: d.verbs.ready } : {}),
      ...(d.verbs.stop ? { stop: d.verbs.stop } : {}),
    },
    wall_clock_s: workload.timeout_s ?? d.wall_clock_cap_s ?? 3600,
    collect: kit.collect,
    upload: {
      enabled: true,
      bundle_name: "out.tar.gz",
      max_bytes: kit.transfer.max_mb * 1024 * 1024,
      plans: {},
    },
    // What the kit says the adapters get (TDM-41): `versions`, `driver.model`, a harness's
    // human_in_loop and cap (anybench.yaml never reaches the subject computer), driver.env, and
    // the `vary` setup, in that precedence.
    env: contenderDriverEnv(kit, contender.id, workload.id, setup),
  };
}

// ---------- errors ----------

class InfraFailure extends Error {
  constructor(
    message: string,
    readonly failureClass: string,
  ) {
    super(message);
    this.name = "InfraFailure";
  }
}

class Stop extends Error {
  constructor(readonly kind: "aborted" | "lease_lost") {
    super(kind);
    this.name = "Stop";
  }
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, Math.max(0, ms));
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------- execution ----------

/** Run one attempt of a trial (see the header). Never throws for trial failures. */
export async function executeTrial(
  deps: ExecutorDeps,
  trialId: string,
  opts: ExecuteOptions = {},
): Promise<ExecuteOutcome> {
  return new TrialExecution(deps, trialId, opts).run();
}

class TrialExecution {
  private readonly timing: ExecutorTiming;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly actor: EventActor;
  private readonly owner: string;
  private readonly stop = new AbortController();
  private stopKind: "aborted" | "lease_lost" | null = null;
  private trial: ExecTrial | null = null;
  private prepared: TrialPrepared | null = null;
  private computer: { id: string; info: ComputerInfo } | null = null;
  private seenRunnerEdges: RunnerEdge[] = [];
  /** This execution wrote ~/.anybench/cancel: a runner-reported `cancelled` is ours. */
  private cancelWritten = false;
  /** TDM-39: revokes the trial's Naïve proxy key at a cap hit and at the end of the attempt. */
  private proxyGuard: ProxyKeyGuard | null = null;

  constructor(
    private readonly deps: ExecutorDeps,
    private readonly trialId: string,
    private readonly opts: ExecuteOptions,
  ) {
    this.timing = { ...DEFAULT_EXECUTOR_TIMING, ...deps.timing };
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
    this.actor = deps.actor ?? { kind: "system" };
    this.owner = `${deps.owner}${LEASE_OWNER_SEPARATOR}${randomBytes(6).toString("hex")}`;
  }

  async run(): Promise<ExecuteOutcome> {
    const { store } = this.deps;
    if (this.opts.signal?.aborted) return { kind: "aborted", trial: null };
    const leased = await store.acquireLease(this.trialId, this.owner, this.timing.leaseMs);
    if (!leased) return { kind: "busy", trial: await store.get(this.trialId) };
    this.trial = leased;

    const onAbort = () => this.halt("aborted");
    this.opts.signal?.addEventListener("abort", onAbort, { once: true });
    const refresher = this.startRefresher();
    let outcome: ExecuteOutcome;
    try {
      outcome = await this.drive();
    } catch (err) {
      if (err instanceof Stop) {
        outcome = { kind: err.kind, trial: this.trial };
      } else {
        await this.endProxyKey("executor error");
        // Unexpected (store down, a bug): release so the job's retry or the next sweep can take the
        // trial at once, instead of leaving it unwatched (no cancel, kill switch or deadline).
        clearInterval(refresher);
        await store.releaseLease(this.trialId, this.owner).catch((e: unknown) => {
          this.deps.logger?.warn({ err: e, trialId: this.trialId }, "lease release failed");
        });
        throw err;
      }
    } finally {
      clearInterval(refresher);
      this.opts.signal?.removeEventListener("abort", onAbort);
    }
    if (outcome.kind !== "aborted" && outcome.kind !== "lease_lost") {
      await this.endProxyKey(`attempt ${outcome.kind}`);
      try {
        await this.opts.beforeRelease?.(outcome);
      } finally {
        await store.releaseLease(this.trialId, this.owner);
      }
    }
    return outcome;
  }

  // ----- lease -----

  private startRefresher(): ReturnType<typeof setInterval> {
    let lastOk = this.now();
    let busy = false;
    const t = setInterval(() => {
      if (busy || this.stopKind) return;
      busy = true;
      void this.deps.store
        .refreshLease(this.trialId, this.owner, this.timing.leaseMs)
        .then(
          (ok) => {
            if (ok) lastOk = this.now();
            else this.halt("lease_lost");
          },
          (err: unknown) => {
            this.deps.logger?.warn({ err, trialId: this.trialId }, "lease refresh failed");
            if (this.now() - lastOk >= this.timing.leaseMs) this.halt("lease_lost");
          },
        )
        .finally(() => (busy = false));
    }, this.timing.leaseRefreshMs);
    t.unref?.();
    return t;
  }

  private halt(kind: "aborted" | "lease_lost"): void {
    this.stopKind ??= kind;
    this.stop.abort();
  }

  private checkStop(): void {
    if (this.stopKind) throw new Stop(this.stopKind);
  }

  private get t(): ExecTrial {
    return this.trial!;
  }

  /** The current state, read fresh (no control-flow narrowing across awaits). */
  private state(): TrialState {
    return this.trial!.state;
  }

  // ----- the state loop -----

  private async drive(): Promise<ExecuteOutcome> {
    for (;;) {
      this.checkStop();
      const t = this.t;
      if (isTerminalTrialState(t.state)) {
        return this.final(t.state, t.cost_micro_usd);
      }
      const cancel = await this.deps.store.cancelState(t);
      if (cancel.cancelled) return this.cancel(cancel.reason ?? "run cancelled");

      try {
        switch (t.state) {
          case "failed_infra": {
            const r = await this.afterInfraFailure();
            if (r) return r;
            break; // retried: now queued on the next attempt
          }
          case "queued":
            await this.move(
              { type: "advance" },
              { started_at: t.started_at ?? new Date(this.now()) },
            );
            break;
          case "forking":
            await this.ensureComputer();
            this.checkStop();
            await this.move({ type: "advance" });
            break;
          case "collecting":
            // A repeat run after we already collected (the gate enqueue failed and the job was
            // retried, or a duplicate job): the computer is gone, so do not watch it again.
            if (t.logs_url !== null || t.machine !== null || t.exit_code !== null) {
              return {
                kind: "collected",
                trial: t,
                cost_micro_usd: t.cost_micro_usd,
                kept_computer_id: null,
              };
            }
            return await this.runAndWatch();
          case "gating":
          case "reviewing":
            // Past the executor: the gate (trial.gate) owns these.
            return {
              kind: "collected",
              trial: t,
              cost_micro_usd: t.cost_micro_usd,
              kept_computer_id: null,
            };
          default:
            return await this.runAndWatch();
        }
      } catch (err) {
        if (err instanceof Stop) throw err;
        const failure =
          err instanceof InfraFailure
            ? err
            : new InfraFailure(
                errMessage(err),
                isProviderError(err) ? `provider_${err.code}` : "executor_error",
              );
        this.deps.logger?.warn(
          { trialId: this.trialId, attempt: this.t.attempt, err: failure.message },
          "trial infra failure",
        );
        return this.infraFailure(failure);
      }
    }
  }

  /** One command from the store's current state. Lease loss stops the execution. */
  private async move(
    command: TrialCommand,
    patch?: TrialPatch,
    emit = true,
  ): Promise<{ from: TrialState; to: TrialState } | null> {
    const out = await this.deps.store.transition(this.trialId, this.owner, {
      command,
      expectAttempt: this.t.attempt,
      ...(patch ? { patch } : {}),
      emit,
      actor: this.actor,
      at: new Date(this.now()),
    });
    if (out.ok) {
      this.trial = out.trial;
      return { from: out.from, to: out.to };
    }
    if (
      out.reason === "lease_lost" ||
      out.reason === "stale_attempt" ||
      out.reason === "not_found"
    ) {
      this.halt("lease_lost");
      throw new Stop("lease_lost");
    }
    if (out.trial) this.trial = out.trial;
    return null;
  }

  private async patch(patch: TrialPatch): Promise<void> {
    if (!(await this.deps.store.patch(this.trialId, this.owner, patch))) {
      this.halt("lease_lost");
      throw new Stop("lease_lost");
    }
    this.trial = { ...this.t, ...patch };
  }

  private async prepare(): Promise<TrialPrepared> {
    if (!this.prepared) {
      try {
        this.prepared = await this.deps.source.prepare(this.t);
        const key = this.prepared.proxy_key;
        if (key) {
          this.proxyGuard = createProxyKeyGuard({
            revoke: key.revoke,
            sleep: (ms) => this.sleep(ms),
            onRevoked: (r) => {
              const log = { trialId: this.trialId, ...r };
              if (r.ok) this.deps.logger?.info(log, "proxy key revoked");
              else this.deps.logger?.error(log, "proxy key revoke FAILED (the reaper will retry)");
            },
          });
          if (key.secret !== undefined) {
            this.prepared = {
              ...this.prepared,
              secrets: { ...this.prepared.secrets, [PROXY_SECRET_ENV_NAME]: key.secret },
            };
          }
        }
      } catch (err) {
        throw new InfraFailure(`could not prepare the trial: ${errMessage(err)}`, "prepare");
      }
    }
    return this.prepared;
  }

  // ----- computer -----

  /** Find (re-attach / reuse) or create the trial's computer, and wait until it runs. */
  private async ensureComputer(): Promise<{ id: string; info: ComputerInfo }> {
    if (this.computer) return this.computer;
    const { registry } = this.deps;
    const t = this.t;

    // Packed block: the computer a previous trial of the block left running.
    if (!t.computer_id && this.opts.reuseComputerId) {
      await this.patch({
        computer_id: this.opts.reuseComputerId,
        provider: registry.provider.name,
      });
    }

    if (t.computer_id || this.t.computer_id) {
      const computerId = this.t.computer_id!;
      try {
        const info = await registry.waitReady(computerId, {
          timeoutMs: this.timing.readyTimeoutMs,
        });
        this.computer = { id: computerId, info };
        return this.computer;
      } catch (err) {
        if (this.t.state !== "forking") {
          throw new InfraFailure(
            `computer ${computerId} is gone: ${errMessage(err)}`,
            "computer_lost",
          );
        }
        // Still forking: the create never finished (crash mid-create, or provisioning failed).
        // Close that row and its provider computer, then create a fresh one below.
        await this.destroyStale(computerId);
        await this.patch({ computer_id: null });
      }
    }

    // A computer tagged for this trial that the registry tracks but the trial row lost.
    const tag = trialTag(t.run_id, t.id);
    for (const info of await registry.provider.list({ tag })) {
      const row = await registry.findByProviderId(info.id);
      if (row && row.trialId === t.id && (row.status === "creating" || row.status === "running")) {
        await this.patch({ computer_id: row.id, provider: registry.provider.name });
        const ready = await registry.waitReady(row.id, { timeoutMs: this.timing.readyTimeoutMs });
        this.computer = { id: row.id, info: ready };
        return this.computer;
      }
    }

    const prepared = await this.prepare();
    this.checkStop();
    const created = await registry.create({
      runId: t.run_id,
      trialId: t.id,
      spec: prepared.computer,
    });
    // The registry's store already linked computer_id at insert time when it can (server); make
    // sure either way, before anything is installed.
    await this.patch({ computer_id: created.computerId, provider: registry.provider.name });
    await this.emit({
      type: "computer.created",
      source: "computer",
      source_id: created.computerId,
      severity: "info",
      actor: this.actor,
      cost_delta_micro_usd: 0n,
      at: new Date(this.now()).toISOString(),
      payload: {
        provider: registry.provider.name,
        provider_id: created.info.id,
        trial_id: t.id,
        ...(created.info.snapshotId ? { snapshot_id: created.info.snapshotId } : {}),
      },
    });
    const info = await registry.waitReady(created.computerId, {
      timeoutMs: this.timing.readyTimeoutMs,
    });
    this.computer = { id: created.computerId, info };
    return this.computer;
  }

  /** A half-created computer: destroy whatever the provider has for it and close the row. */
  private async destroyStale(computerId: string): Promise<void> {
    const { registry } = this.deps;
    try {
      const tag = trialTag(this.t.run_id, this.t.id);
      for (const info of await registry.provider.list({ tag })) {
        const row = await registry.findByProviderId(info.id);
        if (!row || row.id === computerId) await registry.provider.destroy(info.id);
      }
      await registry.destroy(computerId);
    } catch (err) {
      this.deps.logger?.warn({ err, computerId }, "could not clean up a half-created computer");
      await registry.markLeaked(computerId).catch(() => undefined);
    }
  }

  /**
   * Destroy the trial's computer (idempotent); a failure is left to the reaper. `unlink` clears
   * trials.computer_id afterwards (failed_infra: the next attempt gets a new computer).
   */
  private async destroyComputer(reason: string, unlink = false): Promise<void> {
    const computerId = this.t.computer_id ?? this.computer?.id;
    if (!computerId) return;
    const { registry } = this.deps;
    try {
      const out = await registry.destroy(computerId);
      await this.emit({
        type: "computer.destroyed",
        source: "computer",
        source_id: computerId,
        severity: "info",
        actor: this.actor,
        cost_delta_micro_usd: 0n,
        at: new Date(this.now()).toISOString(),
        payload: {
          provider: registry.provider.name,
          reason,
          trial_id: this.t.id,
          blocks_billed: out.blocksBilled,
        },
      });
      if (unlink && this.t.computer_id === computerId) await this.patch({ computer_id: null });
    } catch (err) {
      if (err instanceof Stop) throw err;
      this.deps.logger?.error({ err, computerId }, "destroy failed; the reaper retries it");
      await registry.markLeaked(computerId).catch(() => undefined);
    }
    this.computer = null;
  }

  private async emit(event: ExecEventDraft): Promise<void> {
    try {
      await this.deps.store.emit(this.t, [event]);
    } catch (err) {
      this.deps.logger?.warn({ err, type: event.type }, "could not append event");
    }
  }

  /**
   * This trial's share of the computer's cost: blocks consumed since it started on the computer
   * (the first trial of a fresh computer also pays the block paid at create). Billable states only.
   */
  private async costShare(): Promise<MicroUsd> {
    const info = this.computer?.info;
    if (!info) return 0n;
    const record = await this.deps.registry.findByProviderId(info.id);
    if (!record) return 0n;
    const end = this.deps.registry.costOf(record, new Date(this.now())).costMicroUsd;
    const start = this.t.started_at;
    const base =
      start && start.getTime() > record.createdAt.getTime()
        ? this.deps.registry.costOf(record, start).costMicroUsd
        : 0n;
    return end > base ? end - base : 0n;
  }

  // ----- runner -----

  private paths(): RunnerPaths {
    return runnerPaths(this.computer!.info.home);
  }

  private async readStatus(): Promise<RunnerStatus | null> {
    const { provider } = this.deps.registry;
    const pid = this.computer!.info.id;
    let bytes: Uint8Array;
    try {
      bytes = await provider.getFile(pid, this.paths().statusJson);
    } catch (err) {
      if (!isProviderError(err, "not_found")) throw err;
      // Missing file, or the computer itself is gone: inspect tells them apart.
      try {
        const info = await provider.inspect(pid);
        if (info.status === "destroyed" || info.status === "failed") {
          throw new InfraFailure(`computer ${pid} is ${info.status}`, "computer_lost");
        }
      } catch (e) {
        if (e instanceof InfraFailure) throw e;
        if (isProviderError(e, "not_found")) {
          throw new InfraFailure(`computer ${pid} is gone`, "computer_lost");
        }
        throw e;
      }
      return null;
    }
    let json: unknown;
    try {
      json = JSON.parse(decodeText(bytes));
    } catch {
      return null; // mid-write on a provider without atomic rename; next poll
    }
    const parsed = RunnerStatusSchema.safeParse(json);
    if (!parsed.success) return null;
    const s = parsed.data;
    if (s.trial_id.toLowerCase() !== this.t.id.toLowerCase() || s.attempt !== this.t.attempt) {
      return null; // a previous trial of the block, or a previous attempt
    }
    return s;
  }

  /** trial.json on the computer is already this attempt's: we (or a dead worker) wrote it. */
  private async jobWrittenForAttempt(): Promise<boolean> {
    try {
      const bytes = await this.deps.registry.provider.getFile(
        this.computer!.info.id,
        this.paths().trialJson,
      );
      const job = TrialJobSchema.safeParse(JSON.parse(decodeText(bytes)));
      return (
        job.success &&
        job.data.trial_id.toLowerCase() === this.t.id.toLowerCase() &&
        job.data.attempt === this.t.attempt
      );
    } catch {
      return false;
    }
  }

  private buildJob(prepared: TrialPrepared): TrialJob {
    const t = this.t;
    const ingest = this.deps.ingest;
    const parsed = TrialJobSchema.safeParse({
      ...prepared.job,
      version: TRIAL_JOB_VERSION,
      trial_id: t.id,
      run_id: t.run_id,
      attempt: t.attempt,
      lease_owner: this.owner,
      ingest: ingest
        ? { ...ingest.options, url: ingest.url, token: ingest.token(t.id, t.attempt) }
        : null,
    });
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new InfraFailure(`invalid trial.json: ${issues}`, "prepare");
    }
    return parsed.data;
  }

  /** Clean ~/eval, write secrets, inputs and trial.json, start the runner detached. */
  private async prepareAndLaunch(job: TrialJob, prepared: TrialPrepared): Promise<void> {
    const { provider } = this.deps.registry;
    const pid = this.computer!.info.id;
    const p = this.paths();
    const clean = [p.inDir, p.wsDir, p.outDir, p.warmupDir, p.chunksDir, p.bundle, p.cancelFile]
      .map(shellQuote)
      .join(" ");
    const r = await provider.exec(
      pid,
      `rm -rf ${clean} && mkdir -p ${shellQuote(p.inDir)} ${shellQuote(p.configDir)}`,
      { timeoutMs: 60_000 },
    );
    if (r.exitCode !== 0) {
      throw new InfraFailure(`could not reset ~/eval (exit ${r.exitCode})`, "prepare");
    }
    this.checkStop();
    // Secrets and the token go through fs.write only (Naïve keeps exec history unredacted).
    await provider.putFile(pid, p.envFile, formatEnvFile(prepared.secrets), { mode: 0o600 });
    for (const f of prepared.files ?? []) {
      await provider.putFile(pid, f.path, f.content, f.mode === undefined ? {} : { mode: f.mode });
    }
    await provider.putFile(pid, p.trialJson, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
    this.checkStop();
    const bin = this.deps.runnerBin?.(p.home) ?? `${p.home}/.anybench/bin/runner`;
    await provider.execDetached(pid, `${shellQuote(bin)} --trial ${shellQuote(job.trial_id)}`, {
      logPath: p.runnerLog,
    });
  }

  private runnerEdgeSeen(from: TrialState, to: TrialState): boolean {
    return this.seenRunnerEdges.some((e) => e.from === from && e.to === to);
  }

  /**
   * Move the store's state toward a runner-reported target, one legal command at a time, from the
   * state the store has. Never backwards, never past `collecting` (the gate owns the rest).
   */
  private async applyTarget(target: {
    to: TrialState;
    reason?: string;
    failure_class?: string;
  }): Promise<void> {
    const forward = ["warming", "running", "collecting"] as const;
    const idx = (s: TrialState) => (TRIAL_PHASES as readonly TrialState[]).indexOf(s);
    if ((forward as readonly TrialState[]).includes(target.to)) {
      while (
        (this.t.state === "installing" ||
          this.t.state === "warming" ||
          this.t.state === "running") &&
        idx(this.t.state) < idx(target.to)
      ) {
        const from = this.t.state;
        const next = TRIAL_PHASES[idx(from) + 1]!;
        const moved = await this.move(
          { type: "advance" },
          undefined,
          !this.runnerEdgeSeen(from, next),
        );
        if (!moved) return;
      }
      return;
    }
    const reason = target.reason ?? `runner reported ${target.to}`;
    const from = this.t.state;
    if (from === target.to || isTerminalTrialState(from) || from === "failed_infra") return;
    if (target.to === "cancelled") {
      if (this.cancelWritten || (await this.deps.store.cancelState(this.t)).cancelled) {
        const emit = !this.runnerEdgeSeen(from, "cancelled");
        await this.move({ type: "cancel", reason }, undefined, emit);
        return;
      }
      // Nobody asked: the subject cancelled itself. Its result, billed, never retried.
      await this.failSubject(
        `runner reported cancelled, but no cancel was requested (${reason})`,
        "unrequested_cancel",
      );
      return;
    }
    if (target.to === "failed_subject") {
      const emit = !this.runnerEdgeSeen(from, "failed_subject");
      await this.failSubject(reason, target.failure_class ?? "subject", emit);
      return;
    }
    if (target.to === "failed_infra") {
      // Only the worker decides that a failure is infra (and so retried, unbilled).
      await this.failSubject(reason, `runner:${target.failure_class ?? "failed_infra"}`);
    }
  }

  /** failed_subject from the store's state (legal from installing … reviewing). */
  private async failSubject(reason: string, failureClass: string, emit = true): Promise<void> {
    await this.move(
      { type: "fail_subject", reason, failure_class: failureClass },
      { failure_class: failureClass },
      emit,
    );
  }

  private async applyRunnerEdges(): Promise<void> {
    const edges = await this.deps.store.runnerEdges(this.t);
    for (const e of edges.slice(this.seenRunnerEdges.length)) {
      this.seenRunnerEdges.push(e);
      await this.applyTarget(e);
      if (isTerminalTrialState(this.state())) return;
    }
  }

  /** installing … collecting: launch the runner if it never was, then follow it to its end. */
  private async runAndWatch(): Promise<ExecuteOutcome> {
    const computer = await this.ensureComputer();
    if (!this.t.computer_id) await this.patch({ computer_id: computer.id });
    const prepared = await this.prepare();
    const job = this.buildJob(prepared);
    let status = await this.readStatus();

    if (!status) {
      if (this.t.state !== "installing") {
        // Past installing with no runner status for this attempt: the machine lost it.
        throw new InfraFailure("runner status.json is missing for this attempt", "runner_lost");
      }
      const cancel = await this.deps.store.cancelState(this.t);
      if (cancel.cancelled) return this.cancel(cancel.reason ?? "run cancelled");
      // Only a fresh launch when nobody wrote this attempt's trial.json yet; otherwise a runner may
      // be starting right now, and a second launch (after wiping ~/eval) would run it twice.
      if (!(await this.jobWrittenForAttempt())) await this.prepareAndLaunch(job, prepared);
    }

    const staleMs = this.timing.staleMs ?? Math.max(30_000, 3 * job.heartbeat_s * 1000 + 15_000);
    // From the attempt's stored start, so a re-attach after a crash never restarts the clock.
    const startedAt = this.t.started_at?.getTime() ?? this.now();
    const deadlineAt = startedAt + (this.timing.deadlineMs ?? defaultTrialDeadlineMs)(job);
    const watchStart = this.now();
    let lastSig = "";
    let lastProgress = this.now();

    for (;;) {
      this.checkStop();
      const cancel = await this.deps.store.cancelState(this.t);
      if (cancel.cancelled) return this.cancel(cancel.reason ?? "run cancelled");
      if (this.now() > deadlineAt) {
        await this.writeCancelFile();
        throw new InfraFailure("trial ran over 2x its estimated duration", "deadline");
      }
      await this.deps.registry.touch(computer.id).catch(() => undefined);

      await this.applyRunnerEdges();
      if (isTerminalTrialState(this.state())) return this.finish(status);

      status = await this.readStatus();
      await this.watchProxyKey(status);
      if (status) {
        const sig = `${status.phase}|${status.heartbeat_at ?? ""}|${status.updated_at}`;
        if (sig !== lastSig) {
          lastSig = sig;
          lastProgress = this.now();
        }
        await this.applyTarget(trialTargetOfStatus(status));
        if (isFinalRunnerPhase(status.phase) || isTerminalTrialState(this.state())) {
          return this.finish(status);
        }
        if (this.now() - lastProgress > staleMs) {
          throw new InfraFailure(
            `runner heartbeat lost (no status change for ${Math.round((this.now() - lastProgress) / 1000)} s, phase ${status.phase})`,
            "heartbeat_lost",
          );
        }
      } else if (this.now() - watchStart > this.timing.startTimeoutMs) {
        throw new InfraFailure(
          "the runner did not start (no status.json for this attempt)",
          "runner_start",
        );
      }
      await this.sleep(this.timing.pollMs, this.stop.signal);
    }
  }

  /** TDM-39: enforce the proxy budget and revoke the key the moment any cap is hit. */
  private async watchProxyKey(status: RunnerStatus | null): Promise<void> {
    const guard = this.proxyGuard;
    const key = this.prepared?.proxy_key;
    if (!guard || !key || guard.revoked) return;
    try {
      await key.enforce?.();
      if (status) await guard.observeRunnerStatus(status);
      if (!guard.revoked && (await this.driverTokenCapHit())) {
        await guard.capHit("coding-agent driver: token cap exceeded");
      }
    } catch (err) {
      this.deps.logger?.warn({ err, trialId: this.trialId }, "proxy key budget check failed");
    }
  }

  private async driverTokenCapHit(): Promise<boolean> {
    const pid = this.computer?.info.id;
    if (!pid) return false;
    try {
      await this.deps.registry.provider.getFile(
        pid,
        `${this.paths().outDir}/${DRIVER_TOKEN_CAP_FILE}`,
      );
      return true;
    } catch (err) {
      if (isProviderError(err, "not_found")) return false;
      throw err;
    }
  }

  private async endProxyKey(detail: string): Promise<void> {
    await this.proxyGuard?.trialEnded(detail).catch((err: unknown) => {
      this.deps.logger?.error({ err, trialId: this.trialId }, "proxy key revoke failed");
    });
  }

  private async writeCancelFile(): Promise<void> {
    if (!this.computer) return;
    try {
      await this.deps.registry.provider.putFile(
        this.computer.info.id,
        this.paths().cancelFile,
        `cancel ${new Date(this.now()).toISOString()}\n`,
      );
      this.cancelWritten = true;
    } catch {
      // the computer may already be gone; destroy follows
    }
  }

  /** The runner ended (or the store is terminal): record its results, settle the computer. */
  private async finish(status: RunnerStatus | null): Promise<ExecuteOutcome> {
    const state = this.t.state;
    if (state === "failed_infra") {
      return this.infraFailure(
        new InfraFailure("runner reported an infra failure", this.t.failure_class ?? "runner"),
      );
    }
    if (state === "cancelled") {
      await this.destroyComputer("cancelled");
      await this.patch({ ended_at: new Date(this.now()) });
      return this.final("cancelled", 0n);
    }
    // collecting (runner done) or failed_subject: both keep their outputs.
    const patch: TrialPatch = { exit_code: status?.run?.exit_code ?? null };
    const machine = await this.readMachine();
    if (machine !== undefined) patch.machine = machine;
    const bundle = await this.bundleKey(status);
    if (bundle) patch.logs_url = bundle;
    patch.cost_micro_usd = await this.costShare();
    if (state === "failed_subject") patch.ended_at = new Date(this.now());
    await this.patch(patch);

    const keep = this.opts.keepComputer === true && this.computer !== null;
    const kept = keep ? this.computer!.id : null;
    if (!keep) await this.destroyComputer(state === "collecting" ? "trial collected" : state);
    if (state === "collecting") {
      return {
        kind: "collected",
        trial: this.t,
        cost_micro_usd: this.t.cost_micro_usd,
        kept_computer_id: kept,
      };
    }
    return {
      kind: "final",
      trial: this.t,
      state,
      cost_micro_usd: this.t.cost_micro_usd,
      kept_computer_id: kept,
    };
  }

  private async readMachine(): Promise<unknown> {
    try {
      const bytes = await this.deps.registry.provider.getFile(
        this.computer!.info.id,
        this.paths().machineJson,
      );
      return z.record(z.string(), z.unknown()).parse(JSON.parse(decodeText(bytes)));
    } catch {
      return undefined;
    }
  }

  /** `artifact:<key>` of the frozen bundle: the runner's upload, else the fs/read fallback. */
  private async bundleKey(status: RunnerStatus | null): Promise<string | null> {
    const name = this.prepared?.job.upload?.bundle_name ?? "out.tar.gz";
    const uploaded = status?.upload?.artifacts.find((a) => a.name === name);
    if (uploaded) return `artifact:${uploaded.key}`;
    if (!this.deps.fallbackUpload || !this.computer) return null;
    try {
      const bytes = await this.deps.registry.provider.getFile(
        this.computer.info.id,
        this.paths().bundle,
      );
      const out = await this.deps.fallbackUpload(this.t, bytes);
      return out ? `artifact:${out.key}` : null;
    } catch (err) {
      this.deps.logger?.warn({ err, trialId: this.t.id }, "bundle fallback upload failed");
      return null;
    }
  }

  // ----- failures, retries, cancel -----

  private async infraFailure(failure: InfraFailure): Promise<ExecuteOutcome> {
    if (this.t.state !== "failed_infra" && !isTerminalTrialState(this.t.state)) {
      await this.move(
        { type: "fail_infra", reason: failure.message, failure_class: failure.failureClass },
        { failure_class: failure.failureClass, cost_micro_usd: 0n },
      );
    }
    if (isTerminalTrialState(this.t.state)) return this.final(this.t.state, this.t.cost_micro_usd);
    await this.writeCancelFile();
    await this.destroyComputer(`failed_infra: ${failure.failureClass}`, true);
    if (this.t.attempt >= TRIAL_MAX_ATTEMPTS) {
      await this.patch({ ended_at: new Date(this.now()) });
      return this.final("failed_infra", 0n);
    }
    return {
      kind: "retry",
      trial: this.t,
      retry_at: this.now() + trialRetryDelayMs(this.t.attempt),
      delay_ms: trialRetryDelayMs(this.t.attempt),
      next_attempt: this.t.attempt + 1,
    };
  }

  /** At start in failed_infra: retry now, report the retry, or finish when out of tries. */
  private async afterInfraFailure(): Promise<ExecuteOutcome | null> {
    if (this.t.attempt >= TRIAL_MAX_ATTEMPTS) {
      await this.destroyComputer("failed_infra: no tries left", true);
      if (!this.t.ended_at) await this.patch({ ended_at: new Date(this.now()) });
      return this.final("failed_infra", 0n);
    }
    if (!this.opts.retryNow) {
      await this.destroyComputer("failed_infra", true);
      return {
        kind: "retry",
        trial: this.t,
        retry_at: this.now() + trialRetryDelayMs(this.t.attempt),
        delay_ms: trialRetryDelayMs(this.t.attempt),
        next_attempt: this.t.attempt + 1,
      };
    }
    await this.destroyComputer("failed_infra: retrying", true);
    this.prepared = null;
    this.seenRunnerEdges = [];
    // New attempt → new runner token; the old attempt's computer and outputs are gone.
    await this.move(
      { type: "retry", attempt: this.t.attempt },
      {
        computer_id: null,
        started_at: null,
        failure_class: null,
        exit_code: null,
        ended_at: null,
        log_offset: 0,
        cost_micro_usd: 0n,
        logs_url: null,
      },
    );
    return null;
  }

  private async cancel(reason: string): Promise<ExecuteOutcome> {
    if (this.t.computer_id && !this.computer) {
      // Find the provider id to write the cancel file (re-attach after a crash).
      try {
        const info = await this.deps.registry.waitReady(this.t.computer_id, { timeoutMs: 5_000 });
        this.computer = { id: this.t.computer_id, info };
      } catch {
        // gone already
      }
    }
    if (this.computer) {
      await this.writeCancelFile();
      const until = this.now() + this.timing.cancelGraceMs;
      while (this.now() < until) {
        const s = await this.readStatus().catch(() => null);
        if (!s || isFinalRunnerPhase(s.phase)) break;
        await this.sleep(Math.min(this.timing.pollMs, 1_000), this.stop.signal);
        this.checkStop();
      }
    }
    await this.destroyComputer("cancelled");
    if (!isTerminalTrialState(this.t.state)) {
      await this.move(
        { type: "cancel", reason },
        { ended_at: new Date(this.now()), cost_micro_usd: 0n },
      );
    }
    return this.final(this.t.state, 0n);
  }

  private final(state: TrialState, cost: MicroUsd): ExecuteOutcome {
    return { kind: "final", trial: this.t, state, cost_micro_usd: cost, kept_computer_id: null };
  }
}

// ---------- re-attach (the reaper half of the lease logic) ----------

export interface OrphanedTrial {
  id: string;
  attempt: number;
  state: TrialState;
}

export interface ReattachDeps {
  /** Trials in EXECUTING_TRIAL_STATES whose lease is held but takeable (expired / owner dead). */
  listOrphaned(): Promise<OrphanedTrial[]>;
  /** Hand one to a new execution (graphile: addJob trial.execute with its job key). */
  enqueue(trial: OrphanedTrial): Promise<void>;
  logger?: ExecLogger;
}

/** One sweep: every orphaned trial is enqueued again. Returns what it enqueued. */
export async function reattachOrphans(deps: ReattachDeps): Promise<OrphanedTrial[]> {
  const orphans = await deps.listOrphaned();
  const done: OrphanedTrial[] = [];
  for (const o of orphans) {
    try {
      await deps.enqueue(o);
      done.push(o);
    } catch (err) {
      deps.logger?.warn({ err, trialId: o.id }, "could not re-enqueue an orphaned trial");
    }
  }
  return done;
}

// ---------- in-process launcher for the Scheduler ----------

export interface TrialLauncherOptions {
  /**
   * The trial is collected: wait for its gate (5.6) to settle it and return the final state.
   * Default: resolve `done` (the gate is not run in-process).
   */
  awaitGate?: (
    trial: ExecTrial,
  ) => Promise<"done" | "failed_subject" | "failed_infra" | "cancelled">;
}

/**
 * Scheduler ports over executeTrial: `launch` runs a trial to a final state, retrying infra
 * failures after trialRetryDelayMs as new attempts, and keeps a packed block's computer for the
 * block's next trial; `onBlockEnd` destroys the block's computer.
 */
export function createTrialLauncher(deps: ExecutorDeps, options: TrialLauncherOptions = {}) {
  const blocks = new Map<string, string>();
  const sleep = deps.sleep ?? defaultSleep;
  return {
    blocks,
    async launch(
      plan: { trial_id: string },
      ctx: { computer_key: string; position_in_block: number; block_size: number },
    ): Promise<{ state: TrialState; cost_micro_usd: MicroUsd }> {
      const keep = ctx.position_in_block < ctx.block_size - 1;
      let retryNow = false;
      for (;;) {
        const reuse = blocks.get(ctx.computer_key);
        const out = await executeTrial(deps, plan.trial_id, {
          retryNow,
          keepComputer: keep,
          ...(reuse ? { reuseComputerId: reuse } : {}),
        });
        switch (out.kind) {
          case "collected": {
            if (out.kept_computer_id) blocks.set(ctx.computer_key, out.kept_computer_id);
            else blocks.delete(ctx.computer_key);
            const state = (await options.awaitGate?.(out.trial)) ?? "done";
            return {
              state,
              cost_micro_usd:
                state === "done" || state === "failed_subject" ? out.cost_micro_usd : 0n,
            };
          }
          case "final":
            if (out.kept_computer_id) blocks.set(ctx.computer_key, out.kept_computer_id);
            else blocks.delete(ctx.computer_key);
            return { state: out.state, cost_micro_usd: out.cost_micro_usd };
          case "retry":
            blocks.delete(ctx.computer_key);
            await sleep(out.delay_ms);
            retryNow = true;
            break;
          default:
            throw new Error(`trial ${plan.trial_id}: ${out.kind}`);
        }
      }
    },
    async onBlockEnd(computer_key: string): Promise<void> {
      const id = blocks.get(computer_key);
      blocks.delete(computer_key);
      if (id) await deps.registry.destroy(id);
    },
  };
}

// ---------- in-memory store (tests, local tools) ----------

export interface MemoryTrialSeed {
  id: string;
  run_id: string;
  owner_id?: string;
  state?: TrialState;
  attempt?: number;
}

/** An in-memory TrialExecStore with the same semantics as the Drizzle one. */
export class MemoryTrialExecStore implements TrialExecStore {
  readonly trials = new Map<string, ExecTrial>();
  readonly events: (ExecEventDraft & { run_id: string; seq: number })[] = [];
  /** Runner edges by trial id + attempt (what ingest would have written). */
  readonly pushedEdges = new Map<string, RunnerEdge[]>();
  readonly cancelledRuns = new Map<string, string>();
  /** Lease holders treated as dead (their worker's heartbeat is stale). */
  readonly deadOwners = new Set<string>();
  private seq = 1;

  constructor(private readonly now: () => number = Date.now) {}

  seed(s: MemoryTrialSeed): ExecTrial {
    const row: ExecTrial = {
      id: s.id,
      run_id: s.run_id,
      owner_id: s.owner_id ?? "owner",
      state: s.state ?? "queued",
      attempt: s.attempt ?? 1,
      computer_id: null,
      provider: null,
      lease_owner: null,
      lease_until: null,
      started_at: null,
      ended_at: null,
      failure_class: null,
      exit_code: null,
      logs_url: null,
      machine: null,
      cost_micro_usd: 0n,
      log_offset: 0,
    };
    this.trials.set(row.id, row);
    return row;
  }

  /** Simulate ingest writing a runner trial.phase edge. */
  pushRunnerEdge(trialId: string, attempt: number, edge: RunnerEdge): void {
    const key = `${trialId}#${attempt}`;
    this.pushedEdges.set(key, [...(this.pushedEdges.get(key) ?? []), edge]);
  }

  private isDead(holder: string): boolean {
    for (const d of this.deadOwners)
      if (holder === d || holder.startsWith(`${d}${LEASE_OWNER_SEPARATOR}`)) return true;
    return false;
  }

  async get(id: string): Promise<ExecTrial | null> {
    const t = this.trials.get(id);
    return t ? { ...t } : null;
  }

  async acquireLease(id: string, owner: string, leaseMs: number): Promise<ExecTrial | null> {
    const t = this.trials.get(id);
    if (!t) return null;
    if (!leaseTakeable(t, owner, this.now(), (h) => !this.isDead(h))) return null;
    const next = { ...t, lease_owner: owner, lease_until: new Date(this.now() + leaseMs) };
    this.trials.set(id, next);
    return { ...next };
  }

  async refreshLease(id: string, owner: string, leaseMs: number): Promise<boolean> {
    const t = this.trials.get(id);
    if (!t || t.lease_owner !== owner) return false;
    const until = Math.max(t.lease_until?.getTime() ?? 0, this.now() + leaseMs);
    this.trials.set(id, { ...t, lease_until: new Date(until) });
    return true;
  }

  async releaseLease(id: string, owner: string): Promise<void> {
    const t = this.trials.get(id);
    if (t && t.lease_owner === owner)
      this.trials.set(id, { ...t, lease_owner: null, lease_until: null });
  }

  async transition(id: string, owner: string, req: TransitionRequest): Promise<TransitionOutcome> {
    const t = this.trials.get(id);
    if (!t) return { ok: false, reason: "not_found", message: `no trial ${id}`, trial: null };
    const plan = planTransition(t, owner, req);
    if (!plan.ok) return plan;
    this.trials.set(id, plan.next);
    if (plan.event) this.events.push({ ...plan.event, run_id: t.run_id, seq: this.seq++ });
    return { ok: true, trial: { ...plan.next }, from: plan.from, to: plan.to };
  }

  async patch(id: string, owner: string, patch: TrialPatch): Promise<boolean> {
    const t = this.trials.get(id);
    if (!t || t.lease_owner !== owner) return false;
    this.trials.set(id, { ...t, ...patch });
    return true;
  }

  async runnerEdges(trial: ExecTrial): Promise<RunnerEdge[]> {
    return [...(this.pushedEdges.get(`${trial.id}#${trial.attempt}`) ?? [])];
  }

  async cancelState(trial: ExecTrial): Promise<CancelState> {
    const reason = this.cancelledRuns.get(trial.run_id);
    return reason === undefined ? { cancelled: false } : { cancelled: true, reason };
  }

  async emit(trial: ExecTrial, events: ExecEventDraft[]): Promise<void> {
    for (const e of events) this.events.push({ ...e, run_id: trial.run_id, seq: this.seq++ });
  }

  /** Trials a reaper sweep would hand back (lease held but takeable). */
  listOrphaned(): OrphanedTrial[] {
    const now = this.now();
    return [...this.trials.values()]
      .filter(
        (t) =>
          (EXECUTING_TRIAL_STATES as readonly TrialState[]).includes(t.state) &&
          t.lease_owner !== null &&
          leaseTakeable(t, "", now, (h) => !this.isDead(h)),
      )
      .map((t) => ({ id: t.id, attempt: t.attempt, state: t.state }));
  }
}
