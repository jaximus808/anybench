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
//     4. The skeptic seam (TDM-187: a different model family reviews the kit before proof).
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
import { generatedKitDir } from "./generated-kits.js";
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
  kit: { spec: KitSpec; dir: string; draft: KitDesignerOutput },
) => Promise<{ ok: true } | { ok: false; reason: string }>;

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
    if (u.driver_type !== "cli") {
      const why =
        u.driver_type === "coding-agent" || u.driver_type === "harness"
          ? `automatic kits for ${u.driver_type} repos need tasks mined from the repo's history (TDM-186), which is not built in yet`
          : `driver ${u.driver_type ?? "unknown"} is not supported yet`;
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
      const second = await skeptic(ctx, { spec: built.spec, dir, draft: current });
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
