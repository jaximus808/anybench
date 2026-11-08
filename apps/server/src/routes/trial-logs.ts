// Trial log tail by byte offset (TDM-74, plan.md section 6, ticket 8.3). Mounted at /trials.
//
//   GET /trials/:id/log?stream=&offset=&bytes=   one redacted slice (core apiRoutes.trials.log)
//   GET /trials/:id/logs                          the same (the ticket's spelling)
//   GET /trials/:id/log/stream?stream=&offset=&bytes=   SSE live tail
//
// The bytes live in object storage as the runner's log segments; the index is the trial's
// `trial.log_chunk` events (lib/trial-logs.ts says how they are checked, since every field came
// from the eval computer). The server reads the ranges itself through short-lived presigned GETs
// and returns text only: never a storage URL, never anything the runner sent as a link.
//
// Auth: `logs:read` (requireScope in routes/index.ts), then the trial is looked up under
// scopedDb(actor): RLS hides other tenants' trials, so a foreign or unknown trial is a 404. A key
// limited to other runs is a 403, as for /runs/:id/*.
//
// Live tail frames: `retry: 1000` first; then one frame per slice with `id: <next_offset>` and data
// = the slice JSON ({offset, next_offset, text, eof}); `: ping` after 15 s of silence; `event: end`
// with {next_offset} once the trial is final and the log is read to its end. Resume:
// `Last-Event-ID` (a byte offset) beats `?offset=`. New data is noticed through the run's events
// (the shared LISTEN in listen mode, a re-read every EVENTS_POLL_INTERVAL_MS otherwise).
// Revocation: every LOG_STREAM_AUTH_RECHECK_MS the stream authenticates the request again (a fresh
// Request, so the per-request memo is bypassed) and re-reads the trial under RLS; on failure it
// sends `event: error` with {code, message} and closes. In poll mode the stream also closes after
// EVENTS_STREAM_MAX_DURATION_MS without `end`; the client reconnects with Last-Event-ID.
import {
  apiError,
  API_ERROR_STATUS,
  apiRoutes,
  encodeRouteResponse,
  formatSseFrame,
  LOG_TAIL_MAX_BYTES,
  parseRouteRequest,
  SSE_PING,
  SSE_PING_INTERVAL_MS,
  SSE_RETRY_MS,
  TrialIdSchema,
  type ApiErrorCode,
  type Redactor,
  type TrialState,
} from "@anybench/core";
import { eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { trials } from "../db/schema/trials.js";
import { scopedDb } from "../db/scoped.js";
import { actorCanAccessRun, actorHasScope, type AuthActor } from "../lib/auth-key.js";
import {
  isFinalForLogs,
  LOG_LOOKBACK_BYTES,
  loadChunkWindow,
  readLogSlice,
  trialLogRedactor,
  type LogSlice,
  type TrialLogReader,
  type TrialLogStream,
  type TrialRef,
} from "../lib/trial-logs.js";
import type { AppDeps, AppEnv } from "../types.js";

type C = Context<AppEnv>;

/** Query of the live tail; same fields as apiRoutes.trials.log. */
export const TrialLogStreamQuerySchema = z.object({
  stream: z.enum(["stdout", "stderr", "runner"]).default("stdout"),
  offset: z.coerce.number().int().nonnegative().default(0),
  bytes: z.coerce
    .number()
    .int()
    .min(1)
    .max(LOG_TAIL_MAX_BYTES)
    .default(64 * 1024),
});
const LastEventIdSchema = z.coerce.number().int().nonnegative();

/** Slices one stream wakeup may send before it waits again (keeps a catch-up from hogging). */
const SLICES_PER_WAKE = 16;
/** Listen mode re-reads this often even without a notification. */
const LISTEN_FALLBACK_MS = 10_000;

interface TrialRow extends TrialRef {
  state: TrialState;
}

type Authorized =
  | { ok: true; actor: AuthActor; trial: TrialRow }
  | { ok: false; code: ApiErrorCode; message: string };

function fail(c: C, code: ApiErrorCode, message: string, issues?: string[]): Response {
  const body = apiError(code, message, {
    request_id: c.get("requestId"),
    ...(issues ? { issues } : {}),
  });
  return c.json(body, API_ERROR_STATUS[code] as ContentfulStatusCode);
}

async function readTrial(deps: AppDeps, actor: AuthActor, id: string): Promise<TrialRow | null> {
  const [row] = await scopedDb(actor, deps.db).transaction((tx) =>
    tx
      .select({ id: trials.id, runId: trials.runId, attempt: trials.attempt, state: trials.state })
      .from(trials)
      .where(eq(trials.id, id))
      .limit(1),
  );
  return row ?? null;
}

/** The caller may read this trial's logs: authenticated, `logs:read`, its run, visible under RLS. */
async function authorize(deps: AppDeps, req: Request, id: string): Promise<Authorized> {
  const actor = deps.authenticate ? await deps.authenticate(req) : null;
  if (!actor) return { ok: false, code: "unauthorized", message: "sign in or pass an API key" };
  if (!actorHasScope(actor, "logs:read")) {
    return { ok: false, code: "forbidden", message: "API key lacks the logs:read scope" };
  }
  const trial = await readTrial(deps, actor, id);
  if (!trial) return { ok: false, code: "not_found", message: "trial not found" };
  if (!actorCanAccessRun(actor, trial.runId)) {
    return { ok: false, code: "forbidden", message: "API key is not valid for this run" };
  }
  return { ok: true, actor, trial };
}

/** One slice of the trial's current attempt, read under the actor's RLS. */
async function slice(
  deps: AppDeps,
  reader: TrialLogReader,
  redactor: Redactor,
  actor: AuthActor,
  trial: TrialRow,
  stream: TrialLogStream,
  offset: number,
  bytes: number,
): Promise<LogSlice> {
  const window = await scopedDb(actor, deps.db).transaction((tx) =>
    loadChunkWindow(tx, trial, stream, Math.max(0, offset - LOG_LOOKBACK_BYTES)),
  );
  return readLogSlice(
    reader,
    redactor,
    { trial, stream, offset, bytes, final: isFinalForLogs(trial.state) },
    window,
  );
}

/** A copy of the request the per-request auth memo has not seen, so auth really runs again. */
function freshRequest(req: Request): Request {
  return new Request(req.url, { method: "GET", headers: req.headers });
}

export function trialLogsRoutes(deps: AppDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  async function getLog(c: C) {
    const route = apiRoutes.trials.log;
    const parsed = parseRouteRequest(route, {
      params: c.req.param(),
      query: c.req.queries(),
      headers: {},
    });
    if (!parsed.ok) {
      return fail(c, "validation_failed", parsed.error.error.message, parsed.error.error.issues);
    }
    const { params, query } = parsed.request;
    const auth = await authorize(deps, c.req.raw, params.id);
    if (!auth.ok) return fail(c, auth.code, auth.message);
    const reader = deps.trialLogs;
    if (!reader) return fail(c, "unavailable", "log storage is not configured");
    const redactor = trialLogRedactor(deps.config, auth.trial);
    let result: LogSlice;
    try {
      result = await slice(
        deps,
        reader,
        redactor,
        auth.actor,
        auth.trial,
        query.stream,
        query.offset,
        query.bytes,
      );
    } catch (err) {
      c.get("log").warn({ err, trialId: auth.trial.id }, "trial log read failed");
      return fail(c, "unavailable", "log storage is unavailable; retry");
    }
    return c.json(encodeRouteResponse(route, result) as object, 200);
  }

  r.get("/:id/log", getLog);
  r.get("/:id/logs", getLog);

  r.get("/:id/log/stream", async (c) => {
    const id = TrialIdSchema.safeParse(c.req.param("id"));
    if (!id.success) return fail(c, "validation_failed", "params.id: invalid trial id");
    const q = TrialLogStreamQuerySchema.safeParse(c.req.query());
    if (!q.success) {
      const issues = q.error.issues.map((i) => `query.${i.path.join(".")}: ${i.message}`);
      return fail(c, "validation_failed", issues[0] ?? "invalid query", issues);
    }
    const lastEventId = c.req.header("last-event-id");
    let offset = q.data.offset;
    if (lastEventId !== undefined && lastEventId !== "") {
      const parsedId = LastEventIdSchema.safeParse(lastEventId);
      if (!parsedId.success)
        return fail(c, "validation_failed", "Last-Event-ID must be a byte offset");
      offset = parsedId.data;
    }
    const auth = await authorize(deps, c.req.raw, id.data);
    if (!auth.ok) return fail(c, auth.code, auth.message);
    const reader = deps.trialLogs;
    if (!reader) return fail(c, "unavailable", "log storage is not configured");

    return tailResponse(
      {
        deps,
        reader,
        actor: auth.actor,
        trial: auth.trial,
        stream: q.data.stream,
        bytes: q.data.bytes,
        offset,
        request: c.req.raw,
        log: c.get("log"),
      },
      c.req.raw.signal,
    );
  });

  return r;
}

// ---------------------------------------------------------------------------------------------
// Live tail

interface TailPlan {
  deps: AppDeps;
  reader: TrialLogReader;
  actor: AuthActor;
  trial: TrialRow;
  stream: TrialLogStream;
  bytes: number;
  offset: number;
  request: Request;
  log: AppEnv["Variables"]["log"];
}

function tailResponse(plan: TailPlan, requestSignal: AbortSignal): Response {
  const abort = new AbortController();
  const onRequestAbort = () => abort.abort();
  requestSignal.addEventListener("abort", onRequestAbort, { once: true });
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string) => {
        if (!abort.signal.aborted) controller.enqueue(encoder.encode(text));
      };
      void tail(plan, write, abort.signal)
        .catch((err: unknown) => {
          if (!abort.signal.aborted) {
            plan.log.warn({ err, trialId: plan.trial.id }, "trial log stream failed");
            write(
              formatSseFrame({
                event: "error",
                data: JSON.stringify({
                  code: "unavailable",
                  message: "log stream failed; reconnect",
                }),
              }),
            );
          }
        })
        .finally(() => {
          requestSignal.removeEventListener("abort", onRequestAbort);
          if (!abort.signal.aborted) {
            abort.abort();
            try {
              controller.close();
            } catch {
              // already closed by a cancel
            }
          }
        });
    },
    cancel() {
      abort.abort();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

/** Sleep until `ms` passes, the signal aborts, or `wake()` is called (a wake before the wait counts). */
function waiter(signal: AbortSignal) {
  let pending = false;
  let resolveCurrent: (() => void) | undefined;
  return {
    wake() {
      pending = true;
      resolveCurrent?.();
    },
    wait(ms: number): Promise<void> {
      if (pending || signal.aborted) {
        pending = false;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolveCurrent = undefined;
          pending = false;
          resolve();
        };
        const timer = setTimeout(done, Math.max(1, ms));
        signal.addEventListener("abort", done, { once: true });
        resolveCurrent = done;
      });
    },
  };
}

async function tail(plan: TailPlan, write: (text: string) => void, signal: AbortSignal) {
  const { deps, reader, stream, bytes } = plan;
  const config = deps.config;
  const fanout = config.EVENTS_STREAM_MODE === "listen" ? deps.eventFanout : undefined;
  const startedAt = Date.now();
  const deadline = fanout
    ? Number.POSITIVE_INFINITY
    : startedAt + config.EVENTS_STREAM_MAX_DURATION_MS;
  const recheckMs = config.LOG_STREAM_AUTH_RECHECK_MS;
  let nextAuthCheck = startedAt + recheckMs;
  let actor = plan.actor;
  let trial = plan.trial;
  let redactor = trialLogRedactor(config, trial);
  let cursor = plan.offset;
  let lastWrite = Date.now();
  const w = waiter(signal);
  const unsubscribe = fanout?.subscribe(trial.runId, () => w.wake());
  const send = (text: string) => {
    write(text);
    lastWrite = Date.now();
  };

  try {
    send(formatSseFrame({ retry: SSE_RETRY_MS, data: "" }));
    while (!signal.aborted) {
      if (Date.now() >= nextAuthCheck) {
        const again = await authorize(deps, freshRequest(plan.request), trial.id);
        if (!again.ok) {
          send(
            formatSseFrame({
              event: "error",
              data: JSON.stringify({ code: again.code, message: again.message }),
            }),
          );
          return;
        }
        nextAuthCheck = Date.now() + recheckMs;
        actor = again.actor;
        trial = again.trial;
      } else {
        // The trial row (state, attempt) changes while we tail; re-read it every round.
        const row = await readTrial(deps, actor, trial.id);
        if (!row) return;
        trial = row;
      }
      if (trial.attempt !== plan.trial.attempt) {
        // A retry restarted the log at offset 0 under the same keys.
        redactor = trialLogRedactor(config, trial);
        plan = { ...plan, trial };
        cursor = 0;
      }

      let eof = false;
      for (let n = 0; n < SLICES_PER_WAKE && !signal.aborted; n++) {
        const s = await slice(deps, reader, redactor, actor, trial, stream, cursor, bytes);
        if (s.text.length > 0 || s.next_offset !== cursor) {
          send(formatSseFrame({ id: String(s.next_offset), data: JSON.stringify(s) }));
        }
        const moved = s.next_offset !== cursor;
        cursor = s.next_offset;
        eof = s.eof;
        if (eof || !moved) break;
      }
      if (signal.aborted) return;
      if (eof) {
        send(formatSseFrame({ event: "end", data: JSON.stringify({ next_offset: cursor }) }));
        return;
      }
      const now = Date.now();
      if (now >= deadline) return; // poll mode: close without `end`; resume by Last-Event-ID
      if (now - lastWrite >= SSE_PING_INTERVAL_MS) send(SSE_PING);
      const untilPing = SSE_PING_INTERVAL_MS - (Date.now() - lastWrite);
      const step = fanout ? LISTEN_FALLBACK_MS : config.EVENTS_POLL_INTERVAL_MS;
      await w.wait(Math.min(step, untilPing, nextAuthCheck - Date.now(), deadline - Date.now()));
    }
  } finally {
    unsubscribe?.();
  }
}
