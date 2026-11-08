// The run orchestrator's Postgres side (TDM-54): the run.advance lease, guarded state transitions
// with their run.state_changed event, kill switches, trial expansion and the sweep query.
//
// Lease: `runs.advance_lease_owner = <worker id>~<worker started ms>~<nonce>`, `advance_lease_until`.
// Takeable when free, expired, or held by a worker whose worker_heartbeats row has not ticked as
// the same process within WORKER_MAX_TICK_AGE_MS (the trials lease rule, jobs/trial-execute.ts).
// Every orchestrator write checks the lease inside the same transaction, so a worker that lost
// its lease (presumed dead, then came back) can never move a run.
import {
  toJsonValue,
  transitionRun,
  type AnybenchEvent,
  type EventActor,
  type RunCommand,
  type RunId,
  type RunState,
} from "@anybench/core";
import { and, asc, eq, inArray, isNull, max, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { Database, DbTx } from "../db/client.js";
import { contenders } from "../db/schema/contenders.js";
import { events } from "../db/schema/events.js";
import { kits } from "../db/schema/kits.js";
import { projects } from "../db/schema/projects.js";
import { runs } from "../db/schema/runs.js";
import { trials } from "../db/schema/trials.js";
import { appendEvents } from "../lib/events.js";
import { RunStageOutputsShape } from "./ports.js";

export type RunRow = typeof runs.$inferSelect;
export type KitRow = typeof kits.$inferSelect;
export type TrialRow = typeof trials.$inferSelect;

/** SQL: the run.advance lease holder's worker ticked within maxTickAgeMs, as the same process. */
function holderAlive(maxTickAgeMs: number) {
  return sql`exists (
    select 1 from worker_heartbeats w
    where w.worker_id = split_part(${runs.advanceLeaseOwner}, '~', 1)
      and floor(extract(epoch from w.started_at) * 1000)::bigint::text = split_part(${runs.advanceLeaseOwner}, '~', 2)
      and w.last_tick_at > now() - (${maxTickAgeMs} * interval '1 millisecond'))`;
}

/** SQL: the run.advance lease may be taken (free, expired, or a dead holder). */
export function runLeaseFree(maxTickAgeMs: number) {
  return sql`(${runs.advanceLeaseOwner} is null or ${runs.advanceLeaseUntil} is null or ${runs.advanceLeaseUntil} <= now() or not ${holderAlive(maxTickAgeMs)})`;
}

export type CommitOutcome = "ok" | "moved" | "lease_lost" | "gone";

export interface CommitOptions {
  /** Extra writes in the same transaction (kit insert, contenders, report, digest). */
  writes?: (tx: DbTx, run: RunRow) => Promise<void>;
  /** Merged into runs.stage_outputs. */
  outputs?: Record<string, unknown>;
  /** Extra runs columns. */
  set?: PgUpdateSetSource<typeof runs>;
  /** run.state_changed payload.reason. */
  reason?: string;
}

export function stageOutputsOf(row: Pick<RunRow, "stageOutputs">): Record<string, unknown> {
  const v = row.stageOutputs;
  return v && typeof v === "object" && !Array.isArray(v)
    ? { ...(v as Record<string, unknown>) }
    : {};
}

export function stateChangedEvent(
  runId: string,
  actor: EventActor,
  from: RunState,
  to: RunState,
  command: RunCommand["type"],
  reason?: string,
): AnybenchEvent {
  return {
    run_id: runId,
    seq: 0,
    type: "run.state_changed",
    source: "run",
    source_id: runId,
    severity:
      to === "failed" ? "error" : to === "needs_human" || to === "paused_budget" ? "warn" : "info",
    actor,
    cost_delta_micro_usd: 0n,
    at: new Date().toISOString(),
    payload: { from, to, command, ...(reason ? { reason: reason.slice(0, 2000) } : {}) },
  };
}

export interface OrchestratorStore {
  get(runId: string): Promise<RunRow | null>;
  acquireLease(runId: string, owner: string, leaseMs: number): Promise<RunRow | null>;
  refreshLease(runId: string, owner: string, leaseMs: number): Promise<boolean>;
  releaseLease(runId: string, owner: string): Promise<void>;
  /**
   * Apply `command` to the run, only while `owner` holds the lease and the run is still in
   * `from`: state, stage outputs, extra columns, extra writes and the run.state_changed event in
   * one transaction.
   */
  commit(
    runId: string,
    owner: string,
    from: RunState,
    command: RunCommand,
    options?: CommitOptions,
  ): Promise<CommitOutcome>;
  /** Like commit without a state change (proof results, estimate, finalized_at). */
  save(
    runId: string,
    owner: string,
    expect: RunState,
    options: Omit<CommitOptions, "reason">,
  ): Promise<CommitOutcome>;
  /** Active kill switch (global | run | user) as `<scope>: <reason>`, or null. */
  killSwitch(run: RunRow): Promise<string | null>;
  /** How many times the run entered `state` (run.state_changed events with to = state). */
  visits(runId: string, state: RunState): Promise<number>;
  /** Proof repairs so far (run.state_changed with command repair), as kits.ts counts them. */
  repairs(runId: string): Promise<number>;
  kit(run: RunRow): Promise<KitRow | null>;
  digest(run: RunRow): Promise<unknown>;
  trials(runId: string): Promise<TrialRow[]>;
}

export function orchestratorStore(db: Database, opts: { maxTickAgeMs: number }): OrchestratorStore {
  const free = () => runLeaseFree(opts.maxTickAgeMs);

  async function guarded(
    runId: string,
    owner: string,
    expect: RunState,
    fn: (tx: DbTx, row: RunRow) => Promise<void>,
  ): Promise<CommitOutcome> {
    return db.transaction(async (tx) => {
      const [row] = await tx.select().from(runs).where(eq(runs.id, runId)).for("update").limit(1);
      if (!row) return "gone";
      if (row.advanceLeaseOwner !== owner) return "lease_lost";
      if (row.state !== expect) return "moved";
      await fn(tx, row);
      return "ok";
    });
  }

  return {
    async get(runId) {
      const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
      return row ?? null;
    },

    async acquireLease(runId, owner, leaseMs) {
      const [row] = await db
        .update(runs)
        .set({
          advanceLeaseOwner: owner,
          advanceLeaseUntil: sql`now() + (${leaseMs} * interval '1 millisecond')`,
        })
        .where(and(eq(runs.id, runId), sql`(${runs.advanceLeaseOwner} = ${owner} or ${free()})`))
        .returning();
      return row ?? null;
    },

    async refreshLease(runId, owner, leaseMs) {
      const r = await db
        .update(runs)
        .set({ advanceLeaseUntil: sql`now() + (${leaseMs} * interval '1 millisecond')` })
        .where(and(eq(runs.id, runId), eq(runs.advanceLeaseOwner, owner)))
        .returning({ id: runs.id });
      return r.length > 0;
    },

    async releaseLease(runId, owner) {
      await db
        .update(runs)
        .set({ advanceLeaseOwner: null, advanceLeaseUntil: null })
        .where(and(eq(runs.id, runId), eq(runs.advanceLeaseOwner, owner)));
    },

    async commit(runId, owner, from, command, options = {}) {
      // A mismatch here is a bug in the orchestrator, not a race: fail loudly before writing.
      const t = transitionRun(from, command);
      if (!t.ok) throw new Error(`orchestrator: ${t.error.message}`);
      return guarded(runId, owner, from, async (tx, row) => {
        await options.writes?.(tx, row);
        const outputs = { ...stageOutputsOf(row), ...options.outputs };
        RunStageOutputsShape.parse(outputs);
        await tx
          .update(runs)
          .set({
            ...options.set,
            state: t.to,
            stageOutputs: toJsonValue(outputs),
            updatedAt: sql`now()`,
          })
          .where(eq(runs.id, runId));
        await appendEvents(tx, runId as RunId, [
          stateChangedEvent(runId, actorOf(owner), t.from, t.to, command.type, options.reason),
        ]);
      });
    },

    async save(runId, owner, expect, options) {
      return guarded(runId, owner, expect, async (tx, row) => {
        await options.writes?.(tx, row);
        const outputs = { ...stageOutputsOf(row), ...options.outputs };
        RunStageOutputsShape.parse(outputs);
        await tx
          .update(runs)
          .set({ ...options.set, stageOutputs: toJsonValue(outputs), updatedAt: sql`now()` })
          .where(eq(runs.id, runId));
      });
    },

    async killSwitch(run) {
      const res = await db.execute(sql`
        select scope || ': ' || reason as kill from kill_switches
        where cleared_at is null
          and (scope = 'global'
            or (scope = 'run' and scope_id = ${run.id})
            or (scope = 'user' and scope_id = ${run.ownerId}))
        order by set_at limit 1`);
      const row = (res as unknown as { rows: { kill: string | null }[] }).rows[0];
      return row?.kill ?? null;
    },

    async visits(runId, state) {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(events)
        .where(
          and(
            eq(events.runId, runId),
            eq(events.type, "run.state_changed"),
            sql`${events.payload}->>'to' = ${state}`,
          ),
        );
      return row?.n ?? 0;
    },

    async repairs(runId) {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(events)
        .where(
          and(
            eq(events.runId, runId),
            eq(events.type, "run.state_changed"),
            sql`${events.payload}->>'command' = 'repair'`,
          ),
        );
      return row?.n ?? 0;
    },

    async kit(run) {
      if (!run.kitId) return null;
      const [k] = await db.select().from(kits).where(eq(kits.id, run.kitId)).limit(1);
      return k ?? null;
    },

    async digest(run) {
      if (!run.projectId) return null;
      const [p] = await db
        .select({ digest: projects.digest })
        .from(projects)
        .where(eq(projects.id, run.projectId))
        .limit(1);
      return p?.digest ?? null;
    },

    async trials(runId) {
      return db
        .select()
        .from(trials)
        .where(eq(trials.runId, runId))
        .orderBy(asc(trials.createdAt), asc(trials.id));
    },
  };
}

/** The event actor for a lease owner: the worker id part. */
export function actorOf(owner: string): EventActor {
  return { kind: "worker", id: owner.split("~")[0] || "worker" };
}

/** The next kit version number for a run (inside the caller's transaction). */
export async function nextKitVersion(tx: DbTx, runId: string): Promise<number> {
  const [last] = await tx
    .select({ v: max(kits.version) })
    .from(kits)
    .where(eq(kits.runId, runId));
  return (last?.v ?? 0) + 1;
}

/**
 * The contenders rows that stand for a kit's contenders (found_by `kit`, source = the kit slug),
 * created when missing. trials.contender_id points at these. Inside the caller's transaction.
 */
export async function ensureKitContenders(
  tx: DbTx,
  runId: string,
  kitId: string,
  kitContenders: readonly { id: string; role: string }[],
): Promise<Map<string, string>> {
  const existing = await tx
    .select({ id: contenders.id, source: contenders.source })
    .from(contenders)
    .where(
      and(eq(contenders.runId, runId), eq(contenders.kitId, kitId), eq(contenders.foundBy, "kit")),
    );
  const bySlug = new Map(existing.map((c) => [c.source, c.id]));
  const missing = kitContenders.filter((c) => !bySlug.has(c.id));
  if (missing.length > 0) {
    const rows = await tx
      .insert(contenders)
      .values(
        missing.map((c) => ({
          runId,
          kitId,
          source: c.id,
          role: c.role,
          status: "kept" as const,
          foundBy: "kit",
        })),
      )
      .returning({ id: contenders.id, source: contenders.source });
    for (const r of rows) bySlug.set(r.source, r.id);
  }
  return bySlug;
}

/** Kit slug for each kit contender row of a run (found_by `kit`). */
export async function kitContenderSlugs(db: Database, runId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: contenders.id, source: contenders.source })
    .from(contenders)
    .where(and(eq(contenders.runId, runId), eq(contenders.foundBy, "kit")));
  return new Map(rows.map((r) => [r.id, r.source]));
}

/** Queued trials nobody leased yet → cancelled, with their trial.phase events. */
export async function cancelQueuedTrials(
  db: Database,
  runId: string,
  actor: EventActor,
  reason: string,
): Promise<string[]> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(trials)
      .set({ state: "cancelled", endedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(trials.runId, runId), eq(trials.state, "queued"), isNull(trials.leaseOwner)))
      .returning({ id: trials.id, attempt: trials.attempt });
    if (rows.length > 0) {
      const at = new Date().toISOString();
      await appendEvents(
        tx,
        runId as RunId,
        rows.map((r): AnybenchEvent => ({
          run_id: runId,
          seq: 0,
          type: "trial.phase",
          source: "trial",
          source_id: r.id,
          severity: "info",
          actor,
          cost_delta_micro_usd: 0n,
          at,
          payload: { from: "queued", to: "cancelled", attempt: r.attempt, reason },
        })),
      );
    }
    return rows.map((r) => r.id);
  });
}

/** Runs with no live holder in the given states (sweep candidates). */
export async function sweepCandidates(
  db: Database,
  opts: { maxTickAgeMs: number; active: readonly RunState[]; terminal: readonly RunState[] },
): Promise<{ id: string; state: RunState }[]> {
  return db
    .select({ id: runs.id, state: runs.state })
    .from(runs)
    .where(
      and(
        sql`(
          ${inArray(runs.state, [...opts.active])}
          or (${runs.state} = 'awaiting_go' and coalesce((${runs.intake}->>'auto_go')::boolean, true))
          or (${inArray(runs.state, [...opts.terminal])} and not (${runs.stageOutputs} ? 'finalized_at'))
        )`,
        runLeaseFree(opts.maxTickAgeMs),
      ),
    );
}
