// KitSpec v2: `anybench.yaml`, the single entry point for all testing (plan.md P2).
//
// Seven wrapper layers: L0 source · L1 install · L2 driver (contenders[]) · L3 workloads[] ·
// L4 collectors[] · L5 gates[] + requirements[].gate_id · L6 requirements[].rubric · L7 proof.
//
// The core rule is enforced here, not left to callers: every `measured` requirement names a
// `gate_id` that exists, and every gate a measured requirement uses is covered by `proof.oracle`.
// A kit without an oracle for a measured gate does not validate.
//
// Cross-field rules (refs, weights, oracle coverage) run only once every field is well-formed,
// so a kit with field errors reports those first and the cross-field ones on the next attempt.
import { z } from "zod";
import { CollectorNameSchema, ContenderSchema } from "./contender.js";
import { EnvSpecSchema } from "./env.js";
import {
  KitEnvMapSchema,
  KitEnvVarNameSchema,
  KitGlobSchema,
  KitSlugSchema,
  KitPathSchema,
  SubjectKindSchema,
} from "./kit-primitives.js";
import { GateSchema, RequirementSchema } from "./requirement.js";
import { WorkloadSchema } from "./workload.js";

export const KIT_SCHEMA_VERSION = 2 as const;

export const KitSubjectSchema = z.strictObject({
  kind: SubjectKindSchema,
  name: z.string().min(1),
  summary: z.string().min(1),
  /** What "better" means for this project, in plain words. */
  better_means: z.array(z.string().min(1)).min(1),
});
export type KitSubject = z.infer<typeof KitSubjectSchema>;

/** L7: a contender overlay (driver patch or env) run through L1–L5. */
export const ProofOverlaySchema = z.strictObject({
  id: KitSlugSchema,
  /** e.g. `proof/oracle/`, `proof/do_less/drop-chunks/`. */
  dir: KitPathSchema,
  /** The contender the overlay is applied to. Defaults to the first `subject`. */
  contender: KitSlugSchema.optional(),
  driver_patch: KitPathSchema.optional(),
  env: KitEnvMapSchema.optional(),
  description: z.string().min(1).optional(),
});
export type ProofOverlay = z.infer<typeof ProofOverlaySchema>;

export const OracleOverlaySchema = ProofOverlaySchema.extend({
  /** Gates this oracle proves. Omit to cover every gate in the kit. */
  gates: z.array(KitSlugSchema).min(1).optional(),
});
export type OracleOverlay = z.infer<typeof OracleOverlaySchema>;

export const KitProofSchema = z.strictObject({
  /** The reference solution: must pass every gate at 100%. */
  oracle: OracleOverlaySchema.optional(),
  /** Versions that skip work: each must fail the gate. */
  do_less: z.array(ProofOverlaySchema).default([]),
  /** A planted regression: must score lower. */
  regression: ProofOverlaySchema.optional(),
});
export type KitProof = z.infer<typeof KitProofSchema>;

export const HumanInLoopSchema = z.strictObject({
  /** `tandem`: board approvals; `naive`: Naïve confirmTool / answer prompts. */
  kind: z.enum(["tandem", "naive"]),
  policy: z.enum(["auto", "llm-reviewer", "human-sim"]).default("auto"),
});
export type HumanInLoop = z.infer<typeof HumanInLoopSchema>;

const VaryValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const KitScoringSchema = z.strictObject({
  /** requirement id → integer weight. Every requirement has one; they sum to 100. */
  weights: z.record(KitSlugSchema, z.int().min(0).max(100)),
});
export type KitScoring = z.infer<typeof KitScoringSchema>;

export const KitSpecSchema = z
  .strictObject({
    schema_version: z.literal(KIT_SCHEMA_VERSION, {
      error: `schema_version must be ${KIT_SCHEMA_VERSION}`,
    }),
    subject: KitSubjectSchema,
    contenders: z.array(ContenderSchema).min(1, { error: "a kit needs at least one contender" }),
    workloads: z.array(WorkloadSchema).min(1, { error: "a kit needs at least one workload" }),
    /** Omit to use DRIVER_DEFAULT_COLLECTORS for each contender's driver type. */
    collectors: z.array(CollectorNameSchema).optional(),
    gates: z.array(GateSchema).default([]),
    requirements: z
      .array(RequirementSchema)
      .min(1, { error: "a kit needs at least one requirement" }),
    proof: KitProofSchema.default({ do_less: [] }),
    /** Each value is one setup to compare, e.g. `WORKERS: [1, 3, 5]`. */
    vary: z.record(KitEnvVarNameSchema, z.array(VaryValueSchema).min(1)).default({}),
    human_in_loop: HumanInLoopSchema.optional(),
    /** Names only; values are injected at run time, never stored in the kit. */
    secrets: z.array(KitEnvVarNameSchema).default([]),
    /** Globs under EVAL_OUT copied into `artifacts/`. */
    collect: z.array(KitGlobSchema).default([]),
    transfer: z.strictObject({ max_mb: z.int().min(1).max(10_240) }).default({ max_mb: 512 }),
    scoring: KitScoringSchema,
    repeats: z.int().min(1).max(100),
    /** The eval computer, when the kit carries it inline. */
    env: EnvSpecSchema.optional(),
  })
  .superRefine((kit, ctx) => {
    const issue = (path: PropertyKey[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });

    // Unique ids per collection.
    for (const [field, items] of [
      ["contenders", kit.contenders],
      ["workloads", kit.workloads],
      ["gates", kit.gates],
      ["requirements", kit.requirements],
      ["proof.do_less", kit.proof.do_less],
    ] as const) {
      const seen = new Map<string, number>();
      items.forEach((item, i) => {
        const first = seen.get(item.id);
        const path = field === "proof.do_less" ? ["proof", "do_less", i, "id"] : [field, i, "id"];
        if (first !== undefined)
          issue(path, `id '${item.id}' is already used by ${field}[${first}]`);
        else seen.set(item.id, i);
      });
    }

    const gateIds = new Set(kit.gates.map((g) => g.id));
    const contenderIds = new Set(kit.contenders.map((c) => c.id));
    const requirementIds = new Set(kit.requirements.map((r) => r.id));

    if (!kit.contenders.some((c) => c.role === "subject")) {
      issue(["contenders"], "at least one contender must have role 'subject'");
    }

    // Every gate_id points at a real gate.
    kit.requirements.forEach((r, i) => {
      if (r.gate_id !== undefined && !gateIds.has(r.gate_id)) {
        issue(["requirements", i, "gate_id"], `gate '${r.gate_id}' is not defined in gates[]`);
      }
    });

    // Measured gates need an oracle that covers them.
    const measuredGates = new Map<string, number>();
    kit.requirements.forEach((r, i) => {
      if (r.type === "measured" && gateIds.has(r.gate_id) && !measuredGates.has(r.gate_id)) {
        measuredGates.set(r.gate_id, i);
      }
    });
    const oracle = kit.proof.oracle;
    if (oracle === undefined) {
      for (const [gate, i] of measuredGates) {
        issue(
          ["proof", "oracle"],
          `measured gate '${gate}' (used by requirements[${i}]) has no oracle: add proof.oracle so the gate is proven to pass on a known-good answer`,
        );
      }
    } else {
      oracle.gates?.forEach((g, j) => {
        if (!gateIds.has(g))
          issue(["proof", "oracle", "gates", j], `gate '${g}' is not defined in gates[]`);
      });
      if (oracle.gates !== undefined) {
        const covered = new Set(oracle.gates);
        for (const [gate, i] of measuredGates) {
          if (!covered.has(gate)) {
            issue(
              ["proof", "oracle", "gates"],
              `measured gate '${gate}' (used by requirements[${i}]) is not covered by proof.oracle.gates`,
            );
          }
        }
      }
    }

    // Overlays point at real contenders.
    const overlays: [PropertyKey[], { contender?: string | undefined }][] = [];
    if (oracle) overlays.push([["proof", "oracle"], oracle]);
    kit.proof.do_less.forEach((o, i) => overlays.push([["proof", "do_less", i], o]));
    if (kit.proof.regression) overlays.push([["proof", "regression"], kit.proof.regression]);
    for (const [path, o] of overlays) {
      if (o.contender !== undefined && !contenderIds.has(o.contender)) {
        issue([...path, "contender"], `contender '${o.contender}' is not defined in contenders[]`);
      }
    }

    // scoring.weights: one integer per requirement, summing to 100.
    let sum = 0;
    for (const [id, w] of Object.entries(kit.scoring.weights)) {
      sum += w;
      if (!requirementIds.has(id)) {
        issue(["scoring", "weights", id], `requirement '${id}' is not defined in requirements[]`);
      }
    }
    kit.requirements.forEach((r, i) => {
      if (!(r.id in kit.scoring.weights)) {
        issue(["scoring", "weights"], `requirements[${i}] '${r.id}' has no weight`);
      }
    });
    if (sum !== 100) issue(["scoring", "weights"], `weights must sum to 100, got ${sum}`);

    // Harness drivers run an approver sidecar, so the kit must say which one.
    kit.contenders.forEach((c, i) => {
      if (c.driver.type === "harness" && kit.human_in_loop === undefined) {
        issue(
          ["contenders", i, "driver", "type"],
          `contender '${c.id}' uses a harness driver, which needs human_in_loop {kind, policy}`,
        );
      }
    });

    // Secrets: names only, each once, never also a vary key.
    const seenSecrets = new Set<string>();
    kit.secrets.forEach((s, i) => {
      if (seenSecrets.has(s)) issue(["secrets", i], `secret '${s}' is listed twice`);
      seenSecrets.add(s);
      if (s in kit.vary) issue(["vary", s], `'${s}' is a secret and cannot be varied in the kit`);
    });
  });
export type KitSpec = z.infer<typeof KitSpecSchema>;
export type KitSpecInput = z.input<typeof KitSpecSchema>;

// ---------------------------------------------------------------------------------------------
// Readable, path-based errors: `requirements[1].gate_id: measured requirement must name a gate_id`.

/** `["requirements", 1, "gate_id"]` → `requirements[1].gate_id`. */
export function formatIssuePath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const key of path) {
    if (typeof key === "number") out += `[${key}]`;
    else if (typeof key === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      out += out === "" ? key : `.${key}`;
    else out += `[${JSON.stringify(String(key))}]`;
  }
  return out === "" ? "(root)" : out;
}

/** One line per issue, `<path>: <message>`. */
export function formatSchemaIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${formatIssuePath(i.path)}: ${i.message}`);
}

export type KitSpecParseResult =
  { success: true; data: KitSpec } | { success: false; errors: string[]; error: z.ZodError };

/** Validate an already-parsed `anybench.yaml` document. */
export function safeParseKitSpec(input: unknown): KitSpecParseResult {
  const r = KitSpecSchema.safeParse(input);
  return r.success
    ? { success: true, data: r.data }
    : { success: false, errors: formatSchemaIssues(r.error), error: r.error };
}
