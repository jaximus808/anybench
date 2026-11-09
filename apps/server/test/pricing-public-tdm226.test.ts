// TDM-226 [20.4]: the public pricing reads. GET /billing/pricing answers the pricing page's numbers
// from this deployment's billing config (pure: no database); GET /billing/free-pool answers only
// `open` or `paused`, unauthenticated and cacheable, against local Postgres (skips without it).
import {
  publicPricingFigures,
  HEAD_TO_HEAD_EXAMPLE_KIT,
  STARTER_EXAMPLE_KIT,
  estimateRunCost,
} from "@anybench/billing";
import {
  apiRoutes,
  encodeRouteResponse,
  PublicFreePoolSchema,
  PublicPricingSchema,
} from "@anybench/core";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDb, type DbHandle } from "../src/db/client.js";
import { freeRunPool } from "../src/db/schema/index.js";
import { freeRunConfigFrom, publicPricingFor } from "../src/lib/free-run.js";
import { PUBLIC_BILLING_CACHE_CONTROL } from "../src/routes/billing.js";
import type { AppDeps } from "../src/types.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";
import { recordingJobsTdm67 } from "./helpers/runs-tdm67.js";
import { recordingSentryTdm14, silentLoggerTdm14 } from "./helpers/server-tdm14.js";

const available = await pgAvailableTdm11();
const BASE = "http://api.test";

function appWith(url: string, env: Record<string, string> = {}) {
  const config = loadConfig({
    DATABASE_URL: url,
    DATABASE_URL_DIRECT: url,
    LOG_LEVEL: "silent",
    ...env,
  });
  const dbh = createDb(url, { max: 2 });
  const deps: AppDeps = {
    config,
    logger: silentLoggerTdm14(),
    db: dbh.db,
    sentry: recordingSentryTdm14(),
    // Nobody is signed in: the public reads must not need it.
    authenticate: async () => null,
    jobs: recordingJobsTdm67(),
    stripeBilling: null,
  };
  return { app: createApp(deps), dbh };
}

describe("GET /billing/pricing numbers (TDM-226)", () => {
  it("are the billing config's own values and estimateRunCost on the example kits", () => {
    const config = loadConfig({ LOG_LEVEL: "silent" });
    const p = PublicPricingSchema.parse(publicPricingFor(config));
    expect(p.rates.run_fee_micro_usd).toBe(config.RUN_FEE_MICRO_USD);
    expect(p.rates.uploaded_kit_run_fee_micro_usd).toBe(config.UPLOADED_KIT_RUN_FEE_MICRO_USD);
    expect(BigInt(p.rates.compute_markup_bps)).toBe(config.COMPUTE_MARKUP_BPS);
    expect(BigInt(p.rates.managed_token_markup_bps)).toBe(config.MANAGED_TOKEN_MARKUP_BPS);
    expect(p.free_run).toMatchObject({
      offered: config.FREE_RUN_POOL_MICRO_USD > 0n,
      max_trials: config.FREE_RUN_MAX_TRIALS,
      compute_cap_micro_usd: config.FREE_RUN_CAP_MICRO_USD,
    });
    const pricing = {
      runFeeMicroUsd: config.RUN_FEE_MICRO_USD,
      uploadedKitRunFeeMicroUsd: config.UPLOADED_KIT_RUN_FEE_MICRO_USD,
      computeMarkupBps: config.COMPUTE_MARKUP_BPS,
      defaultBlockPriceMicroUsd: config.COMPUTER_BLOCK_PRICE_MICRO_USD,
    };
    const [starter, h2h] = p.examples;
    const s = estimateRunCost(STARTER_EXAMPLE_KIT, pricing);
    const h = estimateRunCost(HEAD_TO_HEAD_EXAMPLE_KIT, pricing);
    expect(starter).toMatchObject({ id: "starter", free: true, total_micro_usd: s.totalMicroUsd });
    expect(starter!.compute.charge_micro_usd).toBe(s.compute.chargeMicroUsd);
    expect(starter!.compute.blocks).toBe(Number(s.compute.blocks));
    expect(h2h).toMatchObject({
      id: "head_to_head",
      free: false,
      total_micro_usd: h.totalMicroUsd,
    });
    expect(h2h!.run_fee_micro_usd).toBe(config.RUN_FEE_MICRO_USD);
    // The same figures packages/billing computes, field for field.
    const f = publicPricingFigures({
      runFeeMicroUsd: config.RUN_FEE_MICRO_USD,
      uploadedKitRunFeeMicroUsd: config.UPLOADED_KIT_RUN_FEE_MICRO_USD,
      computeMarkupBps: config.COMPUTE_MARKUP_BPS,
      managedTokenMarkupBps: config.MANAGED_TOKEN_MARKUP_BPS,
      defaultBlockPriceMicroUsd: config.COMPUTER_BLOCK_PRICE_MICRO_USD,
      freeRun: freeRunConfigFrom(config),
    });
    expect(p.rates.machine.block_charge_micro_usd).toBe(f.rates.machine.blockChargeMicroUsd);
  });

  it("match the web app's pricing fixture byte for byte at the default config", () => {
    // apps/web renders this fixture in its pricing test; if the billing math or a default changes,
    // regenerate it from publicPricingFor so both sides keep testing the same numbers.
    const fixture = JSON.parse(
      readFileSync(
        new URL("../../web/test/fixtures/public-pricing-defaults.json", import.meta.url),
        "utf8",
      ),
    ) as unknown;
    const wire = encodeRouteResponse(
      apiRoutes.billing.pricing,
      publicPricingFor(loadConfig({ LOG_LEVEL: "silent" })),
    );
    expect(wire).toEqual(fixture);
  });

  it("follow an overridden config (nothing on the page is a fixed number)", () => {
    const config = loadConfig({
      LOG_LEVEL: "silent",
      RUN_FEE_MICRO_USD: "3500000",
      COMPUTE_MARKUP_BPS: "2500",
      MANAGED_TOKEN_MARKUP_BPS: "1500",
      FREE_RUN_POOL_MICRO_USD: "0",
    });
    const p = publicPricingFor(config);
    expect(p.rates.run_fee_micro_usd).toBe(3_500_000n);
    expect(p.rates.compute_markup_bps).toBe(2500);
    expect(p.rates.managed_token_markup_bps).toBe(1500);
    expect(p.free_run.offered).toBe(false);
    expect(p.examples.every((e) => !e.free)).toBe(true);
  });
});

describe.skipIf(!available)(
  "GET /billing/free-pool and /billing/pricing over HTTP (TDM-226)",
  () => {
    let db: FreshDbTdm11;
    let h: { app: ReturnType<typeof createApp>; dbh: DbHandle };
    let off: { app: ReturnType<typeof createApp>; dbh: DbHandle };

    beforeAll(async () => {
      db = await freshMigratedDbTdm11({ max: 4 });
      h = appWith(db.url);
      off = appWith(db.url, { FREE_RUN_POOL_MICRO_USD: "0" });
    }, 60_000);

    afterAll(async () => {
      await h?.dbh.close();
      await off?.dbh.close();
      await db?.drop();
    });

    async function pool(app: ReturnType<typeof createApp>) {
      const res = await app.request(`${BASE}/billing/free-pool`);
      return { res, body: (await res.json()) as Record<string, unknown> };
    }

    it("needs no session, is cacheable for 60 s, and says only open", async () => {
      const { res, body } = await pool(h.app);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe(PUBLIC_BILLING_CACHE_CONTROL);
      expect(body).toEqual({ state: "open" });
      expect(PublicFreePoolSchema.parse(body).state).toBe("open");
      // The session-only billing routes still refuse an anonymous caller.
      expect((await h.app.request(`${BASE}/billing/summary`)).status).toBe(401);
    });

    it("says paused once the pool cannot fund a starter, with no amounts in the answer", async () => {
      await db.db
        .insert(freeRunPool)
        .values({ id: "global", reservedMicroUsd: 30_000_000n, spentMicroUsd: 15_000_000n })
        .onConflictDoUpdate({
          target: freeRunPool.id,
          set: { reservedMicroUsd: 30_000_000n, spentMicroUsd: 15_000_000n },
        });
      // $50 pool - $45 used = $5 left < one $12 default starter.
      const { body } = await pool(h.app);
      expect(body).toEqual({ state: "paused" });
      expect(JSON.stringify(body)).not.toMatch(/micro|usd|remaining|\d/i);
      await db.db.update(freeRunPool).set({ reservedMicroUsd: 0n, spentMicroUsd: 0n });
      expect((await pool(h.app)).body).toEqual({ state: "open" });
    });

    it("says paused when free runs are switched off (FREE_RUN_POOL_MICRO_USD=0)", async () => {
      expect((await pool(off.app)).body).toEqual({ state: "paused" });
    });

    it("GET /billing/pricing is public, cacheable and parses as the contract", async () => {
      const res = await h.app.request(`${BASE}/billing/pricing`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe(PUBLIC_BILLING_CACHE_CONTROL);
      const p = PublicPricingSchema.parse(await res.json());
      expect(p.rates.run_fee_micro_usd).toBe(2_000_000n);
      expect(p.examples.map((e) => e.id)).toEqual(["starter", "head_to_head"]);
    });
  },
);
