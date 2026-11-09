// TDM-250 [21.10]: a trial's model-token bill is Claude Code's own session totals: per session its
// latest `total_cost_usd` (a running total), summed over sessions. Never the sum of result lines,
// which is what recorded run 01a1c202 at $184.80 against a real $87.71.
import { describe, expect, it } from "vitest";
import { claudeCodeSpend, sessionBills } from "../src/collectors/stream-json.js";

const jsonl = (...lines: object[]) => lines.map((l) => JSON.stringify(l)).join("\n");

describe("sessionBills / claudeCodeSpend (TDM-250)", () => {
  it("a session with background subagents: five results with the same running total bill once", () => {
    // Run 01a1c202's B r0: 5 results each carrying total_cost_usd 6.8140478; the stale meter
    // summed them (5x = $34.07). The bill is $6.81, rounded half up to the micro-dollar.
    const result = {
      type: "result",
      subtype: "success",
      session_id: "b",
      total_cost_usd: 6.8140478,
    };
    const text = jsonl(
      { type: "system", subtype: "init", session_id: "b" },
      { type: "assistant", session_id: "b", message: { id: "m1", content: [] } },
      result,
      result,
      result,
      result,
      result,
    );
    expect(sessionBills(text)).toEqual([{ session: "b", cost_micro_usd: 6_814_048n, results: 5 }]);
    const s = claudeCodeSpend([{ name: "stream.jsonl", text }]);
    expect(s).toMatchObject({ total_micro_usd: 6_814_048n, sessions: 1, open_sessions: 0 });
  });

  it("Tandem: one transcript per session, each at its latest total, summed", () => {
    const planner = jsonl(
      { type: "system", subtype: "init", session_id: "p" },
      { type: "result", subtype: "success", session_id: "p", total_cost_usd: 1.5 },
      { type: "result", subtype: "success", session_id: "p", total_cost_usd: 2.25 },
    );
    const worker = jsonl(
      { type: "system", subtype: "init", session_id: "w" },
      { type: "result", subtype: "success", session_id: "w", total_cost_usd: 3 },
      { type: "result", subtype: "success", session_id: "w", total_cost_usd: 4.1 },
    );
    const s = claudeCodeSpend([
      { name: "tandem/streams/planner.jsonl", text: planner },
      { name: "tandem/streams/worker-1.jsonl", text: worker },
    ]);
    expect(s.total_micro_usd).toBe(6_350_000n);
    expect(s).toMatchObject({ sessions: 2, open_sessions: 0, results: 4 });
  });

  it("a resumed session (headless policy) counts once at its whole-session total", () => {
    const text = jsonl(
      { type: "system", subtype: "init", session_id: "s" },
      { type: "result", subtype: "success", session_id: "s", total_cost_usd: 0.5 },
      { type: "system", subtype: "init", session_id: "s" },
      { type: "result", subtype: "success", session_id: "s", total_cost_usd: 1.1 },
    );
    expect(claudeCodeSpend([{ name: "stream.jsonl", text }])).toMatchObject({
      total_micro_usd: 1_100_000n,
      sessions: 1,
    });
  });

  it("a session stopped before it reported is open: it adds nothing and is counted as open", () => {
    const text = jsonl(
      { type: "system", subtype: "init", session_id: "a" },
      { type: "result", subtype: "success", session_id: "a", total_cost_usd: 2 },
      { type: "system", subtype: "init", session_id: "b" },
      { type: "assistant", session_id: "b", message: { id: "m", content: [] } },
    );
    expect(claudeCodeSpend([{ name: "stream.jsonl", text }])).toMatchObject({
      total_micro_usd: 2_000_000n,
      sessions: 2,
      open_sessions: 1,
    });
  });

  it("reads money from the source text (no float), keys unnamed processes, skips junk lines", () => {
    const text = [
      "not json",
      JSON.stringify({ type: "system", subtype: "init" }),
      '{"type":"result","subtype":"success","total_cost_usd":0.1000005}',
      '{"type":"result","subtype":"success","total_cost_usd":0.2000004}',
    ].join("\n");
    expect(sessionBills(text, "stream.jsonl")).toEqual([
      { session: "stream.jsonl#1", cost_micro_usd: 200_000n, results: 2 },
    ]);
    expect(claudeCodeSpend([])).toMatchObject({ total_micro_usd: 0n, sessions: 0 });
  });
});
