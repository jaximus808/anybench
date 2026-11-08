// Runner ingest (TDM-47, plan.md P1 "In-VM runner" and section 5): what the in-VM runner posts with
// its per-trial bearer token. Implements the TDM-10 contract `apiRoutes.runner.*`
// (packages/core/src/api/runner.ts); mounted at /v1/trials.
//
//   POST /v1/trials/:id/events            one batch of AnybenchEvents + status.json
//   POST /v1/trials/:id/uploads           plan an upload of one frozen artifact
//   POST /v1/trials/:id/uploads/complete  finish it (ArtifactStore.completeUpload)
//
// Auth (lib/runner-token.ts): Bearer = HMAC(RUNNER_TOKEN_SECRET, trial id + attempt), checked
// against the trial's CURRENT attempt, and only while the trial is live (plus a short grace after it
// ends). Every auth failure is a 401, which the runner treats as fatal and goes file-only.
//
// Events: idempotent on (trial, attempt, batch_seq). The batch key is inserted into webhook_inbox
// (provider "runner", event_id = the Idempotency-Key) in the SAME transaction as the event rows,
// so a retried batch is a 409 (accepted by the runner) and is never written twice, and a batch
// whose write failed leaves no key behind and can be retried. Events go through appendEvents
// (lib/events.ts, TDM-72) on that transaction, with a redactor for the runner token and the
// server's secrets; it is called last so the run row it locks is held only until commit. A batch carrying a `trial.heartbeat` extends trials.lease_until (now + 90 s, by the
// DB clock) and records the heartbeat's log_offset (stdout+stderr bytes) in trials.log_offset;
// the runner's events.jsonl offset and live log chunk counters are kept on the inbox row.
// Trial state edges in the batch are written as events only; the trial executor applies them.
import {
  apiError,
  API_ERROR_STATUS,
  apiRoutes,
  encodeRouteResponse,
  parseRouteRequest,
  createRedactor,
  runnerIdempotencyKey,
  RunIdSchema,
  TrialIdSchema,
  type AnybenchEvent,
  type AnybenchEventOf,
  type AnybenchEventType,
  type TrialState,
  type ApiErrorCode,
  type RunId,
  type RouteResult,
  type RouteSpec,
} from "@anybench/core";
import {
  ArtifactTransferError,
  artifactNameSchema,
  DEFAULT_PART_BYTES,
  MULTIPART_THRESHOLD_BYTES,
  planParts,
  trialArtifactKey,
  type UploadPlan,
} from "@anybench/envs";
import { eq, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { configSecrets } from "../config.js";
import type { DbTx } from "../db/client.js";
import { kits } from "../db/schema/kits.js";
import { runs } from "../db/schema/runs.js";
import { trials } from "../db/schema/trials.js";
import { webhookInbox } from "../db/schema/webhook_inbox.js";
import { scopedDb } from "../db/scoped.js";
import { appendEvents, EventValidationError, type AppendEventsOptions } from "../lib/events.js";
import { bearerToken, checkRunnerTokenLive, verifyRunnerToken } from "../lib/runner-token.js";
import type { AppDeps, AppEnv } from "../types.js";

/** `appendEvents` from lib/events.ts (TDM-72): validates, redacts, assigns run-wide seqs. */
export interface EventsWriter {
  append(
    db: DbTx,
    runId: RunId,
    events: AnybenchEvent[],
    options?: AppendEventsOptions,
  ): Promise<{ firstSeq: number; lastSeq: number }>;
}

const defaultEventsWriter: EventsWriter = { append: appendEvents };

/** The part of `@anybench/envs` ArtifactStore the upload routes use (a fake in tests). */
export interface TrialArtifactStore {
  createUpload(input: {
    runId: string;
    trialId: string;
    name: string;
    sizeBytes: number;
    sha256: string;
    maxBytes: number;
  }): Promise<UploadPlan>;
  completeUpload(plan: UploadPlan): Promise<{ key: string; sizeBytes: number; sha256: string }>;
}

/** webhook_inbox.provider for runner batches. */
export const RUNNER_INBOX_PROVIDER = "runner";
/** plan.md section 5: lease_until = now + 90 s. */
export const RUNNER_LEASE_EXTEND_SECONDS = 90;
/** kit `transfer.max_mb` default (packages/core KitSpec). */
const DEFAULT_TRANSFER_MAX_MB = 512;
/** completeUpload checks sizes and parts, never the URLs; the rebuilt plan carries this one. */
const COMPLETION_PLACEHOLDER_URL = "https://upload-complete.invalid/";

const SYSTEM = { kind: "system", reason: "runner ingest (TDM-47)" } as const;

// ---------------------------------------------------------------------------------------------
// Untrusted input. The runner token sits on the eval computer, where the agent under test can
// read it, so every runner request is treated as hostile: a runner may only report what
// packages/runner/src/events.ts emits, about its own trial, as itself, at no cost. Gate results,
// run state, usage/billing, alerts, publish, computer and agent events never come from here
// (gates come from the scoring computer through the worker).

/** The only event types the runner emits. */
export const RUNNER_EVENT_TYPES = [
  "trial.phase",
  "trial.heartbeat",
  "trial.log_chunk",
  "trial.network",
] as const satisfies readonly AnybenchEventType[];

/**
 * The trial states a runner may move its trial INTO (runner.ts): installing → warming → running →
 * collecting, plus the final failure edge. gating / reviewing / done belong to the worker.
 */
export const RUNNER_PHASE_TARGETS = [
  "warming",
  "running",
  "collecting",
  "failed_subject",
  "failed_infra",
  "cancelled",
] as const satisfies readonly TrialState[];

/**
 * Size limits. A 413 or 400 is fatal to the runner (it stops pushing and goes file-only, and the
 * worker falls back to polling events.jsonl), so these sit far above any real request:
 * - /events: the runner's `batch_max` is at most 1000 events of well under 1 KiB each, plus
 *   status.json (phases, log_chunks counters), so a real batch stays under ~1 MiB.
 * - /uploads, /uploads/complete: a name, a sha256 and at most a few hundred part ETags.
 */
export const RUNNER_EVENTS_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
export const RUNNER_UPLOAD_BODY_LIMIT_BYTES = 64 * 1024;
/** The runner's `batch_max` ceiling (packages/runner job.ts). */
export const RUNNER_MAX_EVENTS_PER_BATCH = 1000;

/** Why a runner may not send this event, or null when it may. */
function runnerEventProblem(e: AnybenchEvent, trial: { id: string; runId: string }): string | null {
  if (!(RUNNER_EVENT_TYPES as readonly string[]).includes(e.type)) {
    return `type ${e.type} cannot come from a runner`;
  }
  if (e.run_id?.toLowerCase() !== trial.runId) return "run_id is not this trial's run";
  if (e.source_id?.toLowerCase() !== trial.id) return "source_id must be this trial's id";
  if (e.actor.kind !== "runner") return `actor.kind must be runner, got ${e.actor.kind}`;
  if (e.cost_delta_micro_usd !== 0n) return "cost_delta_micro_usd must be 0 for a runner";
  if (
    e.type === "trial.phase" &&
    !(RUNNER_PHASE_TARGETS as readonly string[]).includes(e.payload.to)
  ) {
    return `trial.phase to ${e.payload.to} is not a runner edge`;
  }
  return null;
}

function tooLarge(c: C, limit: number): Response {
  const body = apiError("bad_request", `request body is over the ${limit} byte limit`, {
    request_id: c.get("requestId"),
  });
  return c.json(body, 413);
}

type C = Context<AppEnv>;

interface AuthedTrial {
  id: string;
  runId: RunId;
  attempt: number;
  token: string;
}

function fail(c: C, code: ApiErrorCode, message: string, issues?: string[]): Response {
  const body = apiError(code, message, {
    request_id: c.get("requestId"),
    ...(issues ? { issues } : {}),
  });
  return c.json(body, API_ERROR_STATUS[code] as ContentfulStatusCode);
}

function ok<R extends RouteSpec>(c: C, route: R, result: RouteResult<R>): Response {
  return c.json(encodeRouteResponse(route, result) as object, 200);
}

/** Lowercase header map for parseRouteRequest. */
function headersOf(c: C): Record<string, string> {
  const out: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

async function jsonBody(c: C): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await c.req.json() };
  } catch {
    return { ok: false };
  }
}

const KitTransferSchema = z.object({
  transfer: z.object({ max_mb: z.int().positive() }).optional(),
});

export function runnerRoutes(deps: AppDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const db = scopedDb(SYSTEM, deps.db);
  const writer: EventsWriter = deps.events ?? defaultEventsWriter;

  /** 401 unless the bearer token is this trial's, for its current attempt, while it is live. */
  async function authenticate(c: C): Promise<AuthedTrial | Response> {
    const secret = deps.config.RUNNER_TOKEN_SECRET;
    if (!secret) return fail(c, "unavailable", "runner ingest is not configured");
    const token = bearerToken(c.req.header("authorization"));
    if (!token) return fail(c, "unauthorized", "missing runner token");
    const id = TrialIdSchema.safeParse(c.req.param("id"));
    if (!id.success) return fail(c, "unauthorized", "invalid runner token");
    const [trial] = await db.transaction((tx) =>
      tx
        .select({
          id: trials.id,
          runId: trials.runId,
          attempt: trials.attempt,
          state: trials.state,
          endedAt: trials.endedAt,
        })
        .from(trials)
        .where(eq(trials.id, id.data))
        .limit(1),
    );
    // Same answer for an unknown trial and a wrong token: the token is what is being checked.
    if (!trial || !verifyRunnerToken(secret, token, trial.id, trial.attempt)) {
      return fail(c, "unauthorized", "invalid runner token");
    }
    const live = checkRunnerTokenLive(trial, trial.attempt, new Date());
    if (!live.ok) return fail(c, "unauthorized", `runner token expired (${live.reason})`);
    return { id: trial.id, runId: RunIdSchema.parse(trial.runId), attempt: trial.attempt, token };
  }

  /** parseRouteRequest over the Hono request; a Response on a bad request. */
  async function parse<R extends RouteSpec>(c: C, route: R) {
    const body = await jsonBody(c);
    if (!body.ok) return fail(c, "bad_request", "request body is not valid JSON");
    const parsed = parseRouteRequest(route, {
      params: c.req.param(),
      headers: headersOf(c),
      body: body.body,
    });
    if (!parsed.ok) {
      return fail(c, "validation_failed", parsed.error.error.message, parsed.error.error.issues);
    }
    return parsed.request;
  }

  async function transferCapBytes(runId: string): Promise<number> {
    const [row] = await db.transaction((tx) =>
      tx
        .select({ spec: kits.spec })
        .from(runs)
        .innerJoin(kits, eq(kits.id, runs.kitId))
        .where(eq(runs.id, runId))
        .limit(1),
    );
    const spec = KitTransferSchema.safeParse(row?.spec ?? {});
    const mb = (spec.success ? spec.data.transfer?.max_mb : undefined) ?? DEFAULT_TRANSFER_MAX_MB;
    return mb * 1024 * 1024;
  }

  // -------------------------------------------------------------------------------------------
  // POST /v1/trials/:id/events

  const eventsLimit = bodyLimit({
    maxSize: RUNNER_EVENTS_BODY_LIMIT_BYTES,
    onError: (c) => tooLarge(c, RUNNER_EVENTS_BODY_LIMIT_BYTES),
  });
  const uploadLimit = bodyLimit({
    maxSize: RUNNER_UPLOAD_BODY_LIMIT_BYTES,
    onError: (c) => tooLarge(c, RUNNER_UPLOAD_BODY_LIMIT_BYTES),
  });

  r.post("/:id/events", eventsLimit, async (c) => {
    const route = apiRoutes.runner.ingest;
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const req = await parse(c, route);
    if (req instanceof Response) return req;
    const batch = req.body;

    if (batch.trial_id.toLowerCase() !== auth.id) {
      return fail(c, "bad_request", "body trial_id does not match the URL");
    }
    if (batch.attempt !== auth.attempt) {
      return fail(c, "unauthorized", "runner token is not for this attempt");
    }
    const key = runnerIdempotencyKey(auth.id, batch.attempt, batch.batch_seq);
    if (req.headers["idempotency-key"].toLowerCase() !== key) {
      return fail(c, "bad_request", `idempotency-key must be ${key}`);
    }
    if (
      batch.status &&
      (batch.status.trial_id.toLowerCase() !== auth.id || batch.status.attempt !== batch.attempt)
    ) {
      return fail(c, "bad_request", "status.json is for a different trial or attempt");
    }
    if (batch.events.length > RUNNER_MAX_EVENTS_PER_BATCH) {
      const msg = `body.events: a batch holds at most ${RUNNER_MAX_EVENTS_PER_BATCH} events, got ${batch.events.length}`;
      return fail(c, "validation_failed", msg, [msg]);
    }
    const issues: string[] = [];
    batch.events.forEach((e, i) => {
      const problem = runnerEventProblem(e, auth);
      if (problem) issues.push(`body.events.${i}: ${problem}`);
    });
    if (issues.length > 0) {
      return fail(c, "validation_failed", issues[0]!, issues);
    }
    // appendEvents redacts payload, actor and source_id with this (key patterns + exact secrets).
    const redactor = createRedactor({ ...configSecrets(deps.config), RUNNER_TOKEN: auth.token });
    const heartbeats = batch.events.filter(
      (e): e is AnybenchEventOf<"trial.heartbeat"> => e.type === "trial.heartbeat",
    );
    const logOffset = heartbeats.reduce((max, e) => Math.max(max, e.payload.log_offset), -1);

    const result = await db
      .transaction(async (tx) => {
        const inserted = await tx
          .insert(webhookInbox)
          .values({
            provider: RUNNER_INBOX_PROVIDER,
            eventId: key,
            processedAt: sql`now()`,
            attempts: 1,
            payload: {
              trial_id: auth.id,
              run_id: auth.runId,
              attempt: batch.attempt,
              batch_seq: batch.batch_seq,
              event_count: batch.events.length,
              phase: batch.status?.phase ?? null,
              events_bytes: batch.status?.events.bytes ?? null,
              log_chunks: batch.status?.log_chunks ?? null,
            },
          })
          .onConflictDoNothing({ target: [webhookInbox.provider, webhookInbox.eventId] })
          .returning({ id: webhookInbox.id });
        const inboxId = inserted[0]?.id;
        if (inboxId === undefined) return { duplicate: true as const };

        if (heartbeats.length > 0) {
          await tx
            .update(trials)
            .set({
              leaseUntil: sql`greatest(coalesce(${trials.leaseUntil}, now()), now() + make_interval(secs => ${RUNNER_LEASE_EXTEND_SECONDS}))`,
              logOffset: sql`greatest(${trials.logOffset}, ${logOffset})`,
              updatedAt: sql`now()`,
            })
            // Only a trial a worker holds has a lease to extend; the reaper owns the rest.
            .where(
              sql`${trials.id} = ${auth.id} and ${trials.attempt} = ${batch.attempt} and ${trials.leaseOwner} is not null`,
            );
        }
        const [run] = await tx
          .select({ cancelRequestedAt: runs.cancelRequestedAt })
          .from(runs)
          .where(eq(runs.id, auth.runId))
          .limit(1);
        // Last, so the run row that appendEvents locks (runs.next_seq) is held only until commit.
        if (batch.events.length > 0) {
          await writer.append(tx, auth.runId, batch.events, { redactor });
        }
        return { duplicate: false as const, cancel: run?.cancelRequestedAt != null };
      })
      .catch((err: unknown) => {
        if (err instanceof EventValidationError) return { invalid: err };
        throw err;
      });

    if ("invalid" in result) {
      return fail(c, "validation_failed", result.invalid.message, result.invalid.issues);
    }

    if (result.duplicate) {
      return fail(c, "conflict", `duplicate batch ${key} (already accepted)`);
    }
    c.get("log").debug(
      {
        trialId: auth.id,
        attempt: batch.attempt,
        batchSeq: batch.batch_seq,
        events: batch.events.length,
      },
      "runner batch accepted",
    );
    return ok(c, route, {
      accepted: batch.events.length,
      ...(result.cancel ? { cancel_requested: true } : {}),
    });
  });

  // -------------------------------------------------------------------------------------------
  // POST /v1/trials/:id/uploads

  r.post("/:id/uploads", uploadLimit, async (c) => {
    const route = apiRoutes.runner.uploads;
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const req = await parse(c, route);
    if (req instanceof Response) return req;
    const body = req.body;
    if (body.attempt !== auth.attempt) {
      return fail(c, "unauthorized", "runner token is not for this attempt");
    }
    const name = artifactNameSchema.safeParse(body.name);
    if (!name.success) return fail(c, "validation_failed", "body.name: invalid artifact name");
    const store = deps.artifacts;
    if (!store) return fail(c, "unavailable", "artifact storage is not configured");
    try {
      const plan = await store.createUpload({
        runId: auth.runId,
        trialId: auth.id,
        name: name.data,
        sizeBytes: body.size_bytes,
        sha256: body.sha256,
        maxBytes: await transferCapBytes(auth.runId),
      });
      return ok(c, route, { plan });
    } catch (err) {
      if (err instanceof ArtifactTransferError && err.code === "too_large") {
        return fail(c, "bad_request", err.message);
      }
      throw err;
    }
  });

  // -------------------------------------------------------------------------------------------
  // POST /v1/trials/:id/uploads/complete

  r.post("/:id/uploads/complete", uploadLimit, async (c) => {
    const route = apiRoutes.runner.uploadComplete;
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const req = await parse(c, route);
    if (req instanceof Response) return req;
    const body = req.body;
    if (body.attempt !== auth.attempt) {
      return fail(c, "unauthorized", "runner token is not for this attempt");
    }
    const name = artifactNameSchema.safeParse(body.name);
    if (!name.success) return fail(c, "validation_failed", "body.name: invalid artifact name");
    const key = trialArtifactKey(auth.runId, auth.id, name.data);
    if (body.key !== key) return fail(c, "bad_request", `key must be ${key}`);
    const multipart = body.size_bytes > MULTIPART_THRESHOLD_BYTES;
    if (multipart !== (body.upload_id !== undefined)) {
      return fail(
        c,
        "bad_request",
        multipart ? "upload_id is required for a multipart upload" : "unexpected upload_id",
      );
    }
    const store = deps.artifacts;
    if (!store) return fail(c, "unavailable", "artifact storage is not configured");

    // Rebuild the plan createUpload issued: it is a pure function of (key, size, sha256, cap),
    // so the server keeps no upload state between the two calls.
    const base = {
      key,
      sizeBytes: body.size_bytes,
      sha256: body.sha256,
      maxBytes: await transferCapBytes(auth.runId),
      expiresAt: new Date().toISOString(),
    };
    let plan: UploadPlan;
    if (body.upload_id !== undefined) {
      const parts = planParts(body.size_bytes, DEFAULT_PART_BYTES).map((p) => ({
        ...p,
        url: `${COMPLETION_PLACEHOLDER_URL}${p.partNumber}`,
        headers: {},
      }));
      plan = {
        kind: "multipart",
        ...base,
        uploadId: body.upload_id,
        partSizeBytes: parts[0]?.sizeBytes ?? DEFAULT_PART_BYTES,
        parts,
      };
    } else {
      plan = {
        kind: "single",
        ...base,
        method: "PUT",
        url: COMPLETION_PLACEHOLDER_URL,
        headers: {},
      };
    }

    try {
      const stored = await store.completeUpload(plan);
      return ok(c, route, {
        artifact: {
          name: name.data,
          key: stored.key,
          sha256: stored.sha256,
          size_bytes: stored.sizeBytes,
        },
      });
    } catch (err) {
      if (
        err instanceof ArtifactTransferError &&
        err.code !== "http_error" &&
        err.code !== "config"
      ) {
        return fail(c, "bad_request", err.message);
      }
      throw err;
    }
  });

  return r;
}
