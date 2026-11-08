import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ApprovalLog,
  ApproverConfigSchema,
  LeakError,
  assertSameApproverForAll,
  createTandemApprover,
  readApprovals,
  type ApprovalEvent,
  type Reviewer,
} from "../src/index.js";
import { Tdm52FakeTandem } from "./tdm52-fake-tandem.js";
import { tdm52ProposeEpic } from "./tdm52-planner.js";

const BASE = "http://tandem.test";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "tdm52-"));
  dirs.push(d);
  return d;
}

function scriptedReviewer(
  decide: (title: string) => "approve" | "reject",
  seen: string[] = [],
): Reviewer {
  return {
    decidedBy: "agent:anybench-reviewer",
    review: (req) => {
      seen.push(JSON.stringify(req));
      const decision = decide(req.title);
      return Promise.resolve({
        decision,
        reason: decision === "approve" ? "scoped step" : "unrelated to the goal",
      });
    },
  };
}

describe("createTandemApprover", () => {
  it("auto: PATCHes the policy, human-sim approves the epic, born-approved tasks are counted", async () => {
    const fake = new Tdm52FakeTandem();
    const out = tmp();
    const approver = createTandemApprover({
      baseUrl: BASE,
      fetch: fake.fetch,
      config: ApproverConfigSchema.parse({ kind: "tandem", policy: "auto" }),
      outDir: out,
      trialId: "t1",
      contenderId: "tandem",
    });
    const { canvasCode } = await approver.prepare();
    expect(fake.policy).toBe("auto");
    await tdm52ProposeEpic(BASE, canvasCode, { fetch: fake.fetch });
    fake.tickClock(1500);
    const events = await approver.tick();

    expect(fake.actions.every((a) => a.state === "approved")).toBe(true);
    expect(events).toHaveLength(4);
    const epic = events.find((e) => e.target.type === "epic")!;
    expect(epic).toMatchObject({ decided_by: "human-sim", board_stamp: "human", simulated: true });
    expect(events.filter((e) => e.decided_by === "policy:auto")).toHaveLength(3);
    expect(
      events.filter((e) => e.decided_by === "policy:auto").every((e) => e.latency_ms === 0),
    ).toBe(true);
    expect(fake.calls).toContain(`POST /api/canvas/actions/${epic.target.id}/approve as human`);

    // A second tick finds nothing new; the file holds exactly the four events, all simulated.
    expect(await approver.tick()).toEqual([]);
    const file = readApprovals(join(out, "approvals.jsonl"));
    expect(file).toHaveLength(4);
    expect(
      file.every((e) => e.simulated && e.trial_id === "t1" && e.contender_id === "tandem"),
    ).toBe(true);
    expect(approver.summary()).toMatchObject({
      label: "simulated approvals",
      approvals: 4,
      rejections: 0,
    });
  });

  it("human-sim: approves the epic through the cookie and counts the policy:epic cascade", async () => {
    const fake = new Tdm52FakeTandem();
    const approver = createTandemApprover({
      baseUrl: BASE,
      fetch: fake.fetch,
      config: ApproverConfigSchema.parse({ kind: "tandem", policy: "human-sim" }),
      outDir: null,
    });
    const { canvasCode } = await approver.prepare();
    expect(fake.policy).toBe("epic");
    await tdm52ProposeEpic(BASE, canvasCode, { fetch: fake.fetch, tasks: 2 });
    expect(fake.actions.filter((a) => a.state === "proposed")).toHaveLength(3);
    const events = await approver.tick();
    expect(fake.actions.every((a) => a.state === "approved")).toBe(true);
    expect(events.map((e) => e.decided_by).sort()).toEqual([
      "human-sim",
      "policy:epic",
      "policy:epic",
    ]);
  });

  it("llm-reviewer: peer + cross-model, reviewer approves tasks via the agent door, epic via human-sim", async () => {
    const fake = new Tdm52FakeTandem();
    const seen: string[] = [];
    const approver = createTandemApprover({
      baseUrl: BASE,
      fetch: fake.fetch,
      config: ApproverConfigSchema.parse({
        kind: "tandem",
        policy: "llm-reviewer",
        reviewer_model: "gpt-5",
      }),
      reviewer: scriptedReviewer((t) => (t === "Ticket 2" ? "reject" : "approve"), seen),
      subjectModels: ["claude-opus-4-8"],
      outDir: null,
    });
    const { canvasCode } = await approver.prepare();
    expect(fake.policy).toBe("peer");
    expect(fake.crossModel).toBe(true);
    expect(fake.agents.get("anybench-reviewer")).toBe("gpt-5");
    const { tasks } = await tdm52ProposeEpic(BASE, canvasCode, { fetch: fake.fetch });

    await approver.tick();
    const byTitle = new Map(fake.actions.map((a) => [a.payload.title, a]));
    expect(byTitle.get("Build the todo API")).toMatchObject({
      state: "approved",
      approvedBy: "human",
    });
    expect(byTitle.get("Ticket 1")).toMatchObject({
      state: "approved",
      approvedBy: "agent:anybench-reviewer",
    });
    expect(byTitle.get("Ticket 2")?.state).toBe("rejected");
    expect(fake.calls).toContain(
      `POST /api/canvas/actions/${tasks[0]!.id}/approve as anybench-reviewer`,
    );
    expect(fake.calls).toContain(`POST /api/canvas/actions/${tasks[1]!.id}/reject as human`);
    // The reviewer sees the task and its epic, nothing else.
    expect(seen.some((s) => s.includes("Build the todo API") && s.includes("Ticket 1"))).toBe(true);
    const s = approver.summary();
    expect(s).toMatchObject({ approvals: 3, rejections: 1, total: 4 });
  });

  it("llm-reviewer refuses a reviewer on the model under test, or no reviewer", () => {
    const config = ApproverConfigSchema.parse({
      kind: "tandem",
      policy: "llm-reviewer",
      reviewer_model: "claude-opus-4-8",
    });
    expect(() =>
      createTandemApprover({
        baseUrl: BASE,
        config,
        outDir: null,
        reviewer: scriptedReviewer(() => "approve"),
        subjectModels: ["claude-opus-4-8"],
      }),
    ).toThrow(/also a model under test/);
    expect(() =>
      createTandemApprover({
        baseUrl: BASE,
        config: { ...config, reviewer_model: "gpt-5" },
        outDir: null,
      }),
    ).toThrow(/needs a reviewer/);
  });

  it("never sends a reason that names scoring material", async () => {
    const fake = new Tdm52FakeTandem();
    const leaky: Reviewer = {
      decidedBy: "agent:r",
      review: () =>
        Promise.resolve({
          decision: "reject",
          reason: "the hidden tests in gates/hidden-tests check X",
        }),
    };
    const approver = createTandemApprover({
      baseUrl: BASE,
      fetch: fake.fetch,
      config: ApproverConfigSchema.parse({
        kind: "tandem",
        policy: "llm-reviewer",
        reviewer_model: "gpt-5",
      }),
      reviewer: leaky,
      outDir: null,
    });
    const { canvasCode } = await approver.prepare();
    await tdm52ProposeEpic(BASE, canvasCode, { fetch: fake.fetch, tasks: 1 });
    await expect(approver.tick()).rejects.toBeInstanceOf(LeakError);
    expect(fake.actions.every((a) => a.state === "proposed")).toBe(true);
    expect(fake.calls.some((c) => c.includes("/reject"))).toBe(false);
  });

  it("gives every contender the same config hash (rule 4), and assertSameApproverForAll catches a mismatch", async () => {
    const config = ApproverConfigSchema.parse({ kind: "tandem", policy: "auto" });
    const log = new ApprovalLog(null);
    for (const contender of ["tandem@3", "tandem@5"]) {
      const fake = new Tdm52FakeTandem();
      const a = createTandemApprover({
        baseUrl: BASE,
        fetch: fake.fetch,
        config,
        outDir: null,
        contenderId: contender,
        log: new ApprovalLog(null),
      });
      const { canvasCode } = await a.prepare();
      await tdm52ProposeEpic(BASE, canvasCode, { fetch: fake.fetch, tasks: 1 });
      for (const e of await a.tick())
        log.record({ ...e, target: { ...e.target, id: `${contender}:${e.target.id}` } });
    }
    expect(new Set(log.events().map((e) => e.config_hash)).size).toBe(1);
    expect(() => assertSameApproverForAll(log.events())).not.toThrow();
    const odd: ApprovalEvent = {
      ...log.events()[0]!,
      contender_id: "other",
      config_hash: "0000000000000000",
    };
    expect(() => assertSameApproverForAll([...log.events(), odd])).toThrow(
      /differs across contenders/,
    );
  });

  it("run() ticks until aborted and does a final tick", async () => {
    const fake = new Tdm52FakeTandem();
    const approver = createTandemApprover({
      baseUrl: BASE,
      fetch: fake.fetch,
      config: ApproverConfigSchema.parse({ kind: "tandem", policy: "auto" }),
      outDir: null,
    });
    const { canvasCode } = await approver.prepare();
    const stop = new AbortController();
    const loop = approver.run({ signal: stop.signal, pollMs: 20 });
    await tdm52ProposeEpic(BASE, canvasCode, { fetch: fake.fetch, tasks: 2 });
    stop.abort();
    await loop;
    expect(approver.summary().approvals).toBe(3);
  });

  it("writes one JSON object per line", async () => {
    const fake = new Tdm52FakeTandem();
    const out = tmp();
    const a = createTandemApprover({
      baseUrl: BASE,
      fetch: fake.fetch,
      config: ApproverConfigSchema.parse({ kind: "tandem", policy: "auto" }),
      outDir: out,
    });
    const { canvasCode } = await a.prepare();
    await tdm52ProposeEpic(BASE, canvasCode, { fetch: fake.fetch, tasks: 1 });
    await a.tick();
    const lines = readFileSync(join(out, "approvals.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const l of lines)
      expect(JSON.parse(l)).toMatchObject({ v: 1, simulated: true, kind: "tandem" });
  });
});
