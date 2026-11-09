import { describe, expect, it } from "vitest";
import { collectStreamJson, parseStreamJson } from "../../src/collectors/stream-json.js";
import { fixture, row, value } from "./fixture.js";

// Fixtures are SYNTHETIC (fixtures/collectors/PROVENANCE.md): a real Claude run costs money.
describe("stream-json collector (Claude Code transcript)", () => {
  const ok = fixture("stream-json/success.synthetic.jsonl");

  it("reads tokens from modelUsage across every model", () => {
    const s = parseStreamJson(ok);
    expect(s.token_source).toBe("modelUsage");
    expect(s.tokens).toEqual({ input: 3360, output: 497, cache_read: 18300, cache_creation: 6720 });
    const rows = collectStreamJson(ok);
    expect(value(rows, "input_tokens")).toBe(3360);
    expect(value(rows, "total_tokens")).toBe(3360 + 497 + 18300 + 6720);
    expect(value(rows, "model_output_tokens", { model: "claude-haiku-4-5-20251001" })).toBe(140);
  });

  it("converts total_cost_usd to integer micro-USD from its source text", () => {
    const rows = collectStreamJson(ok);
    const cost = row(rows, "cost_micro_usd");
    expect(cost.unit).toBe("micro_usd");
    expect(cost.value).toBe(123457n); // 0.1234567 USD, half-up at the 7th decimal
    expect(value(rows, "model_cost_micro_usd", { model: "claude-sonnet-4-5-20250929" })).toBe(
      119757n,
    );
    expect(value(rows, "model_cost_micro_usd", { model: "claude-haiku-4-5-20251001" })).toBe(3700n);
  });

  it("counts turns, tool calls, tool errors and 429s", () => {
    const s = parseStreamJson(ok);
    expect(s.turns).toBe(5);
    expect(s.tool_calls).toBe(4);
    expect(s.tool_calls_by_name).toEqual({ Bash: 1, Read: 1, Edit: 2 });
    expect(s.tool_errors).toBe(1);
    expect(s.http_429).toBe(1); // the 529 retry is not a 429
    expect(s.api_retries).toBe(2);
    expect(s.rate_limit_rejections).toBe(0);
    expect(s.is_error).toBe(false);
    const rows = collectStreamJson(ok);
    expect(value(rows, "tool_calls_by_name", { tool: "Edit" })).toBe(2);
    expect(value(rows, "agent_duration_ms")).toBe(48210);
    expect(value(rows, "agent_error")).toBe(0);
    expect(rows.every((m) => m.collector === "stream-json" && m.level === "trial")).toBe(true);
  });

  it("counts a rate-limited run that gave up", () => {
    const rows = collectStreamJson(fixture("stream-json/rate-limited.synthetic.jsonl"));
    expect(value(rows, "http_429")).toBe(3); // two api_retry 429s + the error: "rate_limit" message
    expect(value(rows, "rate_limit_rejections")).toBe(1);
    expect(value(rows, "agent_error")).toBe(1);
    expect(value(rows, "cost_micro_usd")).toBe(25000n); // 2.5e-2 USD, exponent form
    expect(value(rows, "turns")).toBe(2);
  });

  it("falls back to assistant usage when the run died before its result", () => {
    const lines = ok.trimEnd().split("\n");
    const s = parseStreamJson(lines.slice(0, -1).join("\n") + "\n{not json\n");
    expect(s.has_result).toBe(false);
    expect(s.token_source).toBe("assistant.usage");
    // usage counted once per message id: msg_01A, msg_01B, msg_01C, msg_01D
    expect(s.tokens.output).toBe(180 + 95 + 60 + 22);
    expect(s.turns).toBe(4);
    expect(s.cost_micro_usd).toBeNull();
    expect(s.unparsed_lines).toBe(1);
    const rows = collectStreamJson(lines.slice(0, -1).join("\n"));
    expect(value(rows, "result_missing")).toBe(1);
    expect(value(rows, "agent_error")).toBe(1);
    expect(rows.some((m) => m.name === "cost_micro_usd")).toBe(false);
  });

  // TDM-228: a session the headless policy resumed (kits/harness-league), recorded for real.
  describe("a resumed session (TDM-228 headless policy, real Claude Code 2.1.319)", () => {
    const resumed = fixture("stream-json/resumed-auto-answer.real.jsonl");

    it("bills the session once: its last result is the whole session's cost and tokens", () => {
      const s = parseStreamJson(resumed);
      expect(s.processes).toBe(2);
      // 0.03944979999999999 then 0.04993379999999999: the second already includes the first.
      expect(s.cost_micro_usd).toBe(49934n);
      expect(s.token_source).toBe("modelUsage");
      // modelUsage of the second result: input 4 + 6, cache read 28394 + 34425, ...
      expect(s.tokens).toEqual({ input: 10, output: 367, cache_read: 62819, cache_creation: 5998 });
    });

    it("adds up turns and durations over the two processes", () => {
      const s = parseStreamJson(resumed);
      expect(s.turns).toBe(2 + 2);
      expect(s.duration_ms).toBe(5463 + 4213);
    });

    it("counts the policy's auto-answers as questions_auto_answered", () => {
      const s = parseStreamJson(resumed);
      expect(s.headless_policy).toBe("headless-v1");
      expect(s.questions_auto_answered).toBe(1);
      expect(s.auto_answer_cap_reached).toBe(false);
      const rows = collectStreamJson(resumed);
      expect(value(rows, "questions_auto_answered")).toBe(1);
      expect(value(rows, "auto_answer_cap_reached")).toBe(0);
      expect(value(rows, "cost_micro_usd")).toBe(49934n);
      expect(value(rows, "turns")).toBe(4);
    });

    it("reports 0 under the policy when it never fired, and no row without the policy", () => {
      const lines = resumed.trimEnd().split("\n");
      const quiet = lines.filter((l) => !l.includes('"anybench_auto_answer"')).join("\n");
      expect(value(collectStreamJson(quiet), "questions_auto_answered")).toBe(0);
      expect(collectStreamJson(ok).some((m) => m.name === "questions_auto_answered")).toBe(false);
      const capped = `${resumed}{"type":"system","subtype":"anybench_auto_answer_cap","policy":"headless-v1","n":8}\n`;
      expect(value(collectStreamJson(capped), "auto_answer_cap_reached")).toBe(1);
    });

    it("keeps two different sessions apart: each session's last result, added up", () => {
      const other = resumed.replaceAll(
        "97aabc3c-5e00-4043-8e63-cf3459ec2dbc",
        "11111111-2222-4333-8444-555555555555",
      );
      const s = parseStreamJson(`${resumed}${other}`);
      expect(s.processes).toBe(4);
      expect(s.cost_micro_usd).toBe(2n * 49934n);
      expect(s.turns).toBe(8);
    });
  });
});
