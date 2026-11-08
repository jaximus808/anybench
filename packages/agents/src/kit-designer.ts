// TDM-60 [6.6]: the kit designer role (packages/agents/kit-designer/) as typed code.
//
//   buildKitDesignerInput(...)        mode "design": the digest, the understanding (driver, claims,
//                                     subject command hint), the research baselines, the user's
//                                     intake contenders, and the repo context (README, tree,
//                                     manifests), capped so one session stays cheap.
//   buildKitDesignerFixInput(...)     mode "fix": the draft + the validation issues our code found
//                                     (materializer, loadKit, comparability, no-leak). Asked once.
//   buildKitDesignerRepairInput(...)  mode "repair": the previous kit (spec + its draft) and its
//                                     proof check results, and NOTHING else. Plan 17.2 rule 6 (the
//                                     repair loop never sees contender scores) is enforced by the
//                                     type and by a strict schema: there is no field a score, a
//                                     metric or a trial could ride in, proof reasons are scrubbed
//                                     of anything that looks like a measurement, and the builder
//                                     refuses extra keys at run time.
//   KitDesignerOutputSchema           the draft (@anybench/kit CliKitDraftSchema).
import type { ProjectDigest, ProofCheckResult } from "@anybench/core";
import { ProofCheckNameSchema } from "@anybench/core";
import { CliKitDraftSchema, type CliKitDraft, type RepoContext } from "@anybench/kit";
import { z } from "zod";
import { numberedReadme } from "./understander.js";

export const KIT_DESIGNER_ROLE = "kit-designer";

/** The draft the model returns (cli kits; coding-agent/harness kits follow with the miner). */
export const KitDesignerOutputSchema = CliKitDraftSchema;
export type KitDesignerOutput = CliKitDraft;

export const KIT_DESIGNER_INPUT_CAPS = {
  readmeChars: 24_000,
  treePaths: 150,
  manifests: 6,
  manifestChars: 2_500,
  proofReasonChars: 600,
  proofEvidence: 8,
  proofEvidenceChars: 300,
  issues: 20,
} as const;

/** What the design input needs from the orchestrator's understanding (UnderstandingSchema). */
export interface KitDesignerUnderstanding {
  kind: string;
  summary: string;
  better_means: string[];
  risks?: string[];
  driver_type?: string;
  claims?: { text: string; quote: string; source: string }[];
  subject_command?: {
    binary: string;
    install_route: string;
    package: string | null;
    version_command: string | null;
  };
}

export interface KitDesignerDesignArgs {
  digest: ProjectDigest;
  understanding: KitDesignerUnderstanding;
  research: { baselines: { name: string; source: string; why: string }[] } | null;
  /** The user's intake contenders: they win over the designer's own picks. */
  intakeContenders: { id: string; name?: string; source: unknown }[];
  context: RepoContext | null;
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function buildKitDesignerInput(a: KitDesignerDesignArgs): Record<string, unknown> {
  const caps = KIT_DESIGNER_INPUT_CAPS;
  const { digest, context } = a;
  const input: Record<string, unknown> = {
    mode: "design",
    repo: {
      source: digest.source,
      name: digest.name,
      summary: digest.summary,
      languages: digest.languages.slice(0, 6),
      latest_release: digest.releases.latest ?? null,
      recent_tags: digest.releases.tags.slice(0, 8),
    },
    understanding: {
      kind: a.understanding.kind,
      summary: a.understanding.summary,
      better_means: a.understanding.better_means,
      risks: a.understanding.risks ?? [],
      driver_type: a.understanding.driver_type ?? null,
      claims: (a.understanding.claims ?? []).slice(0, 10),
      subject_command_hint: a.understanding.subject_command ?? null,
    },
    research_baselines: a.research?.baselines ?? [],
    intake_contenders: a.intakeContenders.map((c) => ({
      id: c.id,
      name: c.name ?? null,
      source: c.source,
    })),
  };
  if (context) {
    input.readme = context.readme
      ? {
          path: context.readme.path,
          lines: numberedReadme(context.readme.text, caps.readmeChars).text,
        }
      : null;
    input.tree = context.tree.paths.slice(0, caps.treePaths);
    input.manifests = context.manifests.slice(0, caps.manifests).map((m) => ({
      path: m.path,
      text: cut(m.text, caps.manifestChars),
    }));
  } else {
    input.note = "no repo context was available: design from the digest and the understanding";
  }
  return input;
}

export function buildKitDesignerFixInput(a: {
  draft: unknown;
  issues: readonly string[];
}): Record<string, unknown> {
  return {
    mode: "fix",
    draft: a.draft,
    issues: a.issues.slice(0, KIT_DESIGNER_INPUT_CAPS.issues).map((i) => cut(i, 400)),
    note: "Our code could not build a valid kit from this draft. Return the whole corrected draft.",
  };
}

// ---------- repair (plan 17.2 rule 6: proof results, never contender scores) ----------

/** One proof check as the designer sees it: check-level reason and evidence, scrubbed. */
export const RepairProofCheckSchema = z.strictObject({
  check: ProofCheckNameSchema,
  pass: z.boolean(),
  reason: z.string(),
  evidence: z.array(z.string()),
});
export type RepairProofCheck = z.infer<typeof RepairProofCheckSchema>;

/**
 * The ONLY input of a repair. No field for scores, trials, metrics or reports: a strict schema,
 * so `buildKitDesignerRepairInput` throws on anything else (a test proves contender metrics
 * planted on a run never reach the designer).
 */
export const KitDesignerRepairInputSchema = z.strictObject({
  previous_spec: z.record(z.string(), z.unknown()),
  previous_draft: z.record(z.string(), z.unknown()).nullable(),
  proof: z.array(RepairProofCheckSchema),
});
export type KitDesignerRepairInput = z.infer<typeof KitDesignerRepairInputSchema>;

/** Metric names and measurement-looking values that must never reach the designer. */
const METRIC_TOKEN =
  /\b(wall_s|peak_rss(_bytes|_kb)?|cpu_s|user_s|sys_s|median|p50|p95|p99|mean|stddev|score|cost_micro_usd|tokens?)\b\s*[:=]?\s*-?\d[\d.,]*(?:\s*(?:ms|µs|us|bytes|kb|mb|gb|s|%)(?![A-Za-z]))?/gi;
const MEASUREMENT = /-?\d+(\.\d+)?\s*(ms|µs|us|kb|mb|gb|kib|mib|gib)\b/gi;

/** Remove measured values from a proof reason (TDM-44 already writes none; this is belt and braces). */
export function scrubMeasurements(text: string): string {
  return text
    .replace(METRIC_TOKEN, "[measurement withheld]")
    .replace(MEASUREMENT, "[measurement withheld]");
}

export function buildKitDesignerRepairInput(a: KitDesignerRepairInput): Record<string, unknown> {
  const parsed = KitDesignerRepairInputSchema.parse(a);
  const caps = KIT_DESIGNER_INPUT_CAPS;
  return {
    mode: "repair",
    previous_spec: parsed.previous_spec,
    previous_draft: parsed.previous_draft,
    proof: parsed.proof.map((p) => ({
      check: p.check,
      pass: p.pass,
      reason: cut(scrubMeasurements(p.reason), caps.proofReasonChars),
      evidence: p.evidence
        .slice(0, caps.proofEvidence)
        .map((e) => cut(scrubMeasurements(e), caps.proofEvidenceChars)),
    })),
    note: "The kit failed its proof. Return a whole corrected draft that fixes the failing checks.",
  };
}

/** Proof results from the orchestrator → the repair checks (drops nothing but unknown keys). */
export function repairChecksOf(proof: readonly ProofCheckResult[]): RepairProofCheck[] {
  return proof.map((p) => ({
    check: p.check,
    pass: p.pass,
    reason: p.reason,
    evidence: [...p.evidence],
  }));
}
