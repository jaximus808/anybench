// TDM-109 [12.1]: signed attestation of a published benchmark (plan.md P5).
//
// Publishing freezes a report and signs canonical JSON (canonical.ts) with Ed25519: kit hash,
// contender versions, snapshot hashes, trial count, proof-check results, per-contender score
// and CI, issued_at, key_id.
//
// Honest by construction: `attest()` refuses (AttestError) unless all six proof checks are
// present and passed, every contender in the score is attested with a version (no subsets),
// and a CI only ever accompanies a gated (scored) total. The payload schema encodes the same
// rules (`pass: true` literals), so `verify()` rejects a payload that breaks them even if signed.
import { sign } from "node:crypto";
import { z } from "zod";
import { canonicalBytes } from "./canonical.js";
import { KeyIdSchema, SIGNATURE_ALG, type SigningKey } from "./keys.js";

export const ATTESTATION_SCHEMA = "anybench.attestation/v1";

/**
 * The six proof checks (plan.md P2), named as in core `KitProofSchema` where it has a key:
 * oracle passes; do-less fails the gate; smoke run passes on the real profile; planted
 * regression scores lower; known baselines land in range; no secret in the kit. Ids name the
 * check, not its expected outcome. All must pass before a run can be published.
 */
export const PROOF_CHECK_IDS = [
  "oracle",
  "do_less",
  "smoke",
  "planted_regression",
  "baseline_sanity",
  "no_secret",
] as const;
export type ProofCheckId = (typeof PROOF_CHECK_IDS)[number];

const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, { message: "lowercase sha256 hex" });
const IdSchema = z.string().min(1).max(200);

const GateTallySchema = z.strictObject({
  passed: z.int().min(0),
  failed: z.int().min(0),
  missing: z.int().min(0),
  total: z.int().min(0),
});

export const ConfidenceIntervalSchema = z
  .strictObject({
    lo: z.number(),
    hi: z.number(),
    level: z.number().gt(0).lt(1),
    estimate: z.number(),
  })
  .refine((ci) => ci.lo <= ci.hi, { message: "ci.lo must be <= ci.hi" });

const PassedProofCheckSchema = z.strictObject({
  pass: z.literal(true),
  detail: z.string().min(1).optional(),
});

const AttestedScoreBase = {
  contender_id: IdSchema,
  trials: z.int().min(0),
  gates: z.record(z.string().min(1), GateTallySchema),
};

export const AttestedScoreSchema = z.discriminatedUnion("scored", [
  z.strictObject({
    ...AttestedScoreBase,
    scored: z.literal(true),
    total: z.number().min(0).max(100),
    total_rounded: z.int().min(0).max(100),
    ci: ConfidenceIntervalSchema.nullable(),
  }),
  z.strictObject({
    ...AttestedScoreBase,
    scored: z.literal(false),
    total: z.null(),
    reason: z.string().min(1),
    blocked_by: z.array(z.string().min(1)),
    /** No number without a correctness gate: an unscored contender never carries a CI. */
    ci: z.null(),
  }),
]);
export type AttestedScore = z.infer<typeof AttestedScoreSchema>;

/**
 * Where the attestation is shown: the published benchmark and its immutable version. The
 * publish flow (12.2) always sets it. A verifier of a public page must check it matches the
 * page (`/b/<owner>/<slug>`, version shown), or a valid attestation could be replayed elsewhere.
 */
export const AttestedBenchmarkSchema = z.strictObject({
  owner: IdSchema,
  slug: IdSchema,
  version: z.int().min(1),
});
export type AttestedBenchmark = z.infer<typeof AttestedBenchmarkSchema>;

export const AttestationPayloadSchema = z
  .strictObject({
    schema: z.literal(ATTESTATION_SCHEMA),
    kit_hash: Sha256HexSchema,
    run_id: IdSchema.optional(),
    benchmark: AttestedBenchmarkSchema.optional(),
    /** A comped (free) run is published with a "comped" note. Always stated, never defaulted. */
    comped: z.boolean(),
    /** Why the run was comped. Only when `comped` is true. */
    comped_reason: z.string().min(1).max(500).optional(),
    contenders: z
      .array(z.strictObject({ contender_id: IdSchema, version: z.string().min(1) }))
      .min(1),
    snapshots: z.array(z.strictObject({ id: IdSchema, sha256: Sha256HexSchema })).min(1),
    trial_count: z.int().min(1),
    proof_checks: z.strictObject(
      Object.fromEntries(PROOF_CHECK_IDS.map((id) => [id, PassedProofCheckSchema])) as Record<
        ProofCheckId,
        typeof PassedProofCheckSchema
      >,
    ),
    scores: z.array(AttestedScoreSchema).min(1),
    /** Scored contender ids, best first (unscored contenders are never ranked). */
    ranking: z.array(IdSchema),
    issued_at: z.iso.datetime(),
    key_id: KeyIdSchema,
  })
  .refine((p) => p.comped || p.comped_reason === undefined, {
    message: "comped_reason only when comped is true",
    path: ["comped_reason"],
  });
export type AttestationPayload = z.infer<typeof AttestationPayloadSchema>;

export const SignedAttestationSchema = z.strictObject({
  payload: z.unknown(),
  alg: z.literal(SIGNATURE_ALG),
  key_id: KeyIdSchema,
  /** Ed25519 over `canonicalBytes(payload)`, standard base64. */
  signature: z.string().min(1),
});
export interface SignedAttestation {
  payload: AttestationPayload;
  alg: typeof SIGNATURE_ALG;
  key_id: string;
  signature: string;
}

// ── attest() input: @anybench/bench `scoreKit` output plus run facts ────────────────────────

const ScoreContenderInputBase = {
  contenderId: IdSchema,
  trials: z.int().min(0),
  gates: z.record(z.string().min(1), GateTallySchema),
};
/** Accepts @anybench/bench `ContenderScore` (extra fields such as `requirements` are ignored). */
const ScoreContenderInputSchema = z.discriminatedUnion("scored", [
  z.object({
    ...ScoreContenderInputBase,
    scored: z.literal(true),
    total: z.number().min(0).max(100),
    totalRounded: z.int().min(0).max(100),
  }),
  z.object({
    ...ScoreContenderInputBase,
    scored: z.literal(false),
    total: z.null(),
    reason: z.string().min(1),
    blockedBy: z.array(z.string().min(1)),
  }),
]);
/** Accepts @anybench/bench `KitScore`. */
export const KitScoreInputSchema = z.object({
  contenders: z.array(ScoreContenderInputSchema).min(1),
  ranking: z.array(IdSchema),
});

export const AttestInputSchema = z.strictObject({
  kitHash: Sha256HexSchema,
  runId: IdSchema.optional(),
  /** The published benchmark this attestation is for (set by the publish flow). */
  benchmark: AttestedBenchmarkSchema.optional(),
  /** Required: a comped run must say so. */
  comped: z.boolean(),
  compedReason: z.string().min(1).max(500).optional(),
  /** Every contender in the score, each with its pinned version. */
  contenders: z.array(z.strictObject({ id: IdSchema, version: z.string().min(1) })).min(1),
  snapshots: z.array(z.strictObject({ id: IdSchema, sha256: Sha256HexSchema })).min(1),
  /** Proof check id → result. Must contain all six, all passing. */
  proofChecks: z.record(
    z.string(),
    z.strictObject({ pass: z.boolean(), detail: z.string().min(1).optional() }),
  ),
  score: KitScoreInputSchema,
  /** Contender id → CI of its total. Only for scored contenders. */
  ci: z.record(z.string(), ConfidenceIntervalSchema).default({}),
});
export type AttestInput = z.input<typeof AttestInputSchema>;

export type AttestErrorCode =
  | "invalid_input"
  | "proof_check_missing"
  | "proof_check_failed"
  | "contender_mismatch"
  | "ci_without_score";

export class AttestError extends Error {
  override readonly name = "AttestError";
  constructor(
    readonly code: AttestErrorCode,
    message: string,
    /** e.g. the failing proof check ids, or `path: message` schema issues. */
    readonly details: readonly string[] = [],
  ) {
    super(details.length > 0 ? `${message}: ${details.join("; ")}` : message);
  }
}

const issues = (e: z.ZodError) =>
  e.issues.map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`);

export interface AttestOptions {
  /** Clock for `issued_at`. Default `new Date()`. */
  now?: Date;
}

/** Build the attestation payload (unsigned). Throws AttestError when the run can't be attested. */
export function buildAttestationPayload(
  input: AttestInput,
  keyId: string,
  opts: AttestOptions = {},
): AttestationPayload {
  const parsed = AttestInputSchema.safeParse(input);
  if (!parsed.success)
    throw new AttestError("invalid_input", "invalid attest input", issues(parsed.error));
  const inp = parsed.data;

  const unknownChecks = Object.keys(inp.proofChecks).filter(
    (id) => !(PROOF_CHECK_IDS as readonly string[]).includes(id),
  );
  if (unknownChecks.length > 0)
    throw new AttestError("invalid_input", "unknown proof checks", unknownChecks);
  const missing = PROOF_CHECK_IDS.filter((id) => inp.proofChecks[id] === undefined);
  if (missing.length > 0)
    throw new AttestError("proof_check_missing", "all six proof checks must run", missing);
  const failed = PROOF_CHECK_IDS.filter((id) => !inp.proofChecks[id]!.pass);
  if (failed.length > 0)
    throw new AttestError("proof_check_failed", "every proof check must pass to publish", failed);

  const versionOf = new Map<string, string>();
  for (const c of inp.contenders) {
    if (versionOf.has(c.id))
      throw new AttestError("contender_mismatch", "contender listed twice", [c.id]);
    versionOf.set(c.id, c.version);
  }
  const scoredIds = inp.score.contenders.map((c) => c.contenderId);
  if (new Set(scoredIds).size !== scoredIds.length)
    throw new AttestError("contender_mismatch", "contender scored twice");
  const notVersioned = scoredIds.filter((id) => !versionOf.has(id));
  const notScored = [...versionOf.keys()].filter((id) => !scoredIds.includes(id));
  if (notVersioned.length > 0 || notScored.length > 0)
    throw new AttestError(
      "contender_mismatch",
      "every contender must be both scored and versioned (no subsets)",
      [
        ...notVersioned.map((id) => `no version: ${id}`),
        ...notScored.map((id) => `no score: ${id}`),
      ],
    );

  const rankable = new Set(inp.score.contenders.filter((c) => c.scored).map((c) => c.contenderId));
  if (
    inp.score.ranking.length !== rankable.size ||
    !inp.score.ranking.every((id) => rankable.has(id))
  )
    throw new AttestError("invalid_input", "ranking must list exactly the scored contenders");

  for (const id of Object.keys(inp.ci)) {
    if (!scoredIds.includes(id))
      throw new AttestError("contender_mismatch", "CI for an unknown contender", [id]);
    if (!rankable.has(id))
      throw new AttestError("ci_without_score", "no number without a correctness gate", [id]);
  }

  const scores: AttestedScore[] = inp.score.contenders.map((c) =>
    c.scored
      ? {
          contender_id: c.contenderId,
          trials: c.trials,
          gates: c.gates,
          scored: true,
          total: c.total,
          total_rounded: c.totalRounded,
          ci: inp.ci[c.contenderId] ?? null,
        }
      : {
          contender_id: c.contenderId,
          trials: c.trials,
          gates: c.gates,
          scored: false,
          total: null,
          reason: c.reason,
          blocked_by: c.blockedBy,
          ci: null,
        },
  );

  const payload = {
    schema: ATTESTATION_SCHEMA,
    kit_hash: inp.kitHash,
    ...(inp.runId !== undefined ? { run_id: inp.runId } : {}),
    ...(inp.benchmark !== undefined ? { benchmark: { ...inp.benchmark } } : {}),
    comped: inp.comped,
    ...(inp.compedReason !== undefined ? { comped_reason: inp.compedReason } : {}),
    contenders: scoredIds.map((id) => ({ contender_id: id, version: versionOf.get(id)! })),
    snapshots: inp.snapshots.map((s) => ({ id: s.id, sha256: s.sha256 })),
    trial_count: scores.reduce((n, s) => n + s.trials, 0),
    proof_checks: Object.fromEntries(
      PROOF_CHECK_IDS.map((id) => {
        const d = inp.proofChecks[id]!.detail;
        return [id, d !== undefined ? { pass: true, detail: d } : { pass: true }];
      }),
    ),
    scores,
    ranking: inp.score.ranking,
    issued_at: (opts.now ?? new Date()).toISOString(),
    key_id: keyId,
  };
  const checked = AttestationPayloadSchema.safeParse(payload);
  if (!checked.success)
    throw new AttestError("invalid_input", "attestation payload invalid", issues(checked.error));
  return checked.data;
}

/** Ed25519 signature (standard base64) over the canonical JSON of `payload`. */
export function signPayload(payload: AttestationPayload, key: SigningKey): string {
  return sign(null, canonicalBytes(payload), key.privateKey).toString("base64");
}

/**
 * Freeze a scored run into a signed attestation. Throws AttestError (typed `code`) when the
 * run can't honestly be published: a proof check missing or failed, a contender subset, a CI
 * on an ungated contender, or malformed input.
 */
export function attest(
  input: AttestInput,
  key: SigningKey,
  opts: AttestOptions = {},
): SignedAttestation {
  const payload = buildAttestationPayload(input, key.keyId, opts);
  return { payload, alg: SIGNATURE_ALG, key_id: key.keyId, signature: signPayload(payload, key) };
}
