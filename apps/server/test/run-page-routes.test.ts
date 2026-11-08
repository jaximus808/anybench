// Run page routes (orchestrator fix): trials.list, trials.get, runs.contenders, runs.agents against
// local Postgres (skips without it). Successes go through the typed core client, which parses each
// response with the contract's schema; every route also 404s for another tenant's or an unknown id.
import {
  ApiClientError,
  apiRoutes,
  createApiClient,
  newId,
  RunIdSchema,
  TrialIdSchema,
  type ApiClient,
  type Contender,
  type RunId,
  type TrialId,
} from "@anybench/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentSessions, contenders, events, trials } from "../src/db/schema/index.js";
import { eq } from "drizzle-orm";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";
import {
  kitSpecTdm67,
  runsAppTdm67,
  seedApiKeyTdm67,
  seedUserTdm67,
  type RunsAppTdm67,
} from "./helpers/runs-tdm67.js";

const available = await pgAvailableTdm11();
const BASE = "http://api.test";

function clientFor(h: RunsAppTdm67, key: string): ApiClient {
  return createApiClient(
    BASE,
    { kind: "apiKey", key },
    { fetch: (url, init) => Promise.resolve(h.app.request(url, init)) },
  );
}

async function expectStatus(p: Promise<unknown>, status: number) {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiClientError);
    expect((err as ApiClientError).status).toBe(status);
    return;
  }
  throw new Error(`expected HTTP ${status}`);
}

describe.skipIf(!available)("run page routes (trials, contenders, agents)", () => {
  let db: FreshDbTdm11;
  let h: RunsAppTdm67;
  let alice: string;
  let a: ApiClient;
  let b: ApiClient;
  let runId: RunId;
  let contenderId: string;
  let passed: TrialId;
  let failed: TrialId;

  beforeAll(async () => {
    db = await freshMigratedDbTdm11({ max: 4 });
    h = runsAppTdm67(db.url);
    alice = await seedUserTdm67(db.db, "alice-rp");
    const bob = await seedUserTdm67(db.db, "bob-rp");
    a = clientFor(h, alice);
    b = clientFor(h, bob);
    const subject = kitSpecTdm67().contenders[0] as Contender;
    const run = await a.runs.create({
      body: {
        question: "Is ripgrep faster than grep?",
        source: { kind: "github", github: "BurntSushi/ripgrep" },
        budget_micro_usd: 5_000_000n,
        contenders: [subject],
      },
    });
    runId = run.run.id;
    // An agent-found candidate with a free-form source, dropped.
    await db.db.insert(contenders).values({
      runId,
      source: "grep (GNU)",
      role: "baseline",
      status: "unavailable",
      reason: "no driver",
      foundBy: "researcher",
    });
    const [ct] = await db.db
      .select({ id: contenders.id })
      .from(contenders)
      .where(eq(contenders.status, "kept"));
    contenderId = ct!.id;

    passed = newId(TrialIdSchema);
    failed = newId(TrialIdSchema);
    await db.db.insert(trials).values([
      {
        id: passed,
        ownerId: alice,
        runId,
        contenderId,
        workloadId: "search-linux",
        repeat: 0,
        attempt: 1,
        state: "done",
        createdAt: new Date("2026-11-07T19:59:00Z"),
        provider: "fake",
        startedAt: new Date("2026-11-07T20:00:00Z"),
        endedAt: new Date("2026-11-07T20:01:00Z"),
        exitCode: 0,
        logOffset: 1234,
        costMicroUsd: 42_000n,
        machine: {
          cpus: 4,
          dashboard: "https://runner.example/evil",
          versions: { ripgrep: "14.1.1", link: "http://runner.example/x" },
        },
        metrics: { wall_s: 1.5, note: "ignored" },
        gate: { pass: true, reason: "outputs match", evidence: ["out/diff.txt"] },
        logsUrl: "https://runner.example/logs",
      },
      {
        id: failed,
        ownerId: alice,
        runId,
        contenderId,
        workloadId: "search-linux",
        repeat: 1,
        attempt: 2,
        createdAt: new Date("2026-11-07T19:59:01Z"),
        state: "failed_subject",
        failureClass: "subject",
        gate: { not: "a gate result" },
      },
    ]);
    await db.db.insert(events).values([
      {
        ownerId: alice,
        runId,
        seq: 100,
        source: "trial",
        sourceId: passed,
        type: "trial.phase",
        payload: { from: null, to: "queued", attempt: 1 },
      },
      {
        ownerId: alice,
        runId,
        seq: 101,
        source: "trial",
        sourceId: passed,
        type: "trial.phase",
        payload: { from: "collecting", to: "done", attempt: 1 },
      },
    ]);
    await db.db.insert(agentSessions).values({
      runId,
      role: "researcher",
      budgetMicroUsd: 2_000_000n,
      costMicroUsd: 150_000n,
      status: "running",
    });
  }, 60_000);

  afterAll(async () => {
    await h?.dbh.close();
    await db?.drop();
  });

  it("trials.list: the run's trials, filters and cursor; 404 for another tenant or unknown run", async () => {
    const page = await a.call(apiRoutes.trials.list, { params: { id: runId } });
    expect(page.next_cursor).toBeNull();
    expect(page.items.map((t) => t.id)).toEqual([passed, failed]);
    expect(page.items[0]).toEqual({
      id: passed,
      run_id: runId,
      contender_id: contenderId,
      workload_id: "search-linux",
      repeat: 0,
      attempt: 1,
      state: "done",
      failure_class: null,
      started_at: "2026-11-07T20:00:00.000Z",
      ended_at: "2026-11-07T20:01:00.000Z",
      cost_micro_usd: 42_000n,
    });
    expect(page.items[1]).toMatchObject({
      attempt: 2,
      failure_class: "subject",
      cost_micro_usd: 0n,
    });

    const first = await a.call(apiRoutes.trials.list, {
      params: { id: runId },
      query: { limit: 1 },
    });
    expect(first.items.map((t) => t.id)).toEqual([passed]);
    const second = await a.call(apiRoutes.trials.list, {
      params: { id: runId },
      query: { limit: 1, cursor: first.next_cursor! },
    });
    expect(second.items.map((t) => t.id)).toEqual([failed]);
    expect(second.next_cursor).toBeNull();

    const done = await a.call(apiRoutes.trials.list, {
      params: { id: runId },
      query: { state: ["done"] },
    });
    expect(done.items.map((t) => t.id)).toEqual([passed]);

    await expectStatus(b.call(apiRoutes.trials.list, { params: { id: runId } }), 404);
    await expectStatus(a.call(apiRoutes.trials.list, { params: { id: newId(RunIdSchema) } }), 404);
  });

  it("trials.get: gate, metrics, phases; no runner URLs; 404 for another tenant or unknown trial", async () => {
    const { trial } = await a.call(apiRoutes.trials.get, { params: { id: passed } });
    expect(trial.gate).toEqual({ pass: true, reason: "outputs match", evidence: ["out/diff.txt"] });
    expect(trial.metrics).toEqual({ wall_s: 1.5 });
    expect(trial.machine).toEqual({ cpus: 4, versions: { ripgrep: "14.1.1" } });
    expect(trial.versions).toEqual({ ripgrep: "14.1.1" });
    expect(trial.provider).toBe("fake");
    expect(trial.exit_code).toBe(0);
    expect(trial.log_offset).toBe(1234);
    expect(trial.phases.map((p) => p.state)).toEqual(["queued", "done"]);
    expect(
      JSON.stringify(trial, (_k, v: unknown) => (typeof v === "bigint" ? `${v}` : v)),
    ).not.toMatch(/runner\.example/);

    // A malformed trials.gate is not shown as a gate result; the attempt-1 phases are not attempt 2's.
    const other = await a.call(apiRoutes.trials.get, { params: { id: failed } });
    expect(other.trial.gate).toBeNull();
    expect(other.trial.metrics).toBeNull();
    expect(other.trial.phases).toEqual([]);

    await expectStatus(b.call(apiRoutes.trials.get, { params: { id: passed } }), 404);
    await expectStatus(a.call(apiRoutes.trials.get, { params: { id: newId(TrialIdSchema) } }), 404);
  });

  it("trials.get: a key limited to another run is a 403", async () => {
    const key = await seedApiKeyTdm67(db.db, alice, ["runs:read"], [newId(RunIdSchema)]);
    await expectStatus(
      clientFor(h, key).call(apiRoutes.trials.get, { params: { id: passed } }),
      403,
    );
  });

  it("runs.contenders: kept and dropped candidates with spec; 404 for another tenant or unknown run", async () => {
    const { items } = await a.call(apiRoutes.runs.contenders, { params: { id: runId } });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: contenderId,
      name: "ripgrep",
      role: "subject",
      status: "kept",
      found_by: "user",
    });
    expect(items[0]!.spec?.id).toBe("ripgrep");
    expect(items[1]).toMatchObject({
      name: "grep (GNU)",
      role: "baseline",
      status: "unavailable",
      reason: "no driver",
      found_by: "researcher",
      spec: null,
    });

    await expectStatus(b.call(apiRoutes.runs.contenders, { params: { id: runId } }), 404);
    await expectStatus(
      a.call(apiRoutes.runs.contenders, { params: { id: newId(RunIdSchema) } }),
      404,
    );
  });

  it("runs.agents: the run's Naïve sessions; 404 for another tenant or unknown run", async () => {
    const { items } = await a.call(apiRoutes.runs.agents, { params: { id: runId } });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      run_id: runId,
      role: "researcher",
      status: "running",
      budget_micro_usd: 2_000_000n,
      cost_micro_usd: 150_000n,
    });

    await expectStatus(b.call(apiRoutes.runs.agents, { params: { id: runId } }), 404);
    await expectStatus(a.call(apiRoutes.runs.agents, { params: { id: newId(RunIdSchema) } }), 404);
  });
});
