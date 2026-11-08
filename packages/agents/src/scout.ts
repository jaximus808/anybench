// TDM-164 [15.3a]: the outreach scout role. `scout/prompt.md` is the system prompt and
// `scout/config.json` the model, harness, window, budget and toolset. `scout/output.schema.json`
// is the JSON schema Naïve is told to produce; it is generated from the zod schema in
// `@anybench/outreach` (ScoutOutputSchema) and a test there keeps the two identical.
import { readFileSync } from "node:fs";
import type { AgentSpec } from "@anybench/naive";
import { z } from "zod";

export const SCOUT_ROLE = "scout";

const roleFile = (name: string): URL => new URL(`../scout/${name}`, import.meta.url);

const wireMicroUsd = z
  .number()
  .int()
  .nonnegative()
  .transform((n) => BigInt(n));

export const ScoutConfigSchema = z.strictObject({
  role: z.literal(SCOUT_ROLE),
  model: z.string().min(1),
  harness: z.enum(["pi", "claude_code", "vetta", "hermes"]),
  window: z.enum(["immediate", "priority", "loose"]),
  description: z.string().min(1),
  budget: z.strictObject({
    cap_micro_usd: wireMicroUsd,
    max_task_micro_usd: wireMicroUsd,
    period: z.enum(["day", "week", "month"]),
  }),
  tools: z.record(z.string(), z.unknown()),
});
export type ScoutConfig = z.infer<typeof ScoutConfigSchema>;

export function loadScoutPrompt(): string {
  return readFileSync(roleFile("prompt.md"), "utf8");
}

export function loadScoutConfig(): ScoutConfig {
  return ScoutConfigSchema.parse(JSON.parse(readFileSync(roleFile("config.json"), "utf8")));
}

/** The committed `scout/output.schema.json`. */
export function loadScoutOutputJsonSchema(): Record<string, unknown> {
  return z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(readFileSync(roleFile("output.schema.json"), "utf8")));
}

export interface ScoutAgentSpecOptions {
  /** Override the model in config.json (e.g. `--model` on the CLI). */
  model?: string;
  /** Per-task cap; defaults to config.json's `max_task_micro_usd`. Raised into the cap if larger. */
  maxTaskMicroUsd?: bigint;
  /** Defaults to the committed `scout/output.schema.json`. */
  outputSchema?: Record<string, unknown>;
}

/** The `ensureAgent` spec for the scout. */
export function scoutAgentSpec(options: ScoutAgentSpecOptions = {}): AgentSpec {
  const config = loadScoutConfig();
  const maxTask = options.maxTaskMicroUsd ?? config.budget.max_task_micro_usd;
  return {
    role: SCOUT_ROLE,
    model: options.model ?? config.model,
    system: loadScoutPrompt(),
    harness: config.harness,
    window: config.window,
    description: config.description,
    budget: {
      capMicroUsd: maxTask > config.budget.cap_micro_usd ? maxTask : config.budget.cap_micro_usd,
      maxTaskMicroUsd: maxTask,
      period: config.budget.period,
    },
    outputSchema: options.outputSchema ?? loadScoutOutputJsonSchema(),
    tools: config.tools,
  };
}
