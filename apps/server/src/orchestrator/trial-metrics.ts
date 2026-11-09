// What a trial measured, as the scorer reads it (`trials.metrics` + `trials.cost_micro_usd`).
//
// Nothing the agent under test can write goes in (plan.md 17.2 rule 5):
//   wall_s / wall_ms   the worker's own trial.phase edges for the attempt: `running` → `collecting`
//                      (actor worker; the runner's status.json is subject-writable, so it is not
//                      used). Includes the poll interval of the executor (EXECUTOR_POLL_MS).
//   gate metrics       the rows a PASSING gate verdict returned (bench trialGateMetrics), e.g.
//                      api-load's `api_p95_ms`.
//   cost_micro_usd     (the column) compute share (what the executor booked) + the attempt's Naïve
//                      proxy key spend from the credits ledger. The parts are kept in metrics as
//                      `compute_cost_micro_usd` / `proxy_cost_micro_usd`, so recomputing is
//                      idempotent. When the trial had a proxy key but its spend could not be read,
//                      `proxy_cost_missing: 1` is set and the scorer treats cost as missing rather
//                      than reporting compute alone as the cost.
//
//   questions_auto_answered / auto_answer_cap_reached
//                      TDM-245: the harness league's headless policy (TDM-228), from the bundle's
//                      stream.jsonl by bench's stream-json collector. Reported, never scored: the
//                      report's per-setup "questions auto-answered" line (proof-score.ts
//                      autoAnswerLine). The stream is written on the trial computer, so no
//                      requirement may rest on it (plan.md 17.2 rule 5); it says how often the
//                      policy fired, which the policy's own events record.
//
//   byok_token_cost_micro_usd / cost_includes_model_tokens
//                      TDM-246: the scored attempt's spend on the user's own key
//                      (trials.token_spend_by_attempt[attempt]), and whether the kit's cost basis
//                      adds it to the cost
//                      (bench kitCostBasis: every contender on the Anthropic key with one pinned
//                      Claude Code version; plan.md 17.2 rule 5). The scorer adds it to
//                      cost_micro_usd only under that basis (proof-score.ts trialResultOf). Earlier
//                      attempts (infra failures, our retries) never count against the contender.
//                      TDM-250: once the bundle is read, the attempt's spend is Claude Code's own
//                      session totals (settledTokenSpend: each session's latest `total_cost_usd`,
//                      summed over sessions), and it replaces the runner's live meter in
//                      token_spend_by_attempt too, so the run's BYOK limit counts the same figure.
//                      The meter stays the figure while the trial is in flight, and for a bundle
//                      with no transcript.
//
// trial.gate writes these with the verdict (one update, so the run never scores a trial without
// them). trial.execute records them for a failed_subject trial right after it settles (its cost
// counts in "all spend ÷ solved"; its wall is censored at the cap anyway).
// scripts/ops/backfill-trial-metrics.ts recomputes them for trials settled before this existed.
import {
  claudeCodeSpend,
  collectStreamJson,
  trialGateMetrics,
  TrialGateRecordSchema,
  type ClaudeCodeSpend,
  type KitCostBasis,
} from "@anybench/bench";
import type { ProxySpendSource, TrialProxySpend } from "@anybench/naive";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Database, DbTx } from "../db/client.js";
import type { BundleSource } from "../lib/trial-trace/store.js";
import { readTarGz } from "../lib/trial-trace/tar.js";
import { events } from "../db/schema/events.js";
import { trials } from "../db/schema/trials.js";

/** Bumped when the meaning of a key changes. */
export const TRIAL_METRICS_VERSION = 1;

/** Keys this module owns in `trials.metrics` (recomputed every time; anything else is kept). */
export const OWN_METRIC_KEYS = [
  "metrics_version",
  "wall_s",
  "wall_ms",
  "compute_cost_micro_usd",
  "proxy_cost_micro_usd",
  "proxy_calls",
  "proxy_unpriced_calls",
  "proxy_cost_missing",
  "byok_token_cost_micro_usd",
  "cost_includes_model_tokens",
] as const;

/**
 * TDM-246: the metered token spend of `attempt` (trials.token_spend_by_attempt), or null when that
 * attempt reported none. Never another attempt's: a retry is scored on its own spend.
 */
export function attemptTokenSpend(byAttempt: unknown, attempt: number): bigint | null {
  if (!byAttempt || typeof byAttempt !== "object" || Array.isArray(byAttempt)) return null;
  const v = (byAttempt as Record<string, unknown>)[String(attempt)];
  const text = typeof v === "number" && Number.isSafeInteger(v) ? String(v) : v;
  return typeof text === "string" && /^\d{1,20}$/.test(text) ? BigInt(text) : null;
}

/**
 * TDM-245: the headless policy's counts (bench stream-json collector), kept in `trials.metrics`
 * when the trial's bundle has them. Recomputed whenever the bundle is read; kept otherwise.
 */
export const AUTO_ANSWER_METRIC_KEYS = [
  "questions_auto_answered",
  "auto_answer_cap_reached",
] as const;

/** Where a Claude Code setup's transcript sits in the trial bundle (COLLECTOR_OUTPUT_FILES). */
const STREAM_FILE = "stream.jsonl";

/**
 * TDM-250: the bundle files that are one Claude Code session transcript each: `stream.jsonl`
 * (solo, subagents, skill packs) and `tandem/streams/<actor>.jsonl` (Tandem's planner and workers;
 * lib/trial-trace/parse.ts).
 */
export function isSessionTranscript(name: string): boolean {
  return name === STREAM_FILE || /^tandem\/streams\/[^/]+\.jsonl$/.test(name);
}

/** What trial.gate reads from a bundle, from one pass over the archive. */
export interface BundleReadings {
  /** autoAnswerMetricsFromBundle's counts. */
  autoAnswer: Record<string, number>;
  /** Claude Code's own totals over the bundle's transcripts; null when it has none. */
  sessions: ClaudeCodeSpend | null;
}

/** Read a trial bundle (out.tar.gz) once for its auto-answer counts and session totals. */
export function bundleReadings(bundle: Uint8Array): BundleReadings {
  const entries = readTarGz(bundle, { want: isSessionTranscript });
  const transcripts = entries
    .flatMap((e) => (e.data && isSessionTranscript(e.name) ? [{ name: e.name, data: e.data }] : []))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((e) => ({ name: e.name, text: Buffer.from(e.data).toString("utf8") }));
  const solo = transcripts.find((t) => t.name === STREAM_FILE);
  return {
    autoAnswer: solo ? autoAnswerOf(solo.text) : {},
    sessions: transcripts.length > 0 ? claudeCodeSpend(transcripts) : null,
  };
}

function autoAnswerOf(stream: string): Record<string, number> {
  const out: Record<string, number> = {};
  const keys: readonly string[] = AUTO_ANSWER_METRIC_KEYS;
  for (const row of collectStreamJson(stream)) {
    if (keys.includes(row.name) && row.labels === undefined) out[row.name] = Number(row.value);
  }
  return out;
}

/**
 * The headless policy's counts from a trial bundle (out.tar.gz): bench's stream-json collector
 * over its `stream.jsonl`. Empty when there is no transcript (Tandem's sessions live under
 * tandem/) or the policy never started (any setup outside the league); the collector writes the
 * two rows only under the policy, with 0 when it never fired. Throws on an unreadable archive.
 */
export function autoAnswerMetricsFromBundle(bundle: Uint8Array): Record<string, number> {
  const entries = readTarGz(bundle, { want: (name) => name === STREAM_FILE });
  const stream = entries.find((e) => e.name === STREAM_FILE)?.data;
  return stream ? autoAnswerOf(Buffer.from(stream).toString("utf8")) : {};
}

/**
 * TDM-250: a trial's session totals from its stored bundle. undefined when the bundle could not be
 * read (no source, a download or archive error): the caller keeps what is stored. null when the
 * trial has no bundle or the bundle has no transcript. Never throws.
 */
export async function readSessionSpend(
  bundles: BundleSource | null | undefined,
  runId: string,
  trialId: string,
): Promise<ClaudeCodeSpend | null | undefined> {
  if (!bundles) return undefined;
  try {
    const bundle = await bundles.bundle(runId, trialId);
    return bundle ? bundleReadings(bundle).sessions : null;
  } catch {
    return undefined;
  }
}

/** Where a trial attempt's recorded model-token spend came from (TDM-250). */
export type TokenSpendSource =
  /** Every session in the bundle reported a total: their sum, the meter ignored. */
  | "session_totals"
  /** Some session never reported (stopped mid-turn): the larger of the sum and the meter. */
  | "session_totals_and_meter"
  /** No transcript (or bundle) to read: the runner's live meter. */
  | "meter";

/**
 * TDM-250: the attempt's recorded spend. Claude Code's own session totals are the bill once the
 * bundle is read: the runner's live meter is an estimate for the in-flight hard stop, and a stale
 * meter summed the running totals (run 01a1c202: $184.80 recorded, $87.71 real). Where a session
 * stopped before it reported, its spend is not in the transcript, so the meter (which estimates
 * the open sessions on top of the reported ones) stands when it is larger. Idempotent: applying
 * it to its own output gives the same figure.
 */
export function settledTokenSpend(
  meter: bigint | null,
  sessions: ClaudeCodeSpend | null,
): { spend: bigint | null; source: TokenSpendSource } {
  if (!sessions || sessions.sessions === 0) return { spend: meter, source: "meter" };
  if (sessions.open_sessions === 0) {
    return { spend: sessions.total_micro_usd, source: "session_totals" };
  }
  const total = sessions.total_micro_usd;
  return {
    spend: meter !== null && meter > total ? meter : total,
    source: "session_totals_and_meter",
  };
}

/**
 * TDM-246: record THIS attempt's model-token spend (the row's attempt as it stands when the update
 * runs) under its own key, and keep token_spend_micro_usd the sum over every attempt, so a retried
 * attempt never overwrites (lowers) what an earlier one spent. Writing the same attempt again
 * replaces its entry (idempotent; TDM-250: the session totals replace the meter's figure). Null
 * clears nothing.
 */
export function tokenSpendColumns(
  spend: bigint | null,
): Partial<Record<"tokenSpendByAttempt" | "tokenSpendMicroUsd", SQL>> {
  if (spend === null) return {};
  const merged = sql`(coalesce(${trials.tokenSpendByAttempt}, '{}'::jsonb) || jsonb_build_object(${trials.attempt}::text, ${spend.toString()}::text))`;
  return {
    tokenSpendByAttempt: merged,
    tokenSpendMicroUsd: sql`(select coalesce(sum(e.value::bigint), 0) from jsonb_each_text(${merged}) as e)`,
  };
}

/** One trial.phase event, as stored. */
export interface PhaseEdge {
  to: string;
  attempt: number;
  at: Date;
  /** `actor.kind` (worker | runner | ...), null when unreadable. */
  actorKind: string | null;
}

export type ProxySpendResult =
  | { status: "none" }
  | { status: "ok"; spend: Pick<TrialProxySpend, "spentMicroUsd" | "calls" | "unpricedCalls"> }
  | { status: "missing"; reason: string };

export interface TrialMetricsInput {
  attempt: number;
  /** trials.metrics as stored (anything). */
  existing: unknown;
  /** trials.cost_micro_usd as stored. */
  costMicroUsd: bigint;
  edges: readonly PhaseEdge[];
  /** The gate record (trials.gate or the one just scored); null when not gated. */
  gate: unknown;
  proxy: ProxySpendResult;
  /** Extra gate-vouched metrics (the backfill's reading of old records). Gate rows win. */
  gateMetrics?: Record<string, number>;
  /**
   * TDM-245: the bundle's headless-policy counts (autoAnswerMetricsFromBundle). Given: they replace
   * the stored ones (none in the bundle clears them). Omitted (bundle not read): stored ones stay.
   */
  autoAnswer?: Record<string, number>;
  /**
   * TDM-246: the attempt's metered spend on the user's own key (attemptTokenSpend), for a trial
   * with no proxy key; null when the attempt reported none. Omitted: not a BYOK trial.
   */
  byokTokens?: bigint | null;
  /** TDM-246: the kit's cost basis (bench kitCostBasis); omitted: not recorded. */
  costBasis?: KitCostBasis;
}

function numbersOf(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/**
 * The attempt's run time as the worker saw it: its first `running` edge to the first `collecting`
 * (or `failed_subject`) edge after it. Null when either edge is missing.
 */
export function runWallMs(edges: readonly PhaseEdge[], attempt: number): number | null {
  const mine = edges
    .filter((e) => e.attempt === attempt && e.actorKind === "worker")
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const start = mine.find((e) => e.to === "running");
  if (!start) return null;
  const end = mine.find(
    (e) =>
      (e.to === "collecting" || e.to === "failed_subject") && e.at.getTime() >= start.at.getTime(),
  );
  if (!end) return null;
  return end.at.getTime() - start.at.getTime();
}

function safeMicro(n: number | undefined): bigint | null {
  return n !== undefined && Number.isSafeInteger(n) && n >= 0 ? BigInt(n) : null;
}

/** Recompute the trial's metrics and total cost. Pure; idempotent over its own output. */
export function trialMetrics(input: TrialMetricsInput): {
  metrics: Record<string, number>;
  costMicroUsd: bigint;
} {
  const prev = numbersOf(input.existing);
  const compute = safeMicro(prev.compute_cost_micro_usd) ?? input.costMicroUsd;
  const metrics: Record<string, number> = { ...prev };
  for (const k of OWN_METRIC_KEYS) delete metrics[k];
  metrics.metrics_version = TRIAL_METRICS_VERSION;

  const wallMs = runWallMs(input.edges, input.attempt);
  if (wallMs !== null) {
    metrics.wall_ms = wallMs;
    metrics.wall_s = wallMs / 1000;
  }

  const record = TrialGateRecordSchema.safeParse(input.gate);
  const fromGates = record.success ? trialGateMetrics(record.data) : {};
  for (const [k, v] of Object.entries({ ...input.gateMetrics, ...fromGates })) {
    if (!(OWN_METRIC_KEYS as readonly string[]).includes(k)) metrics[k] = v;
  }

  if (input.autoAnswer) {
    for (const k of AUTO_ANSWER_METRIC_KEYS) {
      delete metrics[k];
      const v = input.autoAnswer[k];
      if (v !== undefined && Number.isFinite(v)) metrics[k] = v;
    }
  }

  if (input.byokTokens !== undefined && input.byokTokens !== null) {
    metrics.byok_token_cost_micro_usd = Number(input.byokTokens);
  }
  if (input.costBasis) {
    metrics.cost_includes_model_tokens = input.costBasis.kind === "compute_byok_tokens" ? 1 : 0;
  }

  // Micro-USD stays integer; jsonb numbers are exact below 2^53.
  metrics.compute_cost_micro_usd = Number(compute);
  let total = compute;
  if (input.proxy.status === "ok") {
    const spent = input.proxy.spend.spentMicroUsd;
    metrics.proxy_cost_micro_usd = Number(spent);
    metrics.proxy_calls = input.proxy.spend.calls;
    metrics.proxy_unpriced_calls = input.proxy.spend.unpricedCalls;
    total = compute + spent;
  } else if (input.proxy.status === "missing") {
    metrics.proxy_cost_missing = 1;
  }
  return { metrics, costMicroUsd: total };
}

/** The trial columns the proxy lookup needs. */
export interface ProxyKeyColumns {
  attempt: number;
  proxyKeyId: string | null;
  proxyKeyCreatedAt: Date | null;
  proxyKeyAttempt: number | null;
}

/** Which key (if any) paid for this attempt's model calls. */
export function attemptKey(
  t: ProxyKeyColumns,
): { kind: "none" } | { kind: "key"; keyId: string; since: string } | { kind: "unknown" } {
  if (!t.proxyKeyId) return { kind: "none" };
  if (t.proxyKeyAttempt !== t.attempt || !t.proxyKeyCreatedAt) return { kind: "unknown" };
  return { kind: "key", keyId: t.proxyKeyId, since: t.proxyKeyCreatedAt.toISOString() };
}

/**
 * Spend per key, reading the source once back to the earliest key's creation (both live sources
 * list the whole organization newest first). Entries before a key's creation never count for it.
 */
export async function proxySpendByKey(
  source: ProxySpendSource,
  keys: readonly { keyId: string; since: string }[],
): Promise<Map<string, TrialProxySpend>> {
  const out = new Map<string, TrialProxySpend>();
  if (keys.length === 0) return out;
  const since = new Map(keys.map((k) => [k.keyId, k.since]));
  for (const k of keys) {
    out.set(k.keyId, { keyId: k.keyId, spentMicroUsd: 0n, calls: 0, unpricedCalls: 0 });
  }
  const earliest = [...since.values()].sort()[0]!;
  for await (const e of source.entries(earliest)) {
    if (e.createdAt < earliest) break;
    const id = e.actorKeyId;
    if (!id) continue;
    const s = out.get(id);
    if (!s || e.createdAt < since.get(id)!) continue;
    s.calls += 1;
    if (e.billedMicroUsd === null) s.unpricedCalls += 1;
    else s.spentMicroUsd += e.billedMicroUsd;
  }
  return out;
}

/** The attempt's proxy spend for one trial (trial.gate). Never throws. */
export async function attemptProxySpend(
  source: ProxySpendSource | null | undefined,
  t: ProxyKeyColumns,
): Promise<ProxySpendResult> {
  const key = attemptKey(t);
  if (key.kind === "none") return { status: "none" };
  if (key.kind === "unknown") {
    return { status: "missing", reason: `no proxy key recorded for attempt ${t.attempt}` };
  }
  if (!source) return { status: "missing", reason: "no Naïve spend source configured" };
  try {
    const spend = (await proxySpendByKey(source, [key])).get(key.keyId)!;
    return { status: "ok", spend };
  } catch (err) {
    return { status: "missing", reason: err instanceof Error ? err.message : String(err) };
  }
}

function actorKindOf(actor: string | null): string | null {
  if (!actor) return null;
  try {
    const v = JSON.parse(actor) as { kind?: unknown };
    return typeof v.kind === "string" ? v.kind : null;
  } catch {
    return null;
  }
}

/** trial.phase edges of these trials, by trial id. */
export async function trialPhaseEdges(
  db: Database | DbTx,
  runId: string,
  trialIds: readonly string[],
): Promise<Map<string, PhaseEdge[]>> {
  const out = new Map<string, PhaseEdge[]>();
  if (trialIds.length === 0) return out;
  const rows = await db
    .select({
      sourceId: events.sourceId,
      actor: events.actor,
      payload: events.payload,
      at: events.at,
    })
    .from(events)
    .where(
      and(
        eq(events.runId, runId),
        eq(events.type, "trial.phase"),
        eq(events.source, "trial"),
        inArray(events.sourceId, [...trialIds]),
      ),
    );
  for (const r of rows) {
    const p = r.payload as { to?: unknown; attempt?: unknown } | null;
    if (!r.sourceId || typeof p?.to !== "string" || typeof p.attempt !== "number") continue;
    const list = out.get(r.sourceId) ?? [];
    list.push({ to: p.to, attempt: p.attempt, at: r.at, actorKind: actorKindOf(r.actor) });
    out.set(r.sourceId, list);
  }
  return out;
}

/** The trial columns `recordTrialMetrics` reads. */
export type MetricsTrialRow = ProxyKeyColumns & {
  id: string;
  runId: string;
  state: string;
  metrics: unknown;
  gate: unknown;
  costMicroUsd: bigint;
  /** TDM-246: trials.token_spend_by_attempt. */
  tokenSpendByAttempt?: unknown;
};

/** TDM-246: trialMetrics' BYOK inputs for a trial row (no proxy key: the user's own key). */
export function byokInputsOf(
  t: Pick<MetricsTrialRow, "attempt" | "proxyKeyId" | "tokenSpendByAttempt">,
): { byokTokens?: bigint | null } {
  return t.proxyKeyId === null
    ? { byokTokens: attemptTokenSpend(t.tokenSpendByAttempt, t.attempt) }
    : {};
}

/** TDM-250: a BYOK attempt's settled spend, for trialMetrics and the trial row. */
export interface SettledByok {
  /** trialMetrics' input (byok_token_cost_micro_usd). Omitted: not a BYOK trial. */
  byokTokens?: bigint | null;
  /** The attempt's entry to write into token_spend_by_attempt, when it changes. */
  store?: bigint;
  source?: TokenSpendSource;
}

/** trialMetrics' `byokTokens` from a SettledByok (absent for a proxy-key trial). */
export function byokTokensOf(b: SettledByok): { byokTokens?: bigint | null } {
  return b.byokTokens !== undefined ? { byokTokens: b.byokTokens } : {};
}

/**
 * TDM-250: byokInputsOf once the bundle is read: the attempt's spend is settledTokenSpend over the
 * stored (meter) figure and the bundle's session totals. `sessions` undefined (bundle not read):
 * the stored figure, as byokInputsOf.
 */
export function settledByokOf(
  t: Pick<MetricsTrialRow, "attempt" | "proxyKeyId" | "tokenSpendByAttempt">,
  sessions: ClaudeCodeSpend | null | undefined,
): SettledByok {
  if (t.proxyKeyId !== null) return {};
  const stored = attemptTokenSpend(t.tokenSpendByAttempt, t.attempt);
  if (sessions === undefined) return { byokTokens: stored };
  const s = settledTokenSpend(stored, sessions);
  return {
    byokTokens: s.spend,
    source: s.source,
    ...(s.spend !== null && s.spend !== stored ? { store: s.spend } : {}),
  };
}

/**
 * Recompute and store one settled trial's metrics and cost, only while it is still in the state
 * and attempt it was read in. Returns what was written, or null when the row moved on.
 */
export async function recordTrialMetrics(
  db: Database,
  t: MetricsTrialRow,
  proxy: ProxySpendResult,
  opts: {
    gateMetrics?: Record<string, number>;
    edges?: readonly PhaseEdge[];
    costBasis?: KitCostBasis;
    /**
     * TDM-250: the bundle's session totals (readSessionSpend). Given: the attempt's BYOK spend is
     * settled from them and written back to token_spend_by_attempt. Omitted: the stored figure.
     */
    sessions?: ClaudeCodeSpend | null;
  } = {},
): Promise<{ metrics: Record<string, number>; costMicroUsd: bigint } | null> {
  const edges = opts.edges ?? (await trialPhaseEdges(db, t.runId, [t.id])).get(t.id) ?? [];
  const byok = settledByokOf(t, opts.sessions);
  const m = trialMetrics({
    attempt: t.attempt,
    existing: t.metrics,
    costMicroUsd: t.costMicroUsd,
    edges,
    gate: t.gate,
    proxy,
    ...(opts.gateMetrics ? { gateMetrics: opts.gateMetrics } : {}),
    ...byokTokensOf(byok),
    ...(opts.costBasis ? { costBasis: opts.costBasis } : {}),
  });
  const moved = await db
    .update(trials)
    .set({
      metrics: m.metrics,
      costMicroUsd: m.costMicroUsd,
      ...(byok.store !== undefined ? tokenSpendColumns(byok.store) : {}),
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(trials.id, t.id),
        eq(trials.state, t.state as (typeof trials.$inferSelect)["state"]),
        eq(trials.attempt, t.attempt),
      ),
    )
    .returning({ id: trials.id });
  return moved.length > 0 ? m : null;
}
