// TDM-250: recompute a run's recorded BYOK token spend from Claude Code's own session totals in
// each trial's stored bundle (trial-metrics.ts settledTokenSpend), for runs settled before
// trial.gate did it. CLI: scripts/ops/backfill-token-spend.ts.
//
// Per trial on the user's key (no proxy key): its current attempt's entry in
// trials.token_spend_by_attempt (the runner's live meter, which on a stale runner summed every
// result's running total) becomes the bundle's session totals, token_spend_micro_usd the sum over
// attempts again, and a measured trial's metrics.byok_token_cost_micro_usd the same figure. Earlier
// attempts keep their entries: the bundle is the latest attempt's. Then runs.byok_token_micro_usd
// (the BYOK token limit's "spent") is recomputed from the corrected trials by the budget module.
//
// Idempotent: the figure comes from the bundle every time (and where a session never reported, the
// larger of it and what is stored), so a second run changes nothing. A dry run writes nothing.
import { isTerminalRunState, type RunState } from "@anybench/core";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { runs } from "../db/schema/runs.js";
import { trials } from "../db/schema/trials.js";
import type { BundleSource } from "../lib/trial-trace/store.js";
import { readRunBudget, storeRunBudget, terminalRunBudget, type BudgetPricing } from "./budget.js";
import { kitContenderSlugs } from "./store.js";
import {
  attemptTokenSpend,
  bundleReadings,
  settledByokOf,
  tokenSpendColumns,
  type TokenSpendSource,
} from "./trial-metrics.js";

/** States whose metrics carry byok_token_cost_micro_usd (what the scorer reads). */
const MEASURED_STATES = new Set(["done", "failed_subject"]);

export interface TokenSpendBackfillLine {
  trialId: string;
  contender: string;
  repeat: number;
  state: string;
  attempt: number;
  /** settledTokenSpend's source; `proxy_key` (not BYOK, untouched) or `unread` (bundle error). */
  source: TokenSpendSource | "proxy_key" | "unread";
  sessions: number | null;
  open_sessions: number | null;
  results: number | null;
  /** The current attempt's entry, before → after (integer micro-USD as text). */
  attempt_old_micro_usd: string | null;
  attempt_new_micro_usd: string | null;
  /** token_spend_micro_usd (Σ attempts), before → after. */
  trial_old_micro_usd: string | null;
  trial_new_micro_usd: string | null;
  /** metrics.byok_token_cost_micro_usd, before → after. */
  metric_old_micro_usd: number | null;
  metric_new_micro_usd: number | null;
  note?: string;
  written: boolean;
}

export interface TokenSpendBackfillReport {
  runId: string;
  apply: boolean;
  runState: string;
  trials: TokenSpendBackfillLine[];
  /** contender → its BYOK trials' token_spend_micro_usd, before → after. */
  byContender: Record<string, { trials: number; old_micro_usd: string; new_micro_usd: string }>;
  /** runs.byok_token_micro_usd as stored, and recomputed from the corrected trials. */
  run: { stored_micro_usd: string; new_micro_usd: string; written: boolean };
}

function sumAttempts(byAttempt: Record<string, unknown> | null): bigint | null {
  if (!byAttempt) return null;
  const keys = Object.keys(byAttempt);
  if (keys.length === 0) return null;
  let total = 0n;
  for (const k of keys) total += attemptTokenSpend(byAttempt, Number(k)) ?? 0n;
  return total;
}

function objectOf(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export async function backfillTokenSpend(
  db: Database,
  opts: {
    runId: string;
    apply: boolean;
    bundles: BundleSource;
    /** Needed with apply: runs.byok_token_micro_usd is rewritten by the budget module. */
    pricing?: BudgetPricing;
    log?: (msg: string) => void;
  },
): Promise<TokenSpendBackfillReport> {
  const log = opts.log ?? (() => undefined);
  if (opts.apply && !opts.pricing) throw new Error("apply needs the budget pricing");
  const [run] = await db.select().from(runs).where(eq(runs.id, opts.runId));
  if (!run) throw new Error(`run ${opts.runId} not found`);
  const slugs = await kitContenderSlugs(db, run.id);
  const rows = await db
    .select()
    .from(trials)
    .where(eq(trials.runId, run.id))
    .orderBy(trials.contenderId, trials.repeat, trials.id);
  log(`run ${run.id} (${run.state}): ${rows.length} trials`);

  const lines: TokenSpendBackfillLine[] = [];
  const byContender: TokenSpendBackfillReport["byContender"] = {};
  let newRun = 0n;
  for (const t of rows) {
    const contender = slugs.get(t.contenderId) ?? t.contenderId;
    const byAttempt = objectOf(t.tokenSpendByAttempt);
    const metrics = objectOf(t.metrics);
    const metricOld =
      typeof metrics?.byok_token_cost_micro_usd === "number"
        ? metrics.byok_token_cost_micro_usd
        : null;
    const base = {
      trialId: t.id,
      contender,
      repeat: t.repeat,
      state: t.state,
      attempt: t.attempt,
      attempt_old_micro_usd: attemptTokenSpend(byAttempt, t.attempt)?.toString() ?? null,
      trial_old_micro_usd: t.tokenSpendMicroUsd?.toString() ?? null,
      metric_old_micro_usd: metricOld,
    };
    if (t.proxyKeyId !== null) {
      lines.push({
        ...base,
        source: "proxy_key",
        sessions: null,
        open_sessions: null,
        results: null,
        attempt_new_micro_usd: base.attempt_old_micro_usd,
        trial_new_micro_usd: base.trial_old_micro_usd,
        metric_new_micro_usd: metricOld,
        written: false,
      });
      continue;
    }

    let sessions: ReturnType<typeof bundleReadings>["sessions"] | undefined;
    let note: string | undefined;
    try {
      const bundle = await opts.bundles.bundle(run.id, t.id);
      sessions = bundle ? bundleReadings(bundle).sessions : null;
      if (!bundle) note = "no bundle";
      else if (!sessions) note = "no Claude Code transcript in the bundle";
    } catch (err) {
      note = `bundle not read: ${err instanceof Error ? err.message : String(err)}`;
    }
    const settled = settledByokOf(t, sessions);
    const nextByAttempt =
      settled.store !== undefined
        ? { ...(byAttempt ?? {}), [String(t.attempt)]: settled.store.toString() }
        : byAttempt;
    const trialNew =
      settled.store !== undefined ? sumAttempts(nextByAttempt) : t.tokenSpendMicroUsd;
    const metricNew =
      MEASURED_STATES.has(t.state) &&
      settled.byokTokens !== undefined &&
      settled.byokTokens !== null
        ? Number(settled.byokTokens)
        : metricOld;
    if (open(sessions)) {
      note = [note, `${sessions!.open_sessions} session(s) never reported a total`]
        .filter(Boolean)
        .join("; ");
    }

    let written = false;
    const metricChanged = metricNew !== metricOld && metricNew !== null;
    if (opts.apply && (settled.store !== undefined || metricChanged)) {
      const moved = await db
        .update(trials)
        .set({
          ...(settled.store !== undefined ? tokenSpendColumns(settled.store) : {}),
          ...(metricChanged
            ? {
                metrics: sql`jsonb_set(coalesce(${trials.metrics}, '{}'::jsonb), '{byok_token_cost_micro_usd}', to_jsonb(${metricNew}::bigint))`,
              }
            : {}),
          updatedAt: sql`now()`,
        })
        .where(and(eq(trials.id, t.id), eq(trials.attempt, t.attempt), eq(trials.state, t.state)))
        .returning({ id: trials.id });
      written = moved.length > 0;
      if (!written) note = [note, "row moved on; not written"].filter(Boolean).join("; ");
    }

    lines.push({
      ...base,
      source: sessions === undefined ? "unread" : (settled.source ?? "meter"),
      sessions: sessions?.sessions ?? null,
      open_sessions: sessions?.open_sessions ?? null,
      results: sessions?.results ?? null,
      attempt_new_micro_usd: settled.store?.toString() ?? base.attempt_old_micro_usd,
      trial_new_micro_usd: trialNew?.toString() ?? null,
      metric_new_micro_usd: metricNew,
      ...(note ? { note } : {}),
      written,
    });
    const c = (byContender[contender] ??= { trials: 0, old_micro_usd: "0", new_micro_usd: "0" });
    c.trials++;
    c.old_micro_usd = (BigInt(c.old_micro_usd) + (t.tokenSpendMicroUsd ?? 0n)).toString();
    c.new_micro_usd = (BigInt(c.new_micro_usd) + (trialNew ?? 0n)).toString();
    newRun += trialNew ?? 0n;
  }

  // runs.byok_token_micro_usd: what the budget module derives from the trials (Σ BYOK trials'
  // token_spend_micro_usd), written by it with its run.budget event.
  let runWritten = false;
  if (opts.apply) {
    const b = isTerminalRunState(run.state as RunState)
      ? await terminalRunBudget(db, run.id, opts.pricing!)
      : await readRunBudget(db, run.id, opts.pricing!);
    if (b) {
      newRun = b.byokTokens;
      runWritten = await storeRunBudget(db, b, { kind: "system" });
    }
  }
  return {
    runId: run.id,
    apply: opts.apply,
    runState: run.state,
    trials: lines,
    byContender,
    run: {
      stored_micro_usd: run.byokTokenMicroUsd.toString(),
      new_micro_usd: newRun.toString(),
      written: runWritten,
    },
  };
}

function open(s: ReturnType<typeof bundleReadings>["sessions"] | undefined): boolean {
  return !!s && s.open_sessions > 0;
}
