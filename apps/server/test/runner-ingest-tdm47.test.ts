// TDM-47: runner ingest routes against a fresh local Postgres, the real TDM-72 event writer
// (plus a counting/failing wrapper around it) and a fake ArtifactStore. Covers auth (401s), idempotency (409, no double write, rollback on failure),
// heartbeat lease extension and log offsets, the real TDM-10 runner batch fixture, and the upload
// plan + complete round trip.
import { readFileSync } from "node:fs";
import { apiRoutes, newId, parseRouteRequest, TrialIdSchema } from "@anybench/core";
import {
  ArtifactTransferError,
  MULTIPART_THRESHOLD_BYTES,
  planParts,
  trialArtifactKey,
  type UploadPlan,
} from "@anybench/envs";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  contenders,
  events,
  kits,
  runs,
  trials,
  users,
  webhookInbox,
} from "../src/db/schema/index.js";
import { appendEvents } from "../src/lib/events.js";
import { mintRunnerToken } from "../src/lib/runner-token.js";
import type { EventsWriter, TrialArtifactStore } from "../src/routes/runner.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";
import { configTdm14, recordingSentryTdm14, silentLoggerTdm14 } from "./helpers/server-tdm14.js";

const FIXTURE = JSON.parse(
  readFileSync(
    new URL("../../../packages/core/test/fixtures/runner-batch-tdm10.json", import.meta.url),
    "utf8",
  ),
) as {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> & { status: Record<string, unknown> };
};

const SECRET = "tdm47-ingest-secret-0123456789abcdef-0123456789";
const FIXTURE_TRIAL = "0197a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const FIXTURE_RUN = "0197a1b2-c3d4-7e5f-8a9b-1c1d2e3f4a5c";
const SHA = "a".repeat(64);

describe("runner batch fixture (TDM-47, no DB)", () => {
  it("the real TDM-10 runner batch parses against apiRoutes.runner.ingest", () => {
    const path = new URL(FIXTURE.url).pathname;
    expect(path).toBe(`/v1/trials/${FIXTURE_TRIAL}/events`);
    const parsed = parseRouteRequest(apiRoutes.runner.ingest, {
      params: { id: FIXTURE_TRIAL },
      headers: FIXTURE.headers,
      body: FIXTURE.body,
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.request.body.events.map((e) => e.type)).toEqual([
        "trial.phase",
        "trial.heartbeat",
      ]);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Fakes

/** The real appendEvents, wrapped to count calls and to fail after writing (rollback test). */
function fakeEventsTdm47(): EventsWriter & { calls: number; failNext: boolean } {
  const w = {
    calls: 0,
    failNext: false,
    async append(...args: Parameters<EventsWriter["append"]>) {
      w.calls++;
      const out = await appendEvents(...args);
      if (w.failNext) {
        w.failNext = false;
        throw new Error("event writer blew up after writing (tdm47)");
      }
      return out;
    },
  };
  return w;
}

/** Fake ArtifactStore: plans like the real one (single ≤ 100 MiB, else multipart), stores in memory. */
function fakeStoreTdm47(): TrialArtifactStore & {
  objects: Map<string, { sizeBytes: number; sha256: string }>;
  created: UploadPlan[];
  completed: UploadPlan[];
} {
  const objects = new Map<string, { sizeBytes: number; sha256: string }>();
  const created: UploadPlan[] = [];
  const completed: UploadPlan[] = [];
  return {
    objects,
    created,
    completed,
    async createUpload(input) {
      if (input.sizeBytes > input.maxBytes) {
        throw new ArtifactTransferError("too_large", `${input.name} is over the cap`);
      }
      const key = trialArtifactKey(input.runId, input.trialId, input.name);
      const base = {
        key,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256,
        maxBytes: input.maxBytes,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      };
      const plan: UploadPlan =
        input.sizeBytes <= MULTIPART_THRESHOLD_BYTES
          ? {
              kind: "single",
              ...base,
              method: "PUT",
              url: `http://fake-store.test/${key}`,
              headers: {},
            }
          : {
              kind: "multipart",
              ...base,
              uploadId: `up-${created.length}`,
              partSizeBytes: planParts(input.sizeBytes)[0]!.sizeBytes,
              parts: planParts(input.sizeBytes).map((p) => ({
                ...p,
                url: `http://fake-store.test/${key}?part=${p.partNumber}`,
                headers: {},
              })),
            };
      created.push(plan);
      return plan;
    },
    async completeUpload(plan) {
      completed.push(plan);
      const obj = objects.get(plan.key);
      if (!obj) throw new ArtifactTransferError("not_found", `${plan.key} was not uploaded`);
      if (obj.sizeBytes !== plan.sizeBytes || obj.sha256 !== plan.sha256) {
        throw new ArtifactTransferError("size_mismatch", `${plan.key} differs from the plan`);
      }
      return { key: plan.key, ...obj };
    },
  };
}

// ---------------------------------------------------------------------------------------------

const available = await pgAvailableTdm11();

describe.skipIf(!available)("runner ingest routes (TDM-47, local Postgres)", () => {
  let h: FreshDbTdm11;
  let ownerId: string;
  let contenderId: string;
  const writer = fakeEventsTdm47();
  const store = fakeStoreTdm47();
  /** Default wiring: the real appendEvents. */
  let app: ReturnType<typeof createApp>;
  /** Same app with the counting/failing writer injected. */
  let fakeApp: ReturnType<typeof createApp>;
  let repeat = 0;

  async function seedTrial(
    values: Partial<typeof trials.$inferInsert> = {},
  ): Promise<{ id: string; attempt: number }> {
    const [t] = await h.db
      .insert(trials)
      .values({
        id: newId(TrialIdSchema),
        ownerId,
        runId: FIXTURE_RUN,
        contenderId,
        workloadId: "w-tdm47",
        repeat: repeat++,
        state: "running",
        leaseOwner: "worker-tdm47",
        leaseUntil: new Date(Date.now() + 5_000),
        ...values,
      })
      .returning();
    return { id: t!.id, attempt: t!.attempt };
  }

  function heartbeat(trialId: string, seq: number, logOffset: number) {
    return {
      run_id: FIXTURE_RUN,
      seq,
      source_id: trialId,
      severity: "info",
      actor: { kind: "runner", id: "runner-tdm47" },
      cost_delta_micro_usd: "0",
      at: new Date().toISOString(),
      type: "trial.heartbeat",
      source: "trial",
      payload: {
        phase: "running",
        lease_owner: "runner-tdm47",
        lease_until: new Date().toISOString(),
        log_offset: logOffset,
      },
    };
  }

  function post(
    path: string,
    body: unknown,
    opts: { token?: string | null; key?: string; via?: ReturnType<typeof createApp> } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.key) headers["idempotency-key"] = opts.key;
    return Promise.resolve(
      (opts.via ?? app).request(path, { method: "POST", headers, body: JSON.stringify(body) }),
    );
  }

  function postBatch(
    trialId: string,
    attempt: number,
    batchSeq: number,
    evs: unknown[],
    token: string | null = mintRunnerToken(SECRET, trialId, attempt),
    via?: ReturnType<typeof createApp>,
  ) {
    const body = {
      trial_id: trialId,
      attempt,
      batch_seq: batchSeq,
      events: evs,
      status: { ...FIXTURE.body.status, trial_id: trialId, attempt },
    };
    return post(`/v1/trials/${trialId}/events`, body, {
      token,
      key: `${trialId}:${attempt}:${batchSeq}`,
      ...(via ? { via } : {}),
    });
  }

  async function eventCount(trialId: string): Promise<number> {
    const rows = await h.db
      .select({ n: sql<number>`count(*)::int` })
      .from(events)
      .where(eq(events.sourceId, trialId));
    return rows[0]!.n;
  }

  async function trialRow(id: string) {
    const [t] = await h.db.select().from(trials).where(eq(trials.id, id));
    return t!;
  }

  beforeAll(async () => {
    h = await freshMigratedDbTdm11({ max: 4 });
    const [u] = await h.db
      .insert(users)
      .values({ githubLogin: "tdm47", githubId: 4747 })
      .returning();
    ownerId = u!.id;
    await h.db.insert(runs).values({
      id: FIXTURE_RUN,
      ownerId,
      question: "tdm47?",
      budgetMicroUsd: 1_000_000n,
    });
    const [kit] = await h.db
      .insert(kits)
      .values({
        ownerId,
        runId: FIXTURE_RUN,
        version: 1,
        spec: { transfer: { max_mb: 300 } },
        hash: "h-tdm47",
      })
      .returning();
    await h.db.update(runs).set({ kitId: kit!.id }).where(eq(runs.id, FIXTURE_RUN));
    const [c] = await h.db
      .insert(contenders)
      .values({ runId: FIXTURE_RUN, kitId: kit!.id, source: "github", role: "subject" })
      .returning();
    contenderId = c!.id;
    const deps = {
      config: configTdm14(h.url, { RUNNER_TOKEN_SECRET: SECRET }),
      logger: silentLoggerTdm14(),
      db: h.db,
      sentry: recordingSentryTdm14(),
      artifacts: store,
    };
    app = createApp(deps);
    fakeApp = createApp({ ...deps, events: writer });
  }, 60_000);

  afterAll(async () => {
    await h?.drop();
  });

  it("accepts the real runner batch fixture, extends the lease and records the log offset", async () => {
    await seedTrial({ id: FIXTURE_TRIAL });
    const before = await trialRow(FIXTURE_TRIAL);
    const res = await post(`/v1/trials/${FIXTURE_TRIAL}/events`, FIXTURE.body, {
      token: mintRunnerToken(SECRET, FIXTURE_TRIAL, 1),
      key: FIXTURE.headers["idempotency-key"],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 2 });
    expect(await eventCount(FIXTURE_TRIAL)).toBe(2);
    // appendEvents assigned run-wide seqs (the runner's per-attempt seq 0, 1 is not kept).
    const seqs = await h.db
      .select({ seq: events.seq, type: events.type })
      .from(events)
      .where(eq(events.sourceId, FIXTURE_TRIAL))
      .orderBy(events.seq);
    expect(seqs.map((r) => r.type)).toEqual(["trial.phase", "trial.heartbeat"]);
    expect(seqs[1]!.seq).toBe(seqs[0]!.seq + 1);
    expect(seqs[0]!.seq).toBeGreaterThanOrEqual(1);

    const after = await trialRow(FIXTURE_TRIAL);
    expect(after.leaseUntil!.getTime()).toBeGreaterThan(before.leaseUntil!.getTime() + 60_000);
    expect(after.leaseUntil!.getTime()).toBeGreaterThan(Date.now() + 80_000);
    expect(after.logOffset).toBe(128);
    expect(after.state).toBe("running"); // edges are events only; the executor applies them

    const [inbox] = await h.db
      .select()
      .from(webhookInbox)
      .where(
        and(
          eq(webhookInbox.provider, "runner"),
          eq(webhookInbox.eventId, FIXTURE.headers["idempotency-key"]!),
        ),
      );
    expect(inbox!.processedAt).not.toBeNull();
    expect(inbox!.payload).toMatchObject({ event_count: 2, events_bytes: 600, phase: "run" });
  });

  it("a duplicate batch is a 409 and is not written twice", async () => {
    const t = await seedTrial();
    const evs = [heartbeat(t.id, 0, 10), heartbeat(t.id, 1, 20)];
    expect((await postBatch(t.id, 1, 0, evs, undefined, fakeApp)).status).toBe(200);
    const callsAfterFirst = writer.calls;
    expect(callsAfterFirst).toBeGreaterThan(0);
    const dup = await postBatch(t.id, 1, 0, evs, undefined, fakeApp);
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ error: { code: "conflict" } });
    expect(writer.calls).toBe(callsAfterFirst);
    expect(await eventCount(t.id)).toBe(2);
    // The next batch_seq is new work.
    expect((await postBatch(t.id, 1, 1, [heartbeat(t.id, 2, 30)])).status).toBe(200);
    expect(await eventCount(t.id)).toBe(3);
    expect((await trialRow(t.id)).logOffset).toBe(30);
  });

  it("a batch whose write fails leaves nothing behind and can be retried", async () => {
    const t = await seedTrial();
    writer.failNext = true;
    const before = await trialRow(t.id);
    const failed = await postBatch(t.id, 1, 0, [heartbeat(t.id, 0, 5)], undefined, fakeApp);
    expect(failed.status).toBe(500);
    expect(await eventCount(t.id)).toBe(0);
    // The lease/offset update rolled back with the events.
    const rolledBack = await trialRow(t.id);
    expect(rolledBack.logOffset).toBe(0);
    expect(rolledBack.leaseUntil!.getTime()).toBe(before.leaseUntil!.getTime());
    const retry = await postBatch(t.id, 1, 0, [heartbeat(t.id, 0, 5)]);
    expect(retry.status).toBe(200);
    expect(await eventCount(t.id)).toBe(1);
  });

  it("401 for a missing, wrong, other-trial or other-secret token, and for an unknown trial", async () => {
    const t = await seedTrial();
    const other = await seedTrial();
    const hb = [heartbeat(t.id, 0, 1)];
    expect((await postBatch(t.id, 1, 0, hb, null)).status).toBe(401);
    expect((await postBatch(t.id, 1, 0, hb, "abrt1.not-a-real-token")).status).toBe(401);
    expect((await postBatch(t.id, 1, 0, hb, mintRunnerToken(SECRET, other.id, 1))).status).toBe(
      401,
    );
    const wrongSecret = mintRunnerToken(`${SECRET}-other`, t.id, 1);
    const res = await postBatch(t.id, 1, 0, hb, wrongSecret);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "unauthorized" } });
    const ghost = newId(TrialIdSchema);
    expect((await postBatch(ghost, 1, 0, [], mintRunnerToken(SECRET, ghost, 1))).status).toBe(401);
    expect(await eventCount(t.id)).toBe(0);
    expect((await trialRow(t.id)).logOffset).toBe(0);
  });

  it("401 once the token has expired: superseded attempt, or trial ended past the grace", async () => {
    const t = await seedTrial();
    const oldToken = mintRunnerToken(SECRET, t.id, 1);
    await h.db.update(trials).set({ attempt: 2 }).where(eq(trials.id, t.id));
    expect((await postBatch(t.id, 1, 0, [heartbeat(t.id, 0, 1)], oldToken)).status).toBe(401);
    // The new attempt's token works, but not to post as attempt 1.
    expect((await postBatch(t.id, 1, 0, [], mintRunnerToken(SECRET, t.id, 2))).status).toBe(401);
    expect((await postBatch(t.id, 2, 0, [heartbeat(t.id, 0, 1)])).status).toBe(200);

    const ended = await seedTrial({
      state: "failed_subject",
      endedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const res = await postBatch(ended.id, 1, 0, [heartbeat(ended.id, 0, 1)]);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/expired/);
    // Within the grace window a final in-flight batch still lands.
    const justEnded = await seedTrial({ state: "failed_subject", endedAt: new Date() });
    expect((await postBatch(justEnded.id, 1, 0, [heartbeat(justEnded.id, 0, 1)])).status).toBe(200);
  });

  /** A schema-valid event of any type, as a hostile runner could forge it. */
  function forged(trialId: string, type: string, source: string, payload: object, extra = {}) {
    return { ...heartbeat(trialId, 0, 1), type, source, payload, ...extra };
  }

  async function rejected(trialId: string, evs: unknown[], pattern: RegExp) {
    const res = await postBatch(trialId, 1, 0, evs);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; issues?: string[] } };
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.issues?.join("\n")).toMatch(pattern);
    expect(await eventCount(trialId)).toBe(0);
    // Nothing was recorded either, so the same batch_seq stays free.
    const inbox = await h.db
      .select()
      .from(webhookInbox)
      .where(eq(webhookInbox.eventId, `${trialId}:1:0`));
    expect(inbox).toHaveLength(0);
  }

  it("a runner cannot forge non-runner event types (computer.*, run.*)", async () => {
    const t = await seedTrial();
    await rejected(
      t.id,
      [heartbeat(t.id, 0, 1), forged(t.id, "computer.created", "computer", { provider: "x" })],
      /body\.events\.1: type computer\.created cannot come from a runner/,
    );
    await rejected(
      t.id,
      [forged(t.id, "run.state_changed", "run", { from: "running", to: "scoring" })],
      /body\.events\.0: type run\.state_changed/,
    );
  });

  it("a runner cannot forge a gate result", async () => {
    const t = await seedTrial();
    await rejected(
      t.id,
      [forged(t.id, "trial.gate", "trial", { gate: "hidden-tests", passed: true })],
      /body\.events\.0: type trial\.gate cannot come from a runner/,
    );
  });

  it("a runner cannot write events about a sibling trial (source_id)", async () => {
    const t = await seedTrial();
    const sibling = await seedTrial();
    await rejected(
      t.id,
      [heartbeat(sibling.id, 0, 1)],
      /body\.events\.0: source_id must be this trial's id/,
    );
    expect(await eventCount(sibling.id)).toBe(0);
  });

  it("a runner cannot claim another actor", async () => {
    const t = await seedTrial();
    await rejected(
      t.id,
      [{ ...heartbeat(t.id, 0, 1), actor: { kind: "worker", id: "worker-tdm47" } }],
      /body\.events\.0: actor\.kind must be runner/,
    );
    await rejected(
      t.id,
      [{ ...heartbeat(t.id, 0, 1), actor: { kind: "system" } }],
      /actor\.kind must be runner, got system/,
    );
  });

  it("a runner cannot move money (nonzero or negative cost_delta_micro_usd)", async () => {
    const t = await seedTrial();
    for (const cost of ["5000000", "-1"]) {
      await rejected(
        t.id,
        [{ ...heartbeat(t.id, 0, 1), cost_delta_micro_usd: cost }],
        /body\.events\.0: cost_delta_micro_usd must be 0/,
      );
    }
  });

  it("a runner cannot report the worker's phase edges (gating, reviewing, done)", async () => {
    const t = await seedTrial();
    for (const [from, to] of [
      ["collecting", "gating"],
      ["gating", "reviewing"],
      ["reviewing", "done"],
    ] as const) {
      await rejected(
        t.id,
        [forged(t.id, "trial.phase", "trial", { from, to, attempt: 1 })],
        new RegExp(`trial\\.phase to ${to} is not a runner edge`),
      );
    }
    // The runner's own edges are fine.
    const ok = await postBatch(t.id, 1, 0, [
      forged(t.id, "trial.phase", "trial", { from: "running", to: "collecting", attempt: 1 }),
      forged(t.id, "trial.phase", "trial", {
        from: "collecting",
        to: "failed_subject",
        attempt: 1,
      }),
    ]);
    expect(ok.status).toBe(200);
  });

  it("trial.log_chunk url must be artifact:<key> under this trial's own prefix", async () => {
    const t = await seedTrial();
    const sibling = await seedTrial();
    const chunk = (url: string) =>
      forged(t.id, "trial.log_chunk", "trial", { stream: "stdout", offset: 0, bytes: 10, url });
    for (const url of [
      "javascript:alert(1)",
      "https://evil.example/x",
      `artifact:runs/${FIXTURE_RUN}/trials/${sibling.id}/logs/a`,
      `artifact:runs/${FIXTURE_RUN}/trials/${t.id}/../${sibling.id}/logs/a`,
      `artifact:runs/${FIXTURE_RUN}/trials/${t.id}/`,
    ]) {
      await rejected(
        t.id,
        [chunk(url)],
        /body\.events\.0: trial\.log_chunk url must be artifact:<key> under this trial/,
      );
    }
    // The runner's real reference (artifactUrl(plan.key)) is accepted.
    const ok = await postBatch(t.id, 1, 0, [
      chunk(`artifact:runs/${FIXTURE_RUN}/trials/${t.id}/logs/stdout.000001.log`),
    ]);
    expect(ok.status).toBe(200);
    expect(await eventCount(t.id)).toBe(1);
  });

  it("trial.phase attempt must be the token's attempt", async () => {
    const t = await seedTrial();
    await rejected(
      t.id,
      [forged(t.id, "trial.phase", "trial", { from: "running", to: "collecting", attempt: 7 })],
      /body\.events\.0: trial\.phase attempt must be 1, got 7/,
    );
  });

  it("400 for more than 1000 events in one batch, 413 over the body limits", async () => {
    const t = await seedTrial();
    const many = Array.from({ length: 1001 }, (_, i) => heartbeat(t.id, i, i));
    await rejected(t.id, many, /at most 1000 events/);

    const token = mintRunnerToken(SECRET, t.id, 1);
    const huge = {
      trial_id: t.id,
      attempt: 1,
      batch_seq: 0,
      events: [],
      status: null,
      pad: "x".repeat(2 * 1024 * 1024 + 1),
    };
    const big = await post(`/v1/trials/${t.id}/events`, huge, { token, key: `${t.id}:1:0` });
    expect(big.status).toBe(413);
    expect(await big.json()).toMatchObject({ error: { code: "bad_request" } });
    for (const path of ["uploads", "uploads/complete"]) {
      const res = await post(
        `/v1/trials/${t.id}/${path}`,
        { attempt: 1, name: "a.bin", size_bytes: 1, sha256: SHA, pad: "x".repeat(64 * 1024) },
        { token },
      );
      expect(res.status).toBe(413);
    }
    // A full real-size batch (1000 heartbeats + status) is well under the limit.
    const full = Array.from({ length: 1000 }, (_, i) => heartbeat(t.id, i, i));
    expect(JSON.stringify(full).length).toBeLessThan(1024 * 1024);
    expect((await postBatch(t.id, 1, 0, full)).status).toBe(200);
  });

  it("heartbeat extends lease_until only for a leased trial and never moves it back", async () => {
    const far = new Date(Date.now() + 10 * 60 * 1000);
    const longLease = await seedTrial({ leaseUntil: far });
    expect((await postBatch(longLease.id, 1, 0, [heartbeat(longLease.id, 0, 7)])).status).toBe(200);
    expect((await trialRow(longLease.id)).leaseUntil!.getTime()).toBe(far.getTime());

    const unleased = await seedTrial({ leaseOwner: null, leaseUntil: null });
    expect((await postBatch(unleased.id, 1, 0, [heartbeat(unleased.id, 0, 7)])).status).toBe(200);
    expect((await trialRow(unleased.id)).leaseUntil).toBeNull();

    // A batch without a heartbeat (status only) does not touch the lease.
    const t = await seedTrial();
    const before = (await trialRow(t.id)).leaseUntil!.getTime();
    expect((await postBatch(t.id, 1, 0, [])).status).toBe(200);
    expect((await trialRow(t.id)).leaseUntil!.getTime()).toBe(before);
  });

  it("400 when the idempotency key, trial id or event run_id do not match", async () => {
    const t = await seedTrial();
    const token = mintRunnerToken(SECRET, t.id, 1);
    const body = {
      trial_id: t.id,
      attempt: 1,
      batch_seq: 0,
      events: [heartbeat(t.id, 0, 1)],
      status: null,
    };
    const path = `/v1/trials/${t.id}/events`;
    expect((await post(path, body, { token, key: `${t.id}:1:9` })).status).toBe(400);
    expect((await post(path, body, { token })).status).toBe(400); // header required
    const foreign = {
      ...body,
      events: [{ ...heartbeat(t.id, 0, 1), run_id: newId(TrialIdSchema) }],
    };
    expect((await post(path, foreign, { token, key: `${t.id}:1:0` })).status).toBe(400);
    expect(await eventCount(t.id)).toBe(0);
  });

  it("redacts the runner token from payloads and reports a cancel request", async () => {
    const t = await seedTrial();
    const token = mintRunnerToken(SECRET, t.id, 1);
    await h.db.update(runs).set({ cancelRequestedAt: new Date() }).where(eq(runs.id, FIXTURE_RUN));
    try {
      const leak = {
        ...heartbeat(t.id, 0, 1),
        type: "trial.phase",
        payload: { from: "running", to: "collecting", attempt: 1, reason: `oops ${token}` },
      };
      const res = await postBatch(t.id, 1, 0, [leak], token);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ accepted: 1, cancel_requested: true });
      const [row] = await h.db.select().from(events).where(eq(events.sourceId, t.id));
      expect(JSON.stringify(row!.payload)).not.toContain(token);
      expect(JSON.stringify(row!.payload)).toContain("[REDACTED:RUNNER_TOKEN]");
    } finally {
      await h.db.update(runs).set({ cancelRequestedAt: null }).where(eq(runs.id, FIXTURE_RUN));
    }
  });

  it("upload plan + complete round trip (single and multipart) against the fake store", async () => {
    const t = await seedTrial();
    const token = mintRunnerToken(SECRET, t.id, 1);
    for (const [name, size] of [
      ["bundle.tar.zst", 4096],
      ["logs/stdout.log", MULTIPART_THRESHOLD_BYTES + 33 * 1024 * 1024],
    ] as const) {
      const planRes = await post(
        `/v1/trials/${t.id}/uploads`,
        { attempt: 1, name, size_bytes: size, sha256: SHA },
        { token },
      );
      expect(planRes.status).toBe(200);
      const { plan } = apiRoutes.runner.uploads.response.parse(await planRes.json());
      const key = `runs/${FIXTURE_RUN}/trials/${t.id}/${name}`;
      expect(plan.key).toBe(key);
      expect(plan.maxBytes).toBe(300 * 1024 * 1024); // the kit's transfer.max_mb

      // "Upload" it, then complete.
      store.objects.set(key, { sizeBytes: size, sha256: SHA });
      const done = await post(
        `/v1/trials/${t.id}/uploads/complete`,
        {
          attempt: 1,
          name,
          key,
          sha256: SHA,
          size_bytes: size,
          ...(plan.kind === "multipart" ? { upload_id: plan.uploadId } : {}),
          parts:
            plan.kind === "multipart"
              ? plan.parts.map((p) => ({ partNumber: p.partNumber, etag: `"e${p.partNumber}"` }))
              : [{ partNumber: 1, etag: '"e1"' }],
        },
        { token },
      );
      expect(done.status).toBe(200);
      const out = apiRoutes.runner.uploadComplete.response.parse(await done.json());
      expect(out.artifact).toEqual({ name, key, sha256: SHA, size_bytes: size });
      expect(out.url).toBeUndefined(); // runner falls back to artifact:<key>

      // The plan the server rebuilt for completeUpload matches the one it issued.
      const issued = store.created.at(-1)!;
      const rebuilt = store.completed.at(-1)!;
      expect(rebuilt.kind).toBe(issued.kind);
      expect(rebuilt).toMatchObject({
        key,
        sizeBytes: size,
        sha256: SHA,
        maxBytes: issued.maxBytes,
      });
      if (issued.kind === "multipart" && rebuilt.kind === "multipart") {
        expect(rebuilt.uploadId).toBe(issued.uploadId);
        const shape = (p: UploadPlan & { kind: "multipart" }) =>
          p.parts.map(({ partNumber, offset, sizeBytes }) => ({ partNumber, offset, sizeBytes }));
        expect(shape(rebuilt)).toEqual(shape(issued));
      }
    }
  });

  it("uploads: 400 over the kit cap, wrong key, or not uploaded; 401 without the token", async () => {
    const t = await seedTrial();
    const token = mintRunnerToken(SECRET, t.id, 1);
    const tooBig = await post(
      `/v1/trials/${t.id}/uploads`,
      { attempt: 1, name: "big.bin", size_bytes: 301 * 1024 * 1024, sha256: SHA },
      { token },
    );
    expect(tooBig.status).toBe(400);
    const badName = await post(
      `/v1/trials/${t.id}/uploads`,
      { attempt: 1, name: "../escape", size_bytes: 1, sha256: SHA },
      { token },
    );
    expect(badName.status).toBe(400);
    const complete = (key: string) =>
      post(
        `/v1/trials/${t.id}/uploads/complete`,
        { attempt: 1, name: "x.bin", key, sha256: SHA, size_bytes: 1, parts: [] },
        { token },
      );
    expect(
      (await complete(`runs/${FIXTURE_RUN}/trials/${newId(TrialIdSchema)}/x.bin`)).status,
    ).toBe(400);
    expect((await complete(`runs/${FIXTURE_RUN}/trials/${t.id}/x.bin`)).status).toBe(400); // not uploaded
    expect(
      (
        await post(
          `/v1/trials/${t.id}/uploads`,
          { attempt: 1, name: "a.bin", size_bytes: 1, sha256: SHA },
          { token: null },
        )
      ).status,
    ).toBe(401);
  });

  it("503 when RUNNER_TOKEN_SECRET or the artifact store is not configured", async () => {
    const t = await seedTrial();
    const bare = createApp({
      config: configTdm14(h.url),
      logger: silentLoggerTdm14(),
      db: h.db,
      sentry: recordingSentryTdm14(),
    });
    const res = await bare.request(`/v1/trials/${t.id}/events`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${mintRunnerToken(SECRET, t.id, 1)}`,
        "idempotency-key": `${t.id}:1:0`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ trial_id: t.id, attempt: 1, batch_seq: 0, events: [], status: null }),
    });
    expect(res.status).toBe(503);
    const noStore = createApp({
      config: configTdm14(h.url, { RUNNER_TOKEN_SECRET: SECRET }),
      logger: silentLoggerTdm14(),
      db: h.db,
      sentry: recordingSentryTdm14(),
    });
    const up = await noStore.request(`/v1/trials/${t.id}/uploads`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${mintRunnerToken(SECRET, t.id, 1)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ attempt: 1, name: "a.bin", size_bytes: 1, sha256: SHA }),
    });
    expect(up.status).toBe(503);
  });
});
