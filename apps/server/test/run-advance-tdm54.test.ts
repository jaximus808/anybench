// TDM-54: the run orchestrator (run.advance + run.sweep) on local Postgres, with FakeNaive,
// FakeProvider (the real trial.execute and a fake runner) and FakeAgentStages / FakePipeline:
// a full run to delivered, a worker killed at every stage and recovered by the sweep (no duplicate
// trials, Naïve sessions replayed), user cancel, kill switch, pause, holds and proof repair.
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLedger } from "@anybench/billing";
import { loadKit, validateKitDir } from "@anybench/kit";
import { safeParseKitSpec } from "@anybench/core";
import { FakeNaive } from "@anybench/naive/fake";
import { FakeProvider } from "@anybench/providers";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentSessions,
  computers,
  contenders,
  events,
  interventions,
  killSwitches,
  kits,
  reports,
  runs,
  trials,
  usageEntries,
  users,
} from "../src/db/schema/index.js";
import { ADMIN_AUTO_COMP_REASON } from "../src/lib/billing-gate.js";
import { JOBS } from "../src/jobs/index.js";
import {
  createRunAdvanceJob,
  RUN_SWEEP_INTERVAL_MS,
  runAdvanceJob,
  runSweepJob,
  sweepRuns,
  type RunAdvanceJobOptions,
} from "../src/jobs/run-advance.js";
import type { RunChargesHook } from "../src/orchestrator/advance.js";
import {
  CURATED_KIT_UNAVAILABLE,
  CURATED_TANDEM_KIT,
  curatedKitStages,
  defaultKitsDir,
  isTandemRepo,
  smokeProfile,
  trialCount,
  wantsFullBenchmark,
} from "../src/orchestrator/curated.js";
import { naiveSessionCanceller } from "../src/orchestrator/defaults.js";
import { stageHold } from "../src/orchestrator/ports.js";
import {
  FakeAgentStages,
  FakePipeline,
  failingProof,
  passingProof,
  type FakeAgentStagesOptions,
  type FakeRole,
} from "../src/orchestrator/fake.js";
import { fakeRunnerTdm49 } from "./helpers/fake-runner-tdm49.js";
import {
  digestTdm54,
  drainTdm54,
  killWorkerTdm54,
  kitTdm54,
  MemQueueTdm54,
  runJobTdm54,
  workerTdm54,
  type WorkerTdm54,
} from "./helpers/orchestrator-tdm54.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";
import { runsAppTdm67, seedUserTdm67, type RunsAppTdm67 } from "./helpers/runs-tdm67.js";

const available = await pgAvailableTdm11();
const KIT_EXAMPLE_DIR = fileURLToPath(
  new URL("../../../packages/kit/examples/harness/", import.meta.url),
);
const BASE = "http://api.test";
/** kitTdm54: 2 contenders × 1 workload × (1 warm-up + 2 measured repeats). */
const TRIALS = 6;

const HAPPY_PATH = [
  [null, "intake"],
  ["intake", "understand"],
  ["understand", "research"],
  ["research", "kit_draft"],
  ["kit_draft", "env_build"],
  ["env_build", "proof"],
  ["proof", "awaiting_go"],
  ["awaiting_go", "running"],
  ["running", "scoring"],
  ["scoring", "analyzing"],
  ["analyzing", "delivered"],
];

interface ChargeCall {
  runId: string;
  state: string;
  cancelCause: string | null;
}

describe.skipIf(!available)("run orchestrator (TDM-54)", () => {
  let h: FreshDbTdm11;
  let api: RunsAppTdm67;
  let userId: string;
  let workerSeq = 0;
  const sharedNaive = new FakeNaive();
  for (const role of ["understander", "researcher", "kit_designer", "analyst"]) {
    sharedNaive.scriptDefault(role, { output: { ok: true } });
  }

  beforeAll(async () => {
    h = await freshMigratedDbTdm11({ max: 8 });
    api = runsAppTdm67(h.url);
    userId = await seedUserTdm67(h.db, "orchestrator");
  }, 60_000);

  afterAll(async () => {
    await api?.dbh.close();
    await h?.drop();
  });

  // ---------- helpers ----------

  async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    const res = await api.app.request(`${BASE}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${userId}`,
        ...headers,
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { run?: { id: string; state: string } };
    return { status: res.status, json };
  }

  /** POST /runs, then hand the API's run.advance job to the in-memory queue. */
  async function createRun(queue: MemQueueTdm54, body: Record<string, unknown> = {}) {
    const before = api.jobs.jobs.length;
    const res = await post("/runs", {
      question: "Is ripgrep faster than grep?",
      source: { kind: "github", github: "BurntSushi/ripgrep", ref: "14.1.1" },
      budget_micro_usd: "50000000",
      ...body,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    forwardApiJobs(queue, before);
    return res.json.run!.id;
  }

  function forwardApiJobs(queue: MemQueueTdm54, from: number) {
    for (const j of api.jobs.jobs.slice(from)) {
      void queue.add(j.task, j.payload, { jobKey: j.jobKey });
    }
  }

  interface Rig {
    queue: MemQueueTdm54;
    fake: FakeProvider;
    naive: FakeNaive;
    charges: ChargeCall[];
    worker(opts?: {
      stages?: Partial<FakeAgentStagesOptions>;
      orchestrator?: RunAdvanceJobOptions;
      env?: Record<string, string>;
    }): { w: WorkerTdm54; stages: FakeAgentStages; pipeline: FakePipeline };
  }

  function rig(): Rig {
    const queue = new MemQueueTdm54();
    const fake = new FakeProvider({ name: `fake-tdm54-${workerSeq}` });
    fakeRunnerTdm49(fake, { stepMs: 5 });
    // One FakeNaive for the file: its session ids restart per instance, and
    // agent_sessions.naive_session_id is unique across the database.
    const naive = sharedNaive;
    const charges: ChargeCall[] = [];
    const hook: RunChargesHook = {
      async recordRunCharges(input) {
        charges.push({ runId: input.runId, state: input.state, cancelCause: input.cancelCause });
      },
    };
    return {
      queue,
      fake,
      naive,
      charges,
      worker(opts = {}) {
        // A hanging role's Naïve session stays running until it is cancelled.
        for (const role of opts.stages?.hang ?? []) naive.script(role, { hang: true });
        const stages = new FakeAgentStages({
          kit: kitTdm54(),
          naive: { client: naive, db: h.db },
          ...opts.stages,
        });
        const pipeline = new FakePipeline({ digest: digestTdm54() });
        const w = workerTdm54(
          h.db,
          h.url,
          `tdm54-worker-${workerSeq++}`,
          queue,
          fake,
          {
            agents: () => stages,
            pipeline: () => pipeline,
            sessions: (ctx) => naiveSessionCanceller(ctx.db, naive),
            billingGate: () => async () => ({ allowed: true }),
            charges: () => hook,
            ...opts.orchestrator,
          },
          opts.env,
        );
        return { w, stages, pipeline };
      },
    };
  }

  async function runRow(id: string) {
    const [r] = await h.db.select().from(runs).where(eq(runs.id, id));
    return r!;
  }

  async function stateEdges(id: string): Promise<(string | null)[][]> {
    const rows = await h.db
      .select({ payload: events.payload })
      .from(events)
      .where(and(eq(events.runId, id), eq(events.type, "run.state_changed")))
      .orderBy(asc(events.seq));
    return rows.map((r) => {
      const p = r.payload as { from: string | null; to: string };
      return [p.from, p.to];
    });
  }

  /** Evidence: the run's events, one line each (TDM54_EVIDENCE=1). */
  async function printRunTdm54(id: string) {
    const rows = await h.db
      .select({
        seq: events.seq,
        type: events.type,
        sourceId: events.sourceId,
        payload: events.payload,
      })
      .from(events)
      .where(eq(events.runId, id))
      .orderBy(asc(events.seq));
    const lines = rows.map((e) => {
      const p = e.payload as Record<string, unknown>;
      const what =
        e.type === "run.state_changed" || e.type === "trial.phase"
          ? `${String(p.from ?? "∅")} → ${String(p.to)}${p.command ? ` (${String(p.command)})` : ""}${p.reason ? ` "${String(p.reason)}"` : ""}`
          : e.type === "agent.message"
            ? `${String(p.agent_role)}: ${String(p.text)}`
            : JSON.stringify(p).slice(0, 80);
      const src =
        e.type === "run.state_changed"
          ? "run"
          : `${e.type.split(".")[0]} ${String(e.sourceId).slice(-8)}`;
      return `${String(e.seq).padStart(3)}  ${e.type.padEnd(18)} ${src.padEnd(16)} ${what}`;
    });
    const run = await runRow(id);
    console.log(`\n[TDM-54 evidence] run ${id} → ${run.state}\n${lines.join("\n")}\n`);
  }

  async function trialRows(id: string) {
    return h.db.select().from(trials).where(eq(trials.runId, id));
  }

  async function expectDeliveredOnce(id: string, rigged: Rig) {
    const run = await runRow(id);
    expect(run.state).toBe("delivered");
    expect((run.stageOutputs as { finalized_at?: string }).finalized_at).toBeTruthy();
    expect(run.advanceLeaseOwner).toBeNull();
    const ts = await trialRows(id);
    // 2 contenders × 1 workload × (1 warm-up + 2 repeats), each slot once, each run once.
    expect(ts).toHaveLength(TRIALS);
    expect(ts.every((t) => t.state === "done" && t.attempt === 1)).toBe(true);
    expect(new Set(ts.map((t) => `${t.contenderId}/${t.repeat}`)).size).toBe(TRIALS);
    expect(ts.map((t) => t.repeat).sort()).toEqual([-1, -1, 0, 0, 1, 1]);
    const created = await h.db
      .select({ n: sql<number>`count(*)::int` })
      .from(events)
      .where(
        and(
          eq(events.runId, id),
          eq(events.type, "trial.phase"),
          sql`${events.payload}->>'to' = 'queued' and ${events.payload}->>'from' is null`,
        ),
      );
    expect(created[0]!.n).toBe(TRIALS);
    const comps = await h.db
      .select({ id: computers.id })
      .from(computers)
      .where(sql`${computers.trialId} in (select id from trials where run_id = ${id})`);
    expect(comps).toHaveLength(TRIALS);
    const [report] = await h.db.select().from(reports).where(eq(reports.runId, id));
    expect(report).toMatchObject({ ownerId: userId });
    expect((report!.json as { run_id: string }).run_id).toBe(id);
    expect(rigged.charges.filter((c) => c.runId === id)).toEqual([
      { runId: id, state: "delivered", cancelCause: null },
    ]);
    // One Naïve session per agent stage; a rerun stage replays it instead of paying again.
    const fresh = rigged.naive.sessionCreates.filter(
      (s) => !s.replayed && (s.body.metadata as { run_id?: string } | undefined)?.run_id === id,
    );
    expect(fresh.map((s) => s.role).sort()).toEqual(
      ["analyst", "kit_designer", "researcher", "understander"].sort(),
    );
  }

  // ---------- tests ----------

  it("registers run.advance and run.sweep (every 60 s)", () => {
    expect(JOBS).toContain(runAdvanceJob);
    expect(JOBS).toContain(runSweepJob);
    expect(runSweepJob.everyMs).toBe(RUN_SWEEP_INTERVAL_MS);
  });

  it("drives a submitted run from intake to delivered, with an event at every stage", async () => {
    const r = rig();
    const { w, stages, pipeline } = r.worker();
    const id = await createRun(r.queue);
    await drainTdm54(w, r.queue);

    if (process.env.TDM54_EVIDENCE === "1") await printRunTdm54(id);
    expect(await stateEdges(id)).toEqual(HAPPY_PATH);
    await expectDeliveredOnce(id, r);
    expect(stages.calls.map((c) => c.role)).toEqual([
      "understander",
      "researcher",
      "kit_designer",
      "analyst",
    ]);
    expect(pipeline.calls.map((c) => c.step)).toEqual([
      "ingest",
      "buildEnv",
      "prove",
      "estimate",
      "score",
    ]);
    const run = await runRow(id);
    expect(run.estimateMicroUsd).toBe(1_000_000n);
    const [kit] = await h.db.select().from(kits).where(eq(kits.id, run.kitId!));
    expect(kit).toMatchObject({ version: 1, ownerId: userId });
    const cs = await h.db.select().from(contenders).where(eq(contenders.runId, id));
    expect(cs.filter((c) => c.foundBy === "researcher")).toHaveLength(1);
    expect(
      cs
        .filter((c) => c.foundBy === "kit")
        .map((c) => c.source)
        .sort(),
    ).toEqual(["gnu-grep", "ripgrep"]);
    // Agent progress shows on the live page too.
    const agentMsgs = await h.db
      .select({ n: sql<number>`count(*)::int` })
      .from(events)
      .where(and(eq(events.runId, id), eq(events.type, "agent.message")));
    expect(agentMsgs[0]!.n).toBe(4);
    // A later wake of a finalized run changes nothing.
    await runJobTdm54(w, r.queue, {
      task: "run.advance",
      payload: { run_id: id, reason: "sweep" },
      key: "x",
      runAt: null,
    });
    expect(await stateEdges(id)).toHaveLength(HAPPY_PATH.length);
  }, 60_000);

  // Kill the worker before each stage's work (and twice in `running`: before expansion, and
  // after the trials ran), then let a second worker pick the run up through the sweep.
  const crashPoints: [string, number][] = [
    ["intake", 1],
    ["understand", 1],
    ["research", 1],
    ["kit_draft", 1],
    ["env_build", 1],
    ["proof", 1],
    ["proof", 2],
    ["awaiting_go", 1],
    ["running", 1],
    ["running", 2],
    ["scoring", 1],
    ["analyzing", 1],
  ];
  for (const [stage, nth] of crashPoints) {
    it(`a worker killed at ${stage} (#${nth}) is recovered by the sweep: delivered, no duplicates`, async () => {
      const r = rig();
      let seen = 0;
      let killing: Promise<void> = Promise.resolve();
      const a = r.worker({
        orchestrator: {
          beforeStage: async (state, signal) => {
            if (state !== stage || ++seen !== nth) return;
            const killed = new Promise((_, reject) =>
              signal.addEventListener("abort", () => reject(new Error("killed")), { once: true }),
            );
            killing = killWorkerTdm54(h.db, a.w);
            await killed;
          },
        },
      });
      const id = await createRun(r.queue);
      await drainTdm54(a.w, r.queue, { until: async () => a.w.abort.signal.aborted });
      await killing;
      const dead = await runRow(id);
      expect(dead.state).toBe(stage);
      expect(dead.advanceLeaseOwner).toMatch(new RegExp(`^${a.w.id}~`));

      const b = r.worker();
      // The killed job is gone; the sweep re-drives the run once nothing is pending for it.
      for (const k of await r.queue.pendingKeysWithPrefix(`runs:${id}:`)) r.queue.pending.delete(k);
      expect(await sweepRuns({ db: h.db, jobs: r.queue })).toContain(id);
      await drainTdm54(b.w, r.queue);
      await expectDeliveredOnce(id, r);
    }, 60_000);
  }

  it("a worker killed inside an agent session: the next worker replays the same Naïve session", async () => {
    const r = rig();
    let killing: Promise<void> = Promise.resolve();
    const a = r.worker({
      stages: {
        hang: ["researcher"],
        onHang: () => {
          killing = killWorkerTdm54(h.db, a.w);
        },
      },
    });
    const id = await createRun(r.queue);
    await drainTdm54(a.w, r.queue, { until: async () => a.w.abort.signal.aborted });
    await killing;
    expect((await runRow(id)).state).toBe("research");

    const b = r.worker();
    expect(await sweepRuns({ db: h.db, jobs: r.queue })).toContain(id);
    await drainTdm54(b.w, r.queue);
    await expectDeliveredOnce(id, r);
    const researcher = r.naive.sessionCreates.filter(
      (s) =>
        s.role === "researcher" &&
        (s.body.metadata as { run_id?: string } | undefined)?.run_id === id,
    );
    expect(researcher.map((s) => s.replayed)).toEqual([false, true]);
    expect(new Set(researcher.map((s) => s.sessionId)).size).toBe(1);
  }, 60_000);

  it("the sweep skips runs with a pending job, a live holder, a hold, or finalized", async () => {
    const r = rig();
    const { w } = r.worker();
    // Default agents (CuratedKitStage): no kit design for this repo yet, so it holds.
    const unbuilt = createRunAdvanceJob({
      jobs: () => r.queue,
      pipeline: () => new FakePipeline({ digest: digestTdm54() }),
      timing: { leaseRefreshMs: 50 },
    });
    w.handlers.set(unbuilt.name, unbuilt as never);
    const id = await createRun(r.queue);
    // Pending (the API's `created` job): not swept.
    expect(await sweepRuns({ db: h.db, jobs: r.queue })).not.toContain(id);
    await drainTdm54(w, r.queue);
    const held = await runRow(id);
    expect(held.state).toBe("needs_human");
    expect(held.pausedReason).toBe(CURATED_KIT_UNAVAILABLE);
    expect((held.stageOutputs as { held_from?: string }).held_from).toBe("kit_draft");
    expect(await sweepRuns({ db: h.db, jobs: r.queue })).not.toContain(id);
  }, 60_000);

  it("a user cancel mid-stage stops the agent, cancels its Naïve session and bills as user", async () => {
    const r = rig();
    let hung!: () => void;
    const hanging = new Promise<void>((res) => (hung = res));
    const { w } = r.worker({
      stages: { hang: ["understander"], onHang: () => hung() },
    });
    const id = await createRun(r.queue);
    const draining = drainTdm54(w, r.queue);
    await hanging;
    const [live] = await h.db.select().from(agentSessions).where(eq(agentSessions.runId, id));
    expect(live).toMatchObject({ role: "understander", status: "running" });

    const before = api.jobs.jobs.length;
    const res = await post(`/runs/${id}/cancel`, { reason: "changed my mind" });
    expect(res.status).toBe(200);
    forwardApiJobs(r.queue, before);
    await draining;

    const run = await runRow(id);
    expect(run).toMatchObject({ state: "cancelled", cancelCause: "user" });
    expect(run.cancelRequestedAt).not.toBeNull();
    expect((run.stageOutputs as { finalized_at?: string }).finalized_at).toBeTruthy();
    expect(r.naive.sessionOf(live!.naiveSessionId!).status).toBe("cancelled");
    const [after] = await h.db.select().from(agentSessions).where(eq(agentSessions.id, live!.id));
    expect(after!.status).toBe("cancelled");
    expect(r.charges).toEqual([{ runId: id, state: "cancelled", cancelCause: "user" }]);
    expect((await stateEdges(id)).at(-1)).toEqual(["understand", "cancelled"]);
    expect(await trialRows(id)).toHaveLength(0);
  }, 60_000);

  it("a run kill switch during trials cancels the run as ours and stops every trial", async () => {
    const r = rig();
    const { w } = r.worker();
    const id = await createRun(r.queue);
    await drainTdm54(w, r.queue, {
      until: async () => (await runRow(id)).state === "running" && (await trialRows(id)).length > 0,
    });
    await h.db
      .insert(killSwitches)
      .values({ scope: "run", scopeId: id, reason: "abuse report", setBy: "admin" });
    await drainTdm54(w, r.queue);

    const run = await runRow(id);
    expect(run).toMatchObject({ state: "cancelled", cancelCause: "ours" });
    const ts = await trialRows(id);
    expect(ts).toHaveLength(TRIALS);
    expect(ts.every((t) => t.state === "cancelled")).toBe(true);
    const [last] = await h.db
      .select({ payload: events.payload })
      .from(events)
      .where(and(eq(events.runId, id), eq(events.type, "run.state_changed")))
      .orderBy(sql`${events.seq} desc`)
      .limit(1);
    expect(last!.payload).toMatchObject({
      from: "running",
      to: "cancelled",
      command: "cancel",
      reason: "kill switch run: abuse report",
    });
    expect(r.charges).toEqual([{ runId: id, state: "cancelled", cancelCause: "ours" }]);
  }, 60_000);

  it("CuratedKitStage: the Tandem repo gets the curated Tandem kit, with an event per stage", async () => {
    for (const g of [
      "jaximus808/tandem",
      "https://github.com/Jaximus808/Tandem.git",
      "github.com/JAXIMUS808/tandem",
    ]) {
      expect(isTandemRepo({ kind: "github", github: g })).toBe(true);
    }
    expect(isTandemRepo({ kind: "github", github: "jaximus808/tandem-x" })).toBe(false);
    expect(isTandemRepo({ kind: "github", github: "someone/tandem" })).toBe(false);

    // A valid kit stands in for kits/tandem-vs-claude-code (see the next test for the real one).
    const curatedDir = mkdtempSync(path.join(tmpdir(), "tdm54-kits-"));
    cpSync(KIT_EXAMPLE_DIR, path.join(curatedDir, CURATED_TANDEM_KIT), { recursive: true });
    const r = rig();
    const { w } = r.worker();
    // Stop after kit design: env build is the next stage's ticket ([3.8]).
    const pipeline = new FakePipeline({ digest: digestTdm54() });
    pipeline.buildEnv = async () => stageHold("env build stops this test");
    w.handlers.set(
      "run.advance",
      createRunAdvanceJob({
        jobs: () => r.queue,
        agents: () => curatedKitStages({ kitsDir: curatedDir }),
        pipeline: () => pipeline,
        timing: { leaseRefreshMs: 50 },
      }) as never,
    );
    const id = await createRun(r.queue, {
      question: "Does Tandem beat Claude Code?",
      source: { kind: "github", github: "https://github.com/Jaximus808/Tandem.git", ref: "main" },
    });
    await drainTdm54(w, r.queue);
    const run = await runRow(id);
    expect(run.state).toBe("needs_human");
    expect((run.stageOutputs as { held_from?: string }).held_from).toBe("env_build");
    const [kit] = await h.db.select().from(kits).where(eq(kits.id, run.kitId!));
    expect(kit!.version).toBe(1);
    expect((kit!.spec as { subject: { name: string } }).subject.name).toBe(
      (await loadKit(path.join(curatedDir, CURATED_TANDEM_KIT))).spec.subject.name,
    );
    const said = await h.db
      .select({ payload: events.payload })
      .from(events)
      .where(and(eq(events.runId, id), eq(events.type, "agent.message")))
      .orderBy(asc(events.seq));
    const texts = said.map((e) => (e.payload as { text: string }).text);
    expect(texts.slice(0, 3)).toEqual([
      "using the curated Tandem kit",
      "using the curated Tandem kit: its contenders are the baselines",
      `using the curated Tandem kit (${CURATED_TANDEM_KIT})`,
    ]);
    expect(texts[3]).toMatch(/^smoke profile: \d+ trials/);
    expect((await stateEdges(id)).map((e) => e[1])).toEqual([
      "intake",
      "understand",
      "research",
      "kit_draft",
      "env_build",
      "needs_human",
    ]);
  }, 60_000);

  it("CuratedKitStage on the repo's real kit: stored when valid, else held with the reasons", async () => {
    const r = rig();
    const { w } = r.worker();
    const pipeline = new FakePipeline({ digest: digestTdm54() });
    pipeline.buildEnv = async () => stageHold("env build stops this test");
    w.handlers.set(
      "run.advance",
      createRunAdvanceJob({
        jobs: () => r.queue,
        agents: () => curatedKitStages(),
        pipeline: () => pipeline,
        timing: { leaseRefreshMs: 50 },
      }) as never,
    );
    const id = await createRun(r.queue, {
      source: { kind: "github", github: "jaximus808/tandem", ref: "main" },
    });
    await drainTdm54(w, r.queue);
    const run = await runRow(id);
    const valid = await validateKitDir(path.join(defaultKitsDir(), CURATED_TANDEM_KIT));
    expect(run.state).toBe("needs_human");
    if (valid.ok) {
      expect((run.stageOutputs as { held_from?: string }).held_from).toBe("env_build");
    } else {
      expect((run.stageOutputs as { held_from?: string }).held_from).toBe("understand");
      expect(run.pausedReason).toMatch(/^the curated Tandem kit does not validate/);
    }
  }, 60_000);

  it("CuratedKitStage: the Tandem kit defaults to the 3-trial smoke profile; 'full benchmark' gets all of it", async () => {
    const full = await loadKit(path.join(defaultKitsDir(), CURATED_TANDEM_KIT));
    const smoke = smokeProfile(full.spec);
    expect(smoke.ok).toBe(true);
    if (!smoke.ok) return;
    expect(smoke.spec.workloads.map((w) => w.id)).toEqual(["todo-api"]);
    expect(smoke.spec).toMatchObject({ repeats: 1, schedule: { warmups: 0 } });
    expect(smoke.spec.vary.TANDEM_WORKERS).toEqual([3]);
    expect(trialCount(smoke.spec)).toBe(3);
    expect(smoke.spec.contenders.map((c) => c.id).sort()).toEqual(
      ["claude-code-solo", "claude-code-subagents", "tandem"].sort(),
    );
    expect(trialCount(full.spec)).toBeGreaterThan(3);
    expect(wantsFullBenchmark("Run the FULL Benchmark please")).toBe(true);
    expect(wantsFullBenchmark("Does Tandem beat Claude Code?")).toBe(false);

    for (const [question, expected] of [
      ["Does Tandem beat Claude Code?", "smoke profile: 3 trials"],
      [
        "full benchmark: does Tandem beat Claude Code?",
        `full profile: ${trialCount(full.spec)} trials`,
      ],
    ] as const) {
      const r = rig();
      const { w } = r.worker();
      const pipeline = new FakePipeline({ digest: digestTdm54() });
      pipeline.buildEnv = async () => stageHold("env build stops this test");
      w.handlers.set(
        "run.advance",
        createRunAdvanceJob({
          jobs: () => r.queue,
          agents: () => curatedKitStages(),
          pipeline: () => pipeline,
          timing: { leaseRefreshMs: 50 },
        }) as never,
      );
      const id = await createRun(r.queue, {
        question,
        source: { kind: "github", github: "jaximus808/tandem", ref: "main" },
      });
      await drainTdm54(w, r.queue);
      const run = await runRow(id);
      const [kit] = await h.db.select().from(kits).where(eq(kits.id, run.kitId!));
      const said = await h.db
        .select({ payload: events.payload })
        .from(events)
        .where(and(eq(events.runId, id), eq(events.type, "agent.message")))
        .orderBy(asc(events.seq));
      expect(
        said.map((e) => (e.payload as { text: string }).text).some((t) => t.startsWith(expected)),
      ).toBe(true);
      const stored = safeParseKitSpec(kit!.spec);
      expect(stored.success && trialCount(stored.data)).toBe(
        expected.startsWith("smoke") ? 3 : trialCount(full.spec),
      );
    }
  }, 60_000);

  it("CuratedKitStage: any other repo holds at kit design with the set-up-for-you message", async () => {
    const r = rig();
    const { w } = r.worker();
    w.handlers.set(
      "run.advance",
      createRunAdvanceJob({
        jobs: () => r.queue,
        agents: () => curatedKitStages(),
        pipeline: () => new FakePipeline({ digest: digestTdm54() }),
        timing: { leaseRefreshMs: 50 },
      }) as never,
    );
    const id = await createRun(r.queue);
    await drainTdm54(w, r.queue);
    const run = await runRow(id);
    expect(run).toMatchObject({ state: "needs_human", pausedReason: CURATED_KIT_UNAVAILABLE });
    expect((run.stageOutputs as { held_from?: string }).held_from).toBe("kit_draft");
  }, 60_000);

  it("the default billing hook (ledger.recordRunCharges) bills a delivered run once, our cancel nothing", async () => {
    const r = rig();
    const { w } = r.worker({ orchestrator: { charges: undefined } });
    const id = await createRun(r.queue);
    await drainTdm54(w, r.queue);
    expect((await runRow(id)).state).toBe("delivered");
    const billed = await h.db.select().from(usageEntries).where(eq(usageEntries.runId, id));
    expect(billed.filter((u) => u.type === "run_fee").map((u) => u.amountMicroUsd)).toEqual([
      2_000_000n,
    ]);
    // FakeProvider computers cost nothing, so compute bills 0 or is skipped; never a second fee.
    await h.db
      .update(runs)
      .set({ stageOutputs: sql`${runs.stageOutputs} - 'finalized_at'` })
      .where(eq(runs.id, id));
    await runJobTdm54(w, r.queue, {
      task: "run.advance",
      payload: { run_id: id, reason: "sweep" },
      key: "again",
      runAt: null,
    });
    const again = await h.db.select().from(usageEntries).where(eq(usageEntries.runId, id));
    expect(again).toHaveLength(billed.length);

    const paused = r.worker({ orchestrator: { charges: undefined }, env: { ANYBENCH_PAUSE: "1" } });
    const ours = await createRun(r.queue);
    await drainTdm54(paused.w, r.queue);
    expect(await runRow(ours)).toMatchObject({ state: "cancelled", cancelCause: "ours" });
    expect(await h.db.select().from(usageEntries).where(eq(usageEntries.runId, ours))).toEqual([]);
  }, 60_000);

  it("demo comp: auto-go with the default gate comps an admin's run, the ledger bills nothing; a non-admin waits", async () => {
    const [owner] = await h.db.select().from(users).where(eq(users.id, userId));
    const login = owner!.githubLogin;
    const r = rig();
    // The real default gate (BILLING_MODE=test) and the real ledger hook.
    const admin = r.worker({
      orchestrator: { charges: undefined, billingGate: undefined },
      env: { BILLING_MODE: "test", ADMIN_GITHUB_LOGINS: login },
    });
    const id = await createRun(r.queue);
    await drainTdm54(admin.w, r.queue);
    const run = await runRow(id);
    expect(run).toMatchObject({
      state: "delivered",
      compedBy: login,
      compedReason: ADMIN_AUTO_COMP_REASON,
    });
    expect(await stateEdges(id)).toContainEqual(["awaiting_go", "running"]);
    const ivs = await h.db.select().from(interventions).where(eq(interventions.runId, id));
    expect(ivs).toHaveLength(1);
    expect(ivs[0]).toMatchObject({
      id: run.compInterventionId,
      userId,
      who: login,
      what: "comp",
      why: ADMIN_AUTO_COMP_REASON,
    });
    // The ledger records the run fee as comped: never counted, never sent to Stripe.
    const billed = await h.db.select().from(usageEntries).where(eq(usageEntries.runId, id));
    expect(billed.filter((u) => u.type === "run_fee")).toHaveLength(1);
    for (const u of billed) {
      expect(u).toMatchObject({ compedBy: login, interventionId: ivs[0]!.id, reportedAt: null });
    }
    const unreported = await createLedger(h.db).listUnreported({ userId, limit: 1000 });
    expect(unreported.filter((u) => u.runId === id)).toEqual([]);

    // Same env, owner not an admin: the gate refuses and the run waits in awaiting_go.
    const plain = r.worker({
      orchestrator: { charges: undefined, billingGate: undefined },
      env: { BILLING_MODE: "test", ADMIN_GITHUB_LOGINS: "someone-else" },
    });
    const waits = await createRun(r.queue);
    await drainTdm54(plain.w, r.queue);
    expect(await runRow(waits)).toMatchObject({ state: "awaiting_go", compedBy: null });
    expect(await h.db.select().from(interventions).where(eq(interventions.runId, waits))).toEqual(
      [],
    );
    expect(await h.db.select().from(usageEntries).where(eq(usageEntries.runId, waits))).toEqual([]);
  }, 60_000);

  it("ANYBENCH_PAUSE=1 cancels a run as ours before any agent runs", async () => {
    const r = rig();
    const { w, stages, pipeline } = r.worker({ env: { ANYBENCH_PAUSE: "1" } });
    const id = await createRun(r.queue);
    await drainTdm54(w, r.queue);
    expect(await runRow(id)).toMatchObject({ state: "cancelled", cancelCause: "ours" });
    expect(stages.calls).toHaveLength(0);
    expect(pipeline.calls).toHaveLength(0);
    expect(r.charges).toEqual([{ runId: id, state: "cancelled", cancelCause: "ours" }]);
  }, 60_000);

  it("a failing proof goes back to the kit designer, then delivers on the repaired kit", async () => {
    const r = rig();
    const { w, stages } = r.worker();
    const pipeline = new FakePipeline({
      digest: digestTdm54(),
      proof: (n) => (n === 1 ? failingProof() : passingProof()),
    });
    w.handlers.set(
      "run.advance",
      createRunAdvanceJob({
        jobs: () => r.queue,
        agents: () => stages,
        pipeline: () => pipeline,
        billingGate: () => async () => ({ allowed: true }),
        timing: { leaseRefreshMs: 50 },
      }) as never,
    );
    const id = await createRun(r.queue);
    await drainTdm54(w, r.queue);
    const edges = await stateEdges(id);
    expect(edges).toContainEqual(["proof", "kit_draft"]);
    expect(edges.at(-1)).toEqual(["analyzing", "delivered"]);
    const versions = await h.db.select({ v: kits.version }).from(kits).where(eq(kits.runId, id));
    expect(versions.map((v) => v.v).sort()).toEqual([1, 2]);
    expect(stages.visitsOf("kit_designer" satisfies FakeRole)).toBe(2);
  }, 60_000);

  it("auto_go off waits in awaiting_go; Go through the API resumes it", async () => {
    const r = rig();
    const { w } = r.worker();
    const id = await createRun(r.queue, { auto_go: false });
    await drainTdm54(w, r.queue);
    expect((await runRow(id)).state).toBe("awaiting_go");
    const before = api.jobs.jobs.length;
    // The API's default billing gate (BILLING_MODE=test stub) refuses; open it for this call.
    const go = await runsAppGo(id);
    expect(go).toBe(200);
    forwardApiJobs(r.queue, before);
    await drainTdm54(w, r.queue);
    await expectDeliveredOnce(id, r);
  }, 60_000);

  async function runsAppGo(id: string): Promise<number> {
    const open = runsAppTdm67(h.url, { billingGate: async () => ({ allowed: true }) });
    try {
      const before = open.jobs.jobs.length;
      const res = await open.app.request(`${BASE}/runs/${id}/go`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${userId}` },
        body: "{}",
      });
      for (const j of open.jobs.jobs.slice(before)) api.jobs.jobs.push(j);
      return res.status;
    } finally {
      await open.dbh.close();
    }
  }

  it("an unexpected error on the job's last attempt fails the run instead of retrying", async () => {
    const r = rig();
    const { w } = r.worker();
    const pipeline = new FakePipeline({ digest: digestTdm54() });
    pipeline.ingest = async () => {
      throw new Error("git exploded");
    };
    const job = createRunAdvanceJob({
      jobs: () => r.queue,
      pipeline: () => pipeline,
      charges: () => ({ recordRunCharges: async () => undefined }),
      timing: { leaseRefreshMs: 50 },
    });
    const id = await createRun(r.queue);
    const first = r.queue.take()!;
    const helpers = (attempts: number) =>
      ({
        abortSignal: new AbortController().signal,
        job: { attempts, max_attempts: 3 },
        addJob: async (task: string, payload: unknown, spec: { jobKey?: string }) => {
          await r.queue.add(task, payload as Record<string, unknown>, spec);
        },
      }) as never;
    await expect(job.run(first.payload as never, w.ctx, helpers(1))).rejects.toThrow(
      "git exploded",
    );
    expect((await runRow(id)).advanceLeaseOwner).toBeNull(); // released for the retry
    await job.run(first.payload as never, w.ctx, helpers(3));
    const run = await runRow(id);
    expect(run.state).toBe("failed");
    expect((run.stageOutputs as { failure?: { stage: string } }).failure?.stage).toBe("intake");
  }, 60_000);
});
