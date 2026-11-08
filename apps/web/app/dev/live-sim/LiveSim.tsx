"use client";
// DEV ONLY (TDM-198): plays test/fixtures/simulator.ts through LiveRunView, only imported by
// page.dev.tsx, which production builds leave out. Events are the simulator's schema-valid
// events; the clock is a real clock scaled by the speed control, so every animation on the page
// is still driven by an event or a clock, exactly as on a real run.
//
// It holds at awaiting_go until Go is pressed (a fake API answers POST /runs/:id/go), and serves
// the TDM-103 report fixture once the run is delivered.
import { type AnybenchEvent, type ApiClient, type RunState } from "@anybench/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LiveRunView } from "../../../components/live/LiveRunPage";
import { createWebApiClient } from "../../../lib/api";
import { LiveApiContext } from "../../../lib/live/client";
import { applyEvents, initLive, STAGES, type LiveRun } from "../../../lib/live/model";
import { tdm103Report } from "../../../test/fixtures/tdm103-report";
import { createDemoRun, type DemoRun } from "../../../test/fixtures/simulator";

type Profile = "tandem" | "demo";
type Override = "needs_human" | "failed" | "cancelled";

const SPEEDS = [1, 4, 16, 64] as const;
const OVERRIDE_REASON: Record<Override, string> = {
  needs_human: "the curated Tandem kit failed its proof (oracle-passes)",
  failed: "Naïve never gave us a computer for the trial image after 5 retries",
  cancelled: "cancelled by you",
};

interface Plan {
  demo: DemoRun;
  t0: number;
  /** Index of the run.state_changed → awaiting_go event, or -1. */
  awaitIdx: number;
}

function planFor(profile: Profile): Plan {
  const demo = createDemoRun({ profile });
  const awaitIdx = demo.timeline.findIndex(
    (e) => e.event.type === "run.state_changed" && e.event.payload.to === "awaiting_go",
  );
  return { demo, t0: Date.parse(demo.snapshot.run.created_at), awaitIdx };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function LiveSim() {
  const [profile, setProfile] = useState<Profile>("tandem");
  const plan = useMemo(() => planFor(profile), [profile]);
  const [speed, setSpeed] = useState<number>(1);
  const [paused, setPaused] = useState(false);
  const [holdForGo, setHoldForGo] = useState(true);
  const [override, setOverride] = useState<Override | null>(null);
  const [live, setLive] = useState<LiveRun>(() => initLive(plan.demo.snapshot));
  const [clock, setClock] = useState(0);

  // Mutable playback state, read by the ticker.
  const sim = useRef({ clock: 0, idx: 0, shift: 0, goPressed: false, live });
  sim.current.live = live;

  /** When event i plays, in sim ms: events after awaiting_go move by the time spent waiting. */
  const effAt = useCallback(
    (i: number) => plan.demo.timeline[i]!.atMs + (i > plan.awaitIdx ? sim.current.shift : 0),
    [plan],
  );
  const stamp = useCallback(
    (i: number): AnybenchEvent => ({
      ...plan.demo.timeline[i]!.event,
      at: new Date(plan.t0 + Math.round(effAt(i))).toISOString(),
    }),
    [plan, effAt],
  );

  /** Play every event due by `sim.clock`, holding at awaiting_go until Go when asked to. */
  const advance = useCallback(
    (base: LiveRun): LiveRun => {
      const s = sim.current;
      const due: AnybenchEvent[] = [];
      const tl = plan.demo.timeline;
      while (s.idx < tl.length) {
        if (s.idx === plan.awaitIdx + 1 && holdForGo && !s.goPressed) {
          // Waiting for Go: the rest of the run slides later with the clock.
          s.shift = Math.max(s.shift, s.clock - tl[s.idx]!.atMs);
          break;
        }
        if (effAt(s.idx) > s.clock) break;
        due.push(stamp(s.idx));
        s.idx++;
      }
      return due.length ? applyEvents(base, due) : base;
    },
    [plan, holdForGo, effAt, stamp],
  );

  /** Rebuild from the snapshot up to `toMs` (jump, restart, profile change, clear override). */
  const rebuild = useCallback(
    (toMs: number, goPressed: boolean) => {
      sim.current = { clock: toMs, idx: 0, shift: 0, goPressed, live: sim.current.live };
      const next = advance(initLive(plan.demo.snapshot));
      setLive(next);
      setClock(toMs);
    },
    [plan, advance],
  );

  useEffect(() => {
    setOverride(null);
    rebuild(0, false);
    // A new profile is a new run.
  }, [plan]);

  // The ticker: a real clock scaled by the speed.
  useEffect(() => {
    if (paused || override) return;
    let last = performance.now();
    const id = window.setInterval(() => {
      const now = performance.now();
      sim.current.clock += (now - last) * speed;
      last = now;
      const next = advance(sim.current.live);
      if (next !== sim.current.live) setLive(next);
      setClock(sim.current.clock);
    }, 100);
    return () => window.clearInterval(id);
  }, [paused, override, speed, advance]);

  const jumpTo = (state: RunState) => {
    setOverride(null);
    const i = plan.demo.timeline.findIndex(
      (e) => e.event.type === "run.state_changed" && e.event.payload.to === state,
    );
    const at = i < 0 ? 0 : plan.demo.timeline[i]!.atMs + 1;
    rebuild(at, i > plan.awaitIdx);
  };

  const applyOverride = (o: Override) => {
    setOverride(o);
    const cur = sim.current.live;
    const ev = {
      type: "run.state_changed",
      source: "run",
      source_id: cur.runId,
      severity: o === "failed" ? "error" : "warn",
      actor: { kind: "system" },
      cost_delta_micro_usd: 0n,
      run_id: cur.runId,
      seq: cur.lastSeq + 1,
      at: new Date(plan.t0 + Math.round(sim.current.clock)).toISOString(),
      payload: { from: cur.state, to: o, reason: OVERRIDE_REASON[o] },
    } as AnybenchEvent;
    setLive(applyEvents(cur, [ev]));
  };
  const clearOverride = () => {
    setOverride(null);
    rebuild(sim.current.clock, sim.current.goPressed);
  };

  // The fake API: Go resumes the hold; the report appears once the run is delivered.
  const client = useMemo<ApiClient>(
    () =>
      createWebApiClient("http://sim.local", {
        fetch: async (url, init) => {
          const path = new URL(url).pathname;
          const method = (init?.method ?? "GET").toUpperCase();
          const run = sim.current.live;
          if (method === "POST" && path.endsWith("/go")) {
            sim.current.goPressed = true;
            const now = new Date().toISOString();
            return json(200, {
              run: {
                id: run.runId,
                project_id: null,
                question: run.question,
                state: "running",
                budget_micro_usd: String(run.budgetMicroUsd),
                spent_micro_usd: String(run.spentMicroUsd),
                estimate_micro_usd:
                  run.estimateMicroUsd === null ? null : String(run.estimateMicroUsd),
                kit_id: null,
                paused_reason: null,
                cancel_requested_at: null,
                comped: true,
                created_at: run.createdAt,
                updated_at: now,
              },
            });
          }
          if (path.endsWith("/report") && run.state === "delivered")
            return json(200, { report: tdm103Report({ run_id: run.runId }) });
          return json(404, { error: { code: "not_found", message: "simulated: not here" } });
        },
      }),
    [],
  );

  const ended = ["delivered", "failed", "cancelled"].includes(live.state);
  const pct = Math.min(100, (clock / (plan.demo.durationMs + sim.current.shift)) * 100);

  return (
    <LiveApiContext.Provider value={client}>
      {/* The live page leaves room for this bar at the bottom of its monitor layout. */}
      <style>{":root{--sim-bar:44px}"}</style>
      <div
        role="toolbar"
        aria-label="Simulator controls"
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 90,
          opacity: 0.92,
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          alignItems: "center",
          padding: "8px 16px",
          background: "var(--surface-2)",
          borderTop: "1px solid var(--line)",
          font: "12px var(--font-mono, ui-monospace)",
          color: "var(--muted)",
        }}
      >
        <strong style={{ color: "var(--accent-ink)" }}>SIMULATED</strong>
        <select
          aria-label="Profile"
          value={profile}
          onChange={(e) => setProfile(e.target.value as Profile)}
        >
          <option value="tandem">tandem (real shape)</option>
          <option value="demo">demo (60 trials)</option>
        </select>
        <button type="button" onClick={() => setPaused((p) => !p)}>
          {paused ? "play" : "pause"}
        </button>
        {SPEEDS.map((s) => (
          <button key={s} type="button" aria-pressed={speed === s} onClick={() => setSpeed(s)}>
            {s}×
          </button>
        ))}
        <select
          aria-label="Jump to phase"
          value=""
          onChange={(e) => e.target.value && jumpTo(e.target.value as RunState)}
        >
          <option value="">jump to…</option>
          {STAGES.map((s) => (
            <option key={s.state} value={s.state}>
              {s.label}
            </option>
          ))}
        </select>
        <label>
          <input
            type="checkbox"
            checked={holdForGo}
            onChange={(e) => setHoldForGo(e.target.checked)}
          />{" "}
          wait for Go
        </label>
        {(["needs_human", "failed", "cancelled"] as const).map((o) => (
          <button
            key={o}
            type="button"
            aria-pressed={override === o}
            onClick={() => applyOverride(o)}
          >
            {o}
          </button>
        ))}
        {override ? (
          <button type="button" onClick={clearOverride}>
            clear
          </button>
        ) : null}
        <span className="num">
          {live.state} · seq {live.lastSeq} · {pct.toFixed(0)}%
        </span>
      </div>
      <LiveRunView live={live} status={ended ? "ended" : "live"} clockMs={plan.t0 + clock} />
    </LiveApiContext.Provider>
  );
}
