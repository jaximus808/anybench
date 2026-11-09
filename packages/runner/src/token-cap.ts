// BYOK token cap (TDM-160, TDM-231): reads Claude Code `--output-format stream-json` lines from the
// warm-up and `run` stdout and stops the trial once the spend crosses `token_cap_micro_usd`.
//
// TDM-50's stream-json collector (@anybench/bench parseStreamJson) is not reused: it parses a whole
// transcript after the fact, and depending on @anybench/bench would bundle kit/naive/providers into
// the in-VM binary. This is a minimal incremental parser of the lines that carry spend.
//
// Why output is estimated from content (TDM-231). Claude Code writes one `assistant` line per
// content block, and every line of a message repeats the usage of the message's *first* stream
// event: input and cache counts are final there, but `output_tokens` is the count at message start
// (1 to 20). The TDM-212 smoke summed 340 output tokens over 37 messages; its `result` said 88382,
// so the live estimate read $1.22 against a real $3.05. No line carries a running output count.
// What the stream does carry:
//   - the content itself: text, and tool_use input (the JSON the model wrote). Output tokens ≈
//     chars / OUTPUT_CHARS_PER_TOKEN (the smoke: 162487 chars over 67839 non-thinking tokens).
//   - `{"type":"system","subtype":"thinking_tokens","estimated_tokens_delta":N}` events, Claude
//     Code's own estimate of thinking tokens (thinking text itself is empty in -p mode). The smoke:
//     22066 estimated, 20543 real.
// Per session, output = max(Σ per-message usage output, content estimate + thinking estimate).
//
// Line types read (raw Claude Code, or the compact form of `board.ts tap`, which carries
// `output_chars` / `thinking_chars` instead of the content and keeps `session_id`):
//   - `{"type":"assistant","session_id":S,"message":{"id":...,"usage":{...},"content":[...]}}`:
//     usage kept once per message id (field-wise max), content chars once per block.
//   - `{"type":"system","subtype":"thinking_tokens","session_id":S,"estimated_tokens_delta":N}`
//   - `{"type":"result","session_id":S,"total_cost_usd":...}`: Claude Code's own figure for one
//     `claude -p` session, read from the JSON source text and converted with bigint math.
//
// Spend is per session (Tandem runs a planner and several workers in parallel, each its own
// session): spent = Σ_s (reported_s once session s has a result, else estimate_s). Lines with no
// `session_id` all count as one session, TDM-160's max(estimate, reported). A session that has not
// reported yet is "open": the cap trips when spent + margin > cap, margin = `margin_pct` % of the
// open sessions' estimates, so the cap errs early (the estimate lags by up to one content block,
// and the chars-per-token ratio is a measurement, not a law). A reported cost needs no margin.
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
  /** Best figure: Σ over sessions of reported (once there) or estimate. No margin. */
  spent_micro_usd: MicroUsd;
  /** Margin added to the open (unreported) sessions' estimates before comparing with the cap. */
  margin_micro_usd: MicroUsd;
  margin_pct: number;
  estimate_micro_usd: MicroUsd;
  reported_micro_usd: MicroUsd;
  /** Tokens over every session; `output` is the content-based estimate where it is larger. */
  tokens: TokenUsage;
  /** Σ usage.output_tokens as Claude Code reported them per message (start-of-message counts). */
  usage_output: number;
  messages: number;
  results: number;
  sessions: number;
  open_sessions: number;
  /** spent + margin > cap. */
  exceeded: boolean;
  /** Which figure decided `spent`: the token estimate, Claude Code's reported cost, or both. */
  source: "estimate" | "reported" | "mixed" | "none";
}

export interface TokenMeterOptions {
  /** Percent of the open sessions' estimate added before the cap check. Default 10. */
  marginPct?: number;
  /** Output chars per token × 100 (integer). Default 220, i.e. 2.20 chars per token. */
  charsPerTokenX100?: number;
}

/**
 * Margin on the open sessions' estimate, percent. The content estimate already reads high on the
 * TDM-212 smoke (+5% at the last message), so 10% more stops a runaway session about 15% before
 * the cap. Overridden per trial by `TrialJob.token_cap_margin_pct`.
 */
export const DEFAULT_TOKEN_CAP_MARGIN_PCT = 10;

/**
 * Chars of emitted content per output token, × 100. Measured: 2.40 on the TDM-212 BYOK smoke
 * (Opus 5.5, thinking on: 162487 chars of text + tool_use JSON / (88382 - 20543 thinking) tokens),
 * 2.25 on a Naïve-proxy solo run (thinking off). 2.20 is below both, so the token estimate errs
 * high (the cap trips early, not late).
 */
export const OUTPUT_CHARS_PER_TOKEN_X100 = 220;

const PER_MTOK = 1_000_000n;
const USD_NUMBER = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;
const TOTAL_COST_TEXT = /"total_cost_usd"\s*:\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/;
const NO_SESSION = "";

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

/** Output tokens for `chars` emitted chars, rounded up. */
export function charsToTokens(
  chars: number,
  charsPerTokenX100 = OUTPUT_CHARS_PER_TOKEN_X100,
): number {
  if (chars <= 0) return 0;
  return Math.ceil((chars * 100) / charsPerTokenX100);
}

const count = (v: unknown): number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Emitted chars of one message's content blocks, each block once (`seen` holds block keys across
 * lines: Claude Code writes one block per line, but a re-sent block must not count twice).
 * Text and tool input JSON count as output; thinking text counts as thinking. The same rule is in
 * kits/tandem-long-horizon/adapters/tandem/board.ts `tap`.
 */
export function contentChars(
  messageId: string,
  content: unknown,
  seen: Set<string>,
): { output: number; thinking: number } {
  let output = 0;
  let thinking = 0;
  if (!Array.isArray(content)) return { output, thinking };
  for (const b of content) {
    if (!isObj(b) || typeof b.type !== "string") continue;
    if (b.type === "text" && typeof b.text === "string") {
      const key = `t:${messageId}:${b.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output += b.text.length;
    } else if (b.type === "thinking" && typeof b.thinking === "string") {
      const key = `k:${messageId}:${typeof b.signature === "string" ? b.signature : b.thinking}`;
      if (seen.has(key)) continue;
      seen.add(key);
      thinking += b.thinking.length;
    } else if ("input" in b) {
      // tool_use, server_tool_use, mcp_tool_use: the model wrote the name and the input JSON.
      const key = `u:${messageId}:${typeof b.id === "string" ? b.id : JSON.stringify(b)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output +=
        (typeof b.name === "string" ? b.name.length : 0) + JSON.stringify(b.input ?? null).length;
    }
  }
  return { output, thinking };
}

interface SessionMeter {
  byMessage: Map<string, TokenUsage>;
  seen: Set<string>;
  outputChars: number;
  thinkingChars: number;
  thinkingTokens: number;
  reported: MicroUsd;
  results: number;
}

export class TokenMeter {
  private readonly sessions = new Map<string, SessionMeter>();
  private anonymous = 0;
  private exceededFired = false;
  private readonly prices: TokenPrices;
  private readonly marginPct: number;
  private readonly charsPerTokenX100: number;

  constructor(
    private readonly cap: MicroUsd,
    prices: TokenPrices | undefined,
    /** Called once, on the line that crosses the cap. */
    private readonly onExceeded: (snapshot: TokenMeterSnapshot) => void,
    opts: TokenMeterOptions = {},
  ) {
    this.prices = prices ?? DEFAULT_TOKEN_PRICES;
    this.marginPct = opts.marginPct ?? DEFAULT_TOKEN_CAP_MARGIN_PCT;
    this.charsPerTokenX100 = opts.charsPerTokenX100 ?? OUTPUT_CHARS_PER_TOKEN_X100;
    if (!Number.isSafeInteger(this.marginPct) || this.marginPct < 0)
      throw new RangeError("token cap margin must be a non-negative integer percent");
    if (!Number.isSafeInteger(this.charsPerTokenX100) || this.charsPerTokenX100 <= 0)
      throw new RangeError("chars per token must be a positive integer (× 100)");
  }

  private session(id: unknown): SessionMeter {
    const key = typeof id === "string" ? id : NO_SESSION;
    let s = this.sessions.get(key);
    if (!s) {
      s = {
        byMessage: new Map(),
        seen: new Set(),
        outputChars: 0,
        thinkingChars: 0,
        thinkingTokens: 0,
        reported: 0n,
        results: 0,
      };
      this.sessions.set(key, s);
    }
    return s;
  }

  /** Feed one stdout line (without the verb tag). Non-JSON lines are ignored. */
  line(line: string): void {
    const text = line.trim();
    if (!text.startsWith("{")) return;
    let ev: unknown;
    try {
      ev = JSON.parse(text);
    } catch {
      return;
    }
    if (!isObj(ev)) return;
    if (ev.type === "assistant" && isObj(ev.message)) {
      const msg = ev.message;
      const compact = typeof ev.output_chars === "number" || typeof ev.thinking_chars === "number";
      if (!isObj(msg.usage) && !compact && !Array.isArray(msg.content)) return;
      const s = this.session(ev.session_id);
      const id = typeof msg.id === "string" ? msg.id : `anon-${this.anonymous++}`;
      if (isObj(msg.usage)) {
        const u = msg.usage;
        const usage: TokenUsage = {
          input: count(u.input_tokens),
          output: count(u.output_tokens),
          cache_read: count(u.cache_read_input_tokens),
          cache_creation: count(u.cache_creation_input_tokens),
        };
        const prev = s.byMessage.get(id);
        s.byMessage.set(
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
      }
      if (compact) {
        // `board.ts tap` line: the tap already counted each block once.
        s.outputChars += count(ev.output_chars);
        s.thinkingChars += count(ev.thinking_chars);
      } else {
        const c = contentChars(id, msg.content, s.seen);
        s.outputChars += c.output;
        s.thinkingChars += c.thinking;
      }
    } else if (ev.type === "system" && ev.subtype === "thinking_tokens") {
      const delta = count(ev.estimated_tokens_delta);
      if (delta === 0) return;
      this.session(ev.session_id).thinkingTokens += delta;
    } else if (ev.type === "result") {
      const m = TOTAL_COST_TEXT.exec(text);
      const micro = m ? usdTextToMicroUsd(m[1]!) : null;
      if (micro === null || micro < 0n) return;
      const s = this.session(ev.session_id);
      s.reported += micro;
      s.results++;
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

  private sessionTokens(s: SessionMeter): { tokens: TokenUsage; usageOutput: number } {
    const tokens: TokenUsage = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
    for (const u of s.byMessage.values()) {
      tokens.input += u.input;
      tokens.output += u.output;
      tokens.cache_read += u.cache_read;
      tokens.cache_creation += u.cache_creation;
    }
    const usageOutput = tokens.output;
    const thinking = Math.max(
      s.thinkingTokens,
      charsToTokens(s.thinkingChars, this.charsPerTokenX100),
    );
    const fromContent = charsToTokens(s.outputChars, this.charsPerTokenX100) + thinking;
    tokens.output = Math.max(usageOutput, fromContent);
    return { tokens, usageOutput };
  }

  snapshot(): TokenMeterSnapshot {
    const tokens: TokenUsage = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
    let usageOutput = 0;
    let estimate = 0n;
    let reported = 0n;
    let spent = 0n;
    let openEstimate = 0n;
    let messages = 0;
    let results = 0;
    let open = 0;
    let byEstimate = 0;
    let byReported = 0;
    for (const [key, s] of this.sessions) {
      const t = this.sessionTokens(s);
      const est = estimateMicroUsd(t.tokens, this.prices);
      tokens.input += t.tokens.input;
      tokens.output += t.tokens.output;
      tokens.cache_read += t.tokens.cache_read;
      tokens.cache_creation += t.tokens.cache_creation;
      usageOutput += t.usageOutput;
      estimate += est;
      reported += s.reported;
      messages += s.byMessage.size;
      results += s.results;
      // A named session's own result is its whole bill. Lines without a session id may mix
      // several sessions, so there a result is only a floor.
      if (s.results > 0 && (key !== NO_SESSION || s.reported >= est)) {
        spent += s.reported;
        byReported++;
      } else {
        spent += est;
        byEstimate++;
      }
      if (s.results === 0) {
        open++;
        openEstimate += est;
      }
    }
    const margin = ceilDiv(openEstimate * BigInt(this.marginPct), 100n);
    const source =
      this.sessions.size === 0
        ? "none"
        : byEstimate === 0
          ? "reported"
          : byReported === 0
            ? "estimate"
            : "mixed";
    return {
      cap_micro_usd: this.cap,
      spent_micro_usd: spent,
      margin_micro_usd: margin,
      margin_pct: this.marginPct,
      estimate_micro_usd: estimate,
      reported_micro_usd: reported,
      tokens,
      usage_output: usageOutput,
      messages,
      results,
      sessions: this.sessions.size,
      open_sessions: open,
      exceeded: spent + margin > this.cap,
      source,
    };
  }
}
