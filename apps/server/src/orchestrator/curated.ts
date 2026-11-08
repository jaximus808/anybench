// CuratedKitStage (TDM-54): the agent stages for the founder's live test, until the E6 roles land.
//
//   understand  pass-through: the subject from the digest (or the curated kit), with an event.
//   research    pass-through: no new baselines (the curated kit names its own), with an event.
//   designKit   github.com/jaximus808/tandem (any case, with or without .git) → the curated kit
//               `kits/tandem-vs-claude-code` from this repo's kits/ directory, validated by
//               packages/kit loadKit. Any other repo → needs_human with CURATED_KIT_UNAVAILABLE.
//               TODO([6.6] TDM-60 kit designer): design kits for any repo on Naïve.
//   analyze     not built ([6.8]).
//
// Events: each stage writes an `agent.message` (source_id `curated:<role>`) so the live run page
// shows what happened; the orchestrator writes run.state_changed for every transition.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KitLoadError, loadKit, type LoadedKit } from "@anybench/kit";
import {
  stageHold,
  stageOk,
  unbuiltAgentStages,
  type AgentStagePort,
  type StageContext,
  type Understanding,
} from "./ports.js";

export const CURATED_TANDEM_KIT = "tandem-vs-claude-code";
export const CURATED_KIT_UNAVAILABLE =
  "automatic kit design for this repo isn't available yet; we'll set it up for you";

const TANDEM_REPO =
  /^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?jaximus808\/tandem(?:\.git)?\/?$/i;

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
      await say(ctx, "kit_designer", `using the curated Tandem kit (${CURATED_TANDEM_KIT})`);
      return stageOk({ spec: kit.spec });
    },

    analyze: unbuiltAgentStages.analyze,
  };
}
