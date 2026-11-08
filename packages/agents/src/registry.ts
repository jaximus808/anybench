// TDM-55 [6.1]: the agent role registry. One folder per Naïve role, next to src/:
//
//   packages/agents/<role>/prompt.md           the system prompt (required)
//   packages/agents/<role>/config.json         model, harness, window, description, budget, tools (required)
//   packages/agents/<role>/output.schema.json  the JSON schema the session's final document must match
//
// config.json has the same shape as the TDM-164 scout's. `roleAgentSpec` turns a role into the
// `ensureAgent` spec of @anybench/naive, whose fingerprint covers the whole spec (prompt included),
// so a prompt change mints a new agent version and an unchanged role is a no-op.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HARNESSES, WINDOWS, type AgentSpec } from "@anybench/naive";
import { z } from "zod";

/** The package root: every directory in it with a config.json is a role. */
export const DEFAULT_ROLES_DIR = fileURLToPath(new URL("../", import.meta.url));

export const ROLE_NAME = /^[a-z][a-z0-9_-]*$/;
export const RoleNameSchema = z
  .string()
  .regex(ROLE_NAME, "role must be lowercase kebab/snake case");

/** Integer micro-USD in JSON: a non-negative integer or its decimal string. Never a fraction. */
const wireMicroUsd = z
  .union([z.int().nonnegative(), z.string().regex(/^(0|[1-9]\d*)$/)])
  .transform((v) => BigInt(v));

export const RoleConfigSchema = z
  .strictObject({
    role: RoleNameSchema,
    model: z.string().min(1),
    harness: z.enum(HARNESSES),
    window: z.enum(WINDOWS),
    description: z.string().min(1),
    budget: z.strictObject({
      cap_micro_usd: wireMicroUsd,
      max_task_micro_usd: wireMicroUsd,
      period: z.enum(["day", "week", "month"]),
    }),
    /** Naïve toolset. The SDK refuses one without `configs` (TDM-164 finding), so it is required. */
    tools: z.looseObject({ configs: z.record(z.string(), z.unknown()) }),
  })
  .refine((c) => c.budget.max_task_micro_usd <= c.budget.cap_micro_usd, {
    message: "budget.max_task_micro_usd must be at most budget.cap_micro_usd",
    path: ["budget", "max_task_micro_usd"],
  });
export type RoleConfig = z.infer<typeof RoleConfigSchema>;

export interface RoleDefinition {
  role: string;
  /** Absolute path of the role folder. */
  dir: string;
  config: RoleConfig;
  prompt: string;
  /** `output.schema.json`, or null when the role answers in plain text. */
  outputSchema: Record<string, unknown> | null;
  /** sha256 of prompt.md (hex), for the sync plan. */
  promptSha256: string;
}

export interface RegistryOptions {
  /** Where role folders live. Default: the package root (DEFAULT_ROLES_DIR). */
  rolesDir?: string;
}

export class RoleError extends Error {
  override readonly name = "RoleError";
  constructor(
    readonly role: string,
    message: string,
  ) {
    super(message);
  }
}

const JsonObjectSchema = z.record(z.string(), z.unknown());

function readJson(file: string, role: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    throw new RoleError(
      role,
      `${path.basename(file)} of role "${role}" is not valid JSON: ${String(error)}`,
    );
  }
}

function issuesOf(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/** Loads and validates one role folder. Throws RoleError when it is missing or malformed. */
export function loadRole(role: string, options: RegistryOptions = {}): RoleDefinition {
  if (!ROLE_NAME.test(role)) throw new RoleError(role, `"${role}" is not a role name`);
  const dir = path.join(options.rolesDir ?? DEFAULT_ROLES_DIR, role);
  const configFile = path.join(dir, "config.json");
  const promptFile = path.join(dir, "prompt.md");
  if (!existsSync(configFile)) throw new RoleError(role, `role "${role}" has no ${configFile}`);
  if (!existsSync(promptFile)) throw new RoleError(role, `role "${role}" has no ${promptFile}`);

  const config = RoleConfigSchema.safeParse(readJson(configFile, role));
  if (!config.success) {
    throw new RoleError(
      role,
      `config.json of role "${role}" is invalid: ${issuesOf(config.error)}`,
    );
  }
  if (config.data.role !== role) {
    throw new RoleError(
      role,
      `config.json of folder "${role}" names role "${config.data.role}"; they must match`,
    );
  }
  const prompt = readFileSync(promptFile, "utf8");
  if (prompt.trim() === "") throw new RoleError(role, `prompt.md of role "${role}" is empty`);

  const schemaFile = path.join(dir, "output.schema.json");
  let outputSchema: Record<string, unknown> | null = null;
  if (existsSync(schemaFile)) {
    const parsed = JsonObjectSchema.safeParse(readJson(schemaFile, role));
    if (!parsed.success) {
      throw new RoleError(role, `output.schema.json of role "${role}" must be a JSON object`);
    }
    outputSchema = parsed.data;
  }
  return {
    role,
    dir,
    config: config.data,
    prompt,
    outputSchema,
    promptSha256: createHash("sha256").update(prompt).digest("hex"),
  };
}

/** Every role folder (a directory holding a config.json), sorted by name. */
export function listRoles(options: RegistryOptions = {}): string[] {
  const root = options.rolesDir ?? DEFAULT_ROLES_DIR;
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => ROLE_NAME.test(name) && name !== "node_modules")
    .filter((name) => {
      const dir = path.join(root, name);
      return statSync(dir).isDirectory() && existsSync(path.join(dir, "config.json"));
    })
    .sort();
}

export interface RoleSpecOverrides {
  /** Naïve agent name; default `anybench-<role>`. */
  name?: string;
  /** Replace config.json's model (e.g. a `--model` flag, or a cheaper model in a live test). */
  model?: string;
  /** Per-task cap; default config.json's `max_task_micro_usd`. Raises the cap when larger. */
  maxTaskMicroUsd?: bigint;
  /** Replace output.schema.json. `null` drops it (plain-text answers). */
  outputSchema?: Record<string, unknown> | null;
  /** Replace the prompt (tests). */
  system?: string;
}

/** The `ensureAgent` spec for a role (a name, loaded from its folder, or an already loaded definition). */
export function roleAgentSpec(
  role: string | RoleDefinition,
  overrides: RoleSpecOverrides & RegistryOptions = {},
): AgentSpec {
  const def = typeof role === "string" ? loadRole(role, overrides) : role;
  const { config } = def;
  const maxTask = overrides.maxTaskMicroUsd ?? config.budget.max_task_micro_usd;
  const outputSchema =
    overrides.outputSchema === undefined ? def.outputSchema : overrides.outputSchema;
  return {
    role: def.role,
    ...(overrides.name !== undefined ? { name: overrides.name } : {}),
    model: overrides.model ?? config.model,
    system: overrides.system ?? def.prompt,
    harness: config.harness,
    window: config.window,
    description: config.description,
    budget: {
      capMicroUsd: maxTask > config.budget.cap_micro_usd ? maxTask : config.budget.cap_micro_usd,
      maxTaskMicroUsd: maxTask,
      period: config.budget.period,
    },
    ...(outputSchema !== null ? { outputSchema } : {}),
    tools: config.tools,
  };
}
