// `adapters/<contender>/harness.yaml`: the harness driver's config (TDM-41 [4.9]).
//
// run.sh reads this file on the subject computer with a line parser (`sed -n 's/^key: *//p'`), so
// the schema keeps it flat: one `key: value` scalar per line. `parseHarnessConfig` refuses
// anything the line parser would read differently from a YAML parser (nesting, lists, multi-line
// or quoted values, duplicate keys), so what the tests validate is what run.sh runs.
import { readFile } from "node:fs/promises";
import { formatSchemaIssues, KitEnvVarNameSchema } from "@anybench/core";
import { isMap, isScalar, parseDocument } from "yaml";
import { z } from "zod";

/** Conventional location of the config inside a kit. */
export const harnessConfigPath = (contenderId: string) => `adapters/${contenderId}/harness.yaml`;

const Seconds = z.coerce.number().int().positive();
const Words = z
  .string()
  .regex(/^[A-Za-z0-9_./-]+( [A-Za-z0-9_./-]+)*$/, { error: "space-separated words" });
const PromptFile = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\.md$/, { error: "a .md file next to harness.yaml" });

export const HarnessConfigSchema = z.strictObject({
  schema_version: z.coerce.number().pipe(z.literal(1)),
  /** Which harness run.sh drives. Only Tandem today. */
  harness: z.literal("tandem"),
  planner_prompt: PromptFile,
  worker_prompt: PromptFile,
  /** The env var holding the worker count (the kit's `vary` axis). */
  workers_env: KitEnvVarNameSchema,
  /** `--disallowedTools` for every planner and worker session (space-separated tool names). */
  disallowed_tools: Words.optional(),
  completion: z.literal("epics-drained"),
  timeout_s: Seconds,
  startup_timeout_s: Seconds,
  epic_timeout_s: Seconds,
  poll_s: Seconds,
  drain_grace_s: z.coerce.number().int().nonnegative(),
  stop_grace_s: Seconds,
  max_worker_restarts: z.coerce.number().int().nonnegative(),
  /** Workspace paths restored or removed before freeze (space-separated). */
  scrub: Words,
});
export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;

export class HarnessConfigError extends Error {
  constructor(
    readonly file: string,
    readonly problems: string[],
  ) {
    super(`invalid harness config ${file}:\n  ${problems.join("\n  ")}`);
    this.name = "HarnessConfigError";
  }
}

/**
 * What run.sh's `cfg <key>` returns for each key: the text after `key:` on the first matching
 * line, with a trailing ` # comment` and trailing blanks dropped.
 */
export function readFlatConfig(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*):[ \t]*(.*)$/.exec(line);
    if (!m || out.has(m[1]!)) continue;
    out.set(m[1]!, m[2]!.replace(/[ \t]#.*$/, "").replace(/[ \t]+$/, ""));
  }
  return out;
}

/** Parse harness.yaml text; throws HarnessConfigError with every problem. */
export function parseHarnessConfig(text: string, file = "harness.yaml"): HarnessConfig {
  const problems: string[] = [];
  const doc = parseDocument(text, { uniqueKeys: true });
  for (const e of doc.errors) problems.push(e.message);
  const flat = readFlatConfig(text);
  const raw: Record<string, string> = {};
  if (problems.length === 0) {
    if (!isMap(doc.contents)) problems.push("must be a mapping of `key: value` lines");
    else
      for (const item of doc.contents.items) {
        const key = isScalar(item.key) ? String(item.key.value) : String(item.key);
        if (!isScalar(item.value) || typeof item.value.value === "object") {
          problems.push(`${key}: must be one scalar on the key's line (run.sh reads it with sed)`);
          continue;
        }
        const yamlValue = String(item.value.value);
        const lineValue = flat.get(key);
        if (lineValue !== yamlValue)
          problems.push(
            `${key}: run.sh would read ${JSON.stringify(lineValue ?? null)} but YAML says ${JSON.stringify(yamlValue)} (no quotes, no multi-line values)`,
          );
        raw[key] = yamlValue;
      }
  }
  if (problems.length > 0) throw new HarnessConfigError(file, problems);
  const r = HarnessConfigSchema.safeParse(raw);
  if (!r.success) throw new HarnessConfigError(file, formatSchemaIssues(r.error));
  return r.data;
}

export async function loadHarnessConfig(file: string): Promise<HarnessConfig> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new HarnessConfigError(file, ["file does not exist"]);
  }
  return parseHarnessConfig(text, file);
}

/** `disallowed_tools` / `scrub` as a list. */
export const harnessWords = (s: string | undefined): string[] =>
  s === undefined ? [] : s.split(" ").filter((w) => w !== "");
