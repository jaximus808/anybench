// TDM-187 [16.16]: the skeptic stage seam. The kit designer (TDM-60) calls it between kit
// validation and returning its design; nothing reaches proof without it.
//
//   skepticReview({db, client}, {ctx, kitDir, spec, understanding?, proof?})
//     1. the deterministic checks on the kit dir (@anybench/kit runSkepticChecks), proof-aware;
//     2. the skeptic's model: the role's model or a fallback, refused IN CODE when it is Anthropic,
//        the designer's family or any contender's family (skepticModelFor); none left → hold;
//     3. ONE Naïve skeptic session through runAgentStage (persisted, replay-safe, cost booked),
//        on the kit's instructions, hidden-test excerpts, help files, gates, requirements, weights,
//        contenders and the deterministic findings. Its input type has no field for contender
//        scores (plan.md 17.2 rule 6);
//     4. the model's findings with their path:line + quote verified, merged, and the final
//        verdict computed in code: any block → repair (the designer can fix it) or hold
//        (contamination); the model's verdict is advisory.
//
// Returns ok({verdict, findings, costMicroUsd, ...}) whenever the review ran, whatever the verdict:
// the caller (kit designer) re-asks on `repair` and holds on `hold`. A review that could not run
// (no independent model, the session held) is a hold; transient Naïve errors throw (job retry).
import {
  buildSkepticInput,
  finalizeSkepticReview,
  SKEPTIC_ROLE,
  SkepticOutputSchema,
  skepticModelFor,
  type SkepticReviewResult,
} from "@anybench/agents";
import type { KitSpec, ProofCheckResult } from "@anybench/core";
import {
  formatSkepticFinding,
  runSkepticChecks,
  type SkepticChecksOptions,
  type SkepticFinding,
  type SkepticVerdict,
} from "@anybench/kit";
import type { NaiveClient } from "@anybench/naive";
import type { Database } from "../db/client.js";
import { runAgentStage } from "../jobs/agent-session.js";
import type { KitSkeptic } from "./kit-designer.js";
import {
  stageHold,
  stageOk,
  type StageContext,
  type StageResult,
  type Understanding,
} from "./ports.js";

/** Naïve budget for one skeptic session, integer micro-USD ($0.15; covers the pre-flight quote). */
export const SKEPTIC_BUDGET_MICRO_USD = 150_000n;

export interface SkepticDeps {
  db: Database;
  client: NaiveClient;
}

export interface SkepticReviewArgs {
  ctx: StageContext;
  /** The kit directory the designer wrote (KitDesign.files_dir). */
  kitDir: string;
  /** The validated spec (its contender models feed the independence rule). */
  spec: KitSpec;
  understanding?: Understanding | null;
  /** Proof results, on a repair after proof. Check-level only: never contender scores. */
  proof?: readonly ProofCheckResult[] | null;
  /** The designer's model id (default: packages/agents/kit-designer config, else Anthropic + DeepSeek). */
  designerModel?: string;
  /** Model candidates in order (default: the role's model, then SKEPTIC_MODEL_FALLBACKS). */
  models?: readonly string[];
  /** Per session. Default SKEPTIC_BUDGET_MICRO_USD. */
  budgetMicroUsd?: bigint;
  /**
   * The designer's attempt in this stage visit (0 first). Keys the agent session, so a re-check
   * after a repair runs a new session instead of replaying the first.
   */
  attempt?: number;
  modelCutoffs?: SkepticChecksOptions["modelCutoffs"];
}

export interface SkepticReview {
  /** Computed in code: pass | repair | hold. */
  verdict: SkepticVerdict;
  findings: SkepticFinding[];
  /** The Naïve session's total cost, integer micro-USD. */
  costMicroUsd: bigint;
  /** The model that reviewed the kit. */
  model: string;
  /** The model's own verdict (advisory). */
  advisoryVerdict: SkepticVerdict | null;
  summary: string;
}

async function say(ctx: StageContext, text: string): Promise<void> {
  await ctx.emit([
    {
      type: "agent.message",
      source: "agent_session",
      source_id: `kit-builder:${SKEPTIC_ROLE}`,
      severity: "info",
      actor: { kind: "system" },
      cost_delta_micro_usd: 0n,
      at: new Date().toISOString(),
      payload: {
        agent_role: SKEPTIC_ROLE,
        naive_seq: 0,
        message_role: "system",
        text: text.slice(0, 2_000),
        truncated: text.length > 2_000,
      },
    },
  ]);
}

const count = (fs: readonly SkepticFinding[], s: "block" | "warn") =>
  fs.filter((f) => f.severity === s).length;

/** The skeptic's audit of one kit: deterministic checks + one independent Naïve session. */
export async function skepticReview(
  deps: SkepticDeps,
  args: SkepticReviewArgs,
): Promise<StageResult<SkepticReview>> {
  const { ctx } = args;
  const checks = await runSkepticChecks(args.kitDir, {
    proof: args.proof ?? null,
    ...(args.modelCutoffs ? { modelCutoffs: args.modelCutoffs } : {}),
  });
  if (!checks.material) {
    const lines = checks.findings.slice(0, 5).map(formatSkepticFinding).join("; ");
    return stageHold(`skeptic: the kit at ${args.kitDir} does not load: ${lines}`);
  }

  const choice = skepticModelFor(args.spec, {
    ...(args.models ? { candidates: args.models } : {}),
    ...(args.designerModel ? { designer: [args.designerModel, "anthropic"] } : {}),
  });
  if (!choice.model) {
    return stageHold(
      `skeptic: no model independent of the designer and every contender: ${choice.refused.join("; ")}`,
    );
  }

  const baseKey = args.attempt
    ? `${ctx.idempotencyKey}:skeptic-${args.attempt}`
    : ctx.idempotencyKey;
  // One retry on a fresh session key: a model that slips once (e.g. never submits its output,
  // seen live) must not hold a run whose deterministic checks are clean. Still fail closed after.
  const material = checks.material;
  const model = choice.model;
  const review1 = (key: string) =>
    runAgentStage(
      { db: deps.db, client: deps.client },
      {
        ctx: { ...ctx, idempotencyKey: key },
        role: SKEPTIC_ROLE,
        input: buildSkepticInput(material, checks.findings, {
          proof: args.proof ?? null,
          understanding: args.understanding ?? null,
        }),
        schema: SkepticOutputSchema,
        budgetMicroUsd: args.budgetMicroUsd ?? SKEPTIC_BUDGET_MICRO_USD,
        agent: { overrides: { model } },
      },
    );
  let r = await review1(baseKey);
  if (!r.ok) {
    await say(ctx, `skeptic review did not complete (${r.reason}); retrying once`);
    r = await review1(`${baseKey}:retry`);
  }
  if (!r.ok) {
    const blocks = count(checks.findings, "block");
    return stageHold(
      `skeptic review could not run (${r.reason}); the deterministic checks found ${blocks} block(s)`,
    );
  }

  const review: SkepticReviewResult = finalizeSkepticReview(
    checks.findings,
    r.value.output,
    checks.material,
  );
  const value: SkepticReview = {
    verdict: review.verdict,
    findings: review.findings,
    costMicroUsd: r.value.costMicroUsd,
    model: choice.model,
    advisoryVerdict: review.advisoryVerdict,
    summary: review.summary,
  };
  await say(
    ctx,
    [
      `skeptic (${choice.model}): ${value.verdict}, ${count(value.findings, "block")} block / ${count(value.findings, "warn")} warn${value.advisoryVerdict && value.advisoryVerdict !== value.verdict ? ` (model advised ${value.advisoryVerdict})` : ""}`,
      ...value.findings
        .filter((f) => f.severity === "block")
        .slice(0, 8)
        .map(formatSkepticFinding),
    ].join("\n"),
  );
  return stageOk(value);
}

/**
 * skepticReview as the kit designer's KitSkeptic seam (kit-designer.ts): pass → ok; repair →
 * refused with the blocking findings as fix issues (the designer is re-asked once); hold, or a
 * review that could not run → refused (the run holds with the reason).
 */
export function kitSkeptic(
  deps: SkepticDeps,
  opts: Omit<SkepticReviewArgs, "ctx" | "kitDir" | "spec" | "attempt"> = {},
): KitSkeptic {
  return async (ctx, kit) => {
    const r = await skepticReview(deps, {
      ...opts,
      ctx,
      kitDir: kit.dir,
      spec: kit.spec,
      ...(kit.attempt !== undefined ? { attempt: kit.attempt } : {}),
    });
    if (!r.ok) return { ok: false, reason: r.reason };
    if (r.value.verdict === "pass") return { ok: true };
    const blocking = r.value.findings
      .filter((f) => f.severity === "block")
      .map((f) => `skeptic: ${formatSkepticFinding(f)}`);
    const reason = `${r.value.verdict}: ${blocking.slice(0, 6).join("; ")}`.slice(0, 1_800);
    return r.value.verdict === "repair"
      ? { ok: false, reason, repair: blocking }
      : { ok: false, reason };
  };
}
