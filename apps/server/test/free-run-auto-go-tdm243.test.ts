// TDM-243 [20.6]: free-run follow-ups, against local Postgres (skips without it).
//   - auto-go (the orchestrator, awaiting_go with auto_go) makes the same Go decision as
//     POST /runs/:id/go (lib/go.ts startRunAtGo): an eligible starter run starts free with no
//     card; a refusal leaves the run in awaiting_go with ONE run.go_refused event carrying the
//     sentence the Go button shows; TDM-244's managed-token card rule applies; a reservation made
//     by an auto-go whose commit fails goes back;
//   - cancel while awaiting_go releases a free run the run still holds (user_cancel_before_go),
//     settleFreeRun applies the same rule if the ledger gets there first, and a user cancel after
//     Go still consumes the free run (TDM-223).
import { settleFreeRun } from "@anybench/billing";
import {
  ApiClientError,
  createApiClient,
  paymentRequiredMessage,
  PAYMENT_REQUIRED_WORDS,
  PaymentRequiredSchema,
  PROOF_CHECKS,
  type ApiClient,
  type KitSpec,
  type PaymentRequired,
} from "@anybench/core";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import type { Database } from "../src/db/client.js";
import {
  billingAccounts,
  events,
  freeRunPool,
  freeStarterRuns,
  kits,
  runs,
  users,
} from "../src/db/schema/index.js";
import { defaultBillingGate, MANAGED_TOKENS_NEED_CARD_MESSAGE } from "../src/lib/billing-gate.js";
import { freeRunAtGo, freeRunRefusalMessage } from "../src/lib/free-run.js";
import { advanceRun, type OrchestratorDeps } from "../src/orchestrator/advance.js";
import { MemQueueTdm54 } from "./helpers/orchestrator-tdm54.js";
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
const KEK = "tdm243-test-kek-0123456789abcdefghijklmnop";
const YEAR_AGO = new Date(Date.now() - 365 * 86_400_000);
const ENV = { ANYBENCH_KEK: KEK };

const githubBody = {
  question: "Is ripgrep faster than grep on large trees?",
  source: { kind: "github" as const, github: "BurntSushi/ripgrep", ref: "14.1.1" },
  budget_micro_usd: 5_000_000n,
  auto_go: true,
};

/** The orchestrator stops here: these tests are about the Go, not the trials. */
class AtRunning extends Error {}

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

/** Two agent contenders, the first on Anybench's model tokens (TDM-244). */
function managedKit(): KitSpec {
  const agent = (id: string, role: string, source: string) => ({
    id,
    role,
    source: { github: "example/agent", ref: id },
    driver: {
      type: "coding-agent",
      verbs: { run: "run {task} {workspace}" },
      model: "claude-opus-5-5",
      env: { CC_SETUP: id, AB_TOKEN_SOURCE: source },
    },
  });
  return {
    ...kitSpecTdm67(),
    repeats: 3,
    contenders: [
      agent("ours", "subject", "naive_proxy"),
      agent("byok", "baseline", "anthropic_key"),
    ],
  } as unknown as KitSpec;
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
    .values({ ownerId: run!.ownerId, runId, version: 1, spec, proof, hash: "c".repeat(64) })
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

describe.skipIf(!available)("free run follow-ups (TDM-243)", () => {
  let db: FreshDbTdm11;
  let h: RunsAppTdm67;
  let config: Config;

  beforeAll(async () => {
    db = await freshMigratedDbTdm11({ max: 4 });
    h = runsAppTdm67(db.url, { env: ENV });
    config = loadConfig({
      DATABASE_URL: db.url,
      DATABASE_URL_DIRECT: db.url,
      LOG_LEVEL: "silent",
      PUBLIC_WEB_URL: "https://anybench.jaxonp.com",
      ALLOWED_ORIGINS: "https://anybench.jaxonp.com",
      ...ENV,
    });
  }, 60_000);

  afterAll(async () => {
    await h?.dbh.close();
    await db?.drop();
  });

  /** The orchestrator as the run.advance job wires it (goConfig + the default gate). */
  function orchestrator(extra: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
    return {
      db: db.db,
      jobs: new MemQueueTdm54(),
      agents: {} as never,
      pipeline: {} as never,
      sessions: {} as never,
      billingGate: defaultBillingGate(config, db.db),
      goConfig: config,
      charges: null,
      owner: "tdm243-worker~1",
      paused: false,
      beforeStage: async (state) => {
        if (state === "running") throw new AtRunning("stop at running");
      },
      ...extra,
    };
  }

  /** advanceRun until it stops; the run reaching `running` ends it with AtRunning. */
  async function autoGo(runId: string, extra: Partial<OrchestratorDeps> = {}) {
    try {
      return await advanceRun(orchestrator(extra), runId);
    } catch (err) {
      if (err instanceof AtRunning) return { kind: "at_running" as const };
      throw err;
    }
  }

  async function newUser(
    login: string,
    opts: { key?: boolean; card?: boolean } = {},
  ): Promise<{ id: string; c: ApiClient }> {
    const id = await seedUserTdm67(db.db, login);
    await db.db.update(users).set({ githubCreatedAt: YEAR_AGO }).where(eq(users.id, id));
    const c = clientFor(h, id);
    if (opts.key ?? true) {
      await c.secrets.put({
        params: { provider: "anthropic" },
        body: { value: "sk-ant-test-0000000000002430" },
      });
    }
    if (opts.card) {
      await db.db.insert(billingAccounts).values({
        userId: id,
        paymentStatus: "ok",
        hasPaymentMethod: true,
      });
    }
    return { id, c };
  }

  async function runAwaitingGo(c: ApiClient, spec: KitSpec, autoGoOn = true): Promise<string> {
    const run = (await c.runs.create({ body: { ...githubBody, auto_go: autoGoOn } })).run;
    await forceRunStateTdm67(db.db, run.id, "awaiting_go", 2_000_000n);
    await seedProvenKit(db.db, run.id, spec);
    return run.id;
  }

  const runRow = async (id: string) => (await db.db.select().from(runs).where(eq(runs.id, id)))[0]!;
  const freeRows = (runId: string) =>
    db.db.select().from(freeStarterRuns).where(eq(freeStarterRuns.runId, runId));
  const poolReserved = async () =>
    (await db.db.select().from(freeRunPool).where(eq(freeRunPool.id, "global")))[0]
      ?.reservedMicroUsd ?? 0n;
  const runEvents = (runId: string, type: string) =>
    db.db
      .select()
      .from(events)
      .where(and(eq(events.runId, runId), eq(events.type, type)))
      .orderBy(asc(events.seq));

  it("auto-go starts an eligible starter run free with no card", async () => {
    const { id, c } = await newUser("auto-free");
    const runId = await runAwaitingGo(c, kitWithRepeats(3));
    const before = await poolReserved();

    expect(await autoGo(runId)).toEqual({ kind: "at_running" });

    expect((await runRow(runId)).state).toBe("running");
    const [row] = await freeRows(runId);
    expect(row).toMatchObject({ userId: id, state: "reserved" });
    expect(await poolReserved()).toBe(before + row!.reservedMicroUsd);
    // No card was asked for, and none exists.
    expect(
      await db.db.select().from(billingAccounts).where(eq(billingAccounts.userId, id)),
    ).toEqual([]);
    const changed = await runEvents(runId, "run.state_changed");
    expect(changed.at(-1)!.payload).toMatchObject({
      from: "awaiting_go",
      to: "running",
      command: "go",
      reason: "auto-go: free starter run",
    });
    expect(await runEvents(runId, "run.go_refused")).toEqual([]);
  });

  it("auto-go refuses a non-starter with no card in the Go button's words, once, and stays in awaiting_go", async () => {
    const { c } = await newUser("auto-big", { key: false });
    const runId = await runAwaitingGo(c, kitWithRepeats(10)); // 40 trials > 24
    const before = await poolReserved();

    const out = await autoGo(runId);
    expect(out).toEqual({
      kind: "waiting",
      state: "awaiting_go",
      reason: "billing gate: no_payment_method",
    });
    expect((await runRow(runId)).state).toBe("awaiting_go");
    expect(await freeRows(runId)).toEqual([]);
    expect(await poolReserved()).toBe(before);

    const [ev, ...more] = await runEvents(runId, "run.go_refused");
    expect(more).toEqual([]);
    expect(ev).toMatchObject({ source: "run", severity: "warn" });
    const words = freeRunRefusalMessage("too_many_trials", config);
    expect(ev!.payload).toEqual({
      reason: "no_payment_method",
      message: words,
      link_card_url: `https://anybench.jaxonp.com/settings/billing?run=${runId}`,
      free_run_reason: "too_many_trials",
    });

    // The Go button gets the same decision and shows the same sentence.
    const body = await expect402(c.runs.go({ params: { id: runId } }));
    expect(paymentRequiredMessage(body)).toBe(words);

    // The sweep runs auto-go again: the same refusal is not written twice.
    await autoGo(runId);
    expect(await runEvents(runId, "run.go_refused")).toHaveLength(1);

    // A card lands: the next auto-go starts it on the card, nothing free reserved.
    await db.db
      .insert(billingAccounts)
      .values({
        userId: (await runRow(runId)).ownerId,
        paymentStatus: "ok",
        hasPaymentMethod: true,
      });
    expect(await autoGo(runId)).toEqual({ kind: "at_running" });
    expect((await runRow(runId)).state).toBe("running");
    expect(await freeRows(runId)).toEqual([]);
  });

  it("auto-go applies TDM-244: a kit on Anybench's tokens with no card is refused with its sentence", async () => {
    const { c } = await newUser("auto-managed");
    const runId = await runAwaitingGo(c, managedKit());

    expect(await autoGo(runId)).toMatchObject({
      kind: "waiting",
      reason: "billing gate: managed_tokens_need_card",
    });
    const [ev] = await runEvents(runId, "run.go_refused");
    expect(ev!.payload).toMatchObject({
      reason: "managed_tokens_need_card",
      message: MANAGED_TOKENS_NEED_CARD_MESSAGE,
      free_run_reason: "managed_tokens",
    });
    const body = await expect402(c.runs.go({ params: { id: runId } }));
    expect(paymentRequiredMessage(body)).toBe(MANAGED_TOKENS_NEED_CARD_MESSAGE);
    expect(await freeRows(runId)).toEqual([]);
  });

  it("auto-go off: the run waits for Go, and no refusal is written", async () => {
    const { c } = await newUser("auto-off", { key: false });
    const runId = await runAwaitingGo(c, kitWithRepeats(10), false);
    expect(await autoGo(runId)).toEqual({
      kind: "waiting",
      state: "awaiting_go",
      reason: "waiting for Go",
    });
    expect(await runEvents(runId, "run.go_refused")).toEqual([]);
  });

  it("auto-go gives the free run back when its commit fails", async () => {
    const { c } = await newUser("auto-release");
    const runId = await runAwaitingGo(c, kitWithRepeats(3));
    const before = await poolReserved();
    await expect(
      autoGo(runId, {
        onStateChange: async (_tx, change) => {
          if (change.to === "running") throw new Error("notify queue down");
        },
      }),
    ).rejects.toThrow("notify queue down");
    expect((await runRow(runId)).state).toBe("awaiting_go");
    expect(await freeRows(runId)).toMatchObject([
      { state: "released", releaseReason: "go_failed" },
    ]);
    expect(await poolReserved()).toBe(before);
    expect((await c.billing.summary()).free_run?.status).toBe("available");
  });

  it("cancel in awaiting_go returns a stuck reservation and the entitlement", async () => {
    const { id, c } = await newUser("cancel-stuck");
    const runId = await runAwaitingGo(c, kitWithRepeats(3), false);
    const before = await poolReserved();
    // The crash between Go's reserve and its transition: reserved, still awaiting_go.
    const free = await freeRunAtGo({ db: db.db, config }, { userId: id, run: await runRow(runId) });
    expect(free).toMatchObject({ kind: "reserved", created: true });
    expect(await poolReserved()).toBeGreaterThan(before);
    expect((await c.billing.summary()).free_run?.status).toBe("in_use");

    const cancelled = await c.runs.cancel({ params: { id: runId }, body: {} });
    expect(cancelled.run.state).toBe("cancelled");

    expect(await freeRows(runId)).toMatchObject([
      { state: "released", releaseReason: "user_cancel_before_go" },
    ]);
    expect(await poolReserved()).toBe(before);
    expect((await c.billing.summary()).free_run?.status).toBe("available");
    expect((await runRow(runId)).stageOutputs).toMatchObject({ cancelled_from: "awaiting_go" });
    // The ledger finalizing the run later finds nothing to settle.
    expect(await settleFreeRun(db.db, { runId })).toEqual({ status: "not_free_run" });
    // A repeated cancel is still fine.
    expect((await c.runs.cancel({ params: { id: runId }, body: {} })).run.state).toBe("cancelled");

    // The account's free run is back: its next starter run takes it.
    const next = await runAwaitingGo(c, kitWithRepeats(3), false);
    expect((await c.runs.go({ params: { id: next } })).run.state).toBe("running");
    expect(await freeRows(next)).toMatchObject([{ state: "reserved" }]);
  });

  it("settleFreeRun releases a run cancelled before Go too; a user cancel after Go still consumes", async () => {
    // The cancel's own release did not happen (say it failed): the ledger's settle decides alike.
    const a = await newUser("settle-before-go");
    const before = await runAwaitingGo(a.c, kitWithRepeats(3), false);
    await freeRunAtGo({ db: db.db, config }, { userId: a.id, run: await runRow(before) });
    await db.db
      .update(runs)
      .set({
        state: "cancelled",
        cancelCause: "user",
        stageOutputs: { cancelled_from: "awaiting_go" },
      })
      .where(eq(runs.id, before));
    expect(await settleFreeRun(db.db, { runId: before })).toMatchObject({
      status: "released",
      freeRun: { releaseReason: "user_cancel_before_go" },
    });

    // After Go (TDM-223's rule): the cancel does not release it, and settling consumes it.
    const b = await newUser("cancel-after-go");
    const after = await runAwaitingGo(b.c, kitWithRepeats(3), false);
    expect((await b.c.runs.go({ params: { id: after } })).run.state).toBe("running");
    expect((await b.c.runs.cancel({ params: { id: after }, body: {} })).run.state).toBe(
      "cancelled",
    );
    expect(await freeRows(after)).toMatchObject([{ state: "reserved" }]);
    expect((await runRow(after)).stageOutputs).not.toHaveProperty("cancelled_from");
    expect(await settleFreeRun(db.db, { runId: after })).toMatchObject({
      status: "consumed",
    });
    expect((await b.c.billing.summary()).free_run?.status).toBe("used");
  });
});

describe("the Go refusal sentence (TDM-243, pure)", () => {
  it("prefers the free run's reason with no card, then the server's message, then the reason", () => {
    const free_run = {
      reason: "already_used" as const,
      reasons: [{ code: "already_used" as const, message: "You've used your free run." }],
      message: "You've used your free run.",
    };
    expect(paymentRequiredMessage({ reason: "no_payment_method", free_run })).toBe(
      "You've used your free run.",
    );
    expect(
      paymentRequiredMessage({
        reason: "managed_tokens_need_card",
        free_run,
        message: MANAGED_TOKENS_NEED_CARD_MESSAGE,
      }),
    ).toBe(MANAGED_TOKENS_NEED_CARD_MESSAGE);
    expect(paymentRequiredMessage({ reason: "spend_limit", free_run })).toBe(
      PAYMENT_REQUIRED_WORDS.spend_limit,
    );
  });
});
