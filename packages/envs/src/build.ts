// Env build (plan.md P1 "build once, fork many"): one computer gets the profile's recipes, the
// in-VM runner binary, the kit's subject files and each contender's L1 install, then it is
// snapshotted and destroyed. Every trial forks that snapshot.
//
// Provider-agnostic (exec, putFile, snapshot only). The computer is OUR infrastructure: it is not in
// the computer registry, so it is never billed to a run, and it carries an `ab-infra-` tag so the
// reaper never mistakes it for a trial's. It is destroyed on every path (success, failure, abort).
//
// What goes into the image, relative to the computer's home:
//   .anybench/bin/runner        the runner (installRunner), checked with `--version`
//   kit/<subject files>         never gates/, reference/ or proof/ (17.2 rule 5)
//   whatever installs write     e.g. ~/.anybench/tandem (the Tandem adapter's install-tandem.sh)
// The contender installs run as root when the exec user is not root (they `npm install -g` and
// write /usr/local/bin), with HOME kept, and the home is chowned back to the exec user afterwards.
// Nothing here is secret: no credential ever reaches the image.
import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
  isProviderError,
  shellQuote,
  type ComputeProvider,
  type ComputerInfo,
  type ComputerSpecInput,
  type ExecResult,
} from "@anybench/providers";
import { INFRA_COMPUTER_TAG_PREFIX } from "./registry.js";
import {
  AGENT_CC_RECIPES,
  BASE_RECIPES,
  resolveRecipeOrder,
  runRecipes,
  type RecipeArch,
  type RecipeCatalog,
  type RecipeRunResult,
  type RunRecipesOptions,
} from "./recipe.js";

/** The recipes a kit's `env.profile` installs; null for a profile that is not built yet. */
export function recipesForProfile(profile: string): readonly string[] | null {
  switch (profile) {
    case "base":
      return BASE_RECIPES;
    case "agent-cc":
      return AGENT_CC_RECIPES;
    default:
      return null;
  }
}

/** `name@version` of every recipe the request installs, deps included, in install order. */
export function resolvedRecipeVersions(
  catalog: RecipeCatalog,
  requested: readonly string[],
): string[] {
  return resolveRecipeOrder(catalog, requested).map(
    (r) => `${r.manifest.name}@${r.manifest.version}`,
  );
}

/** Stable JSON (sorted keys) for cache keys. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** sha256 hex of the canonical JSON of `input`: the `envs.spec_hash` snapshot cache key. */
export function envBuildHash(input: unknown): string {
  return createHash("sha256").update(canonical(input)).digest("hex");
}

/** Where the runner binary lives on every eval computer (the executor's default). */
export const RUNNER_BIN_REL = ".anybench/bin/runner";
/** Where the kit's subject files are staged; the trial's verbs run here (driver.cwd). */
export const KIT_DIR_REL = "kit";

export interface EnvBuildFile {
  /** Relative to the computer's home, e.g. `kit/adapters/x/driver.sh`. */
  path: string;
  content: string | Uint8Array;
  mode?: number;
}

export interface EnvBuildInstall {
  /** For messages, e.g. the contender id. */
  name: string;
  /** Script path relative to the home (staged among `files`), e.g. `kit/adapters/x/install.sh`. */
  script: string;
  healthcheck?: string;
  /** Non-secret env (contender `versions`). */
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface RunnerInstaller {
  /** sha256 of the binary per arch: part of the cache key. */
  sha256(arch: RecipeArch): string;
  /** Put the binary at `<home>/.anybench/bin/runner` (0755). */
  install(provider: ComputeProvider, computer: ComputerInfo, arch: RecipeArch): Promise<void>;
}

export type EnvBuildStep =
  "create" | "recipes" | "runner" | "files" | "install" | "healthcheck" | "snapshot";

export class EnvBuildError extends Error {
  constructor(
    readonly step: EnvBuildStep,
    message: string,
    readonly output?: string,
  ) {
    super(`env build failed at ${step}: ${message}`);
    this.name = "EnvBuildError";
  }
}

export interface BuildEnvSnapshotOptions {
  provider: ComputeProvider;
  /** Size of the build computer (the kit's resources). Tags get the infra tag added. */
  spec: Omit<ComputerSpecInput, "snapshotId">;
  /** Short id for the infra tag and name, e.g. the first 12 chars of the spec hash. */
  label: string;
  recipes: readonly string[];
  catalog?: RecipeCatalog;
  runner?: RunnerInstaller;
  files?: EnvBuildFile[];
  installs?: EnvBuildInstall[];
  readyTimeoutMs?: number;
  onEvent?: RunRecipesOptions["onEvent"];
  runId?: string | null;
  signal?: AbortSignal;
  log?: (msg: string, data?: Record<string, unknown>) => void;
  /** Tries of a retryable create (capacity, timeout). Default 6. */
  createTries?: number;
  /** First create backoff, doubled each try (max 60 s). Default 5 000 ms. */
  createBackoffMs?: number;
  /** Tries of the destroy (any failure but forbidden / validation). Default 6. */
  destroyTries?: number;
  /** First destroy backoff, doubled each try (max 60 s). Default 5 000 ms. */
  destroyBackoffMs?: number;
}

export interface EnvSnapshot {
  snapshotId: string;
  /** Provider id of the (destroyed) build computer. */
  buildComputerId: string;
  arch: RecipeArch;
  recipes: RecipeRunResult;
  durationMs: number;
}

const TAIL = 3000;
function tail(r: ExecResult): string {
  const s = [r.stdout.trimEnd(), r.stderr.trimEnd()].filter(Boolean).join("\n");
  return s.length > TAIL ? `…${s.slice(-TAIL)}` : s;
}

/** The infra tag of an env build computer: never reaped as a trial's, never billed to a run. */
export function envBuildTag(label: string): string {
  return `${INFRA_COMPUTER_TAG_PREFIX}envbuild-${label.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)}`;
}

/** Recipe env and PATH as a `KEY=value` env for a script run (PATH prefixed, never replaced). */
function scriptPrefix(env: Record<string, string>, path: readonly string[]): string {
  const parts = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`);
  const p = path.length ? `${shellQuote(path.join(":"))}:"$PATH"` : '"$PATH"';
  return `PATH=${p} ${parts.join(" ")}`.trim();
}

/**
 * Build the env image: create → recipes → runner → files → installs (+ health checks) →
 * snapshot → destroy. Throws EnvBuildError (or RecipeRunError at the recipes step, wrapped) on
 * the first failure; the build computer is destroyed on every path.
 */
export async function buildEnvSnapshot(opts: BuildEnvSnapshotOptions): Promise<EnvSnapshot> {
  const { provider } = opts;
  const started = Date.now();
  const log = opts.log ?? (() => undefined);
  const checkAbort = () => {
    if (opts.signal?.aborted) throw new EnvBuildError("create", "aborted");
  };
  if (!provider.capabilities.snapshot) {
    throw new EnvBuildError("snapshot", `provider ${provider.name} cannot snapshot`);
  }
  const tag = envBuildTag(opts.label);
  const tags = [...(opts.spec.tags ?? [])];
  if (!tags.includes(tag)) tags.push(tag);

  // Naïve answers 429 "at capacity" now and then: a retryable create is retried with backoff.
  let computer!: ComputerInfo;
  const tries = opts.createTries ?? 6;
  for (let i = 0; ; i++) {
    checkAbort();
    try {
      computer = await provider.create({
        ...opts.spec,
        name: `anybench-envbuild-${opts.label}`,
        tags,
      });
      break;
    } catch (err) {
      const retry = isProviderError(err) && err.retryable && i < tries - 1;
      if (!retry) {
        throw new EnvBuildError("create", err instanceof Error ? err.message : String(err));
      }
      const ms = Math.min(60_000, (opts.createBackoffMs ?? 5_000) * 2 ** i);
      log("env build create retry", { attempt: i + 1, ms, err: String(err) });
      await new Promise((r) => setTimeout(r, ms));
    }
  }
  log("env build computer created", { id: computer.id });
  try {
    computer = await provider.waitReady(computer.id, {
      timeoutMs: opts.readyTimeoutMs ?? 300_000,
    });
    checkAbort();
    const maxExec = provider.capabilities.maxExecTimeoutMs;
    const exec = (cmd: string, timeoutMs = 120_000) =>
      provider.exec(computer.id, cmd, { timeoutMs: Math.min(timeoutMs, maxExec) });

    // 1. Recipes (the profile).
    let recipes: RecipeRunResult;
    try {
      recipes = await runRecipes(provider, computer.id, opts.recipes, {
        ...(opts.catalog ? { catalog: opts.catalog } : {}),
        ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
        runId: opts.runId ?? null,
      });
    } catch (err) {
      throw new EnvBuildError("recipes", err instanceof Error ? err.message : String(err));
    }
    log("recipes installed", { recipes: recipes.results.map((r) => `${r.name}:${r.status}`) });
    checkAbort();

    // 2. The runner binary.
    if (opts.runner) {
      try {
        await opts.runner.install(provider, computer, recipes.arch);
      } catch (err) {
        throw new EnvBuildError("runner", err instanceof Error ? err.message : String(err));
      }
      const v = await exec(`"$HOME"/${RUNNER_BIN_REL} --version`, 30_000);
      if (v.exitCode !== 0) throw new EnvBuildError("runner", "runner --version failed", tail(v));
      log("runner installed", { version: v.stdout.trim() });
    }
    checkAbort();

    // 3. Subject files.
    try {
      for (const f of opts.files ?? []) {
        await provider.putFile(
          computer.id,
          posix.join(computer.home, f.path),
          f.content,
          f.mode === undefined ? {} : { mode: f.mode },
        );
      }
    } catch (err) {
      throw new EnvBuildError("files", err instanceof Error ? err.message : String(err));
    }
    log("subject files staged", { files: opts.files?.length ?? 0 });
    checkAbort();

    // 4. Contender L1 installs (root when we are not, HOME kept), then health checks as the user.
    const prefix = scriptPrefix(recipes.env, recipes.path);
    const asRoot = (inner: string) =>
      `if [ "$(id -u)" = 0 ]; then ${inner}; else sudo -n env HOME="$HOME" ${inner}; fi`;
    for (const ins of opts.installs ?? []) {
      const env = Object.entries(ins.env ?? {})
        .map(([k, v]) => `${k}=${shellQuote(v)}`)
        .join(" ");
      const dir = posix.dirname(ins.script);
      const run = (script: string) =>
        `cd "$HOME"/${shellQuote(dir)} && ${prefix} ${env} bash "$HOME"/${shellQuote(script)}`;
      const r = await exec(
        `${asRoot(`bash -c ${shellQuote(run(ins.script))}`)} && { [ "$(id -u)" = 0 ] || sudo -n chown -R "$(id -u):$(id -g)" "$HOME"; }`,
        ins.timeoutMs ?? 600_000,
      );
      if (r.exitCode !== 0) {
        throw new EnvBuildError(
          "install",
          `${ins.name}: ${ins.script} exited ${r.exitCode}`,
          tail(r),
        );
      }
      if (ins.healthcheck) {
        const h = await exec(run(ins.healthcheck), 120_000);
        if (h.exitCode !== 0) {
          throw new EnvBuildError(
            "healthcheck",
            `${ins.name}: ${ins.healthcheck} exited ${h.exitCode}`,
            tail(h),
          );
        }
      }
      log("contender installed", { name: ins.name });
      checkAbort();
    }

    // 5. Snapshot.
    let snapshotId: string;
    try {
      snapshotId = (await provider.snapshot(computer.id)).snapshotId;
    } catch (err) {
      throw new EnvBuildError("snapshot", err instanceof Error ? err.message : String(err));
    }
    log("snapshot taken", { snapshotId });
    return {
      snapshotId,
      buildComputerId: computer.id,
      arch: recipes.arch,
      recipes,
      durationMs: Date.now() - started,
    };
  } finally {
    await destroyBuildComputer(provider, computer.id, opts, log);
  }
}

/**
 * Destroy the build computer, retrying a failure (Naïve 429 "at capacity", a timeout, a dropped
 * connection) with backoff: a build computer is infra, outside the trial reaper's reach, so one
 * 429 on the destroy used to leak it (docs/findings/proof-suite.md). A non-retryable error, or the last try,
 * is logged and swallowed so the build's own result or error stands.
 */
async function destroyBuildComputer(
  provider: BuildEnvSnapshotOptions["provider"],
  id: string,
  opts: Pick<BuildEnvSnapshotOptions, "destroyTries" | "destroyBackoffMs">,
  log: (msg: string, data?: Record<string, unknown>) => void,
): Promise<void> {
  const tries = opts.destroyTries ?? 6;
  for (let i = 0; ; i++) {
    try {
      await provider.destroy(id);
      return;
    } catch (err) {
      // Follow-up 69: destroy is idempotent (already gone is success), so a network blip (a
      // plain `provider` error, not `retryable`) is retried too; only a refusal that cannot
      // change (forbidden / validation) is not.
      const permanent = isProviderError(err, "forbidden") || isProviderError(err, "validation");
      if (permanent || i >= tries - 1) {
        log("env build computer destroy FAILED", { id, attempts: i + 1, err: String(err) });
        return;
      }
      const ms = Math.min(60_000, (opts.destroyBackoffMs ?? 5_000) * 2 ** i);
      log("env build destroy retry", { id, attempt: i + 1, ms, err: String(err) });
      await new Promise((r) => setTimeout(r, ms));
    }
  }
}

/** Runner from bytes held by the worker (docker-local, tests): putFile, 0755. */
export function runnerFromBytes(bins: Partial<Record<RecipeArch, Uint8Array>>): RunnerInstaller {
  const get = (arch: RecipeArch) => {
    const b = bins[arch];
    if (!b) throw new Error(`no runner binary for ${arch}`);
    return b;
  };
  return {
    sha256: (arch) => createHash("sha256").update(get(arch)).digest("hex"),
    async install(provider, computer, arch) {
      await provider.putFile(computer.id, posix.join(computer.home, RUNNER_BIN_REL), get(arch), {
        mode: 0o755,
      });
    },
  };
}

/**
 * Runner fetched by the computer itself from a presigned GET (large binaries: ~94 MB is too big for
 * an fs write). The URL goes in a 0600 file and reaches curl through `-K -`, never argv; the
 * download is refused unless its sha256 matches.
 */
export function runnerFromUrl(opts: {
  sha256: Partial<Record<RecipeArch, string>>;
  url: (arch: RecipeArch) => Promise<string>;
}): RunnerInstaller {
  const shaOf = (arch: RecipeArch) => {
    const s = opts.sha256[arch];
    if (!s) throw new Error(`no runner binary for ${arch}`);
    return s;
  };
  return {
    sha256: shaOf,
    async install(provider, computer, arch) {
      const sha = shaOf(arch);
      const url = await opts.url(arch);
      const urlFile = posix.join(computer.home, ".anybench", "runner.url");
      await provider.putFile(computer.id, urlFile, `${url}\n`, { mode: 0o600 });
      const bin = `"$HOME"/${RUNNER_BIN_REL}`;
      const cmd = [
        "set -e",
        'urlf="$HOME/.anybench/runner.url"',
        `mkdir -p "$HOME/.anybench/bin"`,
        `trap 'rm -f "$urlf"' EXIT`,
        `sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g' -e 's/^/url = "/' -e 's/$/"/' "$urlf" | curl -fsSL --retry 3 --max-time 600 -K - -o ${bin}.part`,
        `got="$(sha256sum ${bin}.part | cut -d' ' -f1)"`,
        `[ "$got" = ${shellQuote(sha)} ] || { echo "runner sha256 mismatch: $got" >&2; rm -f ${bin}.part; exit 1; }`,
        `chmod 755 ${bin}.part && mv ${bin}.part ${bin}`,
      ].join("\n");
      const r = await provider.exec(computer.id, `bash -c ${shellQuote(cmd)}`, {
        timeoutMs: Math.min(660_000, provider.capabilities.maxExecTimeoutMs),
      });
      if (r.exitCode !== 0)
        throw new Error(`runner download failed (exit ${r.exitCode}): ${tail(r)}`);
    },
  };
}
