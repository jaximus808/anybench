// Context.dev REST client for lead sourcing (docs/findings/outreach-spike.md section 3).
// Base https://api.context.dev/v1, `Authorization: Bearer <CONTEXT_DEV_API_KEY>`.
//
// Credits are the budget here (not money): `/web/search` costs 1 credit per 10 results. The client
// keeps a per-instance ledger and refuses a search whose estimate would push it past `creditCap`
// (OUTREACH_CONTEXT_DEV_CREDIT_CAP). `/web/search` is limited to 2 concurrent requests per key, so
// the client never has more than `maxConcurrency` (default 2) in flight.

import { z } from "zod";
import type { FetchLike } from "./monid.js";

export const DEFAULT_CONTEXT_DEV_BASE_URL = "https://api.context.dev/v1";

export const ContextDevClientOptionsSchema = z.object({
  apiKey: z.string().min(1, "CONTEXT_DEV_API_KEY is empty"),
  baseUrl: z.string().url().default(DEFAULT_CONTEXT_DEV_BASE_URL),
  /** Most credits this client instance may spend. */
  creditCap: z.number().int().nonnegative(),
  /** Context.dev enforces concurrency 2 on /web/search; never go above it. */
  maxConcurrency: z.number().int().min(1).max(2).default(2),
  /** Retries on 429 (concurrency) before giving up. */
  maxRetries: z.number().int().nonnegative().default(2),
});
export type ContextDevClientOptions = z.input<typeof ContextDevClientOptionsSchema> & {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
};

export const WEB_SEARCH_FRESHNESS = ["last_day", "last_week", "last_month", "last_year"] as const;

export const WebSearchRequestSchema = z.object({
  query: z.string().min(1),
  freshness: z.enum(WEB_SEARCH_FRESHNESS).optional(),
  numResults: z.number().int().min(1).max(100).default(10),
});
export type WebSearchRequest = z.input<typeof WebSearchRequestSchema>;

export const WebSearchResultSchema = z.looseObject({
  url: z.string(),
  title: z.string().default(""),
  description: z.string().nullish(),
  relevance: z.string().nullish(),
});
export type WebSearchResult = z.output<typeof WebSearchResultSchema>;

const WebSearchBodySchema = z.looseObject({
  results: z.array(WebSearchResultSchema),
  key_metadata: z
    .looseObject({
      credits_consumed: z.number().int().nonnegative().optional(),
      credits_remaining: z.number().int().optional(),
    })
    .optional(),
  request_id: z.string().optional(),
});

const UsageBodySchema = z.looseObject({
  credits_remaining: z.number().int(),
  period: z.looseObject({ credits_used: z.number().int().optional() }).optional(),
});

export interface WebSearchResponse {
  results: WebSearchResult[];
  creditsUsed: number;
  creditsRemaining: number | undefined;
  requestId: string | undefined;
}

export type ContextDevErrorCode =
  | "CREDIT_CAP"
  | "USAGE_EXCEEDED"
  | "UNAUTHORIZED"
  | "RATE_LIMITED"
  | "BAD_REQUEST"
  | "BAD_RESPONSE"
  | "HTTP_ERROR";

export class ContextDevError extends Error {
  override readonly name = "ContextDevError";
  constructor(
    message: string,
    readonly code: ContextDevErrorCode,
    readonly status?: number,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

export interface ContextDevClient {
  webSearch(req: WebSearchRequest): Promise<WebSearchResponse>;
  /** GET /org/usage (free). */
  usage(): Promise<{ creditsRemaining: number }>;
  /** Credits spent through this instance. */
  creditsUsed(): number;
  readonly creditCap: number;
}

/** Credits a /web/search with these options will cost (1 per 10 results, no highlights/markdown). */
export function estimateSearchCredits(numResults: number): number {
  return Math.ceil(numResults / 10);
}

/** A tiny counting semaphore. */
function limiter(max: number) {
  let active = 0;
  const waiters: (() => void)[] = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    while (active >= max) await new Promise<void>((r) => waiters.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiters.shift()?.();
    }
  };
}

export function createContextDevClient(options: ContextDevClientOptions): ContextDevClient {
  const opts = ContextDevClientOptionsSchema.parse(options);
  const doFetch: FetchLike = options.fetch ?? ((u, i) => fetch(u, i));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const limit = limiter(opts.maxConcurrency);
  let used = 0;
  // Credits reserved by searches in flight, so two concurrent searches can't both pass the cap check.
  let reserved = 0;

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
    return { status: res.status, headers: res.headers, body };
  }

  function errorFor(status: number, body: unknown, requestId?: string): ContextDevError {
    const text = typeof body === "string" ? body : JSON.stringify(body ?? null);
    const usage = /USAGE_EXCEEDED/.test(text);
    const code: ContextDevErrorCode =
      status === 402 || usage
        ? "USAGE_EXCEEDED"
        : status === 401 || status === 403
          ? "UNAUTHORIZED"
          : status === 429
            ? "RATE_LIMITED"
            : status === 400 || status === 422
              ? "BAD_REQUEST"
              : "HTTP_ERROR";
    return new ContextDevError(
      `Context.dev HTTP ${status}: ${text.slice(0, 300)}`,
      code,
      status,
      requestId,
    );
  }

  return {
    creditCap: opts.creditCap,
    creditsUsed: () => used,

    async webSearch(raw) {
      const req = WebSearchRequestSchema.parse(raw);
      const estimate = estimateSearchCredits(req.numResults);
      if (used + reserved + estimate > opts.creditCap) {
        throw new ContextDevError(
          `credit cap: ${used} used + ${reserved} reserved + ${estimate} estimated > cap ${opts.creditCap}`,
          "CREDIT_CAP",
        );
      }
      reserved += estimate;
      try {
        return await limit(async () => {
          for (let attempt = 0; ; attempt++) {
            const r = await call("POST", "/web/search", req);
            const requestId = r.headers.get("x-request-id") ?? undefined;
            if (r.status === 429 && attempt < opts.maxRetries) {
              const after = Number(r.headers.get("retry-after") ?? "");
              await sleep(
                Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * (attempt + 1),
              );
              continue;
            }
            if (r.status !== 200) throw errorFor(r.status, r.body, requestId);
            const p = WebSearchBodySchema.safeParse(r.body);
            if (!p.success) {
              throw new ContextDevError(
                `Context.dev /web/search response: ${p.error.message}`,
                "BAD_RESPONSE",
                200,
                requestId,
              );
            }
            const header = Number(r.headers.get("x-credits-used") ?? "");
            const spent = Number.isInteger(header)
              ? header
              : (p.data.key_metadata?.credits_consumed ?? estimate);
            used += spent;
            return {
              results: p.data.results,
              creditsUsed: spent,
              creditsRemaining: p.data.key_metadata?.credits_remaining,
              requestId: requestId ?? p.data.request_id,
            };
          }
        });
      } finally {
        reserved -= estimate;
      }
    },

    async usage() {
      const r = await call("GET", "/org/usage");
      if (r.status !== 200) {
        throw errorFor(r.status, r.body, r.headers.get("x-request-id") ?? undefined);
      }
      const p = UsageBodySchema.safeParse(r.body);
      if (!p.success) {
        throw new ContextDevError(`Context.dev /org/usage: ${p.error.message}`, "BAD_RESPONSE");
      }
      return { creditsRemaining: p.data.credits_remaining };
    },
  };
}

/** Build a client from env: CONTEXT_DEV_API_KEY, OUTREACH_CONTEXT_DEV_CREDIT_CAP (default 300). */
export function createContextDevClientFromEnv(
  env: Record<string, string | undefined> = process.env,
  extra: Partial<Pick<ContextDevClientOptions, "creditCap" | "fetch" | "sleep" | "baseUrl">> = {},
): ContextDevClient {
  const capRaw = env.OUTREACH_CONTEXT_DEV_CREDIT_CAP?.trim();
  const envCap = capRaw ? Number(capRaw) : 300;
  return createContextDevClient({
    apiKey: (env.CONTEXT_DEV_API_KEY ?? "").trim().replace(/^["']|["']$/g, ""),
    creditCap: extra.creditCap ?? envCap,
    ...(extra.baseUrl ? { baseUrl: extra.baseUrl } : {}),
    ...(extra.fetch ? { fetch: extra.fetch } : {}),
    ...(extra.sleep ? { sleep: extra.sleep } : {}),
  });
}

// ---- GitHub URL normalisation -------------------------------------------------------------------

/** First path segments on github.com that are never `owner/repo`. */
const GITHUB_RESERVED = new Set([
  "topics",
  "orgs",
  "collections",
  "sponsors",
  "marketplace",
  "features",
  "enterprise",
  "search",
  "trending",
  "explore",
  "settings",
  "about",
  "pricing",
  "apps",
  "login",
  "join",
  "site",
  "readme",
  "events",
  "customer-stories",
  "security",
  "solutions",
  "resources",
  "notifications",
  "new",
  "organizations",
  "users",
  "issues",
  "pulls",
]);

export interface GithubRepoRef {
  owner: string;
  repo: string;
  /** `owner/repo` as written in the URL. */
  fullName: string;
  /** `https://github.com/owner/repo`. */
  url: string;
  /** Lowercased URL: the dedupe key (GitHub owner/repo names are case-insensitive). */
  key: string;
}

/** True for curated lists: `awesome-*`, `*-awesome`, `awesome`. */
export function isAwesomeList(repo: string): boolean {
  return /^awesome(?:[-_.]|$)/i.test(repo) || /[-_.]awesome$/i.test(repo);
}

/**
 * A search hit → the repo it is the ROOT page of, or null. Drops issues, pulls, topics, blobs,
 * trees, wikis, gists, profile pages and awesome lists (the spike saw all of these in
 * `site:github.com` results).
 */
export function githubRepoRoot(rawUrl: string): GithubRepoRef | null {
  let u: URL;
  try {
    u = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return null;
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/i, "");
  if (GITHUB_RESERVED.has(owner.toLowerCase())) return null;
  if (!/^[A-Za-z0-9-]{1,39}$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo)) return null;
  if (repo === "." || repo === "..") return null;
  if (isAwesomeList(repo)) return null;
  const url = `https://github.com/${owner}/${repo}`;
  return { owner, repo, fullName: `${owner}/${repo}`, url, key: url.toLowerCase() };
}

/** `owner/repo` or a github.com repo URL (the opt-in CSV accepts both). */
export function parseRepoInput(input: string): GithubRepoRef | null {
  const s = input.trim();
  if (/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(s)) {
    return githubRepoRoot(`https://github.com/${s}`);
  }
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  return githubRepoRoot(withScheme.replace(/\/+$/, ""));
}
