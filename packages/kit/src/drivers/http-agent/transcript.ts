// Transcripts: what the http-agent driver writes to EVAL_OUT and the gate reads back frozen
// (TDM-40 [4.8]). One file per conversation: `transcripts/<conversation>.json`.
//
// micro-USD fields are written as decimal-integer strings (bigint does not survive JSON) and
// parsed back to bigint by MicroUsdSchema.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { KitSlugSchema, MicroUsdSchema } from "@anybench/core";
import { z } from "zod";

export const TRANSCRIPTS_DIR = "transcripts";
/** One line per turn: the raw input the http-agent collectors read. */
export const TURNS_JSONL = "http-agent.jsonl";

export const ToolCallSchema = z.strictObject({
  name: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
});

export const TranscriptTurnSchema = z.strictObject({
  /** 0-based user turn index within the conversation. */
  index: z.int().nonnegative(),
  /** `script`: from the conversation file. `simulated`: the simulated user wrote it. */
  source: z.enum(["script", "simulated"]),
  user: z.string(),
  status: z.enum(["ok", "error"]),
  /** null when the turn failed before the agent answered. */
  reply: z.string().nullable(),
  error: z.string().optional(),
  http_status: z.int().optional(),
  /** Request sent -> response body read, wall clock. */
  latency_ms: z.number().nonnegative(),
  session_id: z.string().optional(),
  tool_calls: z.array(ToolCallSchema),
  outcome: z.string().optional(),
  cost_micro_usd: MicroUsdSchema.optional(),
  input_tokens: z.int().nonnegative().optional(),
  output_tokens: z.int().nonnegative().optional(),
  /** What the simulated user's Naïve session cost to write this turn (our spend, not the agent's). */
  simulated_user_micro_usd: MicroUsdSchema.optional(),
  warnings: z.array(z.string()).optional(),
});
export type TranscriptTurn = z.infer<typeof TranscriptTurnSchema>;

export const TranscriptEndedBySchema = z.enum([
  "script", // every scripted turn answered, no simulated user
  "simulated_user", // the simulated user said it was done
  "max_turns", // the turn cap was reached first
  "error", // a turn failed; the rest were not sent
]);
export type TranscriptEndedBy = z.infer<typeof TranscriptEndedBySchema>;

export const TranscriptSchema = z.strictObject({
  conversation_id: KitSlugSchema,
  /** Origin and path only: a query string could carry a key. */
  endpoint: z.string(),
  status: z.enum(["completed", "error"]),
  ended_by: TranscriptEndedBySchema,
  error: z.string().optional(),
  /** Total simulated-user spend for the conversation (every session, including the final `done`). */
  simulated_user_micro_usd: MicroUsdSchema.optional(),
  turns: z.array(TranscriptTurnSchema),
});
export type Transcript = z.infer<typeof TranscriptSchema>;

/** JSON with bigint written as a decimal string. */
export function httpAgentJson(value: unknown, space?: number): string {
  return JSON.stringify(
    value,
    (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v),
    space,
  );
}

export function transcriptPath(outDir: string, conversationId: string): string {
  return path.join(outDir, TRANSCRIPTS_DIR, `${conversationId}.json`);
}

export async function writeTranscript(outDir: string, t: Transcript): Promise<string> {
  const file = transcriptPath(outDir, t.conversation_id);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, httpAgentJson(TranscriptSchema.parse(t), 2) + "\n");
  return file;
}

export type TranscriptRead =
  | { ok: true; transcript: Transcript }
  | { ok: false; reason: "missing" | "invalid"; detail: string };

/** Read a frozen transcript. Never throws: a missing or bad file is a result the gate reports. */
export async function readTranscript(
  outDir: string,
  conversationId: string,
): Promise<TranscriptRead> {
  let text: string;
  try {
    text = await readFile(transcriptPath(outDir, conversationId), "utf8");
  } catch {
    return {
      ok: false,
      reason: "missing",
      detail: `${TRANSCRIPTS_DIR}/${conversationId}.json does not exist`,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: "invalid", detail: `invalid JSON (${(e as Error).message})` };
  }
  const r = TranscriptSchema.safeParse(raw);
  if (!r.success) {
    const first = r.error.issues[0];
    return {
      ok: false,
      reason: "invalid",
      detail: `${first?.path.join(".") || "(root)"}: ${first?.message ?? "invalid"}`,
    };
  }
  if (r.data.conversation_id !== conversationId) {
    return {
      ok: false,
      reason: "invalid",
      detail: `names conversation '${r.data.conversation_id}', not '${conversationId}'`,
    };
  }
  return { ok: true, transcript: r.data };
}

/** The agent's final answer: the reply to the last turn that succeeded. */
export function finalReply(t: Transcript): string | null {
  for (let i = t.turns.length - 1; i >= 0; i--) {
    const turn = t.turns[i];
    if (turn?.status === "ok" && turn.reply !== null) return turn.reply;
  }
  return null;
}
