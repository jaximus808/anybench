// TDM-44 [4.12]: PipelinePort.prove for every kit (contract C3).
//
//   a curated Tandem kit    (files_url = kits/tandem-long-horizon or kits/tandem-vs-claude-code,
//                           or no files_url at all, as kits drafted before contract C1) →
//                           curatedProof: that kit's committed, signed-off offline proof.
//   any other kit           → load the kit from kits.files_url (file://), run the six proof checks
//                           (@anybench/kit runProofSuite) on the run's env: trials fork env.env_id,
//                           gates fork env.detail.scoring_snapshot_id (apps/server/src/jobs/
//                           proof-runner.ts), and return the ProofCheckResult[] the orchestrator
//                           stores on kits.proof. A failing kit goes back to the designer (repair
//                           ×2, then needs_human: advance.ts).
//
// Our failures are not the kit's: no provider, no env, a proof trial that could not run for infra
// reasons (a 403 on fork, a 429, the deadline) hold the run in needs_human with the reason instead
// of sending a good kit to the designer. Every computer the proof created is swept in `finally`.
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  KitLoadError,
  loadKit,
  runProofSuiteReport,
  type LoadedKit,
  type ProofRunner,
  type ProofSuiteDeps,
} from "@anybench/kit";
import { PROOF_CHECKS, type ProofCheckResult } from "@anybench/core";
import type { ComputeProvider } from "@anybench/providers";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { kits } from "../db/schema/kits.js";
import { drizzleComputerStore } from "../lib/computer-store.js";
import { kitSpecHash } from "../routes/kits.js";
import { CURATED_KIT_IDS, defaultKitsDir } from "../orchestrator/curated.js";
import {
  stageHold,
  stageOk,
  type EnvBuild,
  type PipelinePort,
  type StageContext,
} from "../orchestrator/ports.js";
import { curatedProof } from "../orchestrator/proof-score.js";
import { providerProofRunner, type ProviderProofRunnerOptions } from "./proof-runner.js";

export interface ProofStageOptions {
  db: Database;
  /** kits.files_url of a kit (default: read from `db`). */
  kitFilesUrl?: (kitId: string) => Promise<string | null>;
  /** The trials' provider (Naïve in production). Null: non-curated kits hold. */
  provider: ComputeProvider | null;
  /** ANYBENCH_KITS_DIR (the curated kits). */
  kitsDir?: string;
  /** The worker's configured secret values, matched exactly in every kit file. Never logged. */
  secretValues?: () => readonly string[];
  /** Naïve proxy keys + the per-trial cap ceiling, for agent contenders' proof trials. */
  naiveProxy?: ProviderProofRunnerOptions["naiveProxy"];
  proxyCapMicroUsd?: bigint;
  /** COMPUTER_BLOCK_PRICE_MICRO_USD, for the proof computers' rows. */
  pricePerBlockMicroUsd?: bigint;
  /** Suite bounds (concurrency, deadline, repeats). */
  suite?: Pick<
    ProofSuiteDeps,
    "concurrency" | "deadlineMs" | "regressionRepeats" | "gateRepeats" | "mutation"
  >;
  /** Tests: a runner instead of the provider one. */
  runner?: (o: ProviderProofRunnerOptions) => ProofRunner & { sweep?: () => Promise<string[]> };
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

async function say(ctx: StageContext, text: string): Promise<void> {
  await ctx.emit([
    {
      type: "agent.message",
      source: "agent_session",
      source_id: "proof:suite",
      severity: "info",
      actor: { kind: "system" },
      cost_delta_micro_usd: 0n,
      at: new Date().toISOString(),
      payload: {
        agent_role: "proof",
        naive_seq: 0,
        message_role: "system",
        text,
        truncated: false,
      },
    },
  ]);
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Every check failed with the same reason (the kit itself is broken: the designer repairs it). */
function allFailed(reason: string): ProofCheckResult[] {
  return PROOF_CHECKS.map((check) => ({ check, pass: false, reason, evidence: [] }));
}

/** One line per failed check: `<check>: <reason>` (what needs_human and the repair loop show). */
export function failedChecksSummary(proof: readonly ProofCheckResult[], max = 1500): string {
  const lines = proof.filter((p) => !p.pass).map((p) => `${p.check} (${p.reason})`);
  const text = lines.length > 0 ? lines.join("; ") : "missing checks";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function filesUrlFromDb(db: Database) {
  return async (kitId: string): Promise<string | null> => {
    const [row] = await db.select({ filesUrl: kits.filesUrl }).from(kits).where(eq(kits.id, kitId));
    return row?.filesUrl ?? null;
  };
}

export function proofStage(opts: ProofStageOptions): PipelinePort["prove"] {
  const curated = curatedProof(opts.kitsDir ? { kitsDir: opts.kitsDir } : {});
  const curatedDirs = new Set(
    CURATED_KIT_IDS.map((id) => real(path.join(defaultKitsDir(opts.kitsDir), id))),
  );
  const log = opts.log ?? (() => undefined);

  return async (ctx, input) => {
    const filesUrl = await (opts.kitFilesUrl ?? filesUrlFromDb(opts.db))(input.kit_id);
    // The curated kit keeps its signed-off offline proof (and so does a pre-C1 kit row).
    if (
      filesUrl === null ||
      (filesUrl.startsWith("file://") && curatedDirs.has(real(fileURLToPath(filesUrl))))
    ) {
      return curated(ctx, input);
    }
    if (!filesUrl.startsWith("file://")) {
      return stageHold(
        `proof: kit ${input.kit_id} has no file:// files_url (${filesUrl}); the proof suite reads the kit's files from disk`,
      );
    }

    let kit: LoadedKit;
    try {
      kit = await loadKit(fileURLToPath(filesUrl));
    } catch (err) {
      if (!(err instanceof KitLoadError)) throw err;
      // The designer's kit does not load: every check fails with why, and the designer repairs it.
      return stageOk(allFailed(`the kit does not load: ${err.message}`.slice(0, 1500)));
    }
    // The stored spec is the truth (a user edit, a smoke cut); the files come from the kit dir.
    if (kitSpecHash(kit.spec) !== kitSpecHash(input.kit)) kit = { ...kit, spec: input.kit };

    const env: EnvBuild | null = input.env;
    if (!env?.env_id)
      return stageHold("proof needs the run's built env image (env_build did not produce one)");
    if (!opts.provider && !opts.runner)
      return stageHold("proof: no compute provider is configured (NAIVE_API_KEY)");

    const runnerOpts: ProviderProofRunnerOptions = {
      provider: opts.provider!,
      kit,
      env,
      runId: ctx.run.id,
      store: drizzleComputerStore(opts.db),
      ...(opts.pricePerBlockMicroUsd !== undefined
        ? { pricePerBlockMicroUsd: opts.pricePerBlockMicroUsd }
        : {}),
      log,
      ...(opts.naiveProxy ? { naiveProxy: opts.naiveProxy } : {}),
      ...(opts.proxyCapMicroUsd !== undefined ? { proxyCapMicroUsd: opts.proxyCapMicroUsd } : {}),
    };
    const runner = opts.runner ? opts.runner(runnerOpts) : providerProofRunner(runnerOpts);
    await say(
      ctx,
      `proof: running the six checks on ${kit.spec.subject.name} (${kit.spec.workloads.length} workload(s))`,
    );
    let report;
    try {
      report = await runProofSuiteReport(kit, {
        runner,
        secretValues: opts.secretValues?.() ?? [],
        signal: ctx.signal,
        log,
        ...opts.suite,
      });
    } finally {
      const left = (await runner.sweep?.().catch(() => [])) ?? [];
      if (left.length > 0) log("proof: swept leftover computers", { computers: left });
    }
    const failed = report.checks.filter((c) => !c.pass);
    // A check that did not run for OUR reasons: hold, never blame (and repair) the kit.
    const heldForInfra = failed.filter(
      (c) =>
        c.reason.startsWith("not run:") && !c.reason.startsWith("not run: the kit holds a secret"),
    );
    if (heldForInfra.length > 0 && report.infra.length > 0) {
      const why = report.infra.slice(0, 3).join("; ");
      await say(ctx, `proof could not run (ours, not the kit): ${why}`);
      return stageHold(`proof could not run (ours, not the kit): ${why}`.slice(0, 1900));
    }
    await say(
      ctx,
      failed.length === 0
        ? `proof: all six checks passed (${report.trials} trial(s), ${report.gateRuns} gate run(s))`
        : `proof failed: ${failedChecksSummary(report.checks, 600)}`,
    );
    return stageOk(report.checks);
  };
}

/** The worker's configured secret values (config + process env), for the exact-value scan. */
export function configuredSecretValues(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const secretName = /(SECRET|PASSWORD|TOKEN|API_KEY|ACCESS_KEY|PRIVATE_KEY|^DATABASE_URL|_DSN$)/;
  const values = new Set<string>();
  for (const [k, v] of [...Object.entries(config), ...Object.entries(env)]) {
    if (typeof v === "string" && v.length >= 8 && secretName.test(k)) values.add(v);
  }
  return [...values];
}
