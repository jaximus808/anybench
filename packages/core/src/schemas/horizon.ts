// TDM-215 [18.8]: task horizon. A harness built to coordinate several agents (an orchestrator,
// planner + workers, parallel sessions on a task board) earns its keep on long work: a whole
// application across several feature areas, where one session has to compact its context. A kit
// that tests it only on small tasks measures its overhead and never its point (run 01a1bae4: three
// small tasks, the solo agent won). So:
//
//   - the understander records a horizon JUDGEMENT with a rationale (short | mixed | long);
//   - the kit designer's draft records a horizon PLAN: the judgement, and for mixed / long the
//     long-horizon workloads it adds next to the short sanity tasks;
//   - the skeptic's `horizon_mismatch` check flags a coordination-harness kit whose every workload
//     is short (packages/kit skeptic/checks.ts), using the rule below.
//
// The judgement is the model's, argued in its rationale; code only enforces the floor (a subject
// that coordinates agents is never judged `short`) and the mechanical definition of "long".
import { z } from "zod";
import { KitSlugSchema } from "./kit-primitives.js";

/**
 * - `short`: small, self-contained tasks are representative (a CLI, a library, a single agent).
 * - `mixed`: short tasks matter AND the subject claims an edge on long work.
 * - `long`: the subject exists for long, multi-part work (coordinating several agents).
 */
export const TaskHorizonSchema = z.enum(["short", "mixed", "long"]);
export type TaskHorizon = z.infer<typeof TaskHorizonSchema>;

/** The understander's judgement: the horizon and one paragraph of why. */
export const HorizonJudgementSchema = z.strictObject({
  horizon: TaskHorizonSchema,
  rationale: z.string().min(1).max(1_200),
});
export type HorizonJudgement = z.infer<typeof HorizonJudgementSchema>;

/** A workload is long-horizon when its wall cap is at least this (2 h). */
export const LONG_HORIZON_MIN_WALL_S = 7_200;
/** A long-horizon workload spans at least this many feature areas. */
export const LONG_HORIZON_MIN_FEATURE_AREAS = 3;

/** A long-horizon workload as the kit designer plans it (built and graded by later stages). */
export const LongHorizonWorkloadPlanSchema = z.strictObject({
  id: KitSlugSchema,
  title: z.string().min(1).max(200),
  /** The feature areas the task spans, each graded on its own (partial credit). */
  feature_areas: z.array(z.string().min(1).max(120)).min(LONG_HORIZON_MIN_FEATURE_AREAS).max(12),
  /** The workload's wall cap in seconds: at least LONG_HORIZON_MIN_WALL_S. */
  wall_cap_s: z.int().min(LONG_HORIZON_MIN_WALL_S).max(86_400),
  /**
   * `partial-credit`: hidden tests grouped by feature area, the score is the share of areas that
   * pass (a whole-app build is rarely all-or-nothing). The only grading a long workload may use.
   */
  grading: z.literal("partial-credit"),
  /** One line: what this workload stresses that the short ones cannot. */
  why: z.string().min(1).max(400),
});
export type LongHorizonWorkloadPlan = z.infer<typeof LongHorizonWorkloadPlanSchema>;

/** The draft's horizon plan: the judgement it acted on and the long workloads it adds. */
export const KitHorizonPlanSchema = z
  .strictObject({
    horizon: TaskHorizonSchema,
    rationale: z.string().min(1).max(1_200),
    long_workloads: z.array(LongHorizonWorkloadPlanSchema).max(4).default([]),
  })
  .superRefine((p, ctx) => {
    if (p.horizon !== "short" && p.long_workloads.length === 0)
      ctx.addIssue({
        code: "custom",
        path: ["long_workloads"],
        message: `horizon ${p.horizon} needs at least one long-horizon workload (>= ${LONG_HORIZON_MIN_FEATURE_AREAS} feature areas, wall cap >= ${LONG_HORIZON_MIN_WALL_S} s, partial-credit grading)`,
      });
    const ids = new Set<string>();
    p.long_workloads.forEach((w, i) => {
      if (ids.has(w.id))
        ctx.addIssue({
          code: "custom",
          path: ["long_workloads", i, "id"],
          message: `duplicate id '${w.id}'`,
        });
      ids.add(w.id);
    });
  });
export type KitHorizonPlan = z.output<typeof KitHorizonPlanSchema>;

/** The plan a subject with nothing long about it gets when a draft predates TDM-215. */
export const SHORT_HORIZON_DEFAULT: KitHorizonPlan = {
  horizon: "short",
  rationale: "no horizon recorded (a draft from before TDM-215): small tasks only",
  long_workloads: [],
};

// ---------- what "coordinates agents" and "long" mean, in code ----------

/**
 * Text that describes coordinating several agents: an orchestrator, planner + workers, parallel
 * sessions or workers, subagents, a task board or queue agents claim from, a multi-agent setup.
 * Matched on what a subject DOES, never on its name.
 */
const COORDINATION_TEXT = [
  /\borchestrat(e|es|ed|ing|or|ors|ion)\b/i,
  /\bmulti[- ]agents?\b/i,
  /\bsub-?agents?\b/i,
  /\bparallel\b[^.]{0,60}\b(workers?|agents?)\b/i,
  /\b(workers?|agents?)\b[^.]{0,60}\bin parallel\b/i,
  /\bplanners?\b[^.]{0,80}\bworkers?\b/i,
  /\b(\d+|several|many|multiple|n)\s+(\w+\s+){0,2}(workers|agents)\b/i,
  /\bcoordinat(e|es|ed|ing|ion|or)\b[^.]{0,60}\b(agents?|workers?|subagents?)\b/i,
  /\b(task|ticket|work) (board|queue)\b[^.]{0,80}\b(claim|claims|workers?|agents?)\b/i,
  /\b(fleet|swarm) of\b[^.]{0,30}\b(agents?|workers?)\b/i,
];

/** Does this text describe a subject that coordinates several agents or workers? */
export function describesCoordination(text: string): boolean {
  return COORDINATION_TEXT.some((re) => re.test(text));
}

/** What the horizon floor reads from an understanding or a kit subject. */
export interface HorizonSubject {
  kind?: string | null;
  driver_type?: string | null;
  summary?: string | null;
}

const AGENT_DRIVER_TYPES_H = new Set(["coding-agent", "http-agent", "harness"]);

/**
 * A harness, or an agent whose summary describes coordinating agents. Software (a CLI with worker
 * threads, a job queue) is not: it does not coordinate agents, and its kits stay short.
 */
export function isCoordinationSubject(s: HorizonSubject): boolean {
  if (s.kind === "harness" || s.driver_type === "harness") return true;
  const agentLike =
    s.kind === "agent" || (s.driver_type != null && AGENT_DRIVER_TYPES_H.has(s.driver_type));
  return agentLike && s.summary != null && describesCoordination(s.summary);
}

/** Does the kit for this subject need at least one long-horizon workload? */
export function needsLongHorizon(s: HorizonSubject & { horizon?: TaskHorizon | null }): boolean {
  return (s.horizon != null && s.horizon !== "short") || isCoordinationSubject(s);
}

/** The minimal kit shape the wall-cap rule reads (structural, so KitSpec fits). */
export interface HorizonKitShape {
  contenders: readonly { driver: { wall_clock_cap_s?: number | undefined } }[];
  workloads: readonly { id: string; timeout_s?: number | undefined }[];
}

/**
 * The wall cap a workload runs under: its own `timeout_s` (it overrides the driver's), else the
 * tightest contender cap (the one that binds the comparison), else null (uncapped / unknown).
 */
export function workloadWallCapS(
  kit: HorizonKitShape,
  w: HorizonKitShape["workloads"][number],
): number | null {
  if (w.timeout_s !== undefined) return w.timeout_s;
  const caps = kit.contenders
    .map((c) => c.driver.wall_clock_cap_s)
    .filter((x): x is number => x !== undefined);
  return caps.length > 0 ? Math.min(...caps) : null;
}

/** Long-horizon = a wall cap of at least LONG_HORIZON_MIN_WALL_S. */
export function isLongHorizonWorkload(
  kit: HorizonKitShape,
  w: HorizonKitShape["workloads"][number],
): boolean {
  const cap = workloadWallCapS(kit, w);
  return cap !== null && cap >= LONG_HORIZON_MIN_WALL_S;
}
