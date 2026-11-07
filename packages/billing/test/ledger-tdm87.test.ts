// TDM-87: usage ledger behavior against the migrated local Postgres.
import { TRIAL_STATES, isBillableTrialState } from "@anybench/core";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLedger,
  LedgerError,
  LEDGER_TABLES,
  trialFeeIdempotencyKey,
  type Ledger,
} from "../src/index.js";
import {
  freshMigratedDbTdm87,
  pgAvailableTdm87,
  seedUserTdm87,
  type FixtureUserTdm87,
  type FreshDbTdm87,
} from "./helpers/pg-tdm87.js";

const available = await pgAvailableTdm87();
const FEE = 250_000n;

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    if (err instanceof LedgerError) return err.code;
    let e: unknown = err;
    for (let i = 0; i < 5 && e; i++) {
      if (typeof e === "object" && e !== null && "code" in e && typeof e.code === "string") {
        return e.code;
      }
      e = typeof e === "object" && e !== null && "cause" in e ? e.cause : undefined;
    }
    throw err;
  }
  throw new Error("expected a rejection");
}

describe.skipIf(!available)("usage ledger (TDM-87, local Postgres)", () => {
  let h: FreshDbTdm87;
  let ledger: Ledger;

  beforeAll(async () => {
    h = await freshMigratedDbTdm87();
    ledger = createLedger(h.db);
  }, 60_000);

  afterAll(async () => {
    await h?.drop();
  });

  const count = async (q: string, params: unknown[]) =>
    BigInt((await h.pool.query<{ n: string }>(q, params)).rows[0]!.n);

  it("schema mirror matches the migrated tables (names, types, nullability)", async () => {
    for (const table of Object.values(LEDGER_TABLES)) {
      const cfg = getTableConfig(table);
      const { rows } = await h.pool.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
      }>(
        "select column_name, data_type, is_nullable from information_schema.columns where table_name = $1",
        [cfg.name],
      );
      const real = new Map(rows.map((r) => [r.column_name, r]));
      expect(real.size, cfg.name).toBeGreaterThan(0);
      for (const col of cfg.columns) {
        const r = real.get(col.name);
        expect(r, `${cfg.name}.${col.name}`).toBeDefined();
        expect(r!.data_type, `${cfg.name}.${col.name}`).toBe(col.getSQLType());
        expect(r!.is_nullable === "NO", `${cfg.name}.${col.name} notNull`).toBe(col.notNull);
      }
    }
  });

  it("returns an empty summary for a user with no account row", async () => {
    const u = await seedUserTdm87(h.pool, 0);
    expect(await ledger.getAccountSummary(u.userId)).toEqual({
      unbilled: 0n,
      granted_remaining: 0n,
      has_payment_method: false,
      payment_status: "none",
    });
  });

  describe("recordTrialUsage", () => {
    let u: FixtureUserTdm87;
    beforeAll(async () => {
      u = await seedUserTdm87(h.pool, 4);
    });

    it("records the fee once per trial (idempotent on trial:<id>:fee)", async () => {
      const input = {
        runId: u.runId,
        trialId: u.trialIds[0]!,
        userId: u.userId,
        trialState: "done" as const,
        amount: FEE,
      };
      const first = await ledger.recordTrialUsage(input);
      expect(first.status).toBe("recorded");
      if (first.status !== "recorded") throw new Error("unreachable");
      expect(first.entry.idempotencyKey).toBe(trialFeeIdempotencyKey(u.trialIds[0]!));
      expect(first.entry.amountMicroUsd).toBe(FEE);
      const again = await ledger.recordTrialUsage({ ...input, trialState: "failed_subject" });
      expect(again.status).toBe("duplicate");
      expect((await ledger.getAccountSummary(u.userId)).unbilled).toBe(FEE);
      expect((await ledger.auditAccount(u.userId)).ok).toBe(true);
    });

    it("rejects a repeat that disagrees on the amount", async () => {
      const code = await codeOf(
        ledger.recordTrialUsage({
          runId: u.runId,
          trialId: u.trialIds[0]!,
          userId: u.userId,
          trialState: "done",
          amount: FEE + 1n,
        }),
      );
      expect(code).toBe("idempotency_conflict");
    });

    it("never creates an entry for failed_infra or any non-billable state", async () => {
      for (const state of TRIAL_STATES.filter((s) => !isBillableTrialState(s))) {
        const r = await ledger.recordTrialUsage({
          runId: u.runId,
          trialId: u.trialIds[1]!,
          userId: u.userId,
          trialState: state,
          amount: FEE,
        });
        expect(r, state).toEqual({ status: "skipped", reason: "not_billable" });
      }
      expect(
        await count("select count(*)::text as n from usage_entries where trial_id = $1", [
          u.trialIds[1],
        ]),
      ).toBe(0n);
    });

    it("rejects a trial billed to the wrong user or run", async () => {
      const other = await seedUserTdm87(h.pool, 1);
      const code = await codeOf(
        ledger.recordTrialUsage({
          runId: u.runId,
          trialId: other.trialIds[0]!,
          userId: u.userId,
          trialState: "done",
          amount: FEE,
        }),
      );
      expect(code).toBe("trial_mismatch");
    });

    it("rejects JS numbers for money (no float path)", async () => {
      const code = await codeOf(
        ledger.recordTrialUsage({
          runId: u.runId,
          trialId: u.trialIds[2]!,
          userId: u.userId,
          trialState: "done",
          amount: 0.25 as unknown as bigint,
        }),
      );
      expect(code).toBe("invalid_input");
      const code2 = await codeOf(
        ledger.recordTrialUsage({
          runId: u.runId,
          trialId: u.trialIds[2]!,
          userId: u.userId,
          trialState: "done",
          amount: 250000 as unknown as bigint,
        }),
      );
      expect(code2).toBe("invalid_input");
    });

    it("records comped usage without touching the balance or the report queue", async () => {
      const before = await ledger.getAccountSummary(u.userId);
      const r = await ledger.recordTrialUsage({
        runId: u.runId,
        trialId: u.trialIds[3]!,
        userId: u.userId,
        trialState: "done",
        amount: FEE,
        comped: { by: "jaxon", interventionId: u.interventionId },
      });
      expect(r.status).toBe("recorded");
      if (r.status !== "recorded") throw new Error("unreachable");
      expect(r.entry.compedBy).toBe("jaxon");
      expect(await ledger.getAccountSummary(u.userId)).toEqual(before);
      const unreported = await ledger.listUnreported({ userId: u.userId });
      expect(unreported.map((e) => e.id)).not.toContain(r.entry.id);
      expect(await codeOf(ledger.markReported([r.entry.id], ["mev_x"]))).toBe(
        "comped_not_reportable",
      );
      expect((await ledger.auditAccount(u.userId)).ok).toBe(true);
    });

    it("rejects a comp whose intervention is not about the run (DB trigger)", async () => {
      const other = await seedUserTdm87(h.pool, 1);
      const code = await codeOf(
        ledger.recordTrialUsage({
          runId: other.runId,
          trialId: other.trialIds[0]!,
          userId: other.userId,
          trialState: "done",
          amount: FEE,
          comped: { by: "jaxon", interventionId: u.interventionId },
        }),
      );
      expect(code).toBe("23514");
      expect((await ledger.getAccountSummary(other.userId)).unbilled).toBe(0n);
    });
  });

  describe("grants are spent first", () => {
    it("usage after a grant draws the grant down before anything is unbilled", async () => {
      const u = await seedUserTdm87(h.pool, 3);
      const g = await ledger.applyGrant({
        userId: u.userId,
        amount: 400_000n,
        category: "promotional",
        source: "signup",
        reason: "signup",
      });
      expect(g.status).toBe("applied");
      const fee = (i: number) =>
        ledger.recordTrialUsage({
          runId: u.runId,
          trialId: u.trialIds[i]!,
          userId: u.userId,
          trialState: "done",
          amount: FEE,
        });
      await fee(0);
      expect(await ledger.getAccountSummary(u.userId)).toMatchObject({
        unbilled: 0n,
        granted_remaining: 150_000n,
      });
      await fee(1);
      expect(await ledger.getAccountSummary(u.userId)).toMatchObject({
        unbilled: 100_000n,
        granted_remaining: 0n,
      });
      // A later grant pays down usage already accrued.
      await ledger.applyGrant({
        userId: u.userId,
        amount: 1_000_000n,
        category: "promotional",
        source: "admin",
        reason: "demo",
        interventionId: u.userInterventionId,
      });
      expect(await ledger.getAccountSummary(u.userId)).toMatchObject({
        unbilled: 0n,
        granted_remaining: 900_000n,
      });
      expect((await ledger.auditAccount(u.userId)).ok).toBe(true);
    });

    it("signup grants and Stripe grant ids are idempotent; admin grants need an intervention", async () => {
      const u = await seedUserTdm87(h.pool, 0);
      const signup = {
        userId: u.userId,
        amount: 5_000_000n,
        category: "promotional",
        source: "signup",
        reason: "signup",
      } as const;
      expect((await ledger.applyGrant(signup)).status).toBe("applied");
      expect((await ledger.applyGrant(signup)).status).toBe("duplicate");
      const paid = {
        userId: u.userId,
        amount: 2_000_000n,
        category: "paid",
        source: "admin",
        reason: "customer",
        interventionId: u.userInterventionId,
        stripeCreditGrantId: `credgr_${u.userId}`,
      } as const;
      expect((await ledger.applyGrant(paid)).status).toBe("applied");
      expect((await ledger.applyGrant(paid)).status).toBe("duplicate");
      expect((await ledger.getAccountSummary(u.userId)).granted_remaining).toBe(7_000_000n);
      expect(
        await codeOf(
          ledger.applyGrant({
            userId: u.userId,
            amount: 1n,
            category: "promotional",
            source: "admin",
            reason: "x",
          }),
        ),
      ).toBe("23514");
      expect((await ledger.getAccountSummary(u.userId)).granted_remaining).toBe(7_000_000n);
      expect(await codeOf(ledger.applyGrant({ ...signup, amount: 0n }))).toBe("invalid_input");
    });
  });

  describe("recordManagedTokens", () => {
    it("bills cost + markup (floored), records COGS once, idempotent on its key", async () => {
      const u = await seedUserTdm87(h.pool, 0);
      const input = {
        userId: u.userId,
        runId: u.runId,
        cost: 1_234_567n,
        markupBps: 2000,
        idempotencyKey: "sess_1:42",
        ref: "sess_1",
      };
      const r = await ledger.recordManagedTokens(input);
      expect(r.status).toBe("recorded");
      if (r.status !== "recorded") throw new Error("unreachable");
      // 1_234_567 * 0.2 = 246_913.4 -> floored to 246_913.
      expect(r.entry.amountMicroUsd).toBe(1_481_480n);
      expect(r.entry.type).toBe("managed_tokens");
      expect((await ledger.recordManagedTokens(input)).status).toBe("duplicate");
      expect(
        await count("select count(*)::text as n from cost_entries where ref = 'sess_1'", []),
      ).toBe(1n);
      const cost = await h.pool.query<{ a: string }>(
        "select amount_micro_usd::text as a from cost_entries where ref = 'sess_1'",
      );
      expect(cost.rows[0]!.a).toBe("1234567");
      expect((await ledger.getAccountSummary(u.userId)).unbilled).toBe(1_481_480n);
    });
  });

  describe("markReported", () => {
    it("marks entries reported, accepts an identical retry, rejects a different meter id", async () => {
      const u = await seedUserTdm87(h.pool, 2);
      const ids: string[] = [];
      for (const t of u.trialIds) {
        const r = await ledger.recordTrialUsage({
          runId: u.runId,
          trialId: t,
          userId: u.userId,
          trialState: "done",
          amount: FEE,
        });
        if (r.status === "skipped") throw new Error("unreachable");
        ids.push(r.entry.id);
      }
      expect((await ledger.listUnreported({ userId: u.userId })).map((e) => e.id).sort()).toEqual(
        [...ids].sort(),
      );
      const mev = ids.map((id) => `mev_${id}`);
      expect(await ledger.markReported(ids, mev)).toEqual({ reported: 2, alreadyReported: 0 });
      expect(await ledger.markReported(ids, mev)).toEqual({ reported: 0, alreadyReported: 2 });
      expect(await ledger.listUnreported({ userId: u.userId })).toEqual([]);
      expect(await codeOf(ledger.markReported([ids[0]!], ["mev_other"]))).toBe("already_reported");
      expect(
        await codeOf(ledger.markReported(["0190a0b0-0000-7000-8000-000000000000"], ["mev_y"])),
      ).toBe("unknown_entry");
      expect(await codeOf(ledger.markReported(ids, ["one"]))).toBe("invalid_input");
      // Reporting never changes the balance.
      expect((await ledger.getAccountSummary(u.userId)).unbilled).toBe(2n * FEE);
    });
  });
});
