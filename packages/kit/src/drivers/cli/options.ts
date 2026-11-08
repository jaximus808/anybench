// TDM-36 [4.4]: options for the `driver.type: cli` templates (plan.md P2 driver table).
//
// A cli contender is one shell command run in EVAL_IN. The driver template wraps it with the
// two cli collectors (GNU `time -v` around the gated run, `hyperfine --export-json` for the
// timed runs); the gate template diffs the gated run's stdout and output files against the
// kit's `reference/`. Every option is validated here, so the rendered scripts only ever embed
// strings that passed these schemas.
import { KitPathSchema, KitSlugSchema } from "@anybench/core";
import { z } from "zod";

/** Collectors the cli driver can wrap the subject with (`machine` comes from the runner). */
export const CliCollectorSchema = z.enum(["time", "hyperfine"]);
export type CliCollector = z.infer<typeof CliCollectorSchema>;

/** A file the subject writes under `$CLI_FILES_OUT`: a plain relative path, no globs. */
export const CliOutputFileSchema = KitPathSchema.pipe(
  z.string().regex(/^[A-Za-z0-9._/-]+$/, {
    error: "output files are plain relative paths: letters, digits, '.', '_', '-', '/'",
  }),
);

const ExitCodesSchema = z
  .array(z.int().min(0).max(255))
  .min(1)
  .refine((codes) => new Set(codes).size === codes.length, { error: "exit codes must be unique" });

export const CliHyperfineOptionsSchema = z.strictObject({
  /** Timed runs per trial. */
  runs: z.int().min(2).max(1000).default(10),
  /** Untimed runs before them (page cache, lazy init). */
  warmup: z.int().min(0).max(100).default(1),
});
export type CliHyperfineOptions = z.output<typeof CliHyperfineOptionsSchema>;

export const CliDriverTemplateSchema = z.strictObject({
  /** The contender id, recorded in the script header and as hyperfine's command name. */
  contender_id: KitSlugSchema,
  /**
   * The subject, as bash. It runs with cwd = EVAL_IN and must write any output files under
   * `$CLI_FILES_OUT`. Its stdout is what the gate diffs. Workload params are files in EVAL_IN.
   */
  command: z
    .string()
    .min(1)
    .refine((c) => !c.includes("\0"), { error: "command may not contain NUL" })
    .refine((c) => !/^\s*$/.test(c), { error: "command is empty" }),
  /** Exit codes that count as "the subject ran" (grep exits 1 on no match). Default [0]. */
  exit_codes: ExitCodesSchema.default([0]),
  /** Default: both cli collectors (core DRIVER_DEFAULT_COLLECTORS.cli minus `machine`). */
  collectors: z
    .array(CliCollectorSchema)
    .refine((c) => new Set(c).size === c.length, { error: "collectors must be unique" })
    .default(["time", "hyperfine"]),
  hyperfine: CliHyperfineOptionsSchema.default({ runs: 10, warmup: 1 }),
});
export type CliDriverTemplate = z.output<typeof CliDriverTemplateSchema>;
export type CliDriverTemplateInput = z.input<typeof CliDriverTemplateSchema>;

/** Do-less variant for a cli: the subject's stdout is cut to its first `keep_lines` lines. */
export const CliDoLessTruncateSchema = z.strictObject({
  kind: z.literal("truncate-stdout").default("truncate-stdout"),
  keep_lines: z.int().min(0).max(1_000_000).default(1),
});
export type CliDoLessTruncate = z.output<typeof CliDoLessTruncateSchema>;
export type CliDoLessTruncateInput = z.input<typeof CliDoLessTruncateSchema>;

export const CliGateTemplateSchema = z.strictObject({
  gate_id: KitSlugSchema,
  /**
   * Kit-relative reference dir. Per workload it holds `<workload>/stdout.txt` and, for each
   * declared output file, `<workload>/files/<path>`. Default `reference/<gate_id>`.
   */
  reference: KitPathSchema.optional(),
  /** Compare the gated run's stdout. Default true. */
  stdout: z.boolean().default(true),
  /** Sort stdout lines (LC_ALL=C) on both sides before comparing: for tools whose order is free. */
  sort_lines: z.boolean().default(false),
  /** Output files compared byte for byte against `<workload>/files/<path>`. */
  files: z.array(CliOutputFileSchema).default([]),
  /** Exit codes the gated run may end with. Default [0]. */
  exit_codes: ExitCodesSchema.default([0]),
});
export type CliGateTemplate = z.output<typeof CliGateTemplateSchema>;
export type CliGateTemplateInput = z.input<typeof CliGateTemplateSchema>;
