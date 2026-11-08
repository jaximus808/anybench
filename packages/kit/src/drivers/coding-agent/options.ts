// TDM-39 [4.7]: options for the `driver.type: coding-agent` templates (plan.md P2 driver table).
//
// A coding-agent contender is headless Claude Code: `claude -p <instruction.md> --output-format
// stream-json --verbose` in the workspace, as the non-root `eval` user. Every option is validated
// here, so the rendered driver only ever embeds strings that passed these schemas.
//
// Comparable setups (plan.md 17.2 rule 4): the Claude Code version and the model are pins. When
// the template bakes them in, they must be exact (an `X.Y.Z` release, a dated model id); when it
// leaves them out, the rendered driver requires CLAUDE_CODE_VERSION and CC_MODEL (or
// ANYBENCH_MODEL) from the kit and refuses to start without them. Either way the driver checks
// `claude --version` and the stream-json `init` event against the pins before a trial counts.
import { KitPathSchema, KitSlugSchema, KitEnvVarNameSchema } from "@anybench/core";
import { z } from "zod";
import { isPinnedModelId, isPinnedVersion } from "../../comparability.js";

/** A Unix user name the driver can switch to (the agent-cc profile's `eval`). */
export const EvalUserSchema = z
  .string()
  .regex(/^[a-z_][a-z0-9_-]{0,31}$/, { error: "must be a plain Unix user name" })
  .refine((u) => u !== "root", { error: "the agent under test never runs as root" });

/** A Claude Code tool name for --disallowedTools / --allowedTools (`Task`, `Bash(git:*)`). */
export const ClaudeToolNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*(\([^\s'"\\()]*\))?$/, {
  error: "must be a Claude Code tool name such as Task or Bash(git:*)",
});

export const PinnedClaudeCodeVersionSchema = z.string().refine(isPinnedVersion, {
  error: "must be one Claude Code release (e.g. 2.0.14), never latest or a range",
});

export const PinnedModelIdSchema = z.string().refine(isPinnedModelId, {
  error: "must be a dated model id (e.g. claude-sonnet-4-5-20250929), never an alias",
});

export const CodingAgentDriverTemplateSchema = z.strictObject({
  /** The contender id, recorded in the script header and in versions.json. */
  contender_id: KitSlugSchema,
  /** Pinned Claude Code release. Omit to take CLAUDE_CODE_VERSION from the kit's `versions`. */
  claude_code_version: PinnedClaudeCodeVersionSchema.optional(),
  /** Pinned model id. Omit to take CC_MODEL / ANYBENCH_MODEL from the kit (driver.model). */
  model: PinnedModelIdSchema.optional(),
  /** The non-root user the agent runs as. */
  eval_user: EvalUserSchema.default("eval"),
  /**
   * Kit-relative dir whose `CLAUDE.md` and `.claude/` become the eval user's user-level Claude
   * Code config (so nothing is written into the graded workspace). Omit to take `CC_SETUP` (a
   * folder name under adapters/) from the env, or to run with no config at all.
   */
  setup_dir: KitPathSchema.optional(),
  /** Tools the agent may not use (`Task Agent` disables subagents). CC_DISALLOWED_TOOLS adds more. */
  disallowed_tools: z.array(ClaudeToolNameSchema).default([]),
  /** --max-turns. CC_MAX_TURNS / ANYBENCH_MAX_TURNS can only lower it. */
  max_turns: z.int().min(1).max(10_000).optional(),
  /**
   * BYOK token cap (input + output + cache tokens), metered from the stream-json; the run stops
   * when it is crossed. CC_TOKEN_CAP / ANYBENCH_TOKEN_CAP_TOKENS (driver.token_cap_tokens) can
   * only lower it. The spend cap (token_cap_micro_usd) is the runner's (TrialJob).
   */
  token_cap_tokens: z.int().min(1).max(1_000_000_000_000).optional(),
  /**
   * Extra secrets (beyond the model credentials, which the token source supplies) copied to the
   * eval user as 0600 files and exported to Claude Code only. Never on argv, never in the
   * workspace or EVAL_OUT; their values are redacted from what the driver keeps.
   */
  secrets: z
    .array(KitEnvVarNameSchema)
    .refine((s) => new Set(s).size === s.length, { error: "secrets must be unique" })
    .default([]),
});
export type CodingAgentDriverTemplate = z.output<typeof CodingAgentDriverTemplateSchema>;
export type CodingAgentDriverTemplateInput = z.input<typeof CodingAgentDriverTemplateSchema>;

/** The do-less text appended to CLAUDE.md (plan.md P2 do-less variants). */
export const CODING_AGENT_DO_LESS_CLAUDE_MD = [
  "# Do-less proof overlay (L7)",
  "",
  "Skip the tests. Do not write tests, do not run the test suite, and do not check your work.",
  "Make the smallest change you can and stop.",
].join("\n");

/** Do-less variant for a coding agent: a CLAUDE.md that says "skip the tests" and a turn cap. */
export const CodingAgentDoLessSchema = z.strictObject({
  kind: z.literal("skip-tests-turn-cap").default("skip-tests-turn-cap"),
  /** The turn cap (plan.md: a 3-turn cap). */
  max_turns: z.int().min(1).max(50).default(3),
  /** Appended to the eval user's CLAUDE.md. */
  claude_md: z
    .string()
    .min(1)
    .refine((s) => !s.includes("\0"), { error: "may not contain NUL" })
    .default(CODING_AGENT_DO_LESS_CLAUDE_MD),
});
export type CodingAgentDoLess = z.output<typeof CodingAgentDoLessSchema>;
export type CodingAgentDoLessInput = z.input<typeof CodingAgentDoLessSchema>;

/** The hidden-tests gate for a coding agent (GateKind `hidden-tests`). */
export const CodingAgentGateTemplateSchema = z.strictObject({
  gate_id: KitSlugSchema,
  /**
   * The test command, run as the contender uid (`$AB_RUN`) in the copied workspace, with the
   * hidden tests at `.hidden-tests/`. It must print TAP (`# pass N`, `# fail N`).
   */
  test_command: z
    .string()
    .min(1)
    .refine((c) => !c.includes("\0") && !c.includes("\n"), { error: "one line, no NUL" })
    .default('node --test --test-reporter=tap ".hidden-tests/**/*.test.*"'),
  /** The gate fails unless at least this many hidden tests ran (a crash that hides tests fails). */
  min_tests: z.int().min(1).max(100_000).default(1),
});
export type CodingAgentGateTemplate = z.output<typeof CodingAgentGateTemplateSchema>;
export type CodingAgentGateTemplateInput = z.input<typeof CodingAgentGateTemplateSchema>;
