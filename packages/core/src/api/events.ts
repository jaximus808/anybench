// Event routes (plan.md section 6): page a run's events by seq, stream them live over SSE, and the
// in-VM runner's ingest endpoint. Tickets 8.1 (writer + SSE) and 5.2 (runner ingest).
//
// SSE wire format for `GET /runs/:id/stream` (one frame per event):
//
//   retry: 1000                        (first frame: reconnect delay in ms)
//   id: 42                             (the event seq)
//   data: {"run_id":"…","seq":42,…}    (encodeAnybenchEvent JSON, bigint money as strings)
//
//   : ping                             (comment keepalive, every ~15 s)
//
//   event: end                         (nothing more will come: the run is terminal)
//   data: {"state":"delivered","last_seq":97}
//
// Event frames carry no `event:` field, so a browser EventSource gets them on `onmessage`.
// On Vercel Functions a stream ends at the function's max duration without an `end` frame; the
// client reconnects with `Last-Event-ID: <last seq>` and the server replays from the table.
import { z } from "zod";
import { RunIdSchema, TrialIdSchema } from "../ids.js";
import { NonNegativeMicroUsdSchema } from "../money.js";
import {
  AnybenchEventSchema,
  AnybenchEventTypeSchema,
  EventSeveritySchema,
  EventSourceSchema,
} from "../schemas/event.js";
import { RunStateSchema } from "../state/run.js";
import { TrialStateSchema } from "../state/trial.js";
import { IsoDateTimeSchema, OkSchema, csvListSchema } from "./common.js";
import { defineRoute, defineRoutes } from "./route.js";

export const EVENTS_PAGE_LIMIT_MAX = 1000;
export const SSE_RETRY_MS = 1000;
export const SSE_PING_INTERVAL_MS = 15_000;

/** Request headers for the stream. `Last-Event-ID` wins over `?after=`. */
export const StreamHeadersSchema = z.object({
  "last-event-id": z.coerce.number().int().nonnegative().optional(),
});

/** Data of the closing `event: end` frame. */
export const StreamEndSchema = z.object({
  state: RunStateSchema,
  last_seq: z.int().nonnegative(),
});

const eventFilters = {
  types: csvListSchema(AnybenchEventTypeSchema).optional(),
  sources: csvListSchema(EventSourceSchema).optional(),
  severities: csvListSchema(EventSeveritySchema).optional(),
  trial_id: TrialIdSchema.optional(),
};

// ---------------------------------------------------------------------------------------------
// Runner ingest (`POST /v1/trials/:id/events`). Versioned because the runner binary is baked into
// VM snapshots and outlives a deploy. The runner does not know run seqs; the server assigns them,
// maps runner events to AnybenchEvents and validates each with AnybenchEventSchema.

/** The runner's own phases, written to `~/eval/out/status.json` (plan.md P1). */
export const RUNNER_PHASES = [
  "prepare",
  "healthcheck",
  "warmup",
  "run",
  "collect",
  "freeze",
  "upload",
  "done",
  "failed",
] as const;
export const RunnerPhaseSchema = z.enum(RUNNER_PHASES);
export type RunnerPhase = z.infer<typeof RunnerPhaseSchema>;

/** Interval at which the runner posts a heartbeat batch, and how many misses fire an alert. */
export const RUNNER_HEARTBEAT_MS = 15_000;
export const RUNNER_INGEST_MAX_EVENTS = 500;

const at = IsoDateTimeSchema;

export const RunnerEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("phase"),
    phase: RunnerPhaseSchema,
    at,
    detail: z.string().optional(),
  }),
  /** Bulk bytes went to object storage by presigned PUT; this only points at them. */
  z.object({
    kind: z.literal("log_chunk"),
    stream: z.enum(["stdout", "stderr", "transcript", "runner"]),
    offset: z.int().nonnegative(),
    bytes: z.int().positive(),
    key: z.string().min(1),
    at,
  }),
  /** `machine.json`: lscpu, uname, nproc, meminfo, load_1m, steal. */
  z.object({ kind: z.literal("machine"), machine: z.record(z.string(), z.unknown()), at }),
  /** A raw collector reading. Not a score: it only counts once the trial's gate passed. */
  z.object({
    kind: z.literal("metric"),
    name: z.string().min(1),
    value: z.number().finite(),
    unit: z.string().min(1).optional(),
    at,
  }),
  /** Token usage from Claude Code stream-json (BYOK token cap). Money in integer micro-USD. */
  z.object({
    kind: z.literal("usage"),
    input_tokens: z.int().nonnegative(),
    output_tokens: z.int().nonnegative(),
    cost_micro_usd: NonNegativeMicroUsdSchema,
    at,
  }),
  z.object({ kind: z.literal("error"), message: z.string().min(1), at }),
]);
export type RunnerEvent = z.infer<typeof RunnerEventSchema>;

export const RunnerIngestBodySchema = z.object({
  /** Runner-local, strictly increasing per trial attempt; the server drops a batch it has seen. */
  batch_seq: z.int().nonnegative(),
  attempt: z.int().positive(),
  sent_at: at,
  heartbeat: z.object({
    phase: RunnerPhaseSchema,
    log_offset: z.int().nonnegative(),
    load_1m: z.number().nonnegative().optional(),
  }),
  events: z.array(RunnerEventSchema).max(RUNNER_INGEST_MAX_EVENTS),
});
export type RunnerIngestBody = z.infer<typeof RunnerIngestBodySchema>;

export const RunnerIngestResponseSchema = z.object({
  accepted: z.int().nonnegative(),
  /** True when this batch_seq was already ingested (nothing new was written). */
  duplicate: z.boolean(),
  /** The runner stops the workload and uploads what it has. */
  cancel_requested: z.boolean(),
  trial_state: TrialStateSchema,
  lease_until: at,
});

// ---------------------------------------------------------------------------------------------

const runParams = z.object({ id: RunIdSchema });

export const eventRoutes = defineRoutes({
  list: defineRoute({
    id: "events.list",
    method: "GET",
    path: "/runs/:id/events",
    auth: ["session", "apiKey:events:read"],
    summary: "A page of a run's events with seq > after, oldest first.",
    params: runParams,
    query: z.object({
      after: z.coerce.number().int().nonnegative().default(0),
      limit: z.coerce.number().int().min(1).max(EVENTS_PAGE_LIMIT_MAX).default(200),
      ...eventFilters,
    }),
    response: z.object({
      items: z.array(AnybenchEventSchema),
      /** Pass as `after` for the next page; null when this page reached the end. */
      next_after: z.int().nonnegative().nullable(),
    }),
  }),
  stream: defineRoute({
    id: "events.stream",
    method: "GET",
    path: "/runs/:id/stream",
    auth: ["session", "apiKey:events:read"],
    summary: "SSE: replay events after Last-Event-ID (or ?after=), then live; `end` when terminal.",
    params: runParams,
    query: z.object({ after: z.coerce.number().int().nonnegative().optional(), ...eventFilters }),
    headers: StreamHeadersSchema,
    kind: "sse",
    response: AnybenchEventSchema,
    stream: { event: AnybenchEventSchema, end: StreamEndSchema },
  }),
  ingest: defineRoute({
    id: "events.ingest",
    method: "POST",
    path: "/v1/trials/:id/events",
    auth: ["runner"],
    summary: "Runner ingest: a batch of runner events plus the 15 s heartbeat for one trial.",
    params: z.object({ id: TrialIdSchema }),
    body: RunnerIngestBodySchema,
    response: RunnerIngestResponseSchema,
  }),
  naiveWebhook: defineRoute({
    id: "events.naiveWebhook",
    method: "POST",
    path: "/webhooks/naive",
    auth: ["webhook"],
    summary: "Naïve webhook deliveries (session.idle, message.completed, budget.exceeded, ...).",
    rawBody: true,
    body: z.string(),
    response: OkSchema,
  }),
});

// ---------------------------------------------------------------------------------------------
// SSE framing, shared by the server (write) and the client (read)

export interface SseFrame {
  id?: string;
  event?: string;
  data: string;
  retry?: number;
}

/** One SSE frame as text. Multi-line data is split over several `data:` lines. */
export function formatSseFrame(frame: SseFrame): string {
  let out = "";
  if (frame.retry !== undefined) out += `retry: ${frame.retry}\n`;
  if (frame.id !== undefined) out += `id: ${frame.id.replace(/[\r\n]/g, "")}\n`;
  if (frame.event !== undefined) out += `event: ${frame.event.replace(/[\r\n]/g, "")}\n`;
  for (const line of frame.data.split(/\r\n|\r|\n/)) out += `data: ${line}\n`;
  return `${out}\n`;
}

/** The keepalive comment frame. */
export const SSE_PING = ": ping\n\n";

/**
 * Incremental SSE parser (WHATWG event-stream rules): feed text chunks, get complete frames.
 * Comments are dropped; `retry` is reported on the frame that carried it.
 */
export class SseParser {
  #buffer = "";
  #frame: { id?: string; event?: string; data: string[]; retry?: number } = { data: [] };

  push(chunk: string): SseFrame[] {
    this.#buffer += chunk;
    const frames: SseFrame[] = [];
    let nl: number;
    while ((nl = this.#buffer.search(/\r\n|\r|\n/)) !== -1) {
      const line = this.#buffer.slice(0, nl);
      const sepLen = this.#buffer.startsWith("\r\n", nl) ? 2 : 1;
      // A lone trailing \r may be the first half of \r\n: wait for more input.
      if (this.#buffer[nl] === "\r" && sepLen === 1 && nl === this.#buffer.length - 1) break;
      this.#buffer = this.#buffer.slice(nl + sepLen);
      if (line === "") {
        const f = this.#frame;
        if (f.data.length > 0 || f.retry !== undefined) {
          const frame: SseFrame = { data: f.data.join("\n") };
          if (f.id !== undefined) frame.id = f.id;
          if (f.event !== undefined) frame.event = f.event;
          if (f.retry !== undefined) frame.retry = f.retry;
          frames.push(frame);
        }
        this.#frame = { data: [] };
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") this.#frame.data.push(value);
      else if (field === "id") this.#frame.id = value;
      else if (field === "event") this.#frame.event = value;
      else if (field === "retry" && /^\d+$/.test(value)) this.#frame.retry = Number(value);
    }
    return frames;
  }
}
