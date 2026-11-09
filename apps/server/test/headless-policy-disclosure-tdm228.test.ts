// TDM-228 [21.2]: the report's disclosure states the harness league's headless policy, with the
// same reply, cap and id the policy file applies, and lists how often it fired per setup.
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultKitsDir } from "../src/orchestrator/curated.js";
import type { StageTrial } from "../src/orchestrator/ports.js";
import {
  autoAnswerLine,
  HARNESS_LEAGUE_DISCLOSURE,
  HEADLESS_POLICY_ID,
  HEADLESS_POLICY_MAX,
  HEADLESS_POLICY_REPLY,
  LONG_HORIZON_DISCLOSURE,
} from "../src/orchestrator/proof-score.js";

const policyUrlTdm228 = pathToFileURL(
  path.join(defaultKitsDir(), "harness-league/adapters/headless-policy/policy.mjs"),
).href;

function trialTdm228(contender: string, repeat: number, metrics: unknown): StageTrial {
  return {
    id: `${contender}-${repeat}`,
    contender,
    contender_id: contender,
    workload_id: "project-tracker",
    repeat,
    state: "done",
    attempt: 1,
    metrics,
    gate: null,
    cost_micro_usd: 0n,
  };
}

describe("headless policy disclosure (TDM-228)", () => {
  it("matches the policy the league kit applies", async () => {
    const p = (await import(policyUrlTdm228)) as {
      POLICY_ID: string;
      REPLY: string;
      MAX_AUTO_ANSWERS: number;
    };
    expect(HEADLESS_POLICY_ID).toBe(p.POLICY_ID);
    expect(HEADLESS_POLICY_REPLY).toBe(p.REPLY);
    expect(HEADLESS_POLICY_MAX).toBe(p.MAX_AUTO_ANSWERS);
    expect(HARNESS_LEAGUE_DISCLOSURE.startsWith(`${LONG_HORIZON_DISCLOSURE}; `)).toBe(true);
    expect(HARNESS_LEAGUE_DISCLOSURE).toContain(`"${p.REPLY}"`);
    expect(HARNESS_LEAGUE_DISCLOSURE).toContain(`at most ${p.MAX_AUTO_ANSWERS} times per trial`);
    // The league README quotes the disclosure word for word (wrapped lines folded).
    const readme = readFileSync(path.join(defaultKitsDir(), "harness-league/README.md"), "utf8")
      .replace(/\s*\n\s*/g, " ")
      .replaceAll("`", "");
    expect(readme).toContain(HARNESS_LEAGUE_DISCLOSURE);
  });

  it("lists the firings per setup over measured trials, and nothing when no trial has them", () => {
    const names: Record<string, string> = {
      "claude-code-solo": "A · Claude Code solo",
      superpowers: "S · Claude Code + Superpowers",
    };
    const nameOf = (id: string) => names[id] ?? id;
    const trials = [
      trialTdm228("claude-code-solo", 0, { questions_auto_answered: 0 }),
      trialTdm228("claude-code-solo", 1, { questions_auto_answered: 0 }),
      trialTdm228("superpowers", 0, { questions_auto_answered: 2 }),
      trialTdm228("superpowers", 1, { questions_auto_answered: 1 }),
      trialTdm228("superpowers", -1, { questions_auto_answered: 5 }), // warm-up: not counted
      trialTdm228("tandem", 0, { wall_s: 10 }), // no policy: not listed
    ];
    expect(autoAnswerLine(trials, nameOf)).toBe(
      "questions auto-answered (headless policy): A · Claude Code solo 0 in 2 trials; S · Claude Code + Superpowers 3 in 2 trials",
    );
    expect(autoAnswerLine([trialTdm228("tandem", 0, { wall_s: 1 })], nameOf)).toBeNull();
  });
});
