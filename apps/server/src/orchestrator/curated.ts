// CuratedKitStage (TDM-54): the agent stages for the founder's live test, until the E6 roles land.
//
//   understand  pass-through: the subject from the digest (or the curated kit), with an event.
//   research    pass-through: no new baselines (the curated kit names its own), with an event.
//   designKit   github.com/jaximus808/tandem (any case, with or without .git) → one of the two
//               curated kits from this repo's kits/ directory, validated by packages/kit loadKit
//               (curatedKitFor picks it from the question; the run page says which and how to
//               pick the other):
//                 kits/tandem-long-horizon (the default, E18 / TDM-233): one whole-app build, our
//                   own Anthropic key. The whole kit; "smoke" → 1 repeat per setup on the first task.
//                 kits/tandem-vs-claude-code (three short tasks on the Naïve proxy) when the
//                   question names it, says "short tasks", or asks for the "null pilot" (the A/A
//                   pilot is defined on it, E18 18.1). Cut by the question: "null pilot" → Claude
//                   Code solo vs an identical copy of itself, repeats from the power plan; "full
//                   benchmark" → the whole kit; "smoke" → the 3-trial cut (todo-api, 1 repeat, no
//                   warm-up, TANDEM_WORKERS 3); otherwise head-to-head.
//               Any other repo → needs_human with CURATED_KIT_UNAVAILABLE.
//               TODO([6.6] TDM-60 kit designer): design kits for any repo on Naïve.
//   analyze     the Tandem repo: the deterministic summary (proof-score.ts summaryAnalyst, no LLM)
//               with the kit's disclosure (long-horizon: `tokens: anthropic-key, effort: default,
//               thinking: on`; short tasks: the Naïve-proxy one); any other repo: not built ([6.8]).
//
// Events: each stage writes an `agent.message` (source_id `curated:<role>`) so the live run page
// shows what happened; the orchestrator writes run.state_changed for every transition.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  expandTrials,
  expandTrialsInputFromKit,
  minRepeatsForPerTask,
  powerPlanForKit,
} from "@anybench/bench";
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
import { LONG_HORIZON_DISCLOSURE, summaryAnalyst, TANDEM_DISCLOSURE } from "./proof-score.js";

/** The three-short-task curated kit (E14/E16). Still selectable; no longer the default. */
export const CURATED_TANDEM_KIT = "tandem-vs-claude-code";
/** The whole-app build curated kit (E18), the Tandem repo's default (TDM-233). */
export const CURATED_LONG_HORIZON_KIT = "tandem-long-horizon";
/** The curated kit the Tandem repo gets unless the question asks for the other one. */
export const CURATED_DEFAULT_KIT = CURATED_LONG_HORIZON_KIT;
export const CURATED_KIT_IDS = [CURATED_LONG_HORIZON_KIT, CURATED_TANDEM_KIT] as const;
export type CuratedKitId = (typeof CURATED_KIT_IDS)[number];

/** The short-task kit when the question names it or says "short tasks" (any case). */
export function wantsShortTaskKit(question: string): boolean {
  return /tandem-vs-claude-code|\bshort[\s-]+tasks?\b/i.test(question);
}

/**
 * Which curated kit a Tandem run gets: the short-task kit when the question asks for it, or for
 * the null pilot (the A/A pilot is that kit's profile, E18 18.1); otherwise the long-horizon kit.
 */
export function curatedKitFor(question: string): CuratedKitId {
  return wantsShortTaskKit(question) || wantsNullPilot(question)
    ? CURATED_TANDEM_KIT
    : CURATED_DEFAULT_KIT;
}

/** The disclosure the report carries for a curated kit's setups (how tokens were bought). */
export function curatedDisclosure(id: CuratedKitId): string {
  return id === CURATED_LONG_HORIZON_KIT ? LONG_HORIZON_DISCLOSURE : TANDEM_DISCLOSURE;
}
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
/**
 * Repeats per task in the head-to-head profile, at least. With 3 tasks the general (task-paired)
 * verdict can't say anything, so the answer comes from each task's own repeats (E18 per-task
 * results), and those need enough repeats to survive Holm across every task × requirement test:
 * 5 vs 5 can't get below p = 0.0079, which is above 0.05 / 13. `headToHeadProfile` raises the
 * repeats to `minRepeatsForPerTask` (6 for the curated kit).
 */
export const HEAD_TO_HEAD_REPEATS = 5;

/** The Tandem setup's display name in the head-to-head profile (TANDEM_WORKERS=3 only). */
export const HEAD_TO_HEAD_TANDEM_NAME = "Tandem ×3";

/** Per-task tests in a kit's Holm family: (setups − 1) × Σ requirements' covered workloads. */
export function perTaskFamily(spec: KitSpec): number {
  const tasks = spec.workloads.map((w) => w.id);
  const covered = spec.requirements.reduce(
    (n, r) =>
      n + (r.workloads ? r.workloads.filter((w) => tasks.includes(w)).length : tasks.length),
    0,
  );
  const setups =
    spec.contenders.length *
    Object.values(spec.vary).reduce((p, values) => p * Math.max(1, values.length), 1);
  return Math.max(1, setups - 1) * covered;
}

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
 * three tasks, no warm-up, at the fewest repeats a per-task verdict can reach significance with
 * (6 each for the curated kit: 36 trials). It answers "is Tandem better than plain Claude Code ON
 * THESE TASKS?" per task (E18); the general task-paired verdict says "insufficient tasks" at 3.
 * The subagents setup and Tandem ×1/×5 stay in the full kit. Re-validated after the cut.
 */
export function headToHeadProfile(
  spec: KitSpec,
): { ok: true; spec: KitSpec } | { ok: false; reason: string } {
  const keep = new Set<string>(HEAD_TO_HEAD_CONTENDERS);
  const shaped = {
    ...spec,
    // Only Tandem ×3 runs here, so its display name says so ("Tandem ×3 was faster on …").
    contenders: spec.contenders
      .filter((c) => keep.has(c.id))
      .map((c) => (c.id === "tandem" ? { ...c, name: HEAD_TO_HEAD_TANDEM_NAME } : c)),
    schedule: { ...spec.schedule, warmups: 0 },
    vary: { ...spec.vary, TANDEM_WORKERS: [3] },
  };
  const cut = {
    ...shaped,
    repeats: Math.max(HEAD_TO_HEAD_REPEATS, minRepeatsForPerTask(perTaskFamily(shaped))),
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

/** The long-horizon kit's smoke workload (its first task). */
export const LONG_HORIZON_SMOKE_WORKLOAD = "project-tracker";

/**
 * The long-horizon kit's smoke profile: only `project-tracker`, 1 repeat, no warm-up, every setup
 * (2 trials: A solo and Tandem ×3). Still up to 3 h and the $25 cap per trial: it checks the
 * pipeline end to end, it answers nothing. Re-validated after the cut.
 */
export function longHorizonSmokeProfile(
  spec: KitSpec,
): { ok: true; spec: KitSpec } | { ok: false; reason: string } {
  const cut = {
    ...spec,
    workloads: spec.workloads.filter((w) => w.id === LONG_HORIZON_SMOKE_WORKLOAD),
    repeats: 1,
    schedule: { ...spec.schedule, warmups: 0 },
  };
  if (cut.workloads.length === 0) {
    return {
      ok: false,
      reason: `the curated long-horizon kit has no ${LONG_HORIZON_SMOKE_WORKLOAD} workload`,
    };
  }
  const r = safeParseKitSpec(cut);
  if (!r.success) {
    return {
      ok: false,
      reason: `the long-horizon smoke profile does not validate: ${formatSchemaIssues(r.error).slice(0, 5).join("; ")}`,
    };
  }
  return { ok: true, spec: r.data };
}

/** The A/A null pilot when the question says "null pilot" (any case). */
export function wantsNullPilot(question: string): boolean {
  return /\bnull[\s-]+pilot\b/i.test(question);
}

/** The null pilot's two arms: Claude Code solo (the baseline) and its identical copy. */
export const NULL_PILOT_BASELINE = "claude-code-solo";
export const NULL_PILOT_TWIN = "claude-code-solo-twin";
export const NULL_PILOT_TWIN_NAME = "A′ · Claude Code solo (identical copy)";

/**
 * The null pilot (E18 18.1, plan.md 17.2 rule 9 "an A-vs-A null run"): Claude Code solo against
 * an identical copy of itself on all three tasks, no warm-up, through the normal pipeline. The
 * copy differs only in id, name and role (the kit schema needs one `subject`); source, install,
 * driver, model, env, caps and versions are the same objects. Tandem and the subagents setup
 * are dropped, and with them `vary` (TANDEM_WORKERS expands only the Tandem driver). The proof
 * overlays that named Tandem (oracle, do-nothing) point at the baseline instead: they replace
 * the driver, so the contender only says which computer they run on, and the gates and tasks
 * they proved are unchanged.
 *
 * Repeats come from the power plan (packages/bench powerPlanForKit), so the pilot runs what the
 * test plan recommends for this shape: 10 per arm × task for a harness kit, 60 trials. The
 * verdicts should all be "no detectable difference". At 3 tasks the general (task-paired) verdict
 * can't fire at all; the per-task verdicts (E18) can, and Holm keeps a false winner to ≤ 5% of
 * runs, so a winner in repeated pilots means the eval is broken.
 * Re-validated after the cut.
 */
export function nullPilotProfile(
  spec: KitSpec,
): { ok: true; spec: KitSpec } | { ok: false; reason: string } {
  const solo = spec.contenders.find((c) => c.id === NULL_PILOT_BASELINE);
  if (!solo) {
    return { ok: false, reason: `the curated Tandem kit has no ${NULL_PILOT_BASELINE} contender` };
  }
  const baseline = { ...solo, role: "baseline" as const };
  const twin = {
    ...solo,
    id: NULL_PILOT_TWIN,
    name: NULL_PILOT_TWIN_NAME,
    role: "subject" as const,
    found_by: `null pilot: an identical copy of ${NULL_PILOT_BASELINE} (A/A test)`,
  };
  const overlay = <T extends { contender?: string | undefined }>(o: T): T =>
    o.contender === undefined || o.contender === NULL_PILOT_BASELINE
      ? o
      : { ...o, contender: NULL_PILOT_BASELINE };
  const shaped = {
    ...spec,
    contenders: [baseline, twin],
    vary: {},
    schedule: { ...spec.schedule, warmups: 0 },
    proof: {
      ...spec.proof,
      ...(spec.proof.oracle ? { oracle: overlay(spec.proof.oracle) } : {}),
      do_less: spec.proof.do_less.map(overlay),
      ...(spec.proof.regression ? { regression: overlay(spec.proof.regression) } : {}),
    },
  };
  const cut = { ...shaped, repeats: powerPlanForKit(shaped).recommendedRepeats };
  const r = safeParseKitSpec(cut);
  if (!r.success) {
    return {
      ok: false,
      reason: `the null pilot profile does not validate: ${formatSchemaIssues(r.error).slice(0, 5).join("; ")}`,
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

/**
 * Which curated kit a spec came from (its workloads are all that kit's), loaded from `kitsDir`;
 * null when it matches neither. The analyst picks the disclosure by it.
 */
export async function curatedKitOfSpec(
  spec: KitSpec,
  kitsDir?: string,
): Promise<CuratedKitId | null> {
  const dir = defaultKitsDir(kitsDir);
  const ids = spec.workloads.map((w) => w.id);
  for (const id of CURATED_KIT_IDS) {
    try {
      const own = new Set((await loadKit(path.join(dir, id))).spec.workloads.map((w) => w.id));
      if (ids.length > 0 && ids.every((w) => own.has(w))) return id;
    } catch (err) {
      if (!(err instanceof KitLoadError)) throw err;
    }
  }
  return null;
}

export function curatedKitStages(opts: { kitsDir?: string } = {}): AgentStagePort {
  const kitsDir = defaultKitsDir(opts.kitsDir);
  /** The curated kit, or why it does not validate (the run then holds for a human). */
  const tandemKit = async (
    id: CuratedKitId,
  ): Promise<{ ok: true; kit: LoadedKit } | { ok: false; reason: string }> => {
    try {
      return { ok: true, kit: await loadKit(path.join(kitsDir, id)) };
    } catch (err) {
      if (!(err instanceof KitLoadError)) throw err;
      return {
        ok: false,
        reason: `the curated Tandem kit does not validate (${id}): ${err.message}`.slice(0, 1900),
      };
    }
  };

  return {
    async understand(ctx, { digest }) {
      if (isTandemRepo(ctx.run.intake.source)) {
        const id = curatedKitFor(ctx.run.question);
        const loaded = await tandemKit(id);
        if (!loaded.ok) return stageHold(loaded.reason);
        const kit = loaded.kit;
        await say(ctx, "understander", `using the curated Tandem kit (${id})`);
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
        return stageHold(
          `the curated Tandem kit (${curatedKitFor(ctx.run.question)}) failed its proof (${failed.join(", ")})`,
        );
      }
      const id = curatedKitFor(ctx.run.question);
      const loaded = await tandemKit(id);
      if (!loaded.ok) {
        await say(ctx, "kit_designer", loaded.reason);
        return stageHold(loaded.reason);
      }
      const kit = loaded.kit;
      // The kit's files on disk (contract C1): kits.files_url = file://<dir> for env_build/proof.
      const files_dir = kit.dir;
      if (id === CURATED_LONG_HORIZON_KIT) {
        await say(
          ctx,
          "kit_designer",
          `using the curated Tandem kit (${id}): the Tandem repo's default, a whole-app build (${curatedDisclosure(id)}); name "${CURATED_TANDEM_KIT}" in the question for the three short tasks`,
        );
        if (wantsSmoke(ctx.run.question)) {
          const smoke = longHorizonSmokeProfile(kit.spec);
          if (!smoke.ok) return stageHold(smoke.reason);
          await say(
            ctx,
            "kit_designer",
            `smoke profile: ${trialCount(smoke.spec)} trials (${LONG_HORIZON_SMOKE_WORKLOAD}, 1 repeat per setup, no warm-up; each up to 3 h); leave out "smoke" for the whole kit`,
          );
          return stageOk({ spec: smoke.spec, files_dir });
        }
        await say(
          ctx,
          "kit_designer",
          `long-horizon profile: ${trialCount(kit.spec)} trials (${kit.spec.contenders.map((c) => c.name).join(" vs ")}, ${kit.spec.workloads.length} task(s) × ${kit.spec.repeats} repeats, no warm-up); say "smoke" for one trial per setup`,
        );
        return stageOk({ spec: kit.spec, files_dir });
      }
      await say(
        ctx,
        "kit_designer",
        `using the curated Tandem kit (${id})${wantsShortTaskKit(ctx.run.question) ? "" : ": the null pilot runs on the three short tasks"}; leave out "${CURATED_TANDEM_KIT}" for the default long-horizon kit (${CURATED_LONG_HORIZON_KIT})`,
      );
      if (wantsNullPilot(ctx.run.question)) {
        const pilot = nullPilotProfile(kit.spec);
        if (!pilot.ok) return stageHold(pilot.reason);
        await say(
          ctx,
          "kit_designer",
          `null pilot profile: ${trialCount(pilot.spec)} trials (Claude Code solo vs an identical copy of itself, ${pilot.spec.workloads.length} tasks × ${pilot.spec.repeats} repeats from the power plan, no warm-up); expect "no detectable difference" everywhere, per task too: a false winner has at most a 5% chance per run (Holm), so winners in repeated pilots mean the eval is broken`,
        );
        return stageOk({ spec: pilot.spec, files_dir });
      }
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
        `head-to-head profile: ${trialCount(h2h.spec)} trials (Claude Code solo vs Tandem ×3, ${h2h.spec.workloads.length} tasks × ${h2h.spec.repeats} repeats, no warm-up; per-task verdicts, Holm across up to ${perTaskFamily(h2h.spec)} task × requirement tests); say "smoke" for a 3-trial check or "full benchmark" for the whole kit`,
      );
      return stageOk({ spec: h2h.spec, files_dir });
    },

    async analyze(ctx, input) {
      // TODO([6.8] analyst): the Naïve analyst for any kit.
      if (!isTandemRepo(ctx.run.intake.source)) return unbuiltAgentStages.analyze(ctx, input);
      const id = await curatedKitOfSpec(input.kit, kitsDir);
      // A spec that matches neither kit keeps the older (Naïve-proxy) wording: proof holds an
      // edited kit before it gets here, so this is a run stored before TDM-233.
      return summaryAnalyst({ disclosure: curatedDisclosure(id ?? CURATED_TANDEM_KIT) })(
        ctx,
        input,
      );
    },
  };
}
