"use client";
// The phase figure: an isometric drawing of what the run is doing now, built with Anatomy's
// projection and solids (lib/iso/kit.ts, MIT). Flat shaded solids, hairline edges, no glows.
//
// Every colour is state, read from the run: a trial tile is orange while that trial runs, green
// when it passed its gate, red when it failed; an image machine stacks one layer per build step
// the server reported; a live trial's screen flashes on each real heartbeat. Nothing here moves
// without an event or a clock, and nothing shows progress the run didn't report.
import type { RunState } from "@anybench/core";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  cylinder,
  extrude,
  depthOf,
  fitProjection,
  iso,
  pathOf,
  slabOf,
  type Point3,
  type Projection,
  type SolidPaths,
} from "../../lib/iso/kit";
import { tileTone, type LiveRun } from "../../lib/live/model";
import {
  envBuildSteps,
  PHASE_ROLES,
  phaseLog,
  runningView,
  type PhaseView,
} from "../../lib/live/phase";
import styles from "./figure.module.css";
import { PipelineFigure } from "./PipelineFigure";

export type Tone =
  | "base"
  | "body"
  | "dim"
  | "queued"
  | "live"
  | "warm"
  | "pass"
  | "fail"
  | "infra"
  | "lit"
  | "retry"
  | "ink"
  | "glass";

export interface Part {
  id: string;
  x: number;
  y: number;
  w: number;
  d: number;
  z: number;
  h: number;
  tone: Tone;
  r?: number;
  /** A cylinder of radius w/2 instead of a slab. */
  round?: boolean;
  /** Changes on each real event that should flash this part (a heartbeat, a new line). */
  beat?: string | null;
  /** The trial this tile stands for. */
  trial?: string;
  /** Paint layer: lower layers paint first. Long parts (a wall) can't be depth-sorted by centre. */
  layer?: number;
  /** A free-form footprint (world x,y ring) instead of an axis-aligned slab. */
  ring?: [number, number][];
}

interface Scene {
  parts: Part[];
  /** Ground-plane routes, drawn dashed and flowing while the phase is live. */
  flows: Point3[][];
  /** Names that sit right above what they name. */
  tags?: Tag[];
}

export interface Tag {
  id: string;
  at: Point3;
  title: string;
  sub?: string;
  tone?: "live" | "pass" | "fail" | "muted";
}

/** Where a viewBox drawing lands inside its box (preserveAspectRatio "meet"), for HTML labels. */
export function useFigureBox(w: number, h: number) {
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
      const s = Math.min(width / w, height / h);
      setBox({ s, ox: (width - w * s) / 2, oy: (height - h * s) / 2 });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [w, h]);
  return { wrap, box };
}

const W = 520;
const H = 300;

// ---- primitives -----------------------------------------------------------------------------

export const box = (
  id: string,
  x: number,
  y: number,
  w: number,
  d: number,
  z: number,
  h: number,
  tone: Tone,
  extra: Partial<Part> = {},
): Part => ({ id, x, y, w, d, z, h, tone, ...extra });

/** A workstation: plinth, body, a standing display facing the viewer, a key deck. `k` scales it. */
export function machine(
  id: string,
  x: number,
  y: number,
  screen: Tone,
  beat?: string | null,
  k = 1,
): Part[] {
  const b = (
    n: string,
    dx: number,
    dy: number,
    w: number,
    d: number,
    z: number,
    h: number,
    tone: Tone,
    extra: Partial<Part> = {},
  ) => box(`${id}.${n}`, x + dx * k, y + dy * k, w * k, d * k, z * k, h * k, tone, extra);
  return [
    b("plinth", -24, -18, 48, 36, 0, 3, "base", { r: 2 * k }),
    b("body", -18, -13, 36, 26, 3, 9, "body", { r: 1.5 * k }),
    b("frame", -16, -15, 32, 4, 12, 21, "body", { r: k }),
    b("screen", -14, -11.2, 28, 0.8, 14.5, 16, screen, { beat }),
    b("keys", -13, -4, 26, 13, 12, 1.2, "ink", { r: k }),
  ];
}

/** The run's trials as tiles: setups along y, tasks (blocks of repeats) along x. */
function trialTiles(live: LiveRun, x0: number, y0: number): Part[] {
  const size = 7;
  const gap = 2.4;
  const blockGap = 6;
  const parts: Part[] = [];
  const reps = Math.max(1, live.repeats);
  live.contenders.forEach((c, row) => {
    live.workloads.forEach((w, block) => {
      for (let r = 0; r < reps; r++) {
        const t = live.trialOrder
          .map((id) => live.trials[id]!)
          .find((x) => x.contenderId === c.id && x.workload === w && x.repeat === r);
        const tone: Tone = !t
          ? "dim"
          : (
              {
                queued: "queued",
                active: "live",
                passed: "pass",
                failed: "fail",
                infra: "infra",
                cancelled: "dim",
              } as const
            )[tileTone(t)];
        const x = x0 + block * (reps * (size + gap) + blockGap) + r * (size + gap);
        const y = y0 + row * (size + gap + 3);
        parts.push(
          box(`tile.${c.id}.${w}.${r}`, x, y, size, size, 0, tone === "live" ? 3.2 : 1.8, tone, {
            r: 0.8,
            beat: t && tone === "live" ? t.heartbeatAt : null,
            ...(t ? { trial: t.id } : {}),
          }),
        );
      }
    });
  });
  return parts;
}

function gate(id: string, x: number, y: number, span: number): Part[] {
  return [
    box(`${id}.l`, x - 2, y - span / 2 - 2, 4, 4, 0, 26, "body"),
    box(`${id}.r`, x - 2, y + span / 2 - 2, 4, 4, 0, 26, "body"),
    box(`${id}.top`, x - 2.5, y - span / 2 - 2.5, 5, span + 5, 26, 3.5, "body"),
  ];
}

// ---- scenes ---------------------------------------------------------------------------------

function sceneParts(live: LiveRun, view: PhaseView, nowMs: number): Scene {
  const state: RunState = view.current.state;
  const lines = phaseLog(live, state);
  const lastLine = lines.length ? String(lines[lines.length - 1]!.seq) : null;
  const agentScreen: Tone = lines.length ? "live" : "warm";
  const agentAt: [number, number] = [70, 0];
  const agent = () => machine("agent", agentAt[0], agentAt[1], agentScreen, lastLine);

  if (view.hold) {
    const tone: Tone =
      view.hold.state === "failed" ? "fail" : view.hold.state === "cancelled" ? "dim" : "retry";
    return { parts: machine("held", 0, 0, tone), flows: [] };
  }

  switch (state) {
    case "intake":
    case "understand": {
      // The repo: a stack of sheets; the top sheet lifts on each new line the agent writes.
      const n = 5;
      const sheets = Array.from({ length: n }, (_, i) =>
        box(
          `sheet.${i}`,
          -18 + i * 0.8,
          -22 + i * 0.8,
          30,
          40,
          i * 2.4,
          1.4,
          i === n - 1 ? "lit" : "body",
          {
            r: 1,
            beat: lastLine,
          },
        ),
      );
      return {
        parts: [
          box("desk", -26, -30, 46, 56, -3, 3, "base", { r: 2, layer: -1 }),
          ...sheets,
          ...agent(),
        ],
        flows: [
          [
            [4, 0, 0],
            [46, 0, 0],
          ],
        ],
      };
    }
    case "research": {
      const n = Math.max(2, Math.min(4, live.contenders.filter((c) => c.id !== "unplaced").length));
      const parts: Part[] = [];
      const flows: Point3[][] = [];
      for (let i = 0; i < n; i++) {
        const y = (i - (n - 1) / 2) * 46;
        parts.push(box(`ped.${i}.base`, -12, y - 12, 24, 24, 0, 12, "body", { r: 1.5 }));
        parts.push(
          box(`ped.${i}.top`, -8, y - 8, 16, 16, 12, 10, lines.length ? "lit" : "queued", { r: 1 }),
        );
        flows.push([
          [46, 0, 0],
          [24, y, 0],
          [12, y, 0],
        ]);
      }
      return { parts: [...parts, ...agent()], flows };
    }
    case "kit_draft": {
      const n = Math.max(
        1,
        Math.min(5, live.workloads.filter((w) => w !== "unplaced").length || 3),
      );
      const cards = Array.from({ length: n }, (_, i) =>
        box(
          `card.${i}`,
          -42,
          (i - (n - 1) / 2) * 16 - 6,
          22,
          12,
          2,
          1.4,
          lines.length ? "lit" : "queued",
          {
            r: 0.8,
            beat: lastLine,
          },
        ),
      );
      return {
        parts: [
          box("tray", -48, -n * 8 - 6, 34, n * 16 + 12, 0, 2, "base", { r: 1.5, layer: -1 }),
          ...cards,
          ...gate("gate", 4, 0, 40),
          ...agent(),
        ],
        flows: [
          [
            [46, 0, 0],
            [-12, 0, 0],
          ],
        ],
      };
    }
    case "env_build": {
      // One machine per image; one layer per build step the server reported.
      const imgs = envBuildSteps(live);
      const parts: Part[] = [];
      const flows: Point3[][] = [];
      const tags: Tag[] = [];
      (["trial", "scoring"] as const).forEach((name, i) => {
        const img = imgs.find((m) => m.image === name);
        const y = i === 0 ? -32 : 32;
        const last = img?.steps[img.steps.length - 1];
        tags.push({
          id: name,
          at: [0, y - 13, 36],
          title: name === "trial" ? "TRIAL IMAGE" : "SCORING IMAGE",
          sub: !img
            ? "not started"
            : img.done
              ? `ready · ${img.steps.length} steps · snapshot saved`
              : `${img.steps.length} of ${img.steps.length + img.pending.length} steps · ${
                  img.retrying ? "waiting on Naïve" : (last?.label ?? "booting")
                }`,
          tone: !img ? "muted" : img.done ? "pass" : "live",
        });
        const screen: Tone = !img
          ? "dim"
          : img.done
            ? "pass"
            : img.retrying
              ? "retry"
              : img.steps.length
                ? "live"
                : "warm";
        parts.push(...machine(name, 0, y, screen, img?.lastAt));
      });
      return { parts, flows, tags };
    }
    case "proof": {
      const said = lines.length > 0;
      return {
        parts: [
          box("track", -52, -6, 104, 12, -1, 1, "base", { layer: -1 }),
          ...gate("gate", 0, 0, 30),
          box("right", 22, -6, 16, 12, 0, 6, said ? "pass" : "queued", { r: 1 }),
          box("wrong", -38, -6, 16, 12, 0, 6, said ? "fail" : "queued", { r: 1 }),
        ],
        flows: [
          [
            [-50, 0, 0],
            [50, 0, 0],
          ],
        ],
      };
    }
    case "awaiting_go": {
      const tiles = trialTiles(live, -60, -60);
      return {
        parts: [
          ...tiles,
          box("go.plinth", 34, 10, 44, 44, 0, 6, "base", { r: 4 }),
          box("go.button", 42, 18, 28, 28, 6, 8, "lit", { round: true }),
        ],
        flows: [],
      };
    }
    case "running": {
      // The live trials' computers in front, every trial as a tile behind.
      const v = runningView(live, nowMs);
      const slots = 5;
      const parts: Part[] = trialTiles(live, -70, -40);
      for (let i = 0; i < slots; i++) {
        const c = v.live[i];
        const tone: Tone = !c ? "dim" : c.stage === "booting" ? "warm" : "live";
        parts.push(...machine(`slot.${i}`, -76 + i * 40, 58, tone, c?.heartbeatAt ?? null, 0.78));
      }
      // Each live computer's route to the tile of the trial it is running.
      const flows: Point3[][] = [];
      v.live.slice(0, slots).forEach((c, i) => {
        const tile = parts.find((p) => p.trial === c.id);
        if (!tile) return;
        const mx = -76 + i * 40;
        const ty = tile.y + tile.d / 2;
        flows.push([
          [mx, 58 - 16, 0],
          [mx, ty + 14, 0],
          [tile.x + tile.w / 2, ty + 14, 0],
          [tile.x + tile.w / 2, ty, 0],
        ]);
      });
      return { parts, flows };
    }
    case "scoring":
    case "analyzing":
    case "delivered":
      return {
        parts: [...trialTiles(live, -60, -40), ...machine("agent", 90, 30, agentScreen, lastLine)],
        flows: [
          [
            [60, 30, 0],
            [70, 30, 0],
          ],
        ],
      };
    default:
      return { parts: agent(), flows: [] };
  }
}

const ROLE_WORD: Record<string, string> = {
  understander: "UNDERSTANDER",
  researcher: "RESEARCHER",
  kit_designer: "KIT DESIGNER",
  "kit designer": "KIT DESIGNER",
  intake: "INTAKE",
  proof: "PROOF",
  verifier: "PROOF",
  analyst: "ANALYST",
  investigator: "INVESTIGATOR",
};

/** The scene plus a name above every thing in it, so each block says what it is. */
function sceneFor(live: LiveRun, view: PhaseView, nowMs: number): Scene {
  const scene = sceneParts(live, view, nowMs);
  const state = view.current.state;
  const tags: Tag[] = [...(scene.tags ?? [])];
  const has = (id: string) => scene.parts.some((p) => p.id === id);
  const lines = phaseLog(live, state);
  if (has("agent.screen")) {
    const role = lines[lines.length - 1]?.role ?? PHASE_ROLES[state]?.[0] ?? "agent";
    tags.push({
      id: "agent",
      at: [70, -13, 38],
      title: ROLE_WORD[role] ?? role.toUpperCase(),
      sub: lines.length ? "an agent on Naïve" : "starting",
      tone: lines.length ? "live" : "muted",
    });
  }
  if (has("sheet.4")) tags.push({ id: "repo", at: [-3, -2, 16], title: "THE REPO", tone: "muted" });
  const setups = live.contenders.filter((c) => c.id !== "unplaced");
  scene.parts
    .filter((p) => /^ped\.\d+\.top$/.test(p.id))
    .forEach((p, i) =>
      tags.push({
        id: p.id,
        at: [p.x + p.w / 2, p.y + p.d / 2, 26],
        title: setups[i]?.name.toUpperCase() ?? `SETUP ${i + 1}`,
        sub: i === 0 ? "baseline" : "contender",
        tone: lines.length ? "live" : "muted",
      }),
    );
  if (has("tray") && state === "kit_draft") {
    const n = live.workloads.filter((w) => w !== "unplaced").length;
    tags.push({ id: "tasks", at: [-31, 0, 8], title: "TASKS", sub: n ? `${n} tasks` : undefined });
  }
  if (has("gate.top"))
    tags.push({
      id: "gate",
      at: [0, 0, 34],
      title: "THE GATE",
      sub: state === "proof" ? "hidden tests decide pass or fail" : "how every answer is checked",
    });
  if (state === "proof") {
    const said = lines.length > 0;
    tags.push({
      id: "right",
      at: [30, 0, 10],
      title: "RIGHT ANSWER",
      sub: "must pass",
      tone: said ? "pass" : "muted",
    });
    tags.push({
      id: "wrong",
      at: [-30, 0, 10],
      title: "WRONG ANSWER",
      sub: "must fail",
      tone: said ? "fail" : "muted",
    });
  }
  return { ...scene, tags };
}

// ---- render ---------------------------------------------------------------------------------

export function cornersOf(p: Part): Point3[] {
  if (p.ring)
    return p.ring.flatMap(([x, y]) => [[x, y, p.z] as Point3, [x, y, p.z + p.h] as Point3]);
  return [
    [p.x, p.y, p.z],
    [p.x + p.w, p.y, p.z],
    [p.x, p.y + p.d, p.z],
    [p.x + p.w, p.y + p.d, p.z],
    [p.x, p.y, p.z + p.h],
    [p.x + p.w, p.y + p.d, p.z + p.h],
    [p.x + p.w, p.y, p.z + p.h],
    [p.x, p.y + p.d, p.z + p.h],
  ];
}

export function solidOf(p: Part, proj: Projection): SolidPaths {
  if (p.ring) return extrude(p.ring, p.z, p.h, proj, { convex: true });
  if (p.round) return cylinder(p.x + p.w / 2, p.y + p.d / 2, p.w / 2, p.z, p.h, proj, 40);
  return slabOf({ x: p.x, y: p.y, w: p.w, d: p.d, r: p.r ?? 0.5 }, p.z, p.h, proj, 4);
}

/** The figure's geometry depends only on the layout; tones and beats change per render. */
function layoutKey(scene: Scene) {
  return scene.parts.map((p) => `${p.id}:${p.x},${p.y},${p.w},${p.d},${p.z},${p.h}`).join("|");
}

/**
 * Painter's order for an isometric scene: a machine (parts sharing an id prefix "name.part")
 * paints as one unit, in the order its parts were built (plinth → body → frame → screen →
 * keys); units paint back to front by their centre's depth.
 */
export function paintOrder(parts: Part[], proj: Projection): Part[] {
  const groupOf = (p: Part) => (p.id.includes(".") ? p.id.slice(0, p.id.lastIndexOf(".")) : p.id);
  const sums = new Map<string, { d: number; n: number }>();
  for (const p of parts) {
    const g = groupOf(p);
    const d = depthOf([p.x + p.w / 2, p.y + p.d / 2, 0], proj);
    const cur = sums.get(g) ?? { d: 0, n: 0 };
    sums.set(g, { d: cur.d + d, n: cur.n + 1 });
  }
  const depth = (p: Part) => {
    const s = sums.get(groupOf(p))!;
    return s.d / s.n;
  };
  return parts
    .map((p, i) => ({ p, i, d: depth(p), l: p.layer ?? 0 }))
    .sort((a, b) => a.l - b.l || a.d - b.d || a.i - b.i)
    .map((x) => x.p);
}

/** One solid: fill, shaded faces, top, edges; a flash and a ripple on each real beat. */
export function SolidG({
  s,
  tone,
  beat,
  style,
}: {
  s: SolidPaths;
  tone: Tone;
  beat?: string | null;
  style?: React.CSSProperties;
}) {
  return (
    <g className={styles.solid} data-tone={tone} style={style}>
      <path className={styles.fill} d={s.fill} />
      {s.shades.map((d, i) =>
        d ? <path key={i} className={styles.shade} data-shade={i} d={d} /> : null,
      )}
      <path className={styles.top} d={s.top} />
      {s.crease ? <path className={styles.crease} d={s.crease} /> : null}
      <path className={styles.edge} d={s.outline} />
      {beat ? <path key={beat} className={styles.beat} d={s.fill} /> : null}
      {beat ? <path key={`ping:${beat}`} className={styles.ping} d={s.fill} /> : null}
    </g>
  );
}

export interface FigureProps {
  live: LiveRun;
  view: PhaseView;
  nowMs: number;
  active: boolean;
  /** A computer, trial or station was clicked: open the inspector from that point. */
  onFocus?: (target: FocusTarget, at: { x: number; y: number }) => void;
}

export type FocusTarget = { kind: "trial"; id: string } | { kind: "grader" };

/** Phases shown as the eval pipeline (queue → sealed agent computers → grader → bins). */
const PIPELINE: readonly RunState[] = ["awaiting_go", "running", "scoring", "analyzing"];

export const PhaseFigure = memo(function PhaseFigure(props: FigureProps) {
  return PIPELINE.includes(props.view.current.state) && !props.view.hold ? (
    <PipelineFigure {...props} />
  ) : (
    <SceneFigure {...props} />
  );
});

function SceneFigure({ live, view, nowMs, active }: FigureProps) {
  const scene = sceneFor(live, view, nowMs);
  const key = layoutKey(scene);
  const geo = useMemo(() => {
    const pts = [...scene.parts.flatMap(cornersOf), ...scene.flows.flat()];
    const proj = fitProjection(pts, W, H, { pad: 14 });
    const solids = new Map(scene.parts.map((p) => [p.id, solidOf(p, proj)]));
    const order = paintOrder(scene.parts, proj).map((p) => p.id);
    const flows = scene.flows.map((f) => pathOf(f.map((pt) => iso(pt, proj))));
    return { solids, order, flows, proj };
    // Geometry is keyed by layout only; `scene` is rebuilt every render.
  }, [key]);
  const byId = new Map(scene.parts.map((p) => [p.id, p]));
  const parts = geo.order.map((id) => byId.get(id)!).filter(Boolean);
  // The figure builds in once when its phase begins; after that, only state changes move it.
  const fresh = useRef(true);
  useEffect(() => {
    const id = window.setTimeout(() => (fresh.current = false), 1200);
    return () => window.clearTimeout(id);
  }, []);

  const { wrap, box: fit } = useFigureBox(W, H);

  return (
    <div
      className={styles.figWrap}
      ref={wrap}
      data-testid="phase-figure"
      data-phase={view.current.state}
    >
      <svg
        className={styles.fig}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        data-active={active || undefined}
      >
        {geo.flows.map((d, i) => (
          <path key={i} className={styles.flow} d={d} />
        ))}
        {parts.map((p, i) => {
          const s = geo.solids.get(p.id)!;
          return (
            <SolidG
              key={`${p.id}:${p.tone}`}
              s={s}
              tone={p.tone}
              beat={p.beat}
              style={{ "--i": fresh.current ? Math.min(i, 40) : 0 } as React.CSSProperties}
            />
          );
        })}
      </svg>
      {fit
        ? (scene.tags ?? []).map((t) => {
            const [x, y] = iso(t.at, geo.proj);
            return (
              <div
                key={t.id}
                className={styles.callout}
                data-anchor="above"
                data-tone={t.tone}
                style={{ left: fit.ox + x * fit.s, top: fit.oy + y * fit.s }}
              >
                <span className={styles.calloutTitle}>{t.title}</span>
                {t.sub ? <span className={styles.calloutSub}>{t.sub}</span> : null}
              </div>
            );
          })
        : null}
    </div>
  );
}
