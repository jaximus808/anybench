// Event routes (plan.md section 6): page a run's events by seq, stream them live over SSE, and the
// Naïve webhook. Ticket 8.1 (writer + SSE). The runner's ingest routes live in runner.ts.
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
import {
  AnybenchEventSchema,
  AnybenchEventTypeSchema,
  EventSeveritySchema,
  EventSourceSchema,
} from "../schemas/event.js";
import { RunStateSchema } from "../state/run.js";
import { OkSchema, csvListSchema } from "./common.js";
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
