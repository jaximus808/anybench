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
// trial.gate writes these with the verdict (one update, so the run never scores a trial without
// them). trial.execute records them for a failed_subject trial right after it settles (its cost
// counts in "all spend ÷ solved"; its wall is censored at the cap anyway).
// scripts/ops/backfill-trial-metrics.ts recomputes them for trials settled before this existed.
import { trialGateMetrics, TrialGateRecordSchema } from "@anybench/bench";
import type { ProxySpendSource, TrialProxySpend } from "@anybench/naive";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database, DbTx } from "../db/client.js";
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
] as const;

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
};

/**
 * Recompute and store one settled trial's metrics and cost, only while it is still in the state
 * and attempt it was read in. Returns what was written, or null when the row moved on.
 */
export async function recordTrialMetrics(
  db: Database,
  t: MetricsTrialRow,
  proxy: ProxySpendResult,
  opts: { gateMetrics?: Record<string, number>; edges?: readonly PhaseEdge[] } = {},
): Promise<{ metrics: Record<string, number>; costMicroUsd: bigint } | null> {
  const edges = opts.edges ?? (await trialPhaseEdges(db, t.runId, [t.id])).get(t.id) ?? [];
  const m = trialMetrics({
    attempt: t.attempt,
    existing: t.metrics,
    costMicroUsd: t.costMicroUsd,
    edges,
    gate: t.gate,
    proxy,
    ...(opts.gateMetrics ? { gateMetrics: opts.gateMetrics } : {}),
  });
  const moved = await db
    .update(trials)
    .set({ metrics: m.metrics, costMicroUsd: m.costMicroUsd, updatedAt: sql`now()` })
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
