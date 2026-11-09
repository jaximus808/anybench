// TDM-187 [16.16]: the skeptic's finding and verdict shapes, shared by the deterministic checks
// (checks.ts), the Naïve skeptic role (packages/agents/skeptic) and the orchestrator seam
// (apps/server orchestrator/skeptic.ts).
//
// A finding is `{id, severity: block|warn, check, evidence: "path:line", why}`. The verdict is
// computed here, in code, never taken from a model: no block → pass; a block the kit designer can
// fix → repair; a block it cannot (contamination, an unverifiable independence) → hold.
import { z } from "zod";

/** What the skeptic audits (the ABC checklist, arXiv 2507.02825, as the methodology review applies it). */
export const SKEPTIC_CHECKS = [
  /** instruction.md names hidden tests, expected values, assertion messages, or spells out the fix. */
  "solution_leakage",
  /** An answer-bearing file (expected output, hidden test, fix) under workloads/. */
  "answer_in_workloads",
  /** A no-op or untouched input passes the gate. */
  "noop_passable",
  /** No do-less variant, or only a no-op: nothing shows the gate refuses near-misses. */
  "weak_do_less",
  /** Help (CLAUDE.md, tools, a reviewer) that reaches some contenders and not others. */
  "one_sided_assist",
  /** Weight on a metric only some contenders are measured on, or on a vanity metric (17.4). */
  "one_sided_weight",
  /** The oracle lives in the subject's own code or public history; mined tasks before a cutoff. */
  "contamination",
  /** Unpinned versions, unequal caps, unshared assists (the comparability validator's issues). */
  "comparability",
  /** A measured requirement without a correctness gate. */
  "ungated_measure",
  /** Too few tasks or repeats for the claim the kit makes (17.2 rule 3). */
  "too_few_tasks",
  /**
   * TDM-215: a harness that coordinates agents, tested only on short workloads (none with a wall
   * cap of 2 h or more): its overhead is measured, its point never is.
   */
  "horizon_mismatch",
  /** The kit does not load (anything else the validator refuses). */
  "kit_invalid",
  /** Anything else the model reports. */
  "other",
] as const;
export const SkepticCheckSchema = z.enum(SKEPTIC_CHECKS);
export type SkepticCheck = z.infer<typeof SkepticCheckSchema>;

export const SkepticSeveritySchema = z.enum(["block", "warn"]);
export type SkepticSeverity = z.infer<typeof SkepticSeveritySchema>;

/** `path:line`, kit-relative, 1-based line. */
export const EVIDENCE_PATTERN = /^[^\s:][^:]*:[1-9]\d*$/;
export const SkepticEvidenceSchema = z
  .string()
  .regex(EVIDENCE_PATTERN, "evidence must be <kit-relative path>:<line>");

export const SkepticFindingSchema = z.strictObject({
  id: z.string().min(1),
  severity: SkepticSeveritySchema,
  check: SkepticCheckSchema,
  evidence: SkepticEvidenceSchema,
  why: z.string().min(1),
  /** Who found it: the deterministic checks, or the skeptic model (evidence verified by code). */
  source: z.enum(["code", "model"]).default("code"),
});
export type SkepticFinding = z.infer<typeof SkepticFindingSchema>;
export type SkepticFindingInput = z.input<typeof SkepticFindingSchema>;

export const SkepticVerdictSchema = z.enum(["pass", "repair", "hold"]);
export type SkepticVerdict = z.infer<typeof SkepticVerdictSchema>;

/**
 * Blocks the kit designer cannot repair by editing the kit: the tasks themselves are tainted or
 * their independence cannot be shown. Every other block goes back to the designer.
 */
export const HOLD_CHECKS: ReadonlySet<SkepticCheck> = new Set<SkepticCheck>(["contamination"]);

/** The final verdict, from the findings alone. A model's own verdict is advisory and ignored here. */
export function decideSkepticVerdict(findings: readonly SkepticFinding[]): SkepticVerdict {
  const blocks = findings.filter((f) => f.severity === "block");
  if (blocks.length === 0) return "pass";
  return blocks.some((f) => HOLD_CHECKS.has(f.check)) ? "hold" : "repair";
}

/** One line per finding: `BLOCK solution_leakage workloads/x/instruction.md:12 why`. */
export function formatSkepticFinding(f: SkepticFinding): string {
  return `${f.severity.toUpperCase()} ${f.check} ${f.evidence} ${f.why}`;
}
