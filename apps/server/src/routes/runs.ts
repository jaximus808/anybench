// Run routes (TDM-67, contract core apiRoutes.runs). Mounted at /runs, next to the events router.
//   GET   /runs              the caller's runs, newest first (keyset cursor), optional ?state=a,b
//   POST  /runs              create a project + a run at `intake`, write `run.state_changed`
//                            {from: null, to: intake} in the same transaction, enqueue run.advance
//   GET   /runs/:id          run + counters + open alerts + agent sessions
//   PATCH /runs/:id/kit      runs.editKit: edit the run's kit (same as kits.createVersion; see kits.ts)
//   POST  /runs/:id/go       leave awaiting_go: proven kit, estimate within budget, billing gate
//   POST  /runs/:id/cancel   set cancel_requested_at, move to cancelled, write the event
//   GET   /runs/:id/contenders  runs.contenders: every candidate, kept or dropped, with its spec
//   GET   /runs/:id/agents      runs.agents: the run's Naïve agent sessions (agent_sessions)
//
// The API never runs ingest or agents: it persists and enqueues `run.advance` (job key
// `runs:<id>:<step>`) in the SAME transaction as the write (lib/job-queue.ts), so a run is never
// created or moved without its job; the orchestrator ([5.9]) does the work.
//
// Idempotency-Key: stored in runs.intake and unique per owner (runs_owner_idempotency_key_uq,
// migration 0003). A retry finds the prior run; two concurrent creates race on the index and the
// loser re-reads the winner's run. Either way the response is the run the key first created.
//
// Body limits (hono/body-limit, 413 ApiErrorBody `payload_too_large`): POST /runs 256 KiB,
// PATCH /runs/:id/kit 1 MiB.
//
// Tenancy: every read and write goes through scopedDb(actor), so RLS limits a user to their own
// runs and a foreign or unknown run id is a 404 (no existence leak).
// Auth (TDM-66 requireScope): GET routes need `runs:read`, writes need `runs:write`; a key limited
// to specific runs gets 403 on any other run id, only lists its own runs, and cannot create runs.
//
// Go and the billing gate: `deps.billingGate(actor, estimate)` (lib/billing-gate.ts). Its default
// allows only under BILLING_MODE=off; in test/live it answers the contract's 402
// `{reason, link_card_url}` until the real gate ([10.6]) is passed in AppDeps.
import {
  AlertIdSchema,
  apiRoutes,
  ContenderSchema,
  isTerminalRunState,
  KitIdSchema,
  newId,
  PendingActionSchema,
  ProjectIdSchema,
  RunIdSchema,
  toJsonValue,
  transitionRun,
  UserIdSchema,
  type AgentSession,
  type Alert,
  type AnybenchEvent,
  type PaymentRequired,
  type Run,
  type RunCommand,
  type RunContender,
  type RunDetail,
  type RunSource,
  type RunState,
} from "@anybench/core";
import { and, desc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import type { DbTx } from "../db/client.js";
import { RUNS_IDEMPOTENCY_INDEX } from "../db/schema/runs.js";
import { agentSessions } from "../db/schema/agent_sessions.js";
import { alerts } from "../db/schema/alerts.js";
import { contenders } from "../db/schema/contenders.js";
import { kits } from "../db/schema/kits.js";
import { projects } from "../db/schema/projects.js";
import { runs } from "../db/schema/runs.js";
import { trials } from "../db/schema/trials.js";
import { scopedDb } from "../db/scoped.js";
import {
  decodeCursor,
  encodeCursor,
  bodyLimitOf,
  fail,
  isUniqueViolation,
  iso,
  isoOrNull,
  parseOrFail,
  send,
  runLimited,
  type ActorEnv,
  type RouteActor,
} from "../lib/api-route.js";
import { requireScope, runIdsOf } from "../lib/auth-key.js";
import type { BillingGate } from "../lib/billing-gate.js";
import { appendEvents } from "../lib/events.js";
import type { JobQueue } from "../lib/job-queue.js";
import { RUN_ADVANCE_JOB, type RunAdvancePayload } from "../jobs/run-advance.js";
import { proofAccepted } from "../orchestrator/proof-score.js";
import type { AppDeps } from "../types.js";
import {
  insertKitVersion,
  KIT_BODY_LIMIT_BYTES,
  kitSpecHash,
  kitSpecIssues,
  type NewKitVersionResult,
} from "./kits.js";

/** POST /runs body limit. */
export const CREATE_RUN_BODY_LIMIT_BYTES = 256 * 1024;

const contract = apiRoutes.runs;

export type RunsRouteDeps = AppDeps & { jobs: JobQueue; billingGate: BillingGate };

type RunRow = typeof runs.$inferSelect;

export function toRun(row: RunRow): Run {
  return {
    id: row.id as Run["id"],
    project_id: (row.projectId ?? null) as Run["project_id"],
    question: row.question,
    state: row.state,
    budget_micro_usd: row.budgetMicroUsd,
    spent_micro_usd: row.spentMicroUsd,
    estimate_micro_usd: row.estimateMicroUsd ?? null,
    kit_id: (row.kitId ?? null) as Run["kit_id"],
    paused_reason: row.pausedReason ?? null,
    cancel_requested_at: isoOrNull(row.cancelRequestedAt),
    comped: row.compedBy !== null,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
  };
}

function stateChanged(
  runId: string,
  actor: RouteActor,
  from: RunState | null,
  to: RunState,
  extra: { command?: RunCommand["type"]; reason?: string } = {},
): AnybenchEvent {
  return {
    run_id: runId,
    seq: 0,
    type: "run.state_changed",
    source: "run",
    source_id: runId,
    severity: "info",
    actor: { kind: "user", id: actor.userId },
    cost_delta_micro_usd: 0n,
    at: new Date().toISOString(),
    payload: { from, to, ...extra },
  };
}

/** Enqueue run.advance in `tx` (the last statement of the write it belongs to). */
async function enqueueAdvance(
  deps: RunsRouteDeps,
  tx: DbTx,
  payload: RunAdvancePayload,
  step: string,
): Promise<void> {
  await deps.jobs.add(tx, RUN_ADVANCE_JOB, payload, { jobKey: `runs:${payload.run_id}:${step}` });
}

async function lockRun(tx: DbTx, id: string): Promise<RunRow | undefined> {
  const [row] = await tx.select().from(runs).where(eq(runs.id, id)).for("update").limit(1);
  return row;
}

// ---------------------------------------------------------------------------------------------
// Create

function githubUrl(github: string): string {
  const path = github
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/^github\.com\//, "")
    .replace(/\.git$/, "");
  return `https://github.com/${path}`;
}

function projectOf(source: Exclude<RunSource, { kind: "kit" }>): {
  source: string;
  url: string | null;
} {
  switch (source.kind) {
    case "github":
      return { source: "github", url: githubUrl(source.github) };
    case "binary":
      return { source: "binary", url: source.binary_url ?? null };
    case "claude_setup":
      return { source: "claude_setup", url: null };
  }
}

// ---------------------------------------------------------------------------------------------
// Detail

/** Trial states counted as "running now" on the live page (everything between queued and an end). */
const TRIAL_END_STATES = ["done", "failed_infra", "failed_subject", "cancelled"] as const;
const AGENT_STATUSES = ["queued", "running", "waiting", "done", "failed", "cancelled"] as const;
const AGENT_ENDED = new Set<string>(["done", "failed", "cancelled"]);

function agentStatus(raw: string): AgentSession["status"] {
  return (AGENT_STATUSES as readonly string[]).includes(raw)
    ? (raw as AgentSession["status"])
    : "queued"; // the table's default is `pending`
}

function toAgentSession(row: typeof agentSessions.$inferSelect, runId: string): AgentSession {
  const status = agentStatus(row.status);
  const pending = PendingActionSchema.safeParse(row.pendingAction);
  return {
    id: row.id as AgentSession["id"],
    run_id: runId as AgentSession["run_id"],
    role: row.role,
    status,
    budget_micro_usd: row.budgetMicroUsd,
    cost_micro_usd: row.costMicroUsd,
    last_tool: null,
    stop_reason: row.stopReason ?? null,
    pending_action: pending.success ? pending.data : null,
    started_at: status === "queued" ? null : iso(row.createdAt),
    ended_at: AGENT_ENDED.has(status) ? iso(row.updatedAt) : null,
  };
}

function toAlert(row: typeof alerts.$inferSelect): Alert {
  const payload =
    row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
      ? (row.payload as Record<string, unknown>)
      : {};
  const ackedBy = UserIdSchema.safeParse(row.ackedBy);
  return {
    id: AlertIdSchema.parse(row.id),
    rule_key: row.ruleKey,
    fingerprint: row.fingerprint,
    run_id: (row.runId ?? null) as Alert["run_id"],
    severity: row.severity,
    status: row.status,
    message: typeof payload.message === "string" ? payload.message : row.ruleKey,
    first_seen: iso(row.firstSeen),
    last_seen: iso(row.lastSeen),
    count: Math.max(1, row.count),
    acked_by: ackedBy.success ? ackedBy.data : null,
    resolved_at: isoOrNull(row.resolvedAt),
    auto_action: null,
    payload,
  };
}

async function runDetail(tx: DbTx, row: RunRow): Promise<RunDetail> {
  const counts = await tx
    .select({ state: trials.state, n: sql<number>`count(*)::int` })
    .from(trials)
    .where(eq(trials.runId, row.id))
    .groupBy(trials.state);
  const n = (pred: (s: string) => boolean) =>
    counts.filter((r) => pred(r.state)).reduce((a, r) => a + r.n, 0);
  const openAlerts = await tx
    .select()
    .from(alerts)
    .where(and(eq(alerts.runId, row.id), ne(alerts.status, "resolved")))
    .orderBy(desc(alerts.lastSeen));
  const agents = await tx
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.runId, row.id))
    .orderBy(agentSessions.createdAt);
  const end = isTerminalRunState(row.state) ? row.updatedAt.getTime() : Date.now();
  return {
    run: toRun(row),
    counters: {
      trials_total: n(() => true),
      trials_done: n((s) => s === "done"),
      trials_running: n(
        (s) => s !== "queued" && !(TRIAL_END_STATES as readonly string[]).includes(s),
      ),
      trials_failed: n((s) => s === "failed_infra" || s === "failed_subject"),
      spent_micro_usd: row.spentMicroUsd,
      projected_micro_usd: row.estimateMicroUsd ?? null,
      elapsed_s: Math.max(0, Math.floor((end - row.createdAt.getTime()) / 1000)),
      eta_s: null,
      last_seq: Math.max(0, row.nextSeq - 1),
    },
    open_alerts: openAlerts.map(toAlert),
    agents: agents.map((a) => toAgentSession(a, row.id)),
  };
}

// ---------------------------------------------------------------------------------------------
// Contenders

/**
 * contenders.source is the JSON of the kit contender (runs.create writes it) or, for a candidate
 * an agent found, a free-form source string. Only a valid core Contender becomes `spec`.
 */
function toRunContender(row: typeof contenders.$inferSelect): RunContender {
  let spec: RunContender["spec"] = null;
  try {
    const parsed = ContenderSchema.safeParse(JSON.parse(row.source));
    if (parsed.success) spec = parsed.data;
  } catch {
    // not JSON: a free-form source
  }
  const role = ContenderSchema.shape.role.safeParse(row.role);
  return {
    id: row.id as RunContender["id"],
    kit_id: (row.kitId ?? null) as RunContender["kit_id"],
    name: spec?.name ?? spec?.id ?? row.source.slice(0, 200),
    role: spec?.role ?? (role.success ? role.data : "competitor"),
    status: row.status,
    reason: row.reason ?? null,
    found_by: row.foundBy ?? null,
    spec,
  };
}

// ---------------------------------------------------------------------------------------------
// Go

type GoCheck = { ok: true; estimate: bigint } | { ok: false; status: 404 | 409; message: string };

/** Everything Go needs except billing: state, a proven kit, an estimate within the budget. */
async function goCheck(tx: DbTx, run: RunRow | undefined): Promise<GoCheck> {
  if (!run) return { ok: false, status: 404, message: "run not found" };
  if (run.state !== "awaiting_go") {
    const t = transitionRun(run.state, {
      type: "go",
      estimate_fits_budget: true,
      billing_gate_passed: true,
    });
    return { ok: false, status: 409, message: t.ok ? "run is not awaiting go" : t.error.message };
  }
  // No speed or quality number without a correctness gate: Go needs all six proof checks passed,
  // or a curated kit's signed-off offline proof accepted for this kit (stage_outputs.proof_basis).
  const [kit] = run.kitId
    ? await tx
        .select({ id: kits.id, proof: kits.proof })
        .from(kits)
        .where(eq(kits.id, run.kitId))
        .limit(1)
    : [];
  if (!kit || !proofAccepted(kit, run.stageOutputs)) {
    return { ok: false, status: 409, message: "the run's kit has not passed all six proof checks" };
  }
  if (run.estimateMicroUsd === null) {
    return { ok: false, status: 409, message: "the run has no cost estimate yet" };
  }
  const fits = run.estimateMicroUsd <= run.budgetMicroUsd;
  if (!fits) {
    const t = transitionRun(run.state, {
      type: "go",
      estimate_fits_budget: false,
      billing_gate_passed: true,
    });
    return {
      ok: false,
      status: 409,
      message: t.ok ? "estimate exceeds the run budget" : t.error.message,
    };
  }
  return { ok: true, estimate: run.estimateMicroUsd };
}

// ---------------------------------------------------------------------------------------------

export function runsRoutes(deps: RunsRouteDeps): Hono<ActorEnv> {
  const r = new Hono<ActorEnv>();
  // Per route, not r.use: this router shares the /runs mount with the events router.
  const read = requireScope(deps, "runs:read");
  const write = requireScope(deps, "runs:write");
  const readRun = requireScope(deps, "runs:read", { runIdParam: "id" });
  const writeRun = requireScope(deps, "runs:write", { runIdParam: "id" });

  r.get("/", read, async (c) => {
    const route = contract.list;
    const parsed = await parseOrFail(c, route);
    if (!parsed.ok) return parsed.response;
    const { query } = parsed.request;
    const cursor = decodeCursor(query.cursor);
    if (cursor === null)
      return fail(c, "validation_failed", "invalid cursor", ["query.cursor: invalid cursor"]);
    const where: SQL[] = [];
    // A run-scoped API key lists only its own runs (RLS already limits it to the owner's).
    const allowed = runIdsOf(c.get("actor"));
    if (allowed !== null && allowed.length === 0)
      return send(c, route, { items: [], next_cursor: null });
    if (allowed !== null) where.push(inArray(runs.id, [...allowed]));
    if (query.state) where.push(inArray(runs.state, query.state));
    if (cursor)
      where.push(
        sql`(${runs.createdAt}, ${runs.id}) < (${cursor.c}::timestamptz, ${cursor.i}::uuid)`,
      );
    const rows = await scopedDb(c.get("actor"), deps.db).transaction((tx) =>
      tx
        .select({ run: runs, c: sql<string>`${runs.createdAt}::text` })
        .from(runs)
        .where(where.length ? and(...where) : undefined)
        .orderBy(desc(runs.createdAt), desc(runs.id))
        .limit(query.limit + 1),
    );
    const more = rows.length > query.limit;
    const page = more ? rows.slice(0, query.limit) : rows;
    const last = page[page.length - 1];
    return send(c, route, {
      items: page.map((p) => toRun(p.run)),
      next_cursor: more && last ? encodeCursor({ c: last.c, i: last.run.id }) : null,
    });
  });

  r.post("/", bodyLimitOf(CREATE_RUN_BODY_LIMIT_BYTES), write, async (c) => {
    const route = contract.create;
    if (runLimited(c.get("actor")))
      return fail(c, "forbidden", "an API key limited to specific runs cannot create runs");
    const parsed = await parseOrFail(c, route, {
      "idempotency-key": c.req.header("idempotency-key"),
    });
    if (!parsed.ok) return parsed.response;
    const { body, headers } = parsed.request;
    const actor = c.get("actor");
    const idempotencyKey = headers["idempotency-key"];

    const scoped = scopedDb(actor, deps.db);
    const priorRun = (tx: DbTx, key: string) =>
      tx
        .select()
        .from(runs)
        .where(sql`${runs.intake}->>'idempotency_key' = ${key}`)
        .limit(1);

    type Created = { run: RunRow } | { notFound: string };
    const create = () =>
      scoped.transaction(async (tx): Promise<Created> => {
        if (idempotencyKey) {
          // A retried create with the same key returns the run it made (RLS: this owner's runs).
          const [prior] = await priorRun(tx, idempotencyKey);
          if (prior) return { run: prior };
        }

        const runId = newId(RunIdSchema);
        let projectId: string | null;
        let rerun: { kitId: string; spec: unknown; filesUrl: string | null } | undefined;
        if (body.source.kind === "kit") {
          // Rerun a saved kit: same project, the kit copied as version 1 of the new run.
          const [k] = await tx
            .select({ spec: kits.spec, filesUrl: kits.filesUrl, projectId: runs.projectId })
            .from(kits)
            .innerJoin(runs, eq(runs.id, kits.runId))
            .where(eq(kits.id, body.source.kit_id))
            .limit(1);
          if (!k) return { notFound: "kit not found" };
          projectId = k.projectId;
          rerun = { kitId: body.source.kit_id, spec: k.spec, filesUrl: k.filesUrl };
        } else {
          projectId = newId(ProjectIdSchema);
          await tx
            .insert(projects)
            .values({ id: projectId, ownerId: actor.userId, ...projectOf(body.source) });
        }

        const intake = {
          source: body.source,
          contenders: body.contenders,
          auto_go: body.auto_go,
          ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
        };
        const [run] = await tx
          .insert(runs)
          .values({
            id: runId,
            ownerId: actor.userId,
            projectId,
            question: body.question,
            state: "intake",
            budgetMicroUsd: body.budget_micro_usd,
            intake: toJsonValue(intake),
          })
          .returning();
        let row = run!;

        if (rerun) {
          const spec = kitSpecIssues(rerun.spec);
          if (!spec.ok) throw new Error(`stored kit ${rerun.kitId} no longer validates`);
          const [kit] = await tx
            .insert(kits)
            .values({
              id: newId(KitIdSchema),
              ownerId: actor.userId,
              runId,
              version: 1,
              spec: toJsonValue(spec.spec),
              filesUrl: rerun.filesUrl,
              proof: null,
              hash: kitSpecHash(spec.spec),
            })
            .returning({ id: kits.id });
          const [withKit] = await tx
            .update(runs)
            .set({ kitId: kit!.id })
            .where(eq(runs.id, runId))
            .returning();
          row = withKit!;
        }

        if (body.contenders.length > 0) {
          // runs.intake.contenders is the canonical copy of what the user asked for; these rows
          // only list the candidates for the test plan screen, and `source` is never parsed back.
          await tx.insert(contenders).values(
            body.contenders.map((ct) => ({
              runId,
              source: JSON.stringify(toJsonValue(ct)),
              role: ct.role,
              status: "kept" as const,
              foundBy: "user",
            })),
          );
        }

        // Creation is the one edge with no prior state: {from: null, to: intake}.
        const { lastSeq } = await appendEvents(tx, row.id as Run["id"], [
          stateChanged(row.id, actor, null, "intake", { reason: "created" }),
        ]);
        await enqueueAdvance(deps, tx, { run_id: row.id, reason: "created" }, "created");
        return { run: { ...row, nextSeq: lastSeq + 1 } };
      });

    let created: Created;
    try {
      created = await create();
    } catch (err) {
      // A concurrent create with the same key won the unique index: return its run.
      if (!idempotencyKey || !isUniqueViolation(err, RUNS_IDEMPOTENCY_INDEX)) throw err;
      const [prior] = await scoped.transaction((tx) => priorRun(tx, idempotencyKey));
      if (!prior) throw err;
      created = { run: prior };
    }
    if ("notFound" in created) return fail(c, "not_found", created.notFound);
    return send(c, route, { run: toRun(created.run) });
  });

  r.get("/:id", readRun, async (c) => {
    const route = contract.get;
    const parsed = await parseOrFail(c, route);
    if (!parsed.ok) return parsed.response;
    const detail = await scopedDb(c.get("actor"), deps.db).transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(runs)
        .where(eq(runs.id, parsed.request.params.id))
        .limit(1);
      return row ? runDetail(tx, row) : undefined;
    });
    if (!detail) return fail(c, "not_found", "run not found");
    return send(c, route, detail);
  });

  // runs.editKit: kits.createVersion addressed by run, which also works before the run has a kit
  // (it creates version 1). Same body, response and rules (see kits.ts).
  r.patch("/:id/kit", bodyLimitOf(KIT_BODY_LIMIT_BYTES), writeRun, async (c) => {
    const route = contract.editKit;
    const parsed = await parseOrFail(c, route);
    if (!parsed.ok) return parsed.response;
    const { params, body } = parsed.request;
    const actor = c.get("actor");
    const result: NewKitVersionResult = await scopedDb(actor, deps.db).transaction((tx) =>
      insertKitVersion(tx, actor, deps.jobs, params.id, body.spec, body.files_upload_id),
    );
    if (!result.ok) return fail(c, result.code, result.message);
    return send(c, route, { kit: result.kit });
  });

  r.post("/:id/go", writeRun, async (c) => {
    const route = contract.go;
    const parsed = await parseOrFail(c, route);
    if (!parsed.ok) return parsed.response;
    const id = parsed.request.params.id;
    const actor = c.get("actor");
    const scoped = scopedDb(actor, deps.db);

    // 1. Read-only checks, then the billing gate outside any transaction (it may call Stripe).
    const first = await scoped.transaction(async (tx) => {
      const [row] = await tx.select().from(runs).where(eq(runs.id, id)).limit(1);
      return goCheck(tx, row);
    });
    if (!first.ok) return fail(c, first.status === 404 ? "not_found" : "conflict", first.message);
    const gate = await deps.billingGate({ userId: actor.userId }, first.estimate);
    if (!gate.allowed) {
      const body: PaymentRequired = { reason: gate.reason, link_card_url: gate.link_card_url };
      return c.json(route.errors[402].parse(body), 402);
    }

    // 2. Lock, re-check (the run may have moved meanwhile), transition, event.
    const moved = await scoped.transaction(async (tx) => {
      const row = await lockRun(tx, id);
      const again = await goCheck(tx, row);
      if (!again.ok) return again;
      const t = transitionRun(row!.state, {
        type: "go",
        estimate_fits_budget: true,
        billing_gate_passed: true,
      });
      if (!t.ok) return { ok: false as const, status: 409 as const, message: t.error.message };
      const [updated] = await tx
        .update(runs)
        .set({ state: t.to, updatedAt: sql`now()` })
        .where(eq(runs.id, id))
        .returning();
      const { lastSeq } = await appendEvents(tx, id, [
        stateChanged(id, actor, t.from, t.to, { command: "go" }),
      ]);
      await enqueueAdvance(deps, tx, { run_id: id, reason: "go" }, "go");
      return { ok: true as const, run: { ...updated!, nextSeq: lastSeq + 1 } };
    });
    if (!moved.ok) return fail(c, moved.status === 404 ? "not_found" : "conflict", moved.message);
    return send(c, route, { run: toRun(moved.run) });
  });

  r.post("/:id/cancel", writeRun, async (c) => {
    const route = contract.cancel;
    const parsed = await parseOrFail(c, route);
    if (!parsed.ok) return parsed.response;
    const { params, body } = parsed.request;
    const actor = c.get("actor");
    type Cancelled = { ok: true; run: RunRow } | { ok: false; status: 404 | 409; message: string };
    const result = await scopedDb(actor, deps.db).transaction(async (tx): Promise<Cancelled> => {
      const row = await lockRun(tx, params.id);
      if (!row) return { ok: false, status: 404, message: "run not found" };
      if (row.state === "cancelled") return { ok: true, run: row }; // idempotent
      const t = transitionRun(row.state, {
        type: "cancel",
        ...(body.reason ? { reason: body.reason } : {}),
      });
      if (!t.ok) return { ok: false, status: 409, message: t.error.message };
      const [updated] = await tx
        .update(runs)
        .set({
          state: t.to,
          cancelRequestedAt: sql`coalesce(${runs.cancelRequestedAt}, now())`,
          // The user asked (billing [10.12] bills the compute already used; a kill switch is `ours`).
          cancelCause: sql`coalesce(${runs.cancelCause}, 'user')`,
          updatedAt: sql`now()`,
        })
        .where(eq(runs.id, params.id))
        .returning();
      const { lastSeq } = await appendEvents(tx, params.id, [
        stateChanged(params.id, actor, t.from, t.to, {
          command: "cancel",
          ...(body.reason ? { reason: body.reason } : {}),
        }),
      ]);
      // The orchestrator (jobs/run-advance.ts) stops live Naïve sessions and queued trials; running
      // trials see cancel_requested_at and stop themselves.
      await enqueueAdvance(deps, tx, { run_id: params.id, reason: "cancelled" }, "cancelled");
      return { ok: true, run: { ...updated!, nextSeq: lastSeq + 1 } };
    });
    if (!result.ok)
      return fail(c, result.status === 404 ? "not_found" : "conflict", result.message);
    return send(c, route, { run: toRun(result.run) });
  });

  // contenders and agent_sessions carry no owner_id: the run is read under RLS first, so a
  // foreign or unknown run is a 404 and only then are its children read by run_id.
  r.get("/:id/contenders", readRun, async (c) => {
    const route = contract.contenders;
    const parsed = await parseOrFail(c, route);
    if (!parsed.ok) return parsed.response;
    const id = parsed.request.params.id;
    const rows = await scopedDb(c.get("actor"), deps.db).transaction(async (tx) => {
      const [run] = await tx.select({ id: runs.id }).from(runs).where(eq(runs.id, id)).limit(1);
      if (!run) return null;
      return tx
        .select()
        .from(contenders)
        .where(eq(contenders.runId, id))
        .orderBy(contenders.createdAt, contenders.id);
    });
    if (!rows) return fail(c, "not_found", "run not found");
    return send(c, route, { items: rows.map(toRunContender) });
  });

  r.get("/:id/agents", readRun, async (c) => {
    const route = contract.agents;
    const parsed = await parseOrFail(c, route);
    if (!parsed.ok) return parsed.response;
    const id = parsed.request.params.id;
    const rows = await scopedDb(c.get("actor"), deps.db).transaction(async (tx) => {
      const [run] = await tx.select({ id: runs.id }).from(runs).where(eq(runs.id, id)).limit(1);
      if (!run) return null;
      return tx
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.runId, id))
        .orderBy(agentSessions.createdAt, agentSessions.id);
    });
    if (!rows) return fail(c, "not_found", "run not found");
    return send(c, route, { items: rows.map((a) => toAgentSession(a, id)) });
  });

  return r;
}
