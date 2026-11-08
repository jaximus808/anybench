// Small Hono glue over the core route contract (TDM-67), shared by the runs, kits and scan routers.
//
// - Auth is TDM-66's `requireScope(deps, scope, {runIdParam})` (lib/auth-key.ts): it sets
//   `c.get("actor")` (an AuthActor: the user, plus the API key's scopes and run ids if any).
//   Routes whose path id is not a run id (kits, scans, lists) check `runAllowed` / `runIdsOf`.
// - `parseOrFail` / `send`: validate the request and the response against the core descriptor.
//   Every success body passes `encodeRouteResponse`, which throws (500) rather than break the
//   contract. Errors are core ApiErrorBody JSON.
import {
  API_ERROR_STATUS,
  apiError,
  encodeRouteResponse,
  parseRouteRequest,
  successStatus,
  type ApiErrorCode,
  type RawRequest,
  type RouteRequest,
  type RouteResult,
  type RouteSpec,
} from "@anybench/core";
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../types.js";
import { actorCanAccessRun, type ActorEnv, type AuthActor } from "./auth-key.js";

export type { ActorEnv } from "./auth-key.js";
/** The caller of a tenant route (TDM-66 AuthActor). */
export type RouteActor = AuthActor;
export type ActorContext = Context<ActorEnv>;

/** Whether the actor may touch `runId`: always for a session, only listed runs for a scoped key. */
export function runAllowed(actor: AuthActor, runId: string): boolean {
  return actorCanAccessRun(actor, runId);
}

/** True for an API key limited to specific runs (it may not create runs or scans). */
export function runLimited(actor: AuthActor): boolean {
  return actor.apiKey?.runIds != null;
}

/** JSON error with the core ApiErrorBody shape and the status that code implies. */
export function fail(
  c: Context<AppEnv> | ActorContext,
  code: ApiErrorCode,
  message: string,
  issues?: string[],
) {
  return c.json(
    apiError(code, message, {
      ...(issues && issues.length > 0 ? { issues } : {}),
      request_id: c.get("requestId"),
    }),
    API_ERROR_STATUS[code] as ContentfulStatusCode,
  );
}

/** hono/body-limit with a 413 ApiErrorBody (`payload_too_large`). Put it before the auth guard. */
export function bodyLimitOf(maxBytes: number): MiddlewareHandler<ActorEnv> {
  return bodyLimit({
    maxSize: maxBytes,
    onError: (c) =>
      fail(
        c as ActorContext,
        "payload_too_large",
        `request body is over the ${maxBytes} byte limit`,
      ),
  });
}

/** A Postgres unique violation (23505) on `constraint`, looking through Drizzle's error wrapper. */
export function isUniqueViolation(err: unknown, constraint: string): boolean {
  let e: unknown = err;
  for (let i = 0; i < 5 && e && typeof e === "object"; i++) {
    const rec = e as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (rec.code === "23505") return rec.constraint === constraint;
    e = rec.cause;
  }
  return false;
}

/** The request body as JSON: undefined when empty, a 400 marker when it is not JSON. */
async function jsonBody(c: ActorContext): Promise<{ ok: true; body: unknown } | { ok: false }> {
  const text = await c.req.text();
  if (text.trim() === "") return { ok: true, body: undefined };
  try {
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

export type Parsed<R extends RouteSpec> =
  { ok: true; request: RouteRequest<R> } | { ok: false; response: Response };

/** Validate params, query, headers and body against `route`; a failure is a ready 400. */
export async function parseOrFail<R extends RouteSpec>(
  c: ActorContext,
  route: R,
  headers: Record<string, string | undefined> = {},
): Promise<Parsed<R>> {
  const raw: RawRequest = { params: c.req.param(), query: c.req.queries(), headers };
  if (route.body) {
    const body = await jsonBody(c);
    if (!body.ok)
      return { ok: false, response: fail(c, "bad_request", "request body is not valid JSON") };
    raw.body = body.body;
  }
  const parsed = parseRouteRequest(route, raw);
  if (!parsed.ok) {
    return {
      ok: false,
      response: fail(c, "validation_failed", parsed.error.error.message, parsed.error.error.issues),
    };
  }
  return { ok: true, request: parsed.request };
}

/** Encode `result` with the route's response schema and send it with the route's success status. */
export function send<R extends RouteSpec>(c: ActorContext, route: R, result: RouteResult<R>) {
  return c.json(
    encodeRouteResponse(route, result) as object,
    successStatus(route) as ContentfulStatusCode,
  );
}

/** ISO timestamp for a DB date (core IsoDateTimeSchema). */
export function iso(d: Date): string {
  return d.toISOString();
}

export function isoOrNull(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

// ---------------------------------------------------------------------------------------------
// Keyset cursors for `newest first` lists: (created_at, id) of the last row, base64url JSON.
// created_at travels as Postgres text (microseconds), so no row is skipped or repeated.

export interface PageCursor {
  /** created_at as text with microseconds, e.g. `2026-11-07 21:00:00.123456+00`. */
  c: string;
  i: string;
}

/** Postgres timestamptz text (`2026-11-07 21:00:00.123456+00`) or ISO 8601. */
const CURSOR_TS = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)$/;

export function encodeCursor(cur: PageCursor): string {
  return Buffer.from(JSON.stringify(cur), "utf8").toString("base64url");
}

export function decodeCursor(raw: string | undefined): PageCursor | null | undefined {
  if (raw === undefined) return undefined;
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (
      v &&
      typeof v === "object" &&
      typeof (v as PageCursor).c === "string" &&
      typeof (v as PageCursor).i === "string" &&
      /^[0-9a-f-]{36}$/i.test((v as PageCursor).i) &&
      CURSOR_TS.test((v as PageCursor).c)
    ) {
      return { c: (v as PageCursor).c, i: (v as PageCursor).i };
    }
  } catch {
    // fall through
  }
  return null;
}
