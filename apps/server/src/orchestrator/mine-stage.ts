// TDM-60 [6.6] v1 scope (b): mine a coding-agent / harness repo's history inside kit_draft.
//
//   mineForRun(ctx, digest, opts)
//     1. a clone with history at the digest's ref (cached per repo under ~/.anybench/clones,
//        fetched again on reuse);
//     2. the mine result cached by repo + resolved commit + MINER_VERSION
//        (~/.anybench/mine/<hash>.json): a crashed or retried stage never mines twice;
//     3. otherwise ONE mining computer from the run's provider for the whole mine: tagged
//        `ab-infra-mine-…` (our infra cost, never billed to the user's trials), the base tools +
//        the repo's language toolchain recipes installed, mineRepoTasks with a time cap and a
//        verify cap, destroyed in `finally` with the env build's 429-retrying destroy;
//     4. fewer than `minTasks` verified tasks → needs_human with the counts and drop reasons.
//   Progress goes out as agent.message events through `say`.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ProjectDigest } from "@anybench/core";
import { destroyBuildComputer, INFRA_COMPUTER_TAG_PREFIX, runRecipes } from "@anybench/envs";
import {
  MinedTaskSchema,
  MineReportSchema,
  mineRepoTasks,
  type MinedTask,
  type MineReport,
} from "@anybench/kit";
import type { ComputeProvider } from "@anybench/providers";
import { z } from "zod";
import type { StageContext } from "./ports.js";

const pexec = promisify(execFile);

/** Bump when the miner's selection/verification changes, so cached mines are redone. */
export const MINER_VERSION = "tdm186-v1+tdm60-1";
export const MINE_TIME_CAP_MS = 25 * 60_000;
export const MINE_MAX_VERIFY = 40;
export const MINE_TARGET_TASKS = 30;
export const MINE_MIN_TASKS = 3;

export interface MineStageOptions {
  /** The run's provider (Naïve in production). Null: agent repos hold. */
  provider: ComputeProvider | null;
  /** Mine result cache. Default ~/.anybench/mine. */
  cacheDir?: string;
  /** Clones with history. Default ~/.anybench/clones. */
  clonesDir?: string;
  githubToken?: string;
  timeCapMs?: number;
  maxVerify?: number;
  targetTasks?: number;
  minTasks?: number;
  modelCutoff?: string;
  computer?: { vcpu: number; memoryMb: number; diskGb?: number };
  /** Recipes on the mining computer. Default: git-time + the digest languages' toolchains. */
  recipes?: (digest: ProjectDigest) => string[];
  /** Get a clone at `ref` into `dir` (tests: a local fixture). Default: git clone + checkout. */
  clone?: (url: string, ref: string | undefined, dir: string) => Promise<void>;
}

export type MineForRun =
  | {
      ok: true;
      repoDir: string;
      commit: string;
      tasks: MinedTask[];
      report: MineReport;
      cached: boolean;
    }
  | { ok: false; reason: string };

const LANGUAGE_RECIPES: Readonly<Record<string, string>> = {
  Go: "go",
  TypeScript: "node22",
  JavaScript: "node22",
  Python: "python312-uv",
};

/** git-time + one toolchain recipe per language the digest saw (≥ 1% of the bytes). */
export function miningRecipes(digest: ProjectDigest): string[] {
  const total = digest.languages.reduce((n, l) => n + l.bytes, 0) || 1;
  const out = ["git-time"];
  for (const l of digest.languages) {
    const r = LANGUAGE_RECIPES[l.name];
    if (r && l.bytes / total >= 0.01 && !out.includes(r)) out.push(r);
  }
  return out;
}

const CachedMineSchema = z.object({
  miner: z.string(),
  repo: z.string(),
  commit: z.string(),
  report: MineReportSchema,
  tasks: z.array(MinedTaskSchema),
});

function root(sub: string, override?: string): string {
  return override ? path.resolve(override) : path.join(homedir(), ".anybench", sub);
}

async function defaultClone(url: string, ref: string | undefined, dir: string, token?: string) {
  const auth = token ? ["-c", `http.extraHeader=Authorization: Bearer ${token}`] : [];
  if (!existsSync(path.join(dir, ".git"))) {
    await mkdir(path.dirname(dir), { recursive: true });
    await pexec("git", [...auth, "clone", "--quiet", "--no-tags", url, dir], {
      maxBuffer: 1 << 24,
    });
  } else {
    await pexec("git", [...auth, "-C", dir, "fetch", "--quiet", "--no-tags", "origin"], {
      maxBuffer: 1 << 24,
    });
  }
  if (ref) {
    await pexec("git", [...auth, "-C", dir, "fetch", "--quiet", "origin", ref]).catch(
      () => undefined,
    );
    await pexec("git", ["-C", dir, "checkout", "--quiet", "--force", "--detach", ref]).catch(
      async () => {
        await pexec("git", ["-C", dir, "checkout", "--quiet", "--force", "--detach", "FETCH_HEAD"]);
      },
    );
  }
}

export async function mineForRun(
  ctx: StageContext,
  digest: ProjectDigest,
  opts: MineStageOptions,
  say: (text: string) => Promise<void>,
): Promise<MineForRun> {
  if (digest.source.kind !== "github" || !digest.source.url) {
    return { ok: false, reason: "mining needs a GitHub repo with its history" };
  }
  const url = digest.source.url;
  const slug = url
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "__");
  const repoDir = path.join(root("clones", opts.clonesDir), slug);
  await (opts.clone
    ? opts.clone(url, digest.source.ref, repoDir)
    : defaultClone(url, digest.source.ref, repoDir, opts.githubToken));
  const commit = (await pexec("git", ["-C", repoDir, "rev-parse", "HEAD"])).stdout.trim();

  const key = createHash("sha256").update(`${url}\0${commit}\0${MINER_VERSION}`).digest("hex");
  const cacheFile = path.join(root("mine", opts.cacheDir), `${key}.json`);
  if (existsSync(cacheFile)) {
    const hit = CachedMineSchema.safeParse(JSON.parse(await readFile(cacheFile, "utf8")));
    if (hit.success) {
      await say(
        `mined tasks reused from the cache (${hit.data.tasks.length} verified at ${commit.slice(0, 7)})`,
      );
      return gate(
        { ok: true, repoDir, commit, tasks: hit.data.tasks, report: hit.data.report, cached: true },
        opts,
      );
    }
  }

  if (!opts.provider)
    return { ok: false, reason: "mining needs a compute provider, and none is configured" };
  const p = opts.provider;
  const recipes = (opts.recipes ?? miningRecipes)(digest);
  await say(
    `mining ${url} at ${commit.slice(0, 7)}: one mining computer (${recipes.join(", ") || "no recipes"}), at most ${opts.maxVerify ?? MINE_MAX_VERIFY} candidates, ${Math.round((opts.timeCapMs ?? MINE_TIME_CAP_MS) / 60_000)} min cap`,
  );
  const spec = opts.computer ?? { vcpu: 4, memoryMb: 8192, diskGb: 20 };
  const c = await p.create({
    ...spec,
    tags: [`${INFRA_COMPUTER_TAG_PREFIX}mine-${ctx.run.id.slice(0, 8)}`],
  });
  let result: Awaited<ReturnType<typeof mineRepoTasks>>;
  try {
    const ready = await p.waitReady(c.id, { timeoutMs: 600_000, intervalMs: 2_000 });
    if (recipes.length > 0) await runRecipes(p, ready.id, recipes, { runId: ctx.run.id });
    let lines = 0;
    result = await mineRepoTasks(repoDir, {
      provider: p,
      computerId: ready.id,
      repoUrl: url,
      targetTasks: opts.targetTasks ?? MINE_TARGET_TASKS,
      maxVerify: opts.maxVerify ?? MINE_MAX_VERIFY,
      deadline: Date.now() + (opts.timeCapMs ?? MINE_TIME_CAP_MS),
      signal: ctx.signal,
      ...(opts.modelCutoff ? { modelCutoff: opts.modelCutoff } : {}),
      log: (l) => {
        if (/^verifying /.test(l) && lines++ % 5 === 0) void say(`mining: ${l}`);
      },
    });
  } finally {
    await destroyBuildComputer(p, c.id, {}, () => undefined);
  }
  await mkdir(path.dirname(cacheFile), { recursive: true });
  await writeFile(
    cacheFile,
    JSON.stringify(
      { miner: MINER_VERSION, repo: url, commit, report: result.report, tasks: result.tasks },
      null,
      2,
    ),
  );
  await say(
    `mined ${result.report.verified} task(s) from ${result.report.candidates} candidate(s) over ${result.report.commits_scanned} commits`,
  );
  return gate(
    { ok: true, repoDir, commit, tasks: result.tasks, report: result.report, cached: false },
    opts,
  );
}

function gate(r: Extract<MineForRun, { ok: true }>, opts: MineStageOptions): MineForRun {
  const min = opts.minTasks ?? MINE_MIN_TASKS;
  if (r.tasks.length >= min) return r;
  const drops = Object.entries(r.report.drop_counts)
    .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
    .slice(0, 6)
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
  return {
    ok: false,
    reason: `only ${r.tasks.length} task(s) verified from the history (need ${min}): ${r.report.candidates} candidate(s) over ${r.report.commits_scanned} commits; drops: ${drops || "none"}`,
  };
}

/** Copy a local fixture repo as the clone (tests). */
export function localClone(src: string) {
  return async (_url: string, _ref: string | undefined, dir: string): Promise<void> => {
    await rm(dir, { recursive: true, force: true });
    await cp(src, dir, { recursive: true });
  };
}
