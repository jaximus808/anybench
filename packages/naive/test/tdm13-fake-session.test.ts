// FakeNaive + runSession + ensureAgent, all offline. These double as the usage examples for E6.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  agentFingerprint,
  assertSubscriptionActive,
  creditCheck,
  ensureAgent,
  FakeNaive,
  fakeNaiveError,
  NaiveBudgetExceededError,
  NaiveCancelledError,
  NaiveInsufficientCreditsError,
  NaiveOutputInvalidError,
  NaiveSessionFailedError,
  NaiveSubscriptionRequiredError,
  runSession,
  spentMicroUsd,
  toWireMicroUsd,
  fromWireMicroUsd,
  type AgentSpec,
  type NaiveEvent,
} from "../src/index.js";
import { FakeNaive as FakeNaiveFromSubpath } from "../src/fake.js";

const tdm13Spec: AgentSpec = {
  role: "understander",
  model: "anthropic/claude-sonnet",
  system: "Understand the project.",
  budget: { capMicroUsd: 20_000_000n, maxTaskMicroUsd: 2_000_000n },
  outputSchema: { type: "object" },
};

const Understanding = z.object({
  kind: z.enum(["agent", "harness", "software"]),
  summary: z.string(),
  benchable: z.enum(["ready", "needs_hardware", "skip"]),
});

async function tdm13Setup() {
  const naive = new FakeNaive();
  const { agent } = await ensureAgent(naive, tdm13Spec);
  return { naive, agent };
}

describe("money boundary", () => {
  it("converts bigint <-> wire integers and refuses floats and negatives", () => {
    expect(toWireMicroUsd(1_500_000n)).toBe(1_500_000);
    expect(fromWireMicroUsd(42)).toBe(42n);
    expect(() => fromWireMicroUsd(1.5)).toThrow(RangeError);
    expect(() => toWireMicroUsd(-1n)).toThrow(RangeError);
    expect(() => toWireMicroUsd(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(RangeError);
  });
});

describe("ensureAgent", () => {
  it("creates, then is a no-op for the same spec, then mints a version when the prompt changes", async () => {
    const naive = new FakeNaive();
    const first = await ensureAgent(naive, tdm13Spec);
    expect(first.action).toBe("created");
    expect(first.agent.name).toBe("anybench-understander");
    expect(first.agent.metadata).toMatchObject({
      anybench_role: "understander",
      anybench_fingerprint: first.fingerprint,
    });

    const again = await ensureAgent(naive, { ...tdm13Spec });
    expect(again.action).toBe("unchanged");
    expect(again.agent.version).toBe(1);

    const changed = await ensureAgent(naive, { ...tdm13Spec, system: "Understand it better." });
    expect(changed.action).toBe("updated");
    expect(changed.agent.version).toBe(2);
    expect(naive.agentVersions(first.agent.id)).toHaveLength(2);
    expect(naive.allAgents()).toHaveLength(1);
  });

  it("fingerprint ignores key order and changes with content", () => {
    const a = agentFingerprint(tdm13Spec);
    const reordered = agentFingerprint({
      budget: { maxTaskMicroUsd: 2_000_000n, capMicroUsd: 20_000_000n },
      outputSchema: { type: "object" },
      system: "Understand the project.",
      model: "anthropic/claude-sonnet",
      role: "understander",
    });
    expect(reordered).toBe(a);
    expect(agentFingerprint({ ...tdm13Spec, model: "other/model" })).not.toBe(a);
  });

  it("rejects an invalid spec at the boundary", async () => {
    const naive = new FakeNaive();
    await expect(ensureAgent(naive, { ...tdm13Spec, role: "Not A Role" })).rejects.toThrow();
  });
});

describe("runSession on FakeNaive", () => {
  it("returns canned output for the role, records spend and the create", async () => {
    const { naive, agent } = await tdm13Setup();
    naive.script("understander", {
      output: { kind: "software", summary: "A CLI.", benchable: "ready" },
      costMicroUsd: 3_000n,
      events: [{ type: "tool.started", data: { name: "web_search" } }, { type: "tool.completed" }],
    });
    const events: NaiveEvent[] = [];
    const result = await runSession(naive, {
      agentId: agent.id,
      role: "understander",
      input: { digest: "repo" },
      output: { schema: Understanding },
      budgetMicroUsd: 2_000_000n,
      idempotencyKey: "as_1",
      onEvent: (e) => void events.push(e),
    });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.kind).toBe("software");
    expect(result.costMicroUsd).toBe(3_000n);
    expect(naive.spentMicroUsd()).toBe(3_000n);
    expect(await spentMicroUsd(naive, { sessionId: result.sessionId })).toBe(3_000n);
    expect((await naive.credits.show()).balanceMicroUsd).toBe(250_000_000n - 3_000n);

    expect(events.map((e) => e.type)).toEqual([
      "session.running",
      "message.completed",
      "tool.started",
      "tool.completed",
      "message.delta",
      "message.completed",
      "session.usage",
      "session.idle",
    ]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(result.lastSeq).toBe(8);

    const [create] = naive.sessionCreates;
    expect(create).toMatchObject({ role: "understander", idempotencyKey: "as_1", replayed: false });
    expect(create?.body.budgetMicroUsd).toBe(2_000_000n);
    expect(create?.body.outputSchema).toMatchObject({ type: "object" });
    expect(JSON.parse(create?.body.message ?? "")).toEqual({ digest: "repo" });
  });

  it("scripts are FIFO per role, then the default; a function script sees the input", async () => {
    const { naive, agent } = await tdm13Setup();
    naive
      .script("understander", { output: { kind: "agent", summary: "1", benchable: "ready" } })
      .scriptDefault("understander", (ctx) => ({
        output: {
          kind: "harness",
          summary: String((ctx.input as { n: number }).n),
          benchable: "skip",
        },
      }));
    const run = (n: number) =>
      runSession(naive, {
        agentId: agent.id,
        role: "understander",
        input: { n },
        output: { schema: Understanding },
        budgetMicroUsd: 1_000_000n,
        idempotencyKey: `as_${n}`,
      });
    const a = await run(1);
    const b = await run(2);
    const c = await run(3);
    expect([a, b, c].map((r) => (r.status === "completed" ? r.output.summary : null))).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  it("throws when a role has no script, so a test never passes on output it did not choose", async () => {
    const { naive, agent } = await tdm13Setup();
    await expect(
      runSession(naive, {
        agentId: agent.id,
        role: "understander",
        input: "x",
        budgetMicroUsd: 1n,
        idempotencyKey: "k",
      }),
    ).rejects.toThrow(/no script for role "understander"/);
  });

  it("the same idempotency key replays the first session and does not spend twice", async () => {
    const { naive, agent } = await tdm13Setup();
    naive.scriptDefault("understander", {
      output: { kind: "agent", summary: "s", benchable: "ready" },
      costMicroUsd: 10n,
    });
    const opts = {
      agentId: agent.id,
      role: "understander",
      input: "x",
      output: { schema: Understanding },
      budgetMicroUsd: 1_000n,
      idempotencyKey: "as_same",
    };
    const first = await runSession(naive, opts);
    const second = await runSession(naive, opts);
    expect(second.sessionId).toBe(first.sessionId);
    expect(naive.allSessions()).toHaveLength(1);
    expect(naive.spentMicroUsd()).toBe(10n);
    expect(naive.sessionCreates.map((c) => c.replayed)).toEqual([false, true]);
  });

  it("gates output: missing or schema-invalid structured output is NaiveOutputInvalidError", async () => {
    const { naive, agent } = await tdm13Setup();
    naive.script("understander", { output: { kind: "spaceship" } }, { text: "no document" });
    const base = {
      agentId: agent.id,
      role: "understander",
      input: "x",
      output: { schema: Understanding },
      budgetMicroUsd: 1_000n,
    };
    const invalid = await runSession(naive, { ...base, idempotencyKey: "a" }).catch(
      (e: unknown) => e,
    );
    expect(invalid).toBeInstanceOf(NaiveOutputInvalidError);
    expect((invalid as NaiveOutputInvalidError).code).toBe("output_invalid");
    expect((invalid as NaiveOutputInvalidError).issues.length).toBeGreaterThan(0);
    const missing = await runSession(naive, { ...base, idempotencyKey: "b" }).catch(
      (e: unknown) => e,
    );
    expect(missing).toBeInstanceOf(NaiveOutputInvalidError);
    expect((missing as NaiveOutputInvalidError).code).toBe("output_missing");
  });

  it("without an output schema, returns the final agent message", async () => {
    const { naive, agent } = await tdm13Setup();
    naive.script("understander", { text: "plain answer" });
    const r = await runSession(naive, {
      agentId: agent.id,
      role: "understander",
      input: "x",
      budgetMicroUsd: 1_000n,
      idempotencyKey: "k",
    });
    expect(r.status === "completed" && r.output).toBe("plain answer");
  });

  it("a script costing more than the budget emits budget.exceeded and caps spend at the budget", async () => {
    const { naive, agent } = await tdm13Setup();
    naive.script("understander", {
      output: { kind: "agent", summary: "s", benchable: "ready" },
      costMicroUsd: 9_000n,
    });
    const seen: string[] = [];
    const error = await runSession(naive, {
      agentId: agent.id,
      role: "understander",
      input: "x",
      output: { schema: Understanding },
      budgetMicroUsd: 5_000n,
      idempotencyKey: "k",
      onEvent: (e) => void seen.push(e.type),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NaiveBudgetExceededError);
    expect((error as NaiveBudgetExceededError).consumedMicroUsd).toBe(5_000n);
    expect((error as NaiveBudgetExceededError).budgetMicroUsd).toBe(5_000n);
    expect(seen).toContain("budget.exceeded");
    expect(naive.spentMicroUsd()).toBe(5_000n);
  });

  it("an AbortSignal cancels a hanging session on Naïve and rejects with NaiveCancelledError", async () => {
    const { naive, agent } = await tdm13Setup();
    naive.script("understander", { hang: true, costMicroUsd: 700n });
    const controller = new AbortController();
    const seen: number[] = [];
    const run = runSession(naive, {
      agentId: agent.id,
      role: "understander",
      input: "x",
      budgetMicroUsd: 1_000n,
      idempotencyKey: "k",
      signal: controller.signal,
      onEvent: (e) => {
        seen.push(e.seq);
        if (e.seq === 2) controller.abort();
      },
    });
    const error = await run.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NaiveCancelledError);
    expect((error as NaiveCancelledError).lastSeq).toBe(2);
    const [session] = naive.allSessions();
    expect(session?.status).toBe("cancelled");
    expect(naive.calls.some((c) => c.method === "sessions.cancel")).toBe(true);
    expect(naive.spentMicroUsd()).toBe(700n);
  });

  it("a hanging session completes when released", async () => {
    const { naive, agent } = await tdm13Setup();
    naive.script("understander", { hang: true, text: "late" });
    const run = runSession(naive, {
      agentId: agent.id,
      role: "understander",
      input: "x",
      budgetMicroUsd: 1_000n,
      idempotencyKey: "k",
      onSession: (s) => {
        setTimeout(() => naive.release(s.id), 5);
      },
    });
    const r = await run;
    expect(r.status === "completed" && r.output).toBe("late");
  });

  it("reconnects after a dropped stream, resuming after the last seq without duplicates", async () => {
    const { naive, agent } = await tdm13Setup();
    naive.script("understander", { text: "after drop", dropStreamAfterSeq: 3 });
    const seen: number[] = [];
    const r = await runSession(naive, {
      agentId: agent.id,
      role: "understander",
      input: "x",
      budgetMicroUsd: 1_000n,
      idempotencyKey: "k",
      onEvent: (e) => void seen.push(e.seq),
    });
    expect(r.status).toBe("completed");
    expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
    const streams = naive.calls.filter((c) => c.method === "sessions.stream");
    expect(streams.map((c) => (c.args[1] as { afterSeq: number }).afterSeq)).toEqual([0, 3]);
  });

  it("resume re-attaches to an existing session from afterSeq without creating", async () => {
    const { naive, agent } = await tdm13Setup();
    naive.script("understander", { text: "first" });
    const first = await runSession(naive, {
      agentId: agent.id,
      role: "understander",
      input: "x",
      budgetMicroUsd: 1_000n,
      idempotencyKey: "k",
    });
    const seen: number[] = [];
    const resumed = await runSession(naive, {
      agentId: agent.id,
      role: "understander",
      input: "x",
      budgetMicroUsd: 1_000n,
      idempotencyKey: "k",
      resume: { sessionId: first.sessionId, afterSeq: 4 },
      onEvent: (e) => void seen.push(e.seq),
    });
    expect(seen).toEqual([5, 6]);
    expect(resumed.sessionId).toBe(first.sessionId);
    expect(resumed.status === "completed" && resumed.output).toBe("first");
    expect(naive.sessionCreates).toHaveLength(1);
  });

  it("failed sessions and odd stop reasons are NaiveSessionFailedError", async () => {
    const { naive, agent } = await tdm13Setup();
    naive.script(
      "understander",
      { status: "failed", stopCode: "harness_crash" },
      { stopReason: "max_iterations" },
    );
    const base = { agentId: agent.id, role: "understander", input: "x", budgetMicroUsd: 1_000n };
    const failed = await runSession(naive, { ...base, idempotencyKey: "a" }).catch(
      (e: unknown) => e,
    );
    expect(failed).toBeInstanceOf(NaiveSessionFailedError);
    expect((failed as NaiveSessionFailedError).stopCode).toBe("harness_crash");
    const maxed = await runSession(naive, { ...base, idempotencyKey: "b" }).catch(
      (e: unknown) => e,
    );
    expect((maxed as NaiveSessionFailedError).stopReason).toBe("max_iterations");
  });

  it("a session parked on approval is awaiting_human with its pending actions", async () => {
    const { naive, agent } = await tdm13Setup();
    naive.script("understander", {
      stopReason: "awaiting_approval",
      pendingActions: [{ kind: "tool", toolCallId: "tc_1", name: "exec", args: { cmd: "ls" } }],
    });
    const r = await runSession(naive, {
      agentId: agent.id,
      role: "understander",
      input: "x",
      budgetMicroUsd: 1_000n,
      idempotencyKey: "k",
    });
    expect(r.status).toBe("awaiting_human");
    if (r.status === "awaiting_human") expect(r.pendingActions[0]?.toolCallId).toBe("tc_1");
  });

  it("402s: no plan blocks every non-billing route; an empty balance refuses create", async () => {
    const { naive, agent } = await tdm13Setup();
    naive.scriptDefault("understander", { text: "x" });
    naive.setSubscription("past_due");
    await expect(assertSubscriptionActive(naive)).rejects.toBeInstanceOf(
      NaiveSubscriptionRequiredError,
    );
    await expect(
      runSession(naive, {
        agentId: agent.id,
        role: "understander",
        input: "x",
        budgetMicroUsd: 1n,
        idempotencyKey: "a",
      }),
    ).rejects.toBeInstanceOf(NaiveSubscriptionRequiredError);
    naive.setSubscription("active").setBalance(0n);
    await expect(
      runSession(naive, {
        agentId: agent.id,
        role: "understander",
        input: "x",
        budgetMicroUsd: 1n,
        idempotencyKey: "b",
      }),
    ).rejects.toBeInstanceOf(NaiveInsufficientCreditsError);
  });

  it("failNext injects an error on one call", async () => {
    const { naive } = await tdm13Setup();
    naive.failNext("credits.show", fakeNaiveError("provider_error", 503));
    await expect(naive.credits.show()).rejects.toMatchObject({
      code: "provider_error",
      retryable: true,
    });
    await expect(naive.credits.show()).resolves.toMatchObject({ mode: "test" });
  });

  it("refuses to run without a positive budget or an idempotency key", async () => {
    const { naive, agent } = await tdm13Setup();
    await expect(
      runSession(naive, {
        agentId: agent.id,
        role: "understander",
        input: "x",
        budgetMicroUsd: 0n,
        idempotencyKey: "k",
      }),
    ).rejects.toThrow();
    await expect(
      runSession(naive, {
        agentId: agent.id,
        role: "understander",
        input: "x",
        budgetMicroUsd: 1n,
        idempotencyKey: "",
      }),
    ).rejects.toThrow();
  });

  it("creditCheck reports spend against our Naïve budget in integer basis points", async () => {
    const naive = new FakeNaive({ balanceMicroUsd: 175_000_000n });
    const check = await creditCheck(naive, 250_000_000n);
    expect(check.spentMicroUsd).toBe(75_000_000n);
    expect(check.spentBps).toBe(3_000n);
  });

  it("is the same class from the ./fake subpath", () => {
    expect(FakeNaiveFromSubpath).toBe(FakeNaive);
  });
});
