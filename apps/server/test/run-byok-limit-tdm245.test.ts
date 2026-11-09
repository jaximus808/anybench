// TDM-245 [21.5]: a run-level hard stop on model tokens on the user's own key (BYOK), on local
// Postgres (skips without it). The budget (TDM-242) never counts BYOK tokens; with
// runs.byok_token_limit_micro_usd set they are held the same way, apart from it:
//   - trialCap carries each trial's BYOK cap (token_cap_micro_usd of a contender on the user's key);
//   - readRunBudget: BYOK spent (measured; a finished trial with no reading at its cap) and BYOK
//     committed (each BYOK trial in flight at its cap);
//   - the launch admission (trial store, under the run's lock) holds a trial whose BYOK cap would
//     pass the limit and commits the one it admits;
//   - the advance loop launches only what fits and holds the run in paused_budget with the reason;
//     POST /runs/:id/resume with a higher byok_token_limit_micro_usd lets the next trial go;
//   - POST /runs takes the limit and GET returns it.
import path from "node:path";
import { newId, toJsonValue, TrialIdSchema, type KitSpec, type TrialState } from "@anybench/core";
import { leaseOwnerBase, type TransitionRequest } from "@anybench/bench";
import { loadKit } from "@anybench/kit";
import { FakeProvider } from "@anybench/providers";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { contenders, kits, runs, trials } from "../src/db/schema/index.js";
import { drizzleTrialExecStore } from "../src/jobs/trial-execute.js";
import { readRunBudget, trialCap, type BudgetPricing } from "../src/orchestrator/budget.js";
import {
  CURATED_HARNESS_LEAGUE_KIT,
  defaultKitsDir,
  LEAGUE_V1_WORKLOAD,
  leagueProfile,
} from "../src/orchestrator/curated.js";
import { FakeAgentStages, FakePipeline } from "../src/orchestrator/fake.js";
import { fakeRunnerTdm49 } from "./helpers/fake-runner-tdm49.js";
import {
  digestTdm54,
  kitTdm54,
  MemQueueTdm54,
  runJobTdm54,
  workerTdm54,
} from "./helpers/orchestrator-tdm54.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";
import { runsAppTdm67, seedUserTdm67, type RunsAppTdm67 } from "./helpers/runs-tdm67.js";

const available = await pgAvailableTdm11();
const BASE = "http://api.test";
const PRICING: BudgetPricing = {
  runFeeMicroUsd: 2_000_000n,
  uploadedKitRunFeeMicroUsd: 0n,
  computeMarkupBps: 5000n,
  managedTokenMarkupBps: 2000n,
  blockPriceMicroUsd: 27_600n,
  proxyCapCeilingMicroUsd: 3_000_000n,
};
/** Every league setup's per-trial cap on the user's key. */
const CAP = 25_000_000n;
const actor = { kind: "worker" as const, id: "tdm245" };

/** The league's v1 cut at 1 repeat: one trial per setup (5), each $25 on the owner's key. */
async function leagueSpec(): Promise<KitSpec> {
  const kit = (await loadKit(path.join(defaultKitsDir(), CURATED_HARNESS_LEAGUE_KIT))).spec;
  const cut = leagueProfile(kit, { workloads: [LEAGUE_V1_WORKLOAD], repeats: 1 });
  if (!cut.ok) throw new Error(cut.reason);
  return cut.spec;
}

/** A run on `spec` with one trial per setup in the given states (kit order). */
async function seedLeagueRun(
  db: Database,
  ownerId: string,
  spec: KitSpec,
  opts: { budget: bigint; byokLimit: bigint | null; state?: "running" | "paused_budget" },
  states: [TrialState, Partial<typeof trials.$inferInsert>?][],
) {
  const [run] = await db
    .insert(runs)
    .values({
      ownerId,
      question: "harness league",
      budgetMicroUsd: opts.budget,
      byokTokenLimitMicroUsd: opts.byokLimit,
      state: opts.state ?? "running",
    })
    .returning();
  const [kit] = await db
    .insert(kits)
    .values({ ownerId, runId: run!.id, version: 1, spec: toJsonValue(spec), hash: `h-${run!.id}` })
    .returning();
  await db.update(runs).set({ kitId: kit!.id }).where(eq(runs.id, run!.id));
  const ids: string[] = [];
  for (const [i, c] of spec.contenders.entries()) {
    const [row] = await db
      .insert(contenders)
      .values({ runId: run!.id, kitId: kit!.id, source: c.id, role: c.role, foundBy: "kit" })
      .returning();
    const [state, extra] = states[i] ?? ["queued"];
    const [t] = await db
      .insert(trials)
      .values({
        id: newId(TrialIdSchema),
        ownerId,
        runId: run!.id,
        contenderId: row!.id,
        workloadId: spec.workloads[0]!.id,
        repeat: 0,
        state,
        ...extra,
      })
      .returning();
    ids.push(t!.id);
  }
  return { runId: run!.id, ids };
}

describe.skipIf(!available)("BYOK token limit (TDM-245, local Postgres)", () => {
  let h: FreshDbTdm11;
  let api: RunsAppTdm67;
  let userId: string;
  let spec: KitSpec;

  beforeAll(async () => {
    h = await freshMigratedDbTdm11({ max: 8 });
    api = runsAppTdm67(h.url);
    userId = await seedUserTdm67(h.db, "byok-limit");
    spec = await leagueSpec();
  }, 60_000);

  afterAll(async () => {
    await api?.dbh.close();
    await h?.drop();
  });

  it("trialCap carries the BYOK cap of a contender on the user's key, 0 for any other", () => {
    for (const c of spec.contenders) {
      expect(trialCap(spec, c.id, LEAGUE_V1_WORKLOAD, "billed", PRICING).byokTokens, c.id).toBe(
        CAP,
      );
    }
    const cli = kitTdm54();
    expect(
      trialCap(cli, cli.contenders[0]!.id, cli.workloads[0]!.id, "billed", PRICING).byokTokens,
    ).toBe(0n);
    // A BYOK contender with no cap cannot be bounded.
    const uncapped: KitSpec = {
      ...spec,
      contenders: spec.contenders.map((c) =>
        c.driver.type === "coding-agent" || c.driver.type === "harness"
          ? { ...c, driver: { ...c.driver, token_cap_micro_usd: undefined } }
          : c,
      ),
    };
    expect(
      trialCap(uncapped, "claude-code-solo", LEAGUE_V1_WORKLOAD, "billed", PRICING).byokTokens,
    ).toBeNull();
  });

  it("BYOK spent and committed: measured spend, an unread finished trial at its cap, in-flight trials at their caps", async () => {
    const s = await seedLeagueRun(
      h.db,
      userId,
      spec,
      { budget: 500_000_000n, byokLimit: 150_000_000n },
      [
        ["done", { tokenSpendMicroUsd: 10_000_000n }],
        ["failed_subject"], // no reading: counted at its cap
        ["running"],
        ["queued"],
        ["failed_infra", { tokenSpendMicroUsd: 1_000_000n }], // our failure, but real spend on the key
      ],
    );
    const b = (await readRunBudget(h.db, s.runId, PRICING))!;
    expect(b.byok).toEqual({
      limit: 150_000_000n,
      spent: 10_000_000n + CAP + 1_000_000n,
      committed: CAP,
      unbounded: false,
    });
    // Reported BYOK tokens stay what was measured.
    expect(b.byokTokens).toBe(11_000_000n);
    expect(b.queued).toEqual([{ id: s.ids[3], cap: expect.any(BigInt), byokCap: CAP }]);

    // A collecting trial whose runner ended has its reading: measured, no longer committed.
    const c = await seedLeagueRun(
      h.db,
      userId,
      spec,
      { budget: 500_000_000n, byokLimit: 150_000_000n },
      [["collecting", { tokenSpendMicroUsd: 5_000_000n }], ["running"]],
    );
    expect((await readRunBudget(h.db, c.runId, PRICING))!.byok).toMatchObject({
      spent: 5_000_000n,
      committed: CAP,
    });

    const none = await seedLeagueRun(
      h.db,
      userId,
      spec,
      { budget: 500_000_000n, byokLimit: null },
      [],
    );
    expect((await readRunBudget(h.db, none.runId, PRICING))!.byok.limit).toBeNull();
  });

  it("launch admission: a trial whose BYOK cap would pass the limit is held; one that fits is committed", async () => {
    // $10 spent, room for exactly two more $25 trials under a $60 limit; the budget is ample.
    const s = await seedLeagueRun(
      h.db,
      userId,
      spec,
      { budget: 500_000_000n, byokLimit: 60_000_000n },
      [
        ["done", { tokenSpendMicroUsd: 10_000_000n }],
        ["queued"],
        ["queued"],
        ["queued"],
        ["queued"],
      ],
    );
    const store = drizzleTrialExecStore(h.db, { budget: PRICING });
    const owner = `${leaseOwnerBase("tdm245-w", new Date(Date.now() - 1000))}~n`;
    const req: TransitionRequest = {
      command: { type: "advance" },
      expectAttempt: 1,
      emit: true,
      actor,
      at: new Date(),
    };
    for (const id of [s.ids[1]!, s.ids[2]!]) {
      expect(await store.acquireLease(id, owner, 60_000)).not.toBeNull();
      expect(await store.transition(id, owner, req)).toMatchObject({ ok: true, to: "forking" });
    }
    const b = (await readRunBudget(h.db, s.runId, PRICING))!;
    expect(b.byok).toMatchObject({ spent: 10_000_000n, committed: 2n * CAP });
    expect(await store.acquireLease(s.ids[3]!, owner, 60_000)).not.toBeNull();
    const held = await store.transition(s.ids[3]!, owner, req);
    expect(held).toMatchObject({ ok: false, reason: "held" });
    expect(held.ok ? "" : held.message).toBe(
      "BYOK tokens spent $10.00 + $50.00 committed to running trials at their caps + $25.00 for the next trial at its cap would pass the $60.00 BYOK token limit",
    );
    const [row] = await h.db.select().from(trials).where(eq(trials.id, s.ids[3]!));
    expect(row).toMatchObject({ state: "queued", attempt: 1 });

    // No limit: the same run shape launches every trial (BYOK tokens never hold it).
    const free = await seedLeagueRun(
      h.db,
      userId,
      spec,
      { budget: 500_000_000n, byokLimit: null },
      [
        ["done", { tokenSpendMicroUsd: 100_000_000n }],
        ["running"],
        ["running"],
        ["running"],
        ["queued"],
      ],
    );
    expect(await store.acquireLease(free.ids[4]!, owner, 60_000)).not.toBeNull();
    expect(await store.transition(free.ids[4]!, owner, req)).toMatchObject({ ok: true });
  });

  it("the advance loop launches only what fits, holds the run when nothing does, and a raised limit lets the next trial go", async () => {
    const queue = new MemQueueTdm54();
    const fake = new FakeProvider({ name: "fake-tdm245-byok" });
    fakeRunnerTdm49(fake, { stepMs: 5 });
    const w = workerTdm54(
      h.db,
      h.url,
      "tdm245-byok-worker",
      queue,
      fake,
      {
        agents: () => new FakeAgentStages({ kit: kitTdm54() }),
        pipeline: () => new FakePipeline({ digest: digestTdm54() }),
        billingGate: () => async () => ({ allowed: true }),
        budget: () => PRICING,
      },
      {},
      { budget: () => PRICING },
    );
    const advance = (runId: string) =>
      runJobTdm54(w, queue, {
        task: "run.advance",
        payload: { run_id: runId, reason: "poll" },
        key: `runs:${runId}:poll`,
        runAt: null,
      });
    const launchJobs = () =>
      [...queue.pending.values()]
        .filter((j) => j.task === "trial.execute")
        .map((j) => j.payload.trial_id as string);

    // $10 + $25 (no reading) + $25 in flight = $60 of a $70 limit: no room for the next $25 trial.
    const s = await seedLeagueRun(
      h.db,
      userId,
      spec,
      { budget: 500_000_000n, byokLimit: 70_000_000n },
      [
        ["done", { tokenSpendMicroUsd: 10_000_000n }],
        ["done"],
        ["running", { leaseOwner: "someone~1", leaseUntil: new Date(Date.now() + 600_000) }],
        ["queued"],
        ["queued"],
      ],
    );
    await advance(s.runId);
    let run = (await h.db.select().from(runs).where(eq(runs.id, s.runId)))[0]!;
    // A trial is still running (its real spend may come in lower): wait, launch nothing.
    expect(run.state).toBe("running");
    expect(launchJobs()).toEqual([]);

    // It ends at $20: $55 spent, nothing in flight, and $25 more would pass $70: hold.
    await h.db
      .update(trials)
      .set({ state: "done", tokenSpendMicroUsd: 20_000_000n, leaseOwner: null, leaseUntil: null })
      .where(eq(trials.id, s.ids[2]!));
    await advance(s.runId);
    run = (await h.db.select().from(runs).where(eq(runs.id, s.runId)))[0]!;
    expect(run.state).toBe("paused_budget");
    expect(run.pausedReason).toBe(
      "BYOK tokens spent $55.00 + $0.00 committed to running trials at their caps + $25.00 for the next trial at its cap would pass the $70.00 BYOK token limit. 2 trial(s) not started. Raise the BYOK token limit to run them, or settle to score the 3 finished",
    );
    expect(launchJobs()).toEqual([]);

    // Raise the limit to $100 through the API: one more $25 trial fits ($80), the second does not.
    const res = await api.app.request(`${BASE}/runs/${s.runId}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${userId}` },
      body: JSON.stringify({ byok_token_limit_micro_usd: "100000000" }),
    });
    const json = (await res.json()) as {
      run: { state: string; byok_token_limit_micro_usd: string };
    };
    expect(res.status, JSON.stringify(json)).toBe(200);
    expect(json.run).toMatchObject({ state: "running", byok_token_limit_micro_usd: "100000000" });
    await advance(s.runId);
    run = (await h.db.select().from(runs).where(eq(runs.id, s.runId)))[0]!;
    expect(run.state).toBe("running");
    expect(launchJobs()).toEqual([s.ids[3]]);
  }, 60_000);

  it("BYOK spent past the limit while trials run: the run is held with a budget stop", async () => {
    const queue = new MemQueueTdm54();
    const fake = new FakeProvider({ name: "fake-tdm245-byok-stop" });
    fakeRunnerTdm49(fake, { stepMs: 5 });
    const w = workerTdm54(
      h.db,
      h.url,
      "tdm245-byok-stop",
      queue,
      fake,
      {
        agents: () => new FakeAgentStages({ kit: kitTdm54() }),
        pipeline: () => new FakePipeline({ digest: digestTdm54() }),
        billingGate: () => async () => ({ allowed: true }),
        budget: () => PRICING,
      },
      {},
      { budget: () => PRICING },
    );
    // A trial overran its cap on the key ($40 measured): $40 > the $30 limit with one running.
    const s = await seedLeagueRun(
      h.db,
      userId,
      spec,
      { budget: 500_000_000n, byokLimit: 30_000_000n },
      [
        ["done", { tokenSpendMicroUsd: 40_000_000n }],
        ["running", { leaseOwner: "someone~1", leaseUntil: new Date(Date.now() + 600_000) }],
        ["queued"],
        ["queued"],
        ["queued"],
      ],
    );
    await runJobTdm54(w, queue, {
      task: "run.advance",
      payload: { run_id: s.runId, reason: "poll" },
      key: `runs:${s.runId}:poll`,
      runAt: null,
    });
    const [run] = await h.db.select().from(runs).where(eq(runs.id, s.runId));
    expect(run!.state).toBe("paused_budget");
    expect(run!.pausedReason).toMatch(
      /^BYOK tokens spent \$40\.00, past the \$30\.00 BYOK token limit: stopping the 1 running trial\(s\); what they did so far is graded\. 3 trial\(s\) not started\./,
    );
    expect((run!.stageOutputs as { budget_stop?: { reason: string } }).budget_stop?.reason).toBe(
      "BYOK tokens spent $40.00, past the $30.00 BYOK token limit",
    );
    // The running trial's executor reads the stop.
    const store = drizzleTrialExecStore(h.db);
    expect(await store.cancelState((await store.get(s.ids[1]!))!)).toEqual({
      cancelled: false,
      budget_stop: "BYOK tokens spent $40.00, past the $30.00 BYOK token limit",
    });
  }, 60_000);

  it("POST /runs takes byok_token_limit_micro_usd and the run shows it; omitted it is null", async () => {
    const create = async (extra: Record<string, unknown>) => {
      const res = await api.app.request(`${BASE}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${userId}` },
        body: JSON.stringify({
          question: "harness league n=5",
          source: { kind: "github", github: "jaximus808/tandem" },
          budget_micro_usd: "60000000",
          auto_go: false,
          ...extra,
        }),
      });
      return { status: res.status, json: (await res.json()) as { run: Record<string, unknown> } };
    };
    const limited = await create({ byok_token_limit_micro_usd: "150000000" });
    expect(limited.status).toBe(201);
    expect(limited.json.run.byok_token_limit_micro_usd).toBe("150000000");
    const [row] = await h.db
      .select()
      .from(runs)
      .where(and(eq(runs.id, limited.json.run.id as string)));
    expect(row!.byokTokenLimitMicroUsd).toBe(150_000_000n);
    const open = await create({});
    expect(open.json.run.byok_token_limit_micro_usd).toBeNull();
    expect((await create({ byok_token_limit_micro_usd: "0" })).status).toBe(400);
  });
});
