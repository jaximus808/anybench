// Transport-agnostic server helpers (TDM-10): validate a request against a route descriptor and
// encode a handler's result. The Hono app on Vercel Functions (apps/server) wraps these; nothing
// here knows about Hono, Node http or the Fetch API beyond plain values.
import type { z } from "zod";
import { formatSchemaIssues } from "../schemas/kit.js";
import { apiError, type ApiErrorBody } from "./common.js";
import { toJsonValue, type RouteRequest, type RouteResult, type RouteSpec } from "./route.js";

/** The raw pieces of a request, as any framework can produce them. */
export interface RawRequest {
  params?: Readonly<Record<string, string | undefined>>;
  /** Repeated keys may come as arrays; they are joined with commas (csv lists). */
  query?: Readonly<Record<string, string | readonly string[] | undefined>>;
  /** Lowercase header names. */
  headers?: Readonly<Record<string, string | undefined>>;
  /** Parsed JSON body, or the raw text for `rawBody` routes. */
  body?: unknown;
}

export type ParseRequestResult<R extends RouteSpec> =
  { ok: true; request: RouteRequest<R> } | { ok: false; status: 400; error: ApiErrorBody };

function dropUndefined(
  rec: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec ?? {})) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(",") : v;
  }
  return out;
}

function prefixed(prefix: string, error: z.ZodError): string[] {
  return formatSchemaIssues(error).map((line) => `${prefix}.${line}`);
}

/** Validate params, query, headers and body. Issues are `params.id: expected a UUID` lines. */
export function parseRouteRequest<R extends RouteSpec>(
  route: R,
  raw: RawRequest,
): ParseRequestResult<R> {
  const out: Record<string, unknown> = {};
  const issues: string[] = [];
  const parts = [
    ["params", route.params, dropUndefined(raw.params)],
    ["query", route.query, dropUndefined(raw.query)],
    ["headers", route.headers, dropUndefined(raw.headers)],
    ["body", route.body, raw.body],
  ] as const;
  for (const [name, schema, value] of parts) {
    if (!schema) continue;
    const r = schema.safeParse(
      name === "body" && value === undefined && !route.rawBody ? {} : value,
    );
    if (r.success) out[name] = r.data;
    else issues.push(...prefixed(name, r.error));
  }
  if (issues.length > 0) {
    return {
      ok: false,
      status: 400,
      error: apiError("validation_failed", `invalid request for ${route.id}`, { issues }),
    };
  }
  return { ok: true, request: out as RouteRequest<R> };
}

/**
 * Validate a handler's result against the route's response schema and return the JSON-safe value
 * (bigint money → decimal strings). Throws a ZodError when the server would break the contract.
 */
export function encodeRouteResponse<R extends RouteSpec>(
  route: R,
  result: RouteResult<R>,
): unknown {
  return toJsonValue(route.response.parse(result));
}

/** The status to send for a successful call. */
export function successStatus(route: RouteSpec): number {
  return route.status ?? (route.kind === "redirect" ? 302 : 200);
}
