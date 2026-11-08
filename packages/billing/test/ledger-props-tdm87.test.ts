// TDM-87 property tests: random interleavings of concurrent ledger writers against the local
// Postgres. The cached balances always equal the sums of entries and grants, idempotency holds,
// failed_infra never creates an entry, and comped usage is never counted or reported. Cost-plus
// (TDM-171): the per-trial charge is each trial's computer (`compute`, markup 0 here).
import { TRIAL_STATES, isBillableTrialState, withMarkupBps, type TrialState } from "@anybench/core";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  balanceFromNet,
  computeIdempotencyKey,
  createLedger,
  LedgerError,
  managedTokensIdempotencyKey,
  type Ledger,
} from "../src/index.js";
import { freshMigratedDbTdm87, pgAvailableTdm87, type FreshDbTdm87 } from "./helpers/pg-tdm87.js";
import { seedWithComputersTdm171, type BilledFixtureTdm171 } from "./helpers/pg-tdm171.js";

const available = await pgAvailableTdm87();

const USERS = 2;
const TRIALS = 5;
const TOKEN_KEYS = 3;
const MARKUP_BPS = 2000;
const SIGNUP_GRANT = 5_000_000n;

type Op =
  | { kind: "compute"; u: number; t: number; assertComp: boolean }
  | { kind: "tokens"; u: number; k: number; assertComp: boolean }
  | { kind: "grant"; u: number; amount: bigint; signup: boolean }
  | { kind: "report"; u: number }
  | { kind: "audit"; u: number };

const user = fc.integer({ min: 0, max: USERS - 1 });
// failed_infra is weighted up: it is the state that must never bill.
const state = fc.oneof(
  { arbitrary: fc.constantFrom<TrialState>(...TRIAL_STATES), weight: 2 },
  { arbitrary: fc.constant<TrialState>("failed_infra"), weight: 2 },
  { arbitrary: fc.constantFrom<TrialState>("done", "failed_subject"), weight: 2 },
);
const op: fc.Arbitrary<Op> = fc.oneof(
  {
    arbitrary: fc.record({
      kind: fc.constant("compute" as const),
      u: user,
      t: fc.integer({ min: 0, max: TRIALS - 1 }),
      // Pass the (correct) comp flag, or forget it: the run decides either way.
      assertComp: fc.boolean(),
    }),
    weight: 5,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("tokens" as const),
      u: user,
      k: fc.integer({ min: 0, max: TOKEN_KEYS - 1 }),
      assertComp: fc.boolean(),
    }),
    weight: 3,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("grant" as const),
      u: user,
      amount: fc.bigInt({ min: 1n, max: 3_000_000n }),
      signup: fc.boolean(),
    }),
    weight: 2,
  },
  { arbitrary: fc.record({ kind: fc.constant("report" as const), u: user }), weight: 1 },
  { arbitrary: fc.record({ kind: fc.constant("audit" as const), u: user }), weight: 2 },
);

/**
 * Per-scenario constants: a trial's computer cost and stored state, a token key's cost and a run's
 * comp never vary between duplicate writes.
 */
const scenario = fc.record({
  fees: fc.array(
    fc.array(fc.bigInt({ min: 0n, max: 2_000_000n }), { minLength: TRIALS, maxLength: TRIALS }),
    { minLength: USERS, maxLength: USERS },
  ),
  dbStates: fc.array(fc.array(state, { minLength: TRIALS, maxLength: TRIALS }), {
    minLength: USERS,
    maxLength: USERS,
  }),
  runComped: fc.array(fc.boolean(), { minLength: USERS, maxLength: USERS }),
  tokenCosts: fc.array(
    fc.array(fc.bigInt({ min: 0n, max: 5_000_000n }), {
      minLength: TOKEN_KEYS,
      maxLength: TOKEN_KEYS,
    }),
    { minLength: USERS, maxLength: USERS },
  ),
  ops: fc.array(op, { minLength: 1, maxLength: 40 }),
});

describe.skipIf(!available)("usage ledger properties under concurrent writers (TDM-87)", () => {
  let h: FreshDbTdm87;
  let ledger: Ledger;

  beforeAll(async () => {
    h = await freshMigratedDbTdm87({ max: 12 });
    ledger = createLedger(h.db);
  }, 120_000);

  afterAll(async () => {
    await h?.drop();
  });

  it("cache == sums, idempotent, only DB-billable trials billed, comped runs never counted or reported", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (s) => {
        const us: BilledFixtureTdm171[] = [];
        for (let i = 0; i < USERS; i++) {
          us.push(
            await seedWithComputersTdm171(h.pool, TRIALS, {
              states: s.dbStates[i]!,
              comped: s.runComped[i]!,
              cost: s.fees[i]!,
            }),
          );
        }
        /** Billed iff the trial's STORED state is billable (done or failed_subject). */
        const bills = (o: Extract<Op, { kind: "compute" }>) =>
          isBillableTrialState(s.dbStates[o.u]![o.t]!);
        const tokenKey = (u: number, k: number) => `${us[u]!.userId}:${k}`;

        const run = (o: Op) => {
          const u = us[o.u]!;
          switch (o.kind) {
            case "compute":
              return ledger.recordComputerUsage({
                computerId: u.computerIds[o.t]!,
                userId: u.userId,
                markupBps: 0,
                comped: o.assertComp ? s.runComped[o.u]! : undefined,
              });
            case "tokens":
              return ledger.recordManagedTokens({
                userId: u.userId,
                runId: u.runId,
                cost: s.tokenCosts[o.u]![o.k]!,
                markupBps: MARKUP_BPS,
                idempotencyKey: tokenKey(o.u, o.k),
                comped: o.assertComp ? s.runComped[o.u]! : undefined,
              });
            case "grant":
              return o.signup
                ? ledger.applyGrant({
                    userId: u.userId,
                    amount: SIGNUP_GRANT,
                    category: "promotional",
                    source: "signup",
                    reason: "signup",
                  })
                : ledger.applyGrant({
                    userId: u.userId,
                    amount: o.amount,
                    category: "promotional",
                    source: "admin",
                    reason: "prop",
                    interventionId: u.userInterventionId,
                  });
            case "report":
              return ledger.listUnreported({ userId: u.userId }).then((rows) =>
                ledger.markReported(
                  rows.map((r) => r.id),
                  rows.map((r) => `mev_${r.id}`),
                ),
              );
            case "audit":
              return ledger.auditAccount(u.userId);
          }
        };

        // Everything at once: the pool (12 connections) interleaves the transactions.
        // A rejected call resolves to its error code so the batch always completes.
        const results = await Promise.all(
          s.ops.map((o) =>
            run(o).then(
              (r) => r as unknown,
              (e: unknown) => ({ error: e instanceof LedgerError ? e.code : String(e) }),
            ),
          ),
        );

        for (let i = 0; i < s.ops.length; i++) {
          const o = s.ops[i]!;
          const r = results[i] as { status?: string; ok?: boolean; error?: string };
          if (o.kind === "compute") {
            if (!bills(o)) {
              expect(r).toMatchObject({ status: "skipped", reason: "not_billable" });
            } else if (s.fees[o.u]![o.t]! === 0n) {
              expect(r).toMatchObject({ status: "skipped", reason: "zero_cost" });
            } else {
              expect(["recorded", "duplicate"]).toContain(r.status);
            }
          } else {
            expect(r.error, `${o.kind} failed`).toBeUndefined();
          }
          // An audit taken mid-flight sees the cache and the rows from one snapshot: always equal.
          if (o.kind === "audit") expect(r.ok).toBe(true);
        }

        // Exactly one "recorded" per idempotency key, however many writers raced for it.
        const recordedPerKey = new Map<string, number>();
        for (const r of results) {
          const rr = r as { status?: string; entry?: { idempotencyKey: string } };
          if (rr.status === "recorded" && rr.entry) {
            recordedPerKey.set(
              rr.entry.idempotencyKey,
              (recordedPerKey.get(rr.entry.idempotencyKey) ?? 0) + 1,
            );
          }
        }
        for (const [key, n] of recordedPerKey) expect(n, key).toBe(1);

        for (let ui = 0; ui < USERS; ui++) {
          const u = us[ui]!;
          // The model: what the balance must be, independent of interleaving.
          const billedTrials = new Set<number>();
          const touchedTokens = new Set<number>();
          let grants = 0n;
          let signup = false;
          for (const o of s.ops) {
            if (o.u !== ui) continue;
            if (o.kind === "compute" && bills(o) && s.fees[ui]![o.t]! > 0n) billedTrials.add(o.t);
            if (o.kind === "tokens") touchedTokens.add(o.k);
            if (o.kind === "grant") {
              if (o.signup) signup = true;
              else grants += o.amount;
            }
          }
          if (signup) grants += SIGNUP_GRANT;
          // A comped run contributes nothing, whatever the caller passed.
          let usage = 0n;
          if (!s.runComped[ui]) {
            for (const t of billedTrials) usage += s.fees[ui]![t]!;
            for (const k of touchedTokens)
              usage += withMarkupBps(s.tokenCosts[ui]![k]!, MARKUP_BPS);
          }

          const audit = await ledger.auditAccount(u.userId);
          expect(audit.ok).toBe(true);
          expect(audit.usage).toBe(usage);
          expect(audit.granted).toBe(grants);
          const summary = await ledger.getAccountSummary(u.userId);
          const expected = balanceFromNet(usage - grants);
          expect(summary.unbilled).toBe(expected.unbilled);
          expect(summary.granted_remaining).toBe(expected.granted_remaining);
          expect(summary.unbilled === 0n || summary.granted_remaining === 0n).toBe(true);

          const { rows } = await h.pool.query<{
            trial_id: string | null;
            type: string;
            idempotency_key: string;
            comped_by: string | null;
            reported_at: Date | null;
            stripe_meter_event_id: string | null;
            id: string;
          }>(
            "select id, trial_id, type, idempotency_key, comped_by, reported_at, stripe_meter_event_id from usage_entries where user_id = $1",
            [u.userId],
          );
          const feeRows = rows.filter((r) => r.type === "compute");
          // One charge per computer of a trial in a billable state, none for failed_infra trials.
          expect(new Set(feeRows.map((r) => r.trial_id)).size).toBe(feeRows.length);
          expect(feeRows.map((r) => r.trial_id).sort()).toEqual(
            [...billedTrials].map((t) => u.trialIds[t]!).sort(),
          );
          for (const r of feeRows) {
            const t = u.trialIds.indexOf(r.trial_id!);
            expect(r.idempotency_key).toBe(computeIdempotencyKey(u.computerIds[t]!));
          }
          const tokenRows = rows.filter((r) => r.type === "managed_tokens");
          expect(tokenRows.map((r) => r.idempotency_key).sort()).toEqual(
            [...touchedTokens].map((k) => managedTokensIdempotencyKey(tokenKey(ui, k))).sort(),
          );
          // COGS written once per token entry.
          const cogs = await h.pool.query<{ ref: string }>(
            "select ref from cost_entries where run_id = $1",
            [u.runId],
          );
          expect(cogs.rows.map((r) => r.ref).sort()).toEqual(
            tokenRows.map((r) => r.idempotency_key).sort(),
          );
          // Comped rows are never reported; reported rows carry their meter event id.
          for (const r of rows) {
            // Every entry of a comped run is comped (and so never reportable), none otherwise.
            expect(r.comped_by !== null).toBe(s.runComped[ui]!);
            if (r.comped_by !== null) expect(r.reported_at).toBeNull();
            if (r.reported_at !== null) expect(r.stripe_meter_event_id).toBe(`mev_${r.id}`);
          }
        }
      }),
      { numRuns: 25 },
    );
  }, 300_000);
});
