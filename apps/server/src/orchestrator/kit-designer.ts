// TDM-60 [6.6]: the kit designer stage (AgentStagePort["designKit"]) for non-curated repos.
//
//   naiveKitDesigner(opts)(ctx, {digest, understanding, research, previous})
//     1. Only a supported cli understanding gets a generated kit in v1. coding-agent / harness
//        repos hold (their tasks come from the history miner, TDM-186, not merged yet); anything
//        else already held at understand.
//     2. One Naïve session of the kit-designer role (packages/agents/kit-designer) through
//        runAgentStage: mode "design" (digest + understanding + research + the user's intake
//        contenders + repo context), or mode "repair" when the orchestrator sends `previous`:
//        the previous spec, its draft, and the proof check results ONLY (plan 17.2 rule 6:
//        KitDesignerRepairInputSchema has no field for a score, and the orchestrator hands this
//        stage none).
//     3. Code builds the kit: pins (release tag → per-arch asset → sha256), renders every script,
//        writes `<ANYBENCH_GENERATED_KITS_DIR>/<run>/v<n>/`, validates it (loadKit + comparability
//        + no-leak lint). Validation issues → the designer is re-asked ONCE (mode "fix") with
//        them; still invalid → needs_human with the issues.
//     4. The skeptic (TDM-187, orchestrator/skeptic.ts kitSkeptic): a different model family reviews
//        the kit before proof; blocks are re-asked once as fix issues (repair), else the run holds.
//     5. → {spec, files_dir}: advance.ts stores the kit row (file:// files_url), env_build and the
//        proof stage read the files; a failed proof comes back here as a repair (×2, advance.ts).
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  buildKitDesignerFixInput,
  buildKitDesignerInput,
  buildKitDesignerRepairInput,
  KIT_DESIGNER_ROLE,
  KitDesignerOutputSchema,
  repairChecksOf,
  type KitDesignerOutput,
  type RoleSpecOverrides,
} from "@anybench/agents";
import type { KitSpec } from "@anybench/core";
import {
  CliKitDraftSchema,
  MaterializeError,
  materializeCliKit,
  resolveCliPins,
  validateGeneratedKit,
  type GitHubIngestOptions,
  type PinDeps,
  type RepoIngest,
} from "@anybench/kit";
import type { NaiveClient } from "@anybench/naive";
import { eq, max } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { kits } from "../db/schema/kits.js";
import { runAgentStage, type AgentStageOutput } from "../jobs/agent-session.js";
import { designMinedAgentKit } from "./agent-kit-designer.js";
import { CURATED_TANDEM_KIT, defaultKitsDir, isTandemRepo } from "./curated.js";
import { generatedKitDir } from "./generated-kits.js";
import { mineForRun, type MineStageOptions } from "./mine-stage.js";
import {
  stageHold,
  stageOk,
  type AgentStagePort,
  type KitDesign,
  type StageContext,
  type StageResult,
} from "./ports.js";
import { loadRepoIngest } from "./repo-ingest-cache.js";

/** Naïve budget for one kit-designer session, integer micro-USD ($0.80). */
export const KIT_DESIGNER_BUDGET_MICRO_USD = 800_000n;
/** Re-asks after a validation failure (the ticket: once). */
export const KIT_DESIGNER_FIX_ATTEMPTS = 1;

/** The TDM-187 seam: a second opinion on a validated kit, before it goes to env build + proof. */
export type KitSkeptic = (
  ctx: StageContext,
  kit: { spec: KitSpec; dir: string; draft?: KitDesignerOutput; attempt?: number },
) => Promise<
  | { ok: true }
  // `repair`: the blocking findings, re-asked as fix issues (findings only, never scores).
  | { ok: false; reason: string; repair?: string[] }
>;

/** Until TDM-187: no second opinion. */
export const noSkeptic: KitSkeptic = async () => ({ ok: true });

export interface KitDesignerOptions {
  db: Database;
  client: NaiveClient;
  /** ANYBENCH_GENERATED_KITS_DIR. Default ~/.anybench/generated-kits. */
  generatedKitsDir?: string;
  ingestCacheDir?: string;
  githubToken?: string;
  ingest?: (input: string, opts: GitHubIngestOptions) => Promise<RepoIngest>;
  /** Per session. Default KIT_DESIGNER_BUDGET_MICRO_USD. */
  budgetMicroUsd?: bigint;
  /** Overrides for the role spec (a model in a live test). */
  overrides?: RoleSpecOverrides;
  /** Pin resolution (tests inject fetch; the worker passes its GitHub token). */
  pins?: PinDeps;
  /** TDM-187. Default noSkeptic. */
  skeptic?: KitSkeptic;
  /** v1 scope (b): mining a coding-agent / harness repo's history (provider, caches, caps). */
  mining?: MineStageOptions;
  /**
   * The contender template for an agent/harness repo: its adapters and the plain Claude Code
   * baseline, pinned exactly like it. Default: the Tandem repo → kits/tandem-vs-claude-code;
   * anything else → null (holds: no adapter for that harness yet).
   */
  agentTemplate?: (source: StageContext["run"]["intake"]["source"]) => AgentKitTemplate | null;
  /** This repo's kits/ dir (the default agent template). */
  kitsDir?: string;
  /** The kits.version this design will get. Default: max(kits.version) + 1 for the run. */
  nextVersion?: (runId: string) => Promise<number>;
}

async function say(ctx: StageContext, text: string): Promise<void> {
  await ctx.emit([
    {
      type: "agent.message",
      source: "agent_session",
      source_id: `kit-builder:${KIT_DESIGNER_ROLE}`,
      severity: "info",
      actor: { kind: "system" },
      cost_delta_micro_usd: 0n,
      at: new Date().toISOString(),
      payload: {
        agent_role: KIT_DESIGNER_ROLE,
        naive_seq: 0,
        message_role: "system",
        text: text.slice(0, 2_000),
        truncated: text.length > 2_000,
      },
    },
  ]);
}

function dbNextVersion(db: Database) {
  return async (runId: string): Promise<number> => {
    const [row] = await db
      .select({ v: max(kits.version) })
      .from(kits)
      .where(eq(kits.runId, runId));
    return (row?.v ?? 0) + 1;
  };
}

async function previousDraft(dir: string): Promise<Record<string, unknown> | null> {
  const file = path.join(dir, "design", "draft.json");
  if (!existsSync(file)) return null;
  try {
    const parsed = CliKitDraftSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    return parsed.success ? (parsed.data as unknown as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

type Built = { ok: true; spec: KitSpec; warnings: string[] } | { ok: false; issues: string[] };

/** Pins + materialize + validate. Transient pin failures throw (the job retries). */
async function build(
  draft: KitDesignerOutput,
  dir: string,
  opts: KitDesignerOptions,
  provenance: Record<string, unknown>,
): Promise<Built> {
  try {
    const pins = await resolveCliPins(draft, {
      ...(opts.githubToken ? { githubToken: opts.githubToken } : {}),
      ...opts.pins,
    });
    await materializeCliKit({ draft, pins, dir, provenance });
  } catch (err) {
    if (err instanceof MaterializeError && !err.transient)
      return { ok: false, issues: [err.message] };
    throw err;
  }
  const v = await validateGeneratedKit(dir);
  if (!v.ok || !v.kit) return { ok: false, issues: v.issues };
  return { ok: true, spec: v.kit.spec, warnings: v.warnings };
}

export function naiveKitDesigner(opts: KitDesignerOptions): AgentStagePort["designKit"] {
  const nextVersion = opts.nextVersion ?? dbNextVersion(opts.db);
  const skeptic = opts.skeptic ?? noSkeptic;
  const budget = opts.budgetMicroUsd ?? KIT_DESIGNER_BUDGET_MICRO_USD;
  const agent = opts.overrides ? { agent: { overrides: opts.overrides } } : {};

  return async (ctx, input): Promise<StageResult<KitDesign>> => {
    const u = input.understanding;
    if (!u) return stageHold("the kit designer needs the understanding of the repo");
    if (u.supported === false) {
      return stageHold(u.reason || `driver ${u.driver_type ?? "unknown"} is not supported yet`);
    }
    if (u.driver_type === "coding-agent" || u.driver_type === "harness") {
      return designAgentKit(opts, ctx, input, nextVersion, skeptic);
    }
    if (u.driver_type !== "cli") {
      const why = `driver ${u.driver_type ?? "unknown"} is not supported yet`;
      await say(ctx, why);
      return stageHold(why);
    }

    const version = await nextVersion(ctx.run.id);
    const dir = generatedKitDir({
      runId: ctx.run.id,
      version,
      ...(opts.generatedKitsDir ? { root: opts.generatedKitsDir } : {}),
    });

    let task: Record<string, unknown>;
    if (input.previous) {
      // Plan 17.2 rule 6: the previous kit and its proof results, nothing else.
      const prevDir =
        version > 1
          ? generatedKitDir({
              runId: ctx.run.id,
              version: version - 1,
              ...(opts.generatedKitsDir ? { root: opts.generatedKitsDir } : {}),
            })
          : null;
      task = buildKitDesignerRepairInput({
        previous_spec: (input.previous.spec ?? {}) as Record<string, unknown>,
        previous_draft: prevDir ? await previousDraft(prevDir) : null,
        proof: repairChecksOf(input.previous.proof),
      });
      const failing = input.previous.proof.filter((p) => !p.pass).map((p) => p.check);
      await say(ctx, `repairing the kit (v${version}) after proof failed: ${failing.join(", ")}`);
    } else {
      if (!input.digest) return stageHold("the kit designer needs the repo digest");
      const loaded = await loadRepoIngest(input.digest, {
        ...(opts.ingestCacheDir ? { dir: opts.ingestCacheDir } : {}),
        ...(opts.githubToken ? { githubToken: opts.githubToken } : {}),
        ...(opts.ingest ? { ingest: opts.ingest } : {}),
      });
      task = buildKitDesignerInput({
        digest: input.digest,
        understanding: u,
        research: input.research,
        intakeContenders: ctx.run.intake.contenders.map((c) => ({
          id: c.id,
          ...(c.name ? { name: c.name } : {}),
          source: c.source,
        })),
        context: loaded.ingest?.context ?? null,
      });
    }

    let draft: KitDesignerOutput | null = null;
    let issues: string[] = [];
    let cost = 0n;
    for (let attempt = 0; attempt <= KIT_DESIGNER_FIX_ATTEMPTS; attempt++) {
      const r: StageResult<AgentStageOutput<KitDesignerOutput>> = await runAgentStage(
        { db: opts.db, client: opts.client },
        {
          // A distinct key per re-ask, so the fix is its own session (and a rerun replays both).
          ctx:
            attempt === 0 ? ctx : { ...ctx, idempotencyKey: `${ctx.idempotencyKey}:fix${attempt}` },
          role: KIT_DESIGNER_ROLE,
          input: attempt === 0 ? task : buildKitDesignerFixInput({ draft, issues }),
          schema: KitDesignerOutputSchema,
          budgetMicroUsd: budget,
          ...agent,
        },
      );
      if (!r.ok) return r;
      cost += r.value.costMicroUsd;
      const current: KitDesignerOutput = r.value.output;
      draft = current;
      const built = await build(current, dir, opts, {
        run_id: ctx.run.id,
        version,
        mode: input.previous ? "repair" : "design",
        attempt,
        naive_session_id: r.value.naiveSessionId,
      });
      if (!built.ok) {
        issues = built.issues;
        await say(
          ctx,
          `kit v${version} draft ${attempt + 1} did not validate (${issues.length} issue(s)): ${issues.slice(0, 3).join("; ")}`,
        );
        continue;
      }
      const second = await skeptic(ctx, { spec: built.spec, dir, draft: current, attempt });
      if (!second.ok && second.repair && attempt < KIT_DESIGNER_FIX_ATTEMPTS) {
        issues = second.repair;
        await say(ctx, `kit v${version} draft ${attempt + 1}: the skeptic asked for a repair`);
        continue;
      }
      if (!second.ok) return stageHold(`the kit skeptic refused the kit: ${second.reason}`);
      const subject = built.spec.contenders.find((c) => c.role === "subject");
      await say(
        ctx,
        [
          `designed kit v${version}: ${built.spec.contenders.map((c) => `${c.id} (${c.version ?? c.role})`).join(" vs ")}`,
          `${built.spec.workloads.length} workloads, gate ${built.spec.gates.map((g) => g.id).join(", ")} (reference captured from ${subject?.id ?? "the subject"}), ${built.spec.repeats} repeats, weights ${JSON.stringify(built.spec.scoring.weights)}`,
          `designer sessions cost ${cost} µ$`,
          ...built.warnings.slice(0, 3).map((w) => `warning: ${w}`),
        ].join("\n"),
      );
      return stageOk({ spec: built.spec, files_dir: dir });
    }
    return stageHold(
      `the kit designer's kit does not validate after ${KIT_DESIGNER_FIX_ATTEMPTS + 1} drafts: ${issues.slice(0, 6).join("; ")}`.slice(
        0,
        1900,
      ),
    );
  };
}

export interface AgentKitTemplate {
  dir: string;
  contenders: string[];
  subject: string;
}

/** Tandem → the curated kit's adapters (claude-code-solo + tandem); other harnesses: none yet. */
export function defaultAgentTemplate(kitsDir?: string) {
  return (source: StageContext["run"]["intake"]["source"]): AgentKitTemplate | null =>
    isTandemRepo(source)
      ? {
          dir: path.join(defaultKitsDir(kitsDir), CURATED_TANDEM_KIT),
          contenders: ["claude-code-solo", "tandem"],
          subject: "tandem",
        }
      : null;
}

/** v1 scope (b): mine → issues → materialize → validate → skeptic, for coding-agent / harness. */
async function designAgentKit(
  opts: KitDesignerOptions,
  ctx: StageContext,
  input: Parameters<AgentStagePort["designKit"]>[1],
  nextVersion: (runId: string) => Promise<number>,
  skeptic: KitSkeptic,
): Promise<StageResult<KitDesign>> {
  const u = input.understanding!;
  if (input.previous) {
    const failed = input.previous.proof.filter((p) => !p.pass).map((p) => p.check);
    return stageHold(
      `the mined ${u.driver_type} kit failed its proof (${failed.join(", ")}); a mined kit is not repaired automatically yet`,
    );
  }
  if (!input.digest) return stageHold("the kit designer needs the repo digest");
  if (u.history && !u.history.minable) {
    const why = `the history is not minable for tasks: ${u.history.why || `${u.history.test_commits} test commits`}`;
    await say(ctx, why);
    return stageHold(why);
  }
  const template = (opts.agentTemplate ?? defaultAgentTemplate(opts.kitsDir))(
    ctx.run.intake.source,
  );
  if (!template) {
    const why = `no contender adapter for this ${u.driver_type} yet: generated agent kits drive the subject through a pinned adapter, and only Tandem has one`;
    await say(ctx, why);
    return stageHold(why);
  }
  const mined = await mineForRun(ctx, input.digest, opts.mining ?? { provider: null }, (t) =>
    say(ctx, t),
  );
  if (!mined.ok) {
    await say(ctx, mined.reason);
    return stageHold(mined.reason);
  }
  const version = await nextVersion(ctx.run.id);
  const dir = generatedKitDir({
    runId: ctx.run.id,
    version,
    ...(opts.generatedKitsDir ? { root: opts.generatedKitsDir } : {}),
  });
  const readme = existsSync(path.join(mined.repoDir, "README.md"))
    ? (await readFile(path.join(mined.repoDir, "README.md"), "utf8")).slice(0, 4_000)
    : undefined;
  const r = await designMinedAgentKit({ db: opts.db, client: opts.client }, ctx, {
    repoDir: mined.repoDir,
    tasks: mined.tasks,
    repo: { name: input.digest.name, summary: u.summary },
    ...(readme ? { readmeExcerpt: readme } : {}),
    subject: {
      kind: u.driver_type === "harness" ? "harness" : "agent",
      name: input.digest.name,
      summary: `${u.summary} Compared with plain Claude Code on issues mined from the repo's own history.`,
      better_means: u.better_means,
    },
    template,
    dir,
  });
  if (!r.ok) {
    await say(ctx, r.reason);
    return stageHold(r.reason);
  }
  const second = await skeptic(ctx, { spec: r.spec, dir });
  if (!second.ok) return stageHold(`the kit skeptic refused the kit: ${second.reason}`);
  await say(
    ctx,
    [
      `designed kit v${version} from ${r.kept.length} mined task(s) (${r.dropped.length} dropped at issue writing)${mined.cached ? ", mine reused from the cache" : ""}`,
      `contenders ${r.spec.contenders.map((c) => c.id).join(" vs ")}, gate hidden-tests (FAIL_TO_PASS + PASS_TO_PASS), ${r.spec.repeats} repeats`,
      `issue sessions cost ${r.costMicroUsd} µ$`,
    ].join("\n"),
  );
  return stageOk({ spec: r.spec, files_dir: dir });
}
