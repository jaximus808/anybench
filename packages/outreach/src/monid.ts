// Monid client: one key, one wallet, thousands of provider endpoints (docs/findings/outreach-spike.md).
// Flow: POST /v1/inspect (input schema + live price) → POST /v1/run with maxCost → for async (202)
// endpoints, poll GET /v1/runs/{runId}. Every run MUST carry a maxCost; this client also keeps a
// running spend ledger and refuses a run whose maxCost would push it past `spendCapMicroUsd`.

import { z } from "zod";
import {
  MonidBalanceUsdSchema,
  MonidReportedCostSchema,
  MonidUsdSchema,
  microUsdToUsdWire,
  type MicroUsd,
} from "./money.js";

export const DEFAULT_MONID_BASE_URL = "https://api.monid.ai";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const MonidClientOptionsSchema = z.object({
  apiKey: z.string().min(1, "MONID_API_KEY is empty"),
  baseUrl: z.string().url().default(DEFAULT_MONID_BASE_URL),
  /** Total micro-USD this client may commit (sum of settled costs + maxCost of the next run). */
  spendCapMicroUsd: z.bigint().nonnegative().optional(),
  /** Poll interval for async (202) runs. */
  pollIntervalMs: z.number().int().positive().default(2000),
  /** Give up polling an async run after this long. */
  pollTimeoutMs: z.number().int().positive().default(120_000),
});
export type MonidClientOptions = z.input<typeof MonidClientOptionsSchema> & {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
};

// ---- wire schemas -------------------------------------------------------------------------------

const PriceSchema = z.looseObject({
  type: z.string(),
  amount: MonidUsdSchema.optional(),
  flatFee: MonidUsdSchema.optional(),
  notes: z.array(z.string()).optional(),
});
export type MonidPrice = z.output<typeof PriceSchema>;

export const MonidInspectSchema = z.looseObject({
  provider: z.string(),
  endpoint: z.string(),
  method: z.string().optional(),
  description: z.string().optional(),
  summary: z.string().optional(),
  input: z.record(z.string(), z.unknown()).default({}),
  price: PriceSchema,
  docUrl: z.string().optional(),
});
export type MonidInspect = z.output<typeof MonidInspectSchema>;

export const RUN_STATUSES = [
  "READY",
  "RUNNING",
  "STOPPING",
  "COMPLETED",
  "FAILED",
  "BLOCKED",
  "STOPPED",
  "TIMED_OUT",
] as const;
const TERMINAL = new Set<string>(["COMPLETED", "FAILED", "BLOCKED", "STOPPED", "TIMED_OUT"]);

const ResourceSchema = z.looseObject({
  action: z.string(),
  resourceId: z.string(),
  resourceType: z.string(),
  identifier: z.string(),
});

export const MonidRunSchema = z.looseObject({
  runId: z.string(),
  provider: z.string(),
  endpoint: z.string(),
  status: z.enum(RUN_STATUSES),
  reason: z.string().optional(),
  output: z.unknown().optional(),
  providerResponse: z
    .looseObject({ httpStatus: z.number().int().optional(), error: z.unknown().optional() })
    .optional(),
  price: PriceSchema.optional(),
  /** GET /v1/runs/{id} reports the settled cost as a USD float. */
  cost: MonidUsdSchema.optional(),
  /** POST /v1/run reports it as an integer with a unit (observed: MICRO_DOLLAR). */
  billing: z.looseObject({ reportedCost: MonidReportedCostSchema }).optional(),
  resources: z.array(ResourceSchema).optional(),
  createdAt: z.string().optional(),
  completedAt: z.string().optional(),
});
export interface MonidRun<T = unknown> {
  runId: string;
  provider: string;
  endpoint: string;
  status: (typeof RUN_STATUSES)[number];
  reason: string | undefined;
  output: T;
  providerResponse: { httpStatus?: number | undefined; error?: unknown } | undefined;
  price: MonidPrice | undefined;
  resources: z.output<typeof ResourceSchema>[] | undefined;
  createdAt: string | undefined;
  completedAt: string | undefined;
  /** Settled cost in micro-USD (billing.reportedCost, else cost, else 0n while unsettled). */
  costMicroUsd: MicroUsd;
}

export const MonidBalanceSchema = z.looseObject({
  balance: MonidBalanceUsdSchema,
  held: MonidUsdSchema,
});
export interface MonidBalance {
  balanceMicroUsd: MicroUsd;
  heldMicroUsd: MicroUsd;
}

const ErrorBodySchema = z.looseObject({
  code: z.number().optional(),
  message: z.string().optional(),
  errorCode: z.string().optional(),
});

// ---- errors -------------------------------------------------------------------------------------

export type MonidErrorCode =
  | "MAX_COST_EXCEEDED"
  | "WALLET_INSUFFICIENT_FUNDS"
  | "RATE_LIMITED"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "BLOCKED"
  | "PROVIDER_ERROR"
  | "RUN_FAILED"
  | "POLL_TIMEOUT"
  | "SPEND_CAP"
  | "BAD_RESPONSE"
  | "HTTP_ERROR";

export class MonidError extends Error {
  override readonly name = "MonidError";
  constructor(
    message: string,
    readonly code: MonidErrorCode,
    readonly status?: number,
    /** The run, when Monid returned one (provider errors, BLOCKED, FAILED, TIMED_OUT). */
    readonly run?: MonidRun,
    readonly requestId?: string,
  ) {
    super(message);
  }
  get retryable(): boolean {
    return this.code === "RATE_LIMITED" || (this.status !== undefined && this.status >= 500);
  }
}

// ---- client -------------------------------------------------------------------------------------

export interface MonidRunRequest {
  provider: string;
  endpoint: string;
  input?: { body?: unknown; queryParams?: unknown; pathParams?: unknown };
  /** Required: the most this run may be estimated to cost. 0n allows only free runs. */
  maxCostMicroUsd: MicroUsd;
}

export interface MonidClient {
  inspect(provider: string, endpoint: string): Promise<MonidInspect>;
  /** Runs an endpoint; resolves with the terminal COMPLETED run whose provider answered 2xx. */
  run<T = unknown>(req: MonidRunRequest, outputSchema?: z.ZodType<T>): Promise<MonidRun<T>>;
  getRun<T = unknown>(runId: string, outputSchema?: z.ZodType<T>): Promise<MonidRun<T>>;
  balance(): Promise<MonidBalance>;
  /** Micro-USD settled by runs made through this client instance. */
  spentMicroUsd(): MicroUsd;
}

export function createMonidClient(options: MonidClientOptions): MonidClient {
  const opts = MonidClientOptionsSchema.parse(options);
  const doFetch: FetchLike = options.fetch ?? ((u, i) => fetch(u, i));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let spent = 0n;

  async function call(method: string, path: string, json?: unknown) {
    const headers: Record<string, string> = { authorization: `Bearer ${opts.apiKey}` };
    if (json !== undefined) headers["content-type"] = "application/json";
    const res = await doFetch(`${opts.baseUrl}${path}`, {
      method,
      headers,
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    return { status: res.status, requestId: res.headers.get("x-request-id") ?? undefined, body };
  }

  function errorFor(status: number, body: unknown, requestId?: string): MonidError {
    const e = ErrorBodySchema.safeParse(body);
    const msg = e.success ? (e.data.message ?? `HTTP ${status}`) : `HTTP ${status}`;
    const ec = e.success ? e.data.errorCode : undefined;
    const code: MonidErrorCode =
      ec === "MAX_COST_EXCEEDED"
        ? "MAX_COST_EXCEEDED"
        : ec === "WALLET_INSUFFICIENT_FUNDS" || status === 402
          ? "WALLET_INSUFFICIENT_FUNDS"
          : status === 429
            ? "RATE_LIMITED"
            : status === 401 || status === 403
              ? "UNAUTHORIZED"
              : status === 404
                ? "NOT_FOUND"
                : status === 400
                  ? "BAD_REQUEST"
                  : "HTTP_ERROR";
    return new MonidError(`Monid: ${msg}`, code, status, undefined, requestId);
  }

  function toRun<T>(raw: unknown, outputSchema?: z.ZodType<T>): MonidRun<T> {
    const parsed = MonidRunSchema.safeParse(raw);
    if (!parsed.success) {
      throw new MonidError(`Monid run response: ${parsed.error.message}`, "BAD_RESPONSE");
    }
    const r = parsed.data;
    const costMicroUsd = r.billing?.reportedCost ?? r.cost ?? 0n;
    let output: unknown = r.output;
    const ps = r.providerResponse?.httpStatus;
    const providerOk = ps === undefined || (ps >= 200 && ps < 300);
    // Only a successful provider answer is held to the output schema; errors surface in settle().
    if (outputSchema && r.status === "COMPLETED" && providerOk) {
      const o = outputSchema.safeParse(r.output);
      if (!o.success) {
        throw new MonidError(
          `Monid ${r.provider} ${r.endpoint} output: ${o.error.message}`,
          "BAD_RESPONSE",
        );
      }
      output = o.data;
    }
    return {
      runId: r.runId,
      provider: r.provider,
      endpoint: r.endpoint,
      status: r.status,
      reason: r.reason,
      output: output as T,
      providerResponse: r.providerResponse,
      price: r.price,
      resources: r.resources,
      createdAt: r.createdAt,
      completedAt: r.completedAt,
      costMicroUsd,
    };
  }

  function settle<T>(run: MonidRun<T>, httpStatus: number): MonidRun<T> {
    spent += run.costMicroUsd;
    if (run.status === "BLOCKED") {
      throw new MonidError(
        `Monid blocked the run: ${run.reason ?? "workspace control"}`,
        "BLOCKED",
        httpStatus,
        run,
      );
    }
    if (run.status === "FAILED" || run.status === "STOPPED" || run.status === "TIMED_OUT") {
      throw new MonidError(`Monid run ${run.status}`, "RUN_FAILED", httpStatus, run);
    }
    const ps = run.providerResponse?.httpStatus;
    if (httpStatus >= 300 || (ps !== undefined && (ps < 200 || ps >= 300))) {
      throw new MonidError(
        `${run.provider} ${run.endpoint} answered ${ps ?? httpStatus}: ${JSON.stringify(run.providerResponse?.error ?? null).slice(0, 300)}`,
        ps === 429 ? "RATE_LIMITED" : "PROVIDER_ERROR",
        ps ?? httpStatus,
        run,
      );
    }
    return run;
  }

  const client: MonidClient = {
    async inspect(provider, endpoint) {
      const r = await call("POST", "/v1/inspect", { provider, endpoint });
      if (r.status !== 200) throw errorFor(r.status, r.body, r.requestId);
      const p = MonidInspectSchema.safeParse(r.body);
      if (!p.success) throw new MonidError(`Monid inspect: ${p.error.message}`, "BAD_RESPONSE");
      return p.data;
    },

    async run<T>(req: MonidRunRequest, outputSchema?: z.ZodType<T>) {
      if (typeof req.maxCostMicroUsd !== "bigint" || req.maxCostMicroUsd < 0n) {
        throw new TypeError("maxCostMicroUsd is required and must be a non-negative bigint");
      }
      if (
        opts.spendCapMicroUsd !== undefined &&
        spent + req.maxCostMicroUsd > opts.spendCapMicroUsd
      ) {
        throw new MonidError(
          `spend cap: ${spent} spent + ${req.maxCostMicroUsd} maxCost > cap ${opts.spendCapMicroUsd} micro-USD`,
          "SPEND_CAP",
        );
      }
      const r = await call("POST", "/v1/run", {
        provider: req.provider,
        endpoint: req.endpoint,
        input: req.input ?? {},
        maxCost: microUsdToUsdWire(req.maxCostMicroUsd),
      });
      // Provider non-2xx comes back with the provider's status and a full run body; provider 402 → 502.
      const looksLikeRun =
        typeof r.body === "object" && r.body !== null && "runId" in r.body && "status" in r.body;
      if (!looksLikeRun) throw errorFor(r.status, r.body, r.requestId);
      let run = toRun<T>(r.body, outputSchema);
      if (r.status === 202 || !TERMINAL.has(run.status)) {
        const deadline = Date.now() + opts.pollTimeoutMs;
        while (!TERMINAL.has(run.status)) {
          if (Date.now() > deadline) {
            throw new MonidError(
              `Monid run ${run.runId} still ${run.status}`,
              "POLL_TIMEOUT",
              202,
              run,
            );
          }
          await sleep(opts.pollIntervalMs);
          run = await client.getRun<T>(run.runId, outputSchema);
        }
        return settle(run, 200);
      }
      return settle(run, r.status);
    },

    async getRun<T>(runId: string, outputSchema?: z.ZodType<T>) {
      const r = await call("GET", `/v1/runs/${encodeURIComponent(runId)}`);
      if (r.status !== 200) throw errorFor(r.status, r.body, r.requestId);
      return toRun<T>(r.body, outputSchema);
    },

    async balance() {
      const r = await call("GET", "/v1/wallet/balance");
      if (r.status !== 200) throw errorFor(r.status, r.body, r.requestId);
      const p = MonidBalanceSchema.safeParse(r.body);
      if (!p.success) throw new MonidError(`Monid balance: ${p.error.message}`, "BAD_RESPONSE");
      return { balanceMicroUsd: p.data.balance, heldMicroUsd: p.data.held };
    },

    spentMicroUsd: () => spent,
  };
  return client;
}

/** Build a client from env (MONID_API_KEY, optional MONID_BASE_URL). */
export function createMonidClientFromEnv(
  env: Record<string, string | undefined> = process.env,
  extra: Omit<MonidClientOptions, "apiKey" | "baseUrl"> = {},
): MonidClient {
  return createMonidClient({
    apiKey: (env.MONID_API_KEY ?? "").trim().replace(/^["']|["']$/g, ""),
    ...(env.MONID_BASE_URL ? { baseUrl: env.MONID_BASE_URL } : {}),
    ...extra,
  });
}
