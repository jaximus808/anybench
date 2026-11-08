// The Naïve human stand-in: answers a session parked on `awaiting_approval` (confirmTool) or
// `awaiting_answer` (answer) for an agent under test. auto and human-sim allow every tool call and
// answer every question with the config's fixed `default_answer`; llm-reviewer asks the reviewer.
// Every reply is a simulated, timed event in approvals.jsonl, and passes the leak guard first.

import { z } from "zod";
import { approverConfigHash, type ApproverConfig } from "./config.js";
import type { ApprovalEvent, ApprovalLog } from "./events.js";
import { LeakGuard } from "./leak-guard.js";
import { approveAllReviewer, type Reviewer } from "./reviewer.js";

/** The two Naïve session calls a human makes (`client.sessions.confirmTool` / `.answer` in the SDK). */
export interface NaiveHumanApi {
  confirmTool(
    sessionId: string,
    body: { tool_call_id: string; decision: "allow" | "deny"; reason?: string },
  ): Promise<unknown>;
  answer(
    sessionId: string,
    body: { tool_call_id: string; answers: Record<string, string> },
  ): Promise<unknown>;
}

/** A pending action as the SDK reports it (fields kept for questions). */
export const NaivePromptSchema = z.object({
  kind: z.enum(["tool", "question"]),
  toolCallId: z.string().min(1),
  name: z.string(),
  args: z.record(z.string(), z.unknown()).default({}),
  prompt: z.string().optional(),
  fields: z
    .array(z.object({ key: z.string().min(1), optional: z.boolean().optional() }))
    .optional(),
});
export type NaivePrompt = z.input<typeof NaivePromptSchema>;

export interface RespondOptions {
  api: NaiveHumanApi;
  sessionId: string;
  pending: readonly NaivePrompt[];
  config: ApproverConfig;
  log: ApprovalLog;
  /** When the session parked (first seen), for latency. */
  requestedAt: Date;
  reviewer?: Reviewer;
  guard?: LeakGuard;
  trialId?: string;
  contenderId?: string;
  now?: () => Date;
}

function questionFields(
  p: z.infer<typeof NaivePromptSchema>,
): { key: string; optional?: boolean }[] {
  if (p.fields?.length) return p.fields;
  const fromArgs = z
    .object({
      fields: z.array(z.object({ key: z.string().min(1), optional: z.boolean().optional() })),
    })
    .safeParse(p.args);
  return fromArgs.success && fromArgs.data.fields.length
    ? fromArgs.data.fields
    : [{ key: "answer" }];
}

/** Answers every pending prompt on one parked session. Returns the events it recorded. */
export async function respondToNaiveSession(options: RespondOptions): Promise<ApprovalEvent[]> {
  const { config } = options;
  if (config.kind !== "naive") throw new Error(`config.kind is '${config.kind}', not 'naive'`);
  if (config.policy === "llm-reviewer" && !options.reviewer)
    throw new Error("llm-reviewer needs a reviewer");
  const reviewer =
    config.policy === "llm-reviewer" ? options.reviewer! : approveAllReviewer("human-sim");
  const decidedBy = config.policy === "auto" ? "policy:auto" : reviewer.decidedBy;
  const guard = options.guard ?? new LeakGuard();
  const now = options.now ?? (() => new Date());
  const configHash = approverConfigHash(config);
  const out: ApprovalEvent[] = [];

  for (const raw of options.pending) {
    const p = NaivePromptSchema.parse(raw);
    const id = `${options.sessionId}:${p.toolCallId}`;
    if (options.log.has("naive", id)) continue;
    const fields = p.kind === "question" ? questionFields(p) : undefined;
    const verdict = await reviewer.review(
      {
        kind: p.kind,
        title: p.kind === "tool" ? `tool call: ${p.name}` : (p.prompt ?? p.name),
        body: p.kind === "tool" ? JSON.stringify(p.args).slice(0, 4000) : (p.prompt ?? ""),
        ...(fields ? { fields } : {}),
      },
      `${options.trialId ?? "naive"}:${id}`,
    );
    const reason = guard.check(verdict.reason, "naive reason");
    let decision: ApprovalEvent["decision"];
    if (p.kind === "tool") {
      decision = verdict.decision === "approve" ? "allow" : "deny";
      await options.api.confirmTool(options.sessionId, {
        tool_call_id: p.toolCallId,
        decision,
        ...(decision === "deny" ? { reason } : {}),
      });
    } else {
      const answers: Record<string, string> = {};
      for (const f of fields!) {
        const given = verdict.answers?.[f.key];
        answers[f.key] = guard.check(given ?? config.default_answer, "naive answer");
      }
      decision = "answer";
      await options.api.answer(options.sessionId, { tool_call_id: p.toolCallId, answers });
    }
    const decidedAt = now();
    const e: ApprovalEvent = {
      v: 1,
      simulated: true,
      kind: "naive",
      policy: config.policy,
      config_hash: configHash,
      ...(options.trialId ? { trial_id: options.trialId } : {}),
      ...(options.contenderId ? { contender_id: options.contenderId } : {}),
      decision,
      target: {
        type: p.kind,
        id,
        title: (p.kind === "tool" ? p.name : (p.prompt ?? p.name)).slice(0, 200),
      },
      decided_by: decidedBy,
      requested_at: options.requestedAt.toISOString(),
      decided_at: decidedAt.toISOString(),
      latency_ms: Math.max(0, decidedAt.getTime() - options.requestedAt.getTime()),
      reason,
    };
    if (options.log.record(e)) out.push(e);
  }
  return out;
}
