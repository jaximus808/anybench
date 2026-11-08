// TDM-55 [6.1]: runAgentStage on local Postgres with FakeNaive: a session's events land in
// agent_sessions + agent_events, a rerun with the same key replays (no second Naïve session, no
// second cost entry), a crash mid-stream resumes from last_seq, and every failure mode maps to a
// hold (or a throw for transient errors). No network, no spend.
import { fileURLToPath } from "node:url";
import { roleAgentSpec } from "@anybench/agents";
import { AnybenchEventSchema } from "@anybench/core";
import { FakeNaive, fakeNaiveError } from "@anybench/naive/fake";
import { NaiveCancelledError } from "@anybench/naive";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { agentEvents, agentSessions, costEntries, runs, users } from "../src/db/schema/index.js";
import {
  AGENT_MESSAGE_MAX_CHARS,
  agentSessionIdFor,
  ensureAgentCached,
  runAgentStage,
} from "../src/jobs/agent-session.js";
import type { RunIntake, StageContext, StageEventDraft } from "../src/orchestrator/ports.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";

const available = await pgAvailableTdm11();

const ROLES_TDM55 = fileURLToPath(
  new URL("../../../packages/agents/test/fixtures-tdm55/roles/", import.meta.url),
);
const ECHO_SPEC_TDM55 = roleAgentSpec("echo", { rolesDir: ROLES_TDM55 });
const EchoSchemaTdm55 = z.object({ echo: z.string(), length: z.int().nonnegative() });

describe.skipIf(!available)("runAgentStage (TDM-55)", () => {
  let fresh: FreshDbTdm11;
  let userId: string;

  beforeAll(async () => {
    fresh = await freshMigratedDbTdm11({ max: 4 });
    const [u] = await fresh.db
      .insert(users)
      .values({ githubLogin: "tdm55-user", githubId: 5_500_001 })
      .returning();
    userId = u!.id;
  }, 60_000);

  afterAll(async () => {
    await fresh?.drop();
  });

  async function runTdm55(): Promise<string> {
    const [r] = await fresh.db
      .insert(runs)
      .values({ ownerId: userId, question: "is it faster?", budgetMicroUsd: 10_000_000n })
      .returning();
    return r!.id;
  }

  function ctxTdm55(
    runId: string,
    opts: {
      key?: string;
      signal?: AbortSignal;
      emit?: (d: StageEventDraft[]) => Promise<void>;
    } = {},
  ): StageContext & { emitted: StageEventDraft[] } {
    const emitted: StageEventDraft[] = [];
    return {
      emitted,
      run: {
        id: runId,
        owner_id: userId,
        project_id: null,
        question: "is it faster?",
        intake: {} as RunIntake,
        budget_micro_usd: 10_000_000n,
        spent_micro_usd: 0n,
      },
      idempotencyKey: opts.key ?? `${runId}:understand:0`,
      signal: opts.signal ?? new AbortController().signal,
      emit:
        opts.emit ??
        (async (d) => {
          emitted.push(...d);
        }),
    };
  }

  async function rowOf(id: string) {
    const [row] = await fresh.db.select().from(agentSessions).where(eq(agentSessions.id, id));
    return row!;
  }
  async function rowOrNullTdm55(id: string) {
    const [row] = await fresh.db.select().from(agentSessions).where(eq(agentSessions.id, id));
    return row ?? null;
  }
  async function eventsOf(id: string) {
    return fresh.db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.agentSessionId, id))
      .orderBy(asc(agentEvents.naiveSeq));
  }
  async function costsOf(runId: string) {
    return fresh.db.select().from(costEntries).where(eq(costEntries.runId, runId));
  }
  /**
   * A FakeNaive whose ids do not collide with earlier tests' (naive_session_id is unique across the
   * database, and every FakeNaive counts ids from 1): burn ids with throwaway agents first.
   */
  let burned = 0;
  async function fakeTdm55(): Promise<FakeNaive> {
    const naive = new FakeNaive();
    for (let i = 0; i < burned; i++) {
      await naive.agents.create({
        name: `tdm55-burn-${i}`,
        model: "fake",
        system: "burn",
        budget: { capMicroUsd: 1n, maxTaskMicroUsd: 1n, period: "day" },
      });
    }
    burned += 20;
    naive.calls.length = 0;
    return naive;
  }
  const creates = (naive: FakeNaive) => naive.calls.filter((c) => c.method === "sessions.create");

  it("derives a stable v8 uuid per (idempotency key, role)", () => {
    const a = agentSessionIdFor("run:understand:0", "understander");
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(agentSessionIdFor("run:understand:0", "understander")).toBe(a);
    expect(agentSessionIdFor("run:understand:1", "understander")).not.toBe(a);
    expect(agentSessionIdFor("run:understand:0", "researcher")).not.toBe(a);
  });

  it("persists the session, its events, cost and messages; a replay with the same key creates nothing", async () => {
    const runId = await runTdm55();
    const naive = await fakeTdm55();
    const longText = `thinking ${"x".repeat(AGENT_MESSAGE_MAX_CHARS)} sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789`;
    naive.script("echo", {
      output: { echo: "hello", length: 5 },
      costMicroUsd: 2_345n,
      events: [
        { type: "tool.started", data: { name: "think" } },
        { type: "message.completed", data: { content: longText } },
      ],
    });
    const ctx = ctxTdm55(runId);
    const r = await runAgentStage(
      { db: fresh.db, client: naive },
      {
        ctx,
        role: "echo",
        input: { word: "hello" },
        schema: EchoSchemaTdm55,
        budgetMicroUsd: 100_000n,
        agent: ECHO_SPEC_TDM55,
      },
    );
    expect(r).toMatchObject({
      ok: true,
      value: { output: { echo: "hello", length: 5 }, costMicroUsd: 2_345n, replayed: false },
    });
    if (!r.ok) throw new Error("unreachable");
    const id = agentSessionIdFor(ctx.idempotencyKey, "echo");
    expect(r.value.sessionId).toBe(id);

    const row = await rowOf(id);
    const naiveEvents = naive.eventsOf(r.value.naiveSessionId);
    expect(row).toMatchObject({
      runId,
      role: "echo",
      naiveSessionId: r.value.naiveSessionId,
      budgetMicroUsd: 100_000n,
      costMicroUsd: 2_345n,
      status: "done",
      stopReason: "end_turn",
      lastSeq: naiveEvents.length,
    });
    const stored = await eventsOf(id);
    expect(stored.map((e) => e.naiveSeq)).toEqual(naiveEvents.map((e) => e.seq));
    expect(stored.map((e) => e.type)).toEqual(naiveEvents.map((e) => e.type));
    // Persisted payloads are redacted.
    expect(JSON.stringify(stored.map((e) => e.payload))).not.toContain("sk-ant-api03");

    // The session is told the idempotency key = agent_sessions.id, and stamped with the run.
    expect(naive.sessionCreates).toHaveLength(1);
    expect(naive.sessionCreates[0]).toMatchObject({ idempotencyKey: id, replayed: false });
    expect(naive.sessionCreates[0]!.body.metadata).toMatchObject({
      run_id: runId,
      agent_session_id: id,
    });
    expect(naive.sessionCreates[0]!.body.budgetMicroUsd).toBe(100_000n);

    // Two agent messages (interim + final), never our own task message; long text truncated, redacted.
    expect(ctx.emitted).toHaveLength(2);
    for (const d of ctx.emitted) {
      expect(AnybenchEventSchema.safeParse({ ...d, run_id: runId, seq: 1 }).success).toBe(true);
      expect(d).toMatchObject({ type: "agent.message", source_id: id, cost_delta_micro_usd: 0n });
    }
    const first = ctx.emitted[0]!.payload as { text: string; truncated: boolean };
    expect(first.truncated).toBe(true);
    expect(first.text.length).toBeLessThanOrEqual(AGENT_MESSAGE_MAX_CHARS);
    expect(ctx.emitted[1]!.payload).toMatchObject({
      message_role: "assistant",
      text: JSON.stringify({ echo: "hello", length: 5 }),
    });

    // COGS booked once, by Naïve session.
    expect(await costsOf(runId)).toMatchObject([
      { source: "naive", amountMicroUsd: 2_345n, ref: r.value.naiveSessionId },
    ]);

    // Replay: same key → same row, read back, no new Naïve session, no new events, no new cost.
    const again = ctxTdm55(runId, { key: ctx.idempotencyKey });
    const r2 = await runAgentStage(
      { db: fresh.db, client: naive },
      {
        ctx: again,
        role: "echo",
        input: { word: "hello" },
        schema: EchoSchemaTdm55,
        budgetMicroUsd: 100_000n,
        agent: ECHO_SPEC_TDM55,
      },
    );
    expect(r2).toMatchObject({
      ok: true,
      value: {
        output: { echo: "hello", length: 5 },
        sessionId: id,
        naiveSessionId: r.value.naiveSessionId,
        costMicroUsd: 2_345n,
        replayed: true,
      },
    });
    expect(creates(naive)).toHaveLength(1);
    expect(naive.allSessions()).toHaveLength(1);
    expect(await eventsOf(id)).toHaveLength(stored.length);
    expect(await costsOf(runId)).toHaveLength(1);
    expect(again.emitted).toEqual([]);
    expect(naive.spentMicroUsd()).toBe(2_345n);
  });

  it("resumes from last_seq after a crash mid-stream (no second session, no duplicate events)", async () => {
    const runId = await runTdm55();
    const naive = await fakeTdm55();
    naive.script("echo", {
      output: { echo: "crash", length: 5 },
      costMicroUsd: 1_500n,
      events: [
        { type: "tool.started", data: { name: "think" } },
        { type: "message.completed", data: { content: "halfway there" } },
        { type: "tool.completed", data: { name: "think" } },
      ],
    });
    const key = `${runId}:understand:0`;
    const id = agentSessionIdFor(key, "echo");
    // The worker dies while publishing the first agent message (after the event row, before last_seq).
    const crashing = ctxTdm55(runId, {
      key,
      emit: async () => {
        throw new Error("worker killed (simulated)");
      },
    });
    await expect(
      runAgentStage(
        { db: fresh.db, client: naive },
        {
          ctx: crashing,
          role: "echo",
          input: { word: "crash" },
          schema: EchoSchemaTdm55,
          budgetMicroUsd: 100_000n,
          agent: ECHO_SPEC_TDM55,
        },
      ),
    ).rejects.toThrow("worker killed (simulated)");
    const crashed = await rowOf(id);
    expect(crashed.naiveSessionId).toMatch(/^ses_/);
    expect(crashed.status).toBe("running");
    expect(crashed.lastSeq).toBe(3); // session.running, the task message, tool.started
    expect((await eventsOf(id)).map((e) => e.naiveSeq)).toEqual([1, 2, 3, 4]);

    // The restarted worker runs the stage again: it resumes after last_seq.
    const restarted = ctxTdm55(runId, { key });
    const r = await runAgentStage(
      { db: fresh.db, client: naive },
      {
        ctx: restarted,
        role: "echo",
        input: { word: "crash" },
        schema: EchoSchemaTdm55,
        budgetMicroUsd: 100_000n,
        agent: ECHO_SPEC_TDM55,
      },
    );
    expect(r).toMatchObject({
      ok: true,
      value: { output: { echo: "crash", length: 5 }, costMicroUsd: 1_500n, replayed: false },
    });
    expect(creates(naive)).toHaveLength(1);
    const naiveEvents = naive.eventsOf(crashed.naiveSessionId!);
    expect((await eventsOf(id)).map((e) => e.naiveSeq)).toEqual(naiveEvents.map((e) => e.seq));
    expect(await rowOf(id)).toMatchObject({
      status: "done",
      lastSeq: naiveEvents.length,
      costMicroUsd: 1_500n,
    });
    // The message the crash interrupted is published now (at-least-once), then the final answer.
    expect(restarted.emitted.map((d) => (d.payload as { text: string }).text)).toEqual([
      "halfway there",
      JSON.stringify({ echo: "crash", length: 5 }),
    ]);
    const resumeStream = naive.calls.filter((c) => c.method === "sessions.stream");
    expect(resumeStream.length).toBeGreaterThanOrEqual(2);
    expect(await costsOf(runId)).toHaveLength(1);
  });

  it("holds on invalid output and on a budget overrun, with the spend booked", async () => {
    const runId = await runTdm55();
    const naive = await fakeTdm55();
    naive.script("echo", { output: { echo: 42 }, costMicroUsd: 700n });
    const bad = ctxTdm55(runId, { key: `${runId}:understand:0` });
    const r = await runAgentStage(
      { db: fresh.db, client: naive },
      {
        ctx: bad,
        role: "echo",
        input: "x",
        schema: EchoSchemaTdm55,
        budgetMicroUsd: 100_000n,
        agent: ECHO_SPEC_TDM55,
      },
    );
    expect(r).toMatchObject({ ok: false, outcome: "needs_human" });
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toMatch(/echo agent's output failed its schema: echo: .*length: /);
    expect(await rowOf(agentSessionIdFor(bad.idempotencyKey, "echo"))).toMatchObject({
      status: "failed",
      stopReason: "output_invalid",
      costMicroUsd: 700n,
    });

    naive.script("echo", { output: { echo: "a", length: 1 }, costMicroUsd: 90_000n });
    const over = ctxTdm55(runId, { key: `${runId}:understand:1` });
    const r2 = await runAgentStage(
      { db: fresh.db, client: naive },
      {
        ctx: over,
        role: "echo",
        input: "x",
        schema: EchoSchemaTdm55,
        budgetMicroUsd: 50_000n,
        agent: ECHO_SPEC_TDM55,
      },
    );
    expect(r2).toMatchObject({ ok: false, outcome: "needs_human" });
    if (r2.ok) throw new Error("unreachable");
    expect(r2.reason).toMatch(/hit its budget \(50000 of 50000 micro-USD/);
    expect(await rowOf(agentSessionIdFor(over.idempotencyKey, "echo"))).toMatchObject({
      status: "failed",
      stopReason: "budget_exceeded",
      costMicroUsd: 50_000n,
    });
    const costs = await costsOf(runId);
    expect(costs.map((c) => c.amountMicroUsd).sort()).toEqual([50_000n, 700n]);
  });

  it("holds while a session waits on a human, with the pending action stored", async () => {
    const runId = await runTdm55();
    const naive = await fakeTdm55();
    naive.script("echo", {
      stopReason: "awaiting_approval",
      pendingActions: [{ kind: "tool", toolCallId: "call_1", name: "bash", args: { cmd: "ls" } }],
    });
    const ctx = ctxTdm55(runId);
    const r = await runAgentStage(
      { db: fresh.db, client: naive },
      {
        ctx,
        role: "echo",
        input: "x",
        schema: EchoSchemaTdm55,
        budgetMicroUsd: 100_000n,
        agent: ECHO_SPEC_TDM55,
      },
    );
    expect(r).toMatchObject({ ok: false, outcome: "needs_human" });
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toMatch(/waiting for approval of tool bash/);
    expect(await rowOf(agentSessionIdFor(ctx.idempotencyKey, "echo"))).toMatchObject({
      status: "waiting",
      stopReason: "awaiting_approval",
      pendingAction: {
        kind: "confirm_tool",
        tool_use_id: "call_1",
        tool: "bash",
        input_preview: '{"cmd":"ls"}',
      },
    });
  });

  it("throws on a transient Naïve error (row left to resume), holds on a refusal", async () => {
    const runId = await runTdm55();
    const naive = await fakeTdm55();
    naive.failNext("sessions.create", fakeNaiveError("provider_error", 503));
    naive.script("echo", { output: { echo: "ok", length: 2 } });
    const ctx = ctxTdm55(runId);
    const args = {
      role: "echo",
      input: "x",
      schema: EchoSchemaTdm55,
      budgetMicroUsd: 100_000n,
      agent: ECHO_SPEC_TDM55,
    };
    await expect(
      runAgentStage({ db: fresh.db, client: naive }, { ctx, ...args }),
    ).rejects.toMatchObject({ status: 503 });
    const id = agentSessionIdFor(ctx.idempotencyKey, "echo");
    expect(await rowOf(id)).toMatchObject({ status: "pending", naiveSessionId: null });
    // The job's retry succeeds on the same row.
    expect(
      await runAgentStage(
        { db: fresh.db, client: naive },
        { ctx: ctxTdm55(runId, { key: ctx.idempotencyKey }), ...args },
      ),
    ).toMatchObject({ ok: true });
    expect(await rowOf(id)).toMatchObject({ status: "done" });

    naive.failNext("sessions.create", fakeNaiveError("insufficient_credits", 402));
    const broke = await runAgentStage(
      { db: fresh.db, client: naive },
      { ctx: ctxTdm55(runId, { key: `${runId}:research:0` }), ...args },
    );
    expect(broke).toMatchObject({ ok: false, outcome: "needs_human" });
    if (broke.ok) throw new Error("unreachable");
    expect(broke.reason).toMatch(/Naïve refused the echo session: insufficient_credits/);
  });

  it("cancels on abort, and a later visit with a live signal starts a fresh session", async () => {
    const runId = await runTdm55();
    const naive = await fakeTdm55();
    naive.script("echo", { output: { echo: "slow", length: 4 }, hang: true, costMicroUsd: 400n });
    naive.script("echo", { output: { echo: "slow", length: 4 }, costMicroUsd: 600n });
    const ac = new AbortController();
    const key = `${runId}:understand:0`;
    const id = agentSessionIdFor(key, "echo");
    const args = {
      role: "echo",
      input: "x",
      schema: EchoSchemaTdm55,
      budgetMicroUsd: 100_000n,
      agent: ECHO_SPEC_TDM55,
    };
    const pending = runAgentStage(
      { db: fresh.db, client: naive },
      { ctx: ctxTdm55(runId, { key, signal: ac.signal }), ...args },
    );
    // Wait until the session exists and streaming started, then cancel.
    for (let i = 0; i < 100 && !(await rowOrNullTdm55(id))?.naiveSessionId; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    ac.abort();
    await expect(pending).rejects.toBeInstanceOf(NaiveCancelledError);
    const cancelled = await rowOf(id);
    expect(cancelled).toMatchObject({ status: "cancelled", costMicroUsd: 400n });
    expect(naive.sessionOf(cancelled.naiveSessionId!).status).toBe("cancelled");

    const r = await runAgentStage(
      { db: fresh.db, client: naive },
      { ctx: ctxTdm55(runId, { key }), ...args },
    );
    expect(r).toMatchObject({ ok: true, value: { sessionId: id, costMicroUsd: 1_000n } });
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.naiveSessionId).not.toBe(cancelled.naiveSessionId);
    expect(naive.sessionCreates.filter((c) => !c.replayed).map((c) => c.idempotencyKey)).toEqual([
      id,
      `${id}:after:${cancelled.naiveSessionId}`,
    ]);
    expect((await costsOf(runId)).map((c) => c.amountMicroUsd).sort()).toEqual([400n, 600n]);
  });

  it("holds when the role has no folder, and caches ensureAgent per spec", async () => {
    const runId = await runTdm55();
    const naive = await fakeTdm55();
    const r = await runAgentStage(
      { db: fresh.db, client: naive },
      {
        ctx: ctxTdm55(runId),
        role: "no-such-role",
        input: "x",
        schema: EchoSchemaTdm55,
        budgetMicroUsd: 1_000n,
      },
    );
    expect(r).toMatchObject({ ok: false, outcome: "needs_human" });
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toMatch(/agent role "no-such-role"/);
    expect(naive.calls).toEqual([]);

    const a = await ensureAgentCached(naive, ECHO_SPEC_TDM55);
    const b = await ensureAgentCached(naive, ECHO_SPEC_TDM55);
    expect(b).toBe(a);
    expect(naive.calls.filter((c) => c.method === "agents.list")).toHaveLength(1);
    const changed = await ensureAgentCached(naive, {
      ...ECHO_SPEC_TDM55,
      system: `${ECHO_SPEC_TDM55.system}\nBe brief.`,
    });
    expect(changed).toMatchObject({ action: "updated", agent: { version: 2 } });
  });
});
