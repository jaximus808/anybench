// TDM-87: no float path. Money stays bigint from input to Postgres and back, exactly, including
// amounts no JS number can represent; and the ledger source has no number conversions for money.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyNetDelta, balanceFromNet, createLedger, type Ledger } from "../src/index.js";
import {
  freshMigratedDbTdm87,
  pgAvailableTdm87,
  seedUserTdm87,
  type FreshDbTdm87,
} from "./helpers/pg-tdm87.js";

const available = await pgAvailableTdm87();
const SRC = fileURLToPath(new URL("../src/", import.meta.url));

describe("no float path in the ledger source (TDM-87)", () => {
  it("never converts to or parses a JS number", () => {
    const banned = [
      /\bNumber\s*\(/,
      /\bparseFloat\b/,
      /\bparseInt\b/,
      /\bMath\./,
      /\.toFixed\b/,
      /mode:\s*"number"/,
      /\bnumeric\s*\(/,
      /\bdoublePrecision\b/,
      /\breal\s*\(/,
    ];
    const files = readdirSync(SRC).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(SRC + f, "utf8");
      for (const re of banned) expect(re.test(text), `${f} matches ${re}`).toBe(false);
    }
  });

  it("balance arithmetic is exact bigint and order-independent", () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: -(2n ** 62n), max: 2n ** 62n }), { maxLength: 30 }),
        (deltas) => {
          let b = balanceFromNet(0n);
          for (const d of deltas) b = applyNetDelta(b, d);
          const net = deltas.reduce((a, d) => a + d, 0n);
          expect(b).toEqual(balanceFromNet(net));
          expect(typeof b.unbilled).toBe("bigint");
          expect(b.unbilled === 0n || b.granted_remaining === 0n).toBe(true);
          const r = [...deltas].reverse().reduce(applyNetDelta, balanceFromNet(0n));
          expect(r).toEqual(b);
        },
      ),
    );
  });
});

describe.skipIf(!available)("no float path through Postgres (TDM-87)", () => {
  let h: FreshDbTdm87;
  let ledger: Ledger;

  beforeAll(async () => {
    h = await freshMigratedDbTdm87();
    ledger = createLedger(h.db);
  }, 120_000);

  afterAll(async () => {
    await h?.drop();
  });

  it("round-trips amounts above 2^53 exactly (as bigint and as decimal strings)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.bigInt({ min: 2n ** 53n, max: 2n ** 59n }), { minLength: 1, maxLength: 3 }),
        fc.boolean(),
        async (amounts, asString) => {
          const u = await seedUserTdm87(h.pool, amounts.length);
          for (let i = 0; i < amounts.length; i++) {
            const r = await ledger.recordTrialUsage({
              runId: u.runId,
              trialId: u.trialIds[i]!,
              userId: u.userId,
              trialState: "done",
              amount: asString ? amounts[i]!.toString() : amounts[i]!,
            });
            if (r.status === "skipped") throw new Error("unreachable");
            expect(r.entry.amountMicroUsd).toBe(amounts[i]);
            expect(typeof r.entry.amountMicroUsd).toBe("bigint");
          }
          const total = amounts.reduce((a, b) => a + b, 0n);
          const summary = await ledger.getAccountSummary(u.userId);
          expect(summary.unbilled).toBe(total);
          expect(typeof summary.unbilled).toBe("bigint");
          const { rows } = await h.pool.query<{ s: string }>(
            "select sum(amount_micro_usd)::text as s from usage_entries where user_id = $1",
            [u.userId],
          );
          expect(BigInt(rows[0]!.s)).toBe(total);
          // The grant side too: an odd amount above 2^53 nets exactly.
          const g = 2n ** 53n + 1n;
          await ledger.applyGrant({
            userId: u.userId,
            amount: g,
            category: "paid",
            source: "admin",
            reason: "big",
            interventionId: u.userInterventionId,
          });
          const after = await ledger.getAccountSummary(u.userId);
          const expected = balanceFromNet(total - g);
          expect(after.unbilled).toBe(expected.unbilled);
          expect(after.granted_remaining).toBe(expected.granted_remaining);
          expect((await ledger.auditAccount(u.userId)).ok).toBe(true);
        },
      ),
      { numRuns: 15 },
    );
  }, 300_000);
});
