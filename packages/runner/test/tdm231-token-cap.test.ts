// TDM-231: the BYOK spend cap sees true output tokens mid-session. Claude Code's per-message
// usage carries the output count at message start, so the meter estimates output from the content
// the model emitted (and Claude Code's thinking-token events), sums spend per session (Tandem's
// parallel sessions), and trips with a safety margin on the still-unreported estimate.
//
// fixtures/tdm231-smoke-tap.jsonl is the TDM-212 docker-local smoke trial (claude-code-solo,
// Opus 5.5, thinking on, 46 turns, $3.05) passed through kits/tandem-long-horizon's
// `board.ts tap`: the exact lines the runner read from the driver's stdout, with no content (ids,
// usage counts, char counts and the result cost only; checked for `sk-ant-` before commit).

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEFAULT_TOKEN_CAP_MARGIN_PCT,
  estimateMicroUsd,
  OUTPUT_CHARS_PER_TOKEN_X100,
  parseTrialJob,
  TokenMeter,
  usdTextToMicroUsd,
  type TokenMeterSnapshot,
  type TokenPrices,
} from "../src/index.js";

const HERE_TDM231 = dirname(fileURLToPath(import.meta.url));
const SMOKE_TDM231 = readFileSync(join(HERE_TDM231, "fixtures/tdm231-smoke-tap.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.length > 0);
const BOARD_TDM231 = join(
  HERE_TDM231,
  "../../../kits/tandem-long-horizon/adapters/tandem/board.ts",
);
/** Opus 5.5 list prices, as packages/bench FIRST_PARTY_TOKEN_PRICES gives the worker (TDM-212). */
const OPUS_TDM231: TokenPrices = {
  input: 4_000_000n,
  output: 20_000_000n,
  cache_read: 200_000n,
  cache_creation: 5_000_000n,
};
const never = () => undefined;

/** Relative error in basis points, integer math. */
function errorBpTdm231(estimate: bigint, real: bigint): bigint {
  return ((estimate - real) * 10_000n) / real;
}

describe("TDM-212 smoke replay (TDM-231)", () => {
  const resultIdx = SMOKE_TDM231.findIndex((l) => l.startsWith('{"type":"result"'));
  const realMicro = usdTextToMicroUsd(
    /"total_cost_usd":([0-9.eE+-]+)/.exec(SMOKE_TDM231[resultIdx]!)![1]!,
  )!;

  it("the fixture is the whole session: 96 assistant lines, 191 thinking events, one result", () => {
    expect(resultIdx).toBe(SMOKE_TDM231.length - 1);
    expect(realMicro).toBe(3_048_356n);
    expect(SMOKE_TDM231.filter((l) => l.includes('"type":"assistant"'))).toHaveLength(96);
    expect(SMOKE_TDM231.filter((l) => l.includes('"thinking_tokens"'))).toHaveLength(191);
    for (const l of SMOKE_TDM231) expect(l).not.toMatch(/sk-ant-/);
  });

  it("the live estimate at the last message is within 10% of the session's total_cost_usd", () => {
    const meter = new TokenMeter(100_000_000n, OPUS_TDM231, never);
    for (const l of SMOKE_TDM231.slice(0, resultIdx)) meter.line(l);
    const last = meter.snapshot();
    // The root cause: per-message usage says 340 output tokens; the session emitted 88382.
    expect(last.usage_output).toBe(340);
    const usageOnly = estimateMicroUsd({ ...last.tokens, output: last.usage_output }, OPUS_TDM231);
    expect(errorBpTdm231(usageOnly, realMicro)).toBeLessThan(-5000n); // TDM-160's meter: -58%
    // The fix: output from content (162487 chars / 2.20) + thinking events (22066).
    expect(last.tokens).toEqual({
      input: 74,
      output: 73_858 + 22_066,
      cache_read: 3_044_370,
      cache_creation: 134_309,
    });
    expect(last.source).toBe("estimate");
    expect(last.open_sessions).toBe(1);
    const err = errorBpTdm231(last.spent_micro_usd, realMicro);
    expect(err).toBeGreaterThanOrEqual(0n); // errs high: the cap trips early, not late
    expect(err).toBeLessThan(1000n); // within 10%
    // The margin is explicit and on top: 10% of the open estimate.
    expect(last.margin_pct).toBe(DEFAULT_TOKEN_CAP_MARGIN_PCT);
    expect(last.margin_micro_usd).toBe((last.estimate_micro_usd * 10n + 99n) / 100n);

    // Once the session reports, its own figure is the bill and the margin goes.
    meter.line(SMOKE_TDM231[resultIdx]!);
    expect(meter.snapshot()).toMatchObject({
      spent_micro_usd: realMicro,
      margin_micro_usd: 0n,
      source: "reported",
      open_sessions: 0,
    });
  });

  it("a cap the session would cross trips before the session reports", () => {
    const fired: { at: number; snap: TokenMeterSnapshot }[] = [];
    let i = 0;
    const meter = new TokenMeter(2_500_000n, OPUS_TDM231, (snap) => fired.push({ at: i, snap }));
    for (; i < SMOKE_TDM231.length; i++) meter.line(SMOKE_TDM231[i]!);
    expect(fired).toHaveLength(1);
    expect(fired[0]!.at).toBeLessThan(resultIdx);
    expect(fired[0]!.snap.source).toBe("estimate");
    // TDM-160's meter saw $1.29 here and would only have stopped on the result line.
    const s = fired[0]!.snap;
    expect(estimateMicroUsd({ ...s.tokens, output: s.usage_output }, OPUS_TDM231)).toBeLessThan(
      1_500_000n,
    );
  });
});

// ------------------------------------------------------------------------------------------------

/** One Claude Code assistant line: usage frozen at message start, one content block. */
function assistantTdm231(
  session: string | undefined,
  id: string,
  block: Record<string, unknown>,
  usage = { input_tokens: 1000, output_tokens: 3 },
): string {
  return JSON.stringify({
    type: "assistant",
    ...(session ? { session_id: session } : {}),
    message: { id, usage, content: [block] },
  });
}
const toolUseTdm231 = (id: string, chars: number) => ({
  type: "tool_use",
  id: `toolu_${id}`,
  name: "Write",
  // name (5) + {"c":"…"} (8 + n) = chars
  input: { c: "x".repeat(chars - 13) },
});

describe("cap trips before a synthetic overshoot (TDM-231)", () => {
  // Every message writes a 22000-char file. Truth (the smoke's 2.40 chars/token): 9167 output
  // tokens + 1000 input = $0.1405 at the default $3/$15 prices, so the true spend crosses $1.00
  // on message 8. Per-message usage says 3 output tokens a message.
  const trueMicro = (n: number) => BigInt(n) * (3_000n + 137_505n);

  it("stops by message 7 while TDM-160's figure is still a few cents", () => {
    const fired: number[] = [];
    let n = 0;
    const meter = new TokenMeter(1_000_000n, undefined, () => fired.push(n));
    for (n = 1; n <= 20; n++)
      meter.line(assistantTdm231("s1", `m${n}`, toolUseTdm231(`${n}`, 22_000)));
    expect(trueMicro(7)).toBeLessThan(1_000_000n);
    expect(trueMicro(8)).toBeGreaterThan(1_000_000n);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toBeLessThanOrEqual(7);
    // Estimate: 10000 tokens a message; with the 10% margin it crosses on message 6.
    expect(fired[0]).toBe(6);
    const s = meter.snapshot();
    expect(s.usage_output).toBe(60);
    expect(
      estimateMicroUsd(
        { ...s.tokens, output: s.usage_output },
        { input: 3_000_000n, output: 15_000_000n, cache_read: 0n, cache_creation: 0n },
      ),
    ).toBeLessThan(70_000n);
  });

  it("the margin is explicit: 0% trips on message 7, 50% on message 5", () => {
    const at = (marginPct: number) => {
      const fired: number[] = [];
      let n = 0;
      const meter = new TokenMeter(1_000_000n, undefined, () => fired.push(n), { marginPct });
      for (n = 1; n <= 20; n++)
        meter.line(assistantTdm231(undefined, `m${n}`, toolUseTdm231(`${n}`, 22_000)));
      return fired[0];
    };
    expect(at(0)).toBe(7);
    expect(at(50)).toBe(5);
    expect(() => new TokenMeter(1n, undefined, never, { marginPct: -1 })).toThrow(RangeError);
    expect(() => new TokenMeter(1n, undefined, never, { charsPerTokenX100: 0 })).toThrow(
      RangeError,
    );
    expect(OUTPUT_CHARS_PER_TOKEN_X100).toBe(220);
  });

  it("trial.json carries the margin as an integer percent", () => {
    const base = {
      version: 1,
      trial_id: "t",
      run_id: "r",
      attempt: 1,
      driver: { type: "cli", run: "true" },
      wall_clock_s: 10,
    };
    expect(parseTrialJob(base).token_cap_margin_pct).toBeUndefined();
    expect(parseTrialJob({ ...base, token_cap_margin_pct: 25 }).token_cap_margin_pct).toBe(25);
    expect(() => parseTrialJob({ ...base, token_cap_margin_pct: 1.5 })).toThrow(/margin/);
    expect(() => parseTrialJob({ ...base, token_cap_margin_pct: 101 })).toThrow(/margin/);
  });
});

// ------------------------------------------------------------------------------------------------

describe("Tandem: parallel sessions through board.ts tap (TDM-231)", () => {
  const big = (s: string, id: string) =>
    assistantTdm231(s, id, toolUseTdm231(id, 22_000), { input_tokens: 1000, output_tokens: 3 });
  // Default prices: 10000 estimated output + 1000 input = 153000 micro-USD a message.
  const PER_MSG = 153_000n;

  it("sums per session: a finished session's report plus the open sessions' estimates", () => {
    const meter = new TokenMeter(100_000_000n, undefined, never);
    for (const l of [
      big("planner", "p1"),
      big("w1", "a1"),
      big("w2", "b1"),
      big("w1", "a2"),
      big("planner", "p2"),
      '{"type":"result","session_id":"planner","total_cost_usd":0.5}',
      big("w2", "b2"),
      big("w1", "a3"),
    ])
      meter.line(l);
    const s = meter.snapshot();
    expect(s).toMatchObject({
      sessions: 3,
      open_sessions: 2,
      results: 1,
      source: "mixed",
      // planner reported $0.50; w1 has 3 messages, w2 has 2, still estimated.
      spent_micro_usd: 500_000n + 5n * PER_MSG,
      margin_micro_usd: (5n * PER_MSG) / 10n,
    });
    // TDM-160 took max(Σ estimate, Σ reported) over everything: the planner's $0.50 report would
    // hide both workers' spend (or the other way round).
    expect(s.spent_micro_usd).toBeGreaterThan(s.estimate_micro_usd);
    expect(s.spent_micro_usd).toBeGreaterThan(s.reported_micro_usd);
  });

  it("lines without a session id are one session: max(estimate, reported), as before", () => {
    const meter = new TokenMeter(100_000_000n, undefined, never);
    meter.line(assistantTdm231(undefined, "a1", toolUseTdm231("a1", 22_000)));
    meter.line(assistantTdm231(undefined, "a2", toolUseTdm231("a2", 22_000)));
    meter.line('{"type":"result","total_cost_usd":0.1}');
    expect(meter.snapshot()).toMatchObject({
      sessions: 1,
      spent_micro_usd: 2n * PER_MSG,
      source: "estimate",
      margin_micro_usd: 0n,
    });
  });

  // A raw Claude Code stream with every shape the tap reduces: two sessions, a message spread
  // over three lines, a re-sent block, thinking events, a thinking block with text, a key.
  const TEXT_TDM231 = "Writing the app now. sk-ant-api03-tdm231-not-a-real-key-0000";
  const rawTdm231 = [
    '{"type":"system","subtype":"init","session_id":"A","model":"claude-opus-5-5"}',
    '{"type":"system","subtype":"thinking_tokens","estimated_tokens":120,"estimated_tokens_delta":120,"session_id":"A"}',
    assistantTdm231("A", "mA1", { type: "thinking", thinking: "", signature: "sigA" }),
    assistantTdm231("A", "mA1", { type: "text", text: TEXT_TDM231 }),
    assistantTdm231("B", "mB1", {
      type: "thinking",
      thinking: "x".repeat(4400),
      signature: "sigB",
    }),
    assistantTdm231("A", "mA1", toolUseTdm231("A1", 30_000)),
    assistantTdm231("A", "mA1", toolUseTdm231("A1", 30_000)), // re-sent: counted once
    '{"type":"user","session_id":"A","message":{"content":[{"type":"tool_result","content":"ok"}]}}',
    assistantTdm231("B", "mB1", toolUseTdm231("B1", 2_200)),
    '{"type":"system","subtype":"thinking_tokens","estimated_tokens":80,"estimated_tokens_delta":80,"session_id":"A"}',
    assistantTdm231("A", "mA2", { type: "text", text: "Done." }),
    '{"type":"result","subtype":"success","session_id":"B","total_cost_usd":0.25,"usage":{"output_tokens":3000}}',
  ];
  const tmp = mkdtempSync(join(tmpdir(), "tdm231-tap-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("the tap's compact lines meter exactly like the raw stream", () => {
    const r = spawnSync(process.execPath, [BOARD_TDM231, "tap", "--file", join(tmp, "s.jsonl")], {
      input: `${rawTdm231.join("\n")}\n`,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(r.status, r.stderr).toBe(0);
    const compact = r.stdout.trim().split("\n");
    for (const l of compact) {
      expect(Buffer.byteLength(l)).toBeLessThan(4096); // PIPE_BUF: parallel taps never interleave
      expect(l).not.toMatch(/sk-ant-|xxxx/); // no content, no key
    }
    expect(readFileSync(join(tmp, "s.jsonl"), "utf8")).not.toMatch(/sk-ant-/);

    const fromRaw = new TokenMeter(100_000_000n, OPUS_TDM231, never);
    for (const l of rawTdm231) fromRaw.line(l);
    const fromTap = new TokenMeter(100_000_000n, OPUS_TDM231, never);
    for (const l of compact) fromTap.line(l);
    // Same figures, except that the tap counts the redacted text ("[REDACTED]" for the key).
    const a = fromRaw.snapshot();
    const b = fromTap.snapshot();
    expect({
      ...b,
      tokens: undefined,
      estimate_micro_usd: undefined,
      spent_micro_usd: undefined,
      margin_micro_usd: undefined,
    }).toEqual({
      ...a,
      tokens: undefined,
      estimate_micro_usd: undefined,
      spent_micro_usd: undefined,
      margin_micro_usd: undefined,
    });
    expect(b.tokens.output).toBeLessThanOrEqual(a.tokens.output);
    expect(a.tokens.output - b.tokens.output).toBeLessThanOrEqual(13);
    // Session A: (text + 30000 + "Done." chars) / 2.2 + 200 thinking tokens from the events.
    // Session B: 2200 chars / 2.2 + 4400 thinking chars / 2.2; it reported $0.25.
    const charsA = TEXT_TDM231.length + 30_000 + 5;
    expect(a.tokens.output).toBe(Math.ceil((charsA * 100) / 220) + 200 + 1_000 + 2_000);
    expect(a).toMatchObject({ sessions: 2, open_sessions: 1, results: 1, messages: 3 });
  });
});
