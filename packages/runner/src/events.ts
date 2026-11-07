// Event sink: every event is validated as an AnybenchEvent, redacted, appended to
// ~/eval/out/events.jsonl, and (when an ingest URL is configured) pushed in batches to
// `POST <ingest>/v1/trials/<trial_id>/events` with the per-trial bearer token.
//
// Batches are idempotent: a batch keeps its `batch_seq` and its events across retries, and the
// ingest dedupes on (trial_id, attempt, batch_seq) (also sent as `Idempotency-Key`). When pushing
// fails (auth rejected, or `max_failures` consecutive failures) the sink drops to file-only mode for
// the rest of the process: events.jsonl and status.json keep being written and the worker polls
// them by byte offset.
//
// `seq` here is the runner's own per-attempt counter (0, 1, 2, ...). The ingest assigns the
// run-wide `events.seq` when it writes rows.

import { appendFileSync } from "node:fs";
import {
  AnybenchEventSchema,
  EVENT_SOURCE_BY_TYPE,
  encodeAnybenchEvent,
  redactJson,
  type AnybenchEventInput,
  type AnybenchEventOf,
  type AnybenchEventType,
  type EventSeverity,
  type Redactor,
} from "@anybench/core";
import { z } from "zod";
import type { IngestConfig } from "./job.js";
import { RunnerStatusSchema, type RunnerStatus } from "./status.js";

/** Body of `POST /v1/trials/:id/events`. The ingest endpoint ([5.2]) parses with this. */
export const RunnerEventBatchSchema = z.object({
  trial_id: z.string().min(1),
  attempt: z.int().positive(),
  /** 0-based, per (trial, attempt); the idempotency key. */
  batch_seq: z.int().nonnegative(),
  events: z.array(AnybenchEventSchema),
  /** The runner's status.json at send time (null only if not yet written). */
  status: RunnerStatusSchema.nullable(),
});
export type RunnerEventBatch = z.infer<typeof RunnerEventBatchSchema>;
export type RunnerEventBatchInput = z.input<typeof RunnerEventBatchSchema>;

/** Routes the runner calls on the ingest API, relative to `ingest.url`. */
export const RUNNER_INGEST_ROUTES = {
  events: (trialId: string) => `/v1/trials/${encodeURIComponent(trialId)}/events`,
  uploads: (trialId: string) => `/v1/trials/${encodeURIComponent(trialId)}/uploads`,
  uploadComplete: (trialId: string) => `/v1/trials/${encodeURIComponent(trialId)}/uploads/complete`,
} as const;

export function ingestUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + path;
}

export type FetchLike = typeof fetch;

/** The part of an event the caller chooses; the sink fills in the rest. */
export type EmitInput<T extends AnybenchEventType = AnybenchEventType> = {
  type: T;
  payload: AnybenchEventOf<T>["payload"];
  severity?: EventSeverity;
};

export interface EventSinkOptions {
  eventsPath: string;
  trialId: string;
  runId: string;
  attempt: number;
  actorId: string;
  ingest: IngestConfig | null;
  redact: Redactor;
  status: () => RunnerStatus | null;
  log: (line: string) => void;
  fetch?: FetchLike;
  now?: () => Date;
}

interface Batch {
  batch_seq: number;
  events: AnybenchEventInput[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class EventSink {
  private seq = 0;
  private nextBatchSeq = 0;
  private pending: AnybenchEventInput[] = [];
  private current: Batch | null = null;
  private flushing: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  private retryAt = 0;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;

  mode: "push" | "file_only";
  sentBatches = 0;
  failedPosts = 0;
  lastError: string | null = null;
  count = 0;
  bytes = 0;

  constructor(private readonly opts: EventSinkOptions) {
    this.mode = opts.ingest ? "push" : "file_only";
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? (() => new Date());
  }

  /** Validate, redact, append to events.jsonl, queue for push. Throws on an invalid event. */
  emit<T extends AnybenchEventType>(input: EmitInput<T>): AnybenchEventInput {
    const event = AnybenchEventSchema.parse({
      run_id: this.opts.runId,
      seq: this.seq,
      source: EVENT_SOURCE_BY_TYPE[input.type],
      source_id: this.opts.trialId,
      type: input.type,
      severity: input.severity ?? "info",
      actor: { kind: "runner", id: this.opts.actorId },
      cost_delta_micro_usd: 0n,
      payload: input.payload,
      at: this.now().toISOString(),
    });
    this.seq++;
    const encoded = redactJson(encodeAnybenchEvent(event), this.opts.redact);
    const line = `${JSON.stringify(encoded)}\n`;
    appendFileSync(this.opts.eventsPath, line);
    this.count++;
    this.bytes += Buffer.byteLength(line);
    if (this.mode === "push") {
      this.pending.push(encoded);
      if (this.opts.ingest && this.pending.length >= this.opts.ingest.batch_max) void this.flush();
    }
    return encoded;
  }

  /** Start the periodic flusher. */
  start(): void {
    if (!this.opts.ingest || this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.opts.ingest.flush_ms);
    this.timer.unref();
  }

  /** Send queued events now (respects the retry backoff unless `force`). */
  flush(force = false): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushLoop(force).finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async flushLoop(force: boolean): Promise<void> {
    const ingest = this.opts.ingest;
    if (!ingest) return;
    while (this.mode === "push") {
      if (!force && Date.now() < this.retryAt) return;
      if (!this.current) {
        if (this.pending.length === 0) return;
        this.current = {
          batch_seq: this.nextBatchSeq++,
          events: this.pending.splice(0, ingest.batch_max),
        };
      }
      const ok = await this.post(ingest, this.current);
      if (!ok) return;
      this.current = null;
    }
  }

  private async post(ingest: IngestConfig, batch: Batch): Promise<boolean> {
    const status = this.opts.status();
    const body: RunnerEventBatchInput = {
      trial_id: this.opts.trialId,
      attempt: this.opts.attempt,
      batch_seq: batch.batch_seq,
      events: batch.events,
      status: status ? redactJson(status, this.opts.redact) : null,
    };
    let fatal = false;
    let error: string;
    try {
      const res = await this.fetchImpl(
        ingestUrl(ingest.url, RUNNER_INGEST_ROUTES.events(this.opts.trialId)),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${ingest.token}`,
            "content-type": "application/json",
            "idempotency-key": `${this.opts.trialId}:${this.opts.attempt}:${batch.batch_seq}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(ingest.timeout_ms),
        },
      );
      await res.arrayBuffer().catch(() => undefined);
      // 409 = the ingest already has this batch_seq: the retry of a batch that landed.
      if (res.ok || res.status === 409) {
        this.sentBatches++;
        this.consecutiveFailures = 0;
        this.retryAt = 0;
        return true;
      }
      error = `POST events: HTTP ${res.status}`;
      // Auth or a malformed batch will not get better by retrying.
      fatal = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
    } catch (err) {
      error = `POST events: ${(err as Error).message}`;
    }
    this.failedPosts++;
    this.consecutiveFailures++;
    this.lastError = this.opts.redact(error);
    if (fatal || this.consecutiveFailures >= ingest.max_failures) {
      this.goFileOnly(this.lastError);
    } else {
      this.retryAt = Date.now() + Math.min(30_000, 250 * 2 ** this.consecutiveFailures);
    }
    return false;
  }

  private goFileOnly(reason: string): void {
    if (this.mode === "file_only") return;
    this.mode = "file_only";
    this.pending = [];
    this.current = null;
    this.opts.log(`push disabled, file-only from now on (${reason})`);
  }

  /** Stop the timer and try to drain the queue until `deadlineMs` passes. */
  async close(deadlineMs = 10_000): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const until = Date.now() + deadlineMs;
    while (this.mode === "push" && (this.pending.length > 0 || this.current)) {
      if (Date.now() >= until) {
        this.opts.log("event flush deadline passed; remaining events are in events.jsonl only");
        return;
      }
      await this.flush(true);
      if (this.mode === "push" && (this.pending.length > 0 || this.current)) {
        await sleep(Math.min(500, Math.max(0, until - Date.now())));
      }
    }
  }
}
