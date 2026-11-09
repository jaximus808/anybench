// TDM-49 test helpers: a scripted stand-in for the in-VM runner on FakeProvider, plus the wiring
// (memory stores, registry, executor deps) every executor test uses.
import { newId, RunIdSchema, TrialIdSchema } from "@anybench/core";
import { createComputerRegistry, MemoryComputerStore, type ComputerRegistry } from "@anybench/envs";
import { FakeProvider, type FakeExecContext } from "@anybench/providers";
import {
  RUNNER_PHASES,
  TrialJobSchema,
  type RunnerPhase,
  type RunnerStatus,
  type TrialJob,
} from "@anybench/runner";
import {
  MemoryTrialExecStore,
  type ExecutorDeps,
  type ExecutorTiming,
  type TrialPrepared,
} from "../src/index.js";

export type FakeRunnerModeTdm49 =
  /** prepare → … → done, heartbeats every step. */
  | "ok"
  /** The run fails as the subject's fault (wall clock); still collects and uploads. */
  | "subject_fail"
  /** Writes status.json in `run` once, then dies without a final phase (no more heartbeats). */
  | "hang"
  /** Reports an infra failure itself (a claim the executor must not honour as infra). */
  | "infra_fail"
  /** Ends with a final phase but no result at all. */
  | "fail_no_outcome"
  /** Writes `cancelled` into status.json although nobody wrote the cancel file. */
  | "self_cancel";

export interface FakeRunnerLaunchTdm49 {
  computerId: string;
  trialId: string;
  attempt: number;
  token: string | null;
  mode: FakeRunnerModeTdm49;
}

const STEPS: Record<(typeof RUNNER_PHASES)[number], number> = {
  prepare: 1,
  healthcheck: 1,
  warmup: 2,
  run: 6,
  collect: 1,
  freeze: 1,
  upload: 1,
  done: 0,
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Script the runner on a FakeProvider. `mode(job)` picks each launch's behaviour; every step takes
 * `stepMs` real ms and rewrites status.json with a fresh heartbeat. The cancel file is honoured.
 */
export function installFakeRunnerTdm49(
  fake: FakeProvider,
  mode: (job: TrialJob) => FakeRunnerModeTdm49,
  stepMs = 15,
): FakeRunnerLaunchTdm49[] {
  const launches: FakeRunnerLaunchTdm49[] = [];
  fake.onExec(/\.anybench\/bin\/runner' --trial '([^']+)'/, async (ctx: FakeExecContext) => {
    const home = ctx.home;
    const raw = ctx.readFile(`${home}/.anybench/trial.json`);
    if (raw === undefined) return { stderr: "no trial.json", exitCode: 2 };
    const job = TrialJobSchema.parse(JSON.parse(raw));
    if (job.trial_id !== ctx.match?.[1]) return { stderr: "trial id mismatch", exitCode: 2 };
    const m = mode(job);
    launches.push({
      computerId: ctx.computerId,
      trialId: job.trial_id,
      attempt: job.attempt,
      token: job.ingest?.token ?? null,
      mode: m,
    });
    const statusPath = `${home}/eval/out/status.json`;
    const startedAt = new Date().toISOString();
    const phases: RunnerStatus["phases"] = [];
    let result: RunnerStatus["result"] = null;
    let upload: RunnerStatus["upload"] = null;
    const write = (phase: RunnerPhase) => {
      const at = new Date().toISOString();
      const last = phases.at(-1);
      if (!last || last.phase !== phase) {
        if (last) last.ended_at = at;
        phases.push({ phase, started_at: at, ended_at: null });
      }
      const doc: RunnerStatus = {
        trial_id: job.trial_id,
        run_id: job.run_id,
        attempt: job.attempt,
        runner_version: "0.1.0-fake",
        pid: 4242,
        hostname: "fake",
        phase,
        trial_state: "running",
        started_at: startedAt,
        updated_at: at,
        heartbeat_at: at,
        phases,
        push: { mode: "file_only", sent_batches: 0, failed_posts: 0, last_error: null },
        events: { count: phases.length, bytes: 0 },
        run: { exit_code: 0, signal: null, duration_ms: 10, timed_out: false },
        upload,
        result,
      };
      ctx.writeFile(statusPath, JSON.stringify(doc));
    };
    const cancelled = () => ctx.readFile(`${home}/.anybench/cancel`) !== undefined;
    let subjectFailed = false;
    for (const phase of RUNNER_PHASES) {
      if (phase === "done") break;
      if (phase === "run")
        ctx.writeFile(`${home}/eval/out/machine.json`, '{"nproc":2,"load_1m":0.1}');
      // TDM-232: the freeze writes manifest.json (the runner's own logs plus the frozen workspace).
      if (phase === "freeze")
        ctx.writeFile(
          `${home}/eval/out/manifest.json`,
          JSON.stringify({
            trial_id: job.trial_id,
            attempt: job.attempt,
            frozen_at: "2026-11-09T04:00:00.000Z",
            files: [
              { path: "stdout.log", sha256: "a".repeat(64), size_bytes: 1 },
              { path: "machine.json", sha256: "a".repeat(64), size_bytes: 1 },
              { path: "workspace/sorted.txt", sha256: "a".repeat(64), size_bytes: 1 },
            ],
          }),
        );
      write(phase);
      if (m === "hang" && phase === "run") return { exitCode: 137 };
      if (m === "fail_no_outcome" && phase === "warmup") {
        write("failed");
        return { exitCode: 11 };
      }
      if (m === "self_cancel" && phase === "warmup") {
        result = {
          outcome: "cancelled",
          reason: "I would rather not be measured",
          failure_class: null,
        };
        write("cancelled");
        return { exitCode: 12 };
      }
      if (m === "infra_fail" && phase === "warmup") {
        result = {
          outcome: "failed_infra",
          reason: "driver start crashed",
          failure_class: "start",
        };
        write("failed");
        return { exitCode: 11 };
      }
      for (let i = 0; i < STEPS[phase]; i++) {
        await realSleep(stepMs);
        if (cancelled()) {
          result = { outcome: "cancelled", reason: "cancel file", failure_class: null };
          write("cancelled");
          return { exitCode: 12 };
        }
        write(phase);
      }
      if (m === "subject_fail" && phase === "run") subjectFailed = true;
      if (phase === "upload") {
        upload = {
          state: "uploaded",
          artifacts: [
            {
              name: "out.tar.gz",
              key: `runs/${job.run_id}/trials/${job.trial_id}/out.tar.gz`,
              sha256: "a".repeat(64),
              size_bytes: 10,
            },
          ],
          error: null,
        };
      }
    }
    if (subjectFailed) {
      result = { outcome: "failed_subject", reason: "wall clock cap", failure_class: "wall_clock" };
      write("failed");
      return { exitCode: 10 };
    }
    result = { outcome: "ok", reason: null, failure_class: null };
    write("done");
    return { exitCode: 0 };
  });
  return launches;
}

export const TIMING_TDM49: Partial<ExecutorTiming> = {
  leaseMs: 300,
  leaseRefreshMs: 50,
  pollMs: 10,
  readyTimeoutMs: 2_000,
  startTimeoutMs: 600,
  staleMs: 250,
  cancelGraceMs: 400,
};

export const SECRET_TDM49 = "sk-ant-api03-tdm49-SECRET-value-do-not-leak";
export const TOKEN_SECRET_TDM49 = "tdm49-runner-token-secret-0123456789abcdef";

export function preparedTdm49(): TrialPrepared {
  return {
    job: {
      driver: { type: "cli", run: 'sort "$1/words.txt" > "$2/sorted.txt"' },
      wall_clock_s: 60,
      heartbeat_s: 1,
    },
    computer: { vcpu: 2, memoryMb: 4096, snapshotId: undefined },
    secrets: { ANTHROPIC_API_KEY: SECRET_TDM49 },
    files: [{ path: "eval/in/words.txt", content: "delta\nalpha\n" }],
  };
}

export interface HarnessTdm49 {
  /** The executor's injected clock: real time plus `skewMs` (tests may move it). */
  clock: { now: () => number; skewMs: number };
  fake: FakeProvider;
  store: MemoryTrialExecStore;
  computers: MemoryComputerStore;
  registry: ComputerRegistry;
  runId: string;
  deps: (over?: Partial<ExecutorDeps>) => ExecutorDeps;
  newTrial: () => string;
  /** Registry-row creates (each fork/create call). */
  creates: () => number;
}

export function harnessTdm49(opts: { maxComputers?: number } = {}): HarnessTdm49 {
  const fake = new FakeProvider({ name: "fake-tdm49", ...opts });
  const store = new MemoryTrialExecStore();
  const computers = new MemoryComputerStore();
  const registry = createComputerRegistry({
    provider: fake,
    store: computers,
    pricing: { pricePerBlockMicroUsd: 27_600n },
  });
  const runId = newId(RunIdSchema);
  const clock = { skewMs: 0, now: () => Date.now() + clock.skewMs };
  return {
    clock,
    fake,
    store,
    computers,
    registry,
    runId,
    deps: (over = {}) => ({
      store,
      registry,
      source: { prepare: async () => preparedTdm49() },
      ingest: {
        url: "https://api.anybench.test",
        token: (trialId, attempt) => `abrt1.fake-${trialId.slice(-6)}-${attempt}-${"x".repeat(20)}`,
      },
      owner: `worker-a~${Date.now()}`,
      now: clock.now,
      timing: TIMING_TDM49,
      actor: { kind: "worker", id: "worker-a" },
      ...over,
    }),
    newTrial: () => {
      const id = newId(TrialIdSchema);
      store.seed({ id, run_id: runId, owner_id: "user-1" });
      return id;
    },
    creates: () => computers.rows.size,
  };
}

/** Poll until `cond` holds (real time). */
export async function waitForTdm49(cond: () => boolean, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("waitForTdm49: timed out");
    await realSleep(5);
  }
}

/** trial.phase edges in the memory store, as `from→to`. */
export function phaseEdgesTdm49(store: MemoryTrialExecStore, trialId: string): string[] {
  return store.events
    .filter((e) => e.type === "trial.phase" && e.source_id === trialId)
    .map((e) => {
      const p = e.payload as { from: string | null; to: string };
      return `${p.from ?? "∅"}→${p.to}`;
    });
}
