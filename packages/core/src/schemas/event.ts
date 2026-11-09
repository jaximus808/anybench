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
import { FreeRunRefusalReasonSchema, PaymentRequiredReasonSchema } from "../api/common.js";

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
  "run.budget",
  "run.go_refused",
  "trial.phase",
  "trial.heartbeat",
  "trial.log_chunk",
  "trial.network",
  "trial.gate",
  "trial.kit_suspect",
  "agent.tool.started",
  "agent.message",
  "computer.created",
  "computer.destroyed",
  "computer.leaked",
  "computer.recipe",
  "usage.recorded",
  "alert.fired",
  "alert.acked",
  "alert.resolved",
  "billing.payment_failed",
  "publish.version_created",
  "provider.outage",
] as const;
export const AnybenchEventTypeSchema = z.enum(EVENT_TYPES);
export type AnybenchEventType = z.infer<typeof AnybenchEventTypeSchema>;

export const EVENT_SOURCE_BY_TYPE = {
  "run.state_changed": "run",
  "run.budget": "run",
  "run.go_refused": "run",
  "trial.phase": "trial",
  "trial.heartbeat": "trial",
  "trial.log_chunk": "trial",
  "trial.network": "trial",
  "trial.gate": "trial",
  "trial.kit_suspect": "trial",
  "agent.tool.started": "agent_session",
  "agent.message": "agent_session",
  "computer.created": "computer",
  "computer.destroyed": "computer",
  "computer.leaked": "computer",
  "computer.recipe": "computer",
  "usage.recorded": "ledger",
  "alert.fired": "alert",
  "alert.acked": "alert",
  "alert.resolved": "alert",
  "billing.payment_failed": "billing",
  "publish.version_created": "publish",
  "provider.outage": "system",
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
  /**
   * TDM-242: the run's budget numbers changed (orchestrator/budget.ts). `cost_delta_micro_usd` is
   * the change in `spent_micro_usd`, so the live spent counter follows it; the payload carries the
   * absolute numbers. `limit_micro_usd` is what spent + committed is held to (`basis` billed: the
   * run budget; `free_run`: the free-run compute cap at our cost). BYOK tokens are reported only.
   */
  eventOf(
    "run.budget",
    z.object({
      basis: z.enum(["billed", "free_run"]),
      limit_micro_usd: eventMicroUsd,
      spent_micro_usd: eventMicroUsd,
      committed_micro_usd: eventMicroUsd,
      byok_token_micro_usd: eventMicroUsd,
      spent_by_kind: z
        .object({
          run_fee: eventMicroUsd,
          compute: eventMicroUsd,
          managed_tokens: eventMicroUsd,
        })
        .optional(),
    }),
  ),
  /**
   * TDM-243: auto-go (the orchestrator) could not start a run waiting in awaiting_go: the same
   * Go decision as POST /runs/:id/go refused it. `message` is the sentence the Go button would
   * show (core paymentRequiredMessage); the run stays in awaiting_go. Written once per distinct
   * refusal, not on every sweep.
   */
  eventOf(
    "run.go_refused",
    z.object({
      reason: PaymentRequiredReasonSchema,
      message: z.string().min(1),
      link_card_url: z.url(),
      /** Why the free starter run did not apply, when it was in play. */
      free_run_reason: FreeRunRefusalReasonSchema.optional(),
    }),
  ),
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
      /** sha256 of the segment's bytes (the runner sends it; older producers may not). */
      sha256: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional(),
    }),
  ),
  /**
   * The runner's network probe before `run`: an HTTPS HEAD to each declared allowed host and to a
   * canary that should be blocked. On Naïve the allow-list is declared, not enforced, so a
   * reachable canary is recorded, not failed.
   */
  eventOf(
    "trial.network",
    z.object({
      allowed: z.record(z.string(), z.enum(["ok", "failed"])),
      canary: z.enum(["blocked", "reachable"]),
      canary_url: z.url(),
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
  /**
   * A gate FAIL that may be the kit's fault (the check broke rather than judged). It still counts
   * against the contender (a fragile check must not become a free re-roll); this flags it for a
   * refund by hand. Written only by the worker's trial.gate job (TDM-51).
   */
  eventOf(
    "trial.kit_suspect",
    z.object({
      gate: id,
      status: z.string().min(1),
      reason: z.string(),
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
  /**
   * One step of an env recipe (packages/envs/recipes/<name>) on a computer; source_id is the
   * computer id. `skipped` means the health check already passed, so install was not run.
   */
  eventOf(
    "computer.recipe",
    z.object({
      recipe: id,
      version: id,
      phase: z.enum(["started", "installed", "healthy", "skipped", "failed"]),
      step: z.enum(["install", "healthcheck"]).optional(),
      arch: z.enum(["x64", "arm64"]).optional(),
      duration_ms: offset.optional(),
      exit_code: z.int().optional(),
      error: z.string().optional(),
    }),
  ),
  eventOf(
    "usage.recorded",
    z.object({
      user_id: id,
      trial_id: id.optional(),
      kind: z.enum(["run_fee", "compute", "managed_tokens", "adjustment", "refund"]),
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
  /**
   * worker-hardening: the compute provider's outage breaker opened (launches paused, nothing
   * billed) or closed again. Written to every run with unfinished trials, for the live page.
   */
  eventOf(
    "provider.outage",
    z.object({
      provider: id,
      status: z.enum(["open", "closed"]),
      message: z.string(),
      last_error: z.string().nullable().optional(),
      next_probe_at: datetime.nullable().optional(),
    }),
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
