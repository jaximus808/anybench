// Readable kit errors with file:line:col (TDM-33 [4.1]).
//
// Every problem with a kit is a KitIssue. Formatted, it reads like a compiler error:
//   anybench.yaml:14:9: requirements[1].gate_id: gate 'same-output' is not defined in gates[]
//   anybench.yaml:6:7: contenders[0].driver: adapters/rg/driver.sh does not exist (...)
//   anybench.yaml: not found in /path/to/kit

export type KitIssueCode =
  | "kit_dir_missing"
  | "manifest_missing"
  | "manifest_symlink"
  | "yaml_syntax"
  | "yaml_warning"
  | "schema"
  | "missing_file"
  | "wrong_file_type"
  | "outside_kit"
  | "not_executable"
  | "workload_empty"
  | "workload_symlink"
  | "workload_special_file"
  | "workload_sha256_mismatch"
  | "rubric_criterion_missing"
  | "proof_dir_misplaced"
  | "unused_dir";

export interface KitIssue {
  severity: "error" | "warning";
  code: KitIssueCode;
  /** Relative to the kit root, usually `anybench.yaml`. */
  file: string;
  /** 1-based, when the issue maps to a position in `file`. */
  line?: number;
  col?: number;
  /** The KitSpec field, formatted like core's formatIssuePath (`requirements[1].gate_id`). */
  path?: string;
  message: string;
}

/** `anybench.yaml:14:9: requirements[1].gate_id: message`. */
export function formatKitIssue(issue: KitIssue): string {
  const where =
    issue.line === undefined ? issue.file : `${issue.file}:${issue.line}:${issue.col ?? 1}`;
  return `${where}: ${issue.path === undefined ? "" : `${issue.path}: `}${issue.message}`;
}

/** Thrown by loadKit when a kit has at least one error. `issues` holds only errors. */
export class KitLoadError extends Error {
  override readonly name = "KitLoadError";
  readonly dir: string;
  readonly issues: readonly KitIssue[];
  readonly warnings: readonly KitIssue[];

  constructor(dir: string, issues: readonly KitIssue[], warnings: readonly KitIssue[] = []) {
    const lines = issues.map((i) => `  ${formatKitIssue(i)}`).join("\n");
    super(
      `kit at ${dir} is invalid (${issues.length} error${issues.length === 1 ? "" : "s"}):\n${lines}`,
    );
    this.dir = dir;
    this.issues = issues;
    this.warnings = warnings;
  }

  /** One formatted line per error. */
  get lines(): string[] {
    return this.issues.map(formatKitIssue);
  }
}
