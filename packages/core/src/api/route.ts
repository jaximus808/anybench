// Route descriptors: the one place an API route is described (TDM-10, plan.md sections 3, 6, 8, 9).
//
// A route is plain data: method, path template, who may call it, the zod schemas for its params,
// query, headers and body, and the schema of its success response. The server (Hono on Vercel
// Functions today), the web app, the CLI and the MCP server all read the same descriptor, so the
// contract stays transport-agnostic: nothing here imports a framework.
//
// Conventions:
// - Path params are `:name` segments. Every `:name` in `path` is a key of `params`, and back.
// - Query and path values arrive as strings, so their schemas coerce (`z.coerce.number()`).
// - JSON has no bigint. Money is integer micro-USD: a bigint in memory, a decimal string on the
//   wire (`"1250000"`). `MicroUsdSchema` accepts both and yields a bigint; `stringifyJson`
//   writes bigints as decimal strings.
// - Errors use `ApiErrorBodySchema`, except a status listed in `errors` (402 on the run gate).

import { z } from "zod";

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** API key scopes (plan.md section 6). A key may also be limited to specific run ids. */
export const API_KEY_SCOPES = [
  "runs:read",
  "events:read",
  "logs:read",
  "alerts:write",
  "runs:write",
  "publish:write",
  "admin",
] as const;
export const ApiKeyScopeSchema = z.enum(API_KEY_SCOPES);
export type ApiKeyScope = z.infer<typeof ApiKeyScopeSchema>;

/**
 * Who may call a route. A route lists every mode it accepts (any one is enough):
 * - `public`: anyone, no credentials (public pages, badge, OAuth start). Never combined.
 * - `session`: the `anybench_session` cookie (web app).
 * - `apiKey:<scope>`: `Authorization: Bearer ab_live_…` with that scope (CLI, MCP, agents).
 * - `admin`: a session whose `users.github_login` is in `ADMIN_GITHUB_LOGINS`, checked per request.
 * - `runner`: the per-trial runner token (`Authorization: Bearer …`), only for its own trial.
 * - `webhook`: a provider-signed request (Stripe, AgentMail, Naïve); the raw body is verified.
 */
export type AuthMode =
  "public" | "session" | "admin" | "runner" | "webhook" | `apiKey:${ApiKeyScope}`;

export const AUTH_MODES: readonly AuthMode[] = [
  "public",
  "session",
  "admin",
  "runner",
  "webhook",
  ...API_KEY_SCOPES.map((s) => `apiKey:${s}` as const),
];

export function isAuthMode(value: string): value is AuthMode {
  return (AUTH_MODES as readonly string[]).includes(value);
}

/** The API key scope an auth mode requires, or undefined for non-key modes. */
export function apiKeyScopeOf(mode: AuthMode): ApiKeyScope | undefined {
  return mode.startsWith("apiKey:") ? (mode.slice("apiKey:".length) as ApiKeyScope) : undefined;
}

/**
 * How the success response is sent:
 * - `json`: `application/json`, parsed with `response`.
 * - `sse`: `text/event-stream`; each frame's `data` parses with `stream.event` (see events.ts).
 * - `redirect`: a 302; `response` describes `{location}` for documentation, the body is empty.
 * - `text`: a text body (Markdown report, SVG badge); `response` is a string schema.
 */
export type ResponseKind = "json" | "sse" | "redirect" | "text";

export interface StreamSpec {
  /** Schema of each event frame's `data`. The frame `id` is the event seq. */
  readonly event: z.ZodType;
  /** Schema of the final `event: end` frame's `data`, sent when nothing more will come. */
  readonly end: z.ZodType;
}

export interface RouteSpec {
  /** Stable dotted id, `<resource>.<action>`, e.g. `runs.get`. Used by the client and MCP tools. */
  readonly id: string;
  readonly method: HttpMethod;
  /** Path template relative to the API origin, e.g. `/runs/:id`. */
  readonly path: string;
  /** Accepted auth modes; at least one. */
  readonly auth: readonly [AuthMode, ...AuthMode[]];
  readonly summary: string;
  readonly params?: z.ZodType;
  readonly query?: z.ZodType;
  /** Request headers the route reads (lowercase names), e.g. `last-event-id`. */
  readonly headers?: z.ZodType;
  readonly body?: z.ZodType;
  /** The body is verified as raw bytes (webhooks) and parsed by the handler after the signature. */
  readonly rawBody?: boolean;
  /** Success response schema (for `sse`, the schema of one event). */
  readonly response: z.ZodType;
  /** Success status. Default 200 (201 for creates, 302 for redirects). */
  readonly status?: number;
  /** Default `json`. */
  readonly kind?: ResponseKind;
  readonly stream?: StreamSpec;
  /** Non-success statuses with their own body shape (anything else is ApiErrorBody). */
  readonly errors?: { readonly [status: number]: z.ZodType };
}

/** Declare a route. Identity at runtime; keeps every literal type for the client and server. */
export function defineRoute<const R extends RouteSpec>(route: R): R {
  return route;
}

/** A group of routes for one resource, keyed by action name. */
export type RouteGroup = { readonly [action: string]: RouteSpec };

export function defineRoutes<const G extends RouteGroup>(group: G): G {
  return group;
}

// ---------------------------------------------------------------------------------------------
// Typed inputs and outputs

/** `{}` without the lint footgun: an object type with no keys. */
export type EmptyObject = Record<never, never>;

type InputPart<R, K extends "params" | "query" | "headers" | "body"> = R extends {
  readonly [P in K]: infer S extends z.ZodType;
}
  ? EmptyObject extends z.input<S>
    ? { [P in K]?: z.input<S> }
    : { [P in K]: z.input<S> }
  : EmptyObject;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** What a caller sends: `{params, query, headers, body}`, each present only when the route has it. */
export type RouteInput<R extends RouteSpec> = Simplify<
  InputPart<R, "params"> & InputPart<R, "query"> & InputPart<R, "headers"> & InputPart<R, "body">
>;

type ParsedPart<R, K extends "params" | "query" | "headers" | "body"> = R extends {
  readonly [P in K]: infer S extends z.ZodType;
}
  ? { [P in K]: z.output<S> }
  : EmptyObject;

/** What a handler receives after validation (bigint money, branded ids, defaults applied). */
export type RouteRequest<R extends RouteSpec> = Simplify<
  ParsedPart<R, "params"> &
    ParsedPart<R, "query"> &
    ParsedPart<R, "headers"> &
    ParsedPart<R, "body">
>;

/** What a caller gets back (parsed). */
export type RouteOutput<R extends RouteSpec> = z.output<R["response"]>;

/** What a handler may return: the response schema's input (bigint or decimal-string money). */
export type RouteResult<R extends RouteSpec> = z.input<R["response"]>;

/** A server handler for one route, independent of the HTTP framework. */
export type RouteHandler<R extends RouteSpec, Ctx = unknown> = (
  request: RouteRequest<R>,
  ctx: Ctx,
) => RouteResult<R> | Promise<RouteResult<R>>;

/** Handlers for every route of a group. */
export type RouteHandlers<G extends RouteGroup, Ctx = unknown> = {
  [K in keyof G]: RouteHandler<G[K], Ctx>;
};

// ---------------------------------------------------------------------------------------------
// Paths

const PARAM = /:([A-Za-z_][A-Za-z0-9_]*)/g;

/** The `:name` params in a path template, in order. */
export function pathParamNames(path: string): string[] {
  return [...path.matchAll(PARAM)].map((m) => m[1]!);
}

/** Fill a path template; every value is URI-encoded. Throws when a param is missing. */
export function buildPath(path: string, params: Readonly<Record<string, unknown>> = {}): string {
  return path.replace(PARAM, (_m, name: string) => {
    const value = params[name];
    if (value === undefined || value === null || value === "") {
      throw new TypeError(`missing path param '${name}' for ${path}`);
    }
    return encodeURIComponent(String(value));
  });
}

// ---------------------------------------------------------------------------------------------
// JSON (bigint-safe)

/** JSON.stringify replacer: bigint (micro-USD) becomes a decimal string. */
export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/** JSON text with bigints as decimal strings. Never converts money to a JS number. */
export function stringifyJson(value: unknown): string {
  return JSON.stringify(value, bigintReplacer);
}

/** The JSON-safe form of a value (bigints become decimal strings). */
export function toJsonValue<T>(value: T): unknown {
  const text = stringifyJson(value);
  return text === undefined ? undefined : JSON.parse(text);
}

/** Query string values: arrays are comma-joined, undefined and null are dropped. */
export function encodeQuery(query: Readonly<Record<string, unknown>> | undefined): string {
  if (!query) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    sp.set(k, Array.isArray(v) ? v.map(String).join(",") : String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}
