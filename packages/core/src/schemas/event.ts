// AnybenchEvent: the one event model (plan.md section 6). Every row of
// `events(run_id, seq, source, source_id, type, severity, actor, payload, cost_delta_micro_usd, at)`
// parses with AnybenchEventSchema. The DB `id` (bigserial) is not part of the event; unknown keys
// such as `id` are stripped on parse.
//
// Conventions:
// - `type` is dotted and fixes `source` (see EVENT_SOURCE_BY_TYPE); a mismatch fails to parse.
//   `source: "system"` is reserved for future system.* types. Who caused an event is `actor`.
// - `source_id` is the id of the source entity (run id, trial id, agent_session id, computer id,
//   usage_entry id, alert id, Stripe event id, publish_version id). Payloads do not repeat it.
// - `run_id` is null only for events that belong to no run (account-level alerts, billing).
// - Money is integer micro-USD as `bigint` in memory (`cost_delta_micro_usd`, and
//   `usage.recorded.payload.amount_micro_usd`). JSON has no bigint, so on the wire and in jsonb it
//   is a decimal string ("1250000"). Parsing accepts a bigint, a safe integer or a decimal string,
//   and always yields a bigint. Use serializeAnybenchEvent / parseAnybenchEvent to cross JSON.
// - `cost_delta_micro_usd` is the spend this event adds to the run (defaults to 0); it drives the
//   live "spent" counter. It may be negative for refunds and corrections.

import { z } from "zod";
import {
  isLegalRunEdge,
  RUN_COMMAND_TYPES,
  RunStateSchema,
  type RunCommandType,
} from "../state/run.js";
import { isLegalTrialEdge, TrialStateSchema } from "../state/trial.js";

export const EVENT_SOURCES = [
  "run",
  "trial",
  "agent_session",
  "computer",
  "ledger",
  "alert",
  "billing",
  "publish",
  "system",
] as const;
export const EventSourceSchema = z.enum(EVENT_SOURCES);
export type EventSource = z.infer<typeof EventSourceSchema>;

export const EVENT_SEVERITIES = ["debug", "info", "warn", "error", "critical"] as const;
export const EventSeveritySchema = z.enum(EVENT_SEVERITIES);
export type EventSeverity = z.infer<typeof EventSeveritySchema>;

export const EVENT_TYPES = [
  "run.state_changed",
  "trial.phase",
  "trial.heartbeat",
  "trial.log_chunk",
  "trial.gate",
  "agent.tool.started",
  "agent.message",
  "computer.created",
  "computer.destroyed",
  "computer.leaked",
  "usage.recorded",
  "alert.fired",
  "alert.acked",
  "alert.resolved",
  "billing.payment_failed",
  "publish.version_created",
] as const;
export const AnybenchEventTypeSchema = z.enum(EVENT_TYPES);
export type AnybenchEventType = z.infer<typeof AnybenchEventTypeSchema>;

export const EVENT_SOURCE_BY_TYPE = {
  "run.state_changed": "run",
  "trial.phase": "trial",
  "trial.heartbeat": "trial",
  "trial.log_chunk": "trial",
  "trial.gate": "trial",
  "agent.tool.started": "agent_session",
  "agent.message": "agent_session",
  "computer.created": "computer",
  "computer.destroyed": "computer",
  "computer.leaked": "computer",
  "usage.recorded": "ledger",
  "alert.fired": "alert",
  "alert.acked": "alert",
  "alert.resolved": "alert",
  "billing.payment_failed": "billing",
  "publish.version_created": "publish",
} as const satisfies Record<AnybenchEventType, EventSource>;

const id = z.string().min(1);

/** Who caused the event. `agent` ids are agent_session ids; `webhook` ids name the provider. */
export const EventActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("system") }),
  z.object({ kind: z.literal("worker"), id }),
  z.object({ kind: z.literal("runner"), id }),
  z.object({ kind: z.literal("user"), id }),
  z.object({ kind: z.literal("api_key"), id }),
  z.object({ kind: z.literal("agent"), id }),
  z.object({ kind: z.literal("webhook"), id }),
]);
export type EventActor = z.infer<typeof EventActorSchema>;

/** Integer micro-USD, bigint in memory, decimal string in JSON. */
const eventMicroUsd = z
  .union([
    z.bigint(),
    z.int(),
    z.string().regex(/^-?(0|[1-9]\d*)$/, "expected an integer micro-USD decimal string"),
  ])
  .transform((v) => BigInt(v));

const datetime = z.iso.datetime({ offset: true });

const base = {
  run_id: id.nullable(),
  seq: z.int().nonnegative(),
  source_id: id.nullable(),
  severity: EventSeveritySchema,
  actor: EventActorSchema,
  cost_delta_micro_usd: eventMicroUsd.default(0n),
  at: datetime,
};

function eventOf<const T extends AnybenchEventType, P extends z.ZodType>(type: T, payload: P) {
  return z.object({
    ...base,
    type: z.literal(type),
    source: z.literal(EVENT_SOURCE_BY_TYPE[type] as (typeof EVENT_SOURCE_BY_TYPE)[T]),
    payload,
  });
}

const runStateChanged = z
  .object({
    /** null only when the run is created (to = intake). */
    from: RunStateSchema.nullable(),
    to: RunStateSchema,
    command: z
      .custom<RunCommandType>((v) => RUN_COMMAND_TYPES.includes(v as RunCommandType))
      .optional(),
    reason: z.string().optional(),
  })
  .superRefine((p, ctx) => {
    const ok = p.from === null ? p.to === "intake" : isLegalRunEdge(p.from, p.to);
    if (!ok)
      ctx.addIssue({
        code: "custom",
        message: `illegal run transition ${p.from ?? "∅"} → ${p.to}`,
      });
  });

const trialPhase = z
  .object({
    /** null only when the trial is created (to = queued). */
    from: TrialStateSchema.nullable(),
    to: TrialStateSchema,
    attempt: z.int().positive(),
    reason: z.string().optional(),
    failure_class: z.string().optional(),
  })
  .superRefine((p, ctx) => {
    const ok = p.from === null ? p.to === "queued" : isLegalTrialEdge(p.from, p.to);
    if (!ok)
      ctx.addIssue({
        code: "custom",
        message: `illegal trial transition ${p.from ?? "∅"} → ${p.to}`,
      });
  });

const offset = z.int().nonnegative();

export const AnybenchEventSchema = z.discriminatedUnion("type", [
  eventOf("run.state_changed", runStateChanged),
  eventOf("trial.phase", trialPhase),
  eventOf(
    "trial.heartbeat",
    z.object({
      phase: TrialStateSchema,
      lease_owner: id,
      lease_until: datetime,
      log_offset: offset,
    }),
  ),
  /** Bulk bytes live in object storage; the event only points at them. */
  eventOf(
    "trial.log_chunk",
    z.object({
      stream: z.enum(["stdout", "stderr", "transcript", "runner"]),
      offset,
      bytes: z.int().positive(),
      url: z.url(),
    }),
  ),
  /** The correctness gate. No speed or quality number is reported for a trial without one. */
  eventOf(
    "trial.gate",
    z.object({
      gate: id,
      passed: z.boolean(),
      summary: z.string().optional(),
      evidence_url: z.url().optional(),
      details: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  eventOf(
    "agent.tool.started",
    z.object({
      agent_role: id,
      naive_seq: offset,
      tool: id,
      tool_use_id: id.optional(),
      input_preview: z.string().optional(),
    }),
  ),
  eventOf(
    "agent.message",
    z.object({
      agent_role: id,
      naive_seq: offset,
      message_role: z.enum(["assistant", "user", "system"]),
      text: z.string(),
      truncated: z.boolean().default(false),
    }),
  ),
  eventOf(
    "computer.created",
    z.object({
      provider: id,
      provider_id: id.optional(),
      trial_id: id.optional(),
      snapshot_id: id.optional(),
    }),
  ),
  eventOf(
    "computer.destroyed",
    z.object({
      provider: id,
      reason: z.string().optional(),
      trial_id: id.optional(),
      blocks_billed: offset.optional(),
    }),
  ),
  eventOf(
    "computer.leaked",
    z.object({
      provider: id,
      idle_s: offset,
      last_trial_id: id.optional(),
      action: z.enum(["destroyed", "flagged"]),
    }),
  ),
  eventOf(
    "usage.recorded",
    z.object({
      user_id: id,
      trial_id: id.optional(),
      kind: z.enum(["trial_fee", "managed_tokens", "adjustment", "refund"]),
      amount_micro_usd: eventMicroUsd,
      comped: z.boolean().default(false),
    }),
  ),
  eventOf(
    "alert.fired",
    z.object({
      rule_key: id,
      fingerprint: id,
      alert_severity: z.enum(["info", "warn", "critical", "page"]),
      count: z.int().positive(),
      message: z.string(),
      auto_action: z.string().optional(),
    }),
  ),
  eventOf("alert.acked", z.object({ rule_key: id, acked_by: id })),
  /** `resolved_by` is null when the alert resolved itself. */
  eventOf("alert.resolved", z.object({ rule_key: id, resolved_by: id.nullable() })),
  eventOf(
    "billing.payment_failed",
    z.object({
      user_id: id,
      stripe_event_id: id,
      invoice_id: id.optional(),
      action: z.enum(["block_new_runs", "none"]),
    }),
  ),
  eventOf(
    "publish.version_created",
    z.object({ benchmark_id: id, slug: id, version: z.int().positive(), key_id: id.optional() }),
  ),
]);

export type AnybenchEvent = z.infer<typeof AnybenchEventSchema>;
/** The JSON (wire / jsonb) shape: money may be a decimal string. */
export type AnybenchEventInput = z.input<typeof AnybenchEventSchema>;
export type AnybenchEventOf<T extends AnybenchEventType> = Extract<AnybenchEvent, { type: T }>;

// Compile-time check: the union covers every type in EVENT_TYPES.
type MissingEventTypes = Exclude<AnybenchEventType, AnybenchEvent["type"]>;
const _everyEventTypeCovered: [MissingEventTypes] extends [never] ? true : MissingEventTypes = true;
void _everyEventTypeCovered;

function bigintToString(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/** JSON text for an event; bigint money becomes a decimal string. */
export function serializeAnybenchEvent(event: AnybenchEvent): string {
  return JSON.stringify(event, bigintToString);
}

/** The JSON-safe object form (for jsonb columns and SSE payloads). */
export function encodeAnybenchEvent(event: AnybenchEvent): AnybenchEventInput {
  return JSON.parse(serializeAnybenchEvent(event)) as AnybenchEventInput;
}

/** Parse JSON text into a validated event; throws a ZodError (or SyntaxError) on bad input. */
export function parseAnybenchEvent(json: string): AnybenchEvent {
  return AnybenchEventSchema.parse(JSON.parse(json));
}
