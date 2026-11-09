// Recompute trials.metrics / trials.cost_micro_usd for a run whose trials settled before
// trial.gate recorded them (orchestrator/trial-metrics.ts), then re-score the run and, for a
// curated Tandem run, rebuild its deterministic report. CLI: scripts/ops/backfill-trial-metrics.ts.
//
// Idempotent: everything is recomputed from raw data each time (the worker's trial.phase edges,
// the gate record, the Naïve credits ledger by proxy key id, and the compute share kept in
// metrics.compute_cost_micro_usd), so a second run writes the same values.
//
// Records gated before gates returned metric rows have no `metrics` on their outcomes: for those
// the p95 is read back from a passing verdict's reason ("p95 3.6 ms at 50 req/s ..."), which the
// api-load check rounds to 0.1 ms. Nothing else is guessed.
import { gateResultsOf, kitCostBasis, TrialGateRecordSchema } from "@anybench/bench";
import { safeParseKitSpec, toJsonValue, type KitSpec } from "@anybench/core";
import type { ProxySpendSource, TrialProxySpend } from "@anybench/naive";
import { eq, sql } from "drizzle-orm";
import type { z } from "zod";
import type { Database } from "../db/client.js";
import { kits } from "../db/schema/kits.js";
import { reports } from "../db/schema/reports.js";
import { runs } from "../db/schema/runs.js";
import { proofOf } from "../routes/kits.js";
import { stageTrialOf } from "./advance.js";
import { isTandemRepo } from "./curated.js";
import { AnalysisSchema, RunIntakeSchema, RunStageOutputsShape, type StageTrial } from "./ports.js";
import { buildSummary, storedScoreOf, TANDEM_DISCLOSURE, type StoredScore } from "./proof-score.js";
import { kitContenderSlugs, orchestratorStore } from "./store.js";
import {
  attemptKey,
  proxySpendByKey,
  byokInputsOf,
  recordTrialMetrics,
  trialMetrics,
  trialPhaseEdges,
  type ProxySpendResult,
} from "./trial-metrics.js";

/** Trial states that carry results (failed_infra / cancelled are left out of the score anyway). */
const MEASURED_STATES = new Set(["done", "failed_subject"]);

/** `api_p95_ms` from an old api-load verdict: "p95 3.6 ms at 50 req/s over 1000 requests, ...". */
const P95_REASON = /^p95 (\d+(?:\.\d+)?) ms at /;

/** Gate-vouched metrics an old record holds only in its verdict text. */
export function legacyGateMetrics(gate: unknown): Record<string, number> {
  const record = TrialGateRecordSchema.safeParse(gate);
  if (!record.success) return {};
  const out: Record<string, number> = {};
  for (const [id, o] of Object.entries(record.data.gates)) {
    if (o.status !== "verdict" || !o.result.pass || o.metrics) continue;
    const m = P95_REASON.exec(gateResultsOf(record.data)[id]!.reason);
    if (m && out.api_p95_ms === undefined) out.api_p95_ms = Number(m[1]);
  }
  return out;
}

export interface TrialBackfillLine {
  trialId: string;
  contender: string;
  workloadId: string;
  repeat: number;
  state: string;
  wall_s: number | null;
  api_p95_ms: number | null;
  compute_micro_usd: string;
  proxy_micro_usd: string | null;
  cost_micro_usd: string;
  /** Why something could not be recovered. */
  missing: string[];
  written: boolean;
}

export interface RunBackfillReport {
  runId: string;
  apply: boolean;
  trials: TrialBackfillLine[];
  /** After the re-score: requirement id → contenders it is still unscored for (with the reason). */
  unscored: Record<string, string[]>;
  scoreWritten: boolean;
  report: "rebuilt" | "unchanged" | "skipped";
  reportReason?: string;
}

export interface RunBackfillOptions {
  runId: string;
  /** false: compute and print only. */
  apply: boolean;
  /** The Naïve credits ledger (liveLedgerSpend); null leaves proxy spend missing. */
  proxySpend: ProxySpendSource | null;
  log?: (msg: string) => void;
}

function unscoredOf(score: StoredScore): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const c of score.kit_score.contenders) {
    for (const r of c.requirements) {
      if (r.scored) continue;
      (out[r.requirementId] ??= []).push(`${c.contenderId}: ${r.reason}`);
    }
  }
  return out;
}

type RunRow = typeof runs.$inferSelect;
type KitRow = typeof kits.$inferSelect;

export interface ScoreAndReport {
  score: StoredScore;
  scoreWritten: boolean;
  report: "rebuilt" | "unchanged" | "skipped";
  reportReason?: string;
  /** The rebuilt report (also in a dry run), when it was built. */
  analysis?: z.infer<typeof AnalysisSchema>;
}

/**
 * Score the run's trials as given and (curated Tandem runs) rebuild its deterministic report.
 * With `apply`, writes runs.stage_outputs.score (plus `marker` = now) and reports.json/md only;
 * trial rows are never touched here.
 */
export async function writeScoreAndReport(
  db: Database,
  input: {
    run: RunRow;
    kitRow: KitRow;
    kit: KitSpec;
    stageTrials: StageTrial[];
    apply: boolean;
    marker: string;
  },
): Promise<ScoreAndReport> {
  const { run, kitRow, kit, stageTrials, apply } = input;
  const score = storedScoreOf(kit, stageTrials);
  let scoreWritten = false;
  if (apply) {
    const json = toJsonValue(score);
    await db
      .update(runs)
      .set({
        stageOutputs: sql`coalesce(${runs.stageOutputs}, '{}'::jsonb) || jsonb_build_object('score', ${JSON.stringify(json)}::jsonb, ${input.marker}::text, ${new Date().toISOString()}::text)`,
        updatedAt: sql`now()`,
      })
      .where(eq(runs.id, run.id));
    scoreWritten = true;
  }

  // The report: only the curated Tandem summary is deterministic (no LLM) and safe to rebuild.
  const intake = RunIntakeSchema.safeParse(run.intake ?? {});
  const [existing] = await db.select().from(reports).where(eq(reports.runId, run.id));
  if (!existing)
    return { score, scoreWritten, report: "skipped", reportReason: "the run has no report" };
  if (!intake.success || !isTandemRepo(intake.data.source)) {
    return {
      score,
      scoreWritten,
      report: "skipped",
      reportReason: "not a curated Tandem run: its report is an analyst's, not rebuilt",
    };
  }
  const outputs = RunStageOutputsShape.safeParse(run.stageOutputs ?? {});
  const basis = outputs.success ? outputs.data.proof_basis : undefined;
  const built = buildSummary({
    kit,
    score: toJsonValue(score),
    proof: proofOf(kitRow.proof),
    trials: stageTrials,
    ...(basis && basis.kit_id === kitRow.id ? { proofLabel: basis.label } : {}),
    disclosure: TANDEM_DISCLOSURE,
  });
  if (!built.ok) return { score, scoreWritten, report: "skipped", reportReason: built.reason };
  const analysis = AnalysisSchema.safeParse({
    ...built.analysis,
    report: {
      ...built.analysis.report,
      run_id: run.id,
      kit_id: kitRow.id,
      comped: run.compedBy !== null,
    },
  });
  if (!analysis.success) {
    return {
      score,
      scoreWritten,
      report: "skipped",
      reportReason: `rebuilt report does not validate: ${analysis.error.message}`,
    };
  }
  if (!apply) {
    return {
      score,
      scoreWritten,
      report: "unchanged",
      reportReason: "dry run",
      analysis: analysis.data,
    };
  }
  await db
    .update(reports)
    .set({
      json: toJsonValue(analysis.data.report),
      md: analysis.data.md,
      updatedAt: sql`now()`,
    })
    .where(eq(reports.runId, run.id));
  return { score, scoreWritten, report: "rebuilt", analysis: analysis.data };
}

export interface RunRescoreReport {
  runId: string;
  apply: boolean;
  trials: number;
  scoreWritten: boolean;
  report: ScoreAndReport["report"];
  reportReason?: string;
  answer: string | null;
  perTaskHeadline: string[] | null;
}

/**
 * Re-score a run from its stored trial rows (read only) and rebuild its curated report: for a
 * scorer or summary fix. Writes only runs.stage_outputs.score (+ `rescored_at`) and the report.
 */
export async function rescoreRun(
  db: Database,
  opts: { runId: string; apply: boolean },
): Promise<RunRescoreReport> {
  const [run] = await db.select().from(runs).where(eq(runs.id, opts.runId));
  if (!run) throw new Error(`run ${opts.runId} not found`);
  const [kitRow] = run.kitId ? await db.select().from(kits).where(eq(kits.id, run.kitId)) : [];
  if (!kitRow) throw new Error(`run ${opts.runId} has no kit`);
  const spec = safeParseKitSpec(kitRow.spec);
  if (!spec.success) throw new Error(`kit ${kitRow.id} does not validate: ${spec.errors[0]}`);
  const store = orchestratorStore(db, { maxTickAgeMs: 0 });
  const slugs = await kitContenderSlugs(db, run.id);
  const stageTrials = (await store.trials(run.id)).map((t) => stageTrialOf(t, slugs));
  const r = await writeScoreAndReport(db, {
    run,
    kitRow,
    kit: spec.data,
    stageTrials,
    apply: opts.apply,
    marker: "rescored_at",
  });
  return {
    runId: run.id,
    apply: opts.apply,
    trials: stageTrials.length,
    scoreWritten: r.scoreWritten,
    report: r.report,
    ...(r.reportReason ? { reportReason: r.reportReason } : {}),
    answer: r.analysis?.report.answer ?? null,
    perTaskHeadline: r.analysis?.report.per_task?.headline ?? null,
  };
}

export async function backfillRunMetrics(
  db: Database,
  opts: RunBackfillOptions,
): Promise<RunBackfillReport> {
  const log = opts.log ?? (() => undefined);
  const [run] = await db.select().from(runs).where(eq(runs.id, opts.runId));
  if (!run) throw new Error(`run ${opts.runId} not found`);
  const [kitRow] = run.kitId ? await db.select().from(kits).where(eq(kits.id, run.kitId)) : [];
  if (!kitRow) throw new Error(`run ${opts.runId} has no kit`);
  const spec = safeParseKitSpec(kitRow.spec);
  if (!spec.success) throw new Error(`kit ${kitRow.id} does not validate: ${spec.errors[0]}`);
  const kit: KitSpec = spec.data;

  const store = orchestratorStore(db, { maxTickAgeMs: 0 });
  const slugs = await kitContenderSlugs(db, run.id);
  const all = await store.trials(run.id);
  const measured = all.filter((t) => MEASURED_STATES.has(t.state));
  const edges = await trialPhaseEdges(
    db,
    run.id,
    measured.map((t) => t.id),
  );

  // Proxy spend: one ledger pass for every key of the run.
  const keys = measured.flatMap((t) => {
    const k = attemptKey(t);
    return k.kind === "key" ? [{ keyId: k.keyId, since: k.since }] : [];
  });
  let spend: Map<string, TrialProxySpend> | null = null;
  let spendError: string | null = opts.proxySpend ? null : "no NAIVE_API_KEY: ledger not read";
  if (opts.proxySpend && keys.length > 0) {
    try {
      spend = await proxySpendByKey(opts.proxySpend, keys);
    } catch (err) {
      spendError = `ledger read failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  log(`run ${run.id}: ${measured.length} measured trials, ${keys.length} proxy keys`);

  const lines: TrialBackfillLine[] = [];
  const computed = new Map<string, ReturnType<typeof trialMetrics>>();
  // TDM-246: the kit's cost basis, recorded on each trial.
  const costBasis = kitCostBasis(kit);
  for (const t of measured) {
    const k = attemptKey(t);
    const proxy: ProxySpendResult =
      k.kind === "none"
        ? { status: "none" }
        : k.kind === "unknown"
          ? { status: "missing", reason: `no proxy key recorded for attempt ${t.attempt}` }
          : spend?.get(k.keyId)
            ? { status: "ok", spend: spend.get(k.keyId)! }
            : { status: "missing", reason: spendError ?? "ledger not read" };
    const gateMetrics = legacyGateMetrics(t.gate);
    const trialEdges = edges.get(t.id) ?? [];
    const m = trialMetrics({
      attempt: t.attempt,
      existing: t.metrics,
      costMicroUsd: t.costMicroUsd,
      edges: trialEdges,
      gate: t.gate,
      proxy,
      gateMetrics,
      ...byokInputsOf(t),
      costBasis,
    });
    computed.set(t.id, m);
    const missing: string[] = [];
    if (m.metrics.wall_s === undefined) missing.push("wall: no worker running → collecting edges");
    if (proxy.status === "missing") missing.push(`proxy cost: ${proxy.reason}`);
    let written = false;
    if (opts.apply) {
      written =
        (await recordTrialMetrics(db, t, proxy, { gateMetrics, edges: trialEdges, costBasis })) !==
        null;
    }
    lines.push({
      trialId: t.id,
      contender: slugs.get(t.contenderId) ?? t.contenderId,
      workloadId: t.workloadId,
      repeat: t.repeat,
      state: t.state,
      wall_s: m.metrics.wall_s ?? null,
      api_p95_ms: m.metrics.api_p95_ms ?? null,
      compute_micro_usd: String(m.metrics.compute_cost_micro_usd),
      proxy_micro_usd:
        m.metrics.proxy_cost_micro_usd === undefined
          ? null
          : String(m.metrics.proxy_cost_micro_usd),
      cost_micro_usd: m.costMicroUsd.toString(),
      missing,
      written,
    });
  }

  // Re-score over what is stored now (or, in a dry run, over what would be stored).
  const after = opts.apply ? await store.trials(run.id) : all;
  const stageTrials = after.map((t) => {
    const st = stageTrialOf(t, slugs);
    const m = computed.get(t.id);
    return opts.apply || !m ? st : { ...st, metrics: m.metrics, cost_micro_usd: m.costMicroUsd };
  });
  const r = await writeScoreAndReport(db, {
    run,
    kitRow,
    kit,
    stageTrials,
    apply: opts.apply,
    marker: "metrics_backfill_at",
  });
  const { score, scoreWritten, report } = r;
  const unscored = unscoredOf(score);
  const reportReason = r.reportReason;

  return {
    runId: run.id,
    apply: opts.apply,
    trials: lines,
    unscored,
    scoreWritten,
    report,
    ...(reportReason ? { reportReason } : {}),
  };
}
