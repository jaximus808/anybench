// TDM-55 [6.1] LIVE: one tiny real Naïve session through runAgentStage (the echo fixture role on
// a cheap model), then a replay with the same key that must not create or pay for a second
// session. Runs only with NAIVE_LIVE=1, a key and local Postgres; costs well under $0.01:
//   cd apps/server && NAIVE_LIVE=1 node --env-file=<repo>/.env ../../node_modules/vitest/vitest.mjs \
//     run test/agent-session-naive-live-tdm55.test.ts --reporter=verbose
import { fileURLToPath } from "node:url";
import { roleAgentSpec, syncAgents } from "@anybench/agents";
import { createNaiveClientFromEnv, retryOnNaiveCapacity } from "@anybench/naive";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { agentEvents, agentSessions, costEntries, runs, users } from "../src/db/schema/index.js";
import { agentSessionIdFor, runAgentStage } from "../src/jobs/agent-session.js";
import type { RunIntake, StageContext, StageEventDraft } from "../src/orchestrator/ports.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";

const LIVE = process.env.NAIVE_LIVE === "1" && !!process.env.NAIVE_API_KEY;
const available = LIVE && (await pgAvailableTdm11());
const ROLES = fileURLToPath(
  new URL("../../../packages/agents/test/fixtures-tdm55/roles/", import.meta.url),
);
const NAME = "anybench-tdm55-echo";

describe.skipIf(!available)("runAgentStage on live Naïve (TDM-55)", () => {
  let fresh: FreshDbTdm11;
  let runId: string;

  beforeAll(async () => {
    fresh = await freshMigratedDbTdm11({ max: 2 });
    const [u] = await fresh.db
      .insert(users)
      .values({ githubLogin: "tdm55-live", githubId: 5_500_099 })
      .returning();
    const [r] = await fresh.db
      .insert(runs)
      .values({ ownerId: u!.id, question: "live echo", budgetMicroUsd: 1_000_000n })
      .returning();
    runId = r!.id;
  }, 60_000);

  afterAll(async () => {
    await fresh?.drop();
  });

  it("syncs the role, runs one session, persists it, and replays without paying twice", async () => {
    const client = createNaiveClientFromEnv();
    const [synced] = await syncAgents(client, {
      rolesDir: ROLES,
      overrides: { echo: { name: NAME } },
    });
    console.log(`sync: ${synced!.action} ${synced!.agent.name} v${synced!.agent.version}`);
    const [again] = await syncAgents(client, {
      rolesDir: ROLES,
      overrides: { echo: { name: NAME } },
    });
    expect(again!.action).toBe("unchanged");

    const emitted: StageEventDraft[] = [];
    const ctx: StageContext = {
      run: {
        id: runId,
        owner_id: "x",
        project_id: null,
        question: "live echo",
        intake: {} as RunIntake,
        budget_micro_usd: 1_000_000n,
        spent_micro_usd: 0n,
      },
      idempotencyKey: `${runId}:understand:0`,
      signal: new AbortController().signal,
      emit: async (d) => {
        emitted.push(...d);
      },
    };
    const schema = z.object({ echo: z.string(), length: z.int().nonnegative() });
    const args = {
      role: "echo",
      input: { word: "anybench" },
      schema,
      budgetMicroUsd: 50_000n,
      agent: roleAgentSpec("echo", { rolesDir: ROLES, name: NAME }),
    };
    const started = Date.now();
    // A 429 "at capacity" throws (transient); the job would retry the stage, so do the same here.
    const r = await retryOnNaiveCapacity(
      "stage",
      () => runAgentStage({ db: fresh.db, client }, { ctx, ...args }),
      { onRetry: (x) => console.log(`retry ${x.op} #${x.attempt} in ${x.waitMs} ms`) },
    );
    console.log(
      "first:",
      JSON.stringify(r, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
      `${Date.now() - started} ms`,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.output).toEqual({ echo: "anybench", length: 8 });
    expect(r.value.costMicroUsd).toBeLessThanOrEqual(50_000n);

    const id = agentSessionIdFor(ctx.idempotencyKey, "echo");
    const [row] = await fresh.db.select().from(agentSessions).where(eq(agentSessions.id, id));
    const evs = await fresh.db.select().from(agentEvents).where(eq(agentEvents.agentSessionId, id));
    const costs = await fresh.db.select().from(costEntries).where(eq(costEntries.runId, runId));
    console.log(
      `row: status ${row!.status}, stop ${row!.stopReason}, last_seq ${row!.lastSeq}, cost ${row!.costMicroUsd} µ$; ${evs.length} agent_events (${[...new Set(evs.map((e) => e.type))].join(", ")}); ${emitted.length} agent.message; cost_entries ${costs.map((c) => c.amountMicroUsd).join(",")}`,
    );
    expect(row).toMatchObject({ status: "done", naiveSessionId: r.value.naiveSessionId });
    expect(evs.length).toBe(row!.lastSeq);

    const replay = await runAgentStage(
      { db: fresh.db, client },
      { ctx: { ...ctx, emit: async () => {} }, ...args },
    );
    expect(replay).toMatchObject({
      ok: true,
      value: {
        replayed: true,
        naiveSessionId: r.value.naiveSessionId,
        costMicroUsd: r.value.costMicroUsd,
      },
    });
    const costsAfter = await fresh.db
      .select()
      .from(costEntries)
      .where(eq(costEntries.runId, runId));
    expect(costsAfter).toHaveLength(costs.length);
    console.log(
      `replay: same session ${r.value.naiveSessionId}, cost entries ${costsAfter.length}`,
    );
  }, 180_000);
});
