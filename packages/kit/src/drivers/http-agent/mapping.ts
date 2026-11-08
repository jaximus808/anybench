// Request/response mapping for driver.type `http-agent` (TDM-40 [4.8]).
//
// Agents speak many JSON chat dialects (a `{messages}` body, OpenAI chat completions, a session
// API that only wants the latest message). The mapping lives in a small JSON config next to the
// adapter (`adapters/<contender>/http-agent.json`) and says how to build each request body and
// where the reply, session id, tool calls, outcome, cost and token counts sit in the response.
//
// Money: cost is read as integer micro-USD only (a JSON integer, a decimal-integer string, or a
// response header). A float cost is refused and recorded as a cost error, never rounded.
import { MicroUsdSchema, type MicroUsd } from "@anybench/core";
import { z } from "zod";

/** Dot path into a JSON document: `reply`, `choices.0.message.content`, `usage.cost_micro_usd`. */
export const JsonPathSchema = z.string().regex(/^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*$/, {
  error: "must be a dot path like 'reply' or 'choices.0.message.content'",
});

/** The default body: the full history as `[{role, content}]` plus the conversation id. */
export const DEFAULT_REQUEST_BODY = {
  conversation_id: "{{conversation_id}}",
  messages: "{{messages}}",
} as const;

export const HttpAgentRequestSchema = z.strictObject({
  /**
   * `full`: `{{messages}}` holds every user and assistant turn so far (stateless chat APIs).
   * `latest`: only the newest user message (stateful APIs that keep history by session id).
   */
  history: z.enum(["full", "latest"]).default("full"),
  /**
   * JSON template for the body. A string that is exactly a placeholder becomes the typed value
   * (`"{{messages}}"` -> an array, `"{{turn}}"` -> a number, `"{{session_id}}"` -> string or
   * null); placeholders inside longer strings are substituted as text. Placeholders:
   * messages, message, conversation_id, session_id, turn, model, context.<key>.
   */
  body: z.unknown().default(DEFAULT_REQUEST_BODY),
});

export const HttpAgentResponseSchema = z.strictObject({
  reply: JsonPathSchema.default("reply"),
  /** Echoed back as `{{session_id}}` on the next turn. */
  session_id: JsonPathSchema.optional(),
  /** An array of tool calls the agent made on this turn. */
  tool_calls: JsonPathSchema.optional(),
  /** Field names inside each tool call. `tool_args` may hold an object or a JSON string. */
  tool_name: JsonPathSchema.default("name"),
  tool_args: JsonPathSchema.default("args"),
  /** The agent's own outcome label (`resolved`, `escalated`, ...). */
  outcome: JsonPathSchema.optional(),
  /** Integer micro-USD this turn cost the agent. */
  cost_micro_usd: JsonPathSchema.optional(),
  input_tokens: JsonPathSchema.optional(),
  output_tokens: JsonPathSchema.optional(),
});

/** HTTP header names: letters, digits and '-'. */
const HeaderNameSchema = z.string().regex(/^[A-Za-z0-9-]+$/, { error: "invalid header name" });

export const HttpAgentConfigSchema = z.strictObject({
  /** The chat endpoint. Overridden by `--endpoint`; falls back to `driver.endpoint`. */
  endpoint: z.url({ protocol: /^https?$/ }).optional(),
  method: z.enum(["POST", "PUT"]).default("POST"),
  /**
   * Extra request headers. `${NAME}` in a value is read from the driver's environment (EVAL_SECRETS
   * is sourced into it), so the config file never holds a secret.
   */
  headers: z.record(HeaderNameSchema, z.string()).default({}),
  request: HttpAgentRequestSchema.default({ history: "full", body: DEFAULT_REQUEST_BODY }),
  response: HttpAgentResponseSchema.default({
    reply: "reply",
    tool_name: "name",
    tool_args: "args",
  }),
  /** Response header carrying the turn's cost in integer micro-USD. */
  cost_header: HeaderNameSchema.default("x-cost-micro-usd"),
  /** Per-turn request timeout. */
  timeout_ms: z.int().min(100).max(600_000).default(60_000),
});
export type HttpAgentConfig = z.infer<typeof HttpAgentConfigSchema>;
export type HttpAgentConfigInput = z.input<typeof HttpAgentConfigSchema>;

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface TemplateValues {
  messages: ChatMessage[];
  message: string;
  conversation_id: string;
  session_id: string | null;
  turn: number;
  model: string | null;
  context: Record<string, string>;
}

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g;
const WHOLE_PLACEHOLDER = /^\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}$/;

function lookupPlaceholder(name: string, v: TemplateValues): unknown {
  if (name.startsWith("context.")) {
    const key = name.slice("context.".length);
    if (!(key in v.context)) throw new Error(`template placeholder {{${name}}} has no value`);
    return v.context[key];
  }
  switch (name) {
    case "messages":
      return v.messages;
    case "message":
      return v.message;
    case "conversation_id":
      return v.conversation_id;
    case "session_id":
      return v.session_id;
    case "turn":
      return v.turn;
    case "model":
      return v.model;
    default:
      throw new Error(`unknown template placeholder {{${name}}}`);
  }
}

/** Fill a request body template. Throws on an unknown placeholder. */
export function fillRequestTemplate(template: unknown, values: TemplateValues): unknown {
  if (typeof template === "string") {
    const whole = WHOLE_PLACEHOLDER.exec(template);
    if (whole?.[1] !== undefined) return lookupPlaceholder(whole[1], values);
    return template.replace(PLACEHOLDER, (_m, name: string) => {
      const val = lookupPlaceholder(name, values);
      if (val === null || val === undefined) return "";
      return typeof val === "string" ? val : JSON.stringify(val);
    });
  }
  if (Array.isArray(template)) return template.map((t) => fillRequestTemplate(t, values));
  if (template !== null && typeof template === "object") {
    return Object.fromEntries(
      Object.entries(template).map(([k, t]) => [k, fillRequestTemplate(t, values)]),
    );
  }
  return template;
}

/** Read a dot path from a parsed JSON document. Numeric segments index arrays. */
export function readJsonPath(doc: unknown, p: string): unknown {
  let cur: unknown = doc;
  for (const seg of p.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(seg)) return undefined;
      cur = cur[Number(seg)];
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[seg];
    } else return undefined;
  }
  return cur;
}

/** `${NAME}` in header values, from env. Throws naming the variable (never its value). */
export function resolveHttpAgentHeaders(
  headers: Record<string, string>,
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = v.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_m, name: string) => {
      const val = env[name];
      if (val === undefined || val === "")
        throw new Error(`header ${k} needs \${${name}}, which is not set`);
      return val;
    });
  }
  return out;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ExtractedTurn {
  reply: string;
  session_id?: string;
  tool_calls: ToolCall[];
  outcome?: string;
  cost_micro_usd?: MicroUsd;
  input_tokens?: number;
  output_tokens?: number;
  /** Fields the mapping named but the response did not carry usably (never fatal). */
  warnings: string[];
}

/** An integer micro-USD amount from a JSON value: a safe integer or a decimal-integer string. */
export function microUsdFromJson(v: unknown): MicroUsd {
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v))
      throw new Error(`cost must be integer micro-USD, got ${String(v)}`);
    return BigInt(v);
  }
  if (typeof v === "string" || typeof v === "bigint") {
    const r = MicroUsdSchema.safeParse(typeof v === "string" ? v.trim() : v);
    if (r.success) return r.data;
  }
  throw new Error(`cost must be integer micro-USD, got ${JSON.stringify(String(v))}`);
}

function tokenCount(v: unknown, what: string, warnings: string[]): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return v;
  warnings.push(`${what} is not a non-negative integer`);
  return undefined;
}

function toolCallsFrom(
  raw: unknown,
  cfg: HttpAgentConfig["response"],
  warnings: string[],
): ToolCall[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warnings.push("tool_calls is not an array");
    return [];
  }
  const out: ToolCall[] = [];
  for (const [i, call] of raw.entries()) {
    const name = readJsonPath(call, cfg.tool_name);
    if (typeof name !== "string" || name === "") {
      warnings.push(`tool_calls[${i}] has no name at '${cfg.tool_name}'`);
      continue;
    }
    let args = readJsonPath(call, cfg.tool_args);
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        warnings.push(`tool_calls[${i}].args is a string that is not JSON`);
        args = {};
      }
    }
    out.push({
      name,
      args:
        args !== null && typeof args === "object" && !Array.isArray(args)
          ? (args as Record<string, unknown>)
          : {},
    });
  }
  return out;
}

/**
 * Pull one turn's fields out of a response. Throws only when the reply itself is missing (the
 * turn has no answer to score); every other gap is a warning on the turn.
 */
export function extractHttpAgentTurn(
  body: unknown,
  headers: { get(name: string): string | null },
  cfg: HttpAgentConfig,
): ExtractedTurn {
  const r = cfg.response;
  const reply = readJsonPath(body, r.reply);
  if (typeof reply !== "string") throw new Error(`response has no string reply at '${r.reply}'`);
  const warnings: string[] = [];
  const out: ExtractedTurn = { reply, tool_calls: [], warnings };

  if (r.session_id !== undefined) {
    const s = readJsonPath(body, r.session_id);
    if (typeof s === "string" && s !== "") out.session_id = s;
    else if (typeof s === "number") out.session_id = String(s);
  }
  if (r.tool_calls !== undefined)
    out.tool_calls = toolCallsFrom(readJsonPath(body, r.tool_calls), r, warnings);
  if (r.outcome !== undefined) {
    const o = readJsonPath(body, r.outcome);
    if (typeof o === "string" && o !== "") out.outcome = o;
  }

  // Cost: the body path wins; else the header. Both are integer micro-USD.
  const costRaw = r.cost_micro_usd !== undefined ? readJsonPath(body, r.cost_micro_usd) : undefined;
  const header = headers.get(cfg.cost_header);
  try {
    if (costRaw !== undefined && costRaw !== null) out.cost_micro_usd = microUsdFromJson(costRaw);
    else if (header !== null && header.trim() !== "")
      out.cost_micro_usd = microUsdFromJson(header.trim());
  } catch (e) {
    warnings.push((e as Error).message);
  }

  if (r.input_tokens !== undefined) {
    const t = tokenCount(readJsonPath(body, r.input_tokens), "input_tokens", warnings);
    if (t !== undefined) out.input_tokens = t;
  }
  if (r.output_tokens !== undefined) {
    const t = tokenCount(readJsonPath(body, r.output_tokens), "output_tokens", warnings);
    if (t !== undefined) out.output_tokens = t;
  }
  return out;
}
