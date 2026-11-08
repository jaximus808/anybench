// Kit routes (TDM-67, contract core apiRoutes.kits). Mounted at /kits.
//   GET  /kits                 the caller's kit versions, newest first (optionally one run's)
//   GET  /kits/:id             one version: spec, proof results, repairs used
//   POST /kits/validate        validate a parsed anybench.yaml (core safeParseKitSpec); never stores
//   POST /kits/:id/versions    save an edited spec as a new version of that kit's run
//   GET  /kits/:id/download    501 until uploads ([7.4]) can presign the kit folder
//
// Editing a kit (here, or PATCH /runs/:id/kit in runs.ts) is allowed only while the run is in
// `kit_draft` or `awaiting_go` (else 409). The new version starts with no proof results, so it is
// not proven: the run's `kit_id` moves to it, `run.advance {reason: "kit_edited"}` is enqueued so
// the orchestrator ([5.9]) reruns the six proof checks, and POST /runs/:id/go refuses (409) until
// they pass. The run state is not changed: the state machine has no edge from `awaiting_go` back
// to `proof`, so the gate lives on Go.
//
// Every read and write runs through scopedDb(actor): RLS hides other users' kits, so a foreign
// kit id is a 404.
import { createHash } from "node:crypto";
import {
  apiRoutes,
  formatSchemaIssues,
  KitIdSchema,
  newId,
  PROOF_CHECKS,
  ProofCheckResultSchema,
  safeParseKitSpec,
  type KitDetail,
  type KitSpec,
  type KitSummary,
  type ProofCheckResult,
  type RunState,
} from "@anybench/core";
import { and, desc, eq, max, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { DbTx } from "../db/client.js";
import { events } from "../db/schema/events.js";
import { kits } from "../db/schema/kits.js";
import { runs } from "../db/schema/runs.js";
import { scopedDb } from "../db/scoped.js";
import {
  decodeCursor,
  encodeCursor,
  fail,
  iso,
  parseOrFail,
  send,
  withActor,
  type ActorContext,
  type ActorEnv,
  type RouteActor,
} from "../lib/api-route.js";
import type { JobQueue } from "../lib/job-queue.js";
import { RUN_ADVANCE_JOB, type RunAdvancePayload } from "../jobs/run-advance.js";
import type { AppDeps } from "../types.js";

const contract = apiRoutes.kits;

/** Run states in which a kit may be edited. */
export const KIT_EDITABLE_STATES = ["kit_draft", "awaiting_go"] as const satisfies RunState[];

type KitRow = typeof kits.$inferSelect;

/** Canonical JSON (sorted keys, no whitespace): the hash input for a spec-only kit version. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** sha256 of the canonical spec. The folder tree hash replaces it once kit files are uploaded. */
export function kitSpecHash(spec: KitSpec): string {
  return createHash("sha256").update(canonicalJson(spec), "utf8").digest("hex");
}

/** The stored proof results, or [] when none (or unreadable). */
export function proofOf(raw: unknown): ProofCheckResult[] {
  const r = z.array(ProofCheckResultSchema).safeParse(raw);
  return r.success ? r.data : [];
}

/** Proven = every one of the six proof checks has a passing result. */
export function isProven(raw: unknown): boolean {
  const proof = proofOf(raw);
  return PROOF_CHECKS.every((check) => proof.some((p) => p.check === check && p.pass));
}

function kitName(spec: unknown): string {
  const r = z.object({ subject: z.object({ name: z.string().min(1) }) }).safeParse(spec);
  return r.success ? r.data.subject.name : "kit";
}

export function toKitSummary(row: KitRow): KitSummary {
  return {
    id: row.id as KitSummary["id"],
    run_id: row.runId as KitSummary["run_id"],
    version: row.version,
    name: kitName(row.spec),
    hash: row.hash,
    proven: isProven(row.proof),
    created_at: iso(row.createdAt),
  };
}

/** Proof repairs so far: `run.state_changed` events with command `repair` (proof → kit_draft). */
async function repairsOf(tx: DbTx, runId: string): Promise<number> {
  const [row] = await tx
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
}

export async function toKitDetail(tx: DbTx, row: KitRow): Promise<KitDetail> {
  return {
    ...toKitSummary(row),
    spec: row.spec as KitSpec,
    proof: proofOf(row.proof),
    repairs: await repairsOf(tx, row.runId),
  };
}

// ---------------------------------------------------------------------------------------------
// New kit version (shared with PATCH /runs/:id/kit)

export type NewKitVersionResult =
  { ok: true; kit: KitDetail } | { ok: false; code: "not_found" | "conflict"; message: string };

/**
 * Store `spec` as the next version of `runId`'s kit and point the run at it. Locks the run row,
 * so concurrent edits get consecutive versions. The caller enqueues the proof rerun after commit.
 */
export async function insertKitVersion(
  tx: DbTx,
  actor: RouteActor,
  runId: string,
  spec: KitSpec,
  filesUploadId: string | undefined,
): Promise<NewKitVersionResult> {
  const [run] = await tx
    .select({ id: runs.id, state: runs.state, ownerId: runs.ownerId })
    .from(runs)
    .where(eq(runs.id, runId))
    .for("update")
    .limit(1);
  if (!run) return { ok: false, code: "not_found", message: "run not found" };
  if (!(KIT_EDITABLE_STATES as readonly RunState[]).includes(run.state)) {
    return {
      ok: false,
      code: "conflict",
      message: `the kit can only be edited in ${KIT_EDITABLE_STATES.join(" or ")}; the run is ${run.state}`,
    };
  }
  const [last] = await tx
    .select({ v: max(kits.version) })
    .from(kits)
    .where(eq(kits.runId, runId));
  const [row] = await tx
    .insert(kits)
    .values({
      id: newId(KitIdSchema),
      ownerId: actor.userId,
      runId,
      version: (last?.v ?? 0) + 1,
      spec,
      // [7.4] resolves `upload:<id>` to the stored kit folder and replaces the hash with its tree hash.
      filesUrl: filesUploadId ? `upload:${filesUploadId}` : null,
      proof: null,
      hash: kitSpecHash(spec),
    })
    .returning();
  await tx
    .update(runs)
    .set({ kitId: row!.id, updatedAt: sql`now()` })
    .where(eq(runs.id, runId));
  return { ok: true, kit: await toKitDetail(tx, row!) };
}

/** Wake the orchestrator to rerun proof on a new kit version. Logged, never thrown. */
export async function enqueueKitProof(
  jobs: JobQueue,
  c: ActorContext,
  runId: string,
  kitId: string,
): Promise<void> {
  const payload: RunAdvancePayload = { run_id: runId, reason: "kit_edited", kit_id: kitId };
  try {
    await jobs.add(RUN_ADVANCE_JOB, payload, { jobKey: `kits:${kitId}:1` });
  } catch (err) {
    c.get("log").error({ err, runId, kitId }, "could not enqueue run.advance after a kit edit");
  }
}

/** `spec` lines for an invalid kit, prefixed like parseRouteRequest's (`body.spec.repeats: ...`). */
export function kitSpecIssues(
  spec: unknown,
): { ok: true; spec: KitSpec } | { ok: false; issues: string[] } {
  const r = safeParseKitSpec(spec);
  return r.success
    ? { ok: true, spec: r.data }
    : { ok: false, issues: formatSchemaIssues(r.error).map((l) => `body.spec.${l}`) };
}

// ---------------------------------------------------------------------------------------------

export function kitsRoutes(deps: AppDeps & { jobs: JobQueue }): Hono<ActorEnv> {
  const r = new Hono<ActorEnv>();
  r.use(withActor(deps));

  r.get("/", async (c) => {
    const route = contract.list;
    const parsed = await parseOrFail(c, route);
    if (!parsed.ok) return parsed.response;
    const { query } = parsed.request;
    const cursor = decodeCursor(query.cursor);
    if (cursor === null)
      return fail(c, "validation_failed", "invalid cursor", ["query.cursor: invalid cursor"]);
    const where: SQL[] = [];
    if (query.run_id) where.push(eq(kits.runId, query.run_id));
    if (cursor)
      where.push(
        sql`(${kits.createdAt}, ${kits.id}) < (${cursor.c}::timestamptz, ${cursor.i}::uuid)`,
      );
    const rows = await scopedDb(c.get("actor"), deps.db).transaction((tx) =>
      tx
        .select({ kit: kits, c: sql<string>`${kits.createdAt}::text` })
        .from(kits)
        .where(where.length ? and(...where) : undefined)
        .orderBy(desc(kits.createdAt), desc(kits.id))
        .limit(query.limit + 1),
    );
    const more = rows.length > query.limit;
    const page = more ? rows.slice(0, query.limit) : rows;
    const last = page[page.length - 1];
    return send(c, route, {
      items: page.map((p) => toKitSummary(p.kit)),
      next_cursor: more && last ? encodeCursor({ c: last.c, i: last.kit.id }) : null,
    });
  });

  r.post("/validate", async (c) => {
    const route = contract.validate;
    const parsed = await parseOrFail(c, route);
    if (!parsed.ok) return parsed.response;
    const result = safeParseKitSpec(parsed.request.body.spec);
    return send(
      c,
      route,
      result.success ? { ok: true, spec: result.data } : { ok: false, issues: result.errors },
    );
  });

  r.get("/:id", async (c) => {
    const route = contract.get;
    const parsed = await parseOrFail(c, route);
    if (!parsed.ok) return parsed.response;
    const detail = await scopedDb(c.get("actor"), deps.db).transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(kits)
        .where(eq(kits.id, parsed.request.params.id))
        .limit(1);
      return row ? toKitDetail(tx, row) : undefined;
    });
    if (!detail) return fail(c, "not_found", "kit not found");
    return send(c, route, { kit: detail });
  });

  r.post("/:id/versions", async (c) => {
    const route = contract.createVersion;
    const parsed = await parseOrFail(c, route);
    if (!parsed.ok) return parsed.response;
    const { params, body } = parsed.request;
    const actor = c.get("actor");
    const result = await scopedDb(actor, deps.db).transaction(
      async (tx): Promise<NewKitVersionResult> => {
        const [base] = await tx
          .select({ runId: kits.runId })
          .from(kits)
          .where(eq(kits.id, params.id))
          .limit(1);
        if (!base) return { ok: false, code: "not_found", message: "kit not found" };
        return insertKitVersion(tx, actor, base.runId, body.spec, body.files_upload_id);
      },
    );
    if (!result.ok) return fail(c, result.code, result.message);
    await enqueueKitProof(deps.jobs, c, result.kit.run_id, result.kit.id);
    return send(c, route, { kit: result.kit });
  });

  r.get("/:id/download", async (c) => {
    const parsed = await parseOrFail(c, contract.download);
    if (!parsed.ok) return parsed.response;
    const found = await scopedDb(c.get("actor"), deps.db).transaction(async (tx) => {
      const [row] = await tx
        .select({ id: kits.id })
        .from(kits)
        .where(eq(kits.id, parsed.request.params.id))
        .limit(1);
      return row !== undefined;
    });
    if (!found) return fail(c, "not_found", "kit not found");
    return fail(c, "not_implemented", "kit download needs the artifact store (uploads, [7.4])");
  });

  return r;
}
