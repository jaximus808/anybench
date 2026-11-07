// anybench.yaml text → KitSpec, with every schema error placed at anybench.yaml:LINE:COL (TDM-33 [4.1]).
// No filesystem access: ingest and the kit designer can call this on text they are writing.
import { formatIssuePath, type KitSpec, safeParseKitSpec } from "@anybench/core";
import type { KitIssue } from "./issues.js";
import { KIT_LAYOUT } from "./layout.js";
import { type KitYamlSource, parseKitYaml, positionOf } from "./yaml-source.js";

export interface KitManifestParse {
  /** Set when the YAML parsed and the KitSpec validated. */
  spec?: KitSpec;
  source: KitYamlSource;
  errors: KitIssue[];
  warnings: KitIssue[];
}

type ParseFailure = Extract<ReturnType<typeof safeParseKitSpec>, { success: false }>;
type SchemaIssue = ParseFailure["error"]["issues"][number];

/** Turn one zod issue into a positioned KitIssue. Same `path: message` text as formatSchemaIssues. */
export function schemaIssueToKitIssue(
  source: Pick<KitYamlSource, "doc" | "lineCounter" | "file">,
  issue: SchemaIssue,
): KitIssue {
  let lookup: readonly PropertyKey[] = issue.path;
  let preferKey = false;
  // strictObject typos: point at the offending key, not at its parent.
  if (issue.code === "unrecognized_keys" && issue.keys.length > 0) {
    lookup = [...issue.path, issue.keys[0] as string];
    preferKey = true;
  }
  const pos = positionOf(source, lookup, { preferKey });
  return {
    severity: "error",
    code: "schema",
    file: source.file,
    ...(pos ? { line: pos.line, col: pos.col } : {}),
    path: formatIssuePath(issue.path),
    message: issue.message,
  };
}

export function parseKitManifest(
  text: string,
  file: string = KIT_LAYOUT.manifest,
): KitManifestParse {
  const source = parseKitYaml(text, file);
  if (source.errors.length > 0) {
    return { source, errors: source.errors, warnings: source.warnings };
  }
  const r = safeParseKitSpec(source.data);
  if (!r.success) {
    return {
      source,
      errors: r.error.issues.map((i) => schemaIssueToKitIssue(source, i)),
      warnings: source.warnings,
    };
  }
  return { spec: r.data, source, errors: [], warnings: source.warnings };
}
