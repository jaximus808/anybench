import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ApprovalEventSchema,
  ApprovalLog,
  LeakGuard,
  approverConfigFromKit,
  approverConfigHash,
  formatApprovalSummary,
  respondToNaiveSession,
  summarizeApprovals,
  type ApprovalEvent,
  type NaiveHumanApi,
  type Reviewer,
} from "../src/index.js";
import { main } from "../src/cli.js";
import { Tdm52FakeTandem } from "./tdm52-fake-tandem.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function ev(
  latency: number,
  decision: ApprovalEvent["decision"] = "approve",
  id = String(latency),
): ApprovalEvent {
  return {
    v: 1,
    simulated: true,
    kind: "tandem",
    policy: "auto",
    config_hash: "0123456789abcdef",
    decision,
    target: { type: "task", id },
    decided_by: "policy:auto",
    requested_at: "2026-11-08T00:00:00.000Z",
    decided_at: "2026-11-08T00:00:01.000Z",
    latency_ms: latency,
  };
}

describe("approval events", () => {
  it("must be labelled simulated", () => {
    expect(ApprovalEventSchema.safeParse({ ...ev(1), simulated: false }).success).toBe(false);
  });

  it("summarizes as 'simulated approvals: N, latency', never minutes", () => {
    const s = summarizeApprovals([ev(10), ev(20), ev(30), ev(4000, "reject", "r")]);
    expect(s).toMatchObject({
      label: "simulated approvals",
      approvals: 3,
      rejections: 1,
      total: 4,
      policy: "auto",
    });
    expect(s.latency_ms).toEqual({ p50: 20, p95: 4000, max: 4000 });
    const line = formatApprovalSummary(s);
    expect(line).toBe("simulated approvals: 3 (+1 rejected), latency p50 20 ms, p95 4000 ms");
    expect(line).not.toMatch(/human|minute/i);
  });

  it("dedupes the same decision on the same target", () => {
    const log = new ApprovalLog(null);
    expect(log.record(ev(1, "approve", "a"))).toBe(true);
    expect(log.record(ev(5, "approve", "a"))).toBe(false);
    expect(log.events()).toHaveLength(1);
    expect(log.has("tandem", "a")).toBe(true);
    expect(log.has("naive", "a")).toBe(false);
  });
});

describe("config", () => {
  it("comes from the kit's human_in_loop and hashes stably", () => {
    const a = approverConfigFromKit(
      { kind: "tandem", policy: "llm-reviewer" },
      { reviewer_model: "gpt-5" },
    );
    const b = approverConfigFromKit(
      { policy: "llm-reviewer", kind: "tandem" },
      { reviewer_model: "gpt-5" },
    );
    expect(approverConfigHash(a)).toBe(approverConfigHash(b));
    expect(approverConfigHash(a)).not.toBe(approverConfigHash({ ...a, policy: "auto" }));
    expect(() => approverConfigFromKit({ kind: "slack" })).toThrow();
  });
});

describe("LeakGuard", () => {
  it("refuses scoring paths, hidden-test talk and forbidden snippets", () => {
    const g = new LeakGuard({ forbidden: ["expect(res.status).toBe(401)", "short"] });
    expect(g.isClean("Ticket 1 touches src/routes/todos.ts")).toBe(true);
    expect(g.isClean("see gates/hidden-tests/todo-api")).toBe(false);
    expect(g.isClean("check reference/out.txt")).toBe(false);
    expect(g.isClean("the hidden tests want 401")).toBe(false);
    expect(g.isClean("make sure expect(res.status).toBe(401) holds")).toBe(false);
    expect(g.isClean("a short answer")).toBe(true);
  });
});

describe("respondToNaiveSession", () => {
  function api(): NaiveHumanApi & { calls: unknown[] } {
    const calls: unknown[] = [];
    return {
      calls,
      confirmTool: (id, body) => (calls.push(["confirm", id, body]), Promise.resolve({})),
      answer: (id, body) => (calls.push(["answer", id, body]), Promise.resolve({})),
    };
  }

  it("auto: allows tool calls and answers questions with the fixed default", async () => {
    const a = api();
    const log = new ApprovalLog(null);
    const config = approverConfigFromKit({ kind: "naive", policy: "auto" });
    const t0 = new Date("2026-11-08T00:00:00Z");
    const events = await respondToNaiveSession({
      api: a,
      sessionId: "ses_1",
      pending: [
        { kind: "tool", toolCallId: "tc1", name: "bash", args: { cmd: "ls" } },
        {
          kind: "question",
          toolCallId: "tc2",
          name: "ask",
          prompt: "Which db?",
          fields: [{ key: "db" }],
        },
      ],
      config,
      log,
      requestedAt: t0,
      now: () => new Date(t0.getTime() + 250),
    });
    expect(a.calls).toEqual([
      ["confirm", "ses_1", { tool_call_id: "tc1", decision: "allow" }],
      ["answer", "ses_1", { tool_call_id: "tc2", answers: { db: config.default_answer } }],
    ]);
    expect(
      events.map((e) => [e.decision, e.decided_by, e.latency_ms, e.kind, e.simulated]),
    ).toEqual([
      ["allow", "policy:auto", 250, "naive", true],
      ["answer", "policy:auto", 250, "naive", true],
    ]);
    // Re-delivering the same parked prompts answers nothing twice.
    await respondToNaiveSession({
      api: a,
      sessionId: "ses_1",
      pending: [{ kind: "tool", toolCallId: "tc1", name: "bash" }],
      config,
      log,
      requestedAt: t0,
    });
    expect(a.calls).toHaveLength(2);
  });

  it("llm-reviewer: deny follows the reviewer, and a leaking answer is refused before it is sent", async () => {
    const a = api();
    const config = approverConfigFromKit(
      { kind: "naive", policy: "llm-reviewer" },
      { reviewer_model: "gpt-5" },
    );
    const reviewer: Reviewer = {
      decidedBy: "agent:rev",
      review: (req) =>
        Promise.resolve(
          req.kind === "tool"
            ? { decision: "reject", reason: "destructive" }
            : {
                decision: "approve",
                reason: "ok",
                answers: { answer: "copy gates/hidden-tests/x.ts" },
              },
        ),
    };
    const common = {
      api: a,
      config,
      reviewer,
      log: new ApprovalLog(null),
      requestedAt: new Date(),
    };
    const events = await respondToNaiveSession({
      ...common,
      sessionId: "s",
      pending: [{ kind: "tool", toolCallId: "t", name: "rm", args: {} }],
    });
    expect(events[0]).toMatchObject({ decision: "deny", decided_by: "agent:rev" });
    await expect(
      respondToNaiveSession({
        ...common,
        sessionId: "s",
        pending: [{ kind: "question", toolCallId: "q", name: "ask" }],
      }),
    ).rejects.toThrow(/scoring material/);
    expect(a.calls.filter((c) => (c as string[])[0] === "answer")).toHaveLength(0);
  });
});

describe("eval-approver CLI", () => {
  it("rejects a bad policy with usage", async () => {
    const err: string[] = [];
    const code = await main(["--policy", "yolo", "--tandem-url", "http://x"], {
      stdout: () => {},
      stderr: (l) => err.push(l),
      env: {},
    });
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/usage: eval-approver/);
  });

  it("llm-reviewer without a reviewer agent exits 2", async () => {
    const err: string[] = [];
    const code = await main(
      ["--policy", "llm-reviewer", "--tandem-url", "http://x", "--reviewer-model", "gpt-5"],
      {
        stdout: () => {},
        stderr: (l) => err.push(l),
        env: {},
      },
    );
    expect(code).toBe(2);
  });

  it("--once against a fake Tandem prints the canvas code and writes the summary", async () => {
    const fake = new Tdm52FakeTandem();
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((i: string | URL | Request, init?: RequestInit) =>
      fake.fetch(String(i), init)) as typeof fetch;
    const out = mkdtempSync(join(tmpdir(), "tdm52-cli-"));
    dirs.push(out);
    try {
      const lines: string[] = [];
      const code = await main(
        [
          "--policy",
          "auto",
          "--tandem-url",
          "http://tandem.test",
          "--once",
          "--code-file",
          join(out, "canvas.env"),
        ],
        {
          stdout: (l) => lines.push(l),
          stderr: () => {},
          env: { EVAL_OUT: out },
        },
      );
      expect(code).toBe(0);
      expect(lines).toEqual(["TANDEM_CANVAS_CODE=FAKE1234"]);
      expect(readFileSync(join(out, "canvas.env"), "utf8")).toBe("TANDEM_CANVAS_CODE=FAKE1234\n");
      expect(JSON.parse(readFileSync(join(out, "approvals.summary.json"), "utf8"))).toMatchObject({
        label: "simulated approvals",
        simulated: true,
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
