// TDM-224 [20.2]: no card for the free run. POST /runs/:id/go against local Postgres (skips
// without it): an eligible account's starter run goes free with no card; every other case falls
// back to the card gate, and the 402 says in plain words why the run was not free. Also the
// release of a reservation when the transition fails, the billing summary's `free_run`, the BYOK
// /secrets routes onboarding stores the model key with, and the free run's compute cap hold.
import {
  ApiClientError,
  createApiClient,
  PaymentRequiredSchema,
  type ApiClient,
  type KitSpec,
  type PaymentRequired,
  PROOF_CHECKS,
} from "@anybench/core";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  billingAccounts,
  computers,
  events,
  freeRunPool,
  freeStarterRuns,
  kits,
  runs,
  userSecrets,
  users,
} from "../src/db/schema/index.js";
import type { Database } from "../src/db/client.js";
import { freeRunRefusalMessage, dollars } from "../src/lib/free-run.js";
import { freeRunComputeSpent } from "../src/orchestrator/advance.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";
import {
  forceRunStateTdm67,
  kitSpecTdm67,
  runsAppTdm67,
  seedUserTdm67,
  type RunsAppTdm67,
} from "./helpers/runs-tdm67.js";

const available = await pgAvailableTdm11();

const BASE = "http://api.test";
const KEK = "tdm224-test-kek-0123456789abcdefghijklmnop";
const YEAR_AGO = new Date(Date.now() - 365 * 86_400_000);
const WEEK_AGO = new Date(Date.now() - 7 * 86_400_000);
const ENV = { ANYBENCH_KEK: KEK };

const githubBody = {
  question: "Is ripgrep faster than grep on large trees?",
  source: { kind: "github" as const, github: "BurntSushi/ripgrep", ref: "14.1.1" },
  budget_micro_usd: 5_000_000n,
};

function clientFor(h: RunsAppTdm67, userId: string): ApiClient {
  return createApiClient(
    BASE,
    { kind: "apiKey", key: userId },
    { fetch: (url, init) => Promise.resolve(h.app.request(url, init)) },
  );
}

/** The tdm67 CLI kit (2 contenders x 2 workloads) at `repeats`: 3 = 12 trials (a starter). */
function kitWithRepeats(repeats: number): KitSpec {
  return { ...kitSpecTdm67(), repeats } as KitSpec;
}

async function seedProvenKit(db: Database, runId: string, spec: KitSpec): Promise<void> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  const proof = PROOF_CHECKS.map((check) => ({
    check,
    pass: true,
    reason: "seeded",
    evidence: [],
  }));
  const [kit] = await db
    .insert(kits)
    .values({ ownerId: run!.ownerId, runId, version: 1, spec, proof, hash: "b".repeat(64) })
    .returning({ id: kits.id });
  await db.update(runs).set({ kitId: kit!.id }).where(eq(runs.id, runId));
}

async function expect402(p: Promise<unknown>): Promise<PaymentRequired> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiClientError);
    const e = err as ApiClientError;
    expect(e.status, e.message).toBe(402);
    return PaymentRequiredSchema.parse(e.body);
  }
  throw new Error("expected HTTP 402");
}

describe.skipIf(!available)("Go with no card: the free starter run (TDM-224)", () => {
  let db: FreshDbTdm11;
  let h: RunsAppTdm67;

  beforeAll(async () => {
    db = await freshMigratedDbTdm11({ max: 4 });
    h = runsAppTdm67(db.url, { env: ENV });
  }, 60_000);

  afterAll(async () => {
    await h?.dbh.close();
    await db?.drop();
  });

  /** A user; `age` sets github_created_at, `key` stores an Anthropic key through PUT /secrets. */
  async function newUser(
    login: string,
    opts: { age?: Date | null; key?: boolean; card?: boolean } = {},
  ): Promise<{ id: string; c: ApiClient }> {
    const id = await seedUserTdm67(db.db, login);
    if (opts.age !== null) {
      await db.db
        .update(users)
        .set({ githubCreatedAt: opts.age ?? YEAR_AGO })
        .where(eq(users.id, id));
    }
    const c = clientFor(h, id);
    if (opts.key ?? true) {
      await c.secrets.put({
        params: { provider: "anthropic" },
        body: { value: "sk-ant-test-0000000000001234" },
      });
    }
    if (opts.card) await giveCard(id);
    return { id, c };
  }

  async function giveCard(userId: string): Promise<void> {
    await db.db
      .insert(billingAccounts)
      .values({ userId, paymentStatus: "ok", hasPaymentMethod: true })
      .onConflictDoUpdate({
        target: billingAccounts.userId,
        set: { paymentStatus: "ok", hasPaymentMethod: true },
      });
  }

  async function runAwaitingGo(c: ApiClient, repeats = 3): Promise<string> {
    const run = (await c.runs.create({ body: githubBody })).run;
    await forceRunStateTdm67(db.db, run.id, "awaiting_go", 2_000_000n);
    await seedProvenKit(db.db, run.id, kitWithRepeats(repeats));
    return run.id;
  }

  async function freeRow(runId: string) {
    const [row] = await db.db
      .select()
      .from(freeStarterRuns)
      .where(eq(freeStarterRuns.runId, runId));
    return row;
  }

  async function poolReserved(): Promise<bigint> {
    const [row] = await db.db.select().from(freeRunPool).where(eq(freeRunPool.id, "global"));
    return row?.reservedMicroUsd ?? 0n;
  }

  it("free ok: an eligible account with a model key and no card starts a starter run", async () => {
    const { id, c } = await newUser("free-ok");
    const runId = await runAwaitingGo(c);
    const before = await poolReserved();

    const went = await c.runs.go({ params: { id: runId } });
    expect(went.run.state).toBe("running");

    const row = await freeRow(runId);
    expect(row).toMatchObject({ userId: id, state: "reserved" });
    expect(row!.reservedMicroUsd).toBeGreaterThan(0n);
    expect(await poolReserved()).toBe(before + row!.reservedMicroUsd);
    expect(
      await db.db.select().from(billingAccounts).where(eq(billingAccounts.userId, id)),
    ).toEqual([]);
    const [ev] = await db.db
      .select()
      .from(events)
      .where(and(eq(events.runId, runId), eq(events.type, "run.state_changed")))
      .orderBy(sql`${events.seq} desc`)
      .limit(1);
    expect(ev!.payload).toMatchObject({
      from: "awaiting_go",
      to: "running",
      command: "go",
      reason: "free starter run",
    });

    // The billing summary now says the free run is in use, on this run.
    const s = await c.billing.summary();
    expect(s.free_run).toMatchObject({ status: "in_use", run_id: runId, has_model_key: true });
  });

  it("starter-limit refusal: 402 with every reason in plain words, nothing reserved", async () => {
    const { c } = await newUser("too-big", { key: false });
    const runId = await runAwaitingGo(c, 10); // 40 trials > FREE_RUN_MAX_TRIALS (24)
    const before = await poolReserved();

    const body = await expect402(c.runs.go({ params: { id: runId } }));
    expect(body.reason).toBe("no_payment_method");
    expect(body.link_card_url).toBe(`https://anybench.jaxonp.com/settings/billing?run=${runId}`);
    expect(body.free_run?.reason).toBe("too_many_trials");
    expect(body.free_run?.reasons.map((r) => r.code)).toEqual(["too_many_trials", "no_byok_key"]);
    expect(body.free_run?.message).toBe(
      "A free run has at most 24 trials, and this test plan has more. Lower the repeats, or add a card to run it as is.",
    );
    expect(body.free_run?.reasons[1]?.message).toContain("Add your Anthropic or OpenAI key");

    expect(await freeRow(runId)).toBeUndefined();
    expect(await poolReserved()).toBe(before);
    expect((await c.runs.get({ params: { id: runId } })).run.state).toBe("awaiting_go");
  });

  it("entitlement in use, then used: the second run needs a card and says why", async () => {
    const { id, c } = await newUser("twice");
    const first = await runAwaitingGo(c);
    expect((await c.runs.go({ params: { id: first } })).run.state).toBe("running");

    const second = await runAwaitingGo(c);
    const inUse = await expect402(c.runs.go({ params: { id: second } }));
    expect(inUse.free_run).toMatchObject({ reason: "in_use" });
    expect(inUse.free_run?.message).toContain("in use on another run");

    // The first run finished and consumed it (settleFreeRun's job; set directly here).
    await db.db
      .update(freeStarterRuns)
      .set({ state: "consumed" })
      .where(eq(freeStarterRuns.runId, first));
    const used = await expect402(c.runs.go({ params: { id: second } }));
    expect(used).toMatchObject({
      reason: "no_payment_method",
      free_run: {
        reason: "already_used",
        message: "You've used your free run. Add a card to continue.",
      },
    });
    expect((await c.billing.summary()).free_run).toMatchObject({ status: "used", run_id: first });

    // With a card on file the second run starts on the card, as before.
    await giveCard(id);
    expect((await c.runs.go({ params: { id: second } })).run.state).toBe("running");
    expect(await freeRow(second)).toBeUndefined();
  });

  it("pool paused: 402 'free runs are paused right now'; the summary says paused", async () => {
    const small = runsAppTdm67(db.url, { env: { ...ENV, FREE_RUN_POOL_MICRO_USD: "1000" } });
    try {
      const id = await seedUserTdm67(db.db, "pool-paused");
      await db.db.update(users).set({ githubCreatedAt: YEAR_AGO }).where(eq(users.id, id));
      const c = clientFor(small, id);
      await c.secrets.put({
        params: { provider: "openai" },
        body: { value: "sk-test-00000000abcd" },
      });
      const runId = await runAwaitingGo(c);
      const body = await expect402(c.runs.go({ params: { id: runId } }));
      expect(body.free_run).toMatchObject({
        reason: "pool_exhausted",
        message: "Free runs are paused right now. Add a card to run at the normal price.",
      });
      expect(await freeRow(runId)).toBeUndefined();
      expect((await c.billing.summary()).free_run).toMatchObject({
        status: "paused",
        reason: "pool_exhausted",
      });
    } finally {
      await small.dbh.close();
    }
  });

  it("account not eligible: email-only or too-new GitHub accounts get the card gate with a reason", async () => {
    const noAge = await newUser("no-age", { age: null });
    const r1 = await runAwaitingGo(noAge.c);
    expect((await expect402(noAge.c.runs.go({ params: { id: r1 } }))).free_run?.reason).toBe(
      "no_github_account_age",
    );
    const young = await newUser("young", { age: WEEK_AGO });
    const r2 = await runAwaitingGo(young.c);
    const body = await expect402(young.c.runs.go({ params: { id: r2 } }));
    expect(body.free_run).toMatchObject({
      reason: "github_account_too_new",
      message: "Free runs are for GitHub accounts older than 90 days. Add a card to continue.",
    });
    expect((await young.c.billing.summary()).free_run).toMatchObject({
      status: "not_eligible",
      reason: "github_account_too_new",
    });
  });

  it("card path unchanged: a card on file starts a non-starter run on the card, nothing reserved", async () => {
    // Eligible, but 40 trials is not a starter: the card pays, the free run stays available.
    const { c } = await newUser("card-big", { card: true });
    const runId = await runAwaitingGo(c, 10);
    const went = await c.runs.go({ params: { id: runId } });
    expect(went.run.state).toBe("running");
    expect(await freeRow(runId)).toBeUndefined();
    expect((await c.billing.summary()).free_run?.status).toBe("available");

    // Not eligible at all (no GitHub age) with a card: same as before TDM-224.
    const plain = await newUser("card-plain", { age: null, card: true });
    const r2 = await runAwaitingGo(plain.c);
    expect((await plain.c.runs.go({ params: { id: r2 } })).run.state).toBe("running");
    expect(await freeRow(r2)).toBeUndefined();
  });

  it("an eligible starter run is free even with a card on file (first benchmark free)", async () => {
    const { c } = await newUser("card-free", { card: true });
    const runId = await runAwaitingGo(c);
    expect((await c.runs.go({ params: { id: runId } })).run.state).toBe("running");
    expect(await freeRow(runId)).toMatchObject({ state: "reserved" });
  });

  it("a repeated Go after a crash between reserve and transition goes on free (duplicate)", async () => {
    const { c } = await newUser("dup");
    const runId = await runAwaitingGo(c);
    expect((await c.runs.go({ params: { id: runId } })).run.state).toBe("running");
    // Simulate the crash: the run is back in awaiting_go still holding its reservation.
    await forceRunStateTdm67(db.db, runId, "awaiting_go");
    const reserved = await poolReserved();
    expect((await c.runs.go({ params: { id: runId } })).run.state).toBe("running");
    expect(await poolReserved()).toBe(reserved);
    expect(await freeRow(runId)).toMatchObject({ state: "reserved" });
  });

  it("release on a failed transition: the reservation and the entitlement go back", async () => {
    const failing = runsAppTdm67(db.url, {
      env: ENV,
      deps: {
        jobs: {
          // Creating the run enqueues fine; only Go's enqueue (inside the transition) fails.
          async add(_tx, _task, _payload, options) {
            if (options.jobKey.endsWith(":go")) throw new Error("job queue down");
          },
        },
      },
    });
    try {
      const id = await seedUserTdm67(db.db, "release");
      await db.db.update(users).set({ githubCreatedAt: YEAR_AGO }).where(eq(users.id, id));
      const c = clientFor(failing, id);
      await c.secrets.put({
        params: { provider: "anthropic" },
        body: { value: "sk-ant-test-000000000000abcd" },
      });
      const runId = await runAwaitingGo(c);
      const before = await poolReserved();
      const res = await failing.app.request(`${BASE}/runs/${runId}/go`, {
        method: "POST",
        headers: { authorization: `Bearer ${id}` },
      });
      expect(res.status).toBe(500);
      expect((await c.runs.get({ params: { id: runId } })).run.state).toBe("awaiting_go");
      const [row] = await db.db
        .select()
        .from(freeStarterRuns)
        .where(eq(freeStarterRuns.runId, runId));
      expect(row).toMatchObject({ state: "released", releaseReason: "go_failed" });
      expect(await poolReserved()).toBe(before);
      expect((await c.billing.summary()).free_run?.status).toBe("available");

      // The account still has its free run: a Go that works now takes it.
      expect((await clientFor(h, id).runs.go({ params: { id: runId } })).run.state).toBe("running");
      const rows = await db.db
        .select({ state: freeStarterRuns.state })
        .from(freeStarterRuns)
        .where(eq(freeStarterRuns.runId, runId));
      expect(rows.map((r) => r.state).sort()).toEqual(["released", "reserved"]);
    } finally {
      await failing.dbh.close();
    }
  });

  it("an admin's run is comped, never the free run", async () => {
    const id = await seedUserTdm67(db.db, "admin-free");
    await db.db.update(users).set({ githubCreatedAt: YEAR_AGO }).where(eq(users.id, id));
    const [u] = await db.db.select().from(users).where(eq(users.id, id));
    const admin = runsAppTdm67(db.url, { env: { ...ENV, ADMIN_GITHUB_LOGINS: u!.githubLogin } });
    try {
      const c = clientFor(admin, id);
      await c.secrets.put({
        params: { provider: "anthropic" },
        body: { value: "sk-ant-test-00000000admin1" },
      });
      const runId = await runAwaitingGo(c);
      const went = await c.runs.go({ params: { id: runId } });
      expect(went.run).toMatchObject({ state: "running", comped: true });
      expect(await freeRow(runId)).toBeUndefined();
    } finally {
      await admin.dbh.close();
    }
  });

  it("the free run's compute cap: freeRunComputeSpent sums the run's computers only while it is free", async () => {
    const { c } = await newUser("cap");
    const runId = await runAwaitingGo(c);
    expect(await freeRunComputeSpent(db.db, runId)).toBeNull();
    await c.runs.go({ params: { id: runId } });
    expect(await freeRunComputeSpent(db.db, runId)).toBe(0n);
    await db.db.insert(computers).values([
      {
        provider: "naive",
        providerId: `a-${runId}`,
        runId,
        status: "destroyed",
        costMicroUsd: 6_000_000n,
      },
      {
        provider: "naive",
        providerId: `b-${runId}`,
        runId,
        status: "destroyed",
        costMicroUsd: 4_500_000n,
      },
    ]);
    expect(await freeRunComputeSpent(db.db, runId)).toBe(10_500_000n);
  });
});

describe.skipIf(!available)("BYOK /secrets routes (TDM-224 onboarding)", () => {
  let db: FreshDbTdm11;
  let h: RunsAppTdm67;

  beforeAll(async () => {
    db = await freshMigratedDbTdm11({ max: 4 });
    h = runsAppTdm67(db.url, { env: ENV });
  }, 60_000);

  afterAll(async () => {
    await h?.dbh.close();
    await db?.drop();
  });

  it("stores, lists (last4 only), replaces and deletes; never returns or stores the value", async () => {
    const alice = await seedUserTdm67(db.db, "keys-alice");
    const bob = await seedUserTdm67(db.db, "keys-bob");
    const a = clientFor(h, alice);
    const value = "sk-ant-api03-secretsecretsecret-WXYZ";
    const res = await h.app.request(`${BASE}/secrets/anthropic`, {
      method: "PUT",
      headers: { authorization: `Bearer ${alice}`, "content-type": "application/json" },
      body: JSON.stringify({ value }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("secretsecret");
    expect(JSON.parse(text)).toMatchObject({ secret: { provider: "anthropic", last4: "WXYZ" } });

    const [row] = await db.db.select().from(userSecrets).where(eq(userSecrets.ownerId, alice));
    expect(JSON.stringify(row)).not.toContain("secretsecret");

    expect((await a.secrets.list()).items.map((s) => [s.provider, s.last4])).toEqual([
      ["anthropic", "WXYZ"],
    ]);
    expect((await clientFor(h, bob).secrets.list()).items).toEqual([]);

    await a.secrets.put({
      params: { provider: "anthropic" },
      body: { value: "sk-ant-other-9876" },
    });
    expect((await a.secrets.list()).items.map((s) => s.last4)).toEqual(["9876"]);

    await a.secrets.delete({ params: { provider: "anthropic" } });
    await a.secrets.delete({ params: { provider: "anthropic" } });
    expect((await a.secrets.list()).items).toEqual([]);
  });

  it("503 without ANYBENCH_KEK; 400 on a bad provider; 401 signed out", async () => {
    const nokek = runsAppTdm67(db.url);
    try {
      const u = await seedUserTdm67(db.db, "keys-nokek");
      const put = (app: RunsAppTdm67, provider: string, who: string | null) =>
        app.app.request(`${BASE}/secrets/${provider}`, {
          method: "PUT",
          headers: {
            ...(who ? { authorization: `Bearer ${who}` } : {}),
            "content-type": "application/json",
          },
          body: JSON.stringify({ value: "sk-ant-test-12345678" }),
        });
      expect((await put(nokek, "anthropic", u)).status).toBe(503);
      expect((await put(h, "Not A Slug", u)).status).toBe(400);
      expect((await put(h, "anthropic", null)).status).toBe(401);
    } finally {
      await nokek.dbh.close();
    }
  });
});

describe("free-run refusal words (TDM-224, pure)", () => {
  const config = { FREE_RUN_CAP_MICRO_USD: 10_000_000n, FREE_RUN_MAX_TRIALS: 24 };
  it("says the cap in dollars and every reason in a plain sentence", () => {
    expect(dollars(10_000_000n)).toBe("$10");
    expect(dollars(2_500_000n)).toBe("$2.50");
    expect(freeRunRefusalMessage("over_compute_cap", config)).toContain("($10)");
    expect(freeRunRefusalMessage("pool_exhausted", config)).toMatch(
      /^Free runs are paused right now/,
    );
    for (const code of [
      "too_many_setups",
      "too_many_trials",
      "managed_tokens",
      "undeclared_tokens",
      "no_byok_key",
      "missing_provider_key",
      "over_compute_cap",
      "pool_off",
      "unknown_user",
      "no_github_account_age",
      "github_account_too_new",
      "already_used",
      "in_use",
      "pool_exhausted",
    ] as const) {
      expect(freeRunRefusalMessage(code, config)).toMatch(/\.$/);
    }
  });
});
