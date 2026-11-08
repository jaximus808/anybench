// TDM-60 [6.6]: the kit designer's STRUCTURED draft for a `driver.type: cli` kit.
//
// The Naïve kit designer never writes driver, gate or install scripts by hand. It answers with
// this draft: which contenders run (the subject and one or two obvious baselines), the one shell
// command each runs (a CliDriverTemplate command), small deterministic workloads, the gate
// options (CliGateTemplate), the partial do-less flag, weights and repeats. Our code then pins
// every release (asset URL + sha256, resolved by code: pins.ts), renders every script with the
// TDM-36 renderers and writes the kit (materialize-cli.ts). Everything here is validated before
// any file is written, so a rendered script only ever embeds strings that passed these schemas.
import { KitPathSchema, KitSlugSchema } from "@anybench/core";
import { z } from "zod";

/** GNU tools the base image (Ubuntu 24.04) ships, pinned by the version apt installs there. */
export const GNU_BASELINES = {
  grep: {
    apt_package: "grep",
    binary: "grep",
    version: "3.11",
    url: "https://ftp.gnu.org/gnu/grep/grep-3.11.tar.xz",
  },
  findutils: {
    apt_package: "findutils",
    binary: "find",
    version: "4.9.0",
    url: "https://ftp.gnu.org/gnu/findutils/findutils-4.9.0.tar.xz",
  },
  sed: {
    apt_package: "sed",
    binary: "sed",
    version: "4.9",
    url: "https://ftp.gnu.org/gnu/sed/sed-4.9.tar.xz",
  },
  gawk: {
    apt_package: "gawk",
    binary: "gawk",
    version: "5.2.1",
    url: "https://ftp.gnu.org/gnu/gawk/gawk-5.2.1.tar.xz",
  },
  coreutils: {
    apt_package: "coreutils",
    binary: "sort",
    version: "9.4",
    url: "https://ftp.gnu.org/gnu/coreutils/coreutils-9.4.tar.xz",
  },
  diffutils: {
    apt_package: "diffutils",
    binary: "diff",
    version: "3.10",
    url: "https://ftp.gnu.org/gnu/diffutils/diffutils-3.10.tar.xz",
  },
  gzip: {
    apt_package: "gzip",
    binary: "gzip",
    version: "1.12",
    url: "https://ftp.gnu.org/gnu/gzip/gzip-1.12.tar.xz",
  },
} as const;
export type GnuPackage = keyof typeof GNU_BASELINES;
export const GNU_PACKAGES = Object.keys(GNU_BASELINES) as [GnuPackage, ...GnuPackage[]];

/** The one placeholder a subject command carries: where the proof overlays' extra args go. */
export const EXTRA_ARGS_PLACEHOLDER = "{extra_args}";

/** Limits that keep a generated kit small enough to stage file by file on a computer. */
export const CLI_DRAFT_LIMITS = {
  contenders: 4,
  workloads: 6,
  filesPerWorkload: 40,
  fileChars: 64 * 1024,
  generatedLines: 200_000,
  replicate: 50,
  /** After replication and generation, per workload. */
  workloadFiles: 400,
  workloadBytes: 16 * 1024 * 1024,
  /**
   * One generated file. Naïve's sandbox fs moves at most 4 MiB per read/write (live run
   * 01a1ba28…: a 9.9 MB file failed env build), so keep each file well under it.
   */
  fileBytes: 3 * 1024 * 1024,
  commandChars: 2_000,
} as const;

export const BinaryNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/, { error: "must be an executable name" });

export const GithubRepoSchema = z
  .string()
  .regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, { error: "must be 'owner/repo'" });

export const CliDraftInstallSchema = z.discriminatedUnion("route", [
  z.strictObject({
    route: z.literal("github_release"),
    repo: GithubRepoSchema,
    /** A release tag; null = the latest release (code resolves and pins it). */
    tag: z.string().min(1).max(128).nullable().default(null),
  }),
  z.strictObject({
    route: z.literal("gnu"),
    package: z.enum(GNU_PACKAGES),
  }),
]);
export type CliDraftInstall = z.output<typeof CliDraftInstallSchema>;

/** `rg --version`, `find --version`: the binary and plain flags only. */
const VersionCommandSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*( -{1,2}[A-Za-z][A-Za-z0-9-]*| [A-Za-z]+)*$/, {
    error: "must be the binary followed by plain flags, e.g. 'rg --version'",
  });

/** Words a do-less flag may contain: flags and small literals, no quoting, no expansion. */
const PlainWordsSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9 _.,=:@%/+-]+$/, {
    error: "must be plain words (flags and literals): no quotes, '$', ';', '|', '&' or globs",
  });

/** Things a contender command may never do (network, privilege, our secrets, the scoring files). */
export const FORBIDDEN_COMMAND = [
  { re: /\b(curl|wget|nc|ncat|ssh|scp|rsync|telnet|ftp)\b/, why: "network tools" },
  { re: /\/dev\/(tcp|udp)\//, why: "network sockets" },
  { re: /\bsudo\b|\bsu\s/, why: "privilege changes" },
  { re: /EVAL_SECRETS|\.anybench\/env/, why: "our secrets file" },
  { re: /(^|[\s"'=])(\.\.\/)*(reference|gates|proof)\//, why: "scoring-only kit files" },
  { re: /\brm\s+-[a-z]*r[a-z]*f?\s+\/(\s|$)/, why: "deleting the filesystem" },
] as const;

export const CliDraftContenderSchema = z.strictObject({
  id: KitSlugSchema,
  role: z.enum(["subject", "baseline"]),
  /** Display name, e.g. "ripgrep", "GNU grep". */
  name: z.string().min(1).max(80),
  /** The executable the command runs (on PATH after install), e.g. `rg`. */
  binary: BinaryNameSchema,
  install: CliDraftInstallSchema,
  version_command: VersionCommandSchema,
  /**
   * Bash run with cwd = EVAL_IN (the workload's input files). Its stdout is what the gate
   * compares. Per-workload parameters are read from input files (e.g. `"$(cat pattern.txt)"`).
   * The subject's command contains `{extra_args}` exactly once, where the proof overlays' flags go.
   */
  command: z.string().min(1).max(CLI_DRAFT_LIMITS.commandChars),
  exit_codes: z.array(z.int().min(0).max(255)).min(1).max(8).default([0]),
  /** Why this contender (baselines: why it is the obvious comparison). */
  why: z.string().min(1).max(600),
});
export type CliDraftContender = z.output<typeof CliDraftContenderSchema>;

/** Deterministic text made by code (seeded), for inputs bigger than a model can write. */
export const GeneratedTextSchema = z.strictObject({
  lines: z.int().min(1).max(CLI_DRAFT_LIMITS.generatedLines),
  seed: z.int().min(0).max(0xffff_ffff),
  words_per_line: z.int().min(1).max(40).default(10),
  /** Lines inserted verbatim every `every` lines (needles for a search tool). */
  inject: z
    .array(z.strictObject({ text: z.string().min(1).max(500), every: z.int().min(1) }))
    .max(10)
    .default([]),
});

export const CliDraftFileSchema = z.union([
  z.strictObject({
    path: KitPathSchema,
    content: z.string().max(CLI_DRAFT_LIMITS.fileChars),
  }),
  z.strictObject({ path: KitPathSchema, generate: GeneratedTextSchema }),
]);
export type CliDraftFile = z.output<typeof CliDraftFileSchema>;

export const CliDraftWorkloadSchema = z.strictObject({
  id: KitSlugSchema,
  title: z.string().min(1).max(120),
  /** Files under workloads/<id>/input/ (the command's cwd). No answers: those are captured. */
  files: z.array(CliDraftFileSchema).min(1).max(CLI_DRAFT_LIMITS.filesPerWorkload),
  /**
   * Copy every file that lives in a directory `replicate` times inside that top directory
   * (`tree/a.c` → `tree/copy-001/a.c` … `tree/copy-NNN/a.c`), to scale a tree up for tools whose
   * cost grows with file count. Files at the input root are parameters (pattern.txt) and stay
   * single. 1 = as written.
   */
  replicate: z.int().min(1).max(CLI_DRAFT_LIMITS.replicate).default(1),
  /** Free-form knobs recorded on the workload (the command reads files, not these). */
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});
export type CliDraftWorkload = z.output<typeof CliDraftWorkloadSchema>;

export const CliDraftGateSchema = z.strictObject({
  id: KitSlugSchema.default("same-output"),
  description: z.string().min(1).max(600),
  /** Sort stdout lines on both sides: for tools whose output order is free (parallel walkers). */
  sort_lines: z.boolean(),
  /** Exit codes the gated run may end with (grep-likes exit 1 on no match). */
  exit_codes: z.array(z.int().min(0).max(255)).min(1).max(8).default([0]),
});

export const CliDraftPartialSchema = z.strictObject({
  id: KitSlugSchema,
  description: z.string().min(1).max(400),
  /** Flags added to the subject's command that drop part of the result, e.g. `--max-count 1`. */
  args: PlainWordsSchema,
});

export const CliKitDraftSchema = z
  .strictObject({
    driver: z.literal("cli"),
    subject: z.strictObject({
      name: z.string().min(1).max(80),
      summary: z.string().min(1).max(600),
      better_means: z.array(z.string().min(1).max(200)).min(1).max(4),
    }),
    contenders: z.array(CliDraftContenderSchema).min(2).max(CLI_DRAFT_LIMITS.contenders),
    workloads: z.array(CliDraftWorkloadSchema).min(2).max(CLI_DRAFT_LIMITS.workloads),
    gate: CliDraftGateSchema,
    /** The partial do-less variant (the code adds the truncate-stdout cheat itself). */
    do_less_partial: CliDraftPartialSchema,
    /** Integer weights of the two gated CLI requirements (plan 17.4: wall, peak RSS); sum 100. */
    weights: z.strictObject({ wall: z.int().min(0).max(100), rss: z.int().min(0).max(100) }),
    primary: z.enum(["wall", "rss"]).default("wall"),
    /** Measured repeats per contender × workload (17.2 rule 3: software default 5). */
    repeats: z.int().min(5).max(20).default(5),
    /** hyperfine timed runs per trial (17.2 rule 3: at least 10). */
    hyperfine_runs: z.int().min(10).max(100).default(10),
    notes: z.string().max(2_000).default(""),
  })
  .superRefine((d, ctx) => {
    const issue = (path: PropertyKey[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    const subjects = d.contenders.filter((c) => c.role === "subject");
    if (subjects.length !== 1)
      issue(["contenders"], `exactly one contender must be the subject (got ${subjects.length})`);
    if (!d.contenders.some((c) => c.role === "baseline"))
      issue(["contenders"], "at least one baseline is needed to cross-check the reference");
    const ids = new Set<string>();
    d.contenders.forEach((c, i) => {
      if (ids.has(c.id)) issue(["contenders", i, "id"], `duplicate contender id '${c.id}'`);
      ids.add(c.id);
      const count = c.command.split(EXTRA_ARGS_PLACEHOLDER).length - 1;
      if (c.role === "subject" && count !== 1)
        issue(
          ["contenders", i, "command"],
          `the subject's command must contain ${EXTRA_ARGS_PLACEHOLDER} exactly once (got ${count})`,
        );
      if (c.role === "baseline" && count !== 0)
        issue(
          ["contenders", i, "command"],
          `only the subject's command takes ${EXTRA_ARGS_PLACEHOLDER}`,
        );
      if (c.role === "subject" && c.install.route !== "github_release")
        issue(
          ["contenders", i, "install"],
          "the subject installs from its pinned GitHub release (route github_release)",
        );
      if (!c.version_command.startsWith(`${c.binary} `) && c.version_command !== c.binary)
        issue(["contenders", i, "version_command"], `must run '${c.binary}'`);
      if (c.command.includes("\0")) issue(["contenders", i, "command"], "NUL in command");
      for (const f of FORBIDDEN_COMMAND) {
        if (f.re.test(c.command))
          issue(["contenders", i, "command"], `command may not use ${f.why}`);
      }
    });
    const wids = new Set<string>();
    d.workloads.forEach((w, i) => {
      if (wids.has(w.id)) issue(["workloads", i, "id"], `duplicate workload id '${w.id}'`);
      wids.add(w.id);
      const paths = new Set<string>();
      w.files.forEach((f, j) => {
        if (paths.has(f.path)) issue(["workloads", i, "files", j, "path"], "duplicate path");
        paths.add(f.path);
        if (!/^[A-Za-z0-9._/ -]+$/.test(f.path) || f.path.endsWith("/"))
          issue(["workloads", i, "files", j, "path"], "plain relative file paths only");
      });
    });
    if (d.weights.wall + d.weights.rss !== 100)
      issue(["weights"], `weights must sum to 100 (got ${d.weights.wall + d.weights.rss})`);
    if (d.weights[d.primary] === 0) issue(["primary"], "the primary requirement needs weight > 0");
  });
export type CliKitDraft = z.output<typeof CliKitDraftSchema>;
export type CliKitDraftInput = z.input<typeof CliKitDraftSchema>;

function stripForProvider(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripForProvider);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === "$schema" || k === "pattern") continue;
      out[k] = stripForProvider(x);
    }
    return out;
  }
  return v;
}

/**
 * The JSON Schema Naïve is told to match (input shape: defaults are optional). Regex `pattern`s
 * and `$schema` are dropped (not every model provider accepts them); the zod schema still
 * checks every field when the answer comes back.
 */
export function cliKitDraftJsonSchema(): Record<string, unknown> {
  return stripForProvider(
    z.toJSONSchema(CliKitDraftSchema, { io: "input", unrepresentable: "any" }),
  ) as Record<string, unknown>;
}
