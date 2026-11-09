// trial.execute's TrialSource (TDM-54, completed for real trials on Naïve): the run's kit → the
// runner job, the computer (fork of the run's env image, at the kit's size), and the trial's
// Naïve proxy key.
//
// What a trial computer looks like (env build, orchestrator/env-build.ts):
//   ~/.anybench/bin/runner   the runner
//   ~/kit/adapters/…         the subject files; every verb runs here (driver.cwd = kit)
//   ~/kit/workloads/…        the workloads (input, instruction, setup; no answers live there)
// Per trial, the `start` verb is prefixed with the L3 workspace prep (as the TDM-36 / TDM-41 stubs
// do it): copy the input to EVAL_IN, the instruction to EVAL_IN/instruction.md, then setup.sh
// builds EVAL_WS (or the input becomes a one-commit git repo). `{in}`, `{out}`, `{workspace}`,
// `{task}` in the verbs become "$EVAL_IN", "$EVAL_OUT", "$EVAL_WS", "$EVAL_IN/instruction.md".
//
// Model tokens (AB_TOKEN_SOURCE=naive_proxy in driver.env, every Tandem-kit contender): the source
// asks the executor for a per-trial Naïve proxy key (TrialPrepared.naive_proxy: model + cap); the
// executor (TDM-39) mints it with TDM-16's provisionClaudeCodeProxyEnv, enforces the cap and
// revokes it on every path.
//
// TDM-212: AB_TOKEN_SOURCE=anthropic_key (BYOK, e.g. kits/tandem-long-horizon): the run owner's
// stored Anthropic key (user_secrets, provider `anthropic`, lib/byok.ts) is decrypted right here
// and handed to the executor as the trial's ANTHROPIC_API_KEY secret, which it writes to
// ~/.anybench/env (0600); the runner exports it to the driver and redacts it everywhere. No stored
// key (or no ANYBENCH_KEK) refuses the trial: it never falls back to another key.
import { trialJobFromKit, type TrialPrepared, type TrialSource } from "@anybench/bench";
import {
  driverTokenCapTokens,
  isAgentDriver,
  safeParseKitSpec,
  type KitSpec,
} from "@anybench/core";
import { KIT_DIR_REL } from "@anybench/envs";
import { expandVarySetups, KIT_LAYOUT } from "@anybench/kit";
import { shellQuote } from "@anybench/providers";
import { and, eq, isNotNull } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { ANTHROPIC_PROVIDER, type ByokLookup } from "../lib/byok.js";
import { contenders } from "../db/schema/contenders.js";
import { kits } from "../db/schema/kits.js";
import { runs } from "../db/schema/runs.js";
import { trials } from "../db/schema/trials.js";
import { kitComputerSize, type EnvBuildDetail } from "./env-build.js";
import { RunStageOutputsShape } from "./ports.js";

/** Per-trial proxy spend ceiling when nothing else says (the smoke profile): $3. */
export const DEFAULT_TRIAL_PROXY_CAP_MICRO_USD = 3_000_000n;
/** List price used to turn a token cap into money: Sonnet input, $3 / Mtok = 3 µ$ per token. */
export const TOKEN_CAP_MICRO_USD_PER_TOKEN = 3n;

export interface KitTrialSourceOptions {
  /** The ceiling of every trial's proxy cap (TRIAL_PROXY_CAP_MICRO_USD). Default $3. */
  proxyCapMicroUsd?: bigint;
  /** TDM-212: the run owner's stored BYOK key (lib/byok.ts byokLookup); unset without a KEK. */
  byok?: ByokLookup;
}

/** The secret name an anthropic_key driver reads (kits' `secrets: [ANTHROPIC_API_KEY]`). */
export const ANTHROPIC_KEY_SECRET = "ANTHROPIC_API_KEY";

/** The trial's proxy cap: the driver's spend cap, else its token cap at list price; never above the ceiling. */
export function trialProxyCap(
  driver: KitSpec["contenders"][number]["driver"],
  ceiling: bigint = DEFAULT_TRIAL_PROXY_CAP_MICRO_USD,
): bigint {
  let cap = ceiling;
  if (isAgentDriver(driver)) {
    if (driver.token_cap_micro_usd !== undefined) cap = BigInt(driver.token_cap_micro_usd);
    else {
      const tokens = driverTokenCapTokens(driver);
      if (tokens !== undefined) cap = BigInt(tokens) * TOKEN_CAP_MICRO_USD_PER_TOKEN;
    }
  }
  return cap < ceiling ? cap : ceiling;
}

const PLACEHOLDERS: Record<string, string> = {
  in: '"$EVAL_IN"',
  out: '"$EVAL_OUT"',
  workspace: '"$EVAL_WS"',
  task: '"$EVAL_IN/instruction.md"',
};

/** `{in}` → "$EVAL_IN" etc.: the runner gives every verb these env vars. */
export function substituteVerb(cmd: string): string {
  return cmd.replace(/\{(in|out|workspace|task)\}/g, (_m, k: string) => PLACEHOLDERS[k]!);
}

/** The L3 workspace prep, run from ~/kit before the driver's own `start`. */
export function workspacePrep(spec: KitSpec, workloadId: string): string {
  const w = spec.workloads.find((x) => x.id === workloadId);
  if (!w) throw new Error(`kit has no workload ${workloadId}`);
  const input = w.input ?? KIT_LAYOUT.workloadInput(workloadId);
  const lines = [
    'mkdir -p "$EVAL_IN" "$EVAL_WS"',
    `if [ -d ${shellQuote(input)} ]; then cp -R ${shellQuote(input.replace(/\/+$/, ""))}/. "$EVAL_IN/"; fi`,
  ];
  if (w.instruction) lines.push(`cp ${shellQuote(w.instruction)} "$EVAL_IN/instruction.md"`);
  if (w.setup) {
    lines.push(`bash ${shellQuote(w.setup)} "$EVAL_WS"`);
  } else {
    lines.push(
      'cp -R "$EVAL_IN/." "$EVAL_WS/" && rm -f "$EVAL_WS/instruction.md"',
      'if command -v git >/dev/null 2>&1; then git -C "$EVAL_WS" init -q && git -C "$EVAL_WS" add -A && git -C "$EVAL_WS" -c user.name=kit -c user.email=kit@anybench.invalid commit -qm start; fi',
    );
  }
  return lines.join(" && ");
}

/** The one `vary` setup of a contender (the trial row has no setup column yet). */
function setupOf(spec: KitSpec, contenderId: string): Record<string, string> | undefined {
  const setups = expandVarySetups(spec, contenderId);
  if (setups.length === 1) return setups[0]!.env;
  throw new Error(
    `contender ${contenderId} has ${setups.length} vary setups; trials do not record theirs yet`,
  );
}

/** Build the runner job for a trial of the run's kit on the built env. */
export function preparedJob(
  spec: KitSpec,
  contenderId: string,
  workloadId: string,
  env: Partial<EnvBuildDetail> | null,
): TrialPrepared["job"] {
  const job = trialJobFromKit(spec, contenderId, workloadId, setupOf(spec, contenderId));
  const d = job.driver;
  const prep = workspacePrep(spec, workloadId);
  const recipeEnv: Record<string, string> = { ...(env?.env ?? {}) };
  if (env?.path && env.path.length > 0) {
    recipeEnv.PATH = `${env.path.join(":")}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
  }
  return {
    ...job,
    driver: {
      ...d,
      cwd: env?.kit_dir ?? KIT_DIR_REL,
      run: substituteVerb(d.run),
      start: d.start ? `${prep} && ${substituteVerb(d.start)}` : prep,
      ...(d.ready ? { ready: substituteVerb(d.ready) } : {}),
      ...(d.stop ? { stop: substituteVerb(d.stop) } : {}),
    },
    // The recipes' env first: the kit's own env wins.
    env: { ...recipeEnv, ...(job.env ?? {}) },
  };
}

export function kitTrialSource(db: Database, options: KitTrialSourceOptions = {}): TrialSource {
  return {
    async prepare(trial) {
      const [row] = await db
        .select({
          spec: kits.spec,
          stageOutputs: runs.stageOutputs,
          contender: contenders.source,
          foundBy: contenders.foundBy,
          workloadId: trials.workloadId,
          ownerId: runs.ownerId,
        })
        .from(trials)
        .innerJoin(runs, eq(runs.id, trials.runId))
        .innerJoin(kits, eq(kits.id, runs.kitId))
        .innerJoin(contenders, eq(contenders.id, trials.contenderId))
        .where(and(eq(trials.id, trial.id), isNotNull(runs.kitId)))
        .limit(1);
      if (!row) throw new Error(`trial ${trial.id}: no run kit to prepare it from`);
      if (row.foundBy !== "kit")
        throw new Error(`trial ${trial.id}: contender is not a kit contender`);
      const parsed = safeParseKitSpec(row.spec);
      if (!parsed.success) throw new Error(`trial ${trial.id}: the run's kit no longer validates`);
      const spec = parsed.data;
      const outputs = RunStageOutputsShape.safeParse(row.stageOutputs);
      const built = outputs.success ? outputs.data.env : undefined;
      const snapshotId = built?.env_id ?? null;
      const detail = (built?.detail ?? null) as Partial<EnvBuildDetail> | null;
      const job = preparedJob(spec, row.contender, row.workloadId, snapshotId ? detail : null);
      const prepared: TrialPrepared = {
        job,
        computer: {
          ...kitComputerSize(spec),
          ...(snapshotId ? { snapshotId } : {}),
        },
        secrets: {},
      };

      // Model tokens through the Naïve proxy: the executor (TDM-39) mints the per-trial key at
      // launch, writes ~/.anybench/proxy.env, enforces this cap each poll and revokes the key at
      // the end of the attempt; ExecutorDeps.onProxyKeyMinted stores its id on the trial.
      if (job.env?.AB_TOKEN_SOURCE === "naive_proxy") {
        const contender = spec.contenders.find((c) => c.id === row.contender)!;
        const model =
          (isAgentDriver(contender.driver) ? contender.driver.model : undefined) ??
          job.env.CC_MODEL ??
          job.env.ANTHROPIC_MODEL;
        if (!model) throw new Error(`contender ${contender.id}: no model for the Naïve proxy`);
        const small = job.env.ANTHROPIC_SMALL_FAST_MODEL;
        prepared.naive_proxy = {
          model,
          ...(small ? { smallFastModel: small } : {}),
          capMicroUsd: trialProxyCap(contender.driver, options.proxyCapMicroUsd),
        };
      }

      // BYOK: our own (the run owner's) Anthropic key for every trial of the run.
      if (job.env?.AB_TOKEN_SOURCE === "anthropic_key") {
        if (!options.byok)
          throw new Error(
            `trial ${trial.id}: the kit uses AB_TOKEN_SOURCE=anthropic_key but ANYBENCH_KEK is not set, so no stored key can be read`,
          );
        const key = await options.byok(row.ownerId, ANTHROPIC_PROVIDER);
        if (!key)
          throw new Error(
            `trial ${trial.id}: the run owner has no stored Anthropic key (user_secrets provider ${ANTHROPIC_PROVIDER})`,
          );
        prepared.secrets[ANTHROPIC_KEY_SECRET] = key;
      }
      return prepared;
    },
  };
}
