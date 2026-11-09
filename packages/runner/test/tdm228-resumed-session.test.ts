// TDM-228: the spend cap on a resumed session. kits/harness-league's headless policy resumes a
// session that stopped to ask the user (`claude -p <reply> --resume <id>`); the resumed process's
// result carries the whole session's cost again (Claude Code 2.1.319). The meter takes a session's
// latest total instead of the sum of its results, and counts the turns after it (TDM-239,
// e3e4b93); this replays the policy's real driver output through it.
//
// fixtures/tdm228-resumed-tap.jsonl: the driver's stdout (the `board.ts tap` lines) for a real
// two-process session, $0.0394 after the first process and $0.0499 for the whole session.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TokenMeter, type TokenPrices } from "../src/index.js";

const TAP_TDM228 = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "fixtures/tdm228-resumed-tap.jsonl"),
  "utf8",
)
  .split("\n")
  .filter((l) => l.length > 0);
const OPUS_TDM228: TokenPrices = {
  input: 4_000_000n,
  output: 20_000_000n,
  cache_read: 200_000n,
  cache_creation: 5_000_000n,
};
const meterTdm228 = (cap = 25_000_000n) => new TokenMeter(cap, OPUS_TDM228, () => undefined);

describe("TokenMeter on a resumed session (TDM-228)", () => {
  it("bills the session once, at its last (cumulative) result", () => {
    const m = meterTdm228();
    for (const l of TAP_TDM228) m.line(l);
    const s = m.snapshot();
    expect(s.results).toBe(2);
    expect(s.sessions).toBe(1);
    expect(s.reported_micro_usd).toBe(49_934n);
    expect(s.spent_micro_usd).toBe(49_934n);
    expect(s.open_sessions).toBe(0);
    expect(s.source).toBe("reported");
  });

  it("while the resumed process runs, adds what it used since the first result", () => {
    const m = meterTdm228();
    const second = TAP_TDM228.findIndex(
      (l, i) =>
        i > 0 &&
        l.startsWith('{"type":"assistant"') &&
        TAP_TDM228[i - 1]!.startsWith('{"type":"result"'),
    );
    expect(second).toBeGreaterThan(0);
    for (const l of TAP_TDM228.slice(0, second)) m.line(l);
    const atFirst = m.snapshot();
    expect(atFirst.spent_micro_usd).toBe(39_450n);
    expect(atFirst.open_sessions).toBe(0);
    m.line(TAP_TDM228[second]!);
    const running = m.snapshot();
    expect(running.spent_micro_usd).toBeGreaterThan(39_450n);
    expect(running.margin_micro_usd).toBeGreaterThan(0n);
    expect(running.source).toBe("mixed");
  });

  it("lines without a session id still add their results up (they may be several sessions)", () => {
    const m = meterTdm228();
    m.line('{"type":"result","total_cost_usd":0.01}');
    m.line('{"type":"result","total_cost_usd":0.02}');
    expect(m.snapshot().reported_micro_usd).toBe(30_000n);
  });
});
