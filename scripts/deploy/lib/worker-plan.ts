// The worker deploy's inputs, the env file the worker boots with, the host scripts, the computer
// naming scheme and the keep-or-replace decision (worker-naive). Pure: no network, no process.env.
// Shared by scripts/deploy/worker.ts (run from a laptop or CI) and scripts/deploy/worker-rotate.ts
// (run by a systemd timer on the worker computer itself, to hand off before Naïve's 12 h limit).
//
// Secrets: values live only in the objects returned here and in the env file the deploy writes to
// the computer with the fs API (a request body, never an exec command line, never a log line).
import { createHash } from "node:crypto";
import { parseEnv } from "node:util";
import { NAIVE_COMPUTER_LIMITS, type NaiveComputer } from "@anybench/naive";
import {
  decodeNaiveComputerName,
  encodeNaiveComputerName,
  naiveBlockPriceMicroUsd,
  NAIVE_RATE_CARD,
} from "@anybench/providers";
import { z } from "zod";
import { kekVar, sameDatabase } from "./api-plan.js";

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const req = (name: string) =>
  z.preprocess(blank, z.string({ error: `${name} is required in .env` }).min(1));
const opt = z.preprocess(blank, z.string().optional());
const pgUrl = (name: string) =>
  req(name).refine((v) => /^postgres(ql)?:\/\//.test(v), `${name} must be a postgres:// URL`);
const intIn = (min: number, max: number, dflt: number) =>
  z.preprocess(blank, z.coerce.number().int().min(min).max(max).default(dflt));

/** Hours after create at which a worker computer hands off to a successor (Naïve kills it at 12). */
export const DEFAULT_ROTATE_AFTER_HOURS = 10;
/** Never keep a computer this close to the platform's 12 h destroy, whatever the setting says. */
export const LIFETIME_MARGIN_MS = 45 * 60_000;

/** The .env keys the worker deploy reads. Anything else in .env is ignored. */
export const WorkerDeployEnvSchema = z
  .object({
    NAIVE_API_KEY: req("NAIVE_API_KEY"),
    NAIVE_BASE_URL: opt,
    DATABASE_URL: pgUrl("DATABASE_URL"),
    /** graphile-worker needs the direct (unpooled) URL: LISTEN/NOTIFY. */
    DATABASE_URL_DIRECT: pgUrl("DATABASE_URL_DIRECT"),
    DATABASE_URL_PROD: opt,
    DATABASE_URL_DIRECT_PROD: opt,
    BILLING_MODE: z.preprocess(blank, z.string().default("test")),
    STRIPE_TEST_SECRET_KEY: opt,
    STRIPE_LIVE_SECRET_KEY: opt,
    RUNNER_TOKEN_SECRET: opt,
    /** BYOK key-encryption keys (TDM-234): an AB_TOKEN_SOURCE=anthropic_key trial decrypts with them. */
    ANYBENCH_KEK: kekVar,
    ANYBENCH_KEK_PREVIOUS: kekVar,
    PUBLIC_API_URL: z.preprocess(blank, z.url().optional()),
    SENTRY_DSN: opt,
    GITHUB_TOKEN: opt,
    // The bundle travels through the artifact store, and the worker needs it for trial bundles.
    S3_ENDPOINT: req("S3_ENDPOINT"),
    S3_REGION: req("S3_REGION"),
    S3_BUCKET: req("S3_BUCKET"),
    S3_ACCESS_KEY_ID: req("S3_ACCESS_KEY_ID"),
    S3_SECRET_ACCESS_KEY: req("S3_SECRET_ACCESS_KEY"),
    LOG_LEVEL: opt,
    WORKER_CONCURRENCY: opt,
    TRIAL_PROXY_CAP_MICRO_USD: opt,
    COMPUTER_BLOCK_PRICE_MICRO_USD: opt,
    RUN_FEE_MICRO_USD: opt,
    COMPUTE_MARKUP_BPS: opt,
    // Deploy settings (not passed to the worker).
    DEPLOY_WORKER_VCPU: intIn(1, 4, 1),
    DEPLOY_WORKER_MEMORY_MB: intIn(1024, 8192, 2048),
    DEPLOY_WORKER_DISK_GB: intIn(10, 40, 10),
    DEPLOY_WORKER_ROTATE_AFTER_HOURS: intIn(2, 11, DEFAULT_ROTATE_AFTER_HOURS),
    /** The runner ingest base the worker writes into trial.json; default PUBLIC_API_URL. */
    DEPLOY_WORKER_PUBLIC_API_URL: z.preprocess(blank, z.url().optional()),
  })
  .superRefine((env, ctx) => {
    if (env.BILLING_MODE !== "test" && env.BILLING_MODE !== "live") {
      ctx.addIssue({
        code: "custom",
        path: ["BILLING_MODE"],
        message: `must be test or live for this deploy (got ${env.BILLING_MODE})`,
      });
    }
    // The worker's meter reporter only needs the key (meter events go by event name).
    if (env.BILLING_MODE === "live" && !/^(sk|rk)_live_/.test(env.STRIPE_LIVE_SECRET_KEY ?? "")) {
      ctx.addIssue({
        code: "custom",
        path: ["STRIPE_LIVE_SECRET_KEY"],
        message: "is required when BILLING_MODE=live and must be a live key (sk_live_/rk_live_)",
      });
    }
    if (env.STRIPE_TEST_SECRET_KEY && !/^(sk|rk)_test_/.test(env.STRIPE_TEST_SECRET_KEY)) {
      ctx.addIssue({
        code: "custom",
        path: ["STRIPE_TEST_SECRET_KEY"],
        message: "is not a test-mode key",
      });
    }
    for (const [name, value, prod] of [
      ["DATABASE_URL", env.DATABASE_URL, env.DATABASE_URL_PROD],
      ["DATABASE_URL_DIRECT", env.DATABASE_URL_DIRECT, env.DATABASE_URL_DIRECT_PROD],
    ] as const) {
      if (prod && sameDatabase(value, prod)) {
        ctx.addIssue({
          code: "custom",
          path: [name],
          message: "points at the prod branch; this deploy uses dev",
        });
      }
    }
    if (env.DATABASE_URL_DIRECT.includes("-pooler.")) {
      ctx.addIssue({
        code: "custom",
        path: ["DATABASE_URL_DIRECT"],
        message: "is a pooled (-pooler) host; graphile-worker needs the direct endpoint",
      });
    }
  });
export type WorkerDeployEnv = z.infer<typeof WorkerDeployEnvSchema>;

/** Every issue at once, as `KEY: message` (never a value). */
export function parseWorkerDeployEnv(raw: Record<string, string | undefined>): WorkerDeployEnv {
  const parsed = WorkerDeployEnvSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    throw new Error(`worker deploy env is not usable:\n${lines.join("\n")}`);
  }
  return parsed.data;
}

/**
 * Every variable the worker's env file may carry (apps/server/src/config.ts plus the process-env
 * reads: S3_* in packages/envs, GITHUB_TOKEN in packages/kit). Paths (ANYBENCH_KITS_DIR,
 * ANYBENCH_RUNNER_BIN_DIR, ANYBENCH_GENERATED_KITS_DIR) are set by run-worker.sh on the host.
 */
export const WORKER_ENV_NAMES = [
  "NODE_ENV",
  "ANYBENCH_ENV",
  "LOG_LEVEL",
  "DATABASE_URL",
  "DATABASE_URL_DIRECT",
  "BILLING_MODE",
  "STRIPE_SECRET_KEY",
  "NAIVE_API_KEY",
  "NAIVE_BASE_URL",
  "RUNNER_TOKEN_SECRET",
  "ANYBENCH_KEK",
  "ANYBENCH_KEK_PREVIOUS",
  "PUBLIC_API_URL",
  "SENTRY_DSN",
  "GITHUB_TOKEN",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "WORKER_CONCURRENCY",
  "TRIAL_PROXY_CAP_MICRO_USD",
  "COMPUTER_BLOCK_PRICE_MICRO_USD",
  "RUN_FEE_MICRO_USD",
  "COMPUTE_MARKUP_BPS",
] as const;
export type WorkerEnvName = (typeof WORKER_ENV_NAMES)[number];

/** The worker's environment, in WORKER_ENV_NAMES order. Unset optional names are left out. */
export function planWorkerEnv(env: WorkerDeployEnv): Partial<Record<WorkerEnvName, string>> {
  const out: Partial<Record<WorkerEnvName, string>> = {
    NODE_ENV: "production",
    ANYBENCH_ENV: "staging",
    LOG_LEVEL: env.LOG_LEVEL ?? "info",
    DATABASE_URL: env.DATABASE_URL,
    DATABASE_URL_DIRECT: env.DATABASE_URL_DIRECT,
    BILLING_MODE: env.BILLING_MODE === "live" ? "live" : "test",
    NAIVE_API_KEY: env.NAIVE_API_KEY,
    S3_ENDPOINT: env.S3_ENDPOINT,
    S3_REGION: env.S3_REGION,
    S3_BUCKET: env.S3_BUCKET,
    S3_ACCESS_KEY_ID: env.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: env.S3_SECRET_ACCESS_KEY,
  };
  const publicApi = env.DEPLOY_WORKER_PUBLIC_API_URL ?? env.PUBLIC_API_URL;
  if (publicApi) out.PUBLIC_API_URL = publicApi;
  const stripeKey =
    env.BILLING_MODE === "live" ? env.STRIPE_LIVE_SECRET_KEY : env.STRIPE_TEST_SECRET_KEY;
  if (stripeKey) out.STRIPE_SECRET_KEY = stripeKey;
  for (const k of [
    "NAIVE_BASE_URL",
    "RUNNER_TOKEN_SECRET",
    "ANYBENCH_KEK",
    "ANYBENCH_KEK_PREVIOUS",
    "SENTRY_DSN",
    "GITHUB_TOKEN",
    "WORKER_CONCURRENCY",
    "TRIAL_PROXY_CAP_MICRO_USD",
    "COMPUTER_BLOCK_PRICE_MICRO_USD",
    "RUN_FEE_MICRO_USD",
    "COMPUTE_MARKUP_BPS",
  ] as const) {
    if (env[k]) out[k] = env[k];
  }
  return Object.fromEntries(
    WORKER_ENV_NAMES.filter((n) => out[n] !== undefined).map((n) => [n, out[n]!]),
  );
}

/**
 * `KEY='value'` lines that node's --env-file (node:util parseEnv) reads back exactly. A value
 * holding both quote kinds or a newline cannot be written that way and is refused by name.
 */
export function renderEnvFile(vars: Record<string, string>): string {
  const lines = [
    "# Anybench worker env (scripts/deploy/worker.ts). Secret: mode 600, never print.",
  ];
  for (const [name, value] of Object.entries(vars)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`bad env name ${name}`);
    if (/[\r\n]/.test(value)) throw new Error(`${name}: a newline cannot go in the env file`);
    if (!value.includes("'")) lines.push(`${name}='${value}'`);
    else if (!value.includes('"')) lines.push(`${name}="${value}"`);
    else throw new Error(`${name}: holds both quote kinds; cannot go in the env file`);
  }
  return `${lines.join("\n")}\n`;
}

/** What `--dry-run` prints about the worker env file: variable NAMES and its size, never a value. */
export function workerEnvPlanSummary(
  vars: Partial<Record<WorkerEnvName, string>>,
  envFile: string,
): { path: string; names: WorkerEnvName[]; bytes: number } {
  return {
    path: `~/${HOST_PATHS.envFile} (mode 600, written by the fs API)`,
    names: Object.keys(vars) as WorkerEnvName[],
    bytes: envFile.length,
  };
}

/** parseEnv, for the round-trip check and for the rotator reading the file back. */
export function parseEnvFile(text: string): Record<string, string> {
  return parseEnv(text) as Record<string, string>;
}

/** 12 hex chars naming an env file's content in the computer name; salted, never reversible. */
export function envFingerprint(envFile: string): string {
  return createHash("sha256").update(`anybench-worker-env\n${envFile}`).digest("hex").slice(0, 12);
}

// ---------- computer naming ----------

/** Carried by every worker computer. `ab-infra-*` is never touched by the computer reaper. */
export const WORKER_TAG = "ab-infra-worker";
const BUNDLE_TAG = "ab-infra-wb-";
const ENV_TAG = "ab-infra-we-";
export const WORKER_DISPLAY_NAME = "anybench graphile worker (scripts/deploy/worker.ts)";

export function workerComputerName(releaseId: string, envFp: string): string {
  return encodeNaiveComputerName(
    [WORKER_TAG, `${BUNDLE_TAG}${releaseId.slice(0, 12)}`, `${ENV_TAG}${envFp.slice(0, 12)}`],
    WORKER_DISPLAY_NAME,
  );
}

export interface WorkerComputer {
  id: string;
  createdAt: string;
  status: NaiveComputer["status"];
  /** First 12 hex of the release id this computer was provisioned with. */
  release: string | null;
  env: string | null;
}

/** A worker computer, or null for any other computer on the account. */
export function asWorkerComputer(c: NaiveComputer): WorkerComputer | null {
  const { tags } = decodeNaiveComputerName(c.name);
  if (!tags.includes(WORKER_TAG)) return null;
  const pick = (p: string) => tags.find((t) => t.startsWith(p))?.slice(p.length) ?? null;
  return {
    id: c.id,
    createdAt: c.createdAt,
    status: c.status,
    release: pick(BUNDLE_TAG),
    env: pick(ENV_TAG),
  };
}

/** Live worker computers, newest first. */
export function liveWorkers(all: readonly NaiveComputer[]): WorkerComputer[] {
  return all
    .map(asWorkerComputer)
    .filter((w): w is WorkerComputer => w !== null)
    .filter((w) => w.status === "creating" || w.status === "running" || w.status === "paused")
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

// ---------- the release manifest (written next to the release, outside the tarball) ----------

const hex = (n: number) => z.string().regex(new RegExp(`^[0-9a-f]{${n}}$`));
export const WorkerManifestSchema = z.strictObject({
  version: z.literal(1),
  release: z.strictObject({
    /** 32 hex of the file map's content hash: the release dir name and the bundle tag. */
    id: hex(32),
    /** sha256 of the tarball (what the host checks after download). */
    sha256: hex(64),
    sizeBytes: z.number().int().positive(),
    /** Where the tarball is in the artifact store (ArtifactStore createDownload input). */
    artifact: z.strictObject({ runId: z.string(), trialId: z.string(), name: z.string() }),
  }),
  size: z.strictObject({
    vcpu: z.number().int().min(1),
    memoryMb: z.number().int().min(128),
    diskGb: z.number().int().min(1),
  }),
  rotateAfterMs: z.number().int().positive(),
  commit: z.string(),
  builtAt: z.iso.datetime(),
});
export type WorkerManifest = z.infer<typeof WorkerManifestSchema>;

export function releaseArtifactRef(releaseId: string): WorkerManifest["release"]["artifact"] {
  return { runId: "infra", trialId: `worker-${releaseId}`, name: "worker-release.tar.gz" };
}

// ---------- keep or replace ----------

export type Decision =
  | { kind: "keep"; keep: string; retire: string[] }
  | { kind: "replace"; retire: string[]; reason: string }
  | { kind: "wait"; reason: string };

export interface DeployInputs {
  workers: readonly WorkerComputer[];
  /** Whether the newest worker's process is ticking worker_heartbeats (checked by the caller). */
  newestHealthy: boolean;
  want: { release: string; env: string };
  nowMs: number;
  rotateAfterMs: number;
  force?: boolean;
}

const ageMs = (w: WorkerComputer, nowMs: number) => nowMs - Date.parse(w.createdAt);

/** The latest moment a computer may be kept until: the rotation age, capped before the 12 h kill. */
export function retireAtMs(w: WorkerComputer, rotateAfterMs: number): number {
  const cap = NAIVE_COMPUTER_LIMITS.maxLifetimeMs - LIFETIME_MARGIN_MS;
  return Date.parse(w.createdAt) + Math.min(rotateAfterMs, cap);
}

/** The deploy (laptop/CI) view: keep the newest worker only if it runs exactly what we want. */
export function decideDeploy(i: DeployInputs): Decision {
  const [newest, ...older] = i.workers;
  const all = i.workers.map((w) => w.id);
  if (!newest) return { kind: "replace", retire: [], reason: "no worker computer" };
  if (i.force) return { kind: "replace", retire: all, reason: "--force" };
  const reasons: string[] = [];
  if (newest.status !== "running") reasons.push(`newest is ${newest.status}`);
  if (newest.release !== i.want.release.slice(0, 12)) reasons.push("release changed");
  if (newest.env !== i.want.env.slice(0, 12)) reasons.push("env changed");
  if (i.nowMs >= retireAtMs(newest, i.rotateAfterMs))
    reasons.push(`age ${Math.round(ageMs(newest, i.nowMs) / 60_000)} min is past rotation`);
  if (reasons.length === 0 && !i.newestHealthy) reasons.push("newest is not heartbeating");
  if (reasons.length > 0) return { kind: "replace", retire: all, reason: reasons.join(", ") };
  return { kind: "keep", keep: newest.id, retire: older.map((w) => w.id) };
}

/** The on-host rotator's view: only the newest worker hands off, and only once it is old enough. */
export function decideRotate(i: {
  selfId: string;
  workers: readonly WorkerComputer[];
  nowMs: number;
  rotateAfterMs: number;
}): Decision {
  const self = i.workers.find((w) => w.id === i.selfId);
  if (!self) return { kind: "wait", reason: "this computer is not a live worker computer" };
  const newer = i.workers.filter((w) => Date.parse(w.createdAt) > Date.parse(self.createdAt));
  if (newer.length > 0) return { kind: "wait", reason: `a newer worker exists (${newer[0]!.id})` };
  if (i.nowMs < retireAtMs(self, i.rotateAfterMs)) {
    return { kind: "keep", keep: self.id, retire: [] };
  }
  return {
    kind: "replace",
    retire: i.workers.map((w) => w.id),
    reason: `age ${Math.round(ageMs(self, i.nowMs) / 60_000)} min is past rotation`,
  };
}

// ---------- cost (integer micro-USD) ----------

export interface WorkerCost {
  perBlockMicroUsd: bigint;
  /** Always-on compute: 144 ten-minute blocks a day. */
  computePerDayMicroUsd: bigint;
  handoffsPerDay: number;
  /** Each handoff pays at most one extra block: the successor's part-block plus the old one's unrefunded rest. */
  handoffPerDayMicroUsd: bigint;
  totalPerDayMicroUsd: bigint;
  totalPer30DaysMicroUsd: bigint;
}

export function workerCost(
  size: { vcpu: number; memoryMb: number },
  rotateAfterMs: number,
): WorkerCost {
  const perBlock = naiveBlockPriceMicroUsd(size);
  const blocksPerDay = BigInt((24 * 3600) / NAIVE_RATE_CARD.blockSeconds);
  const compute = perBlock * blocksPerDay;
  const handoffsPerDay = Math.ceil((24 * 3600_000) / rotateAfterMs);
  const handoff = perBlock * BigInt(handoffsPerDay);
  return {
    perBlockMicroUsd: perBlock,
    computePerDayMicroUsd: compute,
    handoffsPerDay,
    handoffPerDayMicroUsd: handoff,
    totalPerDayMicroUsd: compute + handoff,
    totalPer30DaysMicroUsd: (compute + handoff) * 30n,
  };
}

// ---------- the host side ----------

/** Relative to the host user's home; the fs API addresses the same place as `<inspect.home>/…`. */
export const HOST_PATHS = {
  root: "anybench-worker",
  bootstrap: "anybench-worker/bootstrap.sh",
  manifest: "anybench-worker/manifest.json",
  computer: "anybench-worker/computer.json",
  kitsArchive: "anybench-worker/generated-kits.tgz",
  secretsDir: ".anybench",
  envFile: ".anybench/worker.env",
  curlConfig: ".anybench/bundle.curl",
} as const;

export const NODE_MIN_MAJOR = 22;
export const NODE_FALLBACK_VERSION = "v22.12.0";
export const BOOTSTRAP_PHASES = [
  "install",
  "start",
  "stop",
  "status",
  "pack-kits",
  "unpack-kits",
] as const;
export type BootstrapPhase = (typeof BOOTSTRAP_PHASES)[number];

/**
 * The exec command line for one bootstrap phase. Only phase names and hex ids ever go on it: the
 * computer keeps command history unredacted for 30 days. Waits for the script first, because an
 * fs write can take a moment to show up in the shell (docs/findings/naive-hosting.md).
 */
export function bootstrapCommand(phase: BootstrapPhase, args: string[] = []): string {
  if (!BOOTSTRAP_PHASES.includes(phase)) throw new Error(`unknown phase ${phase}`);
  for (const a of args)
    if (!/^[0-9a-f]{1,64}$/.test(a)) throw new Error("bootstrap args are hex ids");
  const script = `"$HOME/${HOST_PATHS.bootstrap}"`;
  return (
    `for i in $(seq 1 40); do [ -f ${script} ] && break; sleep 0.5; done; ` +
    `bash ${script} ${[phase, ...args].join(" ")}`
  );
}

/** curl -K config holding the presigned GET, so the URL is never on a command line. */
export function curlConfig(url: string): string {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new Error("bundle URL must be https");
  return `url = "${url.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"\nfail\nsilent\nshow-error\n`;
}

/**
 * bootstrap.sh: installs Node ≥ 22 if the image has none, fetches and checks the release,
 * `npm install`s its dependencies, and runs the worker under systemd (Restart=always) with a timer
 * that runs the rotator every 15 min. Falls back to a setsid supervisor loop without systemd.
 * Prints no secret: the env file is read only by node, the bundle URL only by curl.
 */
export function renderBootstrap(opts: { nodeFallbackVersion?: string } = {}): string {
  const nodeFallback = opts.nodeFallbackVersion ?? NODE_FALLBACK_VERSION;
  if (!/^v\d+\.\d+\.\d+$/.test(nodeFallback)) throw new Error("bad node version");
  return `#!/usr/bin/env bash
# Anybench worker host bootstrap. Rendered by scripts/deploy/lib/worker-plan.ts; do not edit here.
# Phases: install <release-id> <sha256> | start | stop | status | pack-kits | unpack-kits
# Never prints a secret: worker.env is read only by node, bundle.curl only by curl. Never enable xtrace.
set -euo pipefail
umask 077
ROOT="$HOME/${HOST_PATHS.root}"
SECRETS="$HOME/${HOST_PATHS.secretsDir}"
ENV_FILE="$HOME/${HOST_PATHS.envFile}"
CURL_CFG="$HOME/${HOST_PATHS.curlConfig}"
KITS_TGZ="$HOME/${HOST_PATHS.kitsArchive}"
UNIT=anybench-worker
mkdir -p "$ROOT" "$SECRETS"

log() { printf '[bootstrap] %s\\n' "$*" >&2; }
wait_for() { for _ in $(seq 1 40); do [ -e "$1" ] && return 0; sleep 0.5; done; log "missing $1"; exit 2; }
has_systemd() { [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1 && sudo -n true 2>/dev/null; }
node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

ensure_node() {
  local n
  n="$(command -v node || true)"
  if [ -n "$n" ] && [ "$(node_major "$n")" -ge ${NODE_MIN_MAJOR} ]; then echo "$n"; return; fi
  if [ -x "$ROOT/node/bin/node" ]; then echo "$ROOT/node/bin/node"; return; fi
  local a
  case "$(uname -m)" in x86_64) a=x64 ;; aarch64 | arm64) a=arm64 ;; *) log "unsupported arch $(uname -m)"; exit 3 ;; esac
  log "installing node ${nodeFallback} ($a)"
  curl -fsSL --retry 3 -o "$ROOT/node.tar.xz" "https://nodejs.org/dist/${nodeFallback}/node-${nodeFallback}-linux-$a.tar.xz"
  rm -rf "$ROOT/node" && mkdir -p "$ROOT/node"
  tar -xJf "$ROOT/node.tar.xz" -C "$ROOT/node" --strip-components=1 --no-same-owner
  rm -f "$ROOT/node.tar.xz"
  echo "$ROOT/node/bin/node"
}

write_host_files() {
  local node="$1" user
  user="$(id -un)"
  cat > "$ROOT/run-worker.sh" <<EOF
#!/usr/bin/env bash
# \\$1 = worker | rotate. Paths are set here, secrets come from the env file (node --env-file).
set -euo pipefail
export ANYBENCH_KITS_DIR="$ROOT/current/kits"
export ANYBENCH_RUNNER_BIN_DIR="$ROOT/current/bin"
export ANYBENCH_GENERATED_KITS_DIR="$SECRETS/generated-kits"
export PATH="$(dirname "$node"):\\$PATH"
cd "$ROOT/current"
exec "$node" --env-file="$ENV_FILE" "dist/\\\${1:-worker}.js"
EOF
  cat > "$ROOT/supervise.sh" <<EOF
#!/usr/bin/env bash
# Fallback supervisor when the host has no systemd: restart the worker 5 s after any exit,
# and run the rotator every 15 min. Stopped by touching $ROOT/stopped and a TERM to the group.
( while sleep 900; do [ -f "$ROOT/stopped" ] && exit 0; bash "$ROOT/run-worker.sh" rotate >> "$ROOT/rotate.log" 2>&1 < /dev/null || true; done ) &
while true; do
  [ -f "$ROOT/stopped" ] && exit 0
  bash "$ROOT/run-worker.sh" worker >> "$ROOT/worker.log" 2>&1 < /dev/null || true
  [ -f "$ROOT/stopped" ] && exit 0
  sleep 5
done
EOF
  chmod 700 "$ROOT/run-worker.sh" "$ROOT/supervise.sh"
  has_systemd || return 0
  sudo tee /etc/systemd/system/$UNIT.service > /dev/null <<EOF
[Unit]
Description=Anybench graphile worker (scripts/deploy/worker.ts)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=$user
WorkingDirectory=$ROOT
ExecStart=/bin/bash $ROOT/run-worker.sh worker
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=120
StandardOutput=append:$ROOT/worker.log
StandardError=append:$ROOT/worker.log

[Install]
WantedBy=multi-user.target
EOF
  sudo tee /etc/systemd/system/$UNIT-rotate.service > /dev/null <<EOF
[Unit]
Description=Anybench worker handoff before the 12 h computer limit

[Service]
Type=oneshot
User=$user
WorkingDirectory=$ROOT
ExecStart=/bin/bash $ROOT/run-worker.sh rotate
TimeoutStartSec=1800
StandardOutput=append:$ROOT/rotate.log
StandardError=append:$ROOT/rotate.log
EOF
  sudo tee /etc/systemd/system/$UNIT-rotate.timer > /dev/null <<EOF
[Unit]
Description=Run the Anybench worker rotator every 15 min

[Timer]
OnActiveSec=15min
OnUnitActiveSec=15min
RandomizedDelaySec=60

[Install]
WantedBy=timers.target
EOF
  sudo systemctl daemon-reload
}

phase="\${1:-}"
case "$phase" in
  install)
    release="\${2:?release id}" sha="\${3:?sha256}"
    wait_for "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    node="$(ensure_node)"
    rel="$ROOT/releases/$release"
    if [ ! -f "$rel/.complete" ]; then
      wait_for "$CURL_CFG"
      chmod 600 "$CURL_CFG"
      rm -rf "$rel" && mkdir -p "$rel"
      curl --retry 3 --retry-delay 2 -K "$CURL_CFG" -o "$ROOT/release.tgz"
      echo "$sha  $ROOT/release.tgz" | sha256sum -c --status || { log "release sha256 mismatch"; exit 4; }
      tar -xzf "$ROOT/release.tgz" -C "$rel" --no-same-owner
      rm -f "$ROOT/release.tgz"
      npm_bin="$(dirname "$node")/npm"
      [ -x "$npm_bin" ] || npm_bin="$(command -v npm)"
      (cd "$rel" && PATH="$(dirname "$node"):$PATH" "$npm_bin" install --omit=dev --no-audit --no-fund --loglevel=error > "$ROOT/npm-install.log" 2>&1) || { log "npm install failed"; tail -20 "$ROOT/npm-install.log" >&2; exit 5; }
      touch "$rel/.complete"
    fi
    rm -f "$CURL_CFG"
    ln -sfn "$rel" "$ROOT/current"
    write_host_files "$node"
    # Only the current release stays on the (small) disk.
    for d in "$ROOT"/releases/*; do [ "$d" = "$rel" ] || rm -rf "$d"; done
    log "installed $release with node $("$node" -v) (supervisor: $(has_systemd && echo systemd || echo setsid))"
    ;;
  start)
    rm -f "$ROOT/stopped"
    if has_systemd; then
      sudo systemctl enable $UNIT.service $UNIT-rotate.timer > /dev/null 2>&1
      sudo systemctl start $UNIT.service $UNIT-rotate.timer
    elif ! { [ -f "$ROOT/supervise.pid" ] && kill -0 "$(cat "$ROOT/supervise.pid")" 2>/dev/null; }; then
      setsid nohup bash "$ROOT/supervise.sh" > "$ROOT/supervise.log" 2>&1 < /dev/null &
      echo $! > "$ROOT/supervise.pid"
    fi
    log "started"
    ;;
  stop)
    touch "$ROOT/stopped"
    if has_systemd; then
      sudo systemctl stop $UNIT-rotate.timer $UNIT.service || true
    elif [ -f "$ROOT/supervise.pid" ]; then
      pg="$(cat "$ROOT/supervise.pid")"
      kill -TERM -- "-$pg" 2>/dev/null || true
      for _ in $(seq 1 120); do kill -0 -- "-$pg" 2>/dev/null || break; sleep 1; done
      kill -KILL -- "-$pg" 2>/dev/null || true
      rm -f "$ROOT/supervise.pid"
    fi
    log "stopped"
    ;;
  status)
    if has_systemd; then state="$(systemctl is-active $UNIT.service || true)"; sup=systemd
    elif [ -f "$ROOT/supervise.pid" ] && kill -0 "$(cat "$ROOT/supervise.pid")" 2>/dev/null; then state=active; sup=setsid
    else state=inactive; sup=setsid; fi
    printf '{"host":"%s","worker":"%s","supervisor":"%s","release":"%s"}\\n' "$(hostname)" "$state" "$sup" "$(basename "$(readlink "$ROOT/current" 2>/dev/null || echo none)")"
    ;;
  pack-kits)
    if [ -d "$SECRETS/generated-kits" ]; then
      tar -czf "$KITS_TGZ" -C "$SECRETS" generated-kits
      stat -c %s "$KITS_TGZ"
    else
      echo 0
    fi
    ;;
  unpack-kits)
    wait_for "$KITS_TGZ"
    tar -xzf "$KITS_TGZ" -C "$SECRETS" --no-same-owner
    rm -f "$KITS_TGZ"
    log "generated kits restored"
    ;;
  *)
    log "usage: bootstrap.sh install <release-id> <sha256> | start | stop | status | pack-kits | unpack-kits"
    exit 64
    ;;
esac
`;
}

export const HostStatusSchema = z.object({
  host: z.string().min(1),
  worker: z.string(),
  supervisor: z.enum(["systemd", "setsid"]),
  release: z.string(),
});
export type HostStatus = z.infer<typeof HostStatusSchema>;
