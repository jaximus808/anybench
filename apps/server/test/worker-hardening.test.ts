// worker-hardening on local Postgres + FakeProvider:
//   1. stale graphile locks: a killed worker's locks are released on start (dead heartbeat row on
//      this host, or our own WORKER_ID from an earlier start), a live process's never are, an
//      unclaimed old lock is released unless a pre-change process is alive; and the released
//      trial.execute re-attaches to the running trial's computer without starting a second runner.
//   2. provider-outage breaker on the DB: opens after N 5xx, emits provider.outage to runs with
//      unfinished trials, parks trial.execute / trial.gate without spending attempts, the probe
//      closes it.
//   3. operator settle: POST-equivalent settleRun + run.settle cleanup; nothing billed.
import { hostname } from "node:os";
import { newId, TrialIdSchema } from "@anybench/core";
import { createComputerRegistry } from "@anybench/envs";
import { FakeProvider, ProviderError } from "@anybench/providers";
import { eq, sql } from "drizzle-orm";
import { runMigrations as runGraphileMigrations, type JobHelpers } from "graphile-worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import {
  computers,
  contenders,
  events as eventsTable,
  kits,
  providerBreakers,
  runs,
  trials,
  users,
  workerHeartbeats,
} from "../src/db/schema/index.js";
import { startWorker, type WorkerHandle } from "../src/jobs/runner.js";
import { createRunSettleJob } from "../src/jobs/run-settle.js";
import { unlockStaleGraphileJobs } from "../src/jobs/stale-locks.js";
import { createTrialExecuteJob, trialExecuteJobKey } from "../src/jobs/trial-execute.js";
import { createTrialGateJob } from "../src/jobs/trial-gate.js";
import type { JobContext } from "../src/jobs/types.js";
import { drizzleComputerStore } from "../src/lib/computer-store.js";
import { graphileJobQueue } from "../src/lib/job-queue.js";
import { readBreaker, runBreakerProbe } from "../src/lib/provider-breaker.js";
import { OPERATOR_SETTLED_FAILURE_CLASS, settleRun } from "../src/orchestrator/settle.js";
import { computeDecision } from "@anybench/billing";
import { createApiClient } from "@anybench/core";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { AppDeps } from "../src/types.js";
import { GateInfraError } from "@anybench/bench";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";
import { fakeRunnerTdm49 } from "./helpers/fake-runner-tdm49.js";
import { configTdm14, recordingSentryTdm14, silentLoggerTdm14 } from "./helpers/server-tdm14.js";

const available = await pgAvailableTdm11();
const DEAD_PID = 2_147_000_001; // never a live pid
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface SeedWh {
  ownerId: string;
  runId: string;
  contenderId: string;
}

let seedSeq = 0;
async function seedRunWh(db: Database, state = "running"): Promise<SeedWh> {
  const n = ++seedSeq;
  const [u] = await db
    .insert(users)
    .values({ githubLogin: `wh-${n}-${Date.now()}`, githubId: 70_000 + n })
    .returning();
  const [run] = await db
    .insert(runs)
    .values({
      ownerId: u!.id,
      question: "faster?",
      budgetMicroUsd: 5_000_000n,
      state: state as "running",
    })
    .returning();
  const [kit] = await db
    .insert(kits)
    .values({ ownerId: u!.id, runId: run!.id, version: 1, spec: {}, hash: `wh-${n}` })
    .returning();
  const [c] = await db
    .insert(contenders)
    .values({ runId: run!.id, kitId: kit!.id, source: "github", role: "subject" })
    .returning();
  return { ownerId: u!.id, runId: run!.id, contenderId: c!.id };
}

let repeat = 0;
async function trialWh(
  db: Database,
  s: SeedWh,
  extra: Partial<typeof trials.$inferInsert> = {},
): Promise<string> {
  const [t] = await db
    .insert(trials)
    .values({
      id: newId(TrialIdSchema),
      ownerId: s.ownerId,
      runId: s.runId,
      contenderId: s.contenderId,
      workloadId: "w1",
      repeat: repeat++,
      ...extra,
    })
    .returning();
  return t!.id;
}

async function heartbeatRow(
  db: Database,
  row: {
    workerId: string;
    host: string;
    pid: number;
    startedAt: Date;
    ids: string[] | null;
    ageMs?: number;
  },
) {
  await db.insert(workerHeartbeats).values({
    workerId: row.workerId,
    host: row.host,
    pid: row.pid,
    startedAt: row.startedAt,
    lastTickAt: sql`now() - (${row.ageMs ?? 0} * interval '1 millisecond')`,
    ticks: 1,
    graphileWorkerIds: row.ids,
  });
}

/** A job row locked by `lockedBy` `ageMs` ago, the way a killed worker leaves it. */
async function lockedJob(
  db: Database,
  task: string,
  payload: object,
  key: string,
  lockedBy: string,
  ageMs: number,
): Promise<void> {
  await db.execute(sql`select graphile_worker.add_job(
    identifier => ${task}::text, payload => ${JSON.stringify(payload)}::json, job_key => ${key}::text)`);
  await db.execute(sql`update graphile_worker._private_jobs
    set locked_by = ${lockedBy}, locked_at = now() - (${ageMs} * interval '1 millisecond'),
        attempts = 1
    where key = ${key}`);
}

async function lockOf(db: Database, key: string): Promise<string | null> {
  const r = (await db.execute(
    sql`select locked_by from graphile_worker._private_jobs where key = ${key}`,
  )) as unknown as { rows: { locked_by: string | null }[] };
  return r.rows[0]?.locked_by ?? null;
}

function helpersWh(added: { id: string; payload: unknown; spec: unknown }[], attempts = 1) {
  return {
    abortSignal: new AbortController().signal,
    job: { attempts },
    addJob: async (taskId: string, payload: unknown, spec: unknown) => {
      added.push({ id: taskId, payload, spec });
      return {} as never;
    },
  } as unknown as JobHelpers;
}

const gateKitSpecWh = {
  schema_version: 2,
  subject: { kind: "software", name: "summer", summary: "sums numbers", better_means: ["correct"] },
  contenders: [
    {
      id: "summer",
      role: "subject",
      source: { github: "example/summer", ref: "v1.0.0" },
      driver: { type: "cli", verbs: { run: "adapters/summer/driver.sh run" } },
    },
  ],
  workloads: [{ id: "add", instruction: "workloads/add/instruction.md" }],
  gates: [{ id: "sum-tests", kind: "hidden-tests" }],
  requirements: [
    {
      id: "solved",
      type: "measured",
      title: "Solved",
      metric: "gate_pass_rate",
      better: "higher",
      gate_id: "sum-tests",
    },
  ],
  proof: { oracle: { id: "ref", dir: "proof/oracle/" } },
  scoring: { weights: { solved: 100 } },
  repeats: 1,
};

const outage500 = () =>
  new ProviderError("provider", "naive internal (500): the sandbox request failed", {
    status: 500,
  });

describe.skipIf(!available)("worker hardening (local Postgres + FakeProvider)", () => {
  let h: FreshDbTdm11;
  let worker: WorkerHandle | undefined;

  beforeAll(async () => {
    h = await freshMigratedDbTdm11({ max: 4 });
    await runGraphileMigrations({ connectionString: h.url });
  }, 120_000);

  afterAll(async () => {
    await worker?.stop();
    await h?.drop();
  }, 60_000);

  // ---------- 1. stale locks ----------

  it("releases dead workers' locks, keeps live ones, and skips unknown ids while a pre-change worker lives", async () => {
    const me = { workerId: "wh-me", startedAt: new Date() };
    const host = hostname();
    // Dead on this host (pid gone), heartbeat still fresh: released at once, any lock age.
    await heartbeatRow(h.db, {
      workerId: "wh-dead-here",
      host,
      pid: DEAD_PID,
      startedAt: new Date(Date.now() - 60_000),
      ids: ["gw-dead-here"],
    });
    await lockedJob(h.db, "wh.noop", {}, "wh:dead-here", "gw-dead-here", 5_000);
    // Our own WORKER_ID from an earlier start.
    await heartbeatRow(h.db, {
      workerId: "wh-me",
      host: "elsewhere",
      pid: 1,
      startedAt: new Date(Date.now() - 3_600_000),
      ids: ["gw-me-before"],
    });
    await lockedJob(h.db, "wh.noop", {}, "wh:me-before", "gw-me-before", 5_000);
    // Live on another host: never released, however old the lock.
    await heartbeatRow(h.db, {
      workerId: "wh-live",
      host: "other-host",
      pid: 42,
      startedAt: new Date(),
      ids: ["gw-live"],
    });
    await lockedJob(h.db, "wh.noop", {}, "wh:live", "gw-live", 3_600_000);
    // Unclaimed: released only when older than 2 min.
    await lockedJob(h.db, "wh.noop", {}, "wh:orphan-old", "gw-orphan-old", 300_000);
    await lockedJob(h.db, "wh.noop", {}, "wh:orphan-new", "gw-orphan-new", 10_000);

    const r = await unlockStaleGraphileJobs(h.db, {
      workerId: me.workerId,
      workerStartedAt: me.startedAt,
      ownGraphileIds: [],
    });
    expect(r.unlocked.sort()).toEqual(["gw-dead-here", "gw-me-before", "gw-orphan-old"]);
    expect(await lockOf(h.db, "wh:dead-here")).toBeNull();
    expect(await lockOf(h.db, "wh:me-before")).toBeNull();
    expect(await lockOf(h.db, "wh:orphan-old")).toBeNull();
    expect(await lockOf(h.db, "wh:live")).toBe("gw-live");
    expect(await lockOf(h.db, "wh:orphan-new")).toBe("gw-orphan-new");
    // The dead row's leases are takeable now.
    const [dead] = await h.db
      .select({ t: workerHeartbeats.lastTickAt })
      .from(workerHeartbeats)
      .where(eq(workerHeartbeats.workerId, "wh-dead-here"));
    expect(dead!.t.getTime()).toBe(0);

    // A live worker from before this change (no graphile ids): unclaimed locks are left alone.
    await heartbeatRow(h.db, {
      workerId: "wh-old-version",
      host: "other-host-2",
      pid: 43,
      startedAt: new Date(),
      ids: null,
    });
    await lockedJob(h.db, "wh.noop", {}, "wh:orphan-2", "gw-orphan-2", 300_000);
    const r2 = await unlockStaleGraphileJobs(h.db, {
      workerId: me.workerId,
      workerStartedAt: me.startedAt,
      ownGraphileIds: [],
    });
    expect(r2.unlocked).toEqual([]);
    expect(r2.skippedUnknown).toContain("gw-orphan-2");
    await h.db.delete(workerHeartbeats);
    await h.db.execute(sql`delete from graphile_worker._private_jobs`);
  });

  it("a restarted worker frees the killed worker's trial.execute, which re-attaches to the live runner (no second launch)", async () => {
    const seed = await seedRunWh(h.db);
    const fake = new FakeProvider({ name: "fake-wh-restart" });
    const registry = createComputerRegistry({
      provider: fake,
      store: drizzleComputerStore(h.db),
      pricing: { pricePerBlockMicroUsd: 27_600n },
    });
    const id = await trialWh(h.db, seed, { state: "running", startedAt: new Date() });
    const created = await registry.create({ runId: seed.runId, trialId: id, spec: {} });
    const info = await registry.waitReady(created.computerId);
    // The killed worker: its heartbeat (this host, a dead pid), its lease and its locked job.
    const deadStarted = new Date(Date.now() - 600_000);
    await heartbeatRow(h.db, {
      workerId: `${hostname()}:${DEAD_PID}`,
      host: hostname(),
      pid: DEAD_PID,
      startedAt: deadStarted,
      ids: ["gw-killed-trial"],
    });
    await h.db
      .update(trials)
      .set({
        computerId: created.computerId,
        leaseOwner: `${hostname()}:${DEAD_PID}~${deadStarted.getTime()}~abc`,
        leaseUntil: new Date(Date.now() + 3_600_000), // the runner kept extending it
      })
      .where(eq(trials.id, id));
    await lockedJob(
      h.db,
      "trial.execute",
      { trial_id: id },
      trialExecuteJobKey(id, 1),
      "gw-killed-trial",
      30_000,
    );
    // The detached runner is still going and has finished meanwhile.
    const now = new Date().toISOString();
    await fake.putFile(
      info.id,
      `${info.home}/eval/out/status.json`,
      JSON.stringify({
        trial_id: id,
        run_id: seed.runId,
        attempt: 1,
        runner_version: "fake",
        pid: 7,
        hostname: "fake",
        phase: "done",
        trial_state: "collecting",
        started_at: now,
        updated_at: now,
        heartbeat_at: now,
        phases: [],
        push: { mode: "file_only", sent_batches: 0, failed_posts: 0, last_error: null },
        events: { count: 0, bytes: 0 },
        run: { exit_code: 0, signal: null, duration_ms: 1, timed_out: false },
        upload: null,
        result: { outcome: "ok", reason: null, failure_class: null },
      }),
    );

    const execute = createTrialExecuteJob({
      provider: () => fake,
      breaker: () => null,
      source: () => ({
        prepare: async () => ({
          job: { driver: { type: "cli", run: "true" }, wall_clock_s: 30, heartbeat_s: 1 },
          computer: {},
          secrets: {},
        }),
      }),
      timing: { pollMs: 10, leaseRefreshMs: 50, staleMs: 5_000, startTimeoutMs: 5_000 },
    });
    worker = await startWorker({
      config: configTdm14(h.url),
      logger: silentLoggerTdm14(),
      sentry: recordingSentryTdm14(),
      jobs: [execute],
      workerId: "wh-restarted",
      pollIntervalMs: 100,
    });
    let state = "running";
    for (let i = 0; i < 200 && state !== "collecting"; i++) {
      await sleep(50);
      const [t] = await h.db.select().from(trials).where(eq(trials.id, id));
      state = t!.state;
    }
    expect(state).toBe("collecting");
    expect(fake.detached()).toHaveLength(0); // re-attached, never launched a second runner
    const [hb] = await h.db
      .select()
      .from(workerHeartbeats)
      .where(eq(workerHeartbeats.workerId, "wh-restarted"));
    expect(hb!.graphileWorkerIds!.length).toBeGreaterThanOrEqual(2); // control + trial runners
    await worker.stop();
    worker = undefined;
  }, 60_000);

  // ---------- 2. outage breaker ----------

  it("opens after 3 provider 500s, tells the live page, parks trials and gates without spending attempts, and the probe closes it", async () => {
    await h.db.delete(providerBreakers);
    const seed = await seedRunWh(h.db);
    const fake = new FakeProvider({ name: "fake-wh-outage" });
    const ctx: JobContext = {
      config: configTdm14(h.url),
      logger: silentLoggerTdm14(),
      db: h.db,
      sentry: recordingSentryTdm14(),
      workerId: "wh-outage-worker",
      workerStartedAt: new Date(),
    };
    const execute = createTrialExecuteJob({
      provider: () => fake,
      source: () => ({
        prepare: async () => ({
          job: { driver: { type: "cli", run: "true" }, wall_clock_s: 30, heartbeat_s: 1 },
          computer: {},
          secrets: {},
        }),
      }),
      timing: { pollMs: 10, leaseRefreshMs: 50, staleMs: 2_000, startTimeoutMs: 2_000 },
    });
    const ids = [await trialWh(h.db, seed), await trialWh(h.db, seed), await trialWh(h.db, seed)];
    for (let i = 0; i < 3; i++) fake.failNext("create", outage500());
    const added: { id: string; payload: unknown; spec: unknown }[] = [];
    for (const id of ids) {
      await execute.run(
        { trial_id: id, retry: false, keep_computer: false },
        ctx,
        helpersWh(added),
      );
    }
    const rows = await h.db.select().from(trials).where(eq(trials.runId, seed.runId));
    for (const t of rows) {
      expect(t).toMatchObject({ attempt: 1, state: "forking", computerId: null, outagePauses: 1 });
      expect(t.costMicroUsd).toBe(0n);
      expect(t.leaseOwner).toBeNull();
    }
    // Each parked trial re-enqueued itself under the same attempt's key.
    expect(added.map((a) => (a.spec as { jobKey: string }).jobKey).sort()).toEqual(
      ids.map((id) => trialExecuteJobKey(id, 1)).sort(),
    );
    const b = await readBreaker(h.db, "fake-wh-outage");
    expect(b.status).toBe("open");
    const outage = await h.db
      .select({ payload: eventsTable.payload })
      .from(eventsTable)
      .where(sql`${eventsTable.runId} = ${seed.runId} and ${eventsTable.type} = 'provider.outage'`);
    expect(outage).toHaveLength(1);
    expect(outage[0]!.payload).toMatchObject({
      status: "open",
      message: "fake-wh-outage is having an outage; trials paused, nothing billed",
    });

    // While open: a queued trial is not even leased; a gate does not run and spends nothing.
    const queued = await trialWh(h.db, seed);
    const addedQ: typeof added = [];
    await execute.run(
      { trial_id: queued, retry: false, keep_computer: false },
      ctx,
      helpersWh(addedQ),
    );
    const [q] = await h.db.select().from(trials).where(eq(trials.id, queued));
    expect(q).toMatchObject({ state: "queued", attempt: 1, leaseOwner: null });
    expect(addedQ).toHaveLength(1);
    let gateRan = false;
    const gate = createTrialGateJob({
      provider: () => fake,
      artifacts: () => ({ createDownload: async () => ({}) as never }),
      runGates: async () => {
        gateRan = true;
        throw new Error("should not run");
      },
    });
    const gated = await trialWh(h.db, seed, { state: "collecting" });
    const addedG: typeof added = [];
    await gate.run({ trial_id: gated, attempt: 1 }, ctx, helpersWh(addedG, 3));
    expect(gateRan).toBe(false);
    expect(addedG).toHaveLength(1);
    const [g] = await h.db.select().from(trials).where(eq(trials.id, gated));
    expect(g!.state).toBe("collecting");

    // Probe: a failing probe keeps it open; a passing one closes it and says so.
    await h.db
      .update(providerBreakers)
      .set({ nextProbeAt: new Date(Date.now() - 1) })
      .where(eq(providerBreakers.provider, "fake-wh-outage"));
    expect(
      await runBreakerProbe({
        db: h.db,
        provider: fake,
        probe: async () => {
          throw outage500();
        },
      }),
    ).toBe("failed");
    expect((await readBreaker(h.db, "fake-wh-outage")).status).toBe("open");
    await h.db
      .update(providerBreakers)
      .set({ nextProbeAt: new Date(Date.now() - 1) })
      .where(eq(providerBreakers.provider, "fake-wh-outage"));
    expect(await runBreakerProbe({ db: h.db, provider: fake })).toBe("passed"); // real list + create + destroy on the fake
    expect((await readBreaker(h.db, "fake-wh-outage")).status).toBe("closed");
    const closed = await h.db
      .select({ payload: eventsTable.payload })
      .from(eventsTable)
      .where(sql`${eventsTable.runId} = ${seed.runId} and ${eventsTable.type} = 'provider.outage'`);
    expect(closed.map((e) => (e.payload as { status: string }).status)).toEqual(["open", "closed"]);
    expect((await fake.list({ tag: "ab-infra-probe" })).length).toBe(0);

    // Resumed: the parked trials run to collecting on attempt 1, as if the outage never happened.
    const launches = fakeRunnerTdm49(fake);
    for (const id of ids) {
      await execute.run({ trial_id: id, retry: false, keep_computer: false }, ctx, helpersWh([]));
    }
    const after = await h.db.select().from(trials).where(eq(trials.runId, seed.runId));
    for (const t of after.filter((x) => ids.includes(x.id))) {
      expect(t).toMatchObject({ state: "collecting", attempt: 1, outagePauses: 1 });
    }
    expect(launches.map((l) => l.attempt)).toEqual([1, 1, 1]);
  }, 60_000);

  it("a gate that hits a provider 500 on its last attempt is re-enqueued fresh, not failed_infra", async () => {
    await h.db.delete(providerBreakers);
    const seed = await seedRunWh(h.db);
    await h.db.update(kits).set({ spec: gateKitSpecWh }).where(eq(kits.runId, seed.runId));
    const [kit] = await h.db.select().from(kits).where(eq(kits.runId, seed.runId));
    await h.db.update(runs).set({ kitId: kit!.id }).where(eq(runs.id, seed.runId));
    const fake = new FakeProvider({ name: "fake-wh-gate" });
    const ctx = {
      config: configTdm14(h.url),
      logger: silentLoggerTdm14(),
      db: h.db,
      sentry: recordingSentryTdm14(),
      workerId: "wh-gate-worker",
      workerStartedAt: new Date(),
    } as JobContext;
    let calls = 0;
    const gate = createTrialGateJob({
      provider: () => fake,
      artifacts: () => ({
        createDownload: async () => ({ url: "https://r2.test/out.tar.gz" }) as never,
      }),
      kitFiles: { scoringFiles: async () => [] },
      runGates: async () => {
        calls++;
        throw new GateInfraError("scoring computer could not be created", { cause: outage500() });
      },
    });
    const id = await trialWh(h.db, seed, { state: "collecting", workloadId: "add" });
    const added: { id: string; payload: unknown; spec: unknown }[] = [];
    // graphile attempt 3 of GATE_INFRA_MAX_ATTEMPTS: without the breaker this is failed_infra.
    await gate.run({ trial_id: id, attempt: 1 }, ctx, helpersWh(added, 3));
    expect(calls).toBe(1);
    const [t] = await h.db.select().from(trials).where(eq(trials.id, id));
    expect(t!.state).toBe("gating");
    expect(t!.attempt).toBe(1);
    expect(added).toMatchObject([
      { id: "trial.gate", payload: { trial_id: id, attempt: 1, outage_pauses: 1 } },
    ]);
    expect((await readBreaker(h.db, "fake-wh-gate")).failures).toBe(1);
  });

  // ---------- 3. operator settle ----------

  it("settles a run: unfinished trials cancelled (operator_settled, unbilled), computers destroyed, run.advance enqueued", async () => {
    const seed = await seedRunWh(h.db);
    const fake = new FakeProvider({ name: "fake-wh-settle" });
    const registry = createComputerRegistry({
      provider: fake,
      store: drizzleComputerStore(h.db),
      pricing: { pricePerBlockMicroUsd: 27_600n },
    });
    const done = await trialWh(h.db, seed, { state: "done", endedAt: new Date() });
    const running = await trialWh(h.db, seed, {
      state: "running",
      leaseOwner: "someone~1~x",
      leaseUntil: new Date(Date.now() + 60_000),
    });
    const retrying = await trialWh(h.db, seed, { state: "failed_infra", attempt: 2 });
    const queued = await trialWh(h.db, seed);
    const exhausted = await trialWh(h.db, seed, { state: "failed_infra", attempt: 3 });
    const c = await registry.create({ runId: seed.runId, trialId: running, spec: {} });
    await registry.waitReady(c.computerId);
    await h.db.update(trials).set({ computerId: c.computerId }).where(eq(trials.id, running));

    const out = await settleRun(h.db, seed.runId, {
      actor: { kind: "user", id: seed.ownerId },
      reason: "Naïve outage, stopping the rest",
      jobs: graphileJobQueue(),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.settled.map((s) => s.trial_id).sort()).toEqual([running, retrying, queued].sort());
    const rows = await h.db.select().from(trials).where(eq(trials.runId, seed.runId));
    const by = new Map(rows.map((r) => [r.id, r]));
    for (const id of [running, retrying, queued]) {
      expect(by.get(id)).toMatchObject({
        state: "cancelled",
        failureClass: OPERATOR_SETTLED_FAILURE_CLASS,
        leaseOwner: null,
        costMicroUsd: 0n,
      });
    }
    expect(by.get(done)!.state).toBe("done");
    expect(by.get(exhausted)!.state).toBe("failed_infra");
    const jobs = (await h.db.execute(
      sql`select t.identifier as task, j.key from graphile_worker._private_jobs j
          join graphile_worker._private_tasks t on t.id = j.task_id
          where j.key like ${`runs:${seed.runId}:%`}`,
    )) as unknown as { rows: { task: string; key: string }[] };
    expect(jobs.rows.map((r) => r.task).sort()).toEqual(["run.advance", "run.settle"]);

    // Idempotent: nothing more to settle.
    const again = await settleRun(h.db, seed.runId, {
      actor: { kind: "system" },
      jobs: graphileJobQueue(),
    });
    expect(again.ok && again.settled).toEqual([]);

    // run.settle destroys the settled trial's computer and wakes run.advance.
    const added: { id: string; payload: unknown; spec: unknown }[] = [];
    const ctx = {
      config: configTdm14(h.url),
      logger: silentLoggerTdm14(),
      db: h.db,
      sentry: recordingSentryTdm14(),
      workerId: "wh-settle-worker",
      workerStartedAt: new Date(),
    } as JobContext;
    await createRunSettleJob({ provider: () => fake, proxyKeys: () => null }).run(
      { run_id: seed.runId },
      ctx,
      helpersWh(added),
    );
    const [comp] = await h.db.select().from(computers).where(eq(computers.id, c.computerId));
    expect(comp!.status).toBe("destroyed");
    expect(await fake.list({})).toHaveLength(0);
    expect(added).toMatchObject([{ id: "run.advance", payload: { reason: "settled" } }]);

    // Billing (plan.md section 8): in the delivered run, the settled trial's computer bills nothing.
    const billingTrials = (
      await h.db.select().from(trials).where(eq(trials.runId, seed.runId))
    ).map((t) => ({ id: t.id, state: t.state, computerId: t.computerId }));
    const decision = computeDecision(
      {
        id: comp!.id,
        status: comp!.status,
        trialId: comp!.trialId,
        costMicroUsd: comp!.costMicroUsd,
      },
      "delivered",
      billingTrials,
    );
    expect(decision.billable).toBe(false);
  });

  it("POST /runs/:id/settle: the owner settles their run, a stranger gets 404, an admin settles any run", async () => {
    const seed = await seedRunWh(h.db);
    const stranger = await seedRunWh(h.db);
    const t1 = await trialWh(h.db, seed, { state: "running" });
    const config = loadConfig({
      DATABASE_URL: h.url,
      DATABASE_URL_DIRECT: h.url,
      LOG_LEVEL: "silent",
      PUBLIC_WEB_URL: "https://anybench.jaxonp.com",
      ALLOWED_ORIGINS: "https://anybench.jaxonp.com",
    });
    const deps: AppDeps & { jobs: ReturnType<typeof graphileJobQueue> } = {
      config,
      logger: silentLoggerTdm14(),
      db: h.db,
      sentry: recordingSentryTdm14(),
      // `Bearer admin:<id>` is an admin session; `Bearer <id>` a plain user.
      authenticate: async (req) => {
        const m = /^Bearer (admin:)?(.+)$/.exec(req.headers.get("authorization") ?? "");
        return m ? { kind: "user", userId: m[2]!, isAdmin: m[1] !== undefined } : null;
      },
      jobs: graphileJobQueue(),
    };
    const app = createApp(deps);
    const client = (token: string) =>
      createApiClient(
        "http://api.test",
        { kind: "apiKey", key: token },
        { fetch: (url, init) => Promise.resolve(app.request(url, init)) },
      );
    await expect(
      client(stranger.ownerId).runs.settle({ params: { id: seed.runId as never }, body: {} }),
    ).rejects.toMatchObject({ status: 404 });
    const own = await client(seed.ownerId).runs.settle({
      params: { id: seed.runId as never },
      body: { reason: "stopping the rest" },
    });
    expect(own.settled).toEqual([{ trial_id: t1, from: "running" }]);
    expect(own.run.id).toBe(seed.runId);

    const t2 = await trialWh(h.db, stranger, { state: "queued" });
    const byAdmin = await client(`admin:${seed.ownerId}`).runs.settle({
      params: { id: stranger.runId as never },
      body: {},
    });
    expect(byAdmin.settled).toEqual([{ trial_id: t2, from: "queued" }]);
    const ev = await h.db
      .select({ actor: eventsTable.actor, payload: eventsTable.payload })
      .from(eventsTable)
      .where(sql`${eventsTable.sourceId} = ${t2} and ${eventsTable.type} = 'trial.phase'`);
    expect(ev.at(-1)!.payload).toMatchObject({
      from: "queued",
      to: "cancelled",
      failure_class: OPERATOR_SETTLED_FAILURE_CLASS,
    });
  });
});
