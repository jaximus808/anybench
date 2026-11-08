// Trial read routes for the live run page (orchestrator fix, contract core apiRoutes.trials).
//   GET /runs/:id/trials   trials.list: the run's trials for the tile grid (keyset cursor, oldest
//                          first so the grid fills in creation order), optional ?state=a,b and
//                          ?contender_id=
//   GET /trials/:id        trials.get: one trial with machine info, metrics, gate and phases
//
// Tenancy: every read goes through scopedDb(actor); RLS on trials (owner + visible run) hides other
// tenants' rows, so a foreign or unknown id is a 404. A key limited to other runs is a 403.
//
// What comes back is ours, not the runner's word:
// - `gate` is trials.gate, which only the gate job writes; it is returned only when it parses as a
//   core GateResult. Metrics are raw collector readings (finite numbers only) and count toward a
//   score only when gate.pass is true: the report enforces that, this route just shows both.
// - Never a URL the runner sent: trials.logs_url is not returned, and string values that look like
//   URLs are dropped from `machine` and `versions` (both runner-reported).
import {
  apiRoutes,
  ComputeProviderNameSchema,
  FailureClassSchema,
  GateResultSchema,
  TrialStateSchema,
  type Trial,
  type TrialDetail,
} from "@anybench/core";
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { events } from "../db/schema/events.js";
import { runs } from "../db/schema/runs.js";
import { trials } from "../db/schema/trials.js";
import { scopedDb } from "../db/scoped.js";
import {
  decodeCursor,
  encodeCursor,
  fail,
  isoOrNull,
  iso,
  parseOrFail,
  runAllowed,
  send,
  type ActorEnv,
} from "../lib/api-route.js";
import { requireScope } from "../lib/auth-key.js";
import type { AppDeps } from "../types.js";

const contract = apiRoutes.trials;

type TrialRow = typeof trials.$inferSelect;

/** Any `scheme://...` string: never echo a link the eval computer reported. */
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Deep copy of runner-reported JSON without URL-looking strings. */
function withoutUrls(v: unknown): unknown {
  if (typeof v === "string") return URL_LIKE.test(v.trim()) ? undefined : v;
  if (Array.isArray(v)) return v.map(withoutUrls).filter((x) => x !== undefined);
  if (isRecord(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const y = withoutUrls(x);
      if (y !== undefined) out[k] = y;
    }
    return out;
  }
  return v;
}

function machineOf(raw: unknown): Record<string, unknown> | null {
  const m = withoutUrls(raw);
  return isRecord(m) ? m : null;
}

function metricsOf(raw: unknown): Record<string, number> | null {
  if (!isRecord(raw)) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** machine.versions as {name: version}, URL-looking values dropped. */
function versionsOf(machine: Record<string, unknown> | null): Record<string, string> {
  const raw = machine?.versions;
  const out: Record<string, string> = {};
  if (!isRecord(raw)) return out;
  for (const [k, v] of Object.entries(raw)) if (typeof v === "string") out[k] = v;
  return out;
}

export function toTrial(row: TrialRow): Trial {
  const failure = FailureClassSchema.safeParse(row.failureClass);
  return {
    id: row.id as Trial["id"],
    run_id: row.runId as Trial["run_id"],
    contender_id: row.contenderId as Trial["contender_id"],
    workload_id: row.workloadId,
    repeat: row.repeat,
    attempt: row.attempt,
    state: row.state,
    failure_class: failure.success ? failure.data : null,
    started_at: isoOrNull(row.startedAt),
    ended_at: isoOrNull(row.endedAt),
    cost_micro_usd: row.costMicroUsd,
  };
}

function toTrialDetail(row: TrialRow, phases: TrialDetail["phases"]): TrialDetail {
  const gate = GateResultSchema.safeParse(row.gate);
  const machine = machineOf(row.machine);
  const provider = ComputeProviderNameSchema.safeParse(row.provider);
  return {
    ...toTrial(row),
    computer_id: (row.computerId ?? null) as TrialDetail["computer_id"],
    provider: provider.success ? provider.data : null,
    exit_code: row.exitCode ?? null,
    log_offset: Math.max(0, row.logOffset),
    machine,
    metrics: metricsOf(row.metrics),
    gate: gate.success ? gate.data : null,
    versions: versionsOf(machine),
    phases,
  };
}

/** GET /runs/:id/trials. Mount at /runs. */
export function runTrialsRoutes(deps: AppDeps): Hono<ActorEnv> {
  const r = new Hono<ActorEnv>();
  const readRun = requireScope(deps, "runs:read", { runIdParam: "id" });

  r.get("/:id/trials", readRun, async (c) => {
    const route = contract.list;
    const parsed = await parseOrFail(c, route);
    if (!parsed.ok) return parsed.response;
    const { params, query } = parsed.request;
    const cursor = decodeCursor(query.cursor);
    if (cursor === null)
      return fail(c, "validation_failed", "invalid cursor", ["query.cursor: invalid cursor"]);
    const result = await scopedDb(c.get("actor"), deps.db).transaction(async (tx) => {
      // The run itself, under RLS: a foreign or unknown run is a 404, not an empty page.
      const [visible] = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.id, params.id))
        .limit(1);
      if (!visible) return null;
      const where: SQL[] = [eq(trials.runId, params.id)];
      if (query.state) where.push(inArray(trials.state, query.state));
      if (query.contender_id) where.push(eq(trials.contenderId, query.contender_id));
      if (cursor)
        where.push(
          sql`(${trials.createdAt}, ${trials.id}) > (${cursor.c}::timestamptz, ${cursor.i}::uuid)`,
        );
      return tx
        .select({ trial: trials, c: sql<string>`${trials.createdAt}::text` })
        .from(trials)
        .where(and(...where))
        .orderBy(asc(trials.createdAt), asc(trials.id))
        .limit(query.limit + 1);
    });
    if (!result) return fail(c, "not_found", "run not found");
    const more = result.length > query.limit;
    const page = more ? result.slice(0, query.limit) : result;
    const last = page[page.length - 1];
    return send(c, route, {
      items: page.map((p) => toTrial(p.trial)),
      next_cursor: more && last ? encodeCursor({ c: last.c, i: last.trial.id }) : null,
    });
  });

  return r;
}

/** GET /trials/:id. Mount at /trials. */
export function trialsRoutes(deps: AppDeps): Hono<ActorEnv> {
  const r = new Hono<ActorEnv>();
  const read = requireScope(deps, "runs:read");

  r.get("/:id", read, async (c) => {
    const route = contract.get;
    const parsed = await parseOrFail(c, route);
    if (!parsed.ok) return parsed.response;
    const id = parsed.request.params.id;
    const found = await scopedDb(c.get("actor"), deps.db).transaction(async (tx) => {
      const [row] = await tx.select().from(trials).where(eq(trials.id, id)).limit(1);
      if (!row) return null;
      // The drawer's phase timeline: this attempt's trial.phase events, in run order.
      const evs = await tx
        .select({ payload: events.payload, at: events.at })
        .from(events)
        .where(
          and(
            eq(events.runId, row.runId),
            eq(events.source, "trial"),
            eq(events.sourceId, row.id),
            eq(events.type, "trial.phase"),
          ),
        )
        .orderBy(asc(events.seq));
      const phases: TrialDetail["phases"] = [];
      for (const e of evs) {
        const p = isRecord(e.payload) ? e.payload : {};
        const to = TrialStateSchema.safeParse(p.to);
        if (!to.success) continue;
        if (typeof p.attempt === "number" && p.attempt !== row.attempt) continue;
        phases.push({ state: to.data, at: iso(e.at) });
      }
      return { row, phases };
    });
    if (!found) return fail(c, "not_found", "trial not found");
    if (!runAllowed(c.get("actor"), found.row.runId))
      return fail(c, "forbidden", "API key is not valid for this run");
    return send(c, route, { trial: toTrialDetail(found.row, found.phases) });
  });

  return r;
}
