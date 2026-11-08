// Backfill trial traces for one run (scripts/ops/backfill-trial-traces.ts). Read-only on every
// table: it selects the run's trials, reads each trial's out.tar.gz and writes only the trace
// artifacts (runs/<run>/server/traces/<trial>.json). No trial state, score or cost changes.
import { asc, eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { trials } from "../../db/schema/trials.js";
import { buildAndStoreTrace, type TraceDeps } from "./store.js";

export interface TraceBackfillRow {
  trial_id: string;
  contender_id: string;
  workload_id: string;
  state: string;
  status: "traced" | "would_trace" | "no_bundle" | "error";
  actors?: string[];
  duration_ms?: number;
  failure?: string | null;
  error?: string;
}

export interface TraceBackfillReport {
  run_id: string;
  dry_run: boolean;
  traced: number;
  no_bundle: number;
  errors: number;
  trials: TraceBackfillRow[];
}

export async function backfillRunTraces(
  db: Database,
  input: { runId: string; deps: TraceDeps; dryRun?: boolean; log?: (msg: string) => void },
): Promise<TraceBackfillReport> {
  const rows = await db
    .select({
      id: trials.id,
      contenderId: trials.contenderId,
      workloadId: trials.workloadId,
      state: trials.state,
      gate: trials.gate,
    })
    .from(trials)
    .where(eq(trials.runId, input.runId))
    .orderBy(asc(trials.contenderId), asc(trials.workloadId), asc(trials.repeat));
  const dry = input.dryRun === true;
  // A dry run builds every trace and stores nothing.
  const deps: TraceDeps = dry
    ? { ...input.deps, traces: { ...input.deps.traces, put: async () => undefined } }
    : input.deps;
  const out: TraceBackfillRow[] = [];
  for (const t of rows) {
    const base = {
      trial_id: t.id,
      contender_id: t.contenderId,
      workload_id: t.workloadId,
      state: t.state,
    };
    try {
      const trace = await buildAndStoreTrace(deps, {
        runId: input.runId,
        trialId: t.id,
        gate: t.gate,
      });
      if (!trace) {
        out.push({ ...base, status: "no_bundle" });
        continue;
      }
      out.push({
        ...base,
        status: dry ? "would_trace" : "traced",
        actors: trace.actors.map((a) => a.id),
        duration_ms: trace.duration_ms,
        failure: trace.failure?.tests[0]?.name ?? (trace.failure ? "gate failed" : null),
      });
      input.log?.(
        `${t.id} ${t.workloadId}: ${trace.actors.length} actors, ${trace.duration_ms} ms`,
      );
    } catch (err) {
      out.push({
        ...base,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      input.log?.(`${t.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return {
    run_id: input.runId,
    dry_run: dry,
    traced: out.filter((r) => r.status === "traced" || r.status === "would_trace").length,
    no_bundle: out.filter((r) => r.status === "no_bundle").length,
    errors: out.filter((r) => r.status === "error").length,
    trials: out,
  };
}
