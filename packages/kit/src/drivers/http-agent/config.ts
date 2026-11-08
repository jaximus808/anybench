// Loading the http-agent mapping config (`adapters/<contender>/http-agent.json`), TDM-40 [4.8].
import { readFile } from "node:fs/promises";
import { formatSchemaIssues } from "@anybench/core";
import { HttpAgentConfigSchema, type HttpAgentConfig } from "./mapping.js";

/** Conventional location of the mapping config inside a kit. */
export const httpAgentConfigPath = (contenderId: string) =>
  `adapters/${contenderId}/http-agent.json`;

export class HttpAgentConfigError extends Error {
  constructor(
    readonly file: string,
    readonly problems: string[],
  ) {
    super(`invalid http-agent config ${file}:\n  ${problems.join("\n  ")}`);
    this.name = "HttpAgentConfigError";
  }
}

/** Parse a config document; throws HttpAgentConfigError with every `path: message`. */
export function parseHttpAgentConfig(raw: unknown, file = "http-agent.json"): HttpAgentConfig {
  const r = HttpAgentConfigSchema.safeParse(raw);
  if (!r.success) throw new HttpAgentConfigError(file, formatSchemaIssues(r.error));
  return r.data;
}

/** Load a config file, or the all-defaults config when `file` is undefined. */
export async function loadHttpAgentConfig(file?: string): Promise<HttpAgentConfig> {
  if (file === undefined) return parseHttpAgentConfig({});
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new HttpAgentConfigError(file, ["file does not exist"]);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new HttpAgentConfigError(file, [`invalid JSON (${(e as Error).message})`]);
  }
  return parseHttpAgentConfig(raw, file);
}
