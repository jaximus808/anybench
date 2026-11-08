"use client";
// The live run page's data hook (TDM-75): runs.get + trials.list + runs.contenders, recent history
// from events.list, then GET /runs/:id/stream (SSE).
//
// Resume is by the Last-Event-ID header: every (re)connect sends the highest seq seen, so the
// server replays only what was missed and the reducer drops anything it already has. The core
// client reconnects on its own when a stream closes without an `end` frame (function max
// duration); this hook also reconnects, with backoff up to 30 s, when the connection fails, and
// stops on a fatal answer (401/403/404, a contract violation).
//
// The snapshot needs only runs.get: trials.list, runs.contenders and events.list are optional, so
// the page still works against an API that hasn't shipped them yet (trials then appear from the
// stream, unplaced). Agent sessions and alert ids are re-read with runs.get when the run changes
// state and every 20 s. Events are buffered and folded every frame, so a burst renders once.
import {
  ApiClientError,
  apiRoutes,
  EVENTS_PAGE_LIMIT_MAX,
  type AnybenchEvent,
  type ApiClient,
  type RunContender,
  type RunId,
  type Trial,
} from "@anybench/core";
import { useEffect, useRef, useState } from "react";
import { useLiveApi } from "./client";
import {
  applyEvents,
  initLive,
  mergeAgents,
  mergeAlerts,
  mergeTrials,
  seedHistory,
  type LiveRun,
  type LiveSnapshot,
} from "./model";

export type LiveStatus = "loading" | "live" | "reconnecting" | "ended" | "error";

export interface LiveHandle {
  live: LiveRun | null;
  status: LiveStatus;
  /** A customer-facing description of the current problem, or null. */
  error: string | null;
}

export interface UseLiveRunOptions {
  /** First reconnect delay in ms; doubles up to 30 s. */
  reconnectDelayMs?: number;
  /** How often to re-read agent sessions and alerts while the run is live. */
  refreshMs?: number;
  /** How many recent events to load for the feed on open. */
  historyEvents?: number;
}

const MAX_RECONNECT_MS = 30_000;
const TERMINAL = new Set(["delivered", "failed", "cancelled"]);

/** Words a customer can act on. Never echoes a response body. */
export function describeApiError(e: unknown): string {
  if (e instanceof ApiClientError) {
    if (e.status === 401) return "Sign in to see this run.";
    if (e.status === 403) return "You don't have access to this run.";
    if (e.status === 404) return "This run doesn't exist, or it isn't yours.";
    if (e.code === "contract_violation")
      return "The server sent data this page doesn't understand.";
    if (e.status >= 500) return `The Anybench API had a problem (${e.status}).`;
    return `The Anybench API refused the request (${e.status}).`;
  }
  return "Couldn't reach the Anybench API.";
}

/** Retrying won't help: auth, missing run, a request we built wrong, or a contract mismatch. */
export function isFatalApiError(e: unknown): boolean {
  return (
    e instanceof ApiClientError &&
    (e.code === "contract_violation" ||
      e.status === 0 ||
      (e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429))
  );
}

/** A route this API doesn't have yet (404 on a collection route, 405, 501). */
function isMissingRoute(e: unknown): boolean {
  return e instanceof ApiClientError && [404, 405, 501].includes(e.status);
}

async function optional<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (isMissingRoute(e)) return fallback;
    throw e;
  }
}

async function loadTrials(c: ApiClient, id: RunId, signal: AbortSignal): Promise<Trial[]> {
  const out: Trial[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const res = await c.call(
      apiRoutes.trials.list,
      { params: { id }, query: { limit: 200, ...(cursor ? { cursor } : {}) } },
      { signal },
    );
    out.push(...res.items);
    if (!res.next_cursor) break;
    cursor = res.next_cursor;
  }
  return out;
}

async function loadSnapshot(c: ApiClient, id: RunId, signal: AbortSignal): Promise<LiveSnapshot> {
  const [detail, contenders, trials] = await Promise.all([
    c.call(apiRoutes.runs.get, { params: { id } }, { signal }),
    optional(
      c.call(apiRoutes.runs.contenders, { params: { id } }, { signal }).then((r) => r.items),
      [] as RunContender[],
    ),
    optional(loadTrials(c, id, signal), [] as Trial[]),
  ]);
  return {
    run: detail.run,
    contenders: contenders
      .filter((x) => x.status === "kept")
      .map((x) => ({ id: x.id, name: x.name })),
    trials,
    agents: detail.agents,
    alerts: detail.open_alerts,
    lastSeq: detail.counters.last_seq,
  };
}

/** Feed history and stage history from before the snapshot. Best effort. */
async function loadHistory(
  c: ApiClient,
  id: RunId,
  lastSeq: number,
  recent: number,
  signal: AbortSignal,
): Promise<AnybenchEvent[]> {
  if (lastSeq === 0) return [];
  const page = async (after: number, limit: number, types?: AnybenchEvent["type"][]) => {
    const out: AnybenchEvent[] = [];
    let cursor: number | null = after;
    for (let i = 0; i < 20 && cursor !== null && cursor < lastSeq; i++) {
      const r: { items: AnybenchEvent[]; next_after: number | null } = await c.call(
        apiRoutes.events.list,
        { params: { id }, query: { after: cursor, limit, ...(types ? { types } : {}) } },
        { signal },
      );
      out.push(...r.items.filter((e) => e.seq <= lastSeq));
      cursor = r.next_after;
    }
    return out;
  };
  try {
    const [skeleton, tail] = await Promise.all([
      // Every phase change and stage change (places trials when trials.list is missing).
      page(0, EVENTS_PAGE_LIMIT_MAX, ["run.state_changed", "trial.phase"]),
      // The most recent events of every kind, for the feed.
      page(Math.max(0, lastSeq - recent), Math.min(recent, EVENTS_PAGE_LIMIT_MAX)),
    ]);
    const bySeq = new Map<number, AnybenchEvent>();
    for (const e of [...skeleton, ...tail]) bySeq.set(e.seq, e);
    return [...bySeq.values()];
  } catch (e) {
    if (signal.aborted) return [];
    void e; // history is a nicety; the live view works without it
    return [];
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

export function useLiveRun(runId: string, opts: UseLiveRunOptions = {}): LiveHandle {
  const { reconnectDelayMs = 1000, refreshMs = 20_000, historyEvents = 500 } = opts;
  const client = useLiveApi();
  const [live, setLive] = useState<LiveRun | null>(null);
  const [status, setStatus] = useState<LiveStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const buffer = useRef<AnybenchEvent[]>([]);
  const liveRef = useRef<LiveRun | null>(null);
  liveRef.current = live;

  // Flush the buffer once per animation frame.
  useEffect(() => {
    // requestAnimationFrame when there is one (jsdom may not have it).
    const raf =
      typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame.bind(window)
        : (cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 50);
    const caf =
      typeof window.cancelAnimationFrame === "function"
        ? window.cancelAnimationFrame.bind(window)
        : window.clearTimeout.bind(window);
    let handle = 0;
    const tick = () => {
      if (buffer.current.length) {
        const batch = buffer.current;
        buffer.current = [];
        setLive((prev) => (prev ? applyEvents(prev, batch) : prev));
      }
      handle = raf(tick);
    };
    handle = raf(tick);
    return () => caf(handle);
  }, []);

  // Snapshot, history, then SSE with resume.
  useEffect(() => {
    const ctrl = new AbortController();
    const { signal } = ctrl;
    const id = runId as RunId;
    let lastSeen = 0;
    let refreshing = false;

    // Agent statuses and alert ids from runs.get (runs.agents may not exist yet).
    const refresh = async () => {
      if (refreshing || signal.aborted) return;
      refreshing = true;
      try {
        const detail = await client.call(apiRoutes.runs.get, { params: { id } }, { signal });
        if (!signal.aborted)
          setLive((prev) =>
            prev ? mergeAlerts(mergeAgents(prev, detail.agents), detail.open_alerts) : prev,
          );
      } catch {
        // Keep what we have; the next refresh tries again.
      } finally {
        refreshing = false;
      }
    };
    const timer = window.setInterval(() => {
      const cur = liveRef.current;
      if (cur && !TERMINAL.has(cur.state)) void refresh();
    }, refreshMs);

    (async () => {
      // 1. Snapshot (retried until it loads or fails for good).
      let wait = reconnectDelayMs;
      let snap: LiveSnapshot | null = null;
      while (!snap) {
        try {
          snap = await loadSnapshot(client, id, signal);
        } catch (e) {
          if (signal.aborted) return;
          setError(describeApiError(e));
          if (isFatalApiError(e)) {
            setStatus("error");
            return;
          }
          setStatus("reconnecting");
          await delay(wait, signal);
          if (signal.aborted) return;
          wait = Math.min(wait * 2, MAX_RECONNECT_MS);
        }
      }
      lastSeen = snap.lastSeq;
      setLive(initLive(snap));
      setError(null);
      setStatus("live");
      void loadHistory(client, id, snap.lastSeq, historyEvents, signal).then((events) => {
        if (!signal.aborted && events.length)
          setLive((prev) => (prev ? seedHistory(prev, events) : prev));
      });

      // 2. The stream, resuming after the highest seq seen.
      wait = reconnectDelayMs;
      for (;;) {
        try {
          const stream = client.stream(
            apiRoutes.events.stream,
            { params: { id } },
            { lastEventId: lastSeen, signal },
          );
          setStatus("live");
          for (;;) {
            const r = await stream.next();
            if (r.done) {
              if (r.value !== undefined) {
                setStatus("ended");
                void refresh();
                return;
              }
              if (signal.aborted) return;
              break;
            }
            const ev = r.value;
            if (ev.seq > lastSeen) lastSeen = ev.seq;
            buffer.current.push(ev);
            wait = reconnectDelayMs;
            setError(null);
            if (ev.type === "run.state_changed") void refresh();
          }
        } catch (e) {
          if (signal.aborted) return;
          if (isFatalApiError(e)) {
            setError(describeApiError(e));
            setStatus("error");
            return;
          }
          setError("Connection lost. Reconnecting from the last event…");
        }
        setStatus("reconnecting");
        await delay(wait, signal);
        if (signal.aborted) return;
        wait = Math.min(wait * 2, MAX_RECONNECT_MS);
      }
    })();

    return () => {
      ctrl.abort();
      window.clearInterval(timer);
    };
  }, [runId, client, reconnectDelayMs, refreshMs, historyEvents]);

  // Trials that appeared after the snapshot (or that the stream couldn't place).
  const refreshingTrials = useRef(false);
  const trialsBackoffUntil = useRef(0);
  useEffect(() => {
    if (!live?.needsTrialRefresh || refreshingTrials.current) return;
    if (Date.now() < trialsBackoffUntil.current) {
      setLive((prev) => (prev ? { ...prev, needsTrialRefresh: false } : prev));
      return;
    }
    refreshingTrials.current = true;
    const ctrl = new AbortController();
    loadTrials(client, runId as RunId, ctrl.signal)
      .then((list) => setLive((prev) => (prev ? mergeTrials(prev, list) : prev)))
      .catch(() => {
        // trials.list missing or failing: the trial stays in the "not placed yet" row. Back off
        // for 30 s so a busy stream doesn't turn into a request per event.
        trialsBackoffUntil.current = Date.now() + 30_000;
        setLive((prev) => (prev ? { ...prev, needsTrialRefresh: false } : prev));
      })
      .finally(() => {
        refreshingTrials.current = false;
      });
  }, [live?.needsTrialRefresh, runId, client]);

  return { live, status, error };
}
