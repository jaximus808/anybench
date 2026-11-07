// A tiny typed fetch client over the route descriptors (TDM-10). Used by the web app (cookie
// session, `credentials: "include"`), the CLI and MCP server (Bearer API key) and the in-VM runner
// (Bearer per-trial token).
//
//   const api = createApiClient("https://api.anybench.jaxonp.com", { kind: "apiKey", key });
//   const { run } = await api.runs.get({ params: { id } });
//   for await (const ev of api.stream(apiRoutes.events.stream, { params: { id } })) ...
//
// Requests are validated against the route's schemas before they are sent (bigint money is sent
// as decimal strings) and responses are parsed with the route's response schema, so a caller
// always gets bigint money, branded ids and applied defaults back.
import type { z } from "zod";
import { formatSchemaIssues } from "../schemas/kit.js";
import {
  ApiErrorBodySchema,
  PaymentRequiredSchema,
  type ApiErrorCode,
  type PaymentRequired,
} from "./common.js";
import { SSE_RETRY_MS, SseParser } from "./events.js";
import { apiRoutes, type ApiRoutes } from "./registry.js";
import {
  buildPath,
  encodeQuery,
  stringifyJson,
  type EmptyObject,
  type RouteInput,
  type RouteOutput,
  type RouteSpec,
  type StreamSpec,
} from "./route.js";

export type ClientAuth =
  /** Browser: the `anybench_session` cookie rides `credentials: "include"`. */
  | { kind: "session" }
  /** CLI, MCP, agents: `Authorization: Bearer ab_live_…`. */
  | { kind: "apiKey"; key: string }
  /** In-VM runner: `Authorization: Bearer <per-trial token>`. */
  | { kind: "runner"; token: string }
  | { kind: "none" };

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  /** Defaults to the global fetch. Tests pass a Hono app's `fetch` here. */
  fetch?: FetchLike;
  /** Extra headers on every request (e.g. a request id). */
  headers?: Readonly<Record<string, string>>;
  /** Validate inputs before sending. Default true. */
  validateRequests?: boolean;
}

export interface CallInit {
  signal?: AbortSignal;
  headers?: Readonly<Record<string, string>>;
}

/** Any non-2xx response, a request that failed validation (status 0), or a contract violation. */
export class ApiClientError extends Error {
  readonly status: number;
  readonly routeId: string;
  readonly code: ApiErrorCode | "contract_violation" | "http_error";
  readonly issues: readonly string[];
  /** The parsed 402 body of the run gate. */
  readonly paymentRequired: PaymentRequired | undefined;
  readonly body: unknown;

  constructor(init: {
    status: number;
    routeId: string;
    code: ApiClientError["code"];
    message: string;
    issues?: readonly string[];
    paymentRequired?: PaymentRequired;
    body?: unknown;
  }) {
    super(`${init.routeId}: ${init.message}`);
    this.name = "ApiClientError";
    this.status = init.status;
    this.routeId = init.routeId;
    this.code = init.code;
    this.issues = init.issues ?? [];
    this.paymentRequired = init.paymentRequired;
    this.body = init.body;
  }
}

type CallArgs<R extends RouteSpec> =
  EmptyObject extends RouteInput<R>
    ? [input?: RouteInput<R>, init?: CallInit]
    : [input: RouteInput<R>, init?: CallInit];

type StreamRoute = RouteSpec & { readonly stream: StreamSpec };

export interface StreamOptions extends CallInit {
  /** Resume after this seq (sent as `Last-Event-ID`). */
  lastEventId?: string | number;
  /** Reconnect when the stream drops without an `end` frame. Default true. */
  reconnect?: boolean;
}

type GroupClient<G> = {
  [K in keyof G]: G[K] extends RouteSpec
    ? (...args: CallArgs<G[K]>) => Promise<RouteOutput<G[K]>>
    : never;
};

export type ApiClient = {
  /** Call any route descriptor (JSON or text routes). */
  call<R extends RouteSpec>(route: R, ...args: CallArgs<R>): Promise<RouteOutput<R>>;
  /** The absolute URL for a route (redirect routes, EventSource, `<img src>` for the badge). */
  url<R extends RouteSpec>(route: R, ...args: CallArgs<R>): string;
  /**
   * Read an SSE route. Yields parsed events; returns the `end` frame's data, or undefined when
   * aborted. Reconnects with Last-Event-ID when the stream drops (Vercel function max duration).
   */
  stream<R extends StreamRoute>(
    route: R,
    input: RouteInput<R>,
    options?: StreamOptions,
  ): AsyncGenerator<z.output<R["stream"]["event"]>, z.output<R["stream"]["end"]> | undefined>;
} & { readonly [G in keyof ApiRoutes]: GroupClient<ApiRoutes[G]> };

interface PreparedRequest {
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export function createApiClient(
  baseUrl: string,
  auth: ClientAuth,
  options: ApiClientOptions = {},
): ApiClient {
  const base = baseUrl.replace(/\/+$/, "");
  const fetchImpl: FetchLike = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const validate = options.validateRequests ?? true;

  function authHeaders(): Record<string, string> {
    if (auth.kind === "apiKey") return { authorization: `Bearer ${auth.key}` };
    if (auth.kind === "runner") return { authorization: `Bearer ${auth.token}` };
    return {};
  }

  function part(route: RouteSpec, name: "params" | "query" | "headers" | "body", value: unknown) {
    const schema = route[name];
    if (!schema || !validate) return value;
    const r = schema.safeParse(value === undefined && name !== "body" ? {} : value);
    if (r.success) return r.data;
    throw new ApiClientError({
      status: 0,
      routeId: route.id,
      code: "validation_failed",
      message: "invalid request",
      issues: formatSchemaIssues(r.error).map((l) => `${name}.${l}`),
    });
  }

  function prepare(route: RouteSpec, input: Record<string, unknown> = {}): PreparedRequest {
    const params = part(route, "params", input.params) as Record<string, unknown> | undefined;
    const query = part(route, "query", input.query) as Record<string, unknown> | undefined;
    const reqHeaders = part(route, "headers", input.headers) as Record<string, unknown> | undefined;
    const headers: Record<string, string> = { ...options.headers, ...authHeaders() };
    for (const [k, v] of Object.entries(reqHeaders ?? {}))
      if (v !== undefined) headers[k] = String(v);
    let body: string | undefined;
    if (route.body && route.method !== "GET") {
      const value = part(route, "body", input.body ?? (route.rawBody ? undefined : {}));
      if (route.rawBody) {
        body = String(value ?? "");
        headers["content-type"] ??= "application/octet-stream";
      } else {
        body = stringifyJson(value);
        headers["content-type"] = "application/json";
      }
    }
    return { url: `${base}${buildPath(route.path, params)}${encodeQuery(query)}`, headers, body };
  }

  function init(route: RouteSpec, prepared: PreparedRequest, extra?: CallInit): RequestInit {
    const r: RequestInit = {
      method: route.method,
      headers: { ...prepared.headers, ...extra?.headers },
      credentials: auth.kind === "session" ? "include" : "omit",
      redirect: "manual",
    };
    if (prepared.body !== undefined) r.body = prepared.body;
    if (extra?.signal) r.signal = extra.signal;
    return r;
  }

  async function toError(route: RouteSpec, res: Response): Promise<ApiClientError> {
    const text = await res.text().catch(() => "");
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    const special = route.errors?.[res.status];
    if (res.status === 402) {
      const pr = (special ?? PaymentRequiredSchema).safeParse(json);
      if (pr.success) {
        const body = pr.data as PaymentRequired;
        return new ApiClientError({
          status: 402,
          routeId: route.id,
          code: "payment_required",
          message: `payment required: ${body.reason}`,
          paymentRequired: body,
          body,
        });
      }
    }
    const parsed = ApiErrorBodySchema.safeParse(json);
    if (parsed.success) {
      const e = parsed.data.error;
      return new ApiClientError({
        status: res.status,
        routeId: route.id,
        code: e.code,
        message: e.message,
        ...(e.issues ? { issues: e.issues } : {}),
        body: parsed.data,
      });
    }
    return new ApiClientError({
      status: res.status,
      routeId: route.id,
      code: "http_error",
      message: `HTTP ${res.status}`,
      body: json ?? text,
    });
  }

  function parseResponse(route: RouteSpec, status: number, value: unknown): unknown {
    const r = route.response.safeParse(value);
    if (r.success) return r.data;
    throw new ApiClientError({
      status,
      routeId: route.id,
      code: "contract_violation",
      message: "response does not match the contract",
      issues: formatSchemaIssues(r.error),
      body: value,
    });
  }

  async function call(route: RouteSpec, input?: Record<string, unknown>, extra?: CallInit) {
    const kind = route.kind ?? "json";
    if (kind === "redirect") throw new TypeError(`${route.id} is a redirect: use client.url()`);
    if (kind === "sse") throw new TypeError(`${route.id} is a stream: use client.stream()`);
    const prepared = prepare(route, input);
    const res = await fetchImpl(prepared.url, init(route, prepared, extra));
    if (!res.ok) throw await toError(route, res);
    if (kind === "text") return parseResponse(route, res.status, await res.text());
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      throw new ApiClientError({
        status: res.status,
        routeId: route.id,
        code: "contract_violation",
        message: "response is not JSON",
        body: text,
      });
    }
    return parseResponse(route, res.status, json);
  }

  async function* stream(
    route: StreamRoute,
    input: Record<string, unknown>,
    opts: StreamOptions = {},
  ): AsyncGenerator<unknown, unknown> {
    let lastId = opts.lastEventId === undefined ? undefined : String(opts.lastEventId);
    let retryMs = SSE_RETRY_MS;
    for (;;) {
      const headers: Record<string, string> = { accept: "text/event-stream", ...opts.headers };
      if (lastId !== undefined) headers["last-event-id"] = lastId;
      const prepared = prepare(route, {
        ...input,
        headers: { ...(input.headers as object), ...headers },
      });
      const reqInit = init(route, prepared, opts.signal ? { signal: opts.signal } : undefined);
      const res = await fetchImpl(prepared.url, reqInit);
      if (!res.ok) throw await toError(route, res);
      if (!res.body) throw new TypeError(`${route.id}: response has no body`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          const chunk = done ? decoder.decode() : decoder.decode(value, { stream: true });
          for (const frame of parser.push(chunk)) {
            if (frame.retry !== undefined) retryMs = frame.retry;
            if (frame.event === "end") {
              return parseResponseWith(route.stream.end, route, res.status, frame.data);
            }
            if ((frame.event === undefined || frame.event === "message") && frame.data !== "") {
              const ev = parseResponseWith(route.stream.event, route, res.status, frame.data);
              if (frame.id !== undefined) lastId = frame.id;
              yield ev;
            }
          }
          if (done) break;
        }
      } finally {
        reader.releaseLock();
      }
      if (opts.reconnect === false || opts.signal?.aborted) return undefined;
      await sleep(retryMs, opts.signal);
      if (opts.signal?.aborted) return undefined;
    }
  }

  function parseResponseWith(schema: z.ZodType, route: RouteSpec, status: number, data: string) {
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      json = data;
    }
    return parseResponse({ ...route, response: schema }, status, json);
  }

  const client: Record<string, unknown> = {
    call: (route: RouteSpec, input?: Record<string, unknown>, extra?: CallInit) =>
      call(route, input, extra),
    url: (route: RouteSpec, input?: Record<string, unknown>) => prepare(route, input).url,
    stream,
  };
  for (const [group, routes] of Object.entries(apiRoutes)) {
    const g: Record<string, unknown> = {};
    for (const [action, route] of Object.entries(routes as Record<string, RouteSpec>)) {
      g[action] = (input?: Record<string, unknown>, extra?: CallInit) => call(route, input, extra);
    }
    client[group] = g;
  }
  return client as ApiClient;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
