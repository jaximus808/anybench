// TDM-186 [16.15]: the whole miner: select → verify (on one computer) → held-out → report, and
// optionally materialize into a kit dir. The kit designer (TDM-60) calls this, then writes issue
// text from each task's `symptoms` and screens it.
import { randomBytes } from "node:crypto";
import type { ComputeProvider, ComputerSpecInput } from "@anybench/providers";
import { assignHeldOut } from "./group.js";
import { repoTop } from "./git.js";
import {
  materializeMinedTask,
  writeMineReport,
  type MaterializeMinedTaskOptions,
} from "./materialize.js";
import {
  MineReportSchema,
  type MineCandidate,
  type MineDrop,
  type MineDropCode,
  type MinedTask,
  type MineReport,
} from "./schema.js";
import { selectMineCandidates, type SelectMineCandidatesOptions } from "./select.js";
import { verifyMineCandidate, type VerifyMineCandidateOptions } from "./verify.js";

export interface MineRepoTasksOptions
  extends SelectMineCandidatesOptions, Omit<VerifyMineCandidateOptions, "computerId"> {
  /** Use this running computer (the caller owns it). Otherwise one is created and destroyed. */
  computerId?: string;
  /** Spec for the computer created when `computerId` is not given. */
  computer?: ComputerSpecInput;
  /** Stop once this many tasks verified. Default 30. */
  targetTasks?: number;
  /** Verify at most this many candidates (newest first). Default 60. */
  maxVerify?: number;
  /** Fraction held out (when at least 3 tasks). Default 1/3. */
  heldOutFraction?: number;
  /** Write the tasks and mined/report.json here. */
  kitDir?: string;
  materialize?: MaterializeMinedTaskOptions;
}

export interface MineRepoTasksResult {
  report: MineReport;
  tasks: MinedTask[];
  candidates: MineCandidate[];
  drops: MineDrop[];
}

/** Drops listed one by one in the report (the rest only counted). */
const LISTED_SELECT_DROPS: ReadonlySet<MineDropCode> = new Set<MineDropCode>([
  "merge",
  "docs_only",
  "lockfile_only",
  "vendored_only",
  "tests_only",
  "no_source_change",
  "deletes_or_renames",
  "binary_change",
  "too_large",
]);
const MAX_LISTED_DROPS = 500;

export async function mineRepoTasks(
  repoDir: string,
  opts: MineRepoTasksOptions,
): Promise<MineRepoTasksResult> {
  const repo = await repoTop(repoDir);
  const sel = await selectMineCandidates(repo, opts);
  const drops: MineDrop[] = [...sel.dropped];
  const target = opts.targetTasks ?? 30;
  const maxVerify = opts.maxVerify ?? 60;
  const say = opts.log ?? (() => {});
  const p: ComputeProvider = opts.provider;

  let computerId = opts.computerId;
  let created = false;
  const verified: MinedTask[] = [];
  const createComputer = async (): Promise<string> => {
    const tag = `ab-mine-${randomBytes(4).toString("hex")}`;
    const spec = { ...opts.computer, tags: [...(opts.computer?.tags ?? []), tag] };
    const c = await p.create(spec);
    created = true;
    computerId = c.id;
    await p.waitReady(c.id);
    return c.id;
  };
  /** A computer we own that vanished or died mid-run (reaped, OOM-killed) is replaced. */
  const lost = async (id: string): Promise<boolean> => {
    try {
      const s = (await p.inspect(id)).status;
      return s === "failed" || s === "destroyed";
    } catch {
      return true;
    }
  };
  try {
    if (sel.candidates.length > 0 && !computerId) await createComputer();
    let tried = 0;
    for (const cand of sel.candidates) {
      if (verified.length >= target || tried >= maxVerify) {
        drops.push({
          sha: cand.sha,
          stage: "verify",
          code: "over_limit",
          detail:
            verified.length >= target
              ? `target of ${target} tasks reached`
              : `maxVerify ${maxVerify} reached`,
        });
        continue;
      }
      tried++;
      say(
        `verifying ${cand.sha.slice(0, 8)} (${tried}/${Math.min(maxVerify, sel.candidates.length)})`,
      );
      let r = await verifyMineCandidate(repo, cand, { ...opts, computerId: computerId as string });
      if (!r.ok && created && (await lost(computerId as string))) {
        say(`  computer ${String(computerId).slice(0, 12)} was lost; retrying on a new one`);
        await p.destroy(computerId as string).catch(() => {});
        await createComputer();
        r = await verifyMineCandidate(repo, cand, { ...opts, computerId: computerId as string });
      }
      if (r.ok) verified.push(r.task);
      else {
        drops.push(r.drop);
        say(`  dropped: ${r.drop.code}: ${r.drop.detail.slice(0, 200)}`);
      }
    }
  } finally {
    if (created && computerId) await p.destroy(computerId).catch(() => {});
  }

  const tasks = assignHeldOut(verified, {
    ...(opts.heldOutFraction !== undefined ? { fraction: opts.heldOutFraction } : {}),
  });
  const counts: Partial<Record<MineDropCode, number>> = {};
  for (const d of drops) counts[d.code] = (counts[d.code] ?? 0) + 1;
  const report = MineReportSchema.parse({
    record: "anybench.mine-report/v1",
    ...(opts.repoUrl ? { repo: opts.repoUrl } : {}),
    head: sel.head,
    commits_scanned: sel.commits_scanned,
    candidates: sel.candidates.length,
    verified: tasks.length,
    held_out: tasks.filter((t) => t.held_out).length,
    task_ids: tasks.map((t) => t.id),
    drop_counts: counts,
    dropped: drops
      .filter((d) => d.stage === "verify" || LISTED_SELECT_DROPS.has(d.code))
      .slice(0, MAX_LISTED_DROPS),
  });
  if (opts.kitDir) {
    for (const t of tasks) await materializeMinedTask(repo, t, opts.kitDir, opts.materialize);
    await writeMineReport(opts.kitDir, report);
  }
  return { report, tasks, candidates: sel.candidates, drops };
}
