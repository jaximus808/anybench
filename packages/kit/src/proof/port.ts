// TDM-44 [4.12]: the proof suite's runner port. The suite decides WHAT to run; the port runs it.
//
//   runTrial   one contender (optionally under a proof overlay) on one workload, on a FRESH fork
//              of the subject image → the frozen outputs (`out.tar.gz`) + the trial's metric rows.
//   runGates   the kit's gates on one frozen bundle, on a FRESH scoring computer (never one that
//              held the subject) → one verdict per gate.
//
// The server's implementation (apps/server/src/jobs/proof-runner.ts) drives the real trial path:
// bench executeTrial + the runner binary on a fork of env.env_id, then bench runGates on a fork of
// env.detail.scoring_snapshot_id, so proof measures exactly what trials measure. It works on any
// ComputeProvider (docker-local in tests, Naïve live). Tests of the suite logic use a fake.
import { z } from "zod";
import type { ProofOverlay } from "@anybench/core";

/** One metric row of a trial (bench `Metric`, matched structurally: kit cannot import bench). */
export const ProofMetricSchema = z.object({
  name: z.string().min(1),
  value: z.number(),
  /** The gate that vouches for the value (bench linkGates); absent for unlinked rows. */
  gate_id: z.string().min(1).optional(),
  /** `trial` rows only are used; others (e.g. per-run hyperfine rows) are ignored. */
  level: z.string().optional(),
});
export type ProofMetric = z.infer<typeof ProofMetricSchema>;

export const ProofTrialStatusSchema = z.enum([
  /** The runner finished and froze the outputs. */
  "ok",
  /** The subject (or the overlay) failed; outputs may still be frozen. */
  "subject_failed",
  /** Our side broke (computer, fork, runner): not the kit's verdict. */
  "infra_failed",
]);
export type ProofTrialStatus = z.infer<typeof ProofTrialStatusSchema>;

export const ProofTrialOutcomeSchema = z.object({
  status: ProofTrialStatusSchema,
  /** Short structural note (exit code, failure class). Never a metric value. */
  detail: z.string(),
  /** The frozen outputs (tar.gz), when the runner froze them. */
  bundle: z.custom<Uint8Array>((v) => v instanceof Uint8Array).nullable(),
  metrics: z.array(ProofMetricSchema).default([]),
});
export type ProofTrialOutcome = z.infer<typeof ProofTrialOutcomeSchema>;

export const ProofGateVerdictSchema = z.object({
  pass: z.boolean(),
  /** The gate's own reason (untrusted text from check.sh). */
  reason: z.string(),
  applicable: z.boolean().default(true),
  /** bench GateOutcomeStatus: `verdict` when check.sh wrote a valid gate.json. */
  status: z.string().default("verdict"),
  /** The FAIL may be the kit's fault (the check broke). */
  kit_suspect: z.boolean().default(false),
});
export type ProofGateVerdict = z.infer<typeof ProofGateVerdictSchema>;

export const ProofGateOutcomeSchema = z.object({
  gates: z.record(z.string(), ProofGateVerdictSchema),
});
export type ProofGateOutcome = z.infer<typeof ProofGateOutcomeSchema>;

/** What one proof trial runs. */
export interface ProofTrialRequest {
  /** e.g. `oracle.grep-reference.literal-search`: unique per request, for tags and logs. */
  label: string;
  contenderId: string;
  workloadId: string;
  /** A proof overlay (oracle, do_less[], regression) applied to the contender. */
  overlay: ProofOverlay | null;
}

export interface ProofGateRequest {
  label: string;
  workloadId: string;
  /** Gate ids to run (all must be kit gates). */
  gateIds: readonly string[];
  /** The frozen outputs; null = missing (every gate fails closed). */
  bundle: Uint8Array | null;
}

export interface ProofRunner {
  runTrial(req: ProofTrialRequest, signal?: AbortSignal): Promise<ProofTrialOutcome>;
  runGates(req: ProofGateRequest, signal?: AbortSignal): Promise<ProofGateOutcome>;
}

/** Thrown by a runner for OUR failure (no computer, broken fork): the check is "not run", not failed by the kit. */
export class ProofInfraError extends Error {
  override readonly name = "ProofInfraError";
}
