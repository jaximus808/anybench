// TDM-56 [6.2]: the understander role (packages/agents/understander/) as typed code.
//
//   buildUnderstanderInput(digest, context)  the task message: the digest plus the repo context
//                                            (numbered README, tree summary, manifests, tests,
//                                            test-commit count), capped so a session stays cheap.
//   UnderstanderOutputSchema                 the model's answer (matches output.schema.json).
//   decideUnderstanding(output, ingest)      the verdict, enforced IN CODE after the model answers:
//                                            a "cli" with no executable is a library; service, lib,
//                                            pty, web, x11 (and http-agent without a labelled
//                                            conversation set in the tree) are not supported yet;
//                                            needs_hardware holds; skip, or a repo with nothing
//                                            runnable, fails; claims whose quote is not on the
//                                            cited README line are dropped.
//
// The result's `understanding` is what the orchestrator stores (apps/server ports.ts
// UnderstandingSchema, which spreads UnderstandingExtrasShape so old rows still parse).
import {
  DriverTypeSchema,
  SubjectKindSchema,
  type DriverType,
  type ProjectDigest,
  type SubjectKind,
} from "@anybench/core";
import type { RepoContext } from "@anybench/kit";
import { z } from "zod";

export const UNDERSTANDER_ROLE = "understander";

/** The driver types Anybench v1 can build and prove a kit for. */
export const V1_SUPPORTED_DRIVERS: readonly DriverType[] = ["cli", "coding-agent", "harness"];

/** A repo whose history has fewer recent fix+test commits than this is not minable for tasks. */
export const MIN_MINABLE_TEST_COMMITS = 3;

export const InstallRouteSchema = z.enum([
  "github_release",
  "cargo",
  "npm",
  "pip",
  "go",
  "brew",
  "apt",
  "source",
]);
export type InstallRoute = z.infer<typeof InstallRouteSchema>;

/** `README.md#L34`: a repo path and a 1-based line. */
const CLAIM_SOURCE = /^(.+)#L([1-9]\d*)$/;

export const ClaimSchema = z.object({
  /** The claim in plain words. */
  text: z.string().min(1),
  /** Copied from the cited line. */
  quote: z.string().min(1),
  /** `<path>#L<line>`. */
  source: z.string().regex(CLAIM_SOURCE, "must be <path>#L<line>"),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const SubjectCommandSchema = z.object({
  binary: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/, "must be a binary name"),
  install_route: InstallRouteSchema,
  package: z.string().min(1).nullable().default(null),
  version_command: z.string().min(1).nullable().default(null),
});
export type SubjectCommand = z.infer<typeof SubjectCommandSchema>;

export const HistorySignalSchema = z.object({
  /** The model thinks so AND code counted at least MIN_MINABLE_TEST_COMMITS test commits. */
  minable: z.boolean(),
  /** Recent commits that touched test files (counted by ingest, not the model). */
  test_commits: z.int().min(0),
  commits_scanned: z.int().min(0),
  why: z.string(),
});
export type HistorySignal = z.infer<typeof HistorySignalSchema>;

/**
 * The fields TDM-56 adds to the orchestrator's Understanding. All optional, so a
 * stage output stored before TDM-56 (or the curated pass-through) still parses.
 */
export const UnderstandingExtrasShape = {
  /** How a benchmark drives the subject (after the code's corrections). */
  driver_type: DriverTypeSchema.optional(),
  /** True only for a driver Anybench v1 builds kits for. */
  supported: z.boolean().optional(),
  /**
   * Performance or quality claims the project makes, each verified against its line. Optional
   * (not defaulted) so every Understanding built before TDM-56 still type-checks; absent = none.
   */
  claims: z.array(ClaimSchema).optional(),
  /** CLIs: what to run and how to install it (a hint; TDM-60 pins it in code). */
  subject_command: SubjectCommandSchema.optional(),
  /** Agents and harnesses: does the history look minable for tasks (fix + test commits)? */
  history: HistorySignalSchema.optional(),
  /** http-agent: the labelled conversation set it ships (a path verified in the tree). */
  labelled_conversations: z.string().min(1).optional(),
};

/** The model's answer. Mirrors understander/output.schema.json (a test keeps them in step). */
export const UnderstanderOutputSchema = z.object({
  kind: SubjectKindSchema,
  driver_type: DriverTypeSchema,
  driver_reason: z.string().default(""),
  summary: z.string().min(1),
  better_means: z.array(z.string().min(1)).min(1),
  risks: z.array(z.string()).default([]),
  benchable: z.enum(["ready", "needs_hardware", "skip"]),
  reason: z.string().default(""),
  claims: z.array(z.unknown()).default([]),
  subject_command: z.unknown().nullable().default(null),
  history: z
    .object({ minable: z.boolean(), why: z.string().default("") })
    .nullable()
    .default(null),
  labelled_conversations: z.string().nullable().default(null),
});
export type UnderstanderOutput = z.infer<typeof UnderstanderOutputSchema>;

/** What the orchestrator stores (apps/server UnderstandingSchema, minus nothing). */
export interface UnderstandingResult {
  kind: SubjectKind;
  summary: string;
  better_means: string[];
  risks: string[];
  benchable: "ready" | "needs_hardware" | "skip";
  reason: string;
  driver_type: DriverType;
  supported: boolean;
  claims: Claim[];
  subject_command?: SubjectCommand;
  history?: HistorySignal;
  labelled_conversations?: string;
}

export interface UnderstandVerdict {
  /** ready → the run advances; hold → needs_human; fail → the run fails. */
  outcome: "ready" | "hold" | "fail";
  /** The hold / fail reason (also `understanding.reason`). */
  reason: string;
  understanding: UnderstandingResult;
  /** What code changed in the model's answer, for the run's event stream. */
  corrections: string[];
}

export interface UnderstanderIngest {
  digest: ProjectDigest;
  /** The repo context ingest gathered; null when it is not available (the digest alone). */
  context: RepoContext | null;
}

// ---------- input ----------

export const UNDERSTANDER_INPUT_CAPS = {
  readmeChars: 16_000,
  treePaths: 200,
  treeDirs: 40,
  manifests: 8,
  manifestChars: 2_500,
  testCommitSubjects: 10,
  tags: 10,
  largeFiles: 20,
} as const;

function cut(text: string, max: number): { text: string; truncated: boolean } {
  return text.length <= max
    ? { text, truncated: false }
    : { text: text.slice(0, max), truncated: true };
}

/** The README as `<n>| <line>` lines, cut at whole lines under the cap. */
export function numberedReadme(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  const out: string[] = [];
  let size = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = `${i + 1}| ${lines[i]}`;
    if (size + line.length + 1 > maxChars) return { text: out.join("\n"), truncated: true };
    out.push(line);
    size += line.length + 1;
  }
  return { text: out.join("\n"), truncated: false };
}

/** The task message for one understander session (JSON-serializable, bounded size). */
export function buildUnderstanderInput(ingest: UnderstanderIngest): Record<string, unknown> {
  const { digest, context } = ingest;
  const caps = UNDERSTANDER_INPUT_CAPS;
  const { ingested_at: _at, hash: _hash, ...rest } = digest;
  const input: Record<string, unknown> = {
    digest: {
      ...rest,
      releases: {
        ...(digest.releases.latest ? { latest: digest.releases.latest } : {}),
        tags: digest.releases.tags.slice(0, caps.tags),
        tag_count: digest.releases.tags.length,
      },
    },
  };
  if (!context) {
    input.note = "no repo context was available: judge from the digest alone";
    return input;
  }
  if (context.readme) {
    const r = numberedReadme(context.readme.text, caps.readmeChars);
    input.readme = {
      path: context.readme.path,
      truncated: context.readme.truncated || r.truncated,
      lines: r.text,
    };
  } else {
    input.readme = null;
  }
  input.tree = {
    file_count: digest.files.count,
    total_bytes: digest.files.total_bytes,
    dirs: context.tree.dirs
      .slice(0, caps.treeDirs)
      .map((d) => `${d.path} (${d.files} files, ${d.bytes} bytes)`),
    paths: context.tree.paths.slice(0, caps.treePaths),
    paths_truncated: context.tree.truncated || context.tree.paths.length > caps.treePaths,
  };
  input.manifests = context.manifests.slice(0, caps.manifests).map((m) => {
    const c = cut(m.text, caps.manifestChars);
    return { path: m.path, kind: m.kind, text: c.text, truncated: m.truncated || c.truncated };
  });
  input.tests = context.tests;
  input.benchmarks = context.benchmarks;
  input.history = {
    commits_scanned: context.commits_scanned,
    test_commits: context.recent_test_commits.length,
    recent_test_commit_subjects: context.recent_test_commits
      .slice(0, caps.testCommitSubjects)
      .map((c) => c.subject),
  };
  if (context.large_files.length > 0)
    input.large_files = context.large_files.slice(0, caps.largeFiles);
  return input;
}

// ---------- verdict rules (code, not prompt) ----------

const AGENT_DRIVERS = new Set<DriverType>(["coding-agent", "http-agent", "harness"]);

/** Languages that are not something to run. */
const DOC_LANGUAGES = new Set([
  "Markdown",
  "Text",
  "HTML",
  "CSS",
  "SCSS",
  "TeX",
  "reStructuredText",
]);

/** Paths that mean "this ships an executable". */
const EXECUTABLE_PATH =
  /(^|\/)(src\/main\.rs|src\/bin\/[^/]+\.rs|main\.go|cmd\/[^/]+\/main\.go|__main__\.py|bin\/[^/]+|cli\.(py|ts|js|mjs|go|rs))$/;
/** Manifest text that declares an executable. */
const EXECUTABLE_MANIFEST =
  /"bin"\s*:|\[project\.scripts\]|\[tool\.poetry\.scripts\]|console_scripts|\[\[bin\]\]|entry_points\s*=/;

/** Does anything in the ingest show the repo ships an executable (not only importable code)? */
export function hasExecutableEvidence(ingest: UnderstanderIngest): boolean {
  const { digest, context } = ingest;
  if (digest.entrypoints.some((e) => e.kind === "bin" || e.kind === "script")) return true;
  if (!context) return false;
  if (context.tree.paths.some((p) => EXECUTABLE_PATH.test(p))) return true;
  return context.manifests.some((m) => EXECUTABLE_MANIFEST.test(m.text));
}

/** No entrypoint, manifest, build or test command, and only document languages. */
export function nothingRunnable(ingest: UnderstanderIngest): boolean {
  const { digest, context } = ingest;
  if (digest.entrypoints.length > 0) return false;
  if (digest.build_commands.length > 0 || digest.test_commands.length > 0) return false;
  if (context && context.manifests.length > 0) return false;
  return digest.languages.every((l) => DOC_LANGUAGES.has(l.name));
}

const DRIVER_KIND: Partial<Record<DriverType, SubjectKind>> = {
  "coding-agent": "agent",
  "http-agent": "agent",
  harness: "harness",
};

function oneLine(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Keep only claims whose quote is on the cited line (or the next two, for wrapped text) of the
 * README (or a manifest) we gave the model. Line numbers are 1-based, as in the numbered README.
 */
export function verifyClaims(
  raw: readonly unknown[],
  context: RepoContext | null,
): { claims: Claim[]; dropped: number } {
  const files = new Map<string, string[]>();
  if (context?.readme) files.set(context.readme.path, context.readme.text.split("\n"));
  for (const m of context?.manifests ?? []) files.set(m.path, m.text.split("\n"));
  const claims: Claim[] = [];
  let dropped = 0;
  const seen = new Set<string>();
  for (const item of raw) {
    const c = ClaimSchema.safeParse(item);
    if (!c.success) {
      dropped++;
      continue;
    }
    const [, file, lineText] = CLAIM_SOURCE.exec(c.data.source) ?? [];
    const lines = file ? files.get(file) : undefined;
    const line = Number(lineText);
    const window = lines ? norm(lines.slice(line - 1, line + 2).join(" ")) : "";
    const quote = norm(c.data.quote.replace(/^\d+\|\s?/, ""));
    if (
      !lines ||
      quote.length === 0 ||
      !window.includes(quote) ||
      seen.has(c.data.source + quote)
    ) {
      dropped++;
      continue;
    }
    seen.add(c.data.source + quote);
    claims.push({
      text: oneLine(c.data.text, 300),
      quote: oneLine(c.data.quote, 300),
      source: c.data.source,
    });
    if (claims.length >= 20) break;
  }
  return { claims, dropped };
}

function pathInTree(p: string, context: RepoContext | null): boolean {
  if (!context) return false;
  const clean = p.replace(/^\.?\//, "").replace(/\/$/, "");
  if (clean === "") return false;
  return (
    context.tree.paths.some((x) => x === clean || x.startsWith(`${clean}/`)) ||
    context.tree.dirs.some((d) => d.path === clean)
  );
}

/** Why each unsupported driver is not built yet (the hold reason when the model gave none). */
const UNSUPPORTED_WHY: Partial<Record<DriverType, string>> = {
  service: "a long-running server needs a load generator and a golden request set",
  lib: "a library needs a generated bench shim and property tests against a reference",
  pty: "a terminal needs the PTY shim and a reference-grid gate",
  x11: "a desktop GUI needs a display and an accessibility-tree gate",
  web: "a web app needs a browser driver and DOM assertions",
  "http-agent": "an API agent needs a labelled conversation set, and the repo ships none",
};

/** The verdict, from the model's answer and what ingest found. Pure: no I/O. */
export function decideUnderstanding(
  output: UnderstanderOutput,
  ingest: UnderstanderIngest,
): UnderstandVerdict {
  const corrections: string[] = [];
  const { context } = ingest;
  let driver = output.driver_type;
  let driverWhy = oneLine(output.driver_reason);

  // Libraries are the most common miss: a "cli" that ships no executable is a library.
  if (driver === "cli" && !hasExecutableEvidence(ingest)) {
    driver = "lib";
    driverWhy =
      "no executable entrypoint (bin, console script, main) in the repo, so it is a library";
    corrections.push(`driver cli → lib: ${driverWhy}`);
  }

  let kind = output.kind;
  const driverKind = DRIVER_KIND[driver];
  if (driverKind && kind !== driverKind) {
    corrections.push(`kind ${kind} → ${driverKind} (driver ${driver})`);
    kind = driverKind;
  }

  let labelled: string | undefined;
  // Models sometimes spell null as a string ("null", "none", "").
  const claimedSet = output.labelled_conversations?.trim() ?? "";
  if (claimedSet !== "" && !/^(null|none|n\/a)$/i.test(claimedSet)) {
    if (driver === "http-agent" && pathInTree(claimedSet, context)) {
      labelled = claimedSet.replace(/^\.?\//, "");
    } else {
      corrections.push(
        `dropped labelled_conversations "${oneLine(claimedSet, 120)}" (not in the tree)`,
      );
    }
  }

  const supported =
    V1_SUPPORTED_DRIVERS.includes(driver) || (driver === "http-agent" && labelled !== undefined);

  let subject: SubjectCommand | undefined;
  if (driver === "cli" && output.subject_command) {
    const s = SubjectCommandSchema.safeParse(output.subject_command);
    if (s.success) subject = s.data;
    else corrections.push("dropped subject_command (not a binary name and install route)");
  }

  let history: HistorySignal | undefined;
  if (AGENT_DRIVERS.has(driver)) {
    const testCommits = context?.recent_test_commits.length ?? 0;
    const modelSays = output.history?.minable ?? false;
    history = {
      minable: modelSays && testCommits >= MIN_MINABLE_TEST_COMMITS,
      test_commits: testCommits,
      commits_scanned: context?.commits_scanned ?? 0,
      why: oneLine(
        modelSays && testCommits < MIN_MINABLE_TEST_COMMITS
          ? `only ${testCommits} recent commits touched tests (need ${MIN_MINABLE_TEST_COMMITS})`
          : (output.history?.why ?? ""),
      ),
    };
  }

  const { claims, dropped } = verifyClaims(output.claims, context);
  if (dropped > 0)
    corrections.push(`dropped ${dropped} claim(s) whose quote is not on the cited line`);

  let benchable = output.benchable;
  let modelReason = oneLine(output.reason || output.summary);
  if (benchable !== "skip" && nothingRunnable(ingest)) {
    corrections.push(`benchable ${benchable} → skip: nothing runnable`);
    benchable = "skip";
    modelReason =
      "nothing runnable: no entrypoint, manifest, build or test command, only documents";
  }

  let outcome: UnderstandVerdict["outcome"];
  let reason: string;
  if (benchable === "skip") {
    outcome = "fail";
    reason = `not benchable: ${modelReason}`;
  } else if (benchable === "needs_hardware") {
    outcome = "hold";
    reason = `needs hardware: ${modelReason}`;
  } else if (!supported) {
    outcome = "hold";
    const why = driverWhy || UNSUPPORTED_WHY[driver] || "not built in v1";
    reason = `driver ${driver} is not supported yet: ${why}`;
  } else {
    outcome = "ready";
    reason = modelReason;
  }

  const understanding: UnderstandingResult = {
    kind,
    summary: output.summary.trim(),
    better_means: output.better_means.map((b) => b.trim()).filter((b) => b.length > 0),
    risks: output.risks.map((r) => r.trim()).filter((r) => r.length > 0),
    benchable,
    reason,
    driver_type: driver,
    supported,
    claims,
    ...(subject ? { subject_command: subject } : {}),
    ...(history ? { history } : {}),
    ...(labelled ? { labelled_conversations: labelled } : {}),
  };
  if (understanding.better_means.length === 0)
    understanding.better_means = ["to be decided by the kit designer"];
  return { outcome, reason, understanding, corrections };
}
