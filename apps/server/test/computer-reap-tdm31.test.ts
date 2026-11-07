// TDM-31: computer.reap on FakeProvider + local Postgres. Orphans are destroyed with an event and
// an alert payload; a live trial's computer is never touched; destroy failures retry next tick.
import { createComputerRegistry, type ComputerRegistry } from "@anybench/envs";
import { FakeProvider, ProviderUnavailableError, trialTag } from "@anybench/providers";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { computers, contenders, kits, runs, trials, users } from "../src/db/schema/index.js";
import { newId, RunIdSchema, TRIAL_MAX_INFRA_RETRIES, TrialIdSchema } from "@anybench/core";
import {
  COMPUTER_REAP_INTERVAL_MS,
  computerReapJob,
  createComputerReapJob,
  reapComputers,
  trialHoldsComputer,
  type EventDraft,
  type EventsPort,
} from "../src/jobs/computer-reap.js";
import { JOBS } from "../src/jobs/index.js";
import type { JobContext } from "../src/jobs/types.js";
import { drizzleComputerStore } from "../src/lib/computer-store.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";
import { configTdm14, recordingSentryTdm14, silentLoggerTdm14 } from "./helpers/server-tdm14.js";

const available = await pgAvailableTdm11();
const MIN = 60_000;
const PRICE = 20_000n;

interface Seed {
  ownerId: string;
  runId: string;
  contenderId: string;
}

async function seedRunTdm31(
  db: Database,
  login: string,
  githubId: number,
  state: (typeof runs.$inferInsert)["state"] = "running",
): Promise<Seed> {
  const [u] = await db.insert(users).values({ githubLogin: login, githubId }).returning();
  const ownerId = u!.id;
  const [run] = await db
    .insert(runs)
    .values({ ownerId, question: "faster?", budgetMicroUsd: 5_000_000n, state })
    .returning();
  const [kit] = await db
    .insert(kits)
    .values({ ownerId, runId: run!.id, version: 1, spec: {}, hash: `h-${login}` })
    .returning();
  const [c] = await db
    .insert(contenders)
    .values({ runId: run!.id, kitId: kit!.id, source: "github", role: "subject" })
    .returning();
  return { ownerId, runId: run!.id, contenderId: c!.id };
}

let repeatSeq = 0;
async function trialTdm31(
  db: Database,
  s: Seed,
  state: (typeof trials.$inferInsert)["state"],
  extra: Partial<typeof trials.$inferInsert> = {},
) {
  const [t] = await db
    .insert(trials)
    .values({
      ownerId: s.ownerId,
      runId: s.runId,
      contenderId: s.contenderId,
      workloadId: "w1",
      repeat: repeatSeq++,
      state,
      ...extra,
    })
    .returning();
  return t!.id;
}

function recordingEventsTdm31(): EventsPort & {
  calls: { runId: string | null; events: EventDraft[] }[];
} {
  const calls: { runId: string | null; events: EventDraft[] }[] = [];
  return {
    calls,
    async append(_db, runId, events) {
      calls.push({ runId, events });
    },
  };
}

// Each test gets its own provider name: FakeProvider ids restart at fake_000001, and
// computers(provider, provider_id) is unique.
let providerSeq = 0;
function setupTdm31(h: FreshDbTdm11) {
  let t = Date.now();
  const clock = { now: () => new Date(t), nowMs: () => t, advance: (ms: number) => (t += ms) };
  const fake = new FakeProvider({ name: `fake${++providerSeq}`, now: clock.nowMs });
  const registry: ComputerRegistry = createComputerRegistry({
    provider: fake,
    store: drizzleComputerStore(h.db),
    pricing: { pricePerBlockMicroUsd: PRICE },
    now: clock.now,
  });
  const events = recordingEventsTdm31();
  const reap = () => reapComputers({ db: h.db, registries: [registry], events, now: clock.now });
  return { clock, fake, registry, events, reap };
}

async function rowTdm31(db: Database, id: string) {
  const [r] = await db.select().from(computers).where(eq(computers.id, id));
  return r!;
}

describe.skipIf(!available)("computer.reap (TDM-31, FakeProvider + local Postgres)", () => {
  let h: FreshDbTdm11;
  let seed: Seed;

  beforeAll(async () => {
    h = await freshMigratedDbTdm11({ max: 2 });
    seed = await seedRunTdm31(h.db, "reaper", 3101);
  }, 60_000);

  afterAll(async () => {
    await h?.drop();
  });

  it("is registered every 60 s under a single job key", () => {
    expect(JOBS).toContain(computerReapJob);
    expect(computerReapJob.name).toBe("computer.reap");
    expect(computerReapJob.everyMs).toBe(COMPUTER_REAP_INTERVAL_MS);
    expect(COMPUTER_REAP_INTERVAL_MS).toBe(60_000);
  });

  it("destroys an orphan idle > 15 min, emits computer.leaked and an alert payload", async () => {
    const { clock, fake, registry, events, reap } = setupTdm31(h);
    const trialId = await trialTdm31(h.db, seed, "done");
    const { computerId, info } = await registry.create({ runId: seed.runId, trialId });
    expect((await rowTdm31(h.db, computerId)).status).toBe("running");

    clock.advance(16 * MIN);
    const report = await reap();

    expect(report.checked).toBe(1);
    expect(report.reaped).toHaveLength(1);
    expect(report.reaped[0]).toMatchObject({
      computerId,
      providerId: info.id,
      runId: seed.runId,
      trialId,
      action: "destroyed",
      blocksBilled: 2,
      costMicroUsd: 2n * PRICE,
    });
    expect(await fake.list()).toEqual([]);

    const row = await rowTdm31(h.db, computerId);
    expect(row.status).toBe("destroyed");
    expect(row.destroyedAt).not.toBeNull();
    expect(row.blocksBilled).toBe(2);
    expect(row.costMicroUsd).toBe(40_000n);

    expect(events.calls).toHaveLength(1);
    expect(events.calls[0]!.runId).toBe(seed.runId);
    expect(events.calls[0]!.events).toEqual([
      expect.objectContaining({
        type: "computer.leaked",
        source: "computer",
        source_id: computerId,
        severity: "critical",
        payload: expect.objectContaining({
          provider: fake.name,
          action: "destroyed",
          last_trial_id: trialId,
        }),
      }),
    ]);
    const idle = (events.calls[0]!.events[0]!.payload as { idle_s: number }).idle_s;
    expect(idle).toBeGreaterThan(15 * 60);

    expect(report.alerts).toEqual([
      expect.objectContaining({
        ruleKey: "computer.leaked",
        scope: "computer",
        severity: "critical",
        fingerprint: `computer.leaked:${fake.name}:${info.id}`,
        runId: seed.runId,
        payload: expect.objectContaining({
          computer_id: computerId,
          action: "destroyed",
          cost_micro_usd: "40000",
        }),
      }),
    ]);
    // JSON-safe: ready to insert as alerts.payload.
    expect(() => JSON.stringify(report.alerts)).not.toThrow();
    expect(report.totalLeakedCostMicroUsd).toBe(40_000n);

    // Gone from the provider, so the next tick is quiet.
    const again = await reap();
    expect(again).toMatchObject({ checked: 0, reaped: [], failed: [], alerts: [] });
    expect(events.calls).toHaveLength(1);
  });

  it("never touches a live trial's computer, however old", async () => {
    const { clock, fake, registry, events, reap } = setupTdm31(h);
    const trialId = await trialTdm31(h.db, seed, "running");
    const { computerId, info } = await registry.create({ runId: seed.runId, trialId });
    await h.db.update(trials).set({ computerId }).where(eq(trials.id, trialId));

    clock.advance(3 * 60 * MIN);
    const report = await reap();

    expect(report).toMatchObject({ checked: 1, live: 1, reaped: [], failed: [], alerts: [] });
    expect((await fake.inspect(info.id)).status).toBe("running");
    expect((await rowTdm31(h.db, computerId)).status).toBe("running");
    expect(events.calls).toEqual([]);
    await registry.destroy(computerId);
  });

  it("leaves a recently active non-live computer for later", async () => {
    const { clock, fake, registry, reap } = setupTdm31(h);
    const trialId = await trialTdm31(h.db, seed, "done");
    const { computerId, info } = await registry.create({ runId: seed.runId, trialId });
    clock.advance(20 * MIN);
    await registry.touch(computerId); // e.g. the executor is still collecting logs
    clock.advance(5 * MIN);

    const report = await reap();
    expect(report).toMatchObject({ checked: 1, recent: 1, reaped: [] });
    expect((await fake.inspect(info.id)).status).toBe("running");

    clock.advance(11 * MIN);
    expect((await reap()).reaped).toHaveLength(1);
  });

  it("reaps a computer from an earlier attempt even while its trial is live again", async () => {
    const { clock, fake, registry, reap } = setupTdm31(h);
    const trialId = await trialTdm31(h.db, seed, "running");
    const old = await registry.create({ runId: seed.runId, trialId });
    const current = await registry.create({ runId: seed.runId, trialId });
    await h.db.update(trials).set({ computerId: current.computerId }).where(eq(trials.id, trialId));

    clock.advance(16 * MIN);
    const report = await reap();
    expect(report.reaped.map((l) => l.computerId)).toEqual([old.computerId]);
    expect(report.live).toBe(1);
    expect((await fake.inspect(current.info.id)).status).toBe("running");
    await registry.destroy(current.computerId);
  });

  it("adopts and destroys a tagged computer the registry never recorded", async () => {
    const { clock, fake, events, reap } = setupTdm31(h);
    const trialId = await trialTdm31(h.db, seed, "cancelled");
    const stray = await fake.create({ tags: [trialTag(seed.runId, trialId)] });
    await fake.create({ tags: ["not-ours"] }); // no ab- tag: not swept

    clock.advance(30 * MIN);
    const report = await reap();
    expect(report.checked).toBe(1);
    expect(report.reaped).toHaveLength(1);
    const leak = report.reaped[0]!;
    expect(leak).toMatchObject({ providerId: stray.id, runId: seed.runId, trialId });
    expect(leak.blocksBilled).toBe(3);
    const row = await rowTdm31(h.db, leak.computerId);
    expect(row).toMatchObject({ providerId: stray.id, status: "destroyed", blocksBilled: 3 });
    expect(events.calls.at(-1)!.events[0]).toMatchObject({ source_id: leak.computerId });
    expect(await fake.list({ tagPrefix: "ab-" })).toEqual([]);
  });

  it("a failed destroy is flagged, not thrown, and retried next tick", async () => {
    const { clock, fake, registry, events, reap } = setupTdm31(h);
    const trialId = await trialTdm31(h.db, seed, "done");
    const { computerId, info } = await registry.create({ runId: seed.runId, trialId });
    clock.advance(16 * MIN);

    fake.failNext("destroy", new ProviderUnavailableError("naive 503"));
    const first = await reap();
    expect(first.reaped).toEqual([]);
    expect(first.failed).toEqual([
      expect.objectContaining({ computerId, action: "flagged", error: "naive 503" }),
    ]);
    expect(first.alerts[0]).toMatchObject({ payload: { action: "flagged" } });
    expect((await rowTdm31(h.db, computerId)).status).toBe("leaked");
    expect((await fake.inspect(info.id)).status).toBe("running");
    expect(events.calls).toHaveLength(1);
    expect(events.calls[0]!.events[0]!.payload).toMatchObject({ action: "flagged" });

    // Still failing: same alert fingerprint, but no second flag event.
    fake.failNext("destroy", new ProviderUnavailableError("naive 503"));
    clock.advance(MIN);
    const second = await reap();
    expect(second.failed).toHaveLength(1);
    expect(second.alerts[0]!.fingerprint).toBe(first.alerts[0]!.fingerprint);
    expect(events.calls).toHaveLength(1);

    clock.advance(MIN);
    const third = await reap();
    expect(third.reaped).toEqual([expect.objectContaining({ computerId, action: "destroyed" })]);
    expect((await rowTdm31(h.db, computerId)).status).toBe("destroyed");
    expect(events.calls).toHaveLength(2);
    expect(events.calls[1]!.events[0]!.payload).toMatchObject({ action: "destroyed" });
  });

  it("never destroys an ab- computer it cannot prove is ours", async () => {
    const { clock, fake, events, reap } = setupTdm31(h);
    const a = await fake.create({ tags: ["ab-test"] });
    const b = await fake.create({ tags: ["ab-foo-bar"] });
    // A well-formed trial tag from another deployment: no row, no such trial in this DB.
    const c = await fake.create({
      tags: [trialTag(newId(RunIdSchema), newId(TrialIdSchema))],
    });
    // A real trial id but the wrong run: still not provably ours.
    const doneTrial = await trialTdm31(h.db, seed, "done");
    const d = await fake.create({ tags: [trialTag(newId(RunIdSchema), doneTrial)] });

    clock.advance(24 * 60 * MIN);
    const report = await reap();
    expect(report).toMatchObject({ checked: 4, foreign: 4, reaped: [], failed: [], alerts: [] });
    for (const x of [a, b, c, d]) expect((await fake.inspect(x.id)).status).toBe("running");
    expect(events.calls).toEqual([]);
    const rows = await h.db.select().from(computers).where(eq(computers.provider, fake.name));
    expect(rows).toEqual([]);
  });

  it("never touches ab-infra-* computers, even with an orphaned trial tag", async () => {
    const { clock, fake, reap } = setupTdm31(h);
    const trialId = await trialTdm31(h.db, seed, "done");
    const host = await fake.create({ tags: ["ab-infra-worker", trialTag(seed.runId, trialId)] });
    clock.advance(24 * 60 * MIN);
    const report = await reap();
    expect(report).toMatchObject({ checked: 1, infra: 1, reaped: [] });
    expect((await fake.inspect(host.id)).status).toBe("running");
  });

  it("packed blocks: another live trial with computer_id = this computer keeps it", async () => {
    const { clock, fake, registry, reap } = setupTdm31(h);
    const trialA = await trialTdm31(h.db, seed, "done");
    const { computerId, info } = await registry.create({ runId: seed.runId, trialId: trialA });
    await h.db.update(trials).set({ computerId }).where(eq(trials.id, trialA));
    await trialTdm31(h.db, seed, "running", { computerId });

    clock.advance(2 * 60 * MIN);
    const report = await reap();
    expect(report).toMatchObject({ checked: 1, live: 1, reaped: [] });
    expect((await fake.inspect(info.id)).status).toBe("running");
    await registry.destroy(computerId);
  });

  it("a trial still forking (computer_id not written yet) keeps its tagged computer", async () => {
    const { clock, fake, registry, reap } = setupTdm31(h);
    const trialId = await trialTdm31(h.db, seed, "forking");
    const { computerId, info } = await registry.create({ runId: seed.runId, trialId });
    clock.advance(60 * MIN);
    expect(await reap()).toMatchObject({ live: 1, reaped: [] });
    expect((await fake.inspect(info.id)).status).toBe("running");
    await registry.destroy(computerId);
  });

  it("held runs (needs_human, paused_budget) keep their trials' computers", async () => {
    const { clock, fake, registry, reap } = setupTdm31(h);
    const held = [
      await seedRunTdm31(h.db, "held-human", 3111, "needs_human"),
      await seedRunTdm31(h.db, "held-budget", 3112, "paused_budget"),
    ];
    const made = [];
    for (const s of held) {
      const trialId = await trialTdm31(h.db, s, "running");
      const r = await registry.create({ runId: s.runId, trialId });
      await h.db.update(trials).set({ computerId: r.computerId }).where(eq(trials.id, trialId));
      made.push(r);
    }
    clock.advance(3 * 60 * MIN);
    expect(await reap()).toMatchObject({ checked: 2, live: 2, reaped: [] });
    for (const r of made) expect((await fake.inspect(r.info.id)).status).toBe("running");
    for (const r of made) await registry.destroy(r.computerId);
  });

  it("a terminal run releases its non-terminal trial's computer", async () => {
    const { clock, registry, reap } = setupTdm31(h);
    const cancelled = await seedRunTdm31(h.db, "cancelled-run", 3113, "cancelled");
    const trialId = await trialTdm31(h.db, cancelled, "running");
    const { computerId } = await registry.create({ runId: cancelled.runId, trialId });
    await h.db.update(trials).set({ computerId }).where(eq(trials.id, trialId));
    clock.advance(16 * MIN);
    expect((await reap()).reaped.map((l) => l.computerId)).toEqual([computerId]);
  });

  it("failed_infra that can still retry keeps its computer", async () => {
    const { clock, fake, registry, reap } = setupTdm31(h);
    const trialId = await trialTdm31(h.db, seed, "failed_infra", { attempt: 1 });
    const { computerId, info } = await registry.create({ runId: seed.runId, trialId });
    await h.db.update(trials).set({ computerId }).where(eq(trials.id, trialId));
    clock.advance(60 * MIN);
    expect(await reap()).toMatchObject({ live: 1, reaped: [] });
    expect((await fake.inspect(info.id)).status).toBe("running");
    await registry.destroy(computerId);
  });

  it("trialHoldsComputer: failed_infra holds until retries run out; terminal states never do", () => {
    const runState = "running" as const;
    expect(trialHoldsComputer({ state: "failed_infra", attempt: 1, runState })).toBe(true);
    expect(
      trialHoldsComputer({ state: "failed_infra", attempt: TRIAL_MAX_INFRA_RETRIES, runState }),
    ).toBe(true);
    expect(
      trialHoldsComputer({
        state: "failed_infra",
        attempt: TRIAL_MAX_INFRA_RETRIES + 1,
        runState,
      }),
    ).toBe(false);
    for (const state of ["done", "failed_subject", "cancelled"] as const) {
      expect(trialHoldsComputer({ state, attempt: 1, runState })).toBe(false);
    }
    expect(trialHoldsComputer({ state: "running", attempt: 1, runState: "needs_human" })).toBe(
      true,
    );
    expect(trialHoldsComputer({ state: "running", attempt: 1, runState: "delivered" })).toBe(false);
  });

  it("a provider whose list fails is skipped; the sweep still completes", async () => {
    const { fake, reap } = setupTdm31(h);
    fake.failNext("list", new ProviderUnavailableError("down"));
    await expect(reap()).resolves.toMatchObject({ checked: 0 });
  });

  it("the job sweeps injected providers with the configured block price", async () => {
    let t = Date.now();
    const fake = new FakeProvider({ name: "fake-job", now: () => t });
    const events = recordingEventsTdm31();
    const job = createComputerReapJob({
      providers: () => [fake],
      events,
      now: () => new Date(t),
    });
    const config = configTdm14(h.url, { COMPUTER_BLOCK_PRICE_MICRO_USD: "7" });
    expect(config.COMPUTER_BLOCK_PRICE_MICRO_USD).toBe(7n);
    const ctx: JobContext = {
      config,
      logger: silentLoggerTdm14(),
      db: h.db,
      sentry: recordingSentryTdm14(),
      workerId: "test:1",
      workerStartedAt: new Date(),
    };
    const trialId = await trialTdm31(h.db, seed, "done");
    await fake.create({ tags: [trialTag(seed.runId, trialId)] });
    t += 16 * MIN;
    await job.run({}, ctx, undefined as never);
    expect(await fake.list()).toEqual([]);
    const ev = events.calls[0]!.events[0]!;
    expect(ev.actor).toEqual({ kind: "worker", id: "test:1" });
    const [row] = await h.db.select().from(computers).where(eq(computers.id, ev.source_id!));
    expect(row!.costMicroUsd).toBe(14n);
  });
});
