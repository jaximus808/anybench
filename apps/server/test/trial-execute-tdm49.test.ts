// TDM-49: trial.execute on FakeProvider + local Postgres: the Drizzle store's lease CAS (expiry and
// dead-owner takeover through worker_heartbeats), transitions from the DB state with their
// trial.phase events, runner edges, cancel/kill switches, the job end to end and trial.reattach.
import { newId, TrialIdSchema } from "@anybench/core";
import { leaseOwnerBase, type TransitionRequest } from "@anybench/bench";
import { FakeProvider } from "@anybench/providers";
import { eq, sql } from "drizzle-orm";
import type { JobHelpers } from "graphile-worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import {
  computers,
  contenders,
  events as eventsTable,
  killSwitches,
  kits,
  runs,
  trials,
  users,
  workerHeartbeats,
} from "../src/db/schema/index.js";
import { JOBS } from "../src/jobs/index.js";
import {
  createTrialExecuteJob,
  drizzleTrialExecStore,
  trialExecuteJob,
  trialExecuteJobKey,
  trialGateJobKey,
  trialGateStubJob,
  trialReattachJob,
  TRIAL_REATTACH_INTERVAL_MS,
} from "../src/jobs/trial-execute.js";
import type { JobContext } from "../src/jobs/types.js";
import { appendEvents } from "../src/lib/events.js";
import { verifyRunnerToken } from "../src/lib/runner-token.js";
import { fakeRunnerTdm49 } from "./helpers/fake-runner-tdm49.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";
import { configTdm14, recordingSentryTdm14, silentLoggerTdm14 } from "./helpers/server-tdm14.js";

const available = await pgAvailableTdm11();
const TOKEN_SECRET = "tdm49-runner-token-secret-0123456789abcdefgh";

interface SeedTdm49 {
  ownerId: string;
  runId: string;
  contenderId: string;
}

async function seedRunTdm49(db: Database, login: string, githubId: number): Promise<SeedTdm49> {
  const [u] = await db.insert(users).values({ githubLogin: login, githubId }).returning();
  const [run] = await db
    .insert(runs)
    .values({ ownerId: u!.id, question: "faster?", budgetMicroUsd: 5_000_000n, state: "running" })
    .returning();
  const [kit] = await db
    .insert(kits)
    .values({ ownerId: u!.id, runId: run!.id, version: 1, spec: {}, hash: `h-${login}` })
    .returning();
  const [c] = await db
    .insert(contenders)
    .values({ runId: run!.id, kitId: kit!.id, source: "github", role: "subject" })
    .returning();
  return { ownerId: u!.id, runId: run!.id, contenderId: c!.id };
}

let repeatSeq = 0;
async function trialTdm49(
  db: Database,
  s: SeedTdm49,
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
      repeat: repeatSeq++,
      ...extra,
    })
    .returning();
  return t!.id;
}

async function heartbeatTdm49(db: Database, workerId: string, startedAt: Date, ageMs: number) {
  await db
    .insert(workerHeartbeats)
    .values({
      workerId,
      host: "h",
      pid: 1,
      startedAt,
      lastTickAt: sql`now() - (${ageMs} * interval '1 millisecond')`,
      ticks: 1,
    })
    .onConflictDoUpdate({
      target: workerHeartbeats.workerId,
      set: { startedAt, lastTickAt: sql`now() - (${ageMs} * interval '1 millisecond')` },
    });
}

const req = (over: Partial<TransitionRequest>): TransitionRequest => ({
  command: { type: "advance" },
  expectAttempt: 1,
  emit: true,
  actor: { kind: "worker", id: "w" },
  at: new Date(),
  ...over,
});

describe.skipIf(!available)("trial.execute (TDM-49, FakeProvider + local Postgres)", () => {
  let h: FreshDbTdm11;
  let seed: SeedTdm49;

  beforeAll(async () => {
    h = await freshMigratedDbTdm11({ max: 4 });
    seed = await seedRunTdm49(h.db, "executor", 4901);
  }, 60_000);

  afterAll(async () => {
    await h?.drop();
  });

  it("registers trial.execute, trial.reattach (every 60 s) and the trial.gate stub", () => {
    expect(JOBS).toContain(trialExecuteJob);
    expect(JOBS).toContain(trialReattachJob);
    expect(JOBS).toContain(trialGateStubJob);
    expect(trialReattachJob.everyMs).toBe(TRIAL_REATTACH_INTERVAL_MS);
    expect(trialExecuteJobKey("t", 2)).toBe("trials:t:2");
    expect(trialGateJobKey("t", 2)).toBe("trials:t:2:gate");
  });

  it("lease CAS: a live holder blocks, an expired lease or a dead/restarted holder is takeable", async () => {
    const store = drizzleTrialExecStore(h.db);
    const id = await trialTdm49(h.db, seed);
    const started = new Date(Date.now() - 60_000);
    const a = `${leaseOwnerBase("wa", started)}~n1`;
    const b = `${leaseOwnerBase("wb", started)}~n2`;
    await heartbeatTdm49(h.db, "wa", started, 0);

    expect((await store.acquireLease(id, a, 60_000))?.lease_owner).toBe(a);
    expect(await store.acquireLease(id, b, 60_000)).toBeNull(); // wa alive, lease valid
    expect(await store.refreshLease(id, a, 60_000)).toBe(true);
    expect(await store.refreshLease(id, b, 60_000)).toBe(false);
    expect(await store.listOrphaned()).toEqual([]); // queued: not executing anyway

    // wa's heartbeat goes stale: takeable before the lease expires.
    await h.db.update(trials).set({ state: "running" }).where(eq(trials.id, id));
    await heartbeatTdm49(h.db, "wa", started, 120_000);
    expect((await store.listOrphaned()).map((o) => o.id)).toContain(id);
    expect((await store.acquireLease(id, b, 60_000))?.lease_owner).toBe(b);

    // A worker id restarted (new started_at): the old process's lease is dead even if wb ticks.
    await heartbeatTdm49(h.db, "wb", new Date(), 0);
    expect((await store.listOrphaned()).map((o) => o.id)).toContain(id);
    await store.releaseLease(id, b);
    expect((await store.get(id))?.lease_owner).toBeNull();

    // Expired lease with a live holder.
    await heartbeatTdm49(h.db, "wa", started, 0);
    await store.acquireLease(id, a, 1);
    await new Promise((r) => setTimeout(r, 20));
    expect((await store.acquireLease(id, b, 60_000))?.lease_owner).toBe(b);
  });

  it("transitions from the DB state with a trial.phase event, and never past attempt 3", async () => {
    const store = drizzleTrialExecStore(h.db);
    const id = await trialTdm49(h.db, seed, { state: "running" });
    const owner = "wx~1~n";
    await store.acquireLease(id, owner, 60_000);
    const out = await store.transition(id, owner, req({}));
    expect(out).toMatchObject({ ok: true, from: "running", to: "collecting" });
    const [ev] = await h.db
      .select()
      .from(eventsTable)
      .where(sql`${eventsTable.sourceId} = ${id} and ${eventsTable.type} = 'trial.phase'`);
    expect(ev!.payload).toMatchObject({ from: "running", to: "collecting", attempt: 1 });
    expect(JSON.parse(ev!.actor!)).toEqual({ kind: "worker", id: "w" });

    expect(await store.transition(id, "other", req({}))).toMatchObject({
      ok: false,
      reason: "lease_lost",
    });
    expect(
      await store.transition(id, owner, req({ command: { type: "fail_infra", reason: "x" } })),
    ).toMatchObject({ ok: true, to: "failed_infra" });
    const r1 = await store.transition(id, owner, req({ command: { type: "retry", attempt: 1 } }));
    expect(r1).toMatchObject({ ok: true, to: "queued", trial: { attempt: 2 } });

    const at3 = await trialTdm49(h.db, seed, { state: "failed_infra", attempt: 3 });
    await store.acquireLease(at3, owner, 60_000);
    const refused = await store.transition(
      at3,
      owner,
      req({ command: { type: "retry", attempt: 3 }, expectAttempt: 3 }),
    );
    expect(refused).toMatchObject({ ok: false, reason: "illegal" });
    expect((await store.get(at3))?.attempt).toBe(3);
  });

  it("reads runner edges for the current attempt only, from actor runner", async () => {
    const store = drizzleTrialExecStore(h.db);
    const id = await trialTdm49(h.db, seed, { state: "installing", attempt: 2 });
    const ev = (actor: object, attempt: number, from: string, to: string) => ({
      run_id: seed.runId,
      seq: 0,
      type: "trial.phase" as const,
      source: "trial" as const,
      source_id: id,
      severity: "info" as const,
      actor,
      at: new Date().toISOString(),
      payload: { from, to, attempt },
    });
    await appendEvents(
      h.db,
      seed.runId as never,
      [
        ev({ kind: "runner", id: "r" }, 1, "installing", "warming"),
        ev({ kind: "worker", id: "w" }, 2, "queued", "forking"),
        ev({ kind: "runner", id: "r" }, 2, "installing", "warming"),
      ] as never,
    );
    const t = (await store.get(id))!;
    expect(await store.runnerEdges(t)).toEqual([{ from: "installing", to: "warming" }]);
  });

  it("cancel state: cancel_requested_at, kill switches by run / user / global, ANYBENCH_PAUSE", async () => {
    const s2 = await seedRunTdm49(h.db, "cancel", 4902);
    const id = await trialTdm49(h.db, s2);
    const store = drizzleTrialExecStore(h.db);
    const t = (await store.get(id))!;
    expect(await store.cancelState(t)).toEqual({ cancelled: false });
    expect(await drizzleTrialExecStore(h.db, { paused: true }).cancelState(t)).toMatchObject({
      cancelled: true,
    });
    const [ks] = await h.db
      .insert(killSwitches)
      .values({ scope: "user", scopeId: s2.ownerId, reason: "abuse", setBy: "admin" })
      .returning();
    expect(await store.cancelState(t)).toEqual({
      cancelled: true,
      reason: "kill switch user: abuse",
    });
    await h.db
      .update(killSwitches)
      .set({ clearedAt: new Date() })
      .where(eq(killSwitches.id, ks!.id));
    await h.db.update(runs).set({ cancelRequestedAt: new Date() }).where(eq(runs.id, s2.runId));
    expect(await store.cancelState(t)).toEqual({ cancelled: true, reason: "run cancel requested" });
  });

  it("runs a trial end to end: computer linked at insert, token per attempt, gate enqueued", async () => {
    const fake = new FakeProvider({ name: "fake-tdm49-job" });
    const launches = fakeRunnerTdm49(fake);
    const id = await trialTdm49(h.db, seed);
    const config = configTdm14(h.url, {
      RUNNER_TOKEN_SECRET: TOKEN_SECRET,
      PUBLIC_API_URL: "https://api.anybench.test",
    });
    const ctx: JobContext = {
      config,
      logger: silentLoggerTdm14(),
      db: h.db,
      sentry: recordingSentryTdm14(),
      workerId: "tdm49-worker",
      workerStartedAt: new Date(),
    };
    const added: { id: string; payload: unknown; spec: unknown }[] = [];
    const helpers = {
      abortSignal: new AbortController().signal,
      addJob: async (taskId: string, payload: unknown, spec: unknown) => {
        added.push({ id: taskId, payload, spec });
        return {} as never;
      },
    } as unknown as JobHelpers;
    const job = createTrialExecuteJob({
      provider: () => fake,
      source: () => ({
        prepare: async () => ({
          job: { driver: { type: "cli", run: "true" }, wall_clock_s: 30, heartbeat_s: 1 },
          computer: {},
          secrets: { MODEL_KEY: "sk-tdm49-db-secret-value" },
        }),
      }),
      timing: { pollMs: 10, leaseRefreshMs: 50, staleMs: 2_000, startTimeoutMs: 2_000 },
    });

    await job.run({ trial_id: id, retry: false, keep_computer: false }, ctx, helpers);

    const [t] = await h.db.select().from(trials).where(eq(trials.id, id));
    expect(t!.state).toBe("collecting");
    expect(t!.leaseOwner).toBeNull();
    const [c] = await h.db.select().from(computers).where(eq(computers.id, t!.computerId!));
    expect(c).toMatchObject({ trialId: id, status: "destroyed", provider: "fake-tdm49-job" });
    expect(launches).toHaveLength(1);
    expect(verifyRunnerToken(TOKEN_SECRET, launches[0]!.token!, id, 1)).toBe(true);
    expect(added).toEqual([
      {
        id: "trial.gate",
        payload: { trial_id: id, attempt: 1 },
        spec: { jobKey: trialGateJobKey(id, 1) },
      },
    ]);
    for (const cmd of fake.commands())
      expect(cmd.command).not.toContain("sk-tdm49-db-secret-value");
    const phases = await h.db
      .select({ payload: eventsTable.payload })
      .from(eventsTable)
      .where(sql`${eventsTable.sourceId} = ${id} and ${eventsTable.type} = 'trial.phase'`)
      .orderBy(eventsTable.seq);
    expect(phases.map((p) => (p.payload as { to: string }).to)).toEqual([
      "forking",
      "installing",
      "warming",
      "running",
      "collecting",
    ]);
    const [hb] = await h.db
      .select()
      .from(workerHeartbeats)
      .where(eq(workerHeartbeats.workerId, "tdm49-worker"));
    expect(hb).toBeDefined();
  });

  it("schedules the next attempt at its backoff when a run hangs", async () => {
    const fake = new FakeProvider({ name: "fake-tdm49-retry" });
    fakeRunnerTdm49(fake, { hangOnAttempt: 1 });
    const id = await trialTdm49(h.db, seed);
    const ctx: JobContext = {
      config: configTdm14(h.url),
      logger: silentLoggerTdm14(),
      db: h.db,
      sentry: recordingSentryTdm14(),
      workerId: "tdm49-worker-r",
      workerStartedAt: new Date(),
    };
    const added: { id: string; payload: unknown; spec: { runAt?: Date; jobKey?: string } }[] = [];
    const helpers = {
      abortSignal: new AbortController().signal,
      addJob: async (taskId: string, payload: unknown, spec: { runAt?: Date; jobKey?: string }) => {
        added.push({ id: taskId, payload, spec });
        return {} as never;
      },
    } as unknown as JobHelpers;
    const job = createTrialExecuteJob({
      provider: () => fake,
      source: () => ({
        prepare: async () => ({
          job: { driver: { type: "cli", run: "true" }, wall_clock_s: 30, heartbeat_s: 1 },
          computer: {},
          secrets: {},
        }),
      }),
      // staleMs is how long status.json may stay unchanged before the runner counts as dead. The
      // fake runner heartbeats every 20 ms on this same event loop, so a 200 ms window flaked under
      // machine load (a stalled loop looked like a dead runner on attempt 2). 2 s keeps a ~100x
      // margin and still catches attempt 1's hang quickly.
      timing: { pollMs: 10, leaseRefreshMs: 50, staleMs: 2_000, startTimeoutMs: 10_000 },
    });
    const before = Date.now();
    await job.run({ trial_id: id, retry: false, keep_computer: false }, ctx, helpers);
    const [t] = await h.db.select().from(trials).where(eq(trials.id, id));
    expect(t).toMatchObject({
      state: "failed_infra",
      attempt: 1,
      failureClass: "heartbeat_lost",
      computerId: null,
    });
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      id: "trial.execute",
      payload: { trial_id: id, retry: true },
      spec: { jobKey: trialExecuteJobKey(id, 2) },
    });
    expect(added[0]!.spec.runAt!.getTime()).toBeGreaterThanOrEqual(before + 30_000);

    // The delayed retry: attempt 2 runs to collecting.
    await job.run({ trial_id: id, retry: true, keep_computer: false }, ctx, helpers);
    const [t2] = await h.db.select().from(trials).where(eq(trials.id, id));
    expect(
      t2,
      `attempt 2 ended ${t2?.state} (${t2?.failureClass ?? "no failure class"})`,
    ).toMatchObject({
      state: "collecting",
      attempt: 2,
    });
  });

  it("trial.reattach enqueues orphaned trials under their execute job key", async () => {
    const id = await trialTdm49(h.db, seed, {
      state: "running",
      leaseOwner: "ghost-worker~1~n",
      leaseUntil: new Date(Date.now() + 3_600_000), // the runner kept extending it
    });
    const added: { id: string; payload: unknown; spec: unknown }[] = [];
    const helpers = {
      addJob: async (taskId: string, payload: unknown, spec: unknown) => {
        added.push({ id: taskId, payload, spec });
        return {} as never;
      },
    } as unknown as JobHelpers;
    const ctx = {
      config: configTdm14(h.url),
      logger: silentLoggerTdm14(),
      db: h.db,
    } as unknown as JobContext;
    await trialReattachJob.run({}, ctx, helpers);
    expect(added).toContainEqual({
      id: "trial.execute",
      payload: { trial_id: id },
      spec: { jobKey: trialExecuteJobKey(id, 1) },
    });
  });
});
