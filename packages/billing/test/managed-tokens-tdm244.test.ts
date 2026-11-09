// TDM-244 [20.7]: managed (our) model tokens are billed at cost + MANAGED_TOKEN_MARKUP_BPS.
//   - pure: managedTokensDecision follows the compute rules per trial (infra failures, our
//     cancels and runs that failed in our pipeline bill nothing; only the current attempt's key;
//     an unreadable spend bills nothing);
//   - ledger (local Postgres, skips without it): recordRunCharges writes one `managed_tokens`
//     entry per trial on our proxy key (`tokens:trial:<id>`) at cost + markup with its COGS row,
//     once; BYOK trials and failed_infra trials get none; a comped run's entry is comped; the
//     caller's fresh spend read is only a fallback for a trial with no stored spend.
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  createLedger,
  DEFAULT_MANAGED_TOKEN_MARKUP_BPS,
  managedTokensChargeMicroUsd,
  managedTokensDecision,
  storedProxyCost,
  trialTokensIdempotencyKey,
  type Ledger,
  type TrialTokensForBilling,
} from "../src/index.js";
import { setRunStateTdm171 } from "./helpers/pg-tdm171.js";
import {
  freshMigratedDbTdm87,
  pgAvailableTdm87,
  seedUserTdm87,
  type FreshDbTdm87,
} from "./helpers/pg-tdm87.js";

const available = await pgAvailableTdm87();

const trial = (over: Partial<TrialTokensForBilling> = {}): TrialTokensForBilling => ({
  id: "t1",
  state: "done",
  attempt: 1,
  proxyKeyId: "key_a",
  proxyKeyAttempt: 1,
  ...over,
});

describe("managedTokensDecision (TDM-244, pure)", () => {
  it("bills a done trial of a delivered run at its proxy spend", () => {
    expect(managedTokensDecision(trial(), "delivered", ["done"], "user", 400_000n)).toEqual({
      billable: true,
      cost: 400_000n,
    });
    expect(managedTokensChargeMicroUsd(400_000n, DEFAULT_MANAGED_TOKEN_MARKUP_BPS)).toBe(480_000n);
    // Rounded down per trial, like compute.
    expect(managedTokensChargeMicroUsd(7n, 2000n)).toBe(8n);
  });

  it("never bills infra failures, our cancels, or a run that failed in our pipeline", () => {
    const infra = managedTokensDecision(
      trial({ state: "failed_infra" }),
      "delivered",
      ["done", "failed_infra"],
      "user",
      400_000n,
    );
    expect(infra).toMatchObject({ billable: false, reason: "not_billable" });
    const ours = managedTokensDecision(trial(), "cancelled", ["done"], "ours", 400_000n);
    expect(ours).toMatchObject({ billable: false, reason: "not_billable" });
    // failed with a done trial = our pipeline failed after the trials: nothing billed.
    const pipeline = managedTokensDecision(trial(), "failed", ["done"], "user", 400_000n);
    expect(pipeline).toMatchObject({ billable: false, reason: "not_billable" });
    const live = managedTokensDecision(trial(), "running", ["done"], "user", 400_000n);
    expect(live).toMatchObject({ billable: false, reason: "run_not_final" });
  });

  it("a user cancel bills the tokens of trials it cut off; a subject failure bills them too", () => {
    expect(
      managedTokensDecision(trial({ state: "cancelled" }), "cancelled", ["cancelled"], "user", 5n)
        .billable,
    ).toBe(true);
    expect(
      managedTokensDecision(
        trial({ state: "failed_subject" }),
        "failed",
        ["failed_subject"],
        "user",
        5n,
      ).billable,
    ).toBe(true);
  });

  it("BYOK, an earlier attempt's key, an unreadable or zero spend bill nothing", () => {
    expect(
      managedTokensDecision(trial({ proxyKeyId: null }), "delivered", ["done"], "user", 5n),
    ).toMatchObject({ billable: false, reason: "not_billable" });
    expect(
      managedTokensDecision(
        trial({ attempt: 2, proxyKeyAttempt: 1 }),
        "delivered",
        ["done"],
        "user",
        5n,
      ),
    ).toMatchObject({ billable: false, reason: "spend_unknown" });
    expect(managedTokensDecision(trial(), "delivered", ["done"], "user", null)).toMatchObject({
      billable: false,
      reason: "spend_unknown",
    });
    expect(managedTokensDecision(trial(), "delivered", ["done"], "user", 0n)).toMatchObject({
      billable: false,
      reason: "zero_cost",
    });
  });

  it("storedProxyCost reads only a safe non-negative integer", () => {
    expect(storedProxyCost({ proxy_cost_micro_usd: 12 })).toBe(12n);
    expect(storedProxyCost({ proxy_cost_micro_usd: 1.5 })).toBeNull();
    expect(storedProxyCost({ proxy_cost_missing: 1 })).toBeNull();
    expect(storedProxyCost(null)).toBeNull();
  });
});

describe.skipIf(!available)("managed tokens in the ledger (TDM-244, local Postgres)", () => {
  let h: FreshDbTdm87;
  let ledger: Ledger;
  const PRICING = { runFeeMicroUsd: 0n, computeMarkupBps: 0n, managedTokenMarkupBps: 2000n };

  beforeAll(async () => {
    h = await freshMigratedDbTdm87();
    ledger = createLedger(h.db);
  }, 60_000);

  afterAll(async () => {
    await h?.drop();
  });

  async function setTokens(
    trialId: string,
    o: { key: string | null; attempt?: number; keyAttempt?: number; cost?: number | null },
  ) {
    await h.pool.query(
      "update trials set proxy_key_id = $1, attempt = $2, proxy_key_attempt = $3, metrics = $4 where id = $5",
      [
        o.key,
        o.attempt ?? 1,
        o.key === null ? null : (o.keyAttempt ?? o.attempt ?? 1),
        o.cost === undefined || o.cost === null
          ? JSON.stringify({ proxy_cost_missing: 1 })
          : JSON.stringify({ proxy_cost_micro_usd: o.cost }),
        trialId,
      ],
    );
  }

  async function tokenRows(runId: string) {
    return (
      await h.pool.query<{
        trial_id: string;
        amount_micro_usd: string;
        idempotency_key: string;
        comped_by: string | null;
      }>(
        "select trial_id, amount_micro_usd, idempotency_key, comped_by from usage_entries where run_id = $1 and type = 'managed_tokens' order by trial_id",
        [runId],
      )
    ).rows;
  }

  it("a managed-token trial writes one usage entry at cost + markup, with our COGS, once", async () => {
    const u = await seedUserTdm87(h.pool, 3, { states: ["done", "done", "failed_infra"] });
    await setRunStateTdm171(h.pool, u.runId, "delivered");
    const [ours, byok, infra] = u.trialIds as [string, string, string];
    await setTokens(ours, { key: "key_ours", cost: 400_000 });
    await setTokens(byok, { key: null, cost: null });
    await setTokens(infra, { key: "key_infra", cost: 300_000 });

    const r = await ledger.recordRunCharges({
      runId: u.runId,
      userId: u.userId,
      pricing: PRICING,
    });
    // Only trials on our key are considered; the failed_infra one is never billed.
    expect(r.managedTokens.map((m) => [m.trialId, m.result.status]).sort()).toEqual(
      [
        [ours, "recorded"],
        [infra, "skipped"],
      ].sort(),
    );
    const rows = await tokenRows(u.runId);
    expect(rows).toEqual([
      {
        trial_id: ours,
        amount_micro_usd: "480000",
        idempotency_key: trialTokensIdempotencyKey(ours),
        comped_by: null,
      },
    ]);
    const cogs = await h.pool.query<{ amount_micro_usd: string; source: string }>(
      "select amount_micro_usd, source from cost_entries where run_id = $1",
      [u.runId],
    );
    expect(cogs.rows).toEqual([{ amount_micro_usd: "400000", source: "naive" }]);
    expect((await ledger.getAccountSummary(u.userId)).unbilled).toBe(480_000n);

    // Retried finalize: nothing billed twice, even if the stored spend changed meanwhile.
    await setTokens(ours, { key: "key_ours", cost: 999_000 });
    const again = await ledger.recordRunCharges({
      runId: u.runId,
      userId: u.userId,
      pricing: PRICING,
    });
    expect(again.managedTokens.find((m) => m.trialId === ours)?.result.status).toBe("duplicate");
    expect(await tokenRows(u.runId)).toHaveLength(1);
    expect((await ledger.getAccountSummary(u.userId)).unbilled).toBe(480_000n);
    expect((await ledger.auditAccount(u.userId)).ok).toBe(true);

    // It is in the meter reporter's queue like any other charge.
    const queued = await ledger.listUnreported({ userId: u.userId });
    expect(queued.map((e) => e.type)).toContain("managed_tokens");
  });

  it("a BYOK-only run gets no managed-token entry", async () => {
    const u = await seedUserTdm87(h.pool, 2);
    await setRunStateTdm171(h.pool, u.runId, "delivered");
    for (const t of u.trialIds) await setTokens(t, { key: null, cost: null });
    const r = await ledger.recordRunCharges({ runId: u.runId, userId: u.userId, pricing: PRICING });
    expect(r.managedTokens).toEqual([]);
    expect(await tokenRows(u.runId)).toEqual([]);
  });

  it("a run that failed in our infra, or that we cancelled, bills no tokens", async () => {
    const failed = await seedUserTdm87(h.pool, 1, { states: ["failed_infra"] });
    await setRunStateTdm171(h.pool, failed.runId, "failed");
    await setTokens(failed.trialIds[0]!, { key: "key_f", cost: 100_000 });
    const r1 = await ledger.recordRunCharges({
      runId: failed.runId,
      userId: failed.userId,
      pricing: PRICING,
    });
    expect(r1.managedTokens[0]?.result).toMatchObject({
      status: "skipped",
      reason: "not_billable",
    });

    const cancelled = await seedUserTdm87(h.pool, 1, { states: ["cancelled"] });
    await h.pool.query("update runs set state = 'cancelled', cancel_cause = 'ours' where id = $1", [
      cancelled.runId,
    ]);
    await setTokens(cancelled.trialIds[0]!, { key: "key_c", cost: 100_000 });
    const r2 = await ledger.recordRunCharges({
      runId: cancelled.runId,
      userId: cancelled.userId,
      pricing: PRICING,
    });
    expect(r2.managedTokens[0]?.result).toMatchObject({
      status: "skipped",
      reason: "not_billable",
    });
    expect(await tokenRows(failed.runId)).toEqual([]);
    expect(await tokenRows(cancelled.runId)).toEqual([]);
  });

  it("a comped run's tokens are recorded comped (never counted, never metered)", async () => {
    const u = await seedUserTdm87(h.pool, 1, { comped: true });
    await setRunStateTdm171(h.pool, u.runId, "delivered");
    await setTokens(u.trialIds[0]!, { key: "key_comp", cost: 100_000 });
    const r = await ledger.recordRunCharges({ runId: u.runId, userId: u.userId, pricing: PRICING });
    expect(r.managedTokens[0]?.result.status).toBe("recorded");
    const rows = await tokenRows(u.runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.comped_by).toBe("jaxon");
    expect((await ledger.getAccountSummary(u.userId)).unbilled).toBe(0n);
    expect(await ledger.listUnreported({ userId: u.userId })).toEqual([]);
  });

  it("no stored spend: the caller's fresh read is used; none at all bills nothing", async () => {
    const u = await seedUserTdm87(h.pool, 2);
    await setRunStateTdm171(h.pool, u.runId, "delivered");
    const [read, unknown] = u.trialIds as [string, string];
    await setTokens(read, { key: "key_r", cost: null });
    await setTokens(unknown, { key: "key_u", cost: null });
    const r = await ledger.recordRunCharges({
      runId: u.runId,
      userId: u.userId,
      pricing: PRICING,
      managedTokenCosts: { [read]: 50_000n },
    });
    expect(r.managedTokens.find((m) => m.trialId === read)?.result.status).toBe("recorded");
    expect(r.managedTokens.find((m) => m.trialId === unknown)?.result).toMatchObject({
      status: "skipped",
      reason: "spend_unknown",
    });
    expect(await tokenRows(u.runId)).toEqual([
      expect.objectContaining({ trial_id: read, amount_micro_usd: "60000" }),
    ]);
  });

  it("an earlier attempt's key (a failed_infra retry) is never billed", async () => {
    const u = await seedUserTdm87(h.pool, 1);
    await setRunStateTdm171(h.pool, u.runId, "delivered");
    await setTokens(u.trialIds[0]!, { key: "key_old", attempt: 2, keyAttempt: 1, cost: 70_000 });
    const r = await ledger.recordTrialManagedTokens({
      trialId: u.trialIds[0]!,
      userId: u.userId,
      markupBps: 2000,
    });
    expect(r).toMatchObject({ status: "skipped", reason: "spend_unknown" });
  });
});
