"use client";
// One hook for the live run page and the landing hero.
//   runId "demo": the simulated run (lib/live/simulator.ts), replayed on a clock.
//   any other id: runs.get + trials.list + runs.contenders, then GET /runs/:id/stream (SSE),
//   resuming after the snapshot's last_seq. Events are buffered and folded every frame, so a
//   burst of hundreds of events renders once.
import { apiRoutes, type AnybenchEvent, type RunId, type Trial } from "@anybench/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { applyEvents, initLive, mergeTrials, type LiveRun, type LiveSnapshot } from "./model";
import { createDemoRun, type DemoOptions } from "./simulator";

export type LiveStatus = "loading" | "live" | "ended" | "error";

export interface LiveHandle {
  live: LiveRun | null;
  status: LiveStatus;
  error: string | null;
  /** Demo only: playback controls. */
  demo: {
    speed: number;
    setSpeed: (s: number) => void;
    paused: boolean;
    setPaused: (p: boolean) => void;
    restart: () => void;
    progress: number;
  } | null;
}

export interface UseLiveRunOptions {
  /** Demo: start this far into the run (0..1), so the page isn't empty on load. */
  startAt?: number;
  /** Demo: restart when it reaches the end (landing hero). */
  loop?: boolean;
  speed?: number;
  demo?: DemoOptions;
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

export function useLiveRun(runId: string, opts: UseLiveRunOptions = {}): LiveHandle {
  const isDemo = runId === "demo";
  const [live, setLive] = useState<LiveRun | null>(null);
  const [status, setStatus] = useState<LiveStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [speed, setSpeed] = useState(opts.speed ?? 1);
  const [paused, setPaused] = useState(false);
  const [progress, setProgress] = useState(0);
  const [epoch, setEpoch] = useState(0);
  const buffer = useRef<AnybenchEvent[]>([]);
  const speedRef = useRef(speed);
  const pausedRef = useRef(paused);
  speedRef.current = speed;
  pausedRef.current = paused;

  const demoOpts = opts.demo;
  const demoRun = useMemo(() => (isDemo ? createDemoRun(demoOpts) : null), [isDemo, demoOpts]);

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

  // Demo playback.
  useEffect(() => {
    if (!demoRun) return;
    const { snapshot, timeline, durationMs } = demoRun;
    const startMs = durationMs * (epoch === 0 ? (opts.startAt ?? 0) : 0);
    let i = 0;
    const pre: AnybenchEvent[] = [];
    while (i < timeline.length && timeline[i]!.atMs <= startMs) pre.push(timeline[i++]!.event);
    buffer.current = [];
    setLive(applyEvents(initLive(snapshot), pre));
    setStatus("live");
    let clock = startMs;
    let last = performance.now();
    const id = window.setInterval(() => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      if (pausedRef.current) return;
      clock += dt * speedRef.current;
      while (i < timeline.length && timeline[i]!.atMs <= clock)
        buffer.current.push(timeline[i++]!.event);
      setProgress(Math.min(1, clock / durationMs));
      if (i >= timeline.length) {
        if (opts.loop && clock > durationMs + 6000) setEpoch((e) => e + 1);
        else if (!opts.loop) setStatus("ended");
      }
    }, 50);
    return () => window.clearInterval(id);
    // opts.startAt / opts.loop are read once per epoch on purpose.
  }, [demoRun, epoch]);

  // Real run: snapshot, then SSE.
  useEffect(() => {
    if (isDemo) return;
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
  }, [isDemo, runId]);

  // Trials that appeared after the snapshot.
  const refreshing = useRef(false);
  useEffect(() => {
    if (isDemo || !live?.needsTrialRefresh || refreshing.current) return;
    refreshing.current = true;
    loadTrials(runId as RunId)
      .then((list) => setLive((prev) => (prev ? mergeTrials(prev, list) : prev)))
      .finally(() => {
        refreshing.current = false;
      });
  }, [isDemo, live?.needsTrialRefresh, runId]);

  const restart = useCallback(() => {
    setPaused(false);
    setEpoch((e) => e + 1);
  }, []);

  return {
    live,
    status,
    error,
    demo: isDemo ? { speed, setSpeed, paused, setPaused, restart, progress } : null,
  };
}
