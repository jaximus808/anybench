// What a harness driver needs from the kit beyond its own driver.env (TDM-41 [4.9]). run.sh can't
// read anybench.yaml (it never reaches the subject computer), so the trial job carries these.
import { isAgentDriver, type KitSpec } from "@anybench/core";

export const HARNESS_ENV = {
  /** human_in_loop.kind: `tandem` (board approvals) or `naive`. */
  kind: "ANYBENCH_HIL_KIND",
  /** human_in_loop.policy: `auto`, `llm-reviewer` or `human-sim`; the approver sidecar applies it. */
  policy: "ANYBENCH_HIL_POLICY",
  /** The trial's wall-clock cap in seconds; run.sh stops everything before it to collect. */
  wallCap: "ANYBENCH_WALL_CAP_S",
} as const;

export class HarnessEnvError extends Error {
  override readonly name = "HarnessEnvError";
}

/**
 * Env for one harness trial: the kit's human_in_loop and the wall-clock cap the runner enforces
 * (the workload's `timeout_s`, else the driver's `wall_clock_cap_s`, the same rule as bench
 * `trialJobFromKit`). Empty for a contender whose driver is not a harness.
 */
export function harnessDriverEnv(
  kit: KitSpec,
  contenderId: string,
  workloadId?: string,
): Record<string, string> {
  const c = kit.contenders.find((x) => x.id === contenderId);
  if (!c) throw new HarnessEnvError(`kit has no contender '${contenderId}'`);
  if (c.driver.type !== "harness") return {};
  const hil = kit.human_in_loop;
  if (!hil)
    throw new HarnessEnvError(
      `contender '${contenderId}' is a harness but the kit has no human_in_loop`,
    );
  const w = workloadId === undefined ? undefined : kit.workloads.find((x) => x.id === workloadId);
  if (workloadId !== undefined && !w)
    throw new HarnessEnvError(`kit has no workload '${workloadId}'`);
  const cap = w?.timeout_s ?? c.driver.wall_clock_cap_s;
  return {
    [HARNESS_ENV.kind]: hil.kind,
    [HARNESS_ENV.policy]: hil.policy,
    ...(cap === undefined ? {} : { [HARNESS_ENV.wallCap]: String(cap) }),
  };
}

// ---------------------------------------------------------------------------------------------
// Everything the kit says a contender's adapter scripts get (TDM-41, for every driver type).

/** One `vary` setup of a contender: its id in scores (`tandem@TANDEM_WORKERS=3`) and its env. */
export interface VarySetup {
  contenderId: string;
  setupId: string;
  env: Record<string, string>;
}

/**
 * Expand the kit's `vary` into setups for one contender. A vary key expands only the contenders
 * whose `driver.env` declares it (the flagship kit's convention: Tandem declares TANDEM_WORKERS,
 * the Claude Code contenders don't, so they are not duplicated). Several keys: their cross
 * product, in key order. No declared key: one setup, the contender itself, with no extra env.
 */
export function expandVarySetups(kit: KitSpec, contenderId: string): VarySetup[] {
  const c = kit.contenders.find((x) => x.id === contenderId);
  if (!c) throw new HarnessEnvError(`kit has no contender '${contenderId}'`);
  const keys = Object.keys(kit.vary).filter((k) => c.driver.env?.[k] !== undefined);
  let combos: [string, string][][] = [[]];
  for (const k of keys)
    combos = combos.flatMap((prefix) =>
      (kit.vary[k] ?? []).map((v) => [...prefix, [k, String(v)] as [string, string]]),
    );
  return combos.map((pairs) => ({
    contenderId,
    setupId:
      pairs.length === 0
        ? contenderId
        : `${contenderId}@${pairs.map(([k, v]) => `${k}=${v}`).join(",")}`,
    env: Object.fromEntries(pairs),
  }));
}

/** The pinned model id, for adapters that read it from the env (`driver.model`). */
export const DRIVER_MODEL_ENV = "ANYBENCH_MODEL";

/**
 * The env one trial's adapter scripts get from the kit, in increasing precedence:
 * `versions` (keyed by the env var the scripts read, e.g. CLAUDE_CODE_VERSION, TANDEM_MCP_VERSION),
 * `driver.model` as ANYBENCH_MODEL (and as CC_MODEL for Claude Code-based drivers unless
 * driver.env sets it), the harness env (human_in_loop, cap), `driver.env`, then the `vary` setup.
 */
export function contenderDriverEnv(
  kit: KitSpec,
  contenderId: string,
  workloadId?: string,
  setup?: Readonly<Record<string, string>>,
): Record<string, string> {
  const c = kit.contenders.find((x) => x.id === contenderId);
  if (!c) throw new HarnessEnvError(`kit has no contender '${contenderId}'`);
  const model = isAgentDriver(c.driver) ? c.driver.model : undefined;
  const claudeCodeBased = c.driver.type === "coding-agent" || c.driver.type === "harness";
  return {
    ...c.versions,
    ...(model === undefined ? {} : { [DRIVER_MODEL_ENV]: model }),
    ...(model !== undefined && claudeCodeBased ? { CC_MODEL: model } : {}),
    ...harnessDriverEnv(kit, contenderId, workloadId),
    ...c.driver.env,
    ...setup,
  };
}
