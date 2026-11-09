// TDM-67 [7.3]: runs, kits and scan routes against local Postgres (skips without it). Every success
// goes through the typed core client, which parses each response with the contract's response
// schema; every error body is checked against ApiErrorBody (or PaymentRequired for the 402).
import {
  ApiClientError,
  ApiErrorBodySchema,
  apiRoutes,
  createApiClient,
  PaymentRequiredSchema,
  type ApiClient,
  type RunId,
} from "@anybench/core";
import { eq, sql } from "drizzle-orm";
import { runMigrations as runGraphileMigrations } from "graphile-worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { scopedDb } from "../src/db/scoped.js";
import {
  contenders,
  events,
  interventions,
  kits,
  projects,
  runs,
  users,
} from "../src/db/schema/index.js";
import { ADMIN_AUTO_COMP_REASON } from "../src/lib/billing-gate.js";
import { readEvents } from "../src/lib/events.js";
import { graphileJobQueue } from "../src/lib/job-queue.js";
import { createSession } from "../src/lib/session.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";
import {
  forceRunStateTdm67,
  kitSpecTdm67,
  runsAppTdm67,
  seedApiKeyTdm67,
  seedKitTdm67,
  seedUserTdm67,
  type RunsAppTdm67,
} from "./helpers/runs-tdm67.js";
import { configTdm14, recordingSentryTdm14, silentLoggerTdm14 } from "./helpers/server-tdm14.js";

const available = await pgAvailableTdm11();

const BASE = "http://api.test";

function clientFor(h: RunsAppTdm67, userId: string): ApiClient {
  return createApiClient(
    BASE,
    { kind: "apiKey", key: userId },
    { fetch: (url, init) => Promise.resolve(h.app.request(url, init)) },
  );
}

async function expectApiError(p: Promise<unknown>, status: number, code?: string) {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiClientError);
    const e = err as ApiClientError;
    expect(e.status, e.message).toBe(status);
    if (status !== 402) expect(ApiErrorBodySchema.safeParse(e.body).success).toBe(true);
    if (code) expect(e.code).toBe(code);
    return e;
  }
  throw new Error(`expected HTTP ${status}`);
}

/** A raw request, for paths outside the registry and for checking raw bodies. */
async function raw(
  h: RunsAppTdm67,
  userId: string | null,
  method: string,
  path: string,
  body?: unknown,
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (userId) headers.authorization = `Bearer ${userId}`;
  const res = await h.app.request(`${BASE}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as unknown) : undefined };
}

const githubBody = {
  question: "Is ripgrep faster than grep on large trees?",
  source: { kind: "github" as const, github: "BurntSushi/ripgrep", ref: "14.1.1" },
  budget_micro_usd: 5_000_000n,
};

describe.skipIf(!available)("runs, kits and scan routes (TDM-67)", () => {
  let db: FreshDbTdm11;
  let h: RunsAppTdm67;
  let alice: string;
  let bob: string;
  let a: ApiClient;
  let b: ApiClient;

  beforeAll(async () => {
    db = await freshMigratedDbTdm11({ max: 4 });
    h = runsAppTdm67(db.url);
    alice = await seedUserTdm67(db.db, "alice");
    bob = await seedUserTdm67(db.db, "bob");
    a = clientFor(h, alice);
    b = clientFor(h, bob);
  }, 60_000);

  afterAll(async () => {
    await h?.dbh.close();
    await db?.drop();
  });

  async function newRun(
    client = a,
    body: Parameters<ApiClient["runs"]["create"]>[0]["body"] = githubBody,
  ) {
    return (await client.runs.create({ body })).run;
  }

  it("auto_go: an explicit value wins, else the owner's auto_start_runs setting", async () => {
    const carol = await seedUserTdm67(db.db, "carol-autostart");
    const c = clientFor(h, carol);
    const intakeOf = async (id: string) =>
      (await db.db.select().from(runs).where(eq(runs.id, id)))[0]!.intake as { auto_go: boolean };

    expect((await intakeOf((await newRun(c)).id)).auto_go).toBe(false);
    await db.db.update(users).set({ autoStartRuns: true }).where(eq(users.id, carol));
    expect((await intakeOf((await newRun(c)).id)).auto_go).toBe(true);
    expect((await intakeOf((await newRun(c, { ...githubBody, auto_go: false })).id)).auto_go).toBe(
      false,
    );
    // Another user's setting does not leak.
    expect((await intakeOf((await newRun(b)).id)).auto_go).toBe(false);
    await db.db.update(users).set({ autoStartRuns: false }).where(eq(users.id, carol));
    expect((await intakeOf((await newRun(c, { ...githubBody, auto_go: true })).id)).auto_go).toBe(
      true,
    );
  });

  it("401s without credentials", async () => {
    const r = await raw(h, null, "GET", "/runs");
    expect(r.status).toBe(401);
    expect(ApiErrorBodySchema.parse(r.json).error.code).toBe("unauthorized");
  });

  it("POST /runs → GET /runs/:id round trip: project, intake state, event in the same tx, job", async () => {
    const jobsBefore = h.jobs.jobs.length;
    const run = await newRun();
    expect(run.state).toBe("intake");
    expect(run.budget_micro_usd).toBe(5_000_000n);
    expect(run.spent_micro_usd).toBe(0n);
    expect(run.project_id).not.toBeNull();
    expect(run.kit_id).toBeNull();

    const detail = await a.runs.get({ params: { id: run.id } });
    expect(detail.run).toEqual(run);
    expect(detail.counters).toMatchObject({
      trials_total: 0,
      trials_done: 0,
      trials_running: 0,
      trials_failed: 0,
      spent_micro_usd: 0n,
      last_seq: 1,
    });
    expect(detail.open_alerts).toEqual([]);
    expect(detail.agents).toEqual([]);

    const [project] = await db.db.select().from(projects).where(eq(projects.id, run.project_id!));
    expect(project).toMatchObject({
      ownerId: alice,
      source: "github",
      url: "https://github.com/BurntSushi/ripgrep",
    });
    const [row] = await db.db.select().from(runs).where(eq(runs.id, run.id));
    expect(row!.intake).toMatchObject({
      source: githubBody.source,
      contenders: [],
      // No auto_go in the body: the owner's auto_start_runs setting (default off) decides.
      auto_go: false,
    });

    const evs = await readEvents(db.db, run.id as RunId);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      seq: 1,
      type: "run.state_changed",
      source: "run",
      source_id: run.id,
      actor: { kind: "user", id: alice },
      payload: { from: null, to: "intake" },
    });

    expect(h.jobs.jobs.slice(jobsBefore)).toEqual([
      {
        task: "run.advance",
        payload: { run_id: run.id, reason: "created" },
        jobKey: `runs:${run.id}:created`,
      },
    ]);
  });

  it("accepts a binary url, an upload id and a saved kit as the source; stores user contenders", async () => {
    const bin = await newRun(a, {
      question: "Is the new build faster?",
      source: { kind: "binary", binary_url: "https://example.com/tool-v2.tar.gz" },
      budget_micro_usd: 1_000_000n,
    });
    const [p1] = await db.db.select().from(projects).where(eq(projects.id, bin.project_id!));
    expect(p1).toMatchObject({ source: "binary", url: "https://example.com/tool-v2.tar.gz" });

    const uploadId = "0190f5d6-1111-7000-8000-000000000067";
    const spec = kitSpecTdm67();
    const up = await newRun(a, {
      question: "Is my Claude Code setup better?",
      source: { kind: "claude_setup", upload_id: uploadId },
      budget_micro_usd: 1_000_000n,
      contenders: [spec.contenders[1]!],
      auto_go: false,
    });
    const [row] = await db.db.select().from(runs).where(eq(runs.id, up.id));
    expect(row!.intake).toMatchObject({ source: { upload_id: uploadId }, auto_go: false });
    const cs = await db.db.select().from(contenders).where(eq(contenders.runId, up.id));
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ role: "baseline", status: "kept", foundBy: "user" });

    // Rerun a saved kit: same project, the spec copied as version 1 of the new run (unproven).
    await forceRunStateTdm67(db.db, bin.id, "kit_draft");
    const v1 = await raw(h, alice, "PATCH", `/runs/${bin.id}/kit`, { spec });
    expect(v1.status).toBe(201);
    const kitId = (v1.json as { kit: { id: string } }).kit.id;
    const rerun = await newRun(a, {
      question: "Rerun on the next release",
      source: { kind: "kit", kit_id: kitId as never },
      budget_micro_usd: 1_000_000n,
    });
    expect(rerun.project_id).toBe(bin.project_id);
    expect(rerun.kit_id).not.toBeNull();
    expect(rerun.kit_id).not.toBe(kitId);
    const rk = await a.kits.get({ params: { id: rerun.kit_id! } });
    expect(rk.kit).toMatchObject({ run_id: rerun.id, version: 1, proven: false });

    // Bob cannot rerun Alice's kit.
    await expectApiError(
      newRun(b, {
        question: "steal",
        source: { kind: "kit", kit_id: kitId as never },
        budget_micro_usd: 1n,
      }),
      404,
      "not_found",
    );
  });

  it("validates the body: bad budget and source come back as ApiErrorBody issues", async () => {
    const r = await raw(h, alice, "POST", "/runs", {
      question: "",
      source: { kind: "binary" },
      budget_micro_usd: "1.5",
    });
    expect(r.status).toBe(400);
    const body = ApiErrorBodySchema.parse(r.json);
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.issues?.some((i) => i.startsWith("body.budget_micro_usd"))).toBe(true);
    expect(body.error.issues?.some((i) => i.startsWith("body.question"))).toBe(true);
    expect((await raw(h, alice, "POST", "/runs", "{not json")).status).toBe(400);
  });

  it("replays a create with the same Idempotency-Key", async () => {
    const headers = { "idempotency-key": "tdm67-idem-key-1" };
    const first = await a.runs.create({ body: githubBody, headers });
    const jobs = h.jobs.jobs.length;
    const again = await a.runs.create({ body: githubBody, headers });
    expect(again.run.id).toBe(first.run.id);
    expect(h.jobs.jobs.length).toBe(jobs);
  });

  it("another user's run is a 404 everywhere and never listed", async () => {
    const run = await newRun();
    const id = { params: { id: run.id } };
    await expectApiError(b.runs.get(id), 404, "not_found");
    await expectApiError(b.runs.go(id), 404, "not_found");
    await expectApiError(b.runs.cancel({ ...id, body: {} }), 404, "not_found");
    expect(
      (await raw(h, bob, "PATCH", `/runs/${run.id}/kit`, { spec: kitSpecTdm67() })).status,
    ).toBe(404);
    const list = await b.runs.list();
    expect(list.items.map((r) => r.id)).not.toContain(run.id);
    // Unknown ids are 404 too, and a malformed id is a 400.
    await expectApiError(
      a.runs.get({ params: { id: "0190f5d6-0000-7000-8000-000000000000" } }),
      404,
    );
    expect((await raw(h, alice, "GET", "/runs/not-a-uuid")).status).toBe(400);
  });

  it("GET /runs pages newest first and filters by state", async () => {
    const user = await seedUserTdm67(db.db, "pager");
    const c = clientFor(h, user);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await newRun(c)).id);
    await forceRunStateTdm67(db.db, ids[1]!, "kit_draft");

    const p1 = await c.runs.list({ query: { limit: 2 } });
    expect(p1.items.map((r) => r.id)).toEqual([ids[4], ids[3]]);
    expect(p1.next_cursor).not.toBeNull();
    const p2 = await c.runs.list({ query: { limit: 2, cursor: p1.next_cursor! } });
    expect(p2.items.map((r) => r.id)).toEqual([ids[2], ids[1]]);
    const p3 = await c.runs.list({ query: { limit: 2, cursor: p2.next_cursor! } });
    expect(p3.items.map((r) => r.id)).toEqual([ids[0]]);
    expect(p3.next_cursor).toBeNull();

    const drafts = await c.runs.list({ query: { state: ["kit_draft"] } });
    expect(drafts.items.map((r) => r.id)).toEqual([ids[1]]);
    await expectApiError(c.runs.list({ query: { cursor: "garbage" } }), 400, "validation_failed");
  });

  it("kit edits: 409 outside kit_draft/awaiting_go, new versions otherwise, proof to rerun", async () => {
    const run = await newRun();
    const spec = kitSpecTdm67();

    const early = await raw(h, alice, "PATCH", `/runs/${run.id}/kit`, { spec });
    expect(early.status).toBe(409);
    expect(ApiErrorBodySchema.parse(early.json).error.code).toBe("conflict");

    await forceRunStateTdm67(db.db, run.id, "kit_draft");
    const bad = await raw(h, alice, "PATCH", `/runs/${run.id}/kit`, {
      spec: { ...spec, repeats: 0 },
    });
    expect(bad.status).toBe(400);
    const badBody = ApiErrorBodySchema.parse(bad.json);
    expect(badBody.error.issues).toContain(
      "body.spec.repeats: Too small: expected number to be >=1",
    );

    const v1 = await raw(h, alice, "PATCH", `/runs/${run.id}/kit`, { spec });
    expect(v1.status).toBe(201);
    const k1 = apiRoutes.kits.createVersion.response.parse(v1.json).kit;
    expect(k1).toMatchObject({ run_id: run.id, version: 1, proven: false, proof: [], repairs: 0 });
    expect(k1.name).toBe("ripgrep");
    expect(k1.hash).toMatch(/^[0-9a-f]{64}$/);

    await forceRunStateTdm67(db.db, run.id, "awaiting_go");
    const jobs = h.jobs.jobs.length;
    const edited = { ...spec, repeats: 7 };
    const v2 = await a.kits.createVersion({ params: { id: k1.id }, body: { spec: edited } });
    expect(v2.kit).toMatchObject({ run_id: run.id, version: 2, proven: false });
    expect(v2.kit.spec.repeats).toBe(7);
    expect(v2.kit.hash).not.toBe(k1.hash);
    expect((await a.runs.get({ params: { id: run.id } })).run.kit_id).toBe(v2.kit.id);
    expect(h.jobs.jobs.slice(jobs)).toEqual([
      {
        task: "run.advance",
        payload: { run_id: run.id, reason: "kit_edited", kit_id: v2.kit.id },
        jobKey: `kits:${v2.kit.id}:1`,
      },
    ]);

    // Contract-route validation failures carry the same issue shape.
    const badV = await raw(h, alice, "POST", `/kits/${k1.id}/versions`, {
      spec: { ...spec, repeats: 0 },
    });
    expect(badV.status).toBe(400);
    expect(ApiErrorBodySchema.parse(badV.json).error.issues?.[0]).toMatch(/^body\.spec\.repeats: /);

    await forceRunStateTdm67(db.db, run.id, "running");
    await expectApiError(
      a.kits.createVersion({ params: { id: k1.id }, body: { spec } }),
      409,
      "conflict",
    );

    // Reads, list, validate, foreign access.
    const listed = await a.kits.list({ query: { run_id: run.id } });
    expect(listed.items.map((k) => k.version)).toEqual([2, 1]);
    await expectApiError(b.kits.get({ params: { id: k1.id } }), 404);
    await expectApiError(b.kits.createVersion({ params: { id: k1.id }, body: { spec } }), 404);
    expect((await b.kits.list({ query: { run_id: run.id } })).items).toEqual([]);
    expect(await a.kits.validate({ body: { spec } })).toMatchObject({ ok: true });
    const invalid = await a.kits.validate({ body: { spec: { schema_version: 1 } } });
    expect(invalid.ok).toBe(false);
    // TDM-217: only uploaded kits (files in the artifact store) download; this one has none.
    await expectApiError(a.kits.download({ params: { id: k1.id } }), 409, "conflict");
  });

  it("POST /runs/:id/go answers the contract's 402 in test mode and leaves the run waiting", async () => {
    const run = await newRun();
    await forceRunStateTdm67(db.db, run.id, "awaiting_go", 2_000_000n);
    await seedKitTdm67(db.db, run.id, true);

    const res = await h.app.request(`${BASE}/runs/${run.id}/go`, {
      method: "POST",
      headers: { authorization: `Bearer ${alice}` },
    });
    expect(res.status).toBe(402);
    const body = PaymentRequiredSchema.parse(await res.json());
    expect(body).toEqual({
      reason: "no_payment_method",
      link_card_url: `https://anybench.jaxonp.com/settings/billing?run=${run.id}`,
    });
    const e = await expectApiError(a.runs.go({ params: { id: run.id } }), 402, "payment_required");
    expect(e.paymentRequired).toEqual(body);
    expect((await a.runs.get({ params: { id: run.id } })).run.state).toBe("awaiting_go");
  });

  it("demo comp: an admin owner's Go is comped (interventions row) and allowed; a non-admin still gets 402", async () => {
    const [aliceRow] = await db.db.select().from(users).where(eq(users.id, alice));
    // Upper-case on purpose: ADMIN_GITHUB_LOGINS matching is case-insensitive (TDM-65).
    const adminApp = runsAppTdm67(db.url, {
      env: { ADMIN_GITHUB_LOGINS: `someone-else,${aliceRow!.githubLogin.toUpperCase()}` },
    });
    try {
      // Admin (alice): the default gate comps the run and lets it Go.
      const ca = clientFor(adminApp, alice);
      const run = (await ca.runs.create({ body: githubBody })).run;
      await forceRunStateTdm67(db.db, run.id, "awaiting_go", 2_000_000n);
      await seedKitTdm67(db.db, run.id, true);
      const went = await ca.runs.go({ params: { id: run.id } });
      expect(went.run.state).toBe("running");
      expect(went.run.comped).toBe(true);
      const [row] = await db.db.select().from(runs).where(eq(runs.id, run.id));
      expect(row).toMatchObject({
        compedBy: aliceRow!.githubLogin,
        compedReason: ADMIN_AUTO_COMP_REASON,
      });
      const ivs = await db.db.select().from(interventions).where(eq(interventions.runId, run.id));
      expect(ivs).toHaveLength(1);
      expect(ivs[0]).toMatchObject({
        id: row!.compInterventionId,
        userId: alice,
        who: aliceRow!.githubLogin,
        what: "comp",
        why: ADMIN_AUTO_COMP_REASON,
      });

      // Non-admin (bob), same app and env: still the contract's 402, nothing comped or logged.
      const cb = clientFor(adminApp, bob);
      const other = (await cb.runs.create({ body: githubBody })).run;
      await forceRunStateTdm67(db.db, other.id, "awaiting_go", 2_000_000n);
      await seedKitTdm67(db.db, other.id, true);
      const e = await expectApiError(cb.runs.go({ params: { id: other.id } }), 402);
      expect(e.paymentRequired).toEqual({
        reason: "no_payment_method",
        link_card_url: `https://anybench.jaxonp.com/settings/billing?run=${other.id}`,
      });
      const [otherRow] = await db.db.select().from(runs).where(eq(runs.id, other.id));
      expect(otherRow).toMatchObject({ state: "awaiting_go", compedBy: null });
      expect(
        await db.db.select().from(interventions).where(eq(interventions.runId, other.id)),
      ).toEqual([]);
    } finally {
      await adminApp.dbh.close();
    }
  });

  it("go refuses (409) outside awaiting_go, with an unproven kit, or over budget", async () => {
    const run = await newRun();
    await expectApiError(a.runs.go({ params: { id: run.id } }), 409, "conflict");

    await forceRunStateTdm67(db.db, run.id, "awaiting_go", 1_000_000n);
    const e1 = await expectApiError(a.runs.go({ params: { id: run.id } }), 409);
    expect(e1.message).toContain("proof checks");

    await seedKitTdm67(db.db, run.id, false);
    await expectApiError(a.runs.go({ params: { id: run.id } }), 409);

    const r2 = await newRun();
    await forceRunStateTdm67(db.db, r2.id, "awaiting_go", 9_000_000n);
    await seedKitTdm67(db.db, r2.id, true);
    const e2 = await expectApiError(a.runs.go({ params: { id: r2.id } }), 409);
    expect(e2.message).toContain("estimate exceeds the run budget");
  });

  it("go passes with BILLING_MODE=off: running, event, job, gate called with the estimate", async () => {
    const off = runsAppTdm67(db.url, {
      env: { BILLING_MODE: "off" },
      billingGate: async () => ({ allowed: true }),
    });
    try {
      const c = clientFor(off, alice);
      const run = (await c.runs.create({ body: githubBody })).run;
      await forceRunStateTdm67(db.db, run.id, "awaiting_go", 2_500_000n);
      await seedKitTdm67(db.db, run.id, true);
      const went = await c.runs.go({ params: { id: run.id } });
      expect(went.run.state).toBe("running");
      expect(off.gateCalls).toEqual([{ userId: alice, estimate: 2_500_000n }]);
      const evs = await readEvents(db.db, run.id as RunId);
      expect(evs.at(-1)).toMatchObject({
        type: "run.state_changed",
        payload: { from: "awaiting_go", to: "running", command: "go" },
      });
      expect(off.jobs.jobs.at(-1)).toMatchObject({ jobKey: `runs:${run.id}:go` });
      await expectApiError(c.runs.go({ params: { id: run.id } }), 409);
    } finally {
      await off.dbh.close();
    }
  });

  it("the default gate allows under BILLING_MODE=off", async () => {
    const off = runsAppTdm67(db.url, { env: { BILLING_MODE: "off" } });
    try {
      const c = clientFor(off, alice);
      const run = (await c.runs.create({ body: githubBody })).run;
      await forceRunStateTdm67(db.db, run.id, "awaiting_go", 1n);
      await seedKitTdm67(db.db, run.id, true);
      expect((await c.runs.go({ params: { id: run.id } })).run.state).toBe("running");
    } finally {
      await off.dbh.close();
    }
  });

  it("cancel sets cancel_requested_at, moves to cancelled, writes the event; idempotent; 409 when ended", async () => {
    const run = await newRun();
    await forceRunStateTdm67(db.db, run.id, "research");
    const jobs = h.jobs.jobs.length;
    const out = await a.runs.cancel({ params: { id: run.id }, body: { reason: "wrong repo" } });
    expect(out.run.state).toBe("cancelled");
    expect(out.run.cancel_requested_at).not.toBeNull();
    const evs = await readEvents(db.db, run.id as RunId);
    expect(evs.at(-1)).toMatchObject({
      type: "run.state_changed",
      actor: { kind: "user", id: alice },
      payload: { from: "research", to: "cancelled", command: "cancel", reason: "wrong repo" },
    });
    expect(h.jobs.jobs.slice(jobs)).toEqual([
      {
        task: "run.advance",
        payload: { run_id: run.id, reason: "cancelled" },
        jobKey: `runs:${run.id}:cancelled`,
      },
    ]);

    const again = await a.runs.cancel({ params: { id: run.id }, body: {} });
    expect(again.run.cancel_requested_at).toBe(out.run.cancel_requested_at);
    expect(await readEvents(db.db, run.id as RunId)).toHaveLength(evs.length);

    const done = await newRun();
    await forceRunStateTdm67(db.db, done.id, "delivered");
    await expectApiError(a.runs.cancel({ params: { id: done.id }, body: {} }), 409, "conflict");
    const [row] = await db.db.select().from(runs).where(eq(runs.id, done.id));
    expect(row!.cancelRequestedAt).toBeNull();
  });

  it("GET /runs/:id counts trials and returns open alerts and agent sessions", async () => {
    const run = await newRun();
    await db.db.execute(sql`
      insert into contenders (id, run_id, source, role) values (gen_random_uuid(), ${run.id}, 'x', 'subject')`);
    const [ct] = await db.db.select().from(contenders).where(eq(contenders.runId, run.id));
    for (const [i, state] of (
      ["queued", "running", "done", "done", "failed_infra"] as const
    ).entries()) {
      await db.db.execute(sql`
        insert into trials (owner_id, run_id, contender_id, workload_id, repeat, state)
        values (${alice}, ${run.id}, ${ct!.id}, 'w', ${i}, ${state})`);
    }
    await db.db.execute(
      sql`insert into alert_rules (key, scope, condition, severity) values ('tdm67.rule', 'run', '{}'::jsonb, 'warn') on conflict do nothing`,
    );
    await db.db.execute(sql`
      insert into alerts (rule_key, fingerprint, run_id, severity, payload)
      values ('tdm67.rule', ${`tdm67:${run.id}`}, ${run.id}, 'warn', '{"message":"spend at 70%"}'::jsonb)`);
    await db.db.execute(sql`
      insert into agent_sessions (run_id, role, budget_micro_usd, status)
      values (${run.id}, 'understander', 1000000, 'running')`);

    const d = await a.runs.get({ params: { id: run.id } });
    expect(d.counters).toMatchObject({
      trials_total: 5,
      trials_done: 2,
      trials_running: 1,
      trials_failed: 1,
    });
    expect(d.open_alerts).toHaveLength(1);
    expect(d.open_alerts[0]).toMatchObject({ message: "spend at 70%", severity: "warn" });
    expect(d.agents).toHaveLength(1);
    expect(d.agents[0]).toMatchObject({ role: "understander", status: "running" });
  });

  it("scans: create with repos, get, list; foreign 404; invalid repos 400", async () => {
    const created = await a.scan.create({
      body: { github_owner: "jaximus808", repos: ["anybench", "jaximus808/tandem", "anybench"] },
    });
    expect(created.scan).toMatchObject({
      github_owner: "jaximus808",
      status: "queued",
      finished_at: null,
    });
    expect(created.scan.repos.map((r) => r.repo)).toEqual([
      "jaximus808/anybench",
      "jaximus808/tandem",
    ]);
    expect(created.scan.repos[0]).toMatchObject({
      status: "queued",
      benchable: null,
      better_means: [],
    });
    expect(created.scan.cost_micro_usd).toBe(0n);

    const all = await a.scan.create({ body: { github_owner: "jaximus808" } });
    expect(all.scan.repos).toEqual([]);

    expect((await a.scan.get({ params: { id: created.scan.id } })).scan).toEqual(created.scan);
    const listed = await a.scan.list();
    expect(listed.items.map((s) => s.id)).toEqual([all.scan.id, created.scan.id]);
    await expectApiError(b.scan.get({ params: { id: created.scan.id } }), 404, "not_found");
    expect((await b.scan.list()).items).toEqual([]);

    const bad = await raw(h, alice, "POST", "/scans", {
      github_owner: "jaximus808",
      repos: ["a/b/c"],
    });
    expect(bad.status).toBe(400);
    expect(ApiErrorBodySchema.parse(bad.json).error.issues).toEqual([
      "body.repos[0]: expected 'repo' or 'owner/repo'",
    ]);
  });

  it("works with the default session-cookie authenticator and the real graphile job queue", async () => {
    await runGraphileMigrations({ connectionString: db.url });
    // No `authenticate` and no `jobs`: the app falls back to the session cookie (TDM-65) and
    // graphile_worker.add_job on the pooled db.
    const dbh = createDb(db.url, { max: 2 });
    try {
      const app = createApp({
        config: configTdm14(db.url, { ALLOWED_ORIGINS: "https://anybench.jaxonp.com" }),
        logger: silentLoggerTdm14(),
        db: dbh.db,
        sentry: recordingSentryTdm14(),
      });
      const { token } = await createSession(db.db, alice);
      const res = await app.request(`${BASE}/runs`, {
        method: "POST",
        headers: {
          cookie: `anybench_session=${token}`,
          origin: "https://anybench.jaxonp.com",
          "content-type": "application/json",
        },
        body: JSON.stringify({ ...githubBody, budget_micro_usd: "5000000" }),
      });
      expect(res.status).toBe(201);
      const { run } = apiRoutes.runs.create.response.parse(await res.json());
      const jobs = await db.db.execute(
        sql`select t.identifier as task_identifier, j.key, j.payload
            from graphile_worker._private_jobs j
            join graphile_worker._private_tasks t on t.id = j.task_id
            where j.key = ${`runs:${run.id}:created`}`,
      );
      expect((jobs as unknown as { rows: unknown[] }).rows).toEqual([
        {
          task_identifier: "run.advance",
          key: `runs:${run.id}:created`,
          payload: { run_id: run.id, reason: "created" },
        },
      ]);
      // And no cookie → 401.
      expect((await app.request(`${BASE}/runs`)).status).toBe(401);
    } finally {
      await dbh.close();
    }
  });

  it("the real queue enqueues inside the tenant transaction: rolls back with it, keeps RLS on", async () => {
    await runGraphileMigrations({ connectionString: db.url });
    const queue = graphileJobQueue();
    const scoped = scopedDb({ kind: "user", userId: alice }, db.db);
    // Rolled back with the transaction that enqueued it.
    await expect(
      scoped.transaction(async (tx) => {
        await queue.add(
          tx,
          "run.advance",
          { run_id: alice, reason: "created" },
          { jobKey: "tdm67:rollback" },
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // Committed with it, and the tenant role is back afterwards (RLS still applies).
    const role = await scoped.transaction(async (tx) => {
      await queue.add(
        tx,
        "run.advance",
        { run_id: alice, reason: "created" },
        { jobKey: "tdm67:commit" },
      );
      const r = await tx.execute(sql`select current_user as u`);
      return (r as unknown as { rows: { u: string }[] }).rows[0]!.u;
    });
    expect(role).toBe("anybench_app");
    const keys = await db.db.execute(
      sql`select key from graphile_worker._private_jobs where key like 'tdm67:%' order by key`,
    );
    expect((keys as unknown as { rows: { key: string }[] }).rows.map((r) => r.key)).toEqual([
      "tdm67:commit",
    ]);
  });

  it("PATCH /runs/:id/kit is the typed runs.editKit route", async () => {
    const run = await newRun();
    await forceRunStateTdm67(db.db, run.id, "kit_draft");
    const out = await a.runs.editKit({ params: { id: run.id }, body: { spec: kitSpecTdm67() } });
    expect(out.kit).toMatchObject({ run_id: run.id, version: 1, proven: false });
    await expectApiError(
      b.runs.editKit({ params: { id: run.id }, body: { spec: kitSpecTdm67() } }),
      404,
    );
  });

  it("oversized bodies get a 413 ApiErrorBody", async () => {
    const run = await newRun();
    await forceRunStateTdm67(db.db, run.id, "kit_draft");
    const big = (bytes: number) => "x".repeat(bytes);
    const cases: [string, string, unknown][] = [
      ["POST", "/runs", { ...githubBody, budget_micro_usd: "1", question: big(300 * 1024) }],
      ["PATCH", `/runs/${run.id}/kit`, { spec: { pad: big(1100 * 1024) } }],
      ["POST", "/kits/validate", { spec: { pad: big(1100 * 1024) } }],
    ];
    for (const [method, path, body] of cases) {
      const r = await raw(h, alice, method, path, body);
      expect(r.status, `${method} ${path}`).toBe(413);
      expect(ApiErrorBodySchema.parse(r.json).error.code).toBe("payload_too_large");
    }
    // Under the limit still works (and is validated as usual).
    const ok = await raw(h, alice, "POST", "/kits/validate", { spec: kitSpecTdm67() });
    expect(ok.status).toBe(200);
  });

  it("Idempotency-Key: parallel creates with one key make one run; keys are per owner", async () => {
    const key = "tdm67-parallel-key";
    const headers = { "idempotency-key": key };
    const results = await Promise.all(
      Array.from({ length: 4 }, () => a.runs.create({ body: githubBody, headers })),
    );
    expect(new Set(results.map((r) => r.run.id)).size).toBe(1);
    const rows = await db.db
      .select({ id: runs.id })
      .from(runs)
      .where(sql`${runs.intake}->>'idempotency_key' = ${key}`);
    expect(rows).toHaveLength(1);
    const evs = await readEvents(db.db, results[0]!.run.id as RunId);
    expect(evs).toHaveLength(1);

    const mine = await a.runs.create({
      body: githubBody,
      headers: { "idempotency-key": "tdm67-shared" },
    });
    const theirs = await b.runs.create({
      body: githubBody,
      headers: { "idempotency-key": "tdm67-shared" },
    });
    expect(theirs.run.id).not.toBe(mine.run.id);
    expect((await b.runs.get({ params: { id: theirs.run.id } })).run.id).toBe(theirs.run.id);
    await expectApiError(b.runs.get({ params: { id: mine.run.id } }), 404);
  });

  it("API key scopes: run-scoped keys see only their runs; runs:read keys cannot write", async () => {
    const mine = await newRun();
    const other = await newRun();
    await forceRunStateTdm67(db.db, mine.id, "kit_draft");
    await forceRunStateTdm67(db.db, other.id, "kit_draft");
    const kitOther = (
      (await raw(h, alice, "PATCH", `/runs/${other.id}/kit`, { spec: kitSpecTdm67() })).json as {
        kit: { id: string };
      }
    ).kit.id;
    await raw(h, alice, "PATCH", `/runs/${mine.id}/kit`, { spec: kitSpecTdm67() });

    // A read+write key limited to `mine`.
    const scoped = clientFor(
      h,
      await seedApiKeyTdm67(db.db, alice, ["runs:read", "runs:write"], [mine.id]),
    );
    expect((await scoped.runs.get({ params: { id: mine.id } })).run.id).toBe(mine.id);
    await expectApiError(scoped.runs.get({ params: { id: other.id } }), 403, "forbidden");
    await expectApiError(scoped.runs.cancel({ params: { id: other.id }, body: {} }), 403);
    await expectApiError(scoped.runs.go({ params: { id: other.id } }), 403);
    await expectApiError(scoped.kits.get({ params: { id: kitOther as never } }), 403);
    await expectApiError(
      scoped.kits.createVersion({
        params: { id: kitOther as never },
        body: { spec: kitSpecTdm67() },
      }),
      403,
    );
    expect((await scoped.runs.list()).items.map((r) => r.id)).toEqual([mine.id]);
    expect((await scoped.kits.list()).items.every((k) => k.run_id === mine.id)).toBe(true);
    await expectApiError(scoped.runs.create({ body: githubBody }), 403, "forbidden");
    await expectApiError(scoped.scan.list(), 403, "forbidden");

    // A runs:read key (all runs) reads but cannot POST, PATCH, go or cancel.
    const reader = clientFor(h, await seedApiKeyTdm67(db.db, alice, ["runs:read"]));
    expect((await reader.runs.get({ params: { id: other.id } })).run.id).toBe(other.id);
    expect((await reader.runs.list()).items.map((r) => r.id)).toContain(other.id);
    const before = (await a.runs.list({ query: { limit: 200 } })).items.length;
    const denied = await expectApiError(reader.runs.create({ body: githubBody }), 403, "forbidden");
    expect(denied.message).toContain("runs:write");
    expect((await a.runs.list({ query: { limit: 200 } })).items.length).toBe(before);
    await expectApiError(reader.runs.cancel({ params: { id: other.id }, body: {} }), 403);
    await expectApiError(reader.scan.create({ body: { github_owner: "jaximus808" } }), 403);
    await expectApiError(
      reader.kits.createVersion({
        params: { id: kitOther as never },
        body: { spec: kitSpecTdm67() },
      }),
      403,
    );
    expect((await reader.scan.list()).items).toBeDefined();

    // A key with neither scope (events only) is refused everywhere here; a bad key is a 401.
    const events = clientFor(h, await seedApiKeyTdm67(db.db, alice, ["events:read"]));
    await expectApiError(events.runs.get({ params: { id: mine.id } }), 403);
    await expectApiError(events.runs.list(), 403);
    const bogus = clientFor(h, `ab_test_${"x".repeat(43)}`);
    await expectApiError(bogus.runs.list(), 401, "unauthorized");
  });

  it("keeps kits and events owned by the run's owner", async () => {
    const run = await newRun();
    await forceRunStateTdm67(db.db, run.id, "kit_draft");
    await raw(h, alice, "PATCH", `/runs/${run.id}/kit`, { spec: kitSpecTdm67() });
    const ks = await db.db.select().from(kits).where(eq(kits.runId, run.id));
    expect(ks.every((k) => k.ownerId === alice)).toBe(true);
    const es = await db.db.select().from(events).where(eq(events.runId, run.id));
    expect(es.every((e) => e.ownerId === alice)).toBe(true);
  });
});
