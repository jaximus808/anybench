"use client";
// The live run page's data hook: runs.get + trials.list + runs.contenders, then
// GET /runs/:id/stream (SSE), resuming after the snapshot's last_seq. Events are buffered and
// folded every frame, so a burst of hundreds of events renders once.
import { apiRoutes, type AnybenchEvent, type RunId, type Trial } from "@anybench/core";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { applyEvents, initLive, mergeTrials, type LiveRun, type LiveSnapshot } from "./model";

export type LiveStatus = "loading" | "live" | "ended" | "error";

export interface LiveHandle {
  live: LiveRun | null;
  status: LiveStatus;
  error: string | null;
}

async function loadSnapshot(id: RunId): Promise<LiveSnapshot> {
  const client = api();
  const [detail, contenders] = await Promise.all([
    client.call(apiRoutes.runs.get, { params: { id } }),
    client.call(apiRoutes.runs.contenders, { params: { id } }),
  ]);
  const trials = await loadTrials(id);
  return {
    run: detail.run,
    contenders: contenders.items
      .filter((c) => c.status === "kept")
      .map((c) => ({ id: c.id, name: c.name })),
    trials,
    agents: detail.agents,
    alerts: detail.open_alerts,
    lastSeq: detail.counters.last_seq,
  };
}

async function loadTrials(id: RunId): Promise<Trial[]> {
  const out: Trial[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const res = await api().call(apiRoutes.trials.list, {
      params: { id },
      query: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    out.push(...res.items);
    if (!res.next_cursor) break;
    cursor = res.next_cursor;
  }
  return out;
}

export function useLiveRun(runId: string): LiveHandle {
  const [live, setLive] = useState<LiveRun | null>(null);
  const [status, setStatus] = useState<LiveStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const buffer = useRef<AnybenchEvent[]>([]);

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

  // Snapshot, then SSE.
  useEffect(() => {
    const ctrl = new AbortController();
    let cancelled = false;
    (async () => {
      try {
        const snap = await loadSnapshot(runId as RunId);
        if (cancelled) return;
        setLive(initLive(snap));
        setStatus("live");
        const stream = api().stream(
          apiRoutes.events.stream,
          { params: { id: runId as RunId }, query: { after: snap.lastSeq } },
          { signal: ctrl.signal },
        );
        for (;;) {
          const r = await stream.next();
          if (r.done) break;
          buffer.current.push(r.value);
        }
        if (!cancelled) setStatus("ended");
      } catch (e) {
        if (cancelled || ctrl.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [runId]);

  // Trials that appeared after the snapshot.
  const refreshing = useRef(false);
  useEffect(() => {
    if (!live?.needsTrialRefresh || refreshing.current) return;
    refreshing.current = true;
    loadTrials(runId as RunId)
      .then((list) => setLive((prev) => (prev ? mergeTrials(prev, list) : prev)))
      .finally(() => {
        refreshing.current = false;
      });
  }, [live?.needsTrialRefresh, runId]);

  return { live, status, error };
}
