// Env recipes: the contract and the one generic runner (plan.md P1, "Service catalog").
//
// A recipe is a directory `packages/envs/recipes/<name>/` holding
//   - recipe.json      name, pinned version, deps, supported arches, exported env, pinned downloads
//   - install.sh       idempotent install; runs as the exec user (root on docker-local; scripts
//                      go through `as_root` from _lib.sh, which uses sudo when not root)
//   - healthcheck.sh   exits 0 only when the recipe works; it is the recipe's correctness gate
//
// The runner works on any ComputeProvider through exec and putFile only. Scripts are written
// under the computer's home (putFile is confined there; Naïve: /home/naive) and run with bash.
// System installs happen inside the scripts through exec, never through putFile.
//
// Per recipe the runner emits `computer.recipe` AnybenchEvents (started, installed, healthy,
// skipped, failed). Without `reinstall`, a recipe whose health check already passes is
// `skipped` (useful on a snapshot fork). The first failure stops the run with RecipeRunError.
//
// Nothing a recipe touches is secret: commands carry only recipe metadata, never credentials.
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AnybenchEventSchema,
  KitEnvVarNameSchema,
  KitSlugSchema,
  type AnybenchEvent,
  type AnybenchEventOf,
  type EventActor,
} from "@anybench/core";
import { shellQuote, type ComputeProvider, type ExecResult } from "@anybench/providers";
import { z } from "zod";

/** The recipes shipped with this package (`packages/envs/recipes`). */
export const BASE_RECIPES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "recipes");

/** The six base recipes every `base` profile carries (plan.md P1 profile table). */
export const BASE_RECIPES = [
  "node22",
  "python312-uv",
  "git-time",
  "hyperfine",
  "hey",
  "k6",
] as const;

/** Shared shell helpers, sourced by every script as `. "$RECIPE_LIB"`. */
export const RECIPE_LIB_FILE = "_lib.sh";

export const RecipeArchSchema = z.enum(["x64", "arm64"]);
export type RecipeArch = z.infer<typeof RecipeArchSchema>;

/** Map `uname -m` to a recipe arch; null for anything unsupported. */
export function archFromUname(machine: string): RecipeArch | null {
  switch (machine.trim()) {
    case "x86_64":
    case "amd64":
      return "x64";
    case "aarch64":
    case "arm64":
      return "arm64";
    default:
      return null;
  }
}

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "sha256 must be 64 lowercase hex chars");

export const RecipeDownloadSchema = z.strictObject({
  url: z.url({ protocol: /^https$/ }),
  sha256: Sha256Schema,
  /**
   * Where the pinned sha256 came from: `upstream` = a checksum file the project publishes
   * (SHASUMS256.txt, *.sha256, checksums.txt); `github-asset-digest` = the digest GitHub reports
   * for the release asset, when the project publishes none.
   */
  checksumSource: z.enum(["upstream", "github-asset-digest"]),
});
export type RecipeDownload = z.infer<typeof RecipeDownloadSchema>;

const AbsPathSchema = z
  .string()
  .regex(/^\/[A-Za-z0-9._/+-]*$/, "must be an absolute path of [A-Za-z0-9._/+-]");

/** recipe.json */
export const RecipeManifestSchema = z
  .strictObject({
    name: KitSlugSchema,
    /** Pinned version of what the recipe installs; part of the snapshot cache key. */
    version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/, {
      error: "version must be [A-Za-z0-9.+_-], at most 64 chars",
    }),
    description: z.string().min(1).max(500),
    /** Recipes that must be installed (and healthy) first. */
    deps: z.array(KitSlugSchema).default([]),
    arch: z.array(RecipeArchSchema).min(1),
    /** Env exported to later recipes and to the trial. Values are not secrets. */
    env: z.record(KitEnvVarNameSchema, z.string().max(4096)).default({}),
    /** Directories to put in front of PATH (PATH itself is not allowed in `env`). */
    path: z.array(AbsPathSchema).default([]),
    /** Pinned download per arch, handed to install.sh as RECIPE_URL / RECIPE_SHA256. */
    downloads: z.partialRecord(RecipeArchSchema, RecipeDownloadSchema).default({}),
    timeouts: z
      .strictObject({
        installMs: z.int().positive().optional(),
        healthcheckMs: z.int().positive().optional(),
      })
      .default({}),
  })
  .superRefine((m, ctx) => {
    if ("PATH" in m.env) {
      ctx.addIssue({ code: "custom", path: ["env", "PATH"], message: "use `path` to extend PATH" });
    }
    for (const k of Object.keys(m.env)) {
      if (k.startsWith("RECIPE_")) {
        ctx.addIssue({ code: "custom", path: ["env", k], message: "RECIPE_* is reserved" });
      }
    }
    if (m.deps.includes(m.name)) {
      ctx.addIssue({ code: "custom", path: ["deps"], message: "a recipe cannot depend on itself" });
    }
    const dl = Object.keys(m.downloads);
    if (dl.length > 0) {
      for (const a of m.arch) {
        if (!dl.includes(a)) {
          ctx.addIssue({
            code: "custom",
            path: ["downloads", a],
            message: `arch '${a}' is supported but has no pinned download`,
          });
        }
      }
    }
  });
export type RecipeManifest = z.output<typeof RecipeManifestSchema>;
export type RecipeManifestInput = z.input<typeof RecipeManifestSchema>;

export interface Recipe {
  manifest: RecipeManifest;
  install: string;
  healthcheck: string;
  /** Source directory, when loaded from disk. */
  dir?: string;
}

/** Recipes by name, plus the shared shell library. */
export interface RecipeCatalog {
  recipes: ReadonlyMap<string, Recipe>;
  lib: string;
}

export class RecipeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecipeError";
  }
}

export interface RecipeResult {
  name: string;
  version: string;
  status: "installed" | "skipped" | "failed";
  installMs: number | null;
  healthcheckMs: number | null;
  failedStep?: "arch" | "install" | "healthcheck";
  exitCode?: number;
  /** Tail of the failing step's output. */
  output?: string;
}

export interface RecipeRunResult {
  arch: RecipeArch;
  results: RecipeResult[];
  /** Merged exported env of every recipe, in install order (later wins). */
  env: Record<string, string>;
  /** PATH prefix, first entry first. */
  path: string[];
}

export class RecipeRunError extends RecipeError {
  readonly recipe: string;
  readonly results: RecipeResult[];
  constructor(message: string, recipe: string, results: RecipeResult[]) {
    super(message);
    this.name = "RecipeRunError";
    this.recipe = recipe;
    this.results = results;
  }
}

// ---------- loading ----------

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

/** Parse a recipe.json value; throws RecipeError with `path: message` issues. */
export function parseRecipeManifest(raw: unknown, where = "recipe.json"): RecipeManifest {
  const r = RecipeManifestSchema.safeParse(raw);
  if (!r.success) {
    const issues = r.error.issues
      .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
      .join("; ");
    throw new RecipeError(`${where}: ${issues}`);
  }
  return r.data;
}

/** Load one recipe directory. The directory name must equal `name`. */
export async function loadRecipe(dir: string): Promise<Recipe> {
  const where = join(dir, "recipe.json");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(where, "utf8"));
  } catch (e) {
    throw new RecipeError(`${where}: ${(e as Error).message}`);
  }
  const manifest = parseRecipeManifest(raw, where);
  const base = dir.replace(/\/+$/, "").split("/").pop();
  if (base !== manifest.name) {
    throw new RecipeError(`${where}: name '${manifest.name}' does not match directory '${base}'`);
  }
  const [install, healthcheck] = await Promise.all(
    ["install.sh", "healthcheck.sh"].map(async (f) => {
      const p = join(dir, f);
      if (!(await exists(p))) throw new RecipeError(`${manifest.name}: missing ${f}`);
      return readFile(p, "utf8");
    }),
  );
  return { manifest, install: install!, healthcheck: healthcheck!, dir };
}

/** Load every recipe under `root` (default: this package's recipes) and the shared lib. */
export async function loadRecipeCatalog(root: string = BASE_RECIPES_DIR): Promise<RecipeCatalog> {
  const entries = await readdir(root, { withFileTypes: true });
  const recipes = new Map<string, Recipe>();
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory() || e.name.startsWith("_") || e.name.startsWith(".")) continue;
    const r = await loadRecipe(join(root, e.name));
    recipes.set(r.manifest.name, r);
  }
  const libPath = join(root, RECIPE_LIB_FILE);
  const lib = (await exists(libPath)) ? await readFile(libPath, "utf8") : "";
  validateCatalog({ recipes, lib });
  return { recipes, lib };
}

/** Every dep names a recipe in the catalog and there are no cycles. Throws RecipeError. */
export function validateCatalog(catalog: RecipeCatalog): void {
  resolveRecipeOrder(catalog, [...catalog.recipes.keys()]);
}

/**
 * The install order for `requested` plus their transitive deps: deps before dependents,
 * otherwise in request order, each recipe once. Throws RecipeError on an unknown recipe or a cycle.
 */
export function resolveRecipeOrder(catalog: RecipeCatalog, requested: readonly string[]): Recipe[] {
  const out: Recipe[] = [];
  const done = new Set<string>();
  const visiting: string[] = [];
  const visit = (name: string, from: string | null) => {
    if (done.has(name)) return;
    const cyc = visiting.indexOf(name);
    if (cyc >= 0) {
      throw new RecipeError(
        `recipe dependency cycle: ${[...visiting.slice(cyc), name].join(" -> ")}`,
      );
    }
    const r = catalog.recipes.get(name);
    if (!r) {
      throw new RecipeError(
        from ? `recipe '${from}' depends on unknown recipe '${name}'` : `unknown recipe '${name}'`,
      );
    }
    visiting.push(name);
    for (const d of r.manifest.deps) visit(d, name);
    visiting.pop();
    done.add(name);
    out.push(r);
  };
  for (const n of requested) visit(n, null);
  return out;
}

// ---------- running ----------

export interface RunRecipesOptions {
  /** Default: loadRecipeCatalog() of this package's recipes. */
  catalog?: RecipeCatalog;
  /** Receives each validated `computer.recipe` event, in order. */
  onEvent?: (event: AnybenchEvent) => void | Promise<void>;
  runId?: string | null;
  actor?: EventActor;
  /** seq of the first event; later events count up from it. Default 0. */
  seqStart?: number;
  /** Install even when the health check already passes. Default false. */
  reinstall?: boolean;
  /** Where scripts are written on the computer. Default `<home>/.anybench/recipes`. */
  workDir?: string;
  /** Clock, for tests. */
  now?: () => Date;
}

const DEFAULT_INSTALL_TIMEOUT_MS = 600_000;
const DEFAULT_HEALTHCHECK_TIMEOUT_MS = 120_000;
const OUTPUT_TAIL_CHARS = 4_000;

function tail(r: ExecResult): string {
  const s = [r.stdout.trimEnd(), r.stderr.trimEnd()].filter(Boolean).join("\n");
  return s.length > OUTPUT_TAIL_CHARS ? `…${s.slice(-OUTPUT_TAIL_CHARS)}` : s;
}

/** `export K='v'` lines for a run's env and PATH, for an env file a trial sources. */
export function renderRecipeEnv(result: Pick<RecipeRunResult, "env" | "path">): string {
  const lines = Object.entries(result.env).map(([k, v]) => `export ${k}=${shellQuote(v)}`);
  if (result.path.length) lines.push(`export PATH=${shellQuote(result.path.join(":"))}:"$PATH"`);
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/**
 * Install `requested` recipes (and their deps) on a running computer, in dependency order,
 * and health-check each. Returns the exported env; throws RecipeRunError on the first failure
 * (after emitting its `failed` event), or RecipeError for a bad request.
 */
export async function runRecipes(
  provider: ComputeProvider,
  computerId: string,
  requested: readonly string[],
  opts: RunRecipesOptions = {},
): Promise<RecipeRunResult> {
  const catalog = opts.catalog ?? (await loadRecipeCatalog());
  const order = resolveRecipeOrder(catalog, requested);
  const now = opts.now ?? (() => new Date());
  let seq = opts.seqStart ?? 0;
  const actor: EventActor = opts.actor ?? { kind: "system" };

  const emit = async (
    payload: AnybenchEventOf<"computer.recipe">["payload"],
    severity: "info" | "error" = "info",
  ) => {
    const event = AnybenchEventSchema.parse({
      run_id: opts.runId ?? null,
      seq: seq++,
      source: "computer",
      source_id: computerId,
      type: "computer.recipe",
      severity,
      actor,
      at: now().toISOString(),
      payload,
    });
    await opts.onEvent?.(event);
  };

  const info = await provider.inspect(computerId);
  const workDir = opts.workDir ?? posix.join(info.home, ".anybench", "recipes");
  const maxExec = provider.capabilities.maxExecTimeoutMs;

  const uname = await provider.exec(computerId, "uname -m", {
    timeoutMs: Math.min(30_000, maxExec),
  });
  const arch = uname.exitCode === 0 ? archFromUname(uname.stdout) : null;
  if (!arch) {
    throw new RecipeError(`unsupported machine '${uname.stdout.trim() || tail(uname)}'`);
  }

  const libPath = posix.join(workDir, RECIPE_LIB_FILE);
  await provider.putFile(computerId, libPath, catalog.lib, { mode: 0o644 });

  const results: RecipeResult[] = [];
  const env: Record<string, string> = {};
  const path: string[] = [];

  for (const recipe of order) {
    const m = recipe.manifest;
    const base = { recipe: m.name, version: m.version, arch };
    const fail = async (
      step: "arch" | "install" | "healthcheck",
      message: string,
      r?: ExecResult,
      ms: { installMs: number | null; healthcheckMs: number | null } = {
        installMs: null,
        healthcheckMs: null,
      },
    ): Promise<never> => {
      const output = r ? tail(r) : undefined;
      results.push({
        name: m.name,
        version: m.version,
        status: "failed",
        ...ms,
        failedStep: step,
        ...(r ? { exitCode: r.exitCode } : {}),
        ...(output ? { output } : {}),
      });
      await emit(
        {
          ...base,
          phase: "failed",
          ...(step === "arch" ? {} : { step }),
          ...(r ? { exit_code: r.exitCode, duration_ms: r.durationMs } : {}),
          error: (output ? `${message}\n${output}` : message).slice(-OUTPUT_TAIL_CHARS),
        },
        "error",
      );
      throw new RecipeRunError(
        `${m.name}@${m.version}: ${message}${output ? `\n${output}` : ""}`,
        m.name,
        results,
      );
    };

    if (!m.arch.includes(arch)) {
      await fail("arch", `does not support ${arch} (supports ${m.arch.join(", ")})`);
    }

    const dir = posix.join(workDir, `${m.name}@${m.version}`);
    await provider.putFile(computerId, posix.join(dir, "install.sh"), recipe.install, {
      mode: 0o755,
    });
    await provider.putFile(computerId, posix.join(dir, "healthcheck.sh"), recipe.healthcheck, {
      mode: 0o755,
    });

    const dl = m.downloads[arch];
    const vars: Record<string, string> = {
      ...env,
      ...m.env,
      RECIPE_NAME: m.name,
      RECIPE_VERSION: m.version,
      RECIPE_ARCH: arch,
      RECIPE_DIR: dir,
      RECIPE_LIB: libPath,
      ...(dl ? { RECIPE_URL: dl.url, RECIPE_SHA256: dl.sha256 } : {}),
    };
    const paths = [...m.path, ...path];
    const prefix = [
      `cd ${shellQuote(dir)} &&`,
      ...(paths.length ? [`PATH=${shellQuote(paths.join(":"))}:"$PATH"`] : []),
      ...Object.entries(vars).map(([k, v]) => `${k}=${shellQuote(v)}`),
    ].join(" ");
    const script = (f: string) => `${prefix} bash ./${f}`;
    const installMs = Math.min(m.timeouts.installMs ?? DEFAULT_INSTALL_TIMEOUT_MS, maxExec);
    const healthMs = Math.min(m.timeouts.healthcheckMs ?? DEFAULT_HEALTHCHECK_TIMEOUT_MS, maxExec);

    const accept = () => {
      Object.assign(env, m.env);
      for (const p of m.path) if (!path.includes(p)) path.push(p);
    };

    if (!opts.reinstall) {
      const pre = await provider.exec(computerId, script("healthcheck.sh"), {
        timeoutMs: healthMs,
      });
      if (pre.exitCode === 0) {
        accept();
        results.push({
          name: m.name,
          version: m.version,
          status: "skipped",
          installMs: null,
          healthcheckMs: pre.durationMs,
        });
        await emit({ ...base, phase: "skipped", step: "healthcheck", duration_ms: pre.durationMs });
        continue;
      }
    }

    await emit({ ...base, phase: "started", step: "install" });
    const ins = await provider.exec(computerId, script("install.sh"), { timeoutMs: installMs });
    if (ins.exitCode !== 0) {
      await fail(
        "install",
        ins.timedOut ? `install timed out after ${installMs} ms` : `install exited ${ins.exitCode}`,
        ins,
        { installMs: ins.durationMs, healthcheckMs: null },
      );
    }
    await emit({
      ...base,
      phase: "installed",
      step: "install",
      duration_ms: ins.durationMs,
      exit_code: 0,
    });

    const hc = await provider.exec(computerId, script("healthcheck.sh"), { timeoutMs: healthMs });
    if (hc.exitCode !== 0) {
      await fail(
        "healthcheck",
        hc.timedOut
          ? `health check timed out after ${healthMs} ms`
          : `health check exited ${hc.exitCode}`,
        hc,
        { installMs: ins.durationMs, healthcheckMs: hc.durationMs },
      );
    }
    accept();
    results.push({
      name: m.name,
      version: m.version,
      status: "installed",
      installMs: ins.durationMs,
      healthcheckMs: hc.durationMs,
    });
    await emit({
      ...base,
      phase: "healthy",
      step: "healthcheck",
      duration_ms: hc.durationMs,
      exit_code: 0,
    });
  }

  return { arch, results, env, path };
}
