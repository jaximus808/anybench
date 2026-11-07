// BYOK token cap (TDM-160): reads Claude Code `--output-format stream-json` lines from the
// warm-up and `run` stdout and stops the trial once the spend crosses `token_cap_micro_usd`.
//
// TDM-50's stream-json collector (@anybench/bench parseStreamJson) landed while this was written.
// It is not reused: it parses a whole transcript after the fact, and depending on @anybench/bench
// would bundle kit/naive/providers into the in-VM binary. This is a minimal incremental parser of
// the same two line types that carry spend, with the same field semantics:
//   - `{"type":"assistant","message":{"id":...,"usage":{input_tokens, output_tokens,
//     cache_read_input_tokens, cache_creation_input_tokens}}}`: Claude Code repeats one message's
//     usage on every content block, so usage is kept once per message id (field-wise max);
//     the estimate is tokens × `token_prices` (micro-USD per million tokens, rounded up).
//   - `{"type":"result","total_cost_usd":...}`: Claude Code's own figure for one `claude -p`
//     session, read from the JSON source text and converted with bigint math (no float).
// Spend = max(estimate over every message, sum of reported results). Anything else is ignored.
//
// Money is integer micro-USD as bigint throughout.

import type { MicroUsd } from "@anybench/core";
import { DEFAULT_TOKEN_PRICES, type TokenPrices } from "./job.js";

export interface TokenUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
}

export interface TokenMeterSnapshot {
  cap_micro_usd: MicroUsd;
  spent_micro_usd: MicroUsd;
  estimate_micro_usd: MicroUsd;
  reported_micro_usd: MicroUsd;
  tokens: TokenUsage;
  messages: number;
  results: number;
  exceeded: boolean;
  /** Which figure decided `spent`: the token estimate or Claude Code's reported cost. */
  source: "estimate" | "reported" | "none";
}

const PER_MTOK = 1_000_000n;
const USD_NUMBER = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;
const TOTAL_COST_TEXT = /"total_cost_usd"\s*:\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/;

/**
 * A JSON number of USD, as text, to integer micro-USD (rounded up, so the cap errs on the side of
 * stopping). Returns null for anything that is not a plain number.
 */
export function usdTextToMicroUsd(text: string): MicroUsd | null {
  const m = USD_NUMBER.exec(text.trim());
  if (!m) return null;
  const [, sign, int, frac = "", exp = "0"] = m;
  const digits = BigInt(`${int}${frac}`);
  const scale = BigInt(exp) - BigInt(frac.length) + 6n;
  let micro: bigint;
  if (scale >= 0n) micro = digits * 10n ** scale;
  else {
    const div = 10n ** -scale;
    micro = digits / div + (digits % div === 0n ? 0n : 1n);
  }
  return sign === "-" ? -micro : micro;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return a / b + (a % b === 0n ? 0n : 1n);
}

export function estimateMicroUsd(usage: TokenUsage, prices: TokenPrices): MicroUsd {
  const total =
    BigInt(usage.input) * prices.input +
    BigInt(usage.output) * prices.output +
    BigInt(usage.cache_read) * prices.cache_read +
    BigInt(usage.cache_creation) * prices.cache_creation;
  return ceilDiv(total, PER_MTOK);
}

const count = (v: unknown): number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;

export class TokenMeter {
  private readonly byMessage = new Map<string, TokenUsage>();
  private anonymous = 0;
  private reported: MicroUsd = 0n;
  private results = 0;
  private exceededFired = false;
  private readonly prices: TokenPrices;

  constructor(
    private readonly cap: MicroUsd,
    prices: TokenPrices | undefined,
    /** Called once, on the line that crosses the cap. */
    private readonly onExceeded: (snapshot: TokenMeterSnapshot) => void,
  ) {
    this.prices = prices ?? DEFAULT_TOKEN_PRICES;
  }

  /** Feed one stdout line (without the verb tag). Non-JSON lines are ignored. */
  line(line: string): void {
    const text = line.trim();
    if (!text.startsWith("{")) return;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return;
    }
    if (raw === null || typeof raw !== "object") return;
    const ev = raw as { type?: unknown; message?: unknown };
    if (ev.type === "assistant" && ev.message && typeof ev.message === "object") {
      const msg = ev.message as { id?: unknown; usage?: unknown };
      if (!msg.usage || typeof msg.usage !== "object") return;
      const u = msg.usage as Record<string, unknown>;
      const usage: TokenUsage = {
        input: count(u.input_tokens),
        output: count(u.output_tokens),
        cache_read: count(u.cache_read_input_tokens),
        cache_creation: count(u.cache_creation_input_tokens),
      };
      const id = typeof msg.id === "string" ? msg.id : `anon-${this.anonymous++}`;
      const prev = this.byMessage.get(id);
      this.byMessage.set(
        id,
        prev
          ? {
              input: Math.max(prev.input, usage.input),
              output: Math.max(prev.output, usage.output),
              cache_read: Math.max(prev.cache_read, usage.cache_read),
              cache_creation: Math.max(prev.cache_creation, usage.cache_creation),
            }
          : usage,
      );
    } else if (ev.type === "result") {
      const m = TOTAL_COST_TEXT.exec(text);
      const micro = m ? usdTextToMicroUsd(m[1]!) : null;
      if (micro === null || micro < 0n) return;
      this.reported += micro;
      this.results++;
    } else {
      return;
    }
    if (!this.exceededFired) {
      const snap = this.snapshot();
      if (snap.exceeded) {
        this.exceededFired = true;
        this.onExceeded(snap);
      }
    }
  }

  snapshot(): TokenMeterSnapshot {
    const tokens: TokenUsage = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
    for (const u of this.byMessage.values()) {
      tokens.input += u.input;
      tokens.output += u.output;
      tokens.cache_read += u.cache_read;
      tokens.cache_creation += u.cache_creation;
    }
    const estimate = estimateMicroUsd(tokens, this.prices);
    const spent = estimate > this.reported ? estimate : this.reported;
    const source =
      this.byMessage.size === 0 && this.results === 0
        ? "none"
        : this.reported >= estimate && this.results > 0
          ? "reported"
          : "estimate";
    return {
      cap_micro_usd: this.cap,
      spent_micro_usd: spent,
      estimate_micro_usd: estimate,
      reported_micro_usd: this.reported,
      tokens,
      messages: this.byMessage.size,
      results: this.results,
      exceeded: spent > this.cap,
      source,
    };
  }
}
