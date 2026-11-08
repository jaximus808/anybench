// TDM-171: cost-plus entries (run fee + metered compute) against the migrated local Postgres.
import { TRIAL_STATES, withMarkupBps, type RunState, type TrialState } from "@anybench/core";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  computeDecision,
  computeIdempotencyKey,
  createLedger,
  LedgerError,
  runFeeDecision,
  runFeeIdempotencyKey,
  type Ledger,
} from "../src/index.js";
import {
  freshMigratedDbTdm87,
  pgAvailableTdm87,
  seedUserTdm87,
  setTrialStateTdm87,
  type FreshDbTdm87,
} from "./helpers/pg-tdm87.js";
import {
  addComputerTdm171,
  pointTrialTdm171,
  seedWithComputersTdm171,
  setComputerTdm171,
  setRunStateTdm171,
} from "./helpers/pg-tdm171.js";

const available = await pgAvailableTdm87();
const RUN_FEE = 2_000_000n;
const MARKUP = 5000;

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    if (err instanceof LedgerError) return err.code;
    throw err;
  }
  throw new Error("expected a rejection");
}

describe.skipIf(!available)("cost-plus ledger entries (TDM-171, local Postgres)", () => {
  let h: FreshDbTdm87;
  let ledger: Ledger;

  beforeAll(async () => {
    h = await freshMigratedDbTdm87({ max: 12 });
    ledger = createLedger(h.db);
  }, 60_000);

  afterAll(async () => {
    await h?.drop();
  });

  const entries = async (userId: string) =>
    (
      await h.pool.query<{ type: string; idempotency_key: string; amount: string }>(
        "select type, idempotency_key, amount_micro_usd::text as amount from usage_entries where user_id = $1 order by idempotency_key",
        [userId],
      )
    ).rows;

  describe("recordRunFee", () => {
    it("bills a delivered run once (run:<id>:fee), with no trial", async () => {
      const u = await seedUserTdm87(h.pool, 2);
      await setRunStateTdm171(h.pool, u.runId, "delivered");
      const input = { runId: u.runId, userId: u.userId, amount: RUN_FEE };
      const r = await ledger.recordRunFee(input);
      expect(r.status).toBe("recorded");
      if (r.status !== "recorded") throw new Error("unreachable");
      expect(r.entry).toMatchObject({
        type: "run_fee",
        idempotencyKey: runFeeIdempotencyKey(u.runId),
        amountMicroUsd: RUN_FEE,
        trialId: null,
        runId: u.runId,
      });
      expect((await ledger.recordRunFee(input)).status).toBe("duplicate");
      expect(await codeOf(ledger.recordRunFee({ ...input, amount: RUN_FEE + 1n }))).toBe(
        "idempotency_conflict",
      );
      expect((await ledger.getAccountSummary(u.userId)).unbilled).toBe(RUN_FEE);
      expect((await ledger.auditAccount(u.userId)).ok).toBe(true);
    });

    it("bills a run that failed because of the subject", async () => {
      const u = await seedUserTdm87(h.pool, 3, {
        states: ["failed_subject", "failed_subject", "cancelled"],
      });
      await setRunStateTdm171(h.pool, u.runId, "failed");
      const r = await ledger.recordRunFee({ runId: u.runId, userId: u.userId, amount: RUN_FEE });
      expect(r.status).toBe("recorded");
    });

    it("never bills a run that failed in infra or our pipeline, was cancelled, or is not finished", async () => {
      const cases: { states: TrialState[]; run: string }[] = [
        { states: ["failed_subject", "failed_infra"], run: "failed" },
        { states: ["failed_infra"], run: "failed" },
        { states: ["done", "failed_subject"], run: "failed" },
        { states: ["done"], run: "failed" },
        { states: ["cancelled"], run: "failed" },
        { states: [], run: "failed" },
        { states: ["done"], run: "cancelled" },
        { states: ["done"], run: "analyzing" },
        { states: ["done"], run: "paused_budget" },
      ];
      for (const c of cases) {
        const u = await seedUserTdm87(h.pool, c.states.length, { states: c.states });
        await setRunStateTdm171(h.pool, u.runId, c.run);
        const r = await ledger.recordRunFee({ runId: u.runId, userId: u.userId, amount: RUN_FEE });
        expect(r, JSON.stringify(c)).toMatchObject({ status: "skipped", reason: "not_billable" });
        expect(await entries(u.userId)).toEqual([]);
      }
    });

    it("skips while the run is live, then bills once it is delivered", async () => {
      const u = await seedUserTdm87(h.pool, 1);
      await setRunStateTdm171(h.pool, u.runId, "running");
      const input = { runId: u.runId, userId: u.userId, amount: RUN_FEE };
      expect((await ledger.recordRunFee(input)).status).toBe("skipped");
      await setRunStateTdm171(h.pool, u.runId, "delivered");
      expect((await ledger.recordRunFee(input)).status).toBe("recorded");
    });

    it("a comped run records the fee but never counts or reports it", async () => {
      const u = await seedUserTdm87(h.pool, 1, { comped: true });
      await setRunStateTdm171(h.pool, u.runId, "delivered");
      const r = await ledger.recordRunFee({ runId: u.runId, userId: u.userId, amount: RUN_FEE });
      if (r.status !== "recorded") throw new Error(`expected recorded, got ${r.status}`);
      expect(r.entry.compedBy).toBe("jaxon");
      expect((await ledger.getAccountSummary(u.userId)).unbilled).toBe(0n);
      expect(await ledger.listUnreported({ userId: u.userId })).toEqual([]);
      expect(await codeOf(ledger.markReported([r.entry.id], ["mev_fee"]))).toBe(
        "comped_not_reportable",
      );
    });

    it("rejects someone else's run", async () => {
      const a = await seedUserTdm87(h.pool, 0);
      const b = await seedUserTdm87(h.pool, 0);
      await setRunStateTdm171(h.pool, b.runId, "delivered");
      expect(
        await codeOf(ledger.recordRunFee({ runId: b.runId, userId: a.userId, amount: RUN_FEE })),
      ).toBe("run_mismatch");
    });
  });

  describe("recordComputerUsage", () => {
    it("bills registry cost + COMPUTE_MARKUP_BPS, rounded down", async () => {
      const u = await seedWithComputersTdm171(h.pool, 1, { cost: 27_601n });
      const r = await ledger.recordComputerUsage({
        computerId: u.computerIds[0]!,
        userId: u.userId,
        markupBps: MARKUP,
      });
      if (r.status !== "recorded") throw new Error(`expected recorded, got ${r.status}`);
      // 27_601 * 0.5 = 13_800.5 -> 13_800.
      expect(r.entry.amountMicroUsd).toBe(41_401n);
      expect(r.entry.idempotencyKey).toBe(computeIdempotencyKey(u.computerIds[0]!));
    });

    it("never bills the computer of a failed_infra trial", async () => {
      const u = await seedWithComputersTdm171(h.pool, 2, { states: ["failed_infra", "done"] });
      const r0 = await ledger.recordComputerUsage({
        computerId: u.computerIds[0]!,
        userId: u.userId,
        markupBps: MARKUP,
      });
      expect(r0).toMatchObject({ status: "skipped", reason: "not_billable" });
      const r1 = await ledger.recordComputerUsage({
        computerId: u.computerIds[1]!,
        userId: u.userId,
        markupBps: MARKUP,
      });
      expect(r1.status).toBe("recorded");
      expect((await entries(u.userId)).map((e) => e.idempotency_key)).toEqual([
        computeIdempotencyKey(u.computerIds[1]!),
      ]);
    });

    it("a retried trial: the failed_infra attempt's computer is not billed, the final one is", async () => {
      const u = await seedUserTdm87(h.pool, 1);
      const t = u.trialIds[0]!;
      const first = await addComputerTdm171(h.pool, { runId: u.runId, trialId: t });
      const second = await addComputerTdm171(h.pool, { runId: u.runId, trialId: t });
      // The trial (now done) points at its second computer; the first was its failed attempt.
      const a = await ledger.recordComputerUsage({
        computerId: first,
        userId: u.userId,
        markupBps: MARKUP,
      });
      expect(a).toMatchObject({ status: "skipped", reason: "not_billable" });
      const b = await ledger.recordComputerUsage({
        computerId: second,
        userId: u.userId,
        markupBps: MARKUP,
      });
      if (b.status !== "recorded") throw new Error(`expected recorded, got ${b.status}`);
      expect(b.entry.trialId).toBe(t);
    });

    it("the creating trial counts while it has no computer_id yet (the reaper's rule)", async () => {
      const u = await seedUserTdm87(h.pool, 1);
      const c = await addComputerTdm171(h.pool, {
        runId: u.runId,
        trialId: u.trialIds[0]!,
        point: false,
      });
      const r = await ledger.recordComputerUsage({ computerId: c, userId: u.userId, markupBps: 0 });
      expect(r.status).toBe("recorded");
    });

    it("packed: billed once if any trial on it is billable, never if all were failed_infra", async () => {
      const u = await seedUserTdm87(h.pool, 3, {
        states: ["failed_infra", "done", "failed_infra"],
      });
      const packed = await addComputerTdm171(h.pool, { runId: u.runId, trialId: u.trialIds[0]! });
      await pointTrialTdm171(h.pool, u.trialIds[1]!, packed);
      const r = await ledger.recordComputerUsage({
        computerId: packed,
        userId: u.userId,
        markupBps: 0,
      });
      if (r.status !== "recorded") throw new Error(`expected recorded, got ${r.status}`);
      // The creating trial failed in infra, so the entry is not pinned on it.
      expect(r.entry.trialId).toBeNull();
      const v = await seedUserTdm87(h.pool, 2, { states: ["failed_infra", "failed_infra"] });
      const allInfra = await addComputerTdm171(h.pool, { runId: v.runId, trialId: v.trialIds[0]! });
      await pointTrialTdm171(h.pool, v.trialIds[1]!, allInfra);
      expect(
        await ledger.recordComputerUsage({ computerId: allInfra, userId: v.userId, markupBps: 0 }),
      ).toMatchObject({ status: "skipped", reason: "not_billable" });
    });

    it("a run-level (scoring) computer is folded into the run's trials", async () => {
      const u = await seedUserTdm87(h.pool, 2, { states: ["failed_infra", "done"] });
      const scoring = await addComputerTdm171(h.pool, { runId: u.runId, trialId: null });
      const r = await ledger.recordComputerUsage({
        computerId: scoring,
        userId: u.userId,
        markupBps: MARKUP,
      });
      if (r.status !== "recorded") throw new Error(`expected recorded, got ${r.status}`);
      expect(r.entry.trialId).toBeNull();
      const v = await seedUserTdm87(h.pool, 1, { states: ["failed_infra"] });
      const orphan = await addComputerTdm171(h.pool, { runId: v.runId, trialId: null });
      expect(
        await ledger.recordComputerUsage({ computerId: orphan, userId: v.userId, markupBps: 0 }),
      ).toMatchObject({ status: "skipped", reason: "not_billable" });
    });

    it("waits for the registry's final cost: not destroyed -> computer_not_final", async () => {
      const u = await seedWithComputersTdm171(h.pool, 1);
      const c = u.computerIds[0]!;
      for (const status of ["creating", "running", "destroying", "leaked", "error"]) {
        await setComputerTdm171(h.pool, c, { status });
        expect(
          await ledger.recordComputerUsage({ computerId: c, userId: u.userId, markupBps: 0 }),
          status,
        ).toMatchObject({ status: "skipped", reason: "computer_not_final" });
      }
      await setComputerTdm171(h.pool, c, { status: "destroyed" });
      expect(
        (await ledger.recordComputerUsage({ computerId: c, userId: u.userId, markupBps: 0 }))
          .status,
      ).toBe("recorded");
    });

    it("a zero-cost computer (docker-local) makes no entry", async () => {
      const u = await seedWithComputersTdm171(h.pool, 1, { cost: 0n });
      expect(
        await ledger.recordComputerUsage({
          computerId: u.computerIds[0]!,
          userId: u.userId,
          markupBps: MARKUP,
        }),
      ).toMatchObject({ status: "skipped", reason: "zero_cost" });
    });

    it("rejects an unknown computer", async () => {
      const u = await seedUserTdm87(h.pool, 0);
      expect(
        await codeOf(
          ledger.recordComputerUsage({
            computerId: "0190a0b0-0000-7000-8000-000000000001",
            userId: u.userId,
            markupBps: 0,
          }),
        ),
      ).toBe("computer_mismatch");
    });

    it("a comped run records compute but never counts or reports it", async () => {
      const u = await seedWithComputersTdm171(h.pool, 1, { comped: true });
      const r = await ledger.recordComputerUsage({
        computerId: u.computerIds[0]!,
        userId: u.userId,
        markupBps: MARKUP,
      });
      if (r.status !== "recorded") throw new Error(`expected recorded, got ${r.status}`);
      expect(r.entry.compedBy).toBe("jaxon");
      expect((await ledger.getAccountSummary(u.userId)).unbilled).toBe(0n);
      expect(await ledger.listUnreported({ userId: u.userId })).toEqual([]);
    });
  });

  // Concurrent writers: random runs (states, computers, retries) and a burst of duplicate calls,
  // all at once. Exactly one entry per key, balance == the model, decisions == the pure functions.
  it("property: idempotent and DB-decided under concurrent writers", async () => {
    const trialState = fc.constantFrom<TrialState>(...TRIAL_STATES);
    const scenario = fc.record({
      runState: fc.constantFrom<RunState>("delivered", "failed", "cancelled", "running"),
      trials: fc.array(
        fc.record({
          state: fc.oneof(
            { arbitrary: trialState, weight: 2 },
            { arbitrary: fc.constantFrom<TrialState>("failed_infra"), weight: 2 },
            { arbitrary: fc.constantFrom<TrialState>("done", "failed_subject"), weight: 2 },
          ),
          // An earlier failed_infra attempt on its own computer.
          retried: fc.boolean(),
          cost: fc.bigInt({ min: 0n, max: 5_000_000n }),
        }),
        { minLength: 0, maxLength: 4 },
      ),
      scoring: fc.option(fc.bigInt({ min: 1n, max: 1_000_000n }), { nil: undefined }),
      comped: fc.boolean(),
      markupBps: fc.integer({ min: 0, max: 20_000 }),
      copies: fc.integer({ min: 1, max: 4 }),
    });
    await fc.assert(
      fc.asyncProperty(scenario, async (s) => {
        const u = await seedUserTdm87(h.pool, s.trials.length, {
          states: s.trials.map((t) => t.state),
          comped: s.comped,
        });
        await setRunStateTdm171(h.pool, u.runId, s.runState);
        const computerIds: string[] = [];
        // Independent of the pure decision: computers that must never be billed.
        const neverBilled = new Set<string>();
        for (let i = 0; i < s.trials.length; i++) {
          const t = s.trials[i]!;
          if (t.retried) {
            const earlier = await addComputerTdm171(h.pool, {
              runId: u.runId,
              trialId: u.trialIds[i]!,
              cost: t.cost + 1n,
            });
            computerIds.push(earlier);
            neverBilled.add(earlier);
          }
          const current = await addComputerTdm171(h.pool, {
            runId: u.runId,
            trialId: u.trialIds[i]!,
            cost: t.cost,
          });
          computerIds.push(current);
          if (t.state !== "done" && t.state !== "failed_subject") neverBilled.add(current);
        }
        if (s.scoring !== undefined) {
          computerIds.push(
            await addComputerTdm171(h.pool, { runId: u.runId, trialId: null, cost: s.scoring }),
          );
        }
        // Model, from the pure decisions over what we stored.
        const { rows: trialRows } = await h.pool.query<{
          id: string;
          state: TrialState;
          computer_id: string | null;
        }>("select id, state, computer_id from trials where run_id = $1", [u.runId]);
        const { rows: compRows } = await h.pool.query<{
          id: string;
          trial_id: string | null;
          status: string;
          cost: string;
        }>(
          "select id, trial_id, status, cost_micro_usd::text as cost from computers where run_id = $1",
          [u.runId],
        );
        const runTrials = trialRows.map((t) => ({
          id: t.id,
          state: t.state,
          computerId: t.computer_id,
        }));
        const expectKeys = new Map<string, bigint>();
        const fee = runFeeDecision(
          s.runState,
          runTrials.map((t) => t.state),
        );
        if (fee.billable) expectKeys.set(runFeeIdempotencyKey(u.runId), RUN_FEE);
        for (const c of compRows) {
          const d = computeDecision(
            { id: c.id, trialId: c.trial_id, status: c.status, costMicroUsd: BigInt(c.cost) },
            runTrials,
          );
          if (d.billable) {
            expectKeys.set(computeIdempotencyKey(c.id), withMarkupBps(BigInt(c.cost), s.markupBps));
          }
        }

        const calls: Promise<unknown>[] = [];
        for (let k = 0; k < s.copies; k++) {
          calls.push(ledger.recordRunFee({ runId: u.runId, userId: u.userId, amount: RUN_FEE }));
          for (const computerId of computerIds) {
            calls.push(
              ledger.recordComputerUsage({
                computerId,
                userId: u.userId,
                markupBps: s.markupBps,
              }),
            );
          }
        }
        const results = (await Promise.all(calls)) as { status: string }[];
        const recorded = results.filter((r) => r.status === "recorded").length;
        expect(recorded).toBe(expectKeys.size);

        const got = await entries(u.userId);
        expect(new Map(got.map((e) => [e.idempotency_key, BigInt(e.amount)]))).toEqual(expectKeys);
        // failed_infra (and other unbilled) trials' computers and earlier attempts never appear.
        for (const e of got) expect(["run_fee", "compute"]).toContain(e.type);
        for (const id of neverBilled) {
          expect(got.map((e) => e.idempotency_key)).not.toContain(computeIdempotencyKey(id));
        }
        // A run fee only for delivered, or failed with no failed_infra trial.
        if (got.some((e) => e.type === "run_fee")) {
          expect(
            s.runState === "delivered" ||
              (s.runState === "failed" && !s.trials.some((t) => t.state === "failed_infra")),
          ).toBe(true);
        }
        const total = [...expectKeys.values()].reduce((a, b) => a + b, 0n);
        const audit = await ledger.auditAccount(u.userId);
        expect(audit.ok).toBe(true);
        expect(audit.usage).toBe(s.comped ? 0n : total);
        expect((await ledger.listUnreported({ userId: u.userId })).length).toBe(
          s.comped ? 0 : expectKeys.size,
        );
      }),
      { numRuns: 30 },
    );
  }, 300_000);

  it("the seeded failed_infra state is the DB's, not the caller's", async () => {
    // Flipping a trial to failed_infra after the fact (before billing) removes its computer.
    const u = await seedWithComputersTdm171(h.pool, 1);
    await setTrialStateTdm87(h.pool, u.trialIds[0]!, "failed_infra");
    expect(
      await ledger.recordComputerUsage({
        computerId: u.computerIds[0]!,
        userId: u.userId,
        markupBps: 0,
      }),
    ).toMatchObject({ status: "skipped", reason: "not_billable" });
  });
});
