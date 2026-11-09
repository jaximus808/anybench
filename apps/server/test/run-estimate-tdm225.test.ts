// TDM-225 [20.3]: GET /runs/:id/estimate against local Postgres (skips without it). A starter run
// for an account that still has its free run is `free`, with the normal price line by line; past a
// starter limit it is `paid` and says which limit and that a card is needed; a paused pool says so
// and shows the normal price. The same rules Go applies (lib/free-run.ts freeRunAtGo).
import {
  ApiClientError,
  createApiClient,
  PROOF_CHECKS,
  type ApiClient,
  type KitSpec,
} from "@anybench/core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { billingAccounts, kits, runs, users } from "../src/db/schema/index.js";
import type { Database } from "../src/db/client.js";
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
const ENV = { ANYBENCH_KEK: "tdm225-test-kek-0123456789abcdefghijklmnop" };
const YEAR_AGO = new Date(Date.now() - 365 * 86_400_000);

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

async function seedProvenKit(db: Database, runId: string, repeats: number): Promise<void> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  const proof = PROOF_CHECKS.map((check) => ({
    check,
    pass: true,
    reason: "seeded",
    evidence: [],
  }));
  const spec = { ...kitSpecTdm67(), repeats } as KitSpec;
  const [kit] = await db
    .insert(kits)
    .values({ ownerId: run!.ownerId, runId, version: 1, spec, proof, hash: "c".repeat(64) })
    .returning({ id: kits.id });
  await db.update(runs).set({ kitId: kit!.id }).where(eq(runs.id, runId));
}

describe.skipIf(!available)(
  "GET /runs/:id/estimate: the starter run shows 'Free' (TDM-225)",
  () => {
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

    async function newUser(app: RunsAppTdm67, login: string, key = true) {
      const id = await seedUserTdm67(db.db, login);
      await db.db.update(users).set({ githubCreatedAt: YEAR_AGO }).where(eq(users.id, id));
      const c = clientFor(app, id);
      if (key) {
        await c.secrets.put({
          params: { provider: "anthropic" },
          body: { value: "sk-ant-test-0000000000001234" },
        });
      }
      return { id, c };
    }

    async function runWithKit(c: ApiClient, repeats: number): Promise<string> {
      const run = (await c.runs.create({ body: githubBody })).run;
      await forceRunStateTdm67(db.db, run.id, "awaiting_go", 2_000_000n);
      await seedProvenKit(db.db, run.id, repeats);
      return run.id;
    }

    it("free: a starter run costs 0 and still shows the normal price line by line", async () => {
      const { c } = await newUser(h, "est-free");
      const runId = await runWithKit(c, 3); // 2 contenders x 2 workloads x 3 = 12 trials (+ warm-ups)
      const { estimate } = await c.runs.estimate({ params: { id: runId } });
      expect(estimate.price).toBe("free");
      expect(estimate.total_micro_usd).toBe(0n);
      expect(estimate.card_needed).toBe(false);
      expect(estimate.normal.run_fee_micro_usd).toBe(2_000_000n);
      expect(estimate.normal.total_micro_usd).toBe(
        estimate.normal.run_fee_micro_usd + estimate.normal.compute.charge_micro_usd,
      );
      expect(estimate.free_run).toMatchObject({
        status: "available",
        applies: true,
        refusal: null,
        setups: 2,
        limits: { max_setups: 2, max_trials: 24 },
      });
      // Go agrees: the run goes free, and the estimate keeps saying so while it holds the free run.
      expect((await c.runs.go({ params: { id: runId } })).run.state).toBe("running");
      const after = (await c.runs.estimate({ params: { id: runId } })).estimate;
      expect(after.price).toBe("free");
      expect(after.free_run).toMatchObject({ status: "in_use", applies: true });
    });

    it("past the limits: paid at the normal price, which limit, and a card is needed", async () => {
      const { id, c } = await newUser(h, "est-big");
      const runId = await runWithKit(c, 10); // 40+ trials > FREE_RUN_MAX_TRIALS (24)
      const { estimate } = await c.runs.estimate({ params: { id: runId } });
      expect(estimate.price).toBe("paid");
      expect(estimate.total_micro_usd).toBe(estimate.normal.total_micro_usd);
      expect(estimate.card_needed).toBe(true);
      expect(estimate.free_run?.applies).toBe(false);
      expect(estimate.free_run?.refusal?.reason).toBe("too_many_trials");
      expect(estimate.free_run?.refusal?.message).toContain("at most 24 trials");

      await db.db
        .insert(billingAccounts)
        .values({ userId: id, paymentStatus: "ok", hasPaymentMethod: true })
        .onConflictDoUpdate({
          target: billingAccounts.userId,
          set: { paymentStatus: "ok", hasPaymentMethod: true },
        });
      expect((await c.runs.estimate({ params: { id: runId } })).estimate.card_needed).toBe(false);
    });

    it("pool paused: says so and shows the paid price", async () => {
      const small = runsAppTdm67(db.url, { env: { ...ENV, FREE_RUN_POOL_MICRO_USD: "1000" } });
      try {
        const { c } = await newUser(small, "est-paused");
        const runId = await runWithKit(c, 3);
        const { estimate } = await c.runs.estimate({ params: { id: runId } });
        expect(estimate.price).toBe("paid");
        expect(estimate.total_micro_usd).toBeGreaterThan(0n);
        expect(estimate.free_run).toMatchObject({
          status: "paused",
          applies: false,
          refusal: { reason: "pool_exhausted" },
        });
        expect(estimate.card_needed).toBe(true);
      } finally {
        await small.dbh.close();
      }
    });

    it("409 before the run has a kit; 404 for someone else's run", async () => {
      const { c } = await newUser(h, "est-nokit");
      const run = (await c.runs.create({ body: githubBody })).run;
      const err = await c.runs.estimate({ params: { id: run.id } }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiClientError);
      expect((err as ApiClientError).status).toBe(409);
      const other = await newUser(h, "est-other", false);
      const err2 = await other.c.runs.estimate({ params: { id: run.id } }).catch((e: unknown) => e);
      expect((err2 as ApiClientError).status).toBe(404);
    });
  },
);
