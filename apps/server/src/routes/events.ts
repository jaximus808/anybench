// GET /runs/:id/events (pages) and GET /runs/:id/stream (SSE) — TDM-72, plan.md section 6.
// Contract: core apiRoutes.events (TDM-10). Mounted at /runs.
//
// Stream: first frame `retry: 1000`, then one frame per event (`id: <seq>`, data = the event JSON),
// `: ping` every 15 s of silence, and `event: end` with {state, last_seq} once the run is terminal
// and every event up to that point was sent. Resume point: `Last-Event-ID` beats `?after=`.
//
// Two modes (config EVENTS_STREAM_MODE):
//   poll   (default, Vercel Functions): re-read the table every EVENTS_POLL_INTERVAL_MS; after
//          EVENTS_STREAM_MAX_DURATION_MS close the response WITHOUT an end frame. Per the core
//          contract, `end` means "terminal, nothing more"; the client (core createApiClient().stream,
//          browser EventSource) reconnects with Last-Event-ID and the replay continues from the table.
//   listen (long-lived Node): wait on deps.eventFanout (one shared LISTEN) instead of a timer, with
//          a slow fallback re-read; no max duration. Falls back to poll if no fanout is wired.
//
// Every read runs through scopedDb(actor, deps.db): RLS limits a user to their own runs, and an
// unknown or foreign run is a 404 (no existence leak).
import {
  apiError,
  apiRoutes,
  encodeRouteResponse,
  formatSseFrame,
  isTerminalRunState,
  parseRouteRequest,
  serializeAnybenchEvent,
  SSE_PING,
  SSE_PING_INTERVAL_MS,
  SSE_RETRY_MS,
  type ApiErrorBody,
  type ApiErrorCode,
  type RawRequest,
  type RunId,
  type RunState,
} from "@anybench/core";
import { eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { runs } from "../db/schema/runs.js";
import { scopedDb, type DbActor, type ScopedDb } from "../db/scoped.js";
import { readEvents, type EventFanout, type ReadEventsOptions } from "../lib/events.js";
import type { AppDeps, AppEnv } from "../types.js";

const STREAM_PAGE = 500;
/** Listen mode re-reads this often even without a notification (missed NOTIFY, filtered wakes). */
const LISTEN_FALLBACK_MS = 10_000;

type Filters = Pick<ReadEventsOptions, "types" | "sources" | "severities" | "trialId">;

function errorJson(
  c: Context<AppEnv>,
  code: ApiErrorCode,
  message: string,
  status: number,
  issues?: string[],
) {
  const body: ApiErrorBody = apiError(code, message, {
    ...(issues ? { issues } : {}),
    request_id: c.get("requestId"),
  });
  return c.json(body, status as 400);
}

function rawRequest(
  c: Context<AppEnv>,
  headers: Record<string, string | undefined> = {},
): RawRequest {
  return { params: c.req.param(), query: c.req.queries(), headers };
}

function filtersOf(q: {
  types?: ReadEventsOptions["types"];
  sources?: ReadEventsOptions["sources"];
  severities?: ReadEventsOptions["severities"];
  trial_id?: string;
}): Filters {
  return {
    ...(q.types ? { types: q.types } : {}),
    ...(q.sources ? { sources: q.sources } : {}),
    ...(q.severities ? { severities: q.severities } : {}),
    ...(q.trial_id ? { trialId: q.trial_id } : {}),
  };
}

async function actorOf(deps: AppDeps, c: Context<AppEnv>): Promise<DbActor | null> {
  if (!deps.authenticate) return null;
  return deps.authenticate(c.req.raw);
}

interface RunHead {
  state: RunState;
  lastSeq: number;
}

async function runHead(tx: Parameters<Parameters<ScopedDb["transaction"]>[0]>[0], runId: RunId) {
  const [row] = await tx
    .select({ state: runs.state, nextSeq: runs.nextSeq })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);
  return row ? ({ state: row.state, lastSeq: row.nextSeq - 1 } satisfies RunHead) : undefined;
}

/** Resolve after `ms`, on `signal` abort, or when `wake` is called. */
function waiter(signal: AbortSignal) {
  let pending = false;
  let resolveCurrent: (() => void) | undefined;
  return {
    /** Mark that new data may exist; ends the current wait. */
    wake() {
      pending = true;
      resolveCurrent?.();
    },
    /** Consume a pending wake before reading, so a wake during the read is not lost. */
    consume() {
      pending = false;
    },
    wait(ms: number): Promise<void> {
      if (pending || signal.aborted) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolveCurrent = undefined;
          resolve();
        };
        const timer = setTimeout(done, ms);
        signal.addEventListener("abort", done, { once: true });
        resolveCurrent = done;
      });
    },
  };
}

interface StreamPlan {
  deps: AppDeps;
  scoped: ScopedDb;
  runId: RunId;
  after: number;
  filters: Filters;
  fanout: EventFanout | undefined;
  log: AppEnv["Variables"]["log"];
}

function sseResponse(plan: StreamPlan, requestSignal: AbortSignal): Response {
  const abort = new AbortController();
  const onRequestAbort = () => abort.abort();
  requestSignal.addEventListener("abort", onRequestAbort, { once: true });
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string) => {
        if (!abort.signal.aborted) controller.enqueue(encoder.encode(text));
      };
      void pump(plan, write, abort.signal)
        .catch((err: unknown) => {
          if (!abort.signal.aborted)
            plan.log.warn({ err, runId: plan.runId }, "event stream failed");
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

async function pump(
  plan: StreamPlan,
  write: (text: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const { deps, scoped, runId, filters, fanout } = plan;
  const listen = fanout !== undefined;
  const pollMs = deps.config.EVENTS_POLL_INTERVAL_MS;
  const deadline = listen
    ? Number.POSITIVE_INFINITY
    : Date.now() + deps.config.EVENTS_STREAM_MAX_DURATION_MS;
  let cursor = plan.after;
  let lastWrite = Date.now();
  const w = waiter(signal);
  // Subscribe BEFORE the first read, so a NOTIFY between the read and the wait still wakes us.
  const unsubscribe = fanout?.subscribe(runId, (seq) => {
    if (seq > cursor) w.wake();
  });

  const send = (text: string) => {
    write(text);
    lastWrite = Date.now();
  };

  try {
    send(formatSseFrame({ retry: SSE_RETRY_MS, data: "" }));
    while (!signal.aborted) {
      w.consume();
      // Drain: read the run head first, then events (each statement sees a newer snapshot, so a
      // terminal state seen here has all its earlier events visible to the reads below).
      let head: RunHead | undefined;
      let drained = false;
      while (!signal.aborted && !drained) {
        const page = await scoped.transaction(async (tx) => {
          const h = await runHead(tx, runId);
          const items = h
            ? await readEvents(tx, runId, { after: cursor, limit: STREAM_PAGE, ...filters })
            : [];
          return { h, items };
        });
        head = page.h;
        if (!head) return; // the run was deleted (or the actor lost access): just close
        for (const ev of page.items) {
          send(formatSseFrame({ id: String(ev.seq), data: serializeAnybenchEvent(ev) }));
          cursor = ev.seq;
        }
        drained = page.items.length < STREAM_PAGE;
      }
      if (signal.aborted || !head) return;
      if (isTerminalRunState(head.state)) {
        send(
          formatSseFrame({
            event: "end",
            data: JSON.stringify({
              state: head.state,
              last_seq: Math.max(head.lastSeq, cursor, 0),
            }),
          }),
        );
        return;
      }
      const now = Date.now();
      if (now >= deadline) return; // poll mode: close without `end`; the client resumes by Last-Event-ID
      if (now - lastWrite >= SSE_PING_INTERVAL_MS) send(SSE_PING);
      const untilPing = Math.max(1, SSE_PING_INTERVAL_MS - (Date.now() - lastWrite));
      const step = listen ? LISTEN_FALLBACK_MS : pollMs;
      await w.wait(Math.min(step, untilPing, Math.max(1, deadline - Date.now())));
    }
  } finally {
    unsubscribe?.();
  }
}

export function eventsRoutes(deps: AppDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/:id/events", async (c) => {
    const route = apiRoutes.events.list;
    const parsed = parseRouteRequest(route, rawRequest(c));
    if (!parsed.ok)
      return errorJson(
        c,
        "validation_failed",
        parsed.error.error.message,
        400,
        parsed.error.error.issues,
      );
    const actor = await actorOf(deps, c);
    if (!actor) return errorJson(c, "unauthorized", "sign in or pass an API key", 401);
    const { params, query } = parsed.request;
    const result = await scopedDb(actor, deps.db).transaction(async (tx) => {
      const head = await runHead(tx, params.id);
      if (!head) return undefined;
      // One extra row tells us whether another page exists.
      const items = await readEvents(tx, params.id, {
        after: query.after,
        limit: query.limit + 1,
        ...filtersOf(query),
      });
      return items;
    });
    if (!result) return errorJson(c, "not_found", "run not found", 404);
    const more = result.length > query.limit;
    const items = more ? result.slice(0, query.limit) : result;
    const nextAfter = more ? items[items.length - 1]!.seq : null;
    return c.json(encodeRouteResponse(route, { items, next_after: nextAfter }) as object);
  });

  r.get("/:id/stream", async (c) => {
    const route = apiRoutes.events.stream;
    const parsed = parseRouteRequest(
      route,
      rawRequest(c, { "last-event-id": c.req.header("last-event-id") }),
    );
    if (!parsed.ok)
      return errorJson(
        c,
        "validation_failed",
        parsed.error.error.message,
        400,
        parsed.error.error.issues,
      );
    const actor = await actorOf(deps, c);
    if (!actor) return errorJson(c, "unauthorized", "sign in or pass an API key", 401);
    const { params, query, headers } = parsed.request;
    const scoped = scopedDb(actor, deps.db);
    const head = await scoped.transaction((tx) => runHead(tx, params.id));
    if (!head) return errorJson(c, "not_found", "run not found", 404);

    const fanout = deps.config.EVENTS_STREAM_MODE === "listen" ? deps.eventFanout : undefined;
    return sseResponse(
      {
        deps,
        scoped,
        runId: params.id,
        after: headers["last-event-id"] ?? query.after ?? 0,
        filters: filtersOf(query),
        fanout,
        log: c.get("log"),
      },
      c.req.raw.signal,
    );
  });

  return r;
}
