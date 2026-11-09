// TDM-223 [20.1]: the free starter run entitlement and the global pool. Pure rules first, then
// the Postgres behavior (local docker-compose.dev.yml Postgres): eligibility, Go reservations under
// real concurrent transactions, release, settle on every outcome, the entitlement used once, and
// the ledger balance after a free run.
import { KitSpecSchema, type KitSpecInput } from "@anybench/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applySignupGrant,
  createLedger,
  estimateRunCost,
  FREE_RUN_METER_PREFIX,
  freePoolStatus,
  freeRunEligibility,
  freeRunForRun,
  githubAgeEligible,
  isStarterRun,
  kitSetupCount,
  kitTokenUse,
  poolStatusFrom,
  releaseFreeRun,
  reserveFreeRun,
  settleFreeRun,
  type FreeRunConfigInput,
  type Ledger,
  type RunCostEstimate,
} from "../src/index.js";
import { addComputerTdm171, setRunStateTdm171 } from "./helpers/pg-tdm171.js";
import {
  freshMigratedDbTdm87,
  pgAvailableTdm87,
  seedUserTdm87,
  setTrialStateTdm87,
  type FixtureUserTdm87,
  type FreshDbTdm87,
} from "./helpers/pg-tdm87.js";

const available = await pgAvailableTdm87();

const RUN_FEE = 2_000_000n;
const PRICING = {
  runFeeMicroUsd: RUN_FEE,
  computeMarkupBps: 5000,
  defaultBlockPriceMicroUsd: 27_600n,
};

function cliKit(over: Partial<KitSpecInput> = {}): KitSpecInput {
  return {
    schema_version: 2,
    subject: { kind: "software", name: "tool", summary: "A CLI", better_means: ["faster"] },
    contenders: [
      {
        id: "new",
        role: "subject",
        source: { github: "example/tool", ref: "v2" },
        driver: { type: "cli", verbs: { run: "run {in} {out}" } },
      },
      {
        id: "old",
        role: "baseline",
        source: { github: "example/tool", ref: "v1" },
        driver: { type: "cli", verbs: { run: "run {in} {out}" } },
      },
    ],
    workloads: [{ id: "small" }, { id: "large" }],
    gates: [{ id: "same-output", kind: "output-diff" }],
    requirements: [
      {
        id: "wall",
        type: "measured",
        title: "Wall time",
        metric: "wall_s",
        better: "lower",
        gate_id: "same-output",
      },
    ],
    proof: { oracle: { id: "reference", dir: "proof/oracle/" } },
    scoring: { weights: { wall: 100 } },
    repeats: 3,
    ...over,
  } as KitSpecInput;
}

/** Two coding-agent contenders reading `source` tokens. */
function agentKit(sources: [string | undefined, string | undefined]): KitSpecInput {
  const base = cliKit();
  const agent = (id: string, role: string, source: string | undefined) => ({
    id,
    role,
    source: { github: "example/agent", ref: id },
    driver: {
      type: "coding-agent",
      verbs: { run: "run {task} {workspace}" },
      model: "claude-opus-5-5",
      env: source === undefined ? { CC_SETUP: id } : { CC_SETUP: id, AB_TOKEN_SOURCE: source },
    },
  });
  return {
    ...base,
    contenders: [agent("a", "subject", sources[0]), agent("b", "baseline", sources[1])],
  } as KitSpecInput;
}

const estimate = (kit: KitSpecInput, kitOrigin: "generated" | "uploaded" = "generated") =>
  estimateRunCost(kit, PRICING, { kitOrigin });

function config(over: Partial<FreeRunConfigInput> = {}): FreeRunConfigInput {
  return {
    poolMicroUsd: 50_000_000n,
    capMicroUsd: 10_000_000n,
    maxTrials: 24,
    runFeeMicroUsd: RUN_FEE,
    ...over,
  };
}

// ---- Pure ---------------------------------------------------------------------------------------

describe("free starter run rules (TDM-223, pure)", () => {
  it("githubAgeEligible: strictly older than 90 days; no GitHub creation date is never eligible", () => {
    const now = new Date("2026-11-09T00:00:00Z");
    const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
    expect(githubAgeEligible(daysAgo(400), now)).toBe(true);
    expect(githubAgeEligible(daysAgo(91), now)).toBe(true);
    expect(githubAgeEligible(daysAgo(90), now)).toBe(false);
    expect(githubAgeEligible(daysAgo(3), now)).toBe(false);
    expect(githubAgeEligible(null, now)).toBe(false);
    expect(githubAgeEligible(undefined, now)).toBe(false);
  });

  it("kitSetupCount counts contenders times the vary combinations that apply to them", () => {
    expect(kitSetupCount(cliKit())).toBe(2);
    const varied = agentKit(["anthropic_key", "anthropic_key"]);
    (varied as { vary?: Record<string, string[]> }).vary = {
      CC_SETUP: ["x", "y"],
      OTHER: ["1", "2"],
    };
    // CC_SETUP is set on both contenders (2 values each); OTHER on neither.
    expect(kitSetupCount(varied)).toBe(4);
  });

  it("kitTokenUse sorts contenders into ours (naive_proxy), BYOK, and undeclared agents", () => {
    expect(kitTokenUse(agentKit(["naive_proxy", "anthropic_key"]))).toEqual({
      managed: ["a"],
      byok: [{ contenderId: "b", provider: "anthropic" }],
      undeclared: [],
    });
    expect(kitTokenUse(agentKit(["openai_key", undefined]))).toEqual({
      managed: [],
      byok: [{ contenderId: "a", provider: "openai" }],
      undeclared: ["b"],
    });
    expect(kitTokenUse(cliKit())).toEqual({ managed: [], byok: [], undeclared: [] });
  });

  it("isStarterRun accepts a small BYOK kit and reserves compute at our cost + the run fee", () => {
    const kit = cliKit();
    const est = estimate(kit);
    const d = isStarterRun(kit, est, { byokProviders: ["anthropic"], config: config() });
    expect(d.starter).toBe(true);
    if (!d.starter) throw new Error("unreachable");
    expect(d.setups).toBe(2);
    expect(d.trials).toBe(est.compute.trials);
    expect(d.computeCostMicroUsd).toBe(est.compute.costMicroUsd);
    expect(d.agentAllowanceMicroUsd).toBe(RUN_FEE);
    expect(d.reserveMicroUsd).toBe(est.compute.costMicroUsd + RUN_FEE);
  });

  it("isStarterRun: an uploaded kit has no agent allowance, and already-used compute counts", () => {
    const kit = cliKit();
    const est = estimate(kit, "uploaded");
    const d = isStarterRun(kit, est, {
      byokProviders: ["openai"],
      config: config(),
      spentCostMicroUsd: 55_200n,
    });
    if (!d.starter) throw new Error(JSON.stringify(d.reasons));
    expect(d.agentAllowanceMicroUsd).toBe(0n);
    expect(d.reserveMicroUsd).toBe(est.compute.costMicroUsd + 55_200n);
  });

  it("isStarterRun names every rule a kit breaks", () => {
    const codes = (
      kit: KitSpecInput,
      providers: string[],
      over: Partial<FreeRunConfigInput> = {},
    ) => {
      const d = isStarterRun(kit, estimate(kit), {
        byokProviders: providers,
        config: config(over),
      });
      return d.starter ? [] : d.reasons.map((r) => r.code);
    };
    const three = cliKit();
    three.contenders = [
      ...three.contenders,
      { ...three.contenders[0]!, id: "third", role: "baseline" },
    ] as KitSpecInput["contenders"];
    expect(codes(three, ["anthropic"])).toContain("too_many_setups");
    expect(codes(cliKit({ repeats: 20 }), ["anthropic"])).toContain("too_many_trials");
    expect(codes(agentKit(["naive_proxy", "anthropic_key"]), ["anthropic"])).toEqual([
      "managed_tokens",
    ]);
    expect(codes(agentKit([undefined, "anthropic_key"]), ["anthropic"])).toEqual([
      "undeclared_tokens",
    ]);
    expect(codes(cliKit(), [])).toEqual(["no_byok_key"]);
    expect(codes(agentKit(["anthropic_key", "anthropic_key"]), ["openai"])).toEqual([
      "missing_provider_key",
    ]);
    expect(codes(cliKit(), ["anthropic"], { capMicroUsd: 1n })).toEqual(["over_compute_cap"]);
    expect(codes(cliKit(), ["anthropic"], { poolMicroUsd: 0n })).toEqual(["pool_off"]);
    expect(codes(agentKit(["anthropic_key", "openai_key"]), ["anthropic", "openai"])).toEqual([]);
  });

  it("poolStatusFrom: runs remaining at the default starter size, paused when none fits", () => {
    // Default starter = $10 cap + $2 run fee = $12; $50 pool = 4 runs.
    const open = poolStatusFrom(config(), 0n, 0n);
    expect(open).toMatchObject({
      state: "open",
      availableMicroUsd: 50_000_000n,
      defaultStarterMicroUsd: 12_000_000n,
      runsRemaining: 4n,
    });
    const tight = poolStatusFrom(config(), 30_000_000n, 9_000_000n);
    expect(tight).toMatchObject({
      state: "paused",
      availableMicroUsd: 11_000_000n,
      runsRemaining: 0n,
    });
    // Over-spent (a run cost more than reserved) never reads as negative.
    expect(poolStatusFrom(config(), 0n, 60_000_000n).availableMicroUsd).toBe(0n);
    expect(poolStatusFrom(config({ poolMicroUsd: 0n }), 0n, 0n).state).toBe("paused");
  });
});

// ---- Postgres -----------------------------------------------------------------------------------

describe.skipIf(!available)("free starter run against Postgres (TDM-223)", () => {
  let h: FreshDbTdm87;
  let ledger: Ledger;
  const KIT = cliKit();
  const EST = estimate(KIT);
  const AMOUNT = EST.compute.costMicroUsd + RUN_FEE;

  beforeAll(async () => {
    KitSpecSchema.parse(KIT);
    h = await freshMigratedDbTdm87({ max: 20 });
    ledger = createLedger(h.db);
  }, 60_000);

  afterAll(async () => {
    await h?.drop();
  });

  beforeEach(async () => {
    await h.pool.query("update free_run_pool set reserved_micro_usd = 0, spent_micro_usd = 0");
  });

  const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await h.pool.query<T>(sql, params)).rows;
  const pool = async () => {
    const [row] = await q<{ reserved: string; spent: string }>(
      "select reserved_micro_usd::text as reserved, spent_micro_usd::text as spent from free_run_pool",
    );
    return { reserved: BigInt(row!.reserved), spent: BigInt(row!.spent) };
  };

  interface Account extends FixtureUserTdm87 {
    runIds: string[];
  }

  /** A user (GitHub account `ageDays` old, keys stored) with `runs` runs awaiting Go. */
  async function account(
    opts: { ageDays?: number | null; keys?: string[]; runs?: number; trials?: number } = {},
  ): Promise<Account> {
    const u = await seedUserTdm87(h.pool, opts.trials ?? 2);
    const age = opts.ageDays === undefined ? 400 : opts.ageDays;
    if (age !== null) {
      await h.pool.query(
        "update users set github_created_at = now() - make_interval(days => $1) where id = $2",
        [age, u.userId],
      );
    }
    for (const provider of opts.keys ?? ["anthropic"]) {
      await h.pool.query(
        `insert into user_secrets (owner_id, provider, ciphertext, iv, tag, wrapped_dek, kek_version, last4)
         values ($1, $2, 'c', 'i', 't', 'w', 1, 'abcd')`,
        [u.userId, provider],
      );
    }
    const runIds = [u.runId];
    for (let i = 1; i < (opts.runs ?? 1); i++) {
      const [r] = await q<{ id: string }>(
        "insert into runs (owner_id, question, budget_micro_usd) values ($1, 'q', 100000000) returning id",
        [u.userId],
      );
      runIds.push(r!.id);
    }
    for (const id of runIds) await setRunStateTdm171(h.pool, id, "awaiting_go");
    return { ...u, runIds };
  }

  const reserve = (
    a: { userId: string },
    runId: string,
    over: { cfg?: FreeRunConfigInput; est?: RunCostEstimate } = {},
  ) =>
    reserveFreeRun(
      h.db,
      { userId: a.userId, runId, kit: KIT, estimate: over.est ?? EST },
      over.cfg ?? config(),
    );

  describe("eligibility", () => {
    it("GitHub accounts older than 90 days are eligible; newer and email-only (no age) are not", async () => {
      const cfg = { config: config() };
      expect(await freeRunEligibility(h.db, (await account()).userId, cfg)).toEqual({
        eligible: true,
      });
      expect(await freeRunEligibility(h.db, (await account({ ageDays: 30 })).userId, cfg)).toEqual({
        eligible: false,
        reason: "github_account_too_new",
      });
      expect(
        await freeRunEligibility(h.db, (await account({ ageDays: null })).userId, cfg),
      ).toEqual({
        eligible: false,
        reason: "no_github_account_age",
      });
    });

    it("Go refuses an ineligible account and a non-starter run, leaving no trace", async () => {
      const young = await account({ ageDays: 10 });
      const r1 = await reserve(young, young.runId);
      expect(r1).toMatchObject({
        status: "refused",
        reason: "not_eligible",
        eligibility: "github_account_too_new",
      });
      const noKey = await account({ keys: [] });
      const r2 = await reserve(noKey, noKey.runId);
      expect(r2).toMatchObject({ status: "refused", reason: "not_starter" });
      if (r2.status === "refused" && r2.reason === "not_starter") {
        expect(r2.rejections.map((r) => r.code)).toEqual(["no_byok_key"]);
      }
      expect(await pool()).toEqual({ reserved: 0n, spent: 0n });
      expect(
        await q("select 1 from free_starter_runs where user_id = any($1)", [
          [young.userId, noKey.userId],
        ]),
      ).toHaveLength(0);
    });

    it("Go refuses a run that is not awaiting go, or whose estimate is for the wrong kit origin", async () => {
      const a = await account();
      await setRunStateTdm171(h.pool, a.runId, "running");
      expect(await reserve(a, a.runId)).toMatchObject({
        status: "refused",
        reason: "run_not_awaiting_go",
      });
      await setRunStateTdm171(h.pool, a.runId, "awaiting_go");
      expect(await reserve(a, a.runId, { est: estimate(KIT, "uploaded") })).toMatchObject({
        status: "refused",
        reason: "kit_origin_mismatch",
      });
      const other = await account();
      expect(await reserve(other, a.runId)).toMatchObject({
        status: "refused",
        reason: "run_mismatch",
      });
    });
  });

  describe("reservations", () => {
    it("reserves the starter estimate from the pool once; a repeated Go is a duplicate", async () => {
      const a = await account();
      const r = await reserve(a, a.runId);
      expect(r.status).toBe("reserved");
      if (r.status !== "reserved") throw new Error("unreachable");
      expect(r.freeRun.reservedMicroUsd).toBe(AMOUNT);
      expect(r.freeRun.agentAllowanceMicroUsd).toBe(RUN_FEE);
      expect(await pool()).toEqual({ reserved: AMOUNT, spent: 0n });
      const again = await reserve(a, a.runId);
      expect(again.status).toBe("duplicate");
      expect(await pool()).toEqual({ reserved: AMOUNT, spent: 0n });
      expect((await freeRunForRun(h.db, a.runId))?.state).toBe("reserved");
      expect(await freeRunEligibility(h.db, a.userId, { config: config() })).toMatchObject({
        eligible: false,
        reason: "in_use",
      });
    });

    it("concurrent Go presses that would exceed the pool: exactly the ones that fit succeed", async () => {
      const fits = 3;
      const cfg = config({ poolMicroUsd: AMOUNT * BigInt(fits) + AMOUNT / 2n });
      const accounts = await Promise.all(Array.from({ length: 10 }, () => account()));
      const results = await Promise.all(accounts.map((a) => reserve(a, a.runId, { cfg })));
      const reserved = results.filter((r) => r.status === "reserved");
      const exhausted = results.filter(
        (r) => r.status === "refused" && r.reason === "pool_exhausted",
      );
      expect(reserved).toHaveLength(fits);
      expect(exhausted).toHaveLength(10 - fits);
      expect(await pool()).toEqual({ reserved: AMOUNT * BigInt(fits), spent: 0n });
      const rows = await q<{ n: string }>(
        "select count(*)::text as n from free_starter_runs where state = 'reserved' and user_id = any($1)",
        [accounts.map((a) => a.userId)],
      );
      expect(rows[0]!.n).toBe(String(fits));
      const status = await freePoolStatus(h.db, cfg);
      expect(status.availableMicroUsd).toBe(AMOUNT / 2n);
      expect(status.state).toBe("paused");
    });

    it("one account pressing Go on several runs at once gets exactly one free run", async () => {
      const a = await account({ runs: 5 });
      const results = await Promise.all(a.runIds.map((id) => reserve(a, id)));
      expect(results.filter((r) => r.status === "reserved")).toHaveLength(1);
      expect(
        results.filter((r) => r.status === "refused" && r.reason === "not_eligible"),
      ).toHaveLength(4);
      expect(await pool()).toEqual({ reserved: AMOUNT, spent: 0n });
    });

    it("releaseFreeRun gives the reservation and the entitlement back when Go is abandoned", async () => {
      const a = await account();
      expect((await reserve(a, a.runId)).status).toBe("reserved");
      const rel = await releaseFreeRun(h.db, { runId: a.runId, reason: "go_abandoned" });
      expect(rel.status).toBe("released");
      expect(rel.freeRun?.releaseReason).toBe("go_abandoned");
      expect(await pool()).toEqual({ reserved: 0n, spent: 0n });
      expect(await freeRunEligibility(h.db, a.userId, { config: config() })).toEqual({
        eligible: true,
      });
      expect((await releaseFreeRun(h.db, { runId: a.runId, reason: "again" })).status).toBe(
        "not_reserved",
      );
      // The run can be pressed again later as a free run.
      expect((await reserve(a, a.runId)).status).toBe("reserved");
    });

    it("an uploaded-kit run qualifies: its proof compute comes from the pool, no agent allowance", async () => {
      const a = await account();
      await h.pool.query(
        `update runs set intake = '{"kit_origin":"uploaded"}'::jsonb where id = $1`,
        [a.runId],
      );
      // A proof computer billed with the run (TDM-218 billToRun): run id, no trial.
      await addComputerTdm171(h.pool, { runId: a.runId, trialId: null, cost: 55_200n });
      const est = estimate(KIT, "uploaded");
      const r = await reserve(a, a.runId, { est });
      if (r.status !== "reserved") throw new Error(JSON.stringify(r));
      expect(r.starter.agentAllowanceMicroUsd).toBe(0n);
      expect(r.freeRun.reservedMicroUsd).toBe(est.compute.costMicroUsd + 55_200n);
    });
  });

  describe("settle", () => {
    /** Reserve, then run: one destroyed computer per trial, and the run ends in `runState`. */
    async function runFree(trialState: string, runState: string, cost = 27_600n) {
      const a = await account({ trials: 2 });
      const r = await reserve(a, a.runId);
      if (r.status !== "reserved") throw new Error(JSON.stringify(r));
      await setRunStateTdm171(h.pool, a.runId, "running");
      expect(await settleFreeRun(h.db, { runId: a.runId })).toEqual({ status: "run_not_final" });
      const computerIds: string[] = [];
      for (const t of a.trialIds) {
        await setTrialStateTdm87(h.pool, t, trialState);
        computerIds.push(await addComputerTdm171(h.pool, { runId: a.runId, trialId: t, cost }));
      }
      await setRunStateTdm171(h.pool, a.runId, runState);
      const charges = await ledger.recordRunCharges({
        runId: a.runId,
        userId: a.userId,
        pricing: { runFeeMicroUsd: RUN_FEE, computeMarkupBps: 5000 },
      });
      return { a, charges, computerIds };
    }

    it("a delivered free run is covered by a free_run grant: the balance after it is zero", async () => {
      const { a, charges } = await runFree("done", "delivered");
      expect(charges.freeRun.status).toBe("consumed");
      // Run fee + 2 computers at cost + 50%.
      const billed = RUN_FEE + 2n * (27_600n + 13_800n);
      if (charges.freeRun.status !== "consumed") throw new Error("unreachable");
      expect(charges.freeRun.coveredMicroUsd).toBe(billed);
      const grants = await q<{ amount: string; source: string; category: string }>(
        "select amount_micro_usd::text as amount, source, category from credit_grants where user_id = $1",
        [a.userId],
      );
      expect(grants).toEqual([
        { amount: billed.toString(), source: "free_run", category: "promotional" },
      ]);
      expect(await ledger.getAccountSummary(a.userId)).toMatchObject({
        unbilled: 0n,
        granted_remaining: 0n,
      });
      const audit = await ledger.auditAccount(a.userId);
      expect(audit.ok).toBe(true);
      expect(audit.usage).toBe(billed);
      expect(audit.granted).toBe(billed);
      // Covered entries are settled: never sent to Stripe.
      expect(await ledger.listUnreported({ userId: a.userId })).toEqual([]);
      const meters = await q<{ m: string }>(
        "select stripe_meter_event_id as m from usage_entries where user_id = $1",
        [a.userId],
      );
      expect(meters).toHaveLength(3);
      for (const m of meters) expect(m.m.startsWith(FREE_RUN_METER_PREFIX)).toBe(true);
      // The pool: reservation back, actual cost (computers at our cost + agent allowance) spent.
      expect(await pool()).toEqual({ reserved: 0n, spent: 2n * 27_600n + RUN_FEE });
      expect(charges.freeRun.freeRun.state).toBe("consumed");
    });

    it("the entitlement is used once: after a consumed free run the account gets no other", async () => {
      const { a } = await runFree("done", "delivered");
      expect(await freeRunEligibility(h.db, a.userId, { config: config() })).toMatchObject({
        eligible: false,
        reason: "already_used",
      });
      const [second] = await q<{ id: string }>(
        "insert into runs (owner_id, question, budget_micro_usd, state) values ($1, 'q', 100000000, 'awaiting_go') returning id",
        [a.userId],
      );
      expect(await reserve(a, second!.id)).toMatchObject({
        status: "refused",
        reason: "not_eligible",
        eligibility: "already_used",
      });
    });

    it("a capped subject failure is a real outcome: it consumes the entitlement and is covered", async () => {
      const { a, charges } = await runFree("failed_subject", "failed");
      expect(charges.freeRun.status).toBe("consumed");
      expect(await ledger.getAccountSummary(a.userId)).toMatchObject({
        unbilled: 0n,
        granted_remaining: 0n,
      });
      expect((await ledger.auditAccount(a.userId)).ok).toBe(true);
    });

    it("an infra failure never consumes the entitlement: released, nothing billed, pool reservation back", async () => {
      const { a, charges } = await runFree("failed_infra", "failed");
      expect(charges.freeRun.status).toBe("released");
      if (charges.freeRun.status !== "released") throw new Error("unreachable");
      expect(charges.freeRun.freeRun.releaseReason).toBe("failed_not_subject");
      expect(charges.freeRun.coveredMicroUsd).toBe(0n);
      expect(await q("select 1 from usage_entries where user_id = $1", [a.userId])).toHaveLength(0);
      expect(await q("select 1 from credit_grants where user_id = $1", [a.userId])).toHaveLength(0);
      expect(await freeRunEligibility(h.db, a.userId, { config: config() })).toEqual({
        eligible: true,
      });
      // We did spend the Naïve credit: the pool records it, the reservation is back.
      expect(await pool()).toEqual({ reserved: 0n, spent: 2n * 27_600n + RUN_FEE });
    });

    it("a run we cancelled releases the entitlement; a user cancel consumes it", async () => {
      const ours = await account();
      expect((await reserve(ours, ours.runId)).status).toBe("reserved");
      await h.pool.query(
        "update runs set state = 'cancelled', cancel_cause = 'ours' where id = $1",
        [ours.runId],
      );
      const s1 = await settleFreeRun(h.db, { runId: ours.runId });
      expect(s1).toMatchObject({
        status: "released",
        freeRun: { releaseReason: "cancelled_by_us" },
      });

      const user = await account();
      expect((await reserve(user, user.runId)).status).toBe("reserved");
      await h.pool.query(
        "update runs set state = 'cancelled', cancel_cause = 'user' where id = $1",
        [user.runId],
      );
      expect((await settleFreeRun(h.db, { runId: user.runId })).status).toBe("consumed");
    });

    it("settle is idempotent, and a computer billed late is covered too", async () => {
      const { a, charges } = await runFree("done", "delivered");
      expect(charges.freeRun.status).toBe("consumed");
      const before = await pool();
      const again = await settleFreeRun(h.db, { runId: a.runId });
      expect(again).toMatchObject({ status: "consumed", coveredMicroUsd: 0n, grantId: null });
      expect(await pool()).toEqual(before);
      // A run-level computer the registry destroys after the run ended.
      const late = await addComputerTdm171(h.pool, {
        runId: a.runId,
        trialId: null,
        cost: 10_000n,
      });
      const r = await ledger.recordComputerUsage({
        computerId: late,
        userId: a.userId,
        markupBps: 5000,
      });
      expect(r.status).toBe("recorded");
      expect(await ledger.getAccountSummary(a.userId)).toMatchObject({
        unbilled: 0n,
        granted_remaining: 0n,
      });
      expect((await ledger.auditAccount(a.userId)).ok).toBe(true);
      const grants = await q(
        "select 1 from credit_grants where user_id = $1 and source = 'free_run'",
        [a.userId],
      );
      expect(grants).toHaveLength(2);
      expect(await pool()).toEqual({ reserved: 0n, spent: before.spent + 10_000n });
    });

    it("a run with no free starter run is untouched", async () => {
      const u = await seedUserTdm87(h.pool, 1);
      await setRunStateTdm171(h.pool, u.runId, "delivered");
      const charges = await ledger.recordRunCharges({
        runId: u.runId,
        userId: u.userId,
        pricing: { runFeeMicroUsd: RUN_FEE, computeMarkupBps: 5000 },
      });
      expect(charges.freeRun).toEqual({ status: "not_free_run" });
      expect(await ledger.getAccountSummary(u.userId)).toMatchObject({ unbilled: RUN_FEE });
    });
  });

  describe("signup grant (SIGNUP_GRANT_MICRO_USD, default 0)", () => {
    it("is off at 0, applies once to an eligible account when set, and skips new accounts", async () => {
      const a = await account();
      expect(await applySignupGrant(h.db, { userId: a.userId, amount: 0n })).toEqual({
        status: "off",
      });
      expect((await applySignupGrant(h.db, { userId: a.userId, amount: 5_000_000n })).status).toBe(
        "applied",
      );
      expect((await applySignupGrant(h.db, { userId: a.userId, amount: 5_000_000n })).status).toBe(
        "duplicate",
      );
      expect(await ledger.getAccountSummary(a.userId)).toMatchObject({
        granted_remaining: 5_000_000n,
      });
      const young = await account({ ageDays: 5 });
      expect(await applySignupGrant(h.db, { userId: young.userId, amount: 5_000_000n })).toEqual({
        status: "not_eligible",
        reason: "github_account_too_new",
      });
    });
  });
});
