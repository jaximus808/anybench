// TDM-11: tenancy. Proves RLS isolates actors even when a query forgets its WHERE clause.
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scopedDb } from "../src/db/scoped.js";
import {
  contenders,
  events,
  kits,
  reports,
  reviews,
  runs,
  trials,
  userSecrets,
  users,
} from "../src/db/schema/index.js";
import {
  freshMigratedDbTdm11,
  pgAvailableTdm11,
  rejectsWithCodeTdm11,
  type FreshDbTdm11,
} from "./helpers/pg-tdm11.js";

const available = await pgAvailableTdm11();

interface Tenant {
  userId: string;
  runId: string;
  trialId: string;
}

async function seedTenant(h: FreshDbTdm11, login: string, githubId: number): Promise<Tenant> {
  const db = h.db;
  const [u] = await db.insert(users).values({ githubLogin: login, githubId }).returning();
  const ownerId = u!.id;
  const [run] = await db
    .insert(runs)
    .values({ ownerId, question: `is ${login} faster?`, budgetMicroUsd: 5_000_000n })
    .returning();
  const runId = run!.id;
  const [kit] = await db
    .insert(kits)
    .values({ ownerId, runId, version: 1, spec: { login }, hash: `h-${login}` })
    .returning();
  const [c] = await db
    .insert(contenders)
    .values({ runId, kitId: kit!.id, source: "github", role: "subject" })
    .returning();
  const [trial] = await db
    .insert(trials)
    .values({ ownerId, runId, contenderId: c!.id, workloadId: "w1", repeat: 0 })
    .returning();
  const trialId = trial!.id;
  await db.insert(reviews).values({ ownerId, trialId, criterion: "correct", score: 90 });
  await db.insert(reports).values({ ownerId, runId, json: { login }, md: `# ${login}` });
  await db
    .insert(events)
    .values({ ownerId, runId, seq: 1, source: "run", type: "run.state_changed" });
  await db.insert(userSecrets).values({
    ownerId,
    provider: "anthropic",
    ciphertext: "c",
    iv: "i",
    tag: "t",
    wrappedDek: "w",
    kekVersion: 1,
    last4: "abcd",
  });
  return { userId: ownerId, runId, trialId };
}

describe.skipIf(!available)("RLS and scopedDb (TDM-11, local Postgres)", () => {
  let h: FreshDbTdm11;
  let a: Tenant;
  let b: Tenant;

  beforeAll(async () => {
    // max 1: every transaction reuses the same connection, so leaks between transactions would show.
    h = await freshMigratedDbTdm11({ max: 1 });
    a = await seedTenant(h, "alice", 1001);
    b = await seedTenant(h, "bob", 1002);
  }, 60_000);

  afterAll(async () => {
    await h?.drop();
  });

  it("actor A cannot read actor B's run, even with no where clause", async () => {
    const seen = await scopedDb({ kind: "user", userId: a.userId }, h.db).transaction((tx) =>
      tx.select().from(runs),
    );
    expect(seen.map((r) => r.id)).toEqual([a.runId]);

    const direct = await scopedDb({ kind: "user", userId: a.userId }, h.db).transaction((tx) =>
      tx.select().from(runs).where(eq(runs.id, b.runId)),
    );
    expect(direct).toEqual([]);
  });

  it("isolates every RLS table: runs, kits, trials, reviews, reports, events, user_secrets", async () => {
    const tables = { runs, kits, trials, reviews, reports, events, userSecrets };
    for (const [name, table] of Object.entries(tables)) {
      for (const t of [a, b]) {
        const rows = await scopedDb({ kind: "user", userId: t.userId }, h.db).transaction((tx) =>
          tx.select({ ownerId: table.ownerId }).from(table),
        );
        expect(rows.length, name).toBe(1);
        expect(rows[0]!.ownerId, name).toBe(t.userId);
      }
    }
  });

  it("the system actor (table owner) sees every tenant", async () => {
    const all = await scopedDb({ kind: "system", reason: "test" }, h.db).transaction((tx) =>
      tx.select().from(runs),
    );
    expect(all.map((r) => r.id).sort()).toEqual([a.runId, b.runId].sort());
  });

  it("A cannot insert a run owned by B", async () => {
    const code = await rejectsWithCodeTdm11(
      scopedDb({ kind: "user", userId: a.userId }, h.db).transaction((tx) =>
        tx.insert(runs).values({ ownerId: b.userId, question: "x", budgetMicroUsd: 1n }),
      ),
    );
    expect(code).toBe("42501"); // insufficient_privilege: new row violates row-level security policy
  });

  it("A cannot attach a kit to B's run, even owning the kit row", async () => {
    const code = await rejectsWithCodeTdm11(
      scopedDb({ kind: "user", userId: a.userId }, h.db).transaction((tx) =>
        tx
          .insert(kits)
          .values({ ownerId: a.userId, runId: b.runId, version: 9, spec: {}, hash: "x" }),
      ),
    );
    expect(code).toBe("42501");
  });

  it("A's unfiltered update and delete touch only A's rows", async () => {
    const updated = await scopedDb({ kind: "user", userId: a.userId }, h.db).transaction((tx) =>
      tx.update(runs).set({ pausedReason: "touched" }).returning({ id: runs.id }),
    );
    expect(updated.map((r) => r.id)).toEqual([a.runId]);

    const rollback = new Error("rollback");
    let deleted: { id: string }[] = [];
    await expect(
      scopedDb({ kind: "user", userId: a.userId }, h.db).transaction(async (tx) => {
        deleted = await tx.delete(runs).returning({ id: runs.id });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(deleted.map((r) => r.id)).toEqual([a.runId]);

    const [bRun] = await h.db.select().from(runs).where(eq(runs.id, b.runId));
    expect(bRun!.pausedReason).toBeNull();
  });

  it("the app role with no actor set sees no tenant rows", async () => {
    const rows = await h.db.transaction(async (tx) => {
      await tx.execute(sql`set local role anybench_app`);
      return tx.select().from(runs);
    });
    expect(rows).toEqual([]);
  });

  it("role and actor are LOCAL: nothing leaks to the next transaction on the same connection", async () => {
    await scopedDb({ kind: "user", userId: a.userId }, h.db).transaction((tx) =>
      tx.select().from(runs),
    );
    const res = await h.db.execute<{ role: string; actor: string | null }>(
      sql`select current_user as role, nullif(current_setting('app.actor_id', true), '') as actor`,
    );
    expect(res.rows[0]!.role).not.toBe("anybench_app");
    expect(res.rows[0]!.actor).toBeNull();
    const all = await h.db.select().from(runs);
    expect(all).toHaveLength(2);
  });

  it("rejects a malformed actor before touching the database", () => {
    expect(() => scopedDb({ kind: "user", userId: "not-a-uuid" }, h.db)).toThrow();
    expect(() => scopedDb({ kind: "system", reason: "" }, h.db)).toThrow();
  });

  it("round-trips money above 2^53 exactly as bigint", async () => {
    const big = 9_007_199_254_740_993n;
    await h.db.update(runs).set({ spentMicroUsd: big }).where(eq(runs.id, b.runId));
    const [row] = await h.db
      .select({ spent: runs.spentMicroUsd })
      .from(runs)
      .where(eq(runs.id, b.runId));
    expect(row!.spent).toBe(big);
  });
});
