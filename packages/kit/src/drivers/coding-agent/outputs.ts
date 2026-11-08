// What a coding-agent trial leaves in EVAL_OUT, and how it reaches the collectors (TDM-39).
//
// The driver tees Claude Code's stream-json to its stdout (the runner meters it for the BYOK
// token cap) and to `stream.jsonl`, the path `@anybench/bench` reads the stream-json collector
// from (COLLECTOR_OUTPUT_FILES). `readCodingAgentCollectorOutputs` returns it in bench's
// `CollectorInput` shape, so a trial's rows are
//   collect((await readCodingAgentCollectorOutputs(out)).inputs, kit.requirements)
// (`@anybench/kit` cannot import bench, which depends on it; bench's TDM-39 test pins the shape).
//
// The workspace the agent left is frozen to `workspace/`: that is what the hidden-tests gate on
// the scoring computer tests (`check.sh <frozen-out> <workload> <gate.json>`, TDM-51).
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { isPinnedModelId, isPinnedVersion } from "../../comparability.js";

/** Paths under EVAL_OUT written by the coding-agent driver, relative to it. */
export const CODING_AGENT_OUTPUT_PATHS = {
  /** Collector `stream-json`: Claude Code's stream-json, secrets redacted. */
  stream: "stream.jsonl",
  /** Pinned and observed versions (Claude Code, model, node), written before the run. */
  versions: "versions.json",
  /** The workspace as the agent left it (symlinks leaving it dropped): what the gate tests. */
  workspace: "workspace",
  /** Claude Code's exit status, one integer and a newline. */
  exitCode: "coding-agent/exit_code",
  /** Claude Code's stderr, secrets redacted. */
  stderr: "coding-agent/stderr.txt",
  /** Why the driver failed the trial, when it did (pin mismatch, missing secret, ...). */
  error: "coding-agent/error.txt",
  /** Written when the BYOK token cap stopped the run: `{token_cap_tokens, tokens}`. */
  tokenCap: "coding-agent/token-cap.json",
  /** Symlinks in the workspace that pointed outside it, removed before the freeze. */
  droppedLinks: "coding-agent/dropped-links.txt",
} as const;

/** `versions.json`: what the trial was pinned to and what actually ran. */
export const CodingAgentVersionsSchema = z.strictObject({
  contender: z.string().min(1),
  claude_code: z.string().min(1),
  claude_code_reported: z.string(),
  model: z.string().min(1),
  node: z.string(),
  eval_user: z.string().min(1),
  max_turns: z.string(),
  token_cap_tokens: z.string(),
  disallowed_tools: z.string(),
  /** Where the tokens came from (disclosed on the report): `naive-proxy` or `anthropic-key`. */
  token_source: z.enum(["naive-proxy", "anthropic-key"]),
  /** Who served the tokens: `anthropic` (BYOK) or `naive:<vendor>` (e.g. `naive:anthropic`). */
  provider: z.string().min(1),
  /** `naive-min` on the Naïve proxy (no client-chosen effort), else `default`. */
  effort: z.string(),
  /** `off` when the proxy env sets MAX_THINKING_TOKENS=0, else the value or `default`. */
  thinking: z.string(),
  /** CLAUDE_CODE_MODEL_CAPABILITIES from the proxy env (capabilities turned off), or empty. */
  model_capabilities: z.string(),
  do_less: z.boolean(),
});
export type CodingAgentVersions = z.infer<typeof CodingAgentVersionsSchema>;

/** Raw collector output in the shape bench's `collect()` takes. */
export interface CodingAgentCollectorOutput {
  collector: "stream-json";
  raw: string;
}

/**
 * Read the stream-json a coding-agent trial wrote. A missing file is reported in `missing`,
 * never invented: bench then lists the requirement as `metric missing`.
 */
export async function readCodingAgentCollectorOutputs(
  outDir: string,
): Promise<{ inputs: CodingAgentCollectorOutput[]; missing: "stream-json"[] }> {
  const file = join(outDir, CODING_AGENT_OUTPUT_PATHS.stream);
  const st = await lstat(file).catch(() => undefined);
  if (!st?.isFile()) return { inputs: [], missing: ["stream-json"] };
  return { inputs: [{ collector: "stream-json", raw: await readFile(file, "utf8") }], missing: [] };
}

/** The `system/init` event of a stream-json transcript: what Claude Code says it ran. */
export interface StreamJsonInit {
  model: string | null;
  claude_code_version: string | null;
}

/** First `{"type":"system","subtype":"init"}` line, or null when there is none. */
export function readStreamJsonInit(stream: string): StreamJsonInit | null {
  for (const line of stream.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{") || !t.includes('"init"')) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    const e = ev as {
      type?: unknown;
      subtype?: unknown;
      model?: unknown;
      claude_code_version?: unknown;
    };
    if (e.type !== "system" || e.subtype !== "init") continue;
    return {
      model: typeof e.model === "string" ? e.model : null,
      claude_code_version: typeof e.claude_code_version === "string" ? e.claude_code_version : null,
    };
  }
  return null;
}

export interface PinCheck {
  ok: boolean;
  problems: string[];
}

/**
 * Plan.md 17.2 rule 4 on one trial: the pins are exact, and what ran (Claude Code's `--version`
 * and the stream-json `init` event) is what was pinned. A trial that fails this is not comparable
 * and must not be scored.
 */
export function checkCodingAgentPins(
  versions: CodingAgentVersions,
  stream: string,
  expected?: { claude_code_version?: string; model?: string },
): PinCheck {
  const problems: string[] = [];
  if (!isPinnedVersion(versions.claude_code))
    problems.push(`Claude Code version '${versions.claude_code}' is not a pin`);
  if (!isPinnedModelId(versions.model)) problems.push(`model '${versions.model}' is not a pin`);
  if (
    expected?.claude_code_version !== undefined &&
    versions.claude_code !== expected.claude_code_version
  )
    problems.push(
      `Claude Code ${versions.claude_code} ran, but the kit pins ${expected.claude_code_version}`,
    );
  if (expected?.model !== undefined && versions.model !== expected.model)
    problems.push(`model ${versions.model} ran, but the kit pins ${expected.model}`);
  const reported = versions.claude_code_reported.trim().split(/\s+/)[0] ?? "";
  if (reported !== versions.claude_code)
    problems.push(
      `claude --version says '${versions.claude_code_reported}', not ${versions.claude_code}`,
    );
  const init = readStreamJsonInit(stream);
  if (init === null) problems.push("the stream has no system/init event");
  else {
    if (init.model !== versions.model)
      problems.push(
        `the stream's init event ran model ${init.model ?? "(none)"}, not ${versions.model}`,
      );
    if (init.claude_code_version !== null && init.claude_code_version !== versions.claude_code)
      problems.push(
        `the stream's init event says Claude Code ${init.claude_code_version}, not ${versions.claude_code}`,
      );
  }
  return { ok: problems.length === 0, problems };
}
