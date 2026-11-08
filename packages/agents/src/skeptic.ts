// TDM-187 [16.16]: the skeptic role (packages/agents/skeptic/) as typed code.
//
//   buildSkepticInput(material, findings, extra)  the task message: instructions, hidden-test
//                                excerpts, contender help, gates/requirements/weights/contenders,
//                                the deterministic findings, proof results. SkepticInputSchema is
//                                strict all the way down and has no field for contender scores
//                                (plan.md 17.2 rule 6): the skeptic judges the plan, never the outcome.
//   SkepticOutputSchema          the model's answer (matches output.schema.json).
//   verifySkepticFindings(...)   the model's findings with their `path:line` + quote checked
//                                mechanically: a quote that is not on the cited line → warn.
//   finalizeSkepticReview(...)   deterministic + verified model findings → the verdict, IN CODE
//                                (decideSkepticVerdict): the model's own verdict is advisory.
//   skepticModelFor(...)         the independence rule: the role's model, else the first fallback,
//                                that is not Anthropic, not the designer's family and not any
//                                contender's family (checkSkepticModel, from the model id).
import { existsSync } from "node:fs";
import path from "node:path";
import { isAgentDriver, type ProofCheckResult } from "@anybench/core";
import {
  checkSkepticModel,
  contenderModels,
  decideSkepticVerdict,
  DEFAULT_DESIGNER_FAMILIES,
  EVIDENCE_PATTERN,
  normText,
  SkepticCheckSchema,
  SkepticFindingSchema,
  SkepticSeveritySchema,
  SkepticVerdictSchema,
  type SkepticFinding,
  type SkepticKitMaterial,
  type SkepticModelCheck,
  type SkepticVerdict,
} from "@anybench/kit";
import { z } from "zod";
import { KIT_DESIGNER_ROLE } from "./kit-designer.js";
import { DEFAULT_ROLES_DIR, loadRole, type RegistryOptions } from "./registry.js";

export const SKEPTIC_ROLE = "skeptic";

/**
 * Tried in order after the role's config.json model when a kit's contenders (or the designer)
 * share its family. Each is from another family; all were listed by Naïve models.list on
 * 2026-11-08 (docs/findings/skeptic.md).
 */
export const SKEPTIC_MODEL_FALLBACKS: readonly string[] = [
  "google/gemini-3.1-flash-lite",
  "qwen/qwen3.8-flash",
  "mistralai/mistral-small-2603",
  "z-ai/glm-5.3-flash",
];

export const SKEPTIC_INPUT_CAPS = {
  manifestChars: 14_000,
  instructionChars: 8_000,
  hiddenFileChars: 5_000,
  hiddenTotalChars: 40_000,
  helpFileChars: 3_000,
  helpFiles: 8,
  findings: 60,
} as const;

// ---------- input (strict: no field for contender scores) ----------

const Numbered = z.strictObject({
  path: z.string(),
  truncated: z.boolean(),
  lines: z.string(),
});

const SkepticContenderSchema = z.strictObject({
  id: z.string(),
  role: z.string(),
  driver_type: z.string(),
  model: z.string().nullable(),
  versions: z.record(z.string(), z.string()),
  assists: z.array(z.string()),
  source: z.enum(["github", "binary", "upload"]),
  help_files: z.array(z.string()),
});

export const SkepticInputSchema = z.strictObject({
  /** anybench.yaml, numbered, so manifest findings can cite `anybench.yaml:<line>`. */
  manifest: Numbered,
  kit: z.strictObject({
    subject: z.strictObject({
      kind: z.string(),
      name: z.string(),
      summary: z.string(),
      better_means: z.array(z.string()),
    }),
    contenders: z.array(SkepticContenderSchema),
    workloads: z.array(
      z.strictObject({
        id: z.string(),
        title: z.string().nullable(),
        params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
        instruction: Numbered.nullable(),
      }),
    ),
    gates: z.array(
      z.strictObject({ id: z.string(), kind: z.string(), description: z.string().nullable() }),
    ),
    requirements: z.array(
      z.strictObject({
        id: z.string(),
        type: z.enum(["measured", "reviewed"]),
        title: z.string(),
        metric: z.string().nullable(),
        gate_id: z.string().nullable(),
        workloads: z.array(z.string()).nullable(),
        weight: z.int(),
      }),
    ),
    repeats: z.int(),
    vary: z.record(z.string(), z.array(z.union([z.string(), z.number(), z.boolean()]))),
    human_in_loop_policy: z.string().nullable(),
    proof_plan: z.strictObject({
      oracle: z
        .strictObject({
          id: z.string(),
          contender: z.string().nullable(),
          description: z.string().nullable(),
        })
        .nullable(),
      do_less: z.array(
        z.strictObject({ id: z.string(), kind: z.string(), description: z.string().nullable() }),
      ),
      regression: z
        .strictObject({
          id: z.string(),
          contender: z.string().nullable(),
          description: z.string().nullable(),
        })
        .nullable(),
    }),
  }),
  hidden_tests: z.array(
    z.strictObject({
      path: z.string(),
      workload: z.string().nullable(),
      truncated: z.boolean(),
      lines: z.string(),
    }),
  ),
  contender_help: z.array(Numbered),
  deterministic_findings: z.array(
    z.strictObject({
      id: z.string(),
      severity: SkepticSeveritySchema,
      check: SkepticCheckSchema,
      evidence: z.string(),
      why: z.string(),
    }),
  ),
  /** Proof checks only: pass/fail and the check-level reason. Never a contender trial's numbers. */
  proof_results: z
    .array(z.strictObject({ check: z.string(), pass: z.boolean(), reason: z.string() }))
    .nullable(),
  understanding: z
    .strictObject({
      kind: z.string(),
      summary: z.string(),
      better_means: z.array(z.string()),
      risks: z.array(z.string()),
    })
    .nullable(),
});
export type SkepticInput = z.infer<typeof SkepticInputSchema>;

/** `<n>| <line>` lines, cut at whole lines under `max` chars. */
export function numberLines(text: string, max: number): { lines: string; truncated: boolean } {
  const out: string[] = [];
  let size = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = `${i + 1}| ${lines[i]}`;
    if (size + line.length + 1 > max) return { lines: out.join("\n"), truncated: true };
    out.push(line);
    size += line.length + 1;
  }
  return { lines: out.join("\n"), truncated: false };
}

const INSTRUCTION_FILE =
  /(^|\/)(CLAUDE\.md|AGENTS\.md|GEMINI\.md|\.cursorrules|copilot-instructions\.md|CONVENTIONS\.md)$/i;

export interface SkepticInputExtra {
  proof?: readonly ProofCheckResult[] | null;
  understanding?: {
    kind: string;
    summary: string;
    better_means: readonly string[];
    risks?: readonly string[];
  } | null;
}

/** The task message for one skeptic session (bounded size; no contender scores by construction). */
export function buildSkepticInput(
  m: SkepticKitMaterial,
  findings: readonly SkepticFinding[],
  extra: SkepticInputExtra = {},
): SkepticInput {
  const caps = SKEPTIC_INPUT_CAPS;
  const { spec } = m;
  const text = (p: string) => m.files.find((f) => f.path === p)?.text ?? "";
  const under = (p: string, dir: string) =>
    p === dir || p.startsWith(`${dir.replace(/\/+$/, "")}/`);

  const helpOf = (upload: readonly string[]) =>
    m.files
      .filter((f) => upload.some((u) => under(f.path, u.replace(/\/+$/, ""))))
      .map((f) => f.path);

  let budget = caps.hiddenTotalChars;
  const hidden: SkepticInput["hidden_tests"] = [];
  for (const h of m.hidden) {
    if (budget <= 200) break;
    const n = numberLines(h.text, Math.min(caps.hiddenFileChars, budget));
    budget -= n.lines.length;
    hidden.push({ path: h.path, workload: h.workload, truncated: n.truncated, lines: n.lines });
  }

  const help = m.files
    .filter((f) => f.path.startsWith("adapters/") && f.text !== "")
    .filter((f) => /\.(md|txt)$/i.test(f.path) || INSTRUCTION_FILE.test(f.path))
    .slice(0, caps.helpFiles)
    .map((f) => {
      const n = numberLines(f.text, caps.helpFileChars);
      return { path: f.path, truncated: n.truncated, lines: n.lines };
    });

  const manifest = numberLines(text("anybench.yaml"), caps.manifestChars);
  const input: SkepticInput = {
    manifest: { path: "anybench.yaml", truncated: manifest.truncated, lines: manifest.lines },
    kit: {
      subject: {
        kind: spec.subject.kind,
        name: spec.subject.name,
        summary: spec.subject.summary,
        better_means: [...spec.subject.better_means],
      },
      contenders: spec.contenders.map((c) => ({
        id: c.id,
        role: c.role,
        driver_type: c.driver.type,
        model: isAgentDriver(c.driver) ? (c.driver.model ?? null) : null,
        versions: { ...(c.versions ?? {}) },
        assists: [...(c.assists ?? [])],
        source: "github" in c.source ? "github" : "upload" in c.source ? "upload" : "binary",
        help_files: "upload" in c.source ? helpOf(c.source.upload) : [],
      })),
      workloads: spec.workloads.map((w) => {
        const p = w.instruction ?? `workloads/${w.id}/instruction.md`;
        const t = text(p);
        const n = t ? numberLines(t, caps.instructionChars) : null;
        return {
          id: w.id,
          title: w.title ?? null,
          params: { ...(w.params ?? {}) },
          instruction: n ? { path: p, truncated: n.truncated, lines: n.lines } : null,
        };
      }),
      gates: spec.gates.map((g) => ({
        id: g.id,
        kind: g.kind,
        description: g.description ?? null,
      })),
      requirements: spec.requirements.map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        metric: r.type === "measured" ? r.metric : null,
        gate_id: r.gate_id ?? null,
        workloads: r.workloads ? [...r.workloads] : null,
        weight: spec.scoring.weights[r.id] ?? 0,
      })),
      repeats: spec.repeats,
      vary: Object.fromEntries(Object.entries(spec.vary).map(([k, v]) => [k, [...v]])),
      human_in_loop_policy: spec.human_in_loop?.policy ?? null,
      proof_plan: {
        oracle: spec.proof.oracle
          ? {
              id: spec.proof.oracle.id,
              contender: spec.proof.oracle.contender ?? null,
              description: spec.proof.oracle.description ?? null,
            }
          : null,
        do_less: spec.proof.do_less.map((o) => ({
          id: o.id,
          kind: o.kind ?? "inferred",
          description: o.description ?? null,
        })),
        regression: spec.proof.regression
          ? {
              id: spec.proof.regression.id,
              contender: spec.proof.regression.contender ?? null,
              description: spec.proof.regression.description ?? null,
            }
          : null,
      },
    },
    hidden_tests: hidden,
    contender_help: help,
    deterministic_findings: findings.slice(0, caps.findings).map((f) => ({
      id: f.id,
      severity: f.severity,
      check: f.check,
      evidence: f.evidence,
      why: f.why,
    })),
    proof_results: extra.proof
      ? extra.proof.map((r) => ({ check: r.check, pass: r.pass, reason: r.reason }))
      : null,
    understanding: extra.understanding
      ? {
          kind: extra.understanding.kind,
          summary: extra.understanding.summary,
          better_means: [...extra.understanding.better_means],
          risks: [...(extra.understanding.risks ?? [])],
        }
      : null,
  };
  return SkepticInputSchema.parse(input);
}

// ---------- output ----------

/** The model's answer. Mirrors skeptic/output.schema.json (a test keeps them in step). */
export const SkepticOutputSchema = z.object({
  verdict: SkepticVerdictSchema,
  summary: z.string().default(""),
  findings: z
    .array(
      z.object({
        // An unknown check name is kept as "other" rather than failing the whole answer.
        check: z.string().transform((c) => (SkepticCheckSchema.safeParse(c).success ? c : "other")),
        severity: SkepticSeveritySchema,
        evidence: z.string(),
        quote: z.string().default(""),
        why: z.string().min(1),
      }),
    )
    .default([]),
});
export type SkepticOutput = z.infer<typeof SkepticOutputSchema>;

const stripPrefix = (s: string) => s.replace(/^\s*\d+\|\s?/, "");

/**
 * The model's findings, each with its evidence checked: the path is a kit file, the line exists,
 * and the quote is on that line (or the next, for wrapped text). Anything that fails becomes a
 * warning that says why, so a model cannot block a kit on a citation that is not there.
 */
export function verifySkepticFindings(
  output: SkepticOutput,
  m: Pick<SkepticKitMaterial, "files">,
): SkepticFinding[] {
  return output.findings.slice(0, 40).map((f, i) => {
    let problem: string | null = null;
    const ev = f.evidence.trim().replace(/^\.\//, "");
    const [, file, lineText] = /^(.+):(\d+)$/.exec(ev) ?? [];
    const lines = file ? m.files.find((x) => x.path === file)?.text.split("\n") : undefined;
    const line = Number(lineText);
    if (!EVIDENCE_PATTERN.test(ev) || !file)
      problem = `evidence '${f.evidence}' is not <path>:<line>`;
    else if (!lines || (lines.length === 1 && lines[0] === ""))
      problem = `${file} is not a text file in the kit`;
    else if (line < 1 || line > lines.length) problem = `${file} has no line ${line}`;
    else {
      const quote = normText(stripPrefix(f.quote));
      const window = normText(lines.slice(line - 1, line + 1).join(" "));
      if (quote.length < 3 || !window.includes(quote))
        problem = `the quote is not on ${file}:${line}`;
    }
    const evidence =
      EVIDENCE_PATTERN.test(ev) && lines && line >= 1 && line <= lines.length
        ? ev
        : "anybench.yaml:1";
    return SkepticFindingSchema.parse({
      id: `model-${i + 1}`,
      severity: problem ? "warn" : f.severity,
      check: f.check,
      evidence,
      why: problem ? `[unverified: ${problem}] ${f.why}` : f.why,
      source: "model",
    });
  });
}

export interface SkepticReviewResult {
  /** Computed in code from `findings`. */
  verdict: SkepticVerdict;
  /** The model's own verdict, advisory only. */
  advisoryVerdict: SkepticVerdict | null;
  summary: string;
  findings: SkepticFinding[];
}

/** Deterministic findings + the model's verified findings → the final verdict (code, not model). */
export function finalizeSkepticReview(
  deterministic: readonly SkepticFinding[],
  output: SkepticOutput | null,
  m: Pick<SkepticKitMaterial, "files">,
): SkepticReviewResult {
  const fromModel = output ? verifySkepticFindings(output, m) : [];
  const seen = new Set(deterministic.map((f) => `${f.check}\0${f.evidence}`));
  const findings = [
    ...deterministic,
    ...fromModel.filter((f) => !seen.has(`${f.check}\0${f.evidence}`)),
  ];
  return {
    verdict: decideSkepticVerdict(findings),
    advisoryVerdict: output?.verdict ?? null,
    summary: output?.summary.trim() ?? "",
    findings,
  };
}

// ---------- the independence rule ----------

/** The kit designer's model(s): its role's config.json (TDM-60), else the default families. Its family is banned. */
export function designerModels(options: RegistryOptions = {}): string[] {
  const dir = path.join(options.rolesDir ?? DEFAULT_ROLES_DIR, KIT_DESIGNER_ROLE, "config.json");
  if (!existsSync(dir)) return [...DEFAULT_DESIGNER_FAMILIES];
  return [loadRole(KIT_DESIGNER_ROLE, options).config.model, ...DEFAULT_DESIGNER_FAMILIES];
}

export interface SkepticModelChoice {
  /** The model to run, or null when every candidate is refused. */
  model: string | null;
  /** Why each refused candidate was refused. */
  refused: string[];
}

/**
 * The skeptic's model for a kit: the first of `candidates` (default: the role's model, then
 * SKEPTIC_MODEL_FALLBACKS) that checkSkepticModel accepts against the designer and the kit's
 * contender models.
 */
export function skepticModelFor(
  spec: Parameters<typeof contenderModels>[0],
  opts: { candidates?: readonly string[]; designer?: readonly string[] } & RegistryOptions = {},
): SkepticModelChoice {
  const candidates = opts.candidates ?? [
    loadRole(SKEPTIC_ROLE, opts).config.model,
    ...SKEPTIC_MODEL_FALLBACKS,
  ];
  const rule = {
    designer: opts.designer ?? designerModels(opts),
    contenders: contenderModels(spec),
  };
  const refused: string[] = [];
  for (const c of candidates) {
    const r: SkepticModelCheck = checkSkepticModel(c, rule);
    if (r.ok) return { model: c, refused };
    refused.push(r.reason);
  }
  return { model: null, refused };
}
