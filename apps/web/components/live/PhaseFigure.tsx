"use client";
// The phase figure: an isometric drawing of what the run is doing now, built with Anatomy's
// projection and solids (lib/iso/kit.ts, MIT). Flat shaded solids, hairline edges, no glows.
//
// Every colour is state, read from the run: a trial tile is orange while that trial runs, green
// when it passed its gate, red when it failed; an image machine stacks one layer per build step
// the server reported; a live trial's screen flashes on each real heartbeat. Nothing here moves
// without an event or a clock, and nothing shows progress the run didn't report.
import type { RunState } from "@anybench/core";
import { memo, useMemo } from "react";
import {
  cylinder,
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
import { envBuildSteps, phaseLog, runningView, type PhaseView } from "../../lib/live/phase";
import styles from "./figure.module.css";

type Tone =
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
  | "ink";

interface Part {
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
}

interface Scene {
  parts: Part[];
  /** Ground-plane routes, drawn dashed and flowing while the phase is live. */
  flows: Point3[][];
}

const W = 520;
const H = 300;

// ---- primitives -----------------------------------------------------------------------------

const box = (
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
function machine(
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

function sceneFor(live: LiveRun, view: PhaseView, nowMs: number): Scene {
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
            beat: i === n - 1 ? lastLine : null,
          },
        ),
      );
      return {
        parts: [box("desk", -26, -30, 46, 56, -3, 3, "base", { r: 2 }), ...sheets, ...agent()],
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
        const y = (i - (n - 1) / 2) * 34;
        parts.push(box(`ped.${i}`, -12, y - 12, 24, 24, 0, 12, "body", { r: 1.5 }));
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
            beat: i === n - 1 ? lastLine : null,
          },
        ),
      );
      return {
        parts: [
          box("tray", -48, -n * 8 - 6, 34, n * 16 + 12, 0, 2, "base", { r: 1.5 }),
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
      (["trial", "scoring"] as const).forEach((name, i) => {
        const img = imgs.find((m) => m.image === name);
        const y = i === 0 ? -32 : 32;
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
        const steps = img?.steps.length ?? 0;
        const expected = steps + (img?.pending.length ?? 0) || 6;
        for (let s = 0; s < expected; s++)
          parts.push(
            box(
              `${name}.layer.${s}`,
              34,
              y - 10,
              22,
              20,
              s * 3,
              2.2,
              s < steps ? (img?.done ? "pass" : "lit") : "queued",
              {
                r: 1,
              },
            ),
          );
        if (!img?.done && img)
          flows.push([
            [26, y, 0],
            [32, y, 0],
          ]);
      });
      return { parts, flows };
    }
    case "proof": {
      const said = lines.length > 0;
      return {
        parts: [
          box("track", -52, -6, 104, 12, -1, 1, "base"),
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
      return { parts, flows: [] };
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

// ---- render ---------------------------------------------------------------------------------

function cornersOf(p: Part): Point3[] {
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

function solidOf(p: Part, proj: Projection): SolidPaths {
  if (p.round) return cylinder(p.x + p.w / 2, p.y + p.d / 2, p.w / 2, p.z, p.h, proj, 40);
  return slabOf({ x: p.x, y: p.y, w: p.w, d: p.d, r: p.r ?? 0.5 }, p.z, p.h, proj, 4);
}

/** The figure's geometry depends only on the layout; tones and beats change per render. */
function layoutKey(scene: Scene) {
  return scene.parts.map((p) => `${p.id}:${p.x},${p.y},${p.w},${p.d},${p.z},${p.h}`).join("|");
}

export const PhaseFigure = memo(function PhaseFigure({
  live,
  view,
  nowMs,
  active,
}: {
  live: LiveRun;
  view: PhaseView;
  nowMs: number;
  active: boolean;
}) {
  const scene = sceneFor(live, view, nowMs);
  const key = layoutKey(scene);
  const geo = useMemo(() => {
    const pts = [...scene.parts.flatMap(cornersOf), ...scene.flows.flat()];
    const proj = fitProjection(pts, W, H, { pad: 14 });
    const solids = new Map(scene.parts.map((p) => [p.id, solidOf(p, proj)]));
    const depth = new Map(
      scene.parts.map((p) => [p.id, depthOf([p.x + p.w / 2, p.y + p.d / 2, p.z + p.h / 2], proj)]),
    );
    const flows = scene.flows.map((f) => pathOf(f.map((pt) => iso(pt, proj))));
    return { solids, depth, flows };
    // Geometry is keyed by layout only; `scene` is rebuilt every render.
  }, [key]);
  const parts = [...scene.parts].sort((a, b) => geo.depth.get(a.id)! - geo.depth.get(b.id)!);

  return (
    <svg
      className={styles.fig}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      data-testid="phase-figure"
      data-phase={view.current.state}
      data-active={active || undefined}
    >
      {geo.flows.map((d, i) => (
        <path key={i} className={styles.flow} d={d} />
      ))}
      {parts.map((p) => {
        const s = geo.solids.get(p.id)!;
        return (
          <g key={p.id} className={styles.solid} data-tone={p.tone}>
            <path className={styles.fill} d={s.fill} />
            {s.shades.map((d, i) =>
              d ? <path key={i} className={styles.shade} data-shade={i} d={d} /> : null,
            )}
            <path className={styles.top} d={s.top} />
            {s.crease ? <path className={styles.crease} d={s.crease} /> : null}
            <path className={styles.edge} d={s.outline} />
            {p.beat ? <path key={p.beat} className={styles.beat} d={s.top} /> : null}
          </g>
        );
      })}
    </svg>
  );
});
