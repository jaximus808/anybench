// TrialJob: what the worker writes to ~/.anybench/trial.json before it launches the runner.
//
// Defined here, not in @anybench/core, because the runner must not depend on the server, the DB
// or the kit loader: the worker flattens the kit (KitSpec driver verbs, wall-clock cap, collect
// globs, transfer cap) into this one self-contained document.
//
// Secrets never go in here, except the per-trial ingest token, which the runner redacts from
// everything it writes. Model keys and other secrets go in ~/.anybench/env.

import { readFile } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { NonNegativeMicroUsdSchema } from "@anybench/core";
import { uploadPlanSchema } from "@anybench/envs";
import { z } from "zod";

export const TRIAL_JOB_VERSION = 1;

/** One path segment id (same alphabet as artifact keys, so ids are safe in paths and URLs). */
const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, "id must be 1-128 chars of [A-Za-z0-9._-]");

const shellCommand = z.string().min(1);

/** A `collect` glob, relative to EVAL_WS: no absolute paths, no `..` segments. */
const collectGlob = z
  .string()
  .min(1)
  .refine((g) => !isAbsolute(g) && !normalize(g).split(/[\\/]/).includes(".."), {
    message: "collect globs are relative to EVAL_WS and may not contain ..",
  });

export const DriverVerbsSchema = z.object({
  /** driver.type from the kit (cli, service, lib, pty, ...); recorded, not interpreted. */
  type: z.string().min(1),
  /**
   * Shell commands for the L2 verbs. `run` gets `$1 = EVAL_IN` and `$2 = EVAL_OUT` (the warm-up
   * out dir during warm-ups). All verbs get EVAL_IN, EVAL_WS, EVAL_OUT, EVAL_SECRETS, EVAL_PHASE.
   */
  start: shellCommand.optional(),
  /** Polled until it exits 0 (or `ready_timeout_s` passes). */
  ready: shellCommand.optional(),
  run: shellCommand,
  stop: shellCommand.optional(),
  /** Working directory for every verb; relative paths are resolved against HOME. Default EVAL_WS. */
  cwd: z.string().min(1).optional(),
  /** Shell used to run the verbs. Default bash when present, else /bin/sh. */
  shell: z.string().min(1).optional(),
});
export type DriverVerbs = z.infer<typeof DriverVerbsSchema>;

export const IngestConfigSchema = z.object({
  /** Base URL of the runner ingest API; events go to `<url>/v1/trials/<trial_id>/events`. */
  url: z.url(),
  /** Per-trial bearer token. Redacted from every line the runner writes. */
  token: z.string().min(16),
  /** Max events per POST. */
  batch_max: z.int().min(1).max(1000).default(100),
  /** How often pending events are flushed. */
  flush_ms: z.int().min(50).max(60_000).default(1000),
  /** Per-request timeout. */
  timeout_ms: z.int().min(100).max(120_000).default(10_000),
  /** Consecutive failed POSTs before the runner gives up pushing and goes file-only. */
  max_failures: z.int().min(1).max(100).default(5),
});
export type IngestConfig = z.infer<typeof IngestConfigSchema>;

export const UploadConfigSchema = z.object({
  /** Upload the frozen bundle at all. */
  enabled: z.boolean().default(true),
  /** Artifact name of the bundle, under `runs/<run>/trials/<trial>/`. */
  bundle_name: z.string().min(1).default("out.tar.gz"),
  /** Size cap (kit `transfer.max_mb`, converted). */
  max_bytes: z
    .int()
    .positive()
    .default(512 * 1024 * 1024),
  /**
   * Pre-made plans by artifact name. Normally empty: a plan needs the file's sha256, which is only
   * known after `freeze`, so the runner asks the ingest API for one (`POST .../uploads`).
   */
  plans: z.record(z.string(), uploadPlanSchema).default({}),
});
export type UploadConfig = z.infer<typeof UploadConfigSchema>;

/**
 * Live log chunks (TDM-160). Absent = off: the logs are only in the frozen bundle. When on, each
 * stream's redacted output is cut into segments (every `segment_bytes`, or `segment_ms` after the
 * segment's first byte), each segment is uploaded through the ingest upload flow and announced
 * with a `trial.log_chunk` event. Needs `ingest`.
 */
export const LogChunksConfigSchema = z.object({
  segment_bytes: z
    .int()
    .min(1024)
    .max(64 * 1024 * 1024)
    .default(256 * 1024),
  segment_ms: z.int().min(50).max(600_000).default(5000),
  streams: z
    .array(z.enum(["stdout", "stderr"]))
    .min(1)
    .default(["stdout", "stderr"]),
  /** Upload tries per segment before live chunks are turned off for that stream. */
  upload_tries: z.int().min(1).max(10).default(3),
});
export type LogChunksConfig = z.infer<typeof LogChunksConfigSchema>;

/** Integer micro-USD per million tokens, as a decimal string (or bigint). */
const perMtok = NonNegativeMicroUsdSchema;

/**
 * Token prices for the BYOK token cap, micro-USD per million tokens. The worker should pass the
 * prices of the contender's model; the default is Claude Sonnet list pricing ($3 in, $15 out,
 * $0.30 cache read, $3.75 cache write).
 */
export const TokenPricesSchema = z.object({
  input: perMtok,
  output: perMtok,
  cache_read: perMtok,
  cache_creation: perMtok,
});
export type TokenPrices = z.infer<typeof TokenPricesSchema>;

export const DEFAULT_TOKEN_PRICES: TokenPrices = {
  input: 3_000_000n,
  output: 15_000_000n,
  cache_read: 300_000n,
  cache_creation: 3_750_000n,
};

/**
 * Network probe before `run` (TDM-160). Absent = no probe. `allow` is the kit's declared
 * `EnvSpec.network.allow`; the canary is a host the allow-list does not cover.
 */
export const NetworkProbeConfigSchema = z.object({
  allow: z.array(z.string().min(1)).default([]),
  canary_url: z.url({ protocol: /^https?$/ }).default("https://example.com"),
  timeout_ms: z.int().min(100).max(60_000).default(5000),
});
export type NetworkProbeConfig = z.infer<typeof NetworkProbeConfigSchema>;

export const TrialJobSchema = z.object({
  version: z.literal(TRIAL_JOB_VERSION),
  trial_id: idSchema,
  run_id: idSchema,
  /** 1-based `trials.attempt`; event batches are idempotent per (trial, attempt, batch_seq). */
  attempt: z.int().positive(),
  contender_id: z.string().min(1).optional(),
  workload_id: z.string().min(1).optional(),
  driver: DriverVerbsSchema,
  /** Extra health check run after `start` (exit 0 = healthy), e.g. the adapter's healthcheck.sh. */
  healthcheck: shellCommand.optional(),
  ready_timeout_s: z.int().min(1).max(3600).default(60),
  /** Warm-up runs before the measured run; their outputs are discarded. */
  warmup_runs: z.int().min(0).max(100).default(0),
  /** Wall-clock cap for each `run` (warm-ups included). Exceeding it fails the trial as the subject's fault. */
  wall_clock_s: z
    .int()
    .min(1)
    .max(7 * 24 * 3600),
  /** Cap for start / ready / stop / healthcheck. */
  verb_timeout_s: z
    .int()
    .min(1)
    .max(24 * 3600)
    .default(300),
  /** Globs relative to EVAL_WS, copied into EVAL_OUT/artifacts after the run. */
  collect: z.array(collectGlob).default([]),
  upload: UploadConfigSchema.default({
    enabled: true,
    bundle_name: "out.tar.gz",
    max_bytes: 512 * 1024 * 1024,
    plans: {},
  }),
  /** null = file-only from the start (egress blocked; the worker polls status.json / events.jsonl). */
  ingest: IngestConfigSchema.nullable().default(null),
  heartbeat_s: z.int().min(1).max(300).default(15),
  /** Recorded as `lease_owner` in heartbeats. Default `runner:<hostname>`. */
  lease_owner: z.string().min(1).optional(),
  /** Live log chunks; absent = off. */
  log_chunks: LogChunksConfigSchema.optional(),
  /**
   * BYOK token cap, integer micro-USD as a decimal string. The runner reads the Claude Code
   * stream-json on the warm-up and `run` stdout and stops the trial with a `budget` failure when
   * the spend crosses it. Absent = no cap.
   */
  token_cap_micro_usd: NonNegativeMicroUsdSchema.optional(),
  /** Prices used to estimate spend from token usage before Claude Code reports its own cost. */
  token_prices: TokenPricesSchema.optional(),
  /**
   * Safety margin of the token cap, integer percent (TDM-231): the cap trips when the spend plus
   * this share of the still-unreported (estimated) spend crosses it. Absent = 10
   * (`DEFAULT_TOKEN_CAP_MARGIN_PCT`).
   */
  token_cap_margin_pct: z.int().min(0).max(100).optional(),
  /** Network probe before `run`; absent = none. */
  network: NetworkProbeConfigSchema.optional(),
  /** Extra non-secret env for the driver. */
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).default({}),
});
export type TrialJob = z.infer<typeof TrialJobSchema>;
export type TrialJobInput = z.input<typeof TrialJobSchema>;

export class TrialJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrialJobError";
  }
}

export function parseTrialJob(input: unknown): TrialJob {
  const parsed = TrialJobSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new TrialJobError(`trial.json is invalid: ${issues}`);
  }
  return parsed.data;
}

export async function loadTrialJob(path: string): Promise<TrialJob> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new TrialJobError(`cannot read ${path}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new TrialJobError(`${path} is not JSON: ${(err as Error).message}`);
  }
  return parseTrialJob(json);
}
