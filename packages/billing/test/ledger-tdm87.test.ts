// TDM-87: usage ledger behavior against the migrated local Postgres. Updated for cost-plus
// (TDM-171): usage is a per-computer `compute` entry (markup 0 here, so the charge is the cost).
import { TRIAL_STATES, isBillableTrialState } from "@anybench/core";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLedger,
  LedgerError,
  LEDGER_TABLES,
  computeIdempotencyKey,
  type Ledger,
} from "../src/index.js";
import { seedWithComputersTdm171, type BilledFixtureTdm171 } from "./helpers/pg-tdm171.js";
import {
  freshMigratedDbTdm87,
  pgAvailableTdm87,
  seedUserTdm87,
  setTrialStateTdm87,
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

  describe("recordComputerUsage basics", () => {
    let u: BilledFixtureTdm171;
    beforeAll(async () => {
      u = await seedWithComputersTdm171(h.pool, 4, { cost: FEE });
    });

    it("records the charge once per computer (idempotent on computer:<id>:compute)", async () => {
      const input = { computerId: u.computerIds[0]!, userId: u.userId, markupBps: 0 };
      const first = await ledger.recordComputerUsage(input);
      expect(first.status).toBe("recorded");
      if (first.status !== "recorded") throw new Error("unreachable");
      expect(first.entry.idempotencyKey).toBe(computeIdempotencyKey(u.computerIds[0]!));
      expect(first.entry.amountMicroUsd).toBe(FEE);
      expect(first.entry.type).toBe("compute");
      expect(first.entry.trialId).toBe(u.trialIds[0]);
      expect(first.entry.runId).toBe(u.runId);
      const again = await ledger.recordComputerUsage(input);
      expect(again.status).toBe("duplicate");
      expect((await ledger.getAccountSummary(u.userId)).unbilled).toBe(FEE);
      expect((await ledger.auditAccount(u.userId)).ok).toBe(true);
    });

    it("rejects a repeat that disagrees on the amount", async () => {
      const code = await codeOf(
        ledger.recordComputerUsage({
          computerId: u.computerIds[0]!,
          userId: u.userId,
          markupBps: 1,
        }),
      );
      expect(code).toBe("idempotency_conflict");
    });

    it("never creates an entry for failed_infra or any non-billable trial state", async () => {
      for (const state of TRIAL_STATES.filter((s) => !isBillableTrialState(s))) {
        await setTrialStateTdm87(h.pool, u.trialIds[1]!, state);
        const r = await ledger.recordComputerUsage({
          computerId: u.computerIds[1]!,
          userId: u.userId,
          markupBps: 0,
        });
        expect(r, state).toMatchObject({ status: "skipped", reason: "not_billable" });
      }
      expect(
        await count("select count(*)::text as n from usage_entries where trial_id = $1", [
          u.trialIds[1],
        ]),
      ).toBe(0n);
    });

    it("rejects a computer billed to the wrong user or run", async () => {
      const other = await seedWithComputersTdm171(h.pool, 1);
      expect(
        await codeOf(
          ledger.recordComputerUsage({
            computerId: other.computerIds[0]!,
            userId: u.userId,
            markupBps: 0,
          }),
        ),
      ).toBe("run_mismatch");
      expect(
        await codeOf(
          ledger.recordComputerUsage({
            computerId: other.computerIds[0]!,
            userId: other.userId,
            runId: u.runId,
            markupBps: 0,
          }),
        ),
      ).toBe("computer_mismatch");
    });

    it("rejects JS numbers for money (no float path)", async () => {
      for (const amount of [0.25, 2_000_000]) {
        const code = await codeOf(
          ledger.recordRunFee({
            runId: u.runId,
            userId: u.userId,
            amount: amount as unknown as bigint,
          }),
        );
        expect(code, String(amount)).toBe("invalid_input");
      }
      expect(
        await codeOf(
          ledger.recordComputerUsage({
            computerId: u.computerIds[2]!,
            userId: u.userId,
            markupBps: 0.5,
          }),
        ),
      ).toBe("invalid_input");
    });
  });

  describe("comp status comes from the run", () => {
    it("a comped run never creates a counted or reportable entry, even if the caller omits the flag", async () => {
      const c = await seedWithComputersTdm171(h.pool, 2, { comped: true, cost: FEE });
      const r = await ledger.recordComputerUsage({
        computerId: c.computerIds[0]!,
        userId: c.userId,
        markupBps: 0,
      });
      expect(r.status).toBe("recorded");
      if (r.status !== "recorded") throw new Error("unreachable");
      expect(r.entry.compedBy).toBe("jaxon");
      expect(r.entry.interventionId).toBe(c.interventionId);
      const t = await ledger.recordManagedTokens({
        userId: c.userId,
        runId: c.runId,
        cost: 1_000_000n,
        markupBps: 2000,
        idempotencyKey: `${c.runId}:tok`,
      });
      if (t.status === "skipped") throw new Error("unreachable");
      expect(t.entry.compedBy).toBe("jaxon");
      // We still paid Naïve for comped tokens: the COGS row exists.
      expect(
        await count("select count(*)::text as n from cost_entries where run_id = $1", [c.runId]),
      ).toBe(1n);
      expect(await ledger.getAccountSummary(c.userId)).toMatchObject({
        unbilled: 0n,
        granted_remaining: 0n,
      });
      expect(await ledger.listUnreported({ userId: c.userId })).toEqual([]);
      expect(await codeOf(ledger.markReported([r.entry.id], ["mev_x"]))).toBe(
        "comped_not_reportable",
      );
      expect((await ledger.auditAccount(c.userId)).ok).toBe(true);
    });

    it("rejects a caller comp flag that disagrees with the run", async () => {
      const c = await seedWithComputersTdm171(h.pool, 1, { comped: true, cost: FEE });
      const p = await seedWithComputersTdm171(h.pool, 1, { cost: FEE });
      const fee = (f: BilledFixtureTdm171, comped: boolean) =>
        ledger.recordComputerUsage({
          computerId: f.computerIds[0]!,
          userId: f.userId,
          markupBps: 0,
          comped,
        });
      expect(await codeOf(fee(c, false))).toBe("comp_mismatch");
      expect(await codeOf(fee(p, true))).toBe("comp_mismatch");
      expect(
        await codeOf(
          ledger.recordManagedTokens({
            userId: p.userId,
            cost: 1n,
            markupBps: 0,
            idempotencyKey: `${p.userId}:no-run`,
            comped: true,
          }),
        ),
      ).toBe("comp_mismatch");
      expect((await fee(c, true)).status).toBe("recorded");
      expect((await fee(p, false)).status).toBe("recorded");
      expect((await ledger.getAccountSummary(c.userId)).unbilled).toBe(0n);
      expect((await ledger.getAccountSummary(p.userId)).unbilled).toBe(FEE);
    });

    it("rejects managed tokens billed to someone else's run", async () => {
      const a = await seedUserTdm87(h.pool, 0);
      const b = await seedUserTdm87(h.pool, 0);
      expect(
        await codeOf(
          ledger.recordManagedTokens({
            userId: a.userId,
            runId: b.runId,
            cost: 1n,
            markupBps: 0,
            idempotencyKey: `${a.userId}:x`,
          }),
        ),
      ).toBe("run_mismatch");
    });
  });

  describe("grants are spent first", () => {
    it("usage after a grant draws the grant down before anything is unbilled", async () => {
      const u = await seedWithComputersTdm171(h.pool, 3, { cost: FEE });
      const g = await ledger.applyGrant({
        userId: u.userId,
        amount: 400_000n,
        category: "promotional",
        source: "signup",
        reason: "signup",
      });
      expect(g.status).toBe("applied");
      const fee = (i: number) =>
        ledger.recordComputerUsage({
          computerId: u.computerIds[i]!,
          userId: u.userId,
          markupBps: 0,
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

    it("a repeat grant that disagrees on amount, category or source is an idempotency conflict", async () => {
      const u = await seedUserTdm87(h.pool, 0);
      const signup = {
        userId: u.userId,
        amount: 5_000_000n,
        category: "promotional",
        source: "signup",
        reason: "signup",
      } as const;
      expect((await ledger.applyGrant(signup)).status).toBe("applied");
      expect(await codeOf(ledger.applyGrant({ ...signup, amount: 6_000_000n }))).toBe(
        "idempotency_conflict",
      );
      expect(await codeOf(ledger.applyGrant({ ...signup, category: "paid" }))).toBe(
        "idempotency_conflict",
      );
      // Stripe-id lookup misses, the user's signup grant is found and matches: a duplicate.
      expect(
        (await ledger.applyGrant({ ...signup, stripeCreditGrantId: `credgr_s_${u.userId}` }))
          .status,
      ).toBe("duplicate");
      // Stripe-id lookup misses, the signup grant is found but the amount differs: a conflict.
      expect(
        await codeOf(
          ledger.applyGrant({
            ...signup,
            amount: 1n,
            stripeCreditGrantId: `credgr_s2_${u.userId}`,
          }),
        ),
      ).toBe("idempotency_conflict");
      const admin = {
        userId: u.userId,
        amount: 2_000_000n,
        category: "paid",
        source: "admin",
        reason: "customer",
        interventionId: u.userInterventionId,
        stripeCreditGrantId: `credgr_a_${u.userId}`,
      } as const;
      expect((await ledger.applyGrant(admin)).status).toBe("applied");
      expect(await codeOf(ledger.applyGrant({ ...admin, amount: 3_000_000n }))).toBe(
        "idempotency_conflict",
      );
      expect(await codeOf(ledger.applyGrant({ ...admin, category: "promotional" }))).toBe(
        "idempotency_conflict",
      );
      // The same Stripe grant id claimed by another user is a conflict, not a duplicate.
      const other = await seedUserTdm87(h.pool, 0);
      expect(
        await codeOf(
          ledger.applyGrant({
            ...admin,
            userId: other.userId,
            interventionId: other.userInterventionId,
          }),
        ),
      ).toBe("idempotency_conflict");
      expect((await ledger.getAccountSummary(u.userId)).granted_remaining).toBe(7_000_000n);
      expect((await ledger.getAccountSummary(other.userId)).granted_remaining).toBe(0n);
      expect((await ledger.auditAccount(u.userId)).ok).toBe(true);
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

    it("rejects unsafe or fractional markupBps with a LedgerError", async () => {
      const u = await seedUserTdm87(h.pool, 0);
      for (const markupBps of [2 ** 60, Number.MAX_SAFE_INTEGER + 2, 1.5, -1]) {
        const err = await ledger
          .recordManagedTokens({
            userId: u.userId,
            runId: u.runId,
            cost: 1_000n,
            markupBps,
            idempotencyKey: `${u.userId}:${markupBps}`,
          })
          .then(
            () => undefined,
            (e: unknown) => e,
          );
        expect(err, String(markupBps)).toBeInstanceOf(LedgerError);
        expect((err as LedgerError).code).toBe("invalid_input");
      }
      expect(
        await count("select count(*)::text as n from usage_entries where user_id = $1", [u.userId]),
      ).toBe(0n);
    });
  });

  describe("markReported", () => {
    it("marks entries reported, accepts an identical retry, rejects a different meter id", async () => {
      const u = await seedWithComputersTdm171(h.pool, 2, { cost: FEE });
      const ids: string[] = [];
      for (const computerId of u.computerIds) {
        const r = await ledger.recordComputerUsage({
          computerId,
          userId: u.userId,
          markupBps: 0,
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
