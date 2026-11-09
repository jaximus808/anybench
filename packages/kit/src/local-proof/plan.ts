// TDM-219 [19.3]: what the local proof runs, from a validated kit (pure; no Docker here).
//
// The local proof is the fast, free, laptop-side half of the proof: two of the six checks, on
// every workload, with no agent, no model tokens and no network:
//   oracle_passes      the oracle overlay (a driver_patch that applies a reference solution)
//                      passes every gate it covers on every workload
//   do_nothing_fails   the untouched starting workspace (no driver runs at all) fails some gate
//                      on every workload: a gate a do-nothing passes measures nothing
// Anybench reruns the full proof (all six checks, on its own computers) on every uploaded kit;
// passing locally is never trusted as is.
import { isAgentDriver, type KitSpec } from "@anybench/core";
import { canonicalKitPath } from "../hash.js";
import { KIT_LAYOUT, normalizeKitPath } from "../layout.js";
import { contenderDriverEnv } from "../drivers/harness/env.js";
import type { LoadedKit } from "../validate.js";

/** The local proof's two checks (a subset of core PROOF_CHECKS, plus the do-nothing baseline). */
export const LOCAL_PROOF_CHECKS = ["oracle_passes", "do_nothing_fails"] as const;
export type LocalProofCheckName = (typeof LOCAL_PROOF_CHECKS)[number];

export const LOCAL_PROOF_VARIANTS = ["oracle", "do-nothing"] as const;
export type LocalProofVariant = (typeof LOCAL_PROOF_VARIANTS)[number];

/** Default per-step timeouts when the kit sets none. */
export const LOCAL_PROOF_DEFAULT_WORKLOAD_TIMEOUT_S = 1800;
export const LOCAL_PROOF_DEFAULT_GATE_TIMEOUT_S = 600;

export class LocalProofError extends Error {
  override readonly name = "LocalProofError";
  constructor(
    readonly code: "not_runnable",
    message: string,
  ) {
    super(message);
  }
}

export interface LocalProofWorkloadPlan {
  id: string;
  /** Kit-relative; copied to EVAL_IN when it exists. */
  input: string;
  instruction?: string;
  setup?: string;
  timeoutS: number;
}

export interface LocalProofGatePlan {
  id: string;
  /** Kit-relative check.sh. */
  check: string;
  /** Kit-relative reference dir, when the gate has one outside gates/<id>/. */
  reference?: string;
  timeoutS: number;
}

export interface LocalProofOraclePlan {
  overlayId: string;
  contenderId: string;
  /** The contender's driver path, which the driver_patch replaces (as on Anybench computers). */
  driver: string;
  driverPatch: string;
  /** The overlay's own dir (e.g. `proof/oracle`), shipped to the subject side for this run only. */
  overlayDir: string;
  /** Verbs, with `{in}` `{out}` `{workspace}` `{task}` already substituted to "$EVAL_*". */
  verbs: { start?: string; ready?: string; run: string; stop?: string };
  /** The contender's driver env (versions, model, driver.env) with the overlay's env on top. */
  env: Record<string, string>;
  /** Gates the oracle must pass. */
  gates: string[];
}

export interface LocalProofPlan {
  oracle: LocalProofOraclePlan;
  workloads: LocalProofWorkloadPlan[];
  gates: LocalProofGatePlan[];
  /** The kit's `collect` globs, relative to EVAL_WS, copied to EVAL_OUT/artifacts. */
  collect: string[];
}

const PLACEHOLDERS: Record<string, string> = {
  in: '"$EVAL_IN"',
  out: '"$EVAL_OUT"',
  workspace: '"$EVAL_WS"',
  task: '"$EVAL_IN/instruction.md"',
};

/** `{in}` → "$EVAL_IN" etc., exactly as the trial source does on Anybench computers. */
export function substituteLocalVerb(cmd: string): string {
  return cmd.replace(/\{(in|out|workspace|task)\}/g, (_m, k: string) => PLACEHOLDERS[k]!);
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function firstSubject(spec: KitSpec): string | undefined {
  return spec.contenders.find((c) => c.role === "subject")?.id ?? spec.contenders[0]?.id;
}

/**
 * Plan the local proof of a validated kit. Throws LocalProofError(`not_runnable`) when the kit has
 * no oracle that can run without the real subject: the oracle must be a `driver_patch` (a
 * replacement driver that applies a reference solution, like the coding-agent template's).
 */
export function planLocalProof(kit: LoadedKit): LocalProofPlan {
  const spec = kit.spec;
  const oracle = spec.proof.oracle;
  if (oracle === undefined) {
    throw new LocalProofError(
      "not_runnable",
      "the kit declares no proof.oracle; add one (a driver_patch that applies a reference solution)",
    );
  }
  const contenderId = oracle.contender ?? firstSubject(spec);
  const contender = spec.contenders.find((c) => c.id === contenderId);
  const resolved = kit.contenders.find((c) => c.id === contenderId);
  if (contender === undefined || resolved === undefined) {
    throw new LocalProofError(
      "not_runnable",
      `proof.oracle: no contender '${String(contenderId)}'`,
    );
  }
  if (oracle.driver_patch === undefined) {
    throw new LocalProofError(
      "not_runnable",
      `proof.oracle '${oracle.id}' has no driver_patch, so it runs contender '${contender.id}'${
        isAgentDriver(contender.driver) ? " (an agent)" : ""
      } for real, which needs its install step on Anybench computers. The local proof runs oracles that are a standalone driver_patch applying a reference solution (see the coding-agent template); push the kit to prove it remotely.`,
    );
  }
  const driverPatch = canonicalKitPath(oracle.driver_patch);
  const driver = canonicalKitPath(resolved.driver);
  if (driverPatch === undefined || driver === undefined) {
    throw new LocalProofError("not_runnable", `proof.oracle '${oracle.id}': bad driver paths`);
  }
  for (const forbidden of [KIT_LAYOUT.gatesDir, KIT_LAYOUT.referenceDir]) {
    if (driverPatch.startsWith(`${forbidden}/`)) {
      throw new LocalProofError(
        "not_runnable",
        `proof.oracle '${oracle.id}': driver_patch may not come from ${forbidden}/`,
      );
    }
  }
  const env: Record<string, string> = {
    ...contenderDriverEnv(spec, contender.id),
    ...oracle.env,
  };
  for (const k of Object.keys(env)) {
    if (!ENV_NAME.test(k)) throw new LocalProofError("not_runnable", `bad env name: ${k}`);
  }
  const v = contender.driver.verbs;
  const gates = kit.gates.map((g) => {
    const gs = spec.gates.find((x) => x.id === g.id);
    const ref = g.reference === undefined ? undefined : normalizeKitPath(g.reference);
    return {
      id: g.id,
      check: normalizeKitPath(g.check),
      ...(ref !== undefined && !ref.startsWith(`${KIT_LAYOUT.gatesDir}/`)
        ? { reference: ref }
        : {}),
      timeoutS: gs?.timeout_s ?? LOCAL_PROOF_DEFAULT_GATE_TIMEOUT_S,
    };
  });
  return {
    oracle: {
      overlayId: oracle.id,
      contenderId: contender.id,
      driver,
      driverPatch,
      overlayDir: normalizeKitPath(oracle.dir),
      verbs: {
        ...(v.start ? { start: substituteLocalVerb(v.start) } : {}),
        ...(v.ready ? { ready: substituteLocalVerb(v.ready) } : {}),
        run: substituteLocalVerb(v.run),
        ...(v.stop ? { stop: substituteLocalVerb(v.stop) } : {}),
      },
      env,
      gates: oracle.gates ?? gates.map((g) => g.id),
    },
    workloads: spec.workloads.map((w) => ({
      id: w.id,
      input: normalizeKitPath(w.input ?? KIT_LAYOUT.workloadInput(w.id)),
      ...(w.instruction ? { instruction: normalizeKitPath(w.instruction) } : {}),
      ...(w.setup ? { setup: normalizeKitPath(w.setup) } : {}),
      timeoutS:
        w.timeout_s ?? contender.driver.wall_clock_cap_s ?? LOCAL_PROOF_DEFAULT_WORKLOAD_TIMEOUT_S,
    })),
    gates,
    collect: [...spec.collect],
  };
}
