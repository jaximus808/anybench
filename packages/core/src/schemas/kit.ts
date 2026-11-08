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
import { CollectorNameSchema, ContenderSchema, type DriverType } from "./contender.js";
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
import { lookupUnit, parseRequirementTarget } from "./target.js";
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

/** Driver types whose trials are short and self-contained enough to share one computer. */
export const PACKABLE_DRIVER_TYPES: readonly DriverType[] = ["cli", "lib", "service"];

export const DEFAULT_KIT_WARMUPS = 1;
export const DEFAULT_KIT_BLOCK_SECONDS = 600;

/**
 * How the scheduler (packages/bench) lays out trials. Omit the whole object for the defaults:
 * one discarded warm-up per contender × workload, no packing, a 600 s billing block.
 */
export const KitScheduleSchema = z.strictObject({
  /** Discarded warm-up trials per contender × workload, run before the measured ones. */
  warmups: z.int().min(0).max(100).default(DEFAULT_KIT_WARMUPS),
  /** Expected wall time of one trial. Required when `packing` is on. */
  est_trial_seconds: z.int().positive().max(86_400).optional(),
  /**
   * Pack several short trials onto one computer per billing block. Off by default; allowed only
   * when every contender's driver type is cli, lib or service (agents and harnesses never share).
   */
  packing: z.boolean().default(false),
  /** Provider billing block in seconds (Naïve: 600). */
  block_seconds: z.int().positive().max(86_400).default(DEFAULT_KIT_BLOCK_SECONDS),
  /**
   * Seed for rotating the contender order in every round (repeat × workload), so no contender
   * always runs first on a warm cache or a quiet API (plan.md 17.2 rule 4). Omit to keep kit order.
   */
  order_seed: z.int().min(0).max(0xffff_ffff).optional(),
});
export type KitSchedule = z.infer<typeof KitScheduleSchema>;
export type KitScheduleInput = z.input<typeof KitScheduleSchema>;

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
    /**
     * Why the contenders' caps (wall clock, tokens, spend, turns) differ. Without it, or without
     * the cap being the `vary` axis, the kit validator refuses unequal caps (plan.md 17.2 rule 4).
     */
    unequal_caps_reason: z.string().trim().min(1).optional(),
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
    /** Trial layout for the scheduler. Omit for the defaults (see KitScheduleSchema). */
    schedule: KitScheduleSchema.default({
      warmups: DEFAULT_KIT_WARMUPS,
      packing: false,
      block_seconds: DEFAULT_KIT_BLOCK_SECONDS,
    }),
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

    // Per-workload scope, target units and aggregation (TDM-174).
    checkRequirementScoringTdm174(kit, issue);

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

    // Packing: software drivers only, and it needs a per-trial time estimate to size the blocks.
    if (kit.schedule.packing) {
      kit.contenders.forEach((c, i) => {
        if (!PACKABLE_DRIVER_TYPES.includes(c.driver.type)) {
          issue(
            ["schedule", "packing"],
            `packing is allowed only when every contender's driver type is ${PACKABLE_DRIVER_TYPES.join(", ")}; contenders[${i}] '${c.id}' is '${c.driver.type}'`,
          );
        }
      });
      if (kit.schedule.est_trial_seconds === undefined) {
        issue(
          ["schedule", "est_trial_seconds"],
          "packing needs est_trial_seconds to size the billing blocks",
        );
      }
    }

    // Secrets: names only, each once, never also a vary key.
    const seenSecrets = new Set<string>();
    kit.secrets.forEach((s, i) => {
      if (seenSecrets.has(s)) issue(["secrets", i], `secret '${s}' is listed twice`);
      seenSecrets.add(s);
      if (s in kit.vary) issue(["vary", s], `'${s}' is a secret and cannot be varied in the kit`);
    });
  });
export type KitSpec = z.infer<typeof KitSpecSchema>;
/** Mirrors `GATE_PASS_RATE_METRIC` in @anybench/bench (core cannot import bench). */
const GATE_PASS_RATE = "gate_pass_rate";

/**
 * TDM-174 [16.3]: requirement scope, target and aggregation rules.
 * - `workloads` names real workloads, each once.
 * - a bound `target` is in a unit that converts to the requirement's `unit`.
 * - `gate_pass_rate` takes no `aggregate`/`cap`; `cap` goes only with `censored` (or no aggregate).
 * - `aggregate: censored` can find a cap for every scoped workload.
 */
function checkRequirementScoringTdm174(
  kit: Pick<KitSpec, "requirements" | "workloads" | "contenders">,
  issue: (path: PropertyKey[], message: string) => void,
): void {
  const workloads = new Map(kit.workloads.map((w) => [w.id, w]));
  kit.requirements.forEach((r, i) => {
    const seen = new Set<string>();
    r.workloads?.forEach((w, j) => {
      if (!workloads.has(w))
        issue(["requirements", i, "workloads", j], `workload '${w}' is not defined in workloads[]`);
      else if (seen.has(w))
        issue(["requirements", i, "workloads", j], `workload '${w}' is listed twice`);
      seen.add(w);
    });
    if (r.type !== "measured") return;

    const t = parseRequirementTarget(r.target, r.unit);
    if (!t.ok) issue(["requirements", i, "target"], t.error);

    if (r.metric === GATE_PASS_RATE) {
      if (r.aggregate !== undefined)
        issue(
          ["requirements", i, "aggregate"],
          `${GATE_PASS_RATE} is always a rate: drop aggregate`,
        );
      if (r.cap !== undefined) issue(["requirements", i, "cap"], `${GATE_PASS_RATE} has no cap`);
      return;
    }
    if (r.cap !== undefined && r.aggregate !== undefined && r.aggregate !== "censored") {
      issue(["requirements", i, "cap"], `cap only applies to aggregate 'censored'`);
    }
    if (r.aggregate === "censored" && r.cap === undefined) {
      const timeUnit = r.unit === undefined || lookupUnit(r.unit)?.dim === "time";
      const scoped = r.workloads ?? kit.workloads.map((w) => w.id);
      const everyContenderCapped = kit.contenders.every(
        (c) => c.driver.wall_clock_cap_s !== undefined,
      );
      const everyWorkloadCapped = scoped.every((w) => workloads.get(w)?.timeout_s !== undefined);
      if (!timeUnit || !(everyContenderCapped || everyWorkloadCapped)) {
        issue(
          ["requirements", i, "cap"],
          timeUnit
            ? "aggregate 'censored' counts failed trials at the cap: set cap, every workload's timeout_s, or every contender's wall_clock_cap_s"
            : `aggregate 'censored' on a metric in '${r.unit}' needs an explicit cap in that unit`,
        );
      }
    }
  });
}

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
