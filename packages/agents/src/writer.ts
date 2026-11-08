// TDM-165 [15.5a]: the outreach writer role. `writer/prompt.md` is the system prompt and
// `writer/config.json` the model, harness, window, budget and toolset. `writer/output.schema.json`
// is the JSON schema Naïve is told to produce; it is generated from the zod schema in
// `@anybench/outreach` (WriterOutputSchema) and a test there keeps the two identical.
import { readFileSync } from "node:fs";
import type { AgentSpec } from "@anybench/naive";
import { z } from "zod";

export const WRITER_ROLE = "writer";

const roleFile = (name: string): URL => new URL(`../writer/${name}`, import.meta.url);

const wireMicroUsd = z
  .number()
  .int()
  .nonnegative()
  .transform((n) => BigInt(n));

export const WriterConfigSchema = z.strictObject({
  role: z.literal(WRITER_ROLE),
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
export type WriterConfig = z.infer<typeof WriterConfigSchema>;

export function loadWriterPrompt(): string {
  return readFileSync(roleFile("prompt.md"), "utf8");
}

export function loadWriterConfig(): WriterConfig {
  return WriterConfigSchema.parse(JSON.parse(readFileSync(roleFile("config.json"), "utf8")));
}

/** The committed `writer/output.schema.json`. */
export function loadWriterOutputJsonSchema(): Record<string, unknown> {
  return z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(readFileSync(roleFile("output.schema.json"), "utf8")));
}

export interface WriterAgentSpecOptions {
  /** Override the model in config.json (e.g. `--model` on the CLI). */
  model?: string;
  /** Per-task cap; defaults to config.json's `max_task_micro_usd`. Raised into the cap if larger. */
  maxTaskMicroUsd?: bigint;
  /** Defaults to the committed `writer/output.schema.json`. */
  outputSchema?: Record<string, unknown>;
}

/** The `ensureAgent` spec for the writer. */
export function writerAgentSpec(options: WriterAgentSpecOptions = {}): AgentSpec {
  const config = loadWriterConfig();
  const maxTask = options.maxTaskMicroUsd ?? config.budget.max_task_micro_usd;
  return {
    role: WRITER_ROLE,
    model: options.model ?? config.model,
    system: loadWriterPrompt(),
    harness: config.harness,
    window: config.window,
    description: config.description,
    budget: {
      capMicroUsd: maxTask > config.budget.cap_micro_usd ? maxTask : config.budget.cap_micro_usd,
      maxTaskMicroUsd: maxTask,
      period: config.budget.period,
    },
    outputSchema: options.outputSchema ?? loadWriterOutputJsonSchema(),
    tools: config.tools,
  };
}
