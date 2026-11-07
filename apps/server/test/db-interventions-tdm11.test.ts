// TDM-11: the DB trigger that rejects admin grants and comps without an interventions row.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { creditGrants, interventions, runs, usageEntries, users } from "../src/db/schema/index.js";
import {
  freshMigratedDbTdm11,
  pgAvailableTdm11,
  rejectsWithCodeTdm11,
  type FreshDbTdm11,
} from "./helpers/pg-tdm11.js";

const available = await pgAvailableTdm11();
const CHECK_VIOLATION = "23514";

describe.skipIf(!available)("intervention guards (TDM-11, local Postgres)", () => {
  let h: FreshDbTdm11;
  let userId: string;
  let otherUserId: string;
  let runId: string;
  let otherRunId: string;

  beforeAll(async () => {
    h = await freshMigratedDbTdm11();
    const [u, o] = await h.db
      .insert(users)
      .values([
        { githubLogin: "carol", githubId: 2001 },
        { githubLogin: "dave", githubId: 2002 },
      ])
      .returning();
    userId = u!.id;
    otherUserId = o!.id;
    const [r1, r2] = await h.db
      .insert(runs)
      .values([
        { ownerId: userId, question: "q1", budgetMicroUsd: 1_000_000n },
        { ownerId: userId, question: "q2", budgetMicroUsd: 1_000_000n },
      ])
      .returning();
    runId = r1!.id;
    otherRunId = r2!.id;
  }, 60_000);

  afterAll(async () => {
    await h?.drop();
  });

  const adminGrant = (interventionId?: string) =>
    h.db.insert(creditGrants).values({
      userId,
      amountMicroUsd: 20_000_000n,
      category: "promotional",
      source: "admin",
      reason: "demo",
      interventionId,
    });

  it("rejects an admin credit grant with no intervention", async () => {
    expect(await rejectsWithCodeTdm11(adminGrant())).toBe(CHECK_VIOLATION);
  });

  it("rejects an admin credit grant whose intervention is about another user", async () => {
    const [i] = await h.db
      .insert(interventions)
      .values({ userId: otherUserId, who: "jaxon", what: "grant", why: "wrong user" })
      .returning();
    expect(await rejectsWithCodeTdm11(adminGrant(i!.id))).toBe(CHECK_VIOLATION);
  });

  it("accepts an admin grant written with its intervention in the same transaction", async () => {
    await h.db.transaction(async (tx) => {
      const [i] = await tx
        .insert(interventions)
        .values({ userId, who: "jaxon", what: "grant $20", why: "YC demo" })
        .returning();
      await tx.insert(creditGrants).values({
        userId,
        amountMicroUsd: 20_000_000n,
        category: "promotional",
        source: "admin",
        reason: "YC demo",
        interventionId: i!.id,
      });
    });
    const rows = await h.db.select().from(creditGrants).where(eq(creditGrants.userId, userId));
    expect(rows.map((r) => r.amountMicroUsd)).toEqual([20_000_000n]);
  });

  it("allows one signup grant without an intervention, and only one", async () => {
    const signup = () =>
      h.db.insert(creditGrants).values({
        userId: otherUserId,
        amountMicroUsd: 5_000_000n,
        category: "promotional",
        source: "signup",
        reason: "signup",
      });
    await signup();
    expect(await rejectsWithCodeTdm11(signup())).toBe("23505");
  });

  it("rejects stripping the intervention from an existing admin grant", async () => {
    const q = h.db
      .update(creditGrants)
      .set({ interventionId: null })
      .where(eq(creditGrants.userId, userId));
    expect(await rejectsWithCodeTdm11(q)).toBe(CHECK_VIOLATION);
  });

  it("rejects comping a run with no intervention, or with one for another run", async () => {
    const noIntervention = h.db
      .update(runs)
      .set({ compedBy: "jaxon", compedReason: "demo" })
      .where(eq(runs.id, runId));
    expect(await rejectsWithCodeTdm11(noIntervention)).toBe(CHECK_VIOLATION);

    const [wrong] = await h.db
      .insert(interventions)
      .values({ runId: otherRunId, who: "jaxon", what: "comp", why: "wrong run" })
      .returning();
    const wrongRun = h.db
      .update(runs)
      .set({ compedBy: "jaxon", compInterventionId: wrong!.id })
      .where(eq(runs.id, runId));
    expect(await rejectsWithCodeTdm11(wrongRun)).toBe(CHECK_VIOLATION);
  });

  it("accepts a comp with its intervention, and guards comped usage the same way", async () => {
    await h.db.transaction(async (tx) => {
      const [i] = await tx
        .insert(interventions)
        .values({ runId, userId, who: "jaxon", what: "comp run", why: "launch demo" })
        .returning();
      await tx
        .update(runs)
        .set({ compedBy: "jaxon", compedReason: "launch demo", compInterventionId: i!.id })
        .where(eq(runs.id, runId));
      await tx.insert(usageEntries).values({
        userId,
        runId,
        type: "trial_fee",
        amountMicroUsd: 250_000n,
        idempotencyKey: `trial_fee:${runId}:1`,
        compedBy: "jaxon",
        interventionId: i!.id,
      });
    });
    const [r] = await h.db.select().from(runs).where(eq(runs.id, runId));
    expect(r!.compedBy).toBe("jaxon");

    const comped = h.db.insert(usageEntries).values({
      userId,
      runId: otherRunId,
      type: "trial_fee",
      amountMicroUsd: 250_000n,
      idempotencyKey: `trial_fee:${otherRunId}:1`,
      compedBy: "jaxon",
    });
    expect(await rejectsWithCodeTdm11(comped)).toBe(CHECK_VIOLATION);
  });
});
