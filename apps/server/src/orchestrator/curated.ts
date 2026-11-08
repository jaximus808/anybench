// CuratedKitStage (TDM-54): the agent stages for the founder's live test, until the E6 roles land.
//
//   understand  pass-through: the subject from the digest (or the curated kit), with an event.
//   research    pass-through: no new baselines (the curated kit names its own), with an event.
//   designKit   github.com/jaximus808/tandem (any case, with or without .git) → the curated kit
//               `kits/tandem-vs-claude-code` from this repo's kits/ directory, validated by
//               packages/kit loadKit, cut to the SMOKE profile (todo-api, 1 repeat, no warm-up,
//               TANDEM_WORKERS 3: 3 trials) unless the question asks for a "full benchmark".
//               Any other repo → needs_human with CURATED_KIT_UNAVAILABLE.
//               TODO([6.6] TDM-60 kit designer): design kits for any repo on Naïve.
//   analyze     the Tandem repo: the deterministic summary (proof-score.ts summaryAnalyst, no LLM)
//               with the Naïve-proxy disclosure; any other repo: not built ([6.8]).
//
// Events: each stage writes an `agent.message` (source_id `curated:<role>`) so the live run page
// shows what happened; the orchestrator writes run.state_changed for every transition.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expandTrials, expandTrialsInputFromKit } from "@anybench/bench";
import { formatSchemaIssues, safeParseKitSpec, type KitSpec } from "@anybench/core";
import { KitLoadError, loadKit, type LoadedKit } from "@anybench/kit";
import {
  stageHold,
  stageOk,
  unbuiltAgentStages,
  type AgentStagePort,
  type StageContext,
  type Understanding,
} from "./ports.js";
import { summaryAnalyst, TANDEM_DISCLOSURE } from "./proof-score.js";

export const CURATED_TANDEM_KIT = "tandem-vs-claude-code";
export const CURATED_KIT_UNAVAILABLE =
  "automatic kit design for this repo isn't available yet; we'll set it up for you";

const TANDEM_REPO =
  /^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?jaximus808\/tandem(?:\.git)?\/?$/i;

/** The Tandem kit's smoke workload. */
export const SMOKE_WORKLOAD = "todo-api";

/** The full Tandem kit only when the question asks for a "full benchmark" (any case). */
export function wantsFullBenchmark(question: string): boolean {
  return /full\s+benchmark/i.test(question);
}

/** The 3-trial smoke cut when the question says "smoke" (any case). */
export function wantsSmoke(question: string): boolean {
  return /\bsmoke\b/i.test(question);
}

/** The head-to-head profile's contenders: plain Claude Code vs Tandem. */
export const HEAD_TO_HEAD_CONTENDERS = ["claude-code-solo", "tandem"] as const;
/** Repeats per task in the head-to-head profile. */
export const HEAD_TO_HEAD_REPEATS = 5;

/** Trials the scheduler will plan for a kit (warm-ups included). */
export function trialCount(spec: KitSpec): number {
  return expandTrials(expandTrialsInputFromKit("count", spec)).length;
}

/**
 * The smoke profile of the Tandem kit: only `todo-api`, 1 repeat, no warm-up, TANDEM_WORKERS 3,
 * so A (solo), B (subagents) and C (Tandem ×3) run once each: 3 trials. Re-validated after the cut.
 */
export function smokeProfile(
  spec: KitSpec,
): { ok: true; spec: KitSpec } | { ok: false; reason: string } {
  const cut = {
    ...spec,
    workloads: spec.workloads.filter((w) => w.id === SMOKE_WORKLOAD),
    repeats: 1,
    schedule: { ...spec.schedule, warmups: 0 },
    vary: { ...spec.vary, TANDEM_WORKERS: [3] },
  };
  if (cut.workloads.length === 0) {
    return { ok: false, reason: `the curated Tandem kit has no ${SMOKE_WORKLOAD} workload` };
  }
  const r = safeParseKitSpec(cut);
  if (!r.success) {
    return {
      ok: false,
      reason: `the smoke profile does not validate: ${formatSchemaIssues(r.error).slice(0, 5).join("; ")}`,
    };
  }
  return { ok: true, spec: r.data };
}

/**
 * The head-to-head profile, the Tandem repo's default: A (Claude Code solo) vs Tandem ×3 on all
 * three tasks, 5 repeats each, no warm-up: 30 trials, paired by task. It answers "is Tandem better
 * than plain Claude Code?" with enough trials for wall clock and cost to say something; the
 * subagents setup and Tandem ×1/×5 stay in the full kit. Re-validated after the cut.
 */
export function headToHeadProfile(
  spec: KitSpec,
): { ok: true; spec: KitSpec } | { ok: false; reason: string } {
  const keep = new Set<string>(HEAD_TO_HEAD_CONTENDERS);
  const cut = {
    ...spec,
    contenders: spec.contenders.filter((c) => keep.has(c.id)),
    repeats: HEAD_TO_HEAD_REPEATS,
    schedule: { ...spec.schedule, warmups: 0 },
    vary: { ...spec.vary, TANDEM_WORKERS: [3] },
  };
  if (cut.contenders.length !== keep.size) {
    return { ok: false, reason: "the curated Tandem kit is missing a head-to-head contender" };
  }
  const r = safeParseKitSpec(cut);
  if (!r.success) {
    return {
      ok: false,
      reason: `the head-to-head profile does not validate: ${formatSchemaIssues(r.error).slice(0, 5).join("; ")}`,
    };
  }
  return { ok: true, spec: r.data };
}

/** Is this run's source the Tandem repo? */
export function isTandemRepo(source: StageContext["run"]["intake"]["source"]): boolean {
  return source.kind === "github" && TANDEM_REPO.test(source.github.trim());
}

/** This repo's kits/ directory: ANYBENCH_KITS_DIR, else found upward from this file. */
export function defaultKitsDir(override?: string): string {
  if (override) return path.resolve(override);
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "kits", CURATED_TANDEM_KIT);
    if (existsSync(path.join(candidate, "anybench.yaml"))) return path.join(dir, "kits");
    dir = path.dirname(dir);
  }
  return path.resolve("kits");
}

async function say(ctx: StageContext, role: string, text: string): Promise<void> {
  await ctx.emit([
    {
      type: "agent.message",
      source: "agent_session",
      source_id: `curated:${role}`,
      severity: "info",
      actor: { kind: "system" },
      cost_delta_micro_usd: 0n,
      at: new Date().toISOString(),
      payload: { agent_role: role, naive_seq: 0, message_role: "system", text, truncated: false },
    },
  ]);
}

export function curatedKitStages(opts: { kitsDir?: string } = {}): AgentStagePort {
  const kitsDir = defaultKitsDir(opts.kitsDir);
  /** The curated kit, or why it does not validate (the run then holds for a human). */
  const tandemKit = async (): Promise<
    { ok: true; kit: LoadedKit } | { ok: false; reason: string }
  > => {
    try {
      return { ok: true, kit: await loadKit(path.join(kitsDir, CURATED_TANDEM_KIT)) };
    } catch (err) {
      if (!(err instanceof KitLoadError)) throw err;
      return {
        ok: false,
        reason: `the curated Tandem kit does not validate: ${err.message}`.slice(0, 1900),
      };
    }
  };

  return {
    async understand(ctx, { digest }) {
      if (isTandemRepo(ctx.run.intake.source)) {
        const loaded = await tandemKit();
        if (!loaded.ok) return stageHold(loaded.reason);
        const kit = loaded.kit;
        await say(ctx, "understander", "using the curated Tandem kit");
        const u: Understanding = {
          kind: kit.spec.subject.kind,
          summary: kit.spec.subject.summary,
          better_means: kit.spec.subject.better_means,
          risks: [],
          benchable: "ready",
          reason: "curated kit",
        };
        return stageOk(u);
      }
      await say(ctx, "understander", "pass-through: using the ingest digest");
      const u: Understanding = {
        kind: digest.kind,
        summary: digest.summary,
        better_means: ["to be decided by the kit designer"],
        risks: [],
        benchable: "ready",
        reason: "pass-through until the understander ([6.2]) lands",
      };
      return stageOk(u);
    },

    async research(ctx) {
      const curated = isTandemRepo(ctx.run.intake.source);
      await say(
        ctx,
        "researcher",
        curated
          ? "using the curated Tandem kit: its contenders are the baselines"
          : "pass-through: no baseline research yet",
      );
      return stageOk({ baselines: [], sources: [] });
    },

    async designKit(ctx, { previous }) {
      if (!isTandemRepo(ctx.run.intake.source)) {
        // TODO([6.6] TDM-60 kit designer): design a kit for any repo.
        await say(ctx, "kit_designer", CURATED_KIT_UNAVAILABLE);
        return stageHold(CURATED_KIT_UNAVAILABLE);
      }
      if (previous) {
        const failed = previous.proof.filter((p) => !p.pass).map((p) => p.check);
        return stageHold(`the curated Tandem kit failed its proof (${failed.join(", ")})`);
      }
      const loaded = await tandemKit();
      if (!loaded.ok) {
        await say(ctx, "kit_designer", loaded.reason);
        return stageHold(loaded.reason);
      }
      const kit = loaded.kit;
      // The kit's files on disk (contract C1): kits.files_url = file://<dir> for env_build/proof.
      const files_dir = kit.dir;
      await say(ctx, "kit_designer", `using the curated Tandem kit (${CURATED_TANDEM_KIT})`);
      if (wantsFullBenchmark(ctx.run.question)) {
        await say(ctx, "kit_designer", `full profile: ${trialCount(kit.spec)} trials`);
        return stageOk({ spec: kit.spec, files_dir });
      }
      if (wantsSmoke(ctx.run.question)) {
        const smoke = smokeProfile(kit.spec);
        if (!smoke.ok) return stageHold(smoke.reason);
        await say(
          ctx,
          "kit_designer",
          `smoke profile: ${trialCount(smoke.spec)} trials (${SMOKE_WORKLOAD}, 1 repeat, no warm-up, TANDEM_WORKERS=3); ask for a "full benchmark" for the whole kit`,
        );
        return stageOk({ spec: smoke.spec, files_dir });
      }
      const h2h = headToHeadProfile(kit.spec);
      if (!h2h.ok) return stageHold(h2h.reason);
      await say(
        ctx,
        "kit_designer",
        `head-to-head profile: ${trialCount(h2h.spec)} trials (Claude Code solo vs Tandem ×3, ${h2h.spec.workloads.length} tasks × ${HEAD_TO_HEAD_REPEATS} repeats, no warm-up); say "smoke" for a 3-trial check or "full benchmark" for the whole kit`,
      );
      return stageOk({ spec: h2h.spec, files_dir });
    },

    async analyze(ctx, input) {
      // TODO([6.8] analyst): the Naïve analyst for any kit.
      if (!isTandemRepo(ctx.run.intake.source)) return unbuiltAgentStages.analyze(ctx, input);
      return summaryAnalyst({ disclosure: TANDEM_DISCLOSURE })(ctx, input);
    },
  };
}
