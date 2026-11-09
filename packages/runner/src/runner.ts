// The trial lifecycle on the eval computer:
//
//   prepare → healthcheck → warmup → run → collect → freeze → upload → done
//
// Launched detached by the worker (`setsid nohup runner --trial <id> >> ~/eval/runner.log 2>&1 &`)
// because Naïve `exec` is capped at 10 minutes and kills attached children. It talks to nothing
// but the files under HOME and, when configured, the ingest API.
//
// trials.state reporting (trial.phase events): the worker has the trial in `installing` when it
// launches the runner. The runner reports installing → warming (warmup), warming → running (run),
// running → collecting (collect), and on failure the final edge to failed_subject / failed_infra /
// cancelled. After a subject failure the runner still collects, freezes and uploads what exists,
// so the investigator has evidence, and reports the failure last.

import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createRedactor, formatUsd, type Redactor, type TrialState } from "@anybench/core";
import { sha256File } from "@anybench/envs";
import { loadEnvFile } from "./envfile.js";
import { EventSink, type FetchLike } from "./events.js";
import { defaultShell, RedactingLineWriter, runVerb, type VerbResult } from "./exec.js";
import { listFiles, matchFiles } from "./glob.js";
import { loadTrialJob, TrialJobError, type TrialJob } from "./job.js";
import { LogChunker, type LogStream } from "./logs.js";
import { probeMachine } from "./machine.js";
import { probeNetwork, type ProbeFetch } from "./netprobe.js";
import { runnerPaths, type RunnerPaths } from "./paths.js";
import {
  isFinalRunnerPhase,
  RunnerStatusSchema,
  TRIAL_STATE_BY_RUNNER_PHASE,
  writeJsonAtomic,
  type RunnerOutcome,
  type RunnerPhase,
  type RunnerStatus,
} from "./status.js";
import { writeTarGz } from "./tar.js";
import { TokenMeter, type TokenMeterSnapshot } from "./token-cap.js";
import { uploadArtifact, type UploadedArtifact } from "./upload.js";
import { RUNNER_VERSION } from "./version.js";

export const RUNNER_EXIT = {
  ok: 0,
  usage: 2,
  /** A runner for this attempt already started and died; the worker must retry with a new attempt. */
  stale_attempt: 3,
  failed_subject: 10,
  failed_infra: 11,
  cancelled: 12,
} as const;

export interface RunTrialOptions {
  /** `--trial`: must match trial.json's trial_id. */
  trialId: string;
  /** Defaults to os.homedir(). */
  home?: string;
  fetch?: FetchLike;
  /** Where the runner's own log lines go (already redacted). Default: stderr. */
  log?: (line: string) => void;
  /** /proc/stat sampling window for steal (tests shorten it). */
  stealWindowMs?: number;
  /** Handle SIGTERM / SIGINT as cancellation (the CLI does). */
  handleSignals?: boolean;
  /** How long to keep trying to push the last events before exiting. */
  finalFlushMs?: number;
  /** fetch for the network probe (default: global fetch). Tests stub it. */
  probeFetch?: ProbeFetch;
  /** How long freeze waits for queued live log segments to upload. */
  logChunkDeadlineMs?: number;
  /** Backoff between live log segment upload tries. */
  logChunkRetryMs?: number;
}

export interface RunTrialResult {
  exitCode: number;
  status: RunnerStatus | null;
  message?: string;
}

interface Failure {
  outcome: Exclude<RunnerOutcome, "ok">;
  reason: string;
  failureClass: string;
}

class CancelledError extends Error {
  constructor() {
    super("cancelled");
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readExistingStatus(path: string): Promise<RunnerStatus | null> {
  try {
    const parsed = RunnerStatusSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function defaultLog(line: string): void {
  process.stderr.write(`${new Date().toISOString()} ${line}\n`);
}

export async function runTrial(opts: RunTrialOptions): Promise<RunTrialResult> {
  const paths = runnerPaths(opts.home);
  const rawLog = opts.log ?? defaultLog;
  // Until the secrets are loaded, redact known key shapes only.
  let redact: Redactor = createRedactor();
  const log = (line: string) => rawLog(redact(line));

  let job: TrialJob;
  try {
    job = await loadTrialJob(paths.trialJson);
  } catch (err) {
    const message = err instanceof TrialJobError ? err.message : String(err);
    log(`runner: ${message}`);
    return { exitCode: RUNNER_EXIT.usage, status: null, message };
  }
  if (job.trial_id !== opts.trialId) {
    const message = `--trial ${opts.trialId} does not match trial.json trial_id ${job.trial_id}`;
    log(`runner: ${message}`);
    return { exitCode: RUNNER_EXIT.usage, status: null, message };
  }
  redact = createRedactor({ ANYBENCH_INGEST_TOKEN: job.ingest?.token });

  // Idempotent launch: a second `runner --trial` for the same attempt never runs it twice.
  const existing = await readExistingStatus(paths.statusJson);
  if (existing && existing.trial_id === job.trial_id && existing.attempt === job.attempt) {
    if (isFinalRunnerPhase(existing.phase)) {
      const message = `attempt ${job.attempt} already finished (${existing.phase})`;
      log(`runner: ${message}`);
      return { exitCode: RUNNER_EXIT.ok, status: existing, message };
    }
    if (existing.pid !== process.pid && pidAlive(existing.pid)) {
      const message = `attempt ${job.attempt} is already running as pid ${existing.pid}`;
      log(`runner: ${message}`);
      return { exitCode: RUNNER_EXIT.ok, status: existing, message };
    }
    const message = `a runner for attempt ${job.attempt} died in phase ${existing.phase}; retry with a new attempt`;
    log(`runner: ${message}`);
    return { exitCode: RUNNER_EXIT.stale_attempt, status: existing, message };
  }

  return new TrialRun(
    job,
    paths,
    opts,
    log,
    () => redact,
    (r) => (redact = r),
  ).execute();
}

class TrialRun {
  private status!: RunnerStatus;
  private sink!: EventSink;
  private stdout!: RedactingLineWriter;
  private stderr!: RedactingLineWriter;
  private secrets: Record<string, string> = {};
  private trialState: TrialState = "installing";
  private failure: Failure | null = null;
  private statusWrite: Promise<void> = Promise.resolve();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private cancelRequested = false;
  private resolveCancel!: () => void;
  private readonly cancelled = new Promise<void>((r) => (this.resolveCancel = r));
  private readonly leaseOwner: string;
  private readonly shell: string;
  private readonly cwd: string;
  private started = false;
  private readonly chunkers = new Map<LogStream, LogChunker>();
  private meter: TokenMeter | null = null;
  private budgetHit: TokenMeterSnapshot | null = null;
  /** TDM-242: why the worker asked us to stop for the run's budget (~/.anybench/budget-stop). */
  private runBudgetStop: string | null = null;
  private resolveBudget!: () => void;
  private readonly budgetStop = new Promise<void>((r) => (this.resolveBudget = r));

  constructor(
    private readonly job: TrialJob,
    private readonly paths: RunnerPaths,
    private readonly opts: RunTrialOptions,
    private readonly log: (line: string) => void,
    private readonly getRedact: () => Redactor,
    private readonly setRedact: (r: Redactor) => void,
  ) {
    this.leaseOwner = job.lease_owner ?? `runner:${hostname()}`;
    this.shell = job.driver.shell ?? defaultShell();
    const cwd = job.driver.cwd;
    this.cwd = cwd ? (isAbsolute(cwd) ? cwd : resolve(paths.home, cwd)) : paths.wsDir;
  }

  async execute(): Promise<RunTrialResult> {
    const p = this.paths;
    // A fresh attempt starts from an empty out dir; in/ and ws/ belong to the worker.
    await rm(p.outDir, { recursive: true, force: true });
    await rm(p.warmupDir, { recursive: true, force: true });
    await rm(p.bundle, { force: true });
    await rm(p.chunksDir, { recursive: true, force: true });
    for (const d of [p.configDir, p.inDir, p.wsDir, p.outDir, p.artifactsDir, p.warmupDir]) {
      await mkdir(d, { recursive: true });
    }

    const now = new Date().toISOString();
    this.status = {
      trial_id: this.job.trial_id,
      run_id: this.job.run_id,
      attempt: this.job.attempt,
      runner_version: RUNNER_VERSION,
      pid: process.pid,
      hostname: hostname(),
      phase: "prepare",
      trial_state: this.trialState,
      started_at: now,
      updated_at: now,
      heartbeat_at: null,
      phases: [],
      push: {
        mode: this.job.ingest ? "push" : "file_only",
        sent_batches: 0,
        failed_posts: 0,
        last_error: null,
      },
      events: { count: 0, bytes: 0 },
      run: null,
      upload: null,
      result: null,
    };
    this.sink = new EventSink({
      eventsPath: p.eventsJsonl,
      trialId: this.job.trial_id,
      runId: this.job.run_id,
      attempt: this.job.attempt,
      actorId: this.leaseOwner,
      ingest: this.job.ingest,
      redact: (t) => this.getRedact()(t),
      status: () => this.snapshot(),
      log: this.log,
      ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
    });
    this.stdout = new RedactingLineWriter(p.stdoutLog, (t) => this.getRedact()(t));
    this.stderr = new RedactingLineWriter(p.stderrLog, (t) => this.getRedact()(t));
    this.setupLogChunks();
    this.setupTokenCap();

    const onSignal = () => this.requestCancel("signal");
    if (this.opts.handleSignals) {
      process.on("SIGTERM", onSignal);
      process.on("SIGINT", onSignal);
    }

    this.log(
      `runner ${RUNNER_VERSION}: trial ${this.job.trial_id} attempt ${this.job.attempt} pid ${process.pid}`,
    );
    try {
      await this.phases();
    } catch (err) {
      if (err instanceof CancelledError || this.cancelRequested) {
        this.failure = { outcome: "cancelled", reason: "cancelled", failureClass: "cancelled" };
      } else {
        this.failure ??= {
          outcome: "failed_infra",
          reason: `runner error: ${(err as Error).message}`,
          failureClass: "runner_error",
        };
      }
      this.log(`runner: ${this.failure.reason}`);
    }

    const result = await this.finish();
    if (this.opts.handleSignals) {
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
    }
    return result;
  }

  // ------------------------------------------------------------------------------------------
  // Live log chunks, token cap, network probe (TDM-160)

  private setupLogChunks(): void {
    const cfg = this.job.log_chunks;
    if (!cfg) return;
    if (!this.job.ingest) {
      this.log("runner: log_chunks needs ingest; live chunks off (logs are in the bundle)");
      return;
    }
    for (const stream of cfg.streams) {
      const chunker = new LogChunker({
        stream,
        config: cfg,
        dir: this.paths.chunksDir,
        upload: (name, path) =>
          uploadArtifact(this.job, name, path, {
            allowIngest: this.sink.mode === "push",
            ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
          }),
        emit: (payload) => this.sink.emit({ type: "trial.log_chunk", payload }),
        log: this.log,
        ...(this.opts.logChunkRetryMs !== undefined
          ? { retryDelayMs: this.opts.logChunkRetryMs }
          : {}),
      });
      this.chunkers.set(stream, chunker);
      const writer = stream === "stdout" ? this.stdout : this.stderr;
      writer.onWrite = (text) => chunker.write(text);
    }
  }

  private async closeLogChunks(): Promise<void> {
    const deadline = this.opts.logChunkDeadlineMs ?? 60_000;
    await Promise.all([...this.chunkers.values()].map((c) => c.close(deadline)));
  }

  private setupTokenCap(): void {
    const cap = this.job.token_cap_micro_usd;
    if (cap === undefined) return;
    this.meter = new TokenMeter(
      cap,
      this.job.token_prices,
      (snap) => {
        this.budgetHit = snap;
        this.log(
          `runner: token cap crossed: ${formatUsd(snap.spent_micro_usd)} (${snap.source}) + ${formatUsd(snap.margin_micro_usd)} margin > ${formatUsd(snap.cap_micro_usd)} cap; stopping`,
        );
        this.resolveBudget();
      },
      { marginPct: this.job.token_cap_margin_pct },
    );
  }

  private budgetReason(snap: TokenMeterSnapshot, what: string): string {
    const t = snap.tokens;
    return (
      `token cap exceeded during ${what}: spent ${formatUsd(snap.spent_micro_usd)} ` +
      `(${snap.spent_micro_usd} micro-USD, ${snap.source}) over the ${formatUsd(snap.cap_micro_usd)} ` +
      `cap (${snap.cap_micro_usd} micro-USD) with a ${formatUsd(snap.margin_micro_usd)} margin ` +
      `(${snap.margin_pct}% of ${snap.open_sessions} unreported session(s)); tokens in ${t.input} ` +
      `out ${t.output} (estimated; ${snap.usage_output} per-message usage) cache_read ` +
      `${t.cache_read} cache_write ${t.cache_creation}`
    );
  }

  /** Probe the network and record it; never fails the trial. */
  private async probeNetwork(): Promise<void> {
    const cfg = this.job.network;
    if (!cfg) return;
    try {
      const result = await probeNetwork(
        cfg,
        this.opts.probeFetch ? { fetch: this.opts.probeFetch } : {},
      );
      await writeJsonAtomic(this.paths.networkJson, result);
      const failed = Object.values(result.allowed).some((v) => v === "failed");
      this.sink.emit({
        type: "trial.network",
        severity: failed ? "warn" : "info",
        payload: { allowed: result.allowed, canary: result.canary, canary_url: result.canary_url },
      });
      this.log(
        `runner: network probe: canary ${result.canary}; allowed ${
          Object.entries(result.allowed)
            .map(([h, v]) => `${h}=${v}`)
            .join(", ") || "(none)"
        }`,
      );
    } catch (err) {
      this.log(`runner: network probe failed: ${(err as Error).message}`);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Phases

  private async phases(): Promise<void> {
    const p = this.paths;
    const job = this.job;

    // prepare
    await this.enter("prepare");
    this.secrets = await loadEnvFile(p.envFile);
    this.setRedact(createRedactor({ ...this.secrets, ANYBENCH_INGEST_TOKEN: job.ingest?.token }));
    this.sink.start();
    this.startHeartbeat();
    if (job.driver.start) {
      this.started = true;
      const r = await this.verb("start", job.driver.start, [], job.verb_timeout_s, p.outDir);
      if (!this.verbOk(r, "start_failed", "driver start")) return this.salvage();
    }

    // healthcheck
    await this.enter("healthcheck");
    if (job.healthcheck) {
      const r = await this.verb("healthcheck", job.healthcheck, [], job.verb_timeout_s, p.outDir);
      if (!this.verbOk(r, "healthcheck_failed", "healthcheck")) return this.salvage();
    }
    if (job.driver.ready && !(await this.waitReady(job.driver.ready))) return this.salvage();

    // warmup (always entered: the trial passes through `warming` even with zero warm-ups)
    await this.enter("warmup");
    for (let i = 0; i < job.warmup_runs; i++) {
      const out = join(p.warmupDir, String(i));
      await mkdir(out, { recursive: true });
      const r = await this.verb("warmup", job.driver.run, [p.inDir, out], job.wall_clock_s, out, i);
      if (!this.verbOk(r, "warmup_failed", `warm-up ${i}`, true)) return this.salvage();
    }

    // run
    await this.enter("run");
    const [machine] = await Promise.all([
      probeMachine(RUNNER_VERSION, this.opts.stealWindowMs ?? 1000),
      this.probeNetwork(),
    ]);
    await writeJsonAtomic(p.machineJson, machine);
    const r = await this.verb(
      "run",
      job.driver.run,
      [p.inDir, p.outDir],
      job.wall_clock_s,
      p.outDir,
    );
    this.status.run = {
      exit_code: r.exitCode,
      signal: r.signal,
      duration_ms: r.durationMs,
      timed_out: r.timedOut,
    };
    this.verbOk(r, "run_failed", "run", true);
    this.throwIfCancelled();

    await this.collectFreezeUpload();
  }

  /** After a failure before `run`: keep the evidence, then stop. */
  private async salvage(): Promise<void> {
    this.throwIfCancelled();
    await this.collectFreezeUpload();
  }

  private async collectFreezeUpload(): Promise<void> {
    const p = this.paths;
    const job = this.job;

    // collect: stop the driver first so whatever it flushes on exit is collected too.
    await this.enter("collect");
    await this.stopDriver();
    for (const rel of await matchFiles(p.wsDir, job.collect)) {
      const dest = join(p.artifactsDir, rel);
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(join(p.wsDir, rel), dest);
    }

    // freeze
    await this.enter("freeze");
    await Promise.all([this.stdout.close(), this.stderr.close()]);
    // The last segments go out before the bundle, so their events are in the frozen events.jsonl.
    await this.closeLogChunks();
    const live = new Set(["status.json", "events.jsonl", "manifest.json"]);
    const files = (await listFiles(p.outDir)).filter((f) => !f.includes(".tmp-"));
    const manifest = [];
    for (const f of files) {
      if (live.has(f)) continue;
      const { sha256, sizeBytes } = await sha256File(join(p.outDir, f));
      manifest.push({ path: f, sha256, size_bytes: sizeBytes });
    }
    await writeJsonAtomic(p.manifestJson, {
      trial_id: job.trial_id,
      attempt: job.attempt,
      frozen_at: new Date().toISOString(),
      files: manifest,
    });
    await writeTarGz(
      p.outDir,
      [...manifest.map((m) => m.path), "manifest.json", "events.jsonl"],
      p.bundle,
    );

    // upload
    await this.enter("upload");
    if (!job.upload.enabled) {
      this.status.upload = { state: "skipped", artifacts: [], error: null };
      return;
    }
    try {
      const uploaded: UploadedArtifact | null = await uploadArtifact(
        job,
        job.upload.bundle_name,
        p.bundle,
        {
          allowIngest: this.sink.mode === "push",
          ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
        },
      );
      this.status.upload = uploaded
        ? { state: "uploaded", artifacts: [uploaded], error: null }
        : { state: "skipped", artifacts: [], error: null };
    } catch (err) {
      // Not a trial failure: the outputs are frozen on disk and the worker can still fetch them.
      const error = this.getRedact()((err as Error).message);
      this.status.upload = { state: "failed", artifacts: [], error };
      this.log(`runner: upload failed: ${error}`);
    }
  }

  private async waitReady(command: string): Promise<boolean> {
    const deadline = Date.now() + this.job.ready_timeout_s * 1000;
    let last: VerbResult | null = null;
    while (Date.now() < deadline) {
      this.throwIfCancelled();
      const left = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
      last = await this.verb(
        "ready",
        command,
        [],
        Math.min(left, this.job.verb_timeout_s),
        this.paths.outDir,
      );
      if (last.exitCode === 0) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    this.fail(
      "failed_subject",
      "not_ready",
      `driver not ready after ${this.job.ready_timeout_s}s (last exit ${last?.exitCode ?? "none"})`,
    );
    return false;
  }

  private async stopDriver(): Promise<void> {
    if (!this.started || !this.job.driver.stop) return;
    this.started = false;
    const r = await this.verb(
      "stop",
      this.job.driver.stop,
      [],
      this.job.verb_timeout_s,
      this.paths.outDir,
      undefined,
      true,
    );
    if (r.exitCode !== 0) this.log(`runner: driver stop exited ${r.exitCode ?? r.signal}`);
  }

  // ------------------------------------------------------------------------------------------
  // Verbs

  private driverEnv(phase: string, out: string, iteration?: number): NodeJS.ProcessEnv {
    const p = this.paths;
    return {
      ...process.env,
      ...this.job.env,
      ...this.secrets,
      EVAL_IN: p.inDir,
      EVAL_WS: p.wsDir,
      EVAL_OUT: out,
      EVAL_SECRETS: p.envFile,
      EVAL_PHASE: phase,
      EVAL_TRIAL_ID: this.job.trial_id,
      EVAL_RUN_ID: this.job.run_id,
      EVAL_ATTEMPT: String(this.job.attempt),
      ...(iteration !== undefined ? { EVAL_ITERATION: String(iteration) } : {}),
    };
  }

  private verb(
    name: string,
    command: string,
    args: string[],
    timeoutS: number,
    out: string,
    iteration?: number,
    ignoreCancel = false,
  ): Promise<VerbResult> {
    if (!ignoreCancel) this.throwIfCancelled();
    // The token cap watches the verbs that run the subject: warm-ups and `run`. Both also stop
    // on the run's budget stop (TDM-242), with or without a token cap.
    const subject = name === "run" || name === "warmup";
    const metered = this.meter !== null && subject;
    this.stdout.onLine = metered ? (line) => this.meter?.line(line) : null;
    if (subject) this.checkBudgetStop();
    return runVerb({
      command,
      args,
      shell: this.shell,
      cwd: this.cwd,
      env: this.driverEnv(name, out, iteration),
      timeoutMs: timeoutS * 1000,
      stdout: this.stdout,
      stderr: this.stderr,
      tag: `[${name}${iteration !== undefined ? ` ${iteration}` : ""}] `,
      ...(ignoreCancel ? {} : { cancelled: this.cancelled }),
      ...(subject ? { abort: this.budgetStop } : {}),
    }).finally(() => {
      this.stdout.onLine = null;
    });
  }

  /** True on exit 0; otherwise records a subject failure (first one wins). */
  private verbOk(r: VerbResult, failureClass: string, what: string, metered = false): boolean {
    if (r.cancelled) throw new CancelledError();
    // Crossing the token cap fails the verb even if it managed to exit 0 before the kill landed.
    if (metered && this.budgetHit) {
      this.fail("failed_subject", "budget", this.budgetReason(this.budgetHit, what));
      return false;
    }
    if (metered && this.runBudgetStop !== null) {
      this.fail(
        "failed_subject",
        "budget",
        `the run's budget stopped ${what}: ${this.runBudgetStop}; the work so far is collected and graded`,
      );
      return false;
    }
    if (r.timedOut) {
      this.fail(
        "failed_subject",
        "wall_clock_exceeded",
        `${what} exceeded its time cap after ${r.durationMs} ms`,
      );
      return false;
    }
    if (r.exitCode !== 0) {
      this.fail("failed_subject", failureClass, `${what} exited ${r.exitCode ?? `on ${r.signal}`}`);
      return false;
    }
    return true;
  }

  private fail(outcome: Failure["outcome"], failureClass: string, reason: string): void {
    if (this.failure) return;
    this.failure = { outcome, failureClass, reason };
    this.log(`runner: ${outcome}: ${reason}`);
  }

  // ------------------------------------------------------------------------------------------
  // Phase bookkeeping, heartbeat, status

  private async enter(phase: Exclude<RunnerPhase, "failed" | "cancelled">): Promise<void> {
    this.throwIfCancelled();
    const now = new Date().toISOString();
    const prev = this.status.phases.at(-1);
    if (prev && prev.ended_at === null) prev.ended_at = now;
    this.status.phases.push({ phase, started_at: now, ended_at: null });
    this.status.phase = phase;
    const to = TRIAL_STATE_BY_RUNNER_PHASE[phase];
    // Once something failed, only the final failure edge is reported (in finish()).
    if (!this.failure && to !== this.trialState) {
      this.sink.emit({
        type: "trial.phase",
        payload: {
          from: this.trialState,
          to,
          attempt: this.job.attempt,
          reason: `runner phase ${phase}`,
        },
      });
      this.trialState = to;
    }
    this.log(`runner: phase ${phase}`);
    await this.writeStatus();
  }

  private startHeartbeat(): void {
    this.heartbeat();
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.job.heartbeat_s * 1000);
  }

  private heartbeat(): void {
    if (!this.cancelRequested && existsSync(this.paths.cancelFile))
      this.requestCancel("cancel file");
    this.checkBudgetStop();
    const now = Date.now();
    this.sink.emit({
      type: "trial.heartbeat",
      payload: {
        phase: this.trialState,
        lease_owner: this.leaseOwner,
        lease_until: new Date(now + this.job.heartbeat_s * 3000).toISOString(),
        log_offset: this.stdout.bytes + this.stderr.bytes,
      },
      severity: "debug",
    });
    this.status.heartbeat_at = new Date(now).toISOString();
    void this.writeStatus();
    void this.sink.flush();
  }

  /** TDM-242: the worker wrote ~/.anybench/budget-stop: stop the subject's verb like a cap hit. */
  private checkBudgetStop(): void {
    if (this.runBudgetStop !== null || !existsSync(this.paths.budgetStopFile)) return;
    let why = "the run reached its budget";
    try {
      const text = readFileSync(this.paths.budgetStopFile, "utf8").trim().split("\n")[0] ?? "";
      if (text) why = text.slice(0, 500);
    } catch {
      // unreadable: the default reason
    }
    this.runBudgetStop = why;
    this.log(`runner: budget stop requested (${why}); stopping`);
    this.resolveBudget();
  }

  private requestCancel(why: string): void {
    if (this.cancelRequested) return;
    this.cancelRequested = true;
    this.log(`runner: cancel requested (${why})`);
    this.resolveCancel();
  }

  private throwIfCancelled(): void {
    if (!this.cancelRequested && existsSync(this.paths.cancelFile))
      this.requestCancel("cancel file");
    if (this.cancelRequested) throw new CancelledError();
  }

  private snapshot(): RunnerStatus {
    this.status.updated_at = new Date().toISOString();
    this.status.trial_state = this.trialState;
    this.status.push = {
      mode: this.sink.mode,
      sent_batches: this.sink.sentBatches,
      failed_posts: this.sink.failedPosts,
      last_error: this.sink.lastError,
    };
    this.status.events = { count: this.sink.count, bytes: this.sink.bytes };
    if (this.chunkers.size > 0) {
      this.status.log_chunks = Object.fromEntries(
        [...this.chunkers].map(([stream, c]) => [
          stream,
          { segments: c.segments, bytes: c.bytes, state: c.state, error: c.error },
        ]),
      );
    }
    if (this.meter) {
      const m = this.meter.snapshot();
      this.status.token_cap = {
        cap_micro_usd: m.cap_micro_usd.toString(),
        spent_micro_usd: m.spent_micro_usd.toString(),
        margin_micro_usd: m.margin_micro_usd.toString(),
        source: m.source,
        exceeded: m.exceeded,
      };
    }
    return structuredClone(this.status);
  }

  private writeStatus(): Promise<void> {
    const snap = this.snapshot();
    this.statusWrite = this.statusWrite
      .then(() => writeJsonAtomic(this.paths.statusJson, snap))
      .catch((err: unknown) =>
        this.log(`runner: cannot write status.json: ${(err as Error).message}`),
      );
    return this.statusWrite;
  }

  private async finish(): Promise<RunTrialResult> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.failure?.outcome === "cancelled") await this.stopDriver().catch(() => undefined);
    await Promise.all([this.stdout.close(), this.stderr.close()]).catch(() => undefined);
    await this.closeLogChunks().catch(() => undefined);

    const now = new Date().toISOString();
    const prev = this.status.phases.at(-1);
    if (prev && prev.ended_at === null) prev.ended_at = now;

    const failure = this.failure;
    if (failure) {
      this.status.phase = failure.outcome === "cancelled" ? "cancelled" : "failed";
      this.status.phases.push({ phase: this.status.phase, started_at: now, ended_at: now });
      this.status.result = {
        outcome: failure.outcome,
        reason: this.getRedact()(failure.reason),
        failure_class: failure.failureClass,
      };
      try {
        this.sink.emit({
          type: "trial.phase",
          severity: failure.outcome === "cancelled" ? "warn" : "error",
          payload: {
            from: this.trialState,
            to: failure.outcome,
            attempt: this.job.attempt,
            reason: failure.reason,
            failure_class: failure.failureClass,
          },
        });
        this.trialState = failure.outcome;
      } catch (err) {
        this.log(`runner: cannot report ${failure.outcome}: ${(err as Error).message}`);
      }
    } else {
      this.status.phase = "done";
      this.status.phases.push({ phase: "done", started_at: now, ended_at: now });
      this.status.result = { outcome: "ok", reason: null, failure_class: null };
      // Last heartbeat: the worker sees `done` in the status carried by this batch.
      this.heartbeat();
    }

    await this.writeStatus();
    await this.sink.close(this.opts.finalFlushMs ?? 10_000);
    const status = this.snapshot();
    await this.writeStatus();
    await this.statusWrite;
    this.log(
      `runner: ${status.phase} (${status.result?.outcome}); push ${status.push.mode}, ${status.events.count} events`,
    );

    const exitCode =
      failure === null
        ? RUNNER_EXIT.ok
        : failure.outcome === "cancelled"
          ? RUNNER_EXIT.cancelled
          : failure.outcome === "failed_subject"
            ? RUNNER_EXIT.failed_subject
            : RUNNER_EXIT.failed_infra;
    return { exitCode, status };
  }
}
