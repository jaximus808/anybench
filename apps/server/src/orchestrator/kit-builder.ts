// TDM-56 [6.2]: the kit builder's agent stages (contract C5's AgentStagePort seam).
//
//   kitBuilderStages({db, client, ...}) : AgentStagePort
//     Tandem repo (github.com/jaximus808/tandem) → curatedKitStages, untouched: curated understand,
//       research, designKit and analyze, and no Naïve session.
//     Any other repo:
//       understand  the Naïve understander (packages/agents/understander) through runAgentStage,
//                   on the digest + the repo context (repo-ingest-cache.ts, re-ingested on a miss),
//                   then the verdict rules IN CODE (@anybench/agents decideUnderstanding): an
//                   unsupported driver holds ("driver <type> is not supported yet: <why>"),
//                   needs_hardware holds, skip fails. A broken kit never goes downstream.
//       research    pass-through for v1 (no baselines), with an event saying so.
//       designKit   `opts.designKit` when given, else the Naïve kit designer (TDM-60,
//                   kit-designer.ts): a supported cli → a generated, validated kit written to
//                   ANYBENCH_GENERATED_KITS_DIR/<run>/v<n> (files_dir); coding-agent / harness hold
//                   until the history miner lands; an unsupported driver holds with the
//                   understander's reason.
//       analyze     the curated stage (not built for other repos: [6.8]).
//
// run-advance.ts uses `defaultAgentStages(ctx)`: kitBuilderStages when NAIVE_API_KEY is
// configured, curatedKitStages otherwise.
import {
  buildUnderstanderInput,
  decideUnderstanding,
  UNDERSTANDER_ROLE,
  UnderstanderOutputSchema,
  type RoleSpecOverrides,
  type UnderstandVerdict,
} from "@anybench/agents";
import type { ProjectDigest } from "@anybench/core";
import type { GitHubIngestOptions, RepoIngest } from "@anybench/kit";
import { createNaiveClient, type NaiveClient } from "@anybench/naive";
import type { Database } from "../db/client.js";
import type { Config } from "../config.js";
import { runAgentStage } from "../jobs/agent-session.js";
import { curatedKitStages, isTandemRepo } from "./curated.js";
import { naiveKitDesigner, type KitDesignerOptions } from "./kit-designer.js";
import {
  stageFail,
  stageHold,
  stageOk,
  type AgentStagePort,
  type StageContext,
  type StageResult,
  type Understanding,
} from "./ports.js";
import { loadRepoIngest } from "./repo-ingest-cache.js";

/** Naïve budget for one understander session, integer micro-USD ($0.10). */
export const UNDERSTANDER_BUDGET_MICRO_USD = 100_000n;

export interface KitBuilderStagesOptions {
  db: Database;
  client: NaiveClient;
  /** This repo's kits/ dir (the curated Tandem kit). */
  kitsDir?: string;
  /** The RepoIngest cache dir (default ~/.anybench/ingest). */
  ingestCacheDir?: string;
  /** For a re-ingest on a cache miss (private repos). */
  githubToken?: string;
  /** Per understander session. Default UNDERSTANDER_BUDGET_MICRO_USD. */
  understanderBudgetMicroUsd?: bigint;
  /** Overrides for the understander's role spec (e.g. a model in a live test). */
  understanderOverrides?: RoleSpecOverrides;
  /** Re-ingest used on a cache miss (tests). Default ingestGitHubRepo. */
  ingest?: (input: string, opts: GitHubIngestOptions) => Promise<RepoIngest>;
  /** Replace the kit designer for non-curated repos. Default: naiveKitDesigner (TDM-60). */
  designKit?: AgentStagePort["designKit"];
  /** Options for the default kit designer (generated kits dir, budget, model, pins, skeptic). */
  kitDesigner?: Omit<KitDesignerOptions, "db" | "client">;
}

async function say(ctx: StageContext, role: string, text: string): Promise<void> {
  await ctx.emit([
    {
      type: "agent.message",
      source: "agent_session",
      source_id: `kit-builder:${role}`,
      severity: "info",
      actor: { kind: "system" },
      cost_delta_micro_usd: 0n,
      at: new Date().toISOString(),
      payload: {
        agent_role: role,
        naive_seq: 0,
        message_role: "system",
        text: text.slice(0, 2_000),
        truncated: text.length > 2_000,
      },
    },
  ]);
}

export interface NaiveUnderstanding {
  /** What the stage returns: ready → ok, an unsupported driver / needs_hardware → hold, skip → fail. */
  result: StageResult<Understanding>;
  /** The code-enforced verdict (null when the session itself did not produce an answer). */
  verdict: UnderstandVerdict | null;
  /** The session's total cost, integer micro-USD (null when no session answered). */
  costMicroUsd: bigint | null;
  /** Where the repo context came from. */
  context: "cache" | "ingest" | "unavailable";
}

/**
 * The Naïve understander on one digest: repo context, one session, the code-enforced verdict.
 * Exported for the live eval (it skips the Tandem routing on purpose).
 */
export async function naiveUnderstand(
  opts: KitBuilderStagesOptions,
  ctx: StageContext,
  digest: ProjectDigest,
): Promise<NaiveUnderstanding> {
  const loaded = await loadRepoIngest(digest, {
    ...(opts.ingestCacheDir ? { dir: opts.ingestCacheDir } : {}),
    ...(opts.githubToken ? { githubToken: opts.githubToken } : {}),
    ...(opts.ingest ? { ingest: opts.ingest } : {}),
  });
  if (!loaded.ingest) {
    await say(
      ctx,
      UNDERSTANDER_ROLE,
      `no repo context (${loaded.why}): judging from the digest alone`,
    );
  }
  const ingest = { digest, context: loaded.ingest?.context ?? null };

  const r = await runAgentStage(
    { db: opts.db, client: opts.client },
    {
      ctx,
      role: UNDERSTANDER_ROLE,
      input: buildUnderstanderInput(ingest),
      schema: UnderstanderOutputSchema,
      budgetMicroUsd: opts.understanderBudgetMicroUsd ?? UNDERSTANDER_BUDGET_MICRO_USD,
      ...(opts.understanderOverrides ? { agent: { overrides: opts.understanderOverrides } } : {}),
    },
  );
  if (!r.ok) return { result: r, verdict: null, costMicroUsd: null, context: loaded.from };

  const verdict = decideUnderstanding(r.value.output, ingest);
  const u = verdict.understanding;
  const lines = [
    `${u.kind} / driver ${u.driver_type}${u.supported ? "" : " (not supported yet)"} / ${u.benchable}: ${verdict.reason}`,
    ...verdict.corrections.map((c) => `corrected: ${c}`),
    ...(u.claims.length > 0 ? [`${u.claims.length} verified claim(s)`] : []),
  ];
  await say(ctx, UNDERSTANDER_ROLE, lines.join("\n"));
  const result: StageResult<Understanding> =
    verdict.outcome === "fail"
      ? stageFail(verdict.reason)
      : verdict.outcome === "hold"
        ? stageHold(verdict.reason)
        : stageOk(u);
  return { result, verdict, costMicroUsd: r.value.costMicroUsd, context: loaded.from };
}

export function kitBuilderStages(opts: KitBuilderStagesOptions): AgentStagePort {
  const curated = curatedKitStages(opts.kitsDir ? { kitsDir: opts.kitsDir } : {});
  const designer =
    opts.designKit ??
    naiveKitDesigner({
      db: opts.db,
      client: opts.client,
      ...(opts.ingestCacheDir ? { ingestCacheDir: opts.ingestCacheDir } : {}),
      ...(opts.githubToken ? { githubToken: opts.githubToken } : {}),
      ...(opts.ingest ? { ingest: opts.ingest } : {}),
      ...opts.kitDesigner,
    });
  return {
    async understand(ctx, input) {
      if (isTandemRepo(ctx.run.intake.source)) return curated.understand(ctx, input);
      return (await naiveUnderstand(opts, ctx, input.digest)).result;
    },

    async research(ctx, input) {
      if (isTandemRepo(ctx.run.intake.source)) return curated.research(ctx, input);
      // TODO([6.3] researcher): competitor research on Naïve. v1 benchmarks the subject alone.
      await say(
        ctx,
        "researcher",
        "pass-through for v1: no baseline research yet (no baselines added)",
      );
      return stageOk({ baselines: [], sources: [] });
    },

    async designKit(ctx, input) {
      // The Tandem repo stays curated (its kit and its signed-off proof).
      if (isTandemRepo(ctx.run.intake.source)) return curated.designKit(ctx, input);
      return designer(ctx, input);
    },

    analyze: (ctx, input) => curated.analyze(ctx, input),
  };
}

/** run-advance's default agents: the kit builder when Naïve is configured, else the curated stages. */
export function defaultAgentStages(ctx: { db: Database; config: Config }): AgentStagePort {
  const { config } = ctx;
  const kitsDir = config.ANYBENCH_KITS_DIR ? { kitsDir: config.ANYBENCH_KITS_DIR } : {};
  if (!config.NAIVE_API_KEY) return curatedKitStages(kitsDir);
  return kitBuilderStages({
    db: ctx.db,
    client: createNaiveClient({
      apiKey: config.NAIVE_API_KEY,
      ...(config.NAIVE_BASE_URL ? { baseUrl: config.NAIVE_BASE_URL } : {}),
    }),
    ...kitsDir,
    ...(config.GITHUB_TOKEN ? { githubToken: config.GITHUB_TOKEN } : {}),
    ...(config.ANYBENCH_GENERATED_KITS_DIR
      ? { kitDesigner: { generatedKitsDir: config.ANYBENCH_GENERATED_KITS_DIR } }
      : {}),
  });
}
