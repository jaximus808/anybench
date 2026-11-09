// TDM-242 [20.5]: every run's budget, on local Postgres (skips without it).
//   - spent_micro_usd tracks each charge type (run fee, compute at billed price, managed tokens
//     at billed price: cost + MANAGED_TOKEN_MARKUP_BPS since TDM-244),
//     BYOK tokens are reported apart, infra failures never count; terminal = the ledger's charges;
//   - the launch admission (trial store, under the run's lock) holds a trial whose cap would pass
//     the budget, and commits the one it admits;
//   - the advance loop holds a run in paused_budget before launching another trial, and a raised
//     budget (POST /runs/:id/resume) takes it to delivered;
//   - the free run's cap still holds (the same mechanism, free-run basis), and settling the held
//     free run scores what it has.
import { newId, TrialIdSchema, type KitSpec, type TrialState } from "@anybench/core";
import { leaseOwnerBase, type TransitionRequest } from "@anybench/bench";
import { FakeNaive } from "@anybench/naive/fake";
import { FakeProvider } from "@anybench/providers";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import {
  computers,
  contenders,
  events,
  freeStarterRuns,
  kits,
  runs,
  trials,
  usageEntries,
  users,
} from "../src/db/schema/index.js";
import { drizzleTrialExecStore } from "../src/jobs/trial-execute.js";
import {
  budgetPricingFromConfig,
  readRunBudget,
  storeRunBudget,
  terminalRunBudget,
  trialCap,
  type BudgetPricing,
} from "../src/orchestrator/budget.js";
import { naiveSessionCanceller } from "../src/orchestrator/defaults.js";
import { FakeAgentStages, FakePipeline } from "../src/orchestrator/fake.js";
import { fakeRunnerTdm49 } from "./helpers/fake-runner-tdm49.js";
import {
  digestTdm54,
  drainTdm54,
  kitTdm54,
  MemQueueTdm54,
  runJobTdm54,
  workerTdm54,
} from "./helpers/orchestrator-tdm54.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";
import { runsAppTdm67, seedUserTdm67, type RunsAppTdm67 } from "./helpers/runs-tdm67.js";
import { configTdm14 } from "./helpers/server-tdm14.js";

const available = await pgAvailableTdm11();
const BASE = "http://api.test";

/**
 * The defaults: $2 fee, +50% compute, +20% managed tokens, $0.0276 a block, $3 proxy ceiling,
 * $10 free-run cap.
 */
const PRICING: BudgetPricing = {
  runFeeMicroUsd: 2_000_000n,
  uploadedKitRunFeeMicroUsd: 0n,
  computeMarkupBps: 5000n,
  managedTokenMarkupBps: 2000n,
  blockPriceMicroUsd: 27_600n,
  proxyCapCeilingMicroUsd: 3_000_000n,
  freeRunCapMicroUsd: 10_000_000n,
};
/** kitTdm54's cli trial at its cap: 3600 s run + 4 × 300 s verbs + 60 s ready + 300 s boot = 9 blocks. */
const CAP_AT_COST = 9n * 27_600n;
const CAP_BILLED = CAP_AT_COST + CAP_AT_COST / 2n;
/** What one fast FakeProvider trial costs: its first block. */
const BLOCK_BILLED = 27_600n + 13_800n;
const actor = { kind: "worker" as const, id: "tdm242" };

let githubId = 242_000;

async function seedRun(
  db: Database,
  opts: { budget: bigint; state?: "running" | "paused_budget"; spec?: KitSpec },
) {
  const [u] = await db
    .insert(users)
    .values({ githubLogin: `budget-${githubId}`, githubId: githubId++ })
    .returning();
  const [run] = await db
    .insert(runs)
    .values({
      ownerId: u!.id,
      question: "cheaper?",
      budgetMicroUsd: opts.budget,
      state: opts.state ?? "running",
    })
    .returning();
  const spec = opts.spec ?? kitTdm54();
  const [kit] = await db
    .insert(kits)
    .values({ ownerId: u!.id, runId: run!.id, version: 1, spec, hash: `h-${run!.id}` })
    .returning();
  await db.update(runs).set({ kitId: kit!.id }).where(eq(runs.id, run!.id));
  const [c] = await db
    .insert(contenders)
    .values({
      runId: run!.id,
      kitId: kit!.id,
      source: spec.contenders[0]!.id,
      role: "subject",
      foundBy: "kit",
    })
    .returning();
  let repeat = 0;
  const trial = async (state: TrialState, extra: Partial<typeof trials.$inferInsert> = {}) => {
    const [t] = await db
      .insert(trials)
      .values({
        id: newId(TrialIdSchema),
        ownerId: u!.id,
        runId: run!.id,
        contenderId: c!.id,
        workloadId: spec.workloads[0]!.id,
        repeat: repeat++,
        state,
        ...extra,
      })
      .returning();
    return t!.id;
  };
  let pid = 0;
  const computer = async (
    trialId: string | null,
    extra: Partial<typeof computers.$inferInsert> = {},
  ) => {
    const [row] = await db
      .insert(computers)
      .values({
        provider: "naive",
        providerId: `${run!.id}-${pid++}`,
        runId: run!.id,
        trialId,
        status: "destroyed",
        ...extra,
      })
      .returning();
    if (trialId && row!.status !== "destroyed") {
      await db.update(trials).set({ computerId: row!.id }).where(eq(trials.id, trialId));
    }
    return row!.id;
  };
  return { ownerId: u!.id, runId: run!.id, trial, computer };
}

describe.skipIf(!available)("run budget (TDM-242, local Postgres)", () => {
  let h: FreshDbTdm11;

  beforeAll(async () => {
    h = await freshMigratedDbTdm11({ max: 8 });
  }, 60_000);

  afterAll(async () => {
    await h?.drop();
  });

  it("trialCap: compute up to the wall-clock cap at the billed price; the free run at our cost", () => {
    const spec = kitTdm54();
    const c = spec.contenders[0]!.id;
    const w = spec.workloads[0]!.id;
    expect(trialCap(spec, c, w, "billed", PRICING)).toEqual({
      compute: CAP_BILLED,
      managedTokens: 0n,
      total: CAP_BILLED,
      byokTokens: 0n,
    });
    expect(trialCap(spec, c, w, "free_run", PRICING).total).toBe(CAP_AT_COST);
  });

  it("spent_micro_usd tracks each charge type; BYOK apart; infra failures never count", async () => {
    const s = await seedRun(h.db, { budget: 20_000_000n });
    // done, on a proxy key: compute (2 blocks) + its Naïve proxy spend (managed tokens), billed
    // at cost + 20% (TDM-244): $0.40 of our cost counts $0.48.
    const a = await s.trial("done", {
      proxyKeyId: "key-a",
      metrics: { proxy_cost_micro_usd: 400_000 },
      tokenSpendMicroUsd: 999n,
    });
    const ca = await s.computer(a, { costMicroUsd: 55_200n });
    await h.db.update(trials).set({ computerId: ca }).where(eq(trials.id, a));
    // failed_subject on the user's own key: compute counts, its tokens are BYOK (reported only).
    const b = await s.trial("failed_subject", { tokenSpendMicroUsd: 250_000n });
    const cb = await s.computer(b, { costMicroUsd: 27_600n });
    await h.db.update(trials).set({ computerId: cb }).where(eq(trials.id, b));
    // an infra failure (our retry): its computer never counts.
    const inf = await s.trial("failed_infra", { attempt: 1 });
    await s.computer(inf, { costMicroUsd: 27_600n });
    // running for 15 minutes: 2 blocks so far, and the rest of its cap is committed.
    const d = await s.trial("running");
    await s.computer(d, {
      status: "running",
      createdAt: new Date(Date.now() - 15 * 60_000),
    });
    // queued: not spent, not committed, waits for room.
    const e = await s.trial("queued");
    // a run-level computer (a gate, an uploaded kit's proof) bills with the run.
    await s.computer(null, { costMicroUsd: 10_000n });

    const budget = await readRunBudget(h.db, s.runId, PRICING);
    expect(budget).not.toBeNull();
    const b0 = budget!;
    const compute = 82_800n + 41_400n + 82_800n + 15_000n;
    expect(b0.basis).toBe("billed");
    expect(b0.limit).toBe(20_000_000n);
    expect(b0.spent).toEqual({
      runFee: 2_000_000n,
      compute,
      managedTokens: 480_000n,
      total: 2_000_000n + compute + 480_000n,
    });
    expect(b0.committed).toBe(CAP_BILLED - 82_800n);
    expect(b0.byokTokens).toBe(250_000n);
    expect(b0.inFlight).toEqual([d]);
    expect(b0.queued).toEqual([{ id: e, cap: CAP_BILLED, byokCap: 0n }]);

    // Stored on the run, with a run.budget event whose cost delta is the change in spent.
    expect(await storeRunBudget(h.db, b0, actor)).toBe(true);
    expect(await storeRunBudget(h.db, b0, actor)).toBe(false);
    const [row] = await h.db.select().from(runs).where(eq(runs.id, s.runId));
    expect(row).toMatchObject({
      spentMicroUsd: b0.spent.total,
      committedMicroUsd: b0.committed,
      byokTokenMicroUsd: 250_000n,
      budgetBasis: "billed",
      budgetLimitMicroUsd: null,
    });
    const evs = await h.db
      .select()
      .from(events)
      .where(and(eq(events.runId, s.runId), eq(events.type, "run.budget")));
    expect(evs).toHaveLength(1);
    expect(evs[0]!.costDeltaMicroUsd).toBe(b0.spent.total);

    // Terminal: what the ledger actually charged replaces the live estimate.
    await h.db.update(runs).set({ state: "delivered" }).where(eq(runs.id, s.runId));
    await h.db.insert(usageEntries).values([
      {
        userId: s.ownerId,
        runId: s.runId,
        type: "run_fee",
        amountMicroUsd: 2_000_000n,
        idempotencyKey: `run:${s.runId}:fee`,
      },
      {
        userId: s.ownerId,
        runId: s.runId,
        type: "compute",
        amountMicroUsd: 120_000n,
        idempotencyKey: `computer:${s.runId}:compute`,
      },
      {
        userId: s.ownerId,
        runId: s.runId,
        trialId: a,
        type: "managed_tokens",
        amountMicroUsd: 480_000n,
        idempotencyKey: `tokens:trial:${a}`,
      },
    ]);
    const end = await terminalRunBudget(h.db, s.runId, PRICING);
    expect(end!.spent).toEqual({
      runFee: 2_000_000n,
      compute: 120_000n,
      managedTokens: 480_000n,
      total: 2_600_000n,
    });
    expect(end!.committed).toBe(0n);
  });

  it("launch admission: a trial whose cap would pass the budget is held; one that fits is committed", async () => {
    // Room for the fee and exactly one trial at its cap.
    const s = await seedRun(h.db, { budget: 2_000_000n + CAP_BILLED + 100n });
    const t1 = await s.trial("queued");
    const t2 = await s.trial("queued");
    const store = drizzleTrialExecStore(h.db, { budget: PRICING });
    const owner = `${leaseOwnerBase("tdm242-w", new Date(Date.now() - 1000))}~n`;
    const req: TransitionRequest = {
      command: { type: "advance" },
      expectAttempt: 1,
      emit: true,
      actor,
      at: new Date(),
    };
    expect(await store.acquireLease(t1, owner, 60_000)).not.toBeNull();
    const ok = await store.transition(t1, owner, req);
    expect(ok).toMatchObject({ ok: true, to: "forking" });
    const [after] = await h.db.select().from(runs).where(eq(runs.id, s.runId));
    expect(after!.committedMicroUsd).toBe(CAP_BILLED);
    expect(after!.spentMicroUsd).toBe(2_000_000n);

    expect(await store.acquireLease(t2, owner, 60_000)).not.toBeNull();
    const held = await store.transition(t2, owner, req);
    expect(held).toMatchObject({ ok: false, reason: "held" });
    expect(held.ok ? "" : held.message).toMatch(
      /spent \$2\.00 \+ \$0\.37 committed to running trials \+ \$0\.37 for the next trial at its cap would pass the \$2\.37 budget/,
    );
    const [t2row] = await h.db.select().from(trials).where(eq(trials.id, t2));
    expect(t2row!.state).toBe("queued");
    expect(t2row!.attempt).toBe(1);

    // A run held in paused_budget launches nothing, even a trial that fits.
    const p = await seedRun(h.db, { budget: 50_000_000n, state: "paused_budget" });
    const t3 = await p.trial("queued");
    expect(await store.acquireLease(t3, owner, 60_000)).not.toBeNull();
    expect(await store.transition(t3, owner, req)).toMatchObject({
      ok: false,
      reason: "held",
      message: "the run is paused for its budget",
    });
  });

  it("a run held past its budget carries a budget stop to its running trials", async () => {
    const s = await seedRun(h.db, { budget: 1_000_000n });
    const t = await s.trial("running");
    const store = drizzleTrialExecStore(h.db);
    const trial = (await store.get(t))!;
    expect(await store.cancelState(trial)).toEqual({ cancelled: false });
    await h.db
      .update(runs)
      .set({
        state: "paused_budget",
        stageOutputs: { budget_stop: { at: new Date().toISOString(), reason: "spent $1.20" } },
      })
      .where(eq(runs.id, s.runId));
    expect(await store.cancelState(trial)).toEqual({
      cancelled: false,
      budget_stop: "spent $1.20",
    });
  });
});

/** What each trial's runner read from ~/.anybench/budget-stop. */
const budgetStops = new Map<string, string>();

/**
 * A fake runner that, in `run`, waits for the worker's ~/.anybench/budget-stop and then ends the
 * trial failed_subject (`budget`), as packages/runner does.
 */
function budgetStopRunner(fake: FakeProvider): void {
  fake.onExec(/\.anybench\/bin\/runner' --trial/, async (ctx) => {
    const job = JSON.parse(ctx.readFile(`${ctx.home}/.anybench/trial.json`) ?? "{}") as {
      trial_id: string;
      run_id: string;
      attempt: number;
    };
    const started = new Date().toISOString();
    const write = (phase: string, result: unknown = null) => {
      const at = new Date().toISOString();
      ctx.writeFile(
        `${ctx.home}/eval/out/status.json`,
        JSON.stringify({
          trial_id: job.trial_id,
          run_id: job.run_id,
          attempt: job.attempt,
          runner_version: "fake",
          pid: 7,
          hostname: "fake",
          phase,
          trial_state: "running",
          started_at: started,
          updated_at: at,
          heartbeat_at: at,
          phases: [],
          push: { mode: "file_only", sent_batches: 0, failed_posts: 0, last_error: null },
          events: { count: 0, bytes: 0 },
          run: { exit_code: null, signal: null, duration_ms: 1, timed_out: false },
          upload: null,
          result,
        }),
      );
    };
    for (const phase of ["prepare", "healthcheck", "warmup"]) write(phase);
    for (let i = 0; i < 400; i++) {
      write("run");
      const stop = ctx.readFile(`${ctx.home}/.anybench/budget-stop`);
      if (stop !== undefined) {
        budgetStops.set(job.trial_id, stop);
        write("failed", { outcome: "failed_subject", reason: stop, failure_class: "budget" });
        return { exitCode: 11 };
      }
      await new Promise((res) => setTimeout(res, 20));
    }
    write("done", { outcome: "ok", reason: null, failure_class: null });
    return { exitCode: 0 };
  });
}

describe.skipIf(!available)(
  "the advance loop's budget hold (TDM-242, orchestrator end to end)",
  () => {
    let h: FreshDbTdm11;
    let api: RunsAppTdm67;
    let userId: string;
    let seq = 0;
    const naive = new FakeNaive();
    for (const role of ["understander", "researcher", "kit_designer", "analyst"]) {
      naive.scriptDefault(role, { output: { ok: true } });
    }

    beforeAll(async () => {
      h = await freshMigratedDbTdm11({ max: 8 });
      api = runsAppTdm67(h.url);
      userId = await seedUserTdm67(h.db, "budget-e2e");
    }, 60_000);

    afterAll(async () => {
      await api?.dbh.close();
      await h?.drop();
    });

    async function post(path: string, body: unknown) {
      const res = await api.app.request(`${BASE}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${userId}` },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    }

    function forward(queue: MemQueueTdm54, from: number) {
      for (const j of api.jobs.jobs.slice(from))
        void queue.add(j.task, j.payload, { jobKey: j.jobKey });
    }

    function rig(pricing?: BudgetPricing, opts: { budgetStopRunner?: boolean } = {}) {
      const queue = new MemQueueTdm54();
      const fake = new FakeProvider({ name: `fake-tdm242-${seq}` });
      if (opts.budgetStopRunner) budgetStopRunner(fake);
      else fakeRunnerTdm49(fake, { stepMs: 5 });
      const stages = new FakeAgentStages({ kit: kitTdm54(), naive: { client: naive, db: h.db } });
      const pipeline = new FakePipeline({ digest: digestTdm54() });
      const budget = pricing ?? budgetPricingFromConfig(configTdm14(h.url));
      const w = workerTdm54(
        h.db,
        h.url,
        `tdm242-worker-${seq++}`,
        queue,
        fake,
        {
          agents: () => stages,
          pipeline: () => pipeline,
          sessions: (ctx) => naiveSessionCanceller(ctx.db, naive),
          billingGate: () => async () => ({ allowed: true }),
          budget: () => budget,
        },
        {},
        { budget: () => budget },
      );
      return { queue, fake, w };
    }

    async function createRun(queue: MemQueueTdm54, budget: bigint): Promise<string> {
      const before = api.jobs.jobs.length;
      const res = await post("/runs", {
        question: "Is ripgrep faster than grep?",
        source: { kind: "github", github: "BurntSushi/ripgrep", ref: "14.1.1" },
        budget_micro_usd: budget.toString(),
        auto_go: true,
      });
      expect(res.status, JSON.stringify(res.json)).toBe(201);
      forward(queue, before);
      return (res.json.run as { id: string }).id;
    }

    const runRow = async (id: string) =>
      (await h.db.select().from(runs).where(eq(runs.id, id)))[0]!;
    const trialStates = async (id: string) =>
      (await h.db.select({ state: trials.state }).from(trials).where(eq(trials.runId, id)))
        .map((t) => t.state)
        .sort();
    const computerCount = async (id: string) =>
      (await h.db.select({ id: computers.id }).from(computers).where(eq(computers.runId, id)))
        .length;
    /** The most trials ever in flight at once, from the trial.phase events. */
    async function maxInFlight(id: string): Promise<number> {
      const rows = await h.db
        .select({ sourceId: events.sourceId, payload: events.payload })
        .from(events)
        .where(and(eq(events.runId, id), eq(events.type, "trial.phase")))
        .orderBy(asc(events.seq));
      const live = new Set<string>();
      let max = 0;
      for (const r of rows) {
        const p = r.payload as { from: string | null; to: string };
        if (p.to === "forking") live.add(r.sourceId!);
        if (["collecting", "failed_subject", "failed_infra", "cancelled"].includes(p.to))
          live.delete(r.sourceId!);
        max = Math.max(max, live.size);
      }
      return max;
    }

    it("a run crossing its budget goes to paused_budget before launching another trial; a raised budget delivers it", async () => {
      const r = rig();
      // The $2 fee plus room for one trial at its cap: trials go one at a time, and after the
      // second one's real compute the third no longer fits.
      const id = await createRun(r.queue, 2_000_000n + CAP_BILLED + 50_000n);
      await drainTdm54(r.w, r.queue);

      const held = await runRow(id);
      expect(held.state).toBe("paused_budget");
      expect(await trialStates(id)).toEqual([
        "done",
        "done",
        "queued",
        "queued",
        "queued",
        "queued",
      ]);
      expect(await computerCount(id)).toBe(2);
      expect(await maxInFlight(id)).toBe(1);
      expect(held.spentMicroUsd).toBe(2_000_000n + 2n * BLOCK_BILLED);
      expect(held.committedMicroUsd).toBe(0n);
      expect(held.pausedReason).toMatch(
        /^spent \$2\.08 \+ \$0\.00 committed to running trials \+ \$0\.37 for the next trial at its cap would pass the \$2\.42 budget\. 4 trial\(s\) not started\. Raise the budget to run them, or settle to score the 2 finished$/,
      );
      const [hold] = await h.db
        .select({ payload: events.payload })
        .from(events)
        .where(
          and(eq(events.runId, id), eq(events.type, "run.state_changed"), eq(events.sourceId, id)),
        )
        .orderBy(asc(events.seq))
        .then((rows) => rows.filter((e) => (e.payload as { to: string }).to === "paused_budget"));
      expect(hold!.payload).toMatchObject({
        from: "running",
        to: "paused_budget",
        command: "pause_budget",
      });

      // Raise the budget: the run resumes into running and finishes.
      const before = api.jobs.jobs.length;
      const res = await post(`/runs/${id}/resume`, { budget_micro_usd: "50000000" });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect((res.json.run as { state: string }).state).toBe("running");
      forward(r.queue, before);
      await drainTdm54(r.w, r.queue);
      const done = await runRow(id);
      expect(done.state).toBe("delivered");
      expect(await trialStates(id)).toEqual(Array(6).fill("done"));
      // Terminal: the ledger's charges (fee + six one-block computers at +50%).
      expect(done.spentMicroUsd).toBe(2_000_000n + 6n * BLOCK_BILLED);
      expect(done.committedMicroUsd).toBe(0n);
    }, 60_000);

    it("spent alone passing the budget while a trial runs: the run is held and the runner told to stop the subject", async () => {
      const r = rig(undefined, { budgetStopRunner: true });
      const id = await createRun(r.queue, 50_000_000n);
      // Drive the run until its trials are enqueued; then run ONE trial while the run advances.
      await drainTdm54(r.w, r.queue, {
        until: async () => [...r.queue.pending.values()].some((j) => j.task === "trial.execute"),
      });
      const job = [...r.queue.pending.values()].find((j) => j.task === "trial.execute")!;
      r.queue.pending.delete(job.key);
      const trialId = job.payload.trial_id as string;
      const running = runJobTdm54(r.w, r.queue, job);
      for (let i = 0; i < 200; i++) {
        const [t] = await h.db
          .select({ state: trials.state })
          .from(trials)
          .where(eq(trials.id, trialId));
        if (t?.state === "running") break;
        await new Promise((res) => setTimeout(res, 20));
      }
      // The budget drops under what the run already spent (the $2 fee): spent alone is past it.
      await h.db.update(runs).set({ budgetMicroUsd: 1_000_000n }).where(eq(runs.id, id));
      await runJobTdm54(r.w, r.queue, {
        task: "run.advance",
        payload: { run_id: id, reason: "poll" },
        key: `runs:${id}:poll`,
        runAt: null,
      });
      const held = await runRow(id);
      expect(held.state).toBe("paused_budget");
      expect(held.pausedReason).toMatch(
        /^spent \$2\.\d\d, past the \$1\.00 budget: stopping the 1 running trial\(s\); what they did so far is graded\. 5 trial\(s\) not started\. Raise the budget/,
      );
      expect(
        (held.stageOutputs as { budget_stop?: { reason: string } }).budget_stop?.reason,
      ).toMatch(/past the \$1\.00 budget/);
      // The executor wrote ~/.anybench/budget-stop; the runner stopped the subject (budget).
      await running;
      const [t] = await h.db.select().from(trials).where(eq(trials.id, trialId));
      expect(t).toMatchObject({ state: "failed_subject", failureClass: "budget" });
      expect(budgetStops.get(trialId)).toMatch(/past the \$1\.00 budget/);
      // The rest never launch while the run is held.
      await drainTdm54(r.w, r.queue);
      expect(await trialStates(id)).toEqual(["failed_subject", ...Array(5).fill("queued")]);
      expect((await runRow(id)).state).toBe("paused_budget");
    }, 60_000);

    it("the free run's cap still holds (free-run basis, our cost), and settling it scores what it has", async () => {
      const config = budgetPricingFromConfig(configTdm14(h.url));
      // A free run covering one trial's worst case plus a little: after two trials' real compute
      // the third no longer fits.
      const pricing = { ...config, freeRunCapMicroUsd: CAP_AT_COST + 52_000n };
      const r = rig(pricing);
      const id = await createRun(r.queue, 50_000_000n);
      await h.db
        .insert(freeStarterRuns)
        .values({ userId, runId: id, state: "reserved", reservedMicroUsd: 1_000_000n });
      await drainTdm54(r.w, r.queue);

      const held = await runRow(id);
      expect(held.state).toBe("paused_budget");
      expect(await trialStates(id)).toEqual([
        "done",
        "done",
        "queued",
        "queued",
        "queued",
        "queued",
      ]);
      expect(held).toMatchObject({
        budgetBasis: "free_run",
        budgetLimitMicroUsd: pricing.freeRunCapMicroUsd,
        // Compute at our cost: no run fee, no markup.
        spentMicroUsd: 2n * 27_600n,
      });
      expect(held.pausedReason).toMatch(
        /would pass the free run's \$0\.30 compute cap\. 4 trial\(s\) not started\. Settle to score the 2 finished, or cancel$/,
      );

      // A free run's cap is ours: it cannot be resumed with a bigger budget.
      const refused = await post(`/runs/${id}/resume`, { budget_micro_usd: "90000000" });
      expect(refused.status).toBe(409);

      // Settle: the queued trials are cancelled; every trial settled, the run scores what it has.
      const before = api.jobs.jobs.length;
      const settled = await post(`/runs/${id}/settle`, { reason: "free run cap" });
      expect(settled.status, JSON.stringify(settled.json)).toBe(200);
      forward(r.queue, before);
      await drainTdm54(r.w, r.queue);
      const done = await runRow(id);
      expect(done.state).toBe("delivered");
      expect(await trialStates(id)).toEqual([
        "cancelled",
        "cancelled",
        "cancelled",
        "cancelled",
        "done",
        "done",
      ]);
    }, 60_000);
  },
);
