"use client";
// The eval pipeline (Go, running, scoring, analyzing): every trial is a block that moves between
// stations as its real state changes.
//
//   queue  →  sealed agent computers  ‖ wall ‖  grader (a separate computer)  →  result bins
//
// The agent under test works on its own Naïve computer; the hidden tests live on the grader, a
// different computer behind the wall, so the agent can't see them or game them. A block only moves
// on a trial.phase event, a bay's screen flashes on each real heartbeat, and the bins count gate
// results only (no speed or quality number before the report).
import { useEffect, useMemo, useRef, useState } from "react";
import { fitProjection, iso, slabOf, type Point3, type Projection } from "../../lib/iso/kit";
import { tileTone, type LiveRun, type LiveTrial } from "../../lib/live/model";
import { runningView, TRIAL_STAGE, type LiveTrialCard } from "../../lib/live/phase";
import styles from "./figure.module.css";
import {
  box,
  cornersOf,
  machine,
  paintOrder,
  SolidG,
  solidOf,
  type FigureProps,
  type Part,
  type Tone,
} from "./PhaseFigure";

const W = 780;
const H = 300;

// Stations on the iso grid: the pipeline steps along world x (down-right on screen); each
// station's row (the bays, the wall, the grader's pads, the bins) runs along world y (down-left).
// Everything sits on the floor in its own place, so nothing reads as stacked when it isn't.
const P = (x: number, y: number, z = 0): Point3 => [x, y, z];

const QU = -125;
const QV = -178;
const BAY_U = -125;
const BAY_VS = [-104, -52, 0, 52, 104];
const BAY_K = 0.62;
const WALL_U = -76;
const GU = -24;
const PAD_U = 24;
const BU = 86;
const BINS = { pass: -64, fail: 0, infra: 64 } as const;
type Bin = keyof typeof BINS;

const TOKEN = 9;

// ---- where each trial is --------------------------------------------------------------------

type Spot =
  | { at: "queue"; i: number }
  | { at: "bay"; i: number }
  | { at: "grader"; i: number }
  | { at: "bin"; bin: Bin; i: number };

function slot(spot: Spot): Point3 {
  switch (spot.at) {
    case "queue": {
      const col = spot.i % 4;
      const row = Math.floor(spot.i / 4) % 4;
      const layer = Math.floor(spot.i / 16);
      return P(QU - 21 + col * 14, QV - 21 + row * 14, 2 + layer * 5);
    }
    case "bay": {
      const [x, y] = P(BAY_U, BAY_VS[spot.i]!);
      return [x, y + 2.5 * BAY_K, 13.6 * BAY_K];
    }
    case "grader":
      return P(PAD_U, -44 + (spot.i % 5) * 22, 2 + Math.floor(spot.i / 5) * 5);
    case "bin": {
      const col = spot.i % 3;
      const row = Math.floor(spot.i / 3) % 3;
      const layer = Math.floor(spot.i / 9);
      return P(BU - 14 + col * 14, BINS[spot.bin] - 14 + row * 14, 3 + layer * 5);
    }
  }
}

function tokenTone(t: LiveTrial): Tone {
  const tone = tileTone(t);
  if (tone === "passed") return "pass";
  if (tone === "failed") return "fail";
  if (tone === "infra") return "infra";
  if (tone === "queued" || tone === "cancelled") return "queued";
  const stage = TRIAL_STAGE[t.state];
  return stage === "booting" ? "warm" : stage === "grading" ? "lit" : "live";
}

interface Placed {
  t: LiveTrial;
  spot: Spot;
  tone: Tone;
  shape: number;
}

function place(live: LiveRun, cards: LiveTrialCard[]): Placed[] {
  const bayOf = new Map(cards.map((c, i) => [c.id, i]));
  const n = { queue: 0, grader: 0, pass: 0, fail: 0, infra: 0 };
  const rank = new Map(live.contenders.map((c, i) => [c.id, i]));
  // One stable order (the run's trial order) for the DOM and for slot numbers, so stacks fill
  // bottom-up and back-to-front in paint order, and a block that moves keeps its node (and glides).
  const order = live.trialOrder.map((id) => live.trials[id]!);
  return order.map((t) => {
    const tone = tokenTone(t);
    const shape = Math.min(3, (rank.get(t.contenderId) ?? 0) + 1);
    const bay = bayOf.get(t.id);
    let spot: Spot;
    if (tone === "pass") spot = { at: "bin", bin: "pass", i: n.pass++ };
    else if (tone === "fail") spot = { at: "bin", bin: "fail", i: n.fail++ };
    else if (tone === "infra") spot = { at: "bin", bin: "infra", i: n.infra++ };
    else if (tone === "lit") spot = { at: "grader", i: n.grader++ };
    else if (bay !== undefined) spot = { at: "bay", i: bay };
    else spot = { at: "queue", i: n.queue++ };
    return { t, spot, tone, shape };
  });
}

// ---- geometry -------------------------------------------------------------------------------

function stationParts(): Part[] {
  const parts: Part[] = [];
  const at = (u: number, v: number) => P(u, v);
  const [qx, qy] = at(QU, QV);
  parts.push(box("queue.pallet", qx - 30, qy - 30, 60, 60, 0, 2, "base", { r: 2 }));
  BAY_VS.forEach((v, i) => {
    const [x, y] = at(BAY_U, v);
    parts.push(...machine(`bay.${i}`, x, y, "dim", null, BAY_K));
  });
  // The wall runs down the screen between the agents' computers and the grader.
  parts.push({
    ...box("wall", 0, 0, 0, 0, 0, 30, "glass"),
    ring: [
      [WALL_U - 1.5, -118],
      [WALL_U + 1.5, -118],
      [WALL_U + 1.5, 118],
      [WALL_U - 1.5, 118],
    ].map(([u, v]) => {
      const [x, y] = P(u!, v!);
      return [x, y] as [number, number];
    }),
  });
  const [gx, gy] = at(GU, 0);
  parts.push(...machine("grader", gx, gy, "dim", null, 1.15));
  for (let i = 0; i < 5; i++) {
    const [x, y] = at(PAD_U, -44 + i * 22);
    parts.push(box(`grader.pad.${i}`, x - 9, y - 9, 18, 18, 0, 2, "base", { r: 1.5 }));
  }
  for (const [bin, v] of Object.entries(BINS)) {
    const [x, y] = at(BU, v);
    parts.push(box(`bin.${bin}`, x - 25, y - 25, 50, 50, 0, 3, "base", { r: 2 }));
  }
  return parts;
}

/** A trial block at the world origin: one slab per setup "worker" (solo 1, Tandem ×3 three). */
function tokenParts(shape: number): Part[] {
  if (shape <= 1) return [box("t", -TOKEN / 2, -TOKEN / 2, TOKEN, TOKEN, 0, 4, "queued", { r: 1 })];
  const h = 3.6 / shape;
  return Array.from({ length: shape }, (_, k) =>
    box(`t${k}`, -TOKEN / 2, -TOKEN / 2, TOKEN, TOKEN, k * (h + 0.4), h, "queued", { r: 1 }),
  );
}

interface Label {
  id: string;
  at: [number, number];
  anchor: "start" | "middle" | "end";
  title: string;
  sub?: string;
  tone?: "live" | "pass" | "fail" | "muted";
  /** Title and sub on one line (the bays' names, so rows don't collide). */
  inline?: boolean;
  /** A big number under the title (bin counts). */
  count?: number;
  /** A leader line from the label to what it names. */
  leader?: [number, number, number, number];
}

// ---- component ------------------------------------------------------------------------------

export function PipelineFigure({ live, view, nowMs, active, onFocus }: FigureProps) {
  const state = view.current.state;
  const v = runningView(live, nowMs, { cap: 5 });
  const placed = place(live, v.live);

  const geo = useMemo(() => {
    const stations = stationParts();
    const extent: Point3[] = [...stations.flatMap(cornersOf), P(QU, QV, 22), P(BU, 0, 24)];
    const fit = fitProjection(extent, W - 440, H - 44, { pad: 4 });
    const proj: Projection = { ...fit, origin: [fit.origin[0] + 318, fit.origin[1] + 36] };
    const solids = new Map(stations.map((p) => [p.id, solidOf(p, proj)]));
    const order = paintOrder(stations, proj);
    const tokens = [1, 2, 3].map((n) =>
      tokenParts(n).map((p) => ({
        part: p,
        s: slabOf({ x: p.x, y: p.y, w: p.w, d: p.d, r: 1 }, p.z, p.h, proj, 4),
      })),
    );
    const o = iso([0, 0, 0], proj);
    const at = (pt: Point3): [number, number] => {
      const [x, y] = iso(pt, proj);
      return [x - o[0], y - o[1]];
    };
    const abs = (pt: Point3) => iso(pt, proj);
    return { solids, order, tokens, at, abs };
  }, []);

  // Where the drawing lands inside its box (preserveAspectRatio "meet"), for the HTML labels.
  const wrap = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ s: number; ox: number; oy: number } | null>(null);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      if (!width || !height) {
        setBox({ s: 1, ox: 0, oy: 0 });
        return;
      }
      const s = Math.min(width / W, height / H);
      setBox({ s, ox: (width - W * s) / 2, oy: (height - H * s) / 2 });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Build in once when the phase begins.
  const fresh = useRef(true);
  useEffect(() => {
    const id = window.setTimeout(() => (fresh.current = false), 1400);
    return () => window.clearTimeout(id);
  }, []);

  const grading = placed.filter((p) => p.spot.at === "grader").length;
  const graderLive = grading > 0 || state === "scoring";
  const counts = { pass: 0, fail: 0, infra: 0 };
  for (const p of placed) if (p.spot.at === "bin") counts[p.spot.bin]++;
  const queued = placed.filter((p) => p.spot.at === "queue").length;
  const gateName =
    live.trialOrder.map((id) => live.trials[id]!.gate?.gate).find(Boolean) ?? "hidden tests";

  const bayTone = (i: number): Tone => {
    const c = v.live[i];
    if (!c) return "dim";
    return c.stage === "booting" ? "warm" : c.stage === "grading" ? "warm" : "live";
  };
  const toneOf = (p: Part): Tone => {
    const bay = /^bay\.(\d)\.screen$/.exec(p.id);
    if (bay) return bayTone(Number(bay[1]));
    if (p.id === "grader.screen") return graderLive ? "live" : "dim";
    return p.tone;
  };
  const beatOf = (p: Part): string | null => {
    const bay = /^bay\.(\d)\.screen$/.exec(p.id);
    if (bay) return v.live[Number(bay[1])]?.heartbeatAt ?? null;
    return null;
  };
  const bayOfPart = (id: string): number | null => {
    const m = /^bay\.(\d)\./.exec(id);
    return m ? Number(m[1]) : null;
  };

  const focus = (
    e: React.MouseEvent,
    target: Parameters<NonNullable<FigureProps["onFocus"]>>[0],
  ) => {
    e.stopPropagation();
    onFocus?.(target, { x: e.clientX, y: e.clientY });
  };

  const setupName = (t: LiveTrial) =>
    live.contenders.find((c) => c.id === t.contenderId)?.name ?? "setup";

  const labels: Label[] = [];
  const q = geo.abs(P(QU + 30, QV - 30, 18));
  labels.push({
    id: "queue",
    at: [q[0] + 6, q[1]],
    anchor: "start",
    title: "QUEUE",
    sub: `${queued} waiting`,
  });
  // Bay names in a column on the left, each with a leader line to its computer.
  const gutter = 304;
  BAY_VS.forEach((bv, i) => {
    const c = v.live[i];
    const [x0, y0] = geo.abs(P(BAY_U - 24 * BAY_K, bv + 18 * BAY_K, 3));
    labels.push({
      id: `bay.${i}`,
      at: [gutter, y0 - 2],
      anchor: "end",
      title: c ? `VM ${c.computerId ? c.computerId.slice(-6) : "starting"}` : `BAY ${i + 1} · IDLE`,
      sub: c ? `${c.setup} · ${c.task} #${c.repeat + 1}` : undefined,
      tone: c ? "live" : "muted",
      inline: true,
      leader: [gutter + 6, y0 - 5, x0 - 3, y0],
    });
  });
  // The wall's and the grader's names sit off the figure on leader lines, clear of the wall.
  const wb = geo.abs(P(WALL_U, 118, 0));
  labels.push({
    id: "wall",
    at: [wb[0] - 8, H - 26],
    anchor: "end",
    title: "SEALED WALL",
    sub: "the agent never sees the hidden tests",
    leader: [wb[0] - 4, H - 29, wb[0], wb[1] + 2],
  });
  const gt = geo.abs(P(GU, 0, 38));
  labels.push({
    id: "grader",
    at: [gt[0] - 34, 20],
    anchor: "end",
    title: "GRADER · SEPARATE COMPUTER",
    sub: `${gateName}${grading ? ` · grading ${grading}` : ""}`,
    tone: graderLive ? "live" : "muted",
    leader: [gt[0] - 30, 17, gt[0], gt[1] - 4],
  });
  (Object.keys(BINS) as Bin[]).forEach((bin) => {
    const [x0, y0] = geo.abs(P(BU + 25, BINS[bin] - 25, 0));
    labels.push({
      id: `bin.${bin}`,
      at: [x0 + 10, y0 + 4],
      anchor: "start",
      title: bin === "pass" ? "PASSED GATE" : bin === "fail" ? "FAILED GATE" : "OURS · NOT BILLED",
      count: counts[bin],
      tone: bin === "pass" ? "pass" : bin === "fail" ? "fail" : "muted",
    });
  });

  return (
    <div className={styles.figWrap} ref={wrap} data-testid="phase-figure" data-phase={state}>
      <svg
        className={styles.fig}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        data-active={active || undefined}
      >
        {geo.order.map((p, i) => {
          const bay = bayOfPart(p.id);
          const card = bay !== null ? v.live[bay] : undefined;
          const clickable = card
            ? { kind: "trial" as const, id: card.id }
            : p.id.startsWith("grader")
              ? { kind: "grader" as const }
              : null;
          const tone = toneOf(p);
          return (
            <g
              key={`${p.id}:${tone}`}
              className={clickable ? styles.hit : undefined}
              onClick={clickable ? (e) => focus(e, clickable) : undefined}
            >
              <SolidG
                s={geo.solids.get(p.id)!}
                tone={tone}
                beat={beatOf(p)}
                style={{ "--i": fresh.current ? Math.min(i, 30) : 0 } as React.CSSProperties}
              />
            </g>
          );
        })}

        {placed.map(({ t, spot, tone, shape }) => {
          const [dx, dy] = geo.at(slot(spot));
          return (
            <g
              key={t.id}
              className={styles.token}
              style={{ transform: `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)` }}
              data-at={spot.at}
              data-testid="trial-token"
              data-tone={tone}
              onClick={(e) => focus(e, { kind: "trial", id: t.id })}
            >
              <title>{`${setupName(t)} · ${t.workload} #${t.repeat + 1}: ${t.state}`}</title>
              {/* Remounts when the trial moves on, so it hops into its new station. */}
              <g key={`${spot.at}:${tone}`} className={styles.hop}>
                {geo.tokens[shape - 1]!.map(({ part, s }) => (
                  <SolidG key={part.id} s={s} tone={tone} />
                ))}
              </g>
            </g>
          );
        })}

        {labels.map((l) =>
          l.leader ? (
            <line
              key={l.id}
              className={styles.leader}
              data-tone={l.tone}
              x1={l.leader[0]}
              y1={l.leader[1]}
              x2={l.leader[2]}
              y2={l.leader[3]}
            />
          ) : null,
        )}
      </svg>
      {/* Labels are HTML at a fixed, readable size, pinned to the drawing's coordinates. */}
      {box
        ? labels.map((l) => (
            <div
              key={l.id}
              className={styles.callout}
              data-tone={l.tone}
              data-anchor={l.anchor}
              data-inline={l.inline || undefined}
              style={{ left: box.ox + l.at[0] * box.s, top: box.oy + l.at[1] * box.s }}
            >
              <span className={styles.calloutTitle}>
                {l.title}
                {l.count !== undefined ? <b className={styles.calloutCount}>{l.count}</b> : null}
              </span>
              {l.sub ? <span className={styles.calloutSub}>{l.sub}</span> : null}
            </div>
          ))
        : null}
    </div>
  );
}
