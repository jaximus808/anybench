// TDM-54 test harness: an in-memory graphile-worker stand-in (keyed jobs, replace on re-add),
// "workers" that run run.advance / trial.execute / a test trial.gate against local Postgres, and
// a way to kill one mid-job (abort it, keep its lease, make its heartbeat stale).
import { readFileSync } from "node:fs";
import { AnybenchEventSchema, type KitSpec, type ProjectDigest, type RunId } from "@anybench/core";
import type { FakeProvider } from "@anybench/providers";
import { and, eq, sql } from "drizzle-orm";
import type { JobHelpers } from "graphile-worker";
import type { Database } from "../../src/db/client.js";
import { trials, workerHeartbeats } from "../../src/db/schema/index.js";
import { createRunAdvanceJob, type RunAdvanceJobOptions } from "../../src/jobs/run-advance.js";
import { createTrialExecuteJob } from "../../src/jobs/trial-execute.js";
import type { JobContext, JobDef } from "../../src/jobs/types.js";
import { appendEvents } from "../../src/lib/events.js";
import type { JobsPort } from "../../src/orchestrator/advance.js";
import { kitTrialSource } from "../../src/orchestrator/defaults.js";
import { configTdm14, recordingSentryTdm14, silentLoggerTdm14 } from "./server-tdm14.js";

export interface MemJobTdm54 {
  task: string;
  payload: Record<string, unknown>;
  key: string;
  runAt: Date | null;
}

/** graphile-worker in memory: one pending job per key (re-adding replaces it), FIFO. */
export class MemQueueTdm54 implements JobsPort {
  readonly pending = new Map<string, MemJobTdm54>();
  /** Every add, in order. */
  readonly added: MemJobTdm54[] = [];
  private anon = 0;

  async add(
    task: string,
    payload: Record<string, unknown>,
    spec: { jobKey?: string; runAt?: Date },
  ): Promise<void> {
    const key = spec.jobKey ?? `anon:${this.anon++}`;
    const job = { task, payload, key, runAt: spec.runAt ?? null };
    this.pending.delete(key); // replace keeps one job per key; move it to the back
    this.pending.set(key, job);
    this.added.push(job);
  }

  async pendingKeys(keys: readonly string[]): Promise<Set<string>> {
    return new Set(keys.filter((k) => this.pending.has(k)));
  }

  async pendingKeysWithPrefix(prefix: string): Promise<string[]> {
    return [...this.pending.keys()].filter((k) => k.startsWith(prefix));
  }

  take(): MemJobTdm54 | undefined {
    const first = this.pending.values().next();
    if (first.done) return undefined;
    this.pending.delete(first.value.key);
    return first.value;
  }

  addedTasks(task: string): MemJobTdm54[] {
    return this.added.filter((j) => j.task === task);
  }
}

export function kitTdm54(overrides: Partial<KitSpec> = {}): KitSpec {
  const url = new URL("../fixtures/tdm67-kit-software-cli.json", import.meta.url);
  const kit = JSON.parse(readFileSync(url, "utf8")) as KitSpec;
  // 2 contenders × 1 workload × 2 repeats = 4 trials.
  return { ...kit, workloads: kit.workloads.slice(0, 1), repeats: 2, ...overrides };
}

export function digestTdm54(): ProjectDigest {
  return {
    source: { kind: "github", url: "https://github.com/BurntSushi/ripgrep", ref: "14.1.1" },
    name: "ripgrep",
    kind: "software",
    summary: "ripgrep recursively searches directories for a regex pattern.",
    languages: [{ name: "Rust", bytes: 1000 }],
    entrypoints: [{ kind: "bin", name: "rg" }],
    build_commands: [],
    test_commands: [],
    docs: ["README.md"],
    releases: { tags: [] },
    files: { count: 10, total_bytes: 1000 },
    suggested_driver_types: ["cli"],
    ingested_at: "2026-11-07T00:00:00.000Z",
    hash: "b".repeat(64),
  };
}

/** trial.gate for tests (the real one is [5.6]): collecting → gating → done, gate passed. */
export function testGateJobTdm54(): JobDef {
  return {
    name: "trial.gate",
    payload: { safeParse: (v: unknown) => ({ success: true, data: v }) } as never,
    async run(raw, ctx) {
      const p = raw as { trial_id: string; attempt: number };
      await ctx.db.transaction(async (tx) => {
        const [t] = await tx
          .update(trials)
          .set({
            state: "done",
            gate: { "same-matches": { pass: true } },
            metrics: { wall_s: 1.5 },
            updatedAt: sql`now()`,
          })
          .where(and(eq(trials.id, p.trial_id), eq(trials.state, "collecting")))
          .returning();
        if (!t) return;
        const at = new Date().toISOString();
        const ev = (from: "collecting" | "gating", to: "gating" | "done") =>
          AnybenchEventSchema.parse({
            run_id: t.runId,
            seq: 0,
            type: "trial.phase",
            source: "trial",
            source_id: t.id,
            severity: "info",
            actor: { kind: "worker", id: ctx.workerId },
            at,
            payload: { from, to, attempt: t.attempt },
          });
        await appendEvents(tx, t.runId as RunId, [
          ev("collecting", "gating"),
          ev("gating", "done"),
        ]);
      });
    },
  };
}

export interface WorkerTdm54 {
  id: string;
  ctx: JobContext;
  handlers: Map<string, JobDef>;
  abort: AbortController;
}

export function workerTdm54(
  db: Database,
  url: string,
  id: string,
  queue: MemQueueTdm54,
  fake: FakeProvider,
  orchestrator: RunAdvanceJobOptions,
  env: Record<string, string> = {},
): WorkerTdm54 {
  const ctx: JobContext = {
    config: configTdm14(url, env),
    logger: silentLoggerTdm14(),
    db,
    sentry: recordingSentryTdm14(),
    workerId: id,
    workerStartedAt: new Date(Date.now() - 1000),
  };
  const handlers = new Map<string, JobDef>();
  const runAdvance = createRunAdvanceJob({
    jobs: () => queue,
    timing: { leaseRefreshMs: 50, trialPollMs: 10, busyRetryMs: 10 },
    ...orchestrator,
  });
  const trialExecute = createTrialExecuteJob({
    provider: () => fake,
    source: (c) => kitTrialSource(c.db),
    timing: { pollMs: 10, leaseRefreshMs: 50, staleMs: 2_000, startTimeoutMs: 2_000 },
  });
  for (const j of [runAdvance, trialExecute, testGateJobTdm54()]) handlers.set(j.name, j as JobDef);
  return { id, ctx, handlers, abort: new AbortController() };
}

function helpersFor(w: WorkerTdm54, queue: MemQueueTdm54): JobHelpers {
  return {
    abortSignal: w.abort.signal,
    job: { attempts: 1, max_attempts: 25 },
    addJob: async (
      task: string,
      payload: unknown,
      spec: { jobKey?: string; runAt?: Date } = {},
    ) => {
      await queue.add(task, (payload ?? {}) as Record<string, unknown>, spec);
      return {} as never;
    },
  } as unknown as JobHelpers;
}

/** Run one job on `w`; resolves with the job's promise (which a killed worker may never settle). */
export function runJobTdm54(w: WorkerTdm54, queue: MemQueueTdm54, job: MemJobTdm54): Promise<void> {
  const def = w.handlers.get(job.task);
  if (!def) return Promise.resolve();
  const parsed = def.payload.safeParse(job.payload);
  if (!parsed.success) throw new Error(`invalid ${job.task} payload in test`);
  return def.run(parsed.data, w.ctx, helpersFor(w, queue));
}

/** Drain the queue on `w` until it is empty (or `until` says stop). Returns how many jobs ran. */
export async function drainTdm54(
  w: WorkerTdm54,
  queue: MemQueueTdm54,
  opts: { maxJobs?: number; until?: () => Promise<boolean> } = {},
): Promise<number> {
  const max = opts.maxJobs ?? 300;
  let n = 0;
  for (; n < max; n++) {
    if (opts.until && (await opts.until())) return n;
    const job = queue.take();
    if (!job) return n;
    await runJobTdm54(w, queue, job);
  }
  throw new Error(`drainTdm54: still busy after ${max} jobs`);
}

/** Kill a worker: abort its jobs (they stop, keeping their leases) and age its heartbeat. */
export async function killWorkerTdm54(db: Database, w: WorkerTdm54): Promise<void> {
  w.abort.abort();
  await db
    .update(workerHeartbeats)
    .set({ lastTickAt: sql`now() - interval '10 minutes'` })
    .where(eq(workerHeartbeats.workerId, w.id));
}
