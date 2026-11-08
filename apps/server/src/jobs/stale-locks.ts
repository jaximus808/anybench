// Stale graphile-worker locks (worker-hardening). A worker process that is killed leaves the jobs it
// was running (trial.execute, trial.gate, ...) locked by its graphile worker ids, and graphile only
// frees a lock after 4 h. So on start, and every minute after, we find the locks no live process
// holds and call graphile_worker.force_unlock_workers(ids). The jobs then run again: a
// trial.execute re-attaches to the trial's computer and its detached runner through the existing
// lease logic (lease_owner is dead once its worker's heartbeat is), never a second runner.
//
// Live vs dead comes from worker_heartbeats: every process records the graphile worker ids it runs
// (graphile_worker_ids). A heartbeat row is dead when
//   - it has not ticked for WORKER_MAX_TICK_AGE_MS, or
//   - it is this process's own worker id from an earlier start (WORKER_ID reused after a restart), or
//   - it is on this host and its pid is not running (a restart on the same machine).
// A lock is released when its worker id is claimed only by dead rows, or by no row at all and the
// lock is older than STALE_LOCK_MIN_AGE_MS (2 min). The unclaimed case is skipped while any live
// process is from before this change (no graphile_worker_ids), since its ids are unknown.
// Dead rows on this host get last_tick_at = epoch, so their trial leases are takeable at once.
import { hostname } from "node:os";
import { sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { WORKER_MAX_TICK_AGE_MS } from "../lib/worker-health.js";

/** A lock no live process claims must be at least this old before we take it. */
export const STALE_LOCK_MIN_AGE_MS = 120_000;
/** How often the running worker sweeps (a dead process on another host). */
export const STALE_LOCK_SWEEP_INTERVAL_MS = 60_000;

export interface StaleLockSweepOptions {
  /** This process's worker_heartbeats id. */
  workerId: string;
  /** This process's start time (its heartbeat row's started_at). */
  workerStartedAt: Date;
  /** This process's graphile worker ids (never unlocked). */
  ownGraphileIds: readonly string[];
  host?: string;
  pid?: number;
  maxTickAgeMs?: number;
  minLockAgeMs?: number;
  /** Is `pid` running on this host? Default: process.kill(pid, 0). */
  pidAlive?: (pid: number) => boolean;
}

export interface StaleLockSweepResult {
  /** graphile worker ids whose locks were released. */
  unlocked: string[];
  /** Jobs those ids held. */
  jobs: { id: string; task: string; lockedBy: string }[];
  /** Heartbeat rows found dead. */
  deadWorkers: string[];
  /** Unclaimed locks left alone because a pre-change process is alive. */
  skippedUnknown: string[];
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but is not ours to signal.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

type Rows<T> = { rows: T[] };

function textArray(values: readonly string[]) {
  return sql`array[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;
}

async function hasGraphileSchema(db: Database): Promise<boolean> {
  const r = (await db.execute(
    sql`select to_regclass('graphile_worker._private_jobs') is not null as ok`,
  )) as unknown as Rows<{ ok: boolean }>;
  return r.rows[0]?.ok === true;
}

/** One sweep. Safe to run concurrently from several processes (force_unlock is idempotent). */
export async function unlockStaleGraphileJobs(
  db: Database,
  opts: StaleLockSweepOptions,
): Promise<StaleLockSweepResult> {
  const result: StaleLockSweepResult = {
    unlocked: [],
    jobs: [],
    deadWorkers: [],
    skippedUnknown: [],
  };
  if (!(await hasGraphileSchema(db))) return result;
  const host = opts.host ?? hostname();
  const pid = opts.pid ?? process.pid;
  const maxTickAgeMs = opts.maxTickAgeMs ?? WORKER_MAX_TICK_AGE_MS;
  const minLockAgeMs = opts.minLockAgeMs ?? STALE_LOCK_MIN_AGE_MS;
  const pidAlive = opts.pidAlive ?? defaultPidAlive;
  const own = new Set(opts.ownGraphileIds);

  const hb = (await db.execute(sql`
    select worker_id, host, pid, started_at, graphile_worker_ids,
      last_tick_at > now() - (${maxTickAgeMs} * interval '1 millisecond') as fresh
    from worker_heartbeats`)) as unknown as Rows<{
    worker_id: string;
    host: string;
    pid: number;
    started_at: Date | string;
    graphile_worker_ids: string[] | null;
    fresh: boolean;
  }>;

  const liveIds = new Set<string>(own);
  const deadIds = new Set<string>();
  const deadOnHost: string[] = [];
  let unknownLive = false;
  const startedMs = opts.workerStartedAt.getTime();
  for (const r of hb.rows) {
    const rowStarted = new Date(r.started_at).getTime();
    const isUs = r.worker_id === opts.workerId && rowStarted === startedMs;
    const earlierUs = r.worker_id === opts.workerId && rowStarted !== startedMs;
    const deadHere = r.host === host && r.pid !== pid && !pidAlive(r.pid);
    const dead = !isUs && (!r.fresh || earlierUs || deadHere);
    if (dead) {
      result.deadWorkers.push(r.worker_id);
      for (const id of r.graphile_worker_ids ?? []) if (!own.has(id)) deadIds.add(id);
      if (r.fresh && (earlierUs || deadHere)) deadOnHost.push(r.worker_id);
    } else {
      if (!isUs && r.graphile_worker_ids === null) unknownLive = true;
      for (const id of r.graphile_worker_ids ?? []) liveIds.add(id);
    }
  }

  // Leases held by a dead process here are takeable right away (trial.reattach picks them up).
  // An earlier run of our own WORKER_ID is overwritten by our next heartbeat anyway.
  for (const w of deadOnHost) {
    if (w === opts.workerId) continue;
    await db.execute(
      sql`update worker_heartbeats set last_tick_at = to_timestamp(0) where worker_id = ${w}`,
    );
  }

  const locks = (await db.execute(sql`
    select locked_by, (locked_at < now() - (${minLockAgeMs} * interval '1 millisecond')) as old
    from (
      select locked_by, min(locked_at) as locked_at from graphile_worker._private_jobs
      where locked_by is not null group by locked_by
    ) l`)) as unknown as Rows<{ locked_by: string; old: boolean }>;

  const unlock: string[] = [];
  for (const l of locks.rows) {
    if (liveIds.has(l.locked_by)) continue;
    if (deadIds.has(l.locked_by)) unlock.push(l.locked_by);
    else if (!l.old) continue;
    else if (unknownLive) result.skippedUnknown.push(l.locked_by);
    else unlock.push(l.locked_by);
  }
  if (unlock.length === 0) return result;

  const jobs = (await db.execute(sql`
    select j.id::text as id, t.identifier as task, j.locked_by
    from graphile_worker._private_jobs j
    join graphile_worker._private_tasks t on t.id = j.task_id
    where j.locked_by = any(${textArray(unlock)})`)) as unknown as Rows<{
    id: string;
    task: string;
    locked_by: string;
  }>;
  await db.execute(sql`select graphile_worker.force_unlock_workers(${textArray(unlock)})`);
  result.unlocked = unlock;
  result.jobs = jobs.rows.map((j) => ({ id: j.id, task: j.task, lockedBy: j.locked_by }));
  return result;
}
