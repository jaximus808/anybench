// L0 source, L1 install, L2 driver, L4 collectors: one contender in a kit (plan.md P2).
import { z } from "zod";
import type { ProfileName } from "./env.js";
import {
  KitEnvMapSchema,
  KitSlugSchema,
  KitPathSchema,
  KitSha256Schema,
} from "./kit-primitives.js";

// ---------------------------------------------------------------------------------------------
// L0 source: `{github, ref}` · `{binary_url, sha256}` · `{upload}`

export const GithubSourceSchema = z.strictObject({
  /** `owner/repo`, or a github.com URL. */
  github: z
    .string()
    .regex(/^(https:\/\/github\.com\/|github\.com\/)?[A-Za-z0-9-]+\/[A-Za-z0-9._-]+?(\.git)?$/, {
      error: "must be 'owner/repo' or a github.com URL",
    }),
  /** Branch, tag or commit. */
  ref: z.string().min(1),
});

export const BinarySourceSchema = z.strictObject({
  binary_url: z.url({ protocol: /^https?$/ }),
  sha256: KitSha256Schema,
});

export const UploadSourceSchema = z.strictObject({
  /** Uploaded paths (a binary, or a Claude Code setup: `CLAUDE.md`, `.claude/`, `.mcp.json`). */
  upload: z.array(KitPathSchema).min(1),
});

export const ContenderSourceSchema = z.union([
  GithubSourceSchema,
  BinarySourceSchema,
  UploadSourceSchema,
]);
export type ContenderSource = z.infer<typeof ContenderSourceSchema>;

// ---------------------------------------------------------------------------------------------
// L1 install: runs at snapshot build. Exit 0 and the health check passes.

export const ContenderInstallSchema = z.strictObject({
  /** Defaults to `adapters/<id>/install.sh`. */
  script: KitPathSchema.optional(),
  /** Defaults to `adapters/<id>/healthcheck.sh`. */
  healthcheck: KitPathSchema.optional(),
});
export type ContenderInstall = z.infer<typeof ContenderInstallSchema>;

// ---------------------------------------------------------------------------------------------
// L4 collectors: built into the runner.

export const CollectorNameSchema = z.enum([
  "machine", // machine.json: lscpu, uname, nproc, meminfo, load_1m, steal
  "time", // /usr/bin/time -v: wall, CPU, peak RSS
  "hyperfine", // hyperfine --export-json
  "hey",
  "k6",
  "bench-shim", // tinybench / pytest-benchmark / criterion output
  "pty-sentinel", // time to sentinel, bytes/s
  "screenshot",
  "playwright",
  "lighthouse",
  "stream-json", // Claude Code stream-json: tokens, turns, cost
  "proxy-calls", // Naïve proxy.calls
  "tandem-board", // claims, conflicts, approvals from the board
]);
export type CollectorName = z.infer<typeof CollectorNameSchema>;

// ---------------------------------------------------------------------------------------------
// L2 driver: verbs `start`, `ready`, `run <in> <out>`, `stop`. `driver.type` picks the collectors.

export const DriverTypeSchema = z.enum([
  "cli",
  "service",
  "lib",
  "pty",
  "x11",
  "web",
  "coding-agent",
  "http-agent",
  "harness",
]);
export type DriverType = z.infer<typeof DriverTypeSchema>;

/** The profile each driver type runs on (plan.md P2 driver table). */
export const DRIVER_DEFAULT_PROFILE: Readonly<Record<DriverType, ProfileName>> = {
  cli: "base",
  service: "svc",
  lib: "base",
  pty: "tui",
  x11: "gui",
  web: "web",
  "coding-agent": "agent-cc",
  "http-agent": "base",
  harness: "agent-cc",
};

/** The collectors each driver type gets when `collectors[]` is omitted. `machine` is always on. */
export const DRIVER_DEFAULT_COLLECTORS: Readonly<Record<DriverType, readonly CollectorName[]>> = {
  cli: ["machine", "time", "hyperfine"],
  service: ["machine", "time", "hey"],
  lib: ["machine", "bench-shim"],
  pty: ["machine", "time", "pty-sentinel"],
  x11: ["machine", "screenshot"],
  web: ["machine", "playwright", "k6"],
  "coding-agent": ["machine", "time", "stream-json", "proxy-calls"],
  "http-agent": ["machine", "time", "proxy-calls"],
  harness: ["machine", "time", "stream-json", "proxy-calls", "tandem-board"],
};

/** Commands for each verb. `{task}`, `{workspace}`, `{in}`, `{out}` are substituted by the runner. */
export const DriverVerbsSchema = z.strictObject({
  start: z.string().min(1).optional(),
  ready: z.string().min(1).optional(),
  run: z.string().min(1, { error: "the driver must define a 'run' verb" }),
  stop: z.string().min(1).optional(),
});
export type DriverVerbs = z.infer<typeof DriverVerbsSchema>;

const driverBase = {
  /** Defaults to `adapters/<id>/driver.sh`. */
  script: KitPathSchema.optional(),
  verbs: DriverVerbsSchema,
  /** Wall-clock cap the runner enforces per trial. */
  wall_clock_cap_s: z.int().positive().max(86_400).optional(),
  /** Plain env for the driver (not secrets; those go in `secrets[]`). */
  env: KitEnvMapSchema.optional(),
};

const tokenCaps = {
  model: z.string().min(1).optional(),
  /** BYOK token cap the runner enforces from stream-json. */
  token_cap: z.int().positive().optional(),
  max_turns: z.int().positive().optional(),
};

export const CliDriverSchema = z.strictObject({ type: z.literal("cli"), ...driverBase });

export const ServiceDriverSchema = z.strictObject({
  type: z.literal("service"),
  ...driverBase,
  /** URL polled until it answers, after `start`. */
  ready_url: z.url().optional(),
  load: z
    .strictObject({
      tool: z.enum(["hey", "k6"]),
      rps: z.int().positive().optional(),
      duration_s: z.int().positive().optional(),
    })
    .optional(),
});

export const LibDriverSchema = z.strictObject({
  type: z.literal("lib"),
  ...driverBase,
  bench: z.enum(["tinybench", "pytest-benchmark", "criterion", "custom"]),
});

export const PtyDriverSchema = z.strictObject({
  type: z.literal("pty"),
  ...driverBase,
  /** The terminal emulator binary, e.g. `kitty`, `alacritty`. */
  emulator: z.string().min(1),
  /** Geometry shared with the reference grid; the gate parses at the same size. */
  rows: z.int().min(1).max(1000),
  cols: z.int().min(1).max(1000),
  scrollback: z.int().min(0).max(10_000_000),
  /** How the final screen is dumped from the emulator. */
  screen_dump: z.enum(["native", "xdotool"]).default("native"),
});

export const X11DriverSchema = z.strictObject({ type: z.literal("x11"), ...driverBase });

export const WebDriverSchema = z.strictObject({
  type: z.literal("web"),
  ...driverBase,
  base_url: z.url().optional(),
});

export const CodingAgentDriverSchema = z.strictObject({
  type: z.literal("coding-agent"),
  ...driverBase,
  ...tokenCaps,
});

export const HttpAgentDriverSchema = z.strictObject({
  type: z.literal("http-agent"),
  ...driverBase,
  ...tokenCaps,
  endpoint: z.url().optional(),
  /** A reviewer-model session plays the user. */
  simulated_user: z.boolean().default(false),
});

/** Harness with approvals: needs `human_in_loop` on the kit (checked by KitSpecSchema). */
export const HarnessDriverSchema = z.strictObject({
  type: z.literal("harness"),
  ...driverBase,
  ...tokenCaps,
});

export const DriverSchema = z.discriminatedUnion("type", [
  CliDriverSchema,
  ServiceDriverSchema,
  LibDriverSchema,
  PtyDriverSchema,
  X11DriverSchema,
  WebDriverSchema,
  CodingAgentDriverSchema,
  HttpAgentDriverSchema,
  HarnessDriverSchema,
]);
export type Driver = z.infer<typeof DriverSchema>;

// ---------------------------------------------------------------------------------------------

export const ContenderRoleSchema = z.enum([
  "subject",
  "baseline",
  "competitor",
  "previous-release",
]);
export type ContenderRole = z.infer<typeof ContenderRoleSchema>;

export const ContenderSchema = z.strictObject({
  id: KitSlugSchema,
  name: z.string().min(1).optional(),
  role: ContenderRoleSchema,
  source: ContenderSourceSchema,
  install: ContenderInstallSchema.default({}),
  driver: DriverSchema,
  /** Pinned version string recorded on every trial (subject, Claude Code, model, Tandem). */
  version: z.string().min(1).optional(),
  /** Where this contender came from (researcher citation, user). */
  found_by: z.string().min(1).optional(),
});
export type Contender = z.infer<typeof ContenderSchema>;
