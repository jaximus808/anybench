// GitHub repo signals for a lead: stars, last push, owner, homepage and README claim lines, each
// claim cited as `https://github.com/<repo>/blob/<branch>/<path>#L<n>`.
//
// GITHUB_TOKEN is usually EMPTY (docs/findings/outreach-spike.md section 4): unauthenticated GitHub
// allows 60 core requests/hour per IP, shared with every worker on the machine. So this client
//   - spends at most `requestBudget` GitHub calls per instance (about 2 per repo: repo + README),
//   - caches every answer (`SignalCache`, a JSON file per key by default),
//   - on 403/429 reads `x-ratelimit-reset` / `retry-after`: waits if the reset is within
//     `maxWaitMs`, otherwise marks GitHub exhausted for this run,
//   - once exhausted (or over budget), falls back to Monid anyapi `/github.repository` ($0.0012,
//     metadata only, no README) when a Monid client is given.
// No commit or event endpoints are ever called: we never harvest emails from commits.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { FetchLike, MonidClient } from "./monid.js";
import type { MicroUsd } from "./money.js";

export const DEFAULT_GITHUB_API = "https://api.github.com";
/** Monid anyapi `/github.repository`: PER_CALL $0.0012 (inspect, 2026-11-08). */
export const ANYAPI_GITHUB_REPOSITORY_MICRO_USD: MicroUsd = 1_200n;

// ---- README claim lines -------------------------------------------------------------------------

export interface ClaimLine {
  /** 1-based line in the README. */
  line: number;
  /** The prose of that line with markup stripped. */
  text: string;
  /** Permalink-style citation: .../blob/<branch>/<path>#L<line>. */
  url: string;
}

/** A quantity: 46%, -80%, 0.069x, 2x, x3, "33 of 50", 1.5k tokens, 120 ms. */
const QUANTITY =
  /(?:[-+~]?\d+(?:[.,]\d+)?\s?%|\b\d+(?:\.\d+)?\s?x\b|\bx\s?\d+(?:\.\d+)?\b|\b\d+\s+(?:of|out of)\s+\d+\b|\b\d+(?:\.\d+)?\s?(?:k|m)?\s?(?:tokens?|ms|s|sec|seconds|minutes|min)\b|\d+(?:\.\d+)?\s?(?:→|->|to)\s?\d+(?:\.\d+)?)/gi;

/** A performance or quality claim word that must sit near the quantity. */
const CLAIM_WORD =
  /\b(?:faster|slower|speed[- ]?up|quicker|fewer|less|lower|more|higher|cheaper|cost|costs|credits|reduc\w*|cut\w*|sav\w*|improv\w*|better|outperform\w*|beat\w*|tokens?|wall[- ]?(?:clock|time)|latency|throughput|time|benchmark\w*|bench|solved|solves|accuracy|accurate|pass(?:es|ed)?|pass rate|resolved|score[sd]?|swe-?bench|terminal-?bench|tool calls?|efficient|efficiency|vs\.?|versus|than)\b/i;

/** How far (characters) a claim word may be from the quantity. */
const NEAR = 60;

/** Strip markdown/HTML so attributes like width="25%" and badge URLs can never match. */
export function proseOf(line: string): string {
  return (
    line
      // badges and images: [![alt](img)](link), ![alt](img)
      .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, " ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      // HTML tags (with every attribute inside them)
      .replace(/<[^>]*>/g, " ")
      // links: keep the text, drop the URL; bare URLs
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\bhttps?:\/\/\S+/g, " ")
      // reference-style link definitions: [x]: url
      .replace(/^\s*\[[^\]]+\]:\s*\S+.*$/, " ")
      // inline code: commands and flags, not claims
      .replace(/`[^`]*`/g, " ")
      // HTML entities
      .replace(/&[a-z]+;|&#\d+;/gi, " ")
      // markdown emphasis, headings, block quotes, list bullets, table pipes
      .replace(/[*_]{1,3}/g, "")
      .replace(/^\s*(?:#{1,6}|>|[-+*]|\d+\.)\s+/, "")
      .replace(/\|/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** True when the prose has a quantity with a claim word within NEAR characters of it. */
export function isClaimProse(prose: string): boolean {
  if (prose.length < 6) return false;
  for (const m of prose.matchAll(QUANTITY)) {
    const start = Math.max(0, (m.index ?? 0) - NEAR);
    const end = Math.min(prose.length, (m.index ?? 0) + m[0].length + NEAR);
    const window = prose.slice(start, end).replace(m[0], " ");
    if (CLAIM_WORD.test(window)) return true;
  }
  return false;
}

export interface ExtractClaimsOptions {
  fullName: string;
  branch: string;
  path: string;
  max?: number;
}

/** README markdown → cited claim lines (prose only: code fences, HTML comments and markup skipped). */
export function extractReadmeClaims(markdown: string, o: ExtractClaimsOptions): ClaimLine[] {
  const out: ClaimLine[] = [];
  const max = o.max ?? 10;
  let fence: string | null = null;
  let inComment = false;
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length && out.length < max; i++) {
    let raw = lines[i]!;
    const f = /^\s*(```+|~~~+)/.exec(raw);
    if (f) {
      if (fence === null) fence = f[1]!.slice(0, 3);
      else if (f[1]!.startsWith(fence)) fence = null;
      continue;
    }
    if (fence !== null) continue;
    if (inComment) {
      const end = raw.indexOf("-->");
      if (end < 0) continue;
      inComment = false;
      raw = raw.slice(end + 3);
    }
    raw = raw.replace(/<!--.*?-->/g, " ");
    const open = raw.indexOf("<!--");
    if (open >= 0) {
      inComment = true;
      raw = raw.slice(0, open);
    }
    const prose = proseOf(raw);
    if (!isClaimProse(prose)) continue;
    out.push({
      line: i + 1,
      text: prose.slice(0, 240),
      url: `https://github.com/${o.fullName}/blob/${o.branch}/${o.path}#L${i + 1}`,
    });
  }
  return out;
}

// ---- domains ------------------------------------------------------------------------------------

/** Hosts that say nothing about who the lead works for. */
const NON_COMPANY_HOSTS = [
  "github.com",
  "github.io",
  "githubusercontent.com",
  "gitlab.com",
  "npmjs.com",
  "npmjs.org",
  "pypi.org",
  "crates.io",
  "docs.rs",
  "readthedocs.io",
  "huggingface.co",
  "vercel.app",
  "netlify.app",
  "pages.dev",
  "x.com",
  "twitter.com",
  "linkedin.com",
  "medium.com",
  "substack.com",
  "youtube.com",
  "youtu.be",
  "discord.gg",
  "discord.com",
  "notion.site",
  "gitbook.io",
  "arxiv.org",
  "google.com",
  "bit.ly",
  "linktr.ee",
  // webmail: an address domain, never a company
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "yahoo.com",
  "icloud.com",
  "proton.me",
  "protonmail.com",
];

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu"]);

/** A homepage/blog URL → its registrable domain (trailhq.com/x → trailhq.com), or null. */
export function companyDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  let host: string;
  try {
    host = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  host = host.replace(/^www\./, "");
  if (!host.includes(".") || /^\d+(\.\d+){3}$/.test(host)) return null;
  if (NON_COMPANY_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return null;
  const labels = host.split(".");
  const n = labels.length;
  const keep = n >= 3 && SECOND_LEVEL.has(labels[n - 2]!) && labels[n - 1]!.length === 2 ? 3 : 2;
  return labels.slice(-keep).join(".");
}

// ---- cache --------------------------------------------------------------------------------------

export interface SignalCache {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

export function createMemoryCache(): SignalCache & { size(): number } {
  const m = new Map<string, unknown>();
  return { get: (k) => m.get(k), set: (k, v) => void m.set(k, v), size: () => m.size };
}

/** One JSON file per key under `dir`, ignored once older than `ttlMs` (default 24 h). */
export function createFileCache(
  dir: string,
  ttlMs = 24 * 3600_000,
  now: () => number = Date.now,
): SignalCache {
  const file = (k: string) => join(dir, `${k.replace(/[^A-Za-z0-9._-]+/g, "__")}.json`);
  return {
    get(k) {
      try {
        const j = JSON.parse(readFileSync(file(k), "utf8")) as { at: number; value: unknown };
        return now() - j.at <= ttlMs ? j.value : undefined;
      } catch {
        return undefined;
      }
    },
    set(k, value) {
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(file(k), JSON.stringify({ at: now(), value }));
      } catch {
        /* a cache write failure never fails sourcing */
      }
    },
  };
}

// ---- signals ------------------------------------------------------------------------------------

export const RepoSignalsSchema = z.object({
  fullName: z.string(),
  url: z.string(),
  ownerLogin: z.string(),
  ownerType: z.enum(["User", "Organization"]).nullable(),
  homepage: z.string().nullable(),
  /** Registrable domain of the homepage (company dedupe key), when it names a company. */
  domain: z.string().nullable(),
  description: z.string().nullable(),
  stars: z.number().int().nonnegative(),
  forks: z.number().int().nonnegative().nullable(),
  language: z.string().nullable(),
  topics: z.array(z.string()),
  license: z.string().nullable(),
  pushedAt: z.string().nullable(),
  createdAt: z.string().nullable(),
  archived: z.boolean(),
  fork: z.boolean(),
  defaultBranch: z.string(),
  /** Where the metadata came from. */
  via: z.enum(["github_api", "monid_anyapi"]),
  fetchedAt: z.string(),
});
export type RepoSignals = z.infer<typeof RepoSignalsSchema>;

export const ReadmeSignalsSchema = z.object({
  available: z.boolean(),
  path: z.string().nullable(),
  /** Git blob SHA of the README as fetched (from /readme): pins exactly which text was cited. */
  blobSha: z.string().nullable().default(null),
  /** Commit SHA the claim URLs are pinned to; only fetched when a GITHUB_TOKEN is set. */
  commitSha: z.string().nullable().default(null),
  claims: z.array(z.object({ line: z.number().int(), text: z.string(), url: z.string() })),
});
export type ReadmeSignals = z.infer<typeof ReadmeSignalsSchema>;

export const GithubUserSchema = z.object({
  login: z.string(),
  type: z.string().nullable(),
  name: z.string().nullable(),
  company: z.string().nullable(),
  blog: z.string().nullable(),
});
export type GithubUser = z.infer<typeof GithubUserSchema>;

const GhRepoWire = z.looseObject({
  full_name: z.string(),
  html_url: z.string(),
  owner: z.looseObject({ login: z.string(), type: z.string().optional() }),
  homepage: z.string().nullish(),
  description: z.string().nullish(),
  stargazers_count: z.number().int().nonnegative(),
  forks_count: z.number().int().nonnegative().nullish(),
  language: z.string().nullish(),
  topics: z.array(z.string()).nullish(),
  license: z.looseObject({ spdx_id: z.string().nullish() }).nullish(),
  pushed_at: z.string().nullish(),
  created_at: z.string().nullish(),
  archived: z.boolean().default(false),
  fork: z.boolean().default(false),
  default_branch: z.string().default("main"),
});

const GhReadmeWire = z.looseObject({
  path: z.string(),
  sha: z.string().nullish(),
  content: z.string(),
  encoding: z.string(),
});

/** GET /repos/{o}/{r}/git/ref/heads/{branch}: just the ref, no author data. */
const GhRefWire = z.looseObject({ object: z.looseObject({ sha: z.string() }) });

const GhUserWire = z.looseObject({
  login: z.string(),
  type: z.string().nullish(),
  name: z.string().nullish(),
  company: z.string().nullish(),
  blog: z.string().nullish(),
});

/** anyapi `/github.repository` output (camelCase; see inspect summary in the spike findings). */
const AnyApiRepoWire = z.looseObject({
  fullName: z.string(),
  url: z.string().optional(),
  homepage: z.string().nullish(),
  description: z.string().nullish(),
  stars: z.number().int().nonnegative(),
  forks: z.number().int().nonnegative().nullish(),
  language: z.string().nullish(),
  topics: z.array(z.string()).nullish(),
  license: z.union([z.string(), z.looseObject({ spdxId: z.string().nullish() })]).nullish(),
  pushedAt: z.string().nullish(),
  createdUtc: z.string().nullish(),
  archived: z.boolean().default(false),
  fork: z.boolean().default(false),
  defaultBranch: z.string().default("main"),
  owner: z
    .union([
      z.string(),
      z.looseObject({ login: z.string().optional(), type: z.string().optional() }),
    ])
    .nullish(),
});

export type GithubErrorCode =
  "RATE_LIMITED" | "BUDGET" | "NOT_FOUND" | "HTTP_ERROR" | "BAD_RESPONSE";

export class GithubSignalsError extends Error {
  override readonly name = "GithubSignalsError";
  constructor(
    message: string,
    readonly code: GithubErrorCode,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface GithubSignalsOptions {
  token?: string | undefined;
  baseUrl?: string;
  /** Most GitHub REST calls this instance may make. Default 40 (of 60/h shared). */
  requestBudget?: number;
  /** Wait for a rate-limit reset only if it is at most this far away. Default 60 s. */
  maxWaitMs?: number;
  cache?: SignalCache;
  /** Fallback for repo metadata once GitHub is exhausted (skipped once the client has halted). */
  monid?: MonidClient | undefined;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface GithubSignals {
  repo(owner: string, repo: string): Promise<RepoSignals>;
  readme(sig: Pick<RepoSignals, "fullName" | "defaultBranch">): Promise<ReadmeSignals>;
  user(login: string): Promise<GithubUser | null>;
  /** GitHub REST calls made (cache hits are free). */
  requestsUsed(): number;
  /** True once GitHub said 403/429 with no reset in reach, or the budget ran out. */
  exhausted(): boolean;
  /** Micro-USD spent on the Monid fallback. */
  fallbackSpentMicroUsd(): MicroUsd;
}

function mapGhRepo(w: z.output<typeof GhRepoWire>, now: number): RepoSignals {
  const t = w.owner.type;
  return {
    fullName: w.full_name,
    url: w.html_url,
    ownerLogin: w.owner.login,
    ownerType: t === "User" || t === "Organization" ? t : null,
    homepage: w.homepage || null,
    domain: companyDomain(w.homepage),
    description: w.description ?? null,
    stars: w.stargazers_count,
    forks: w.forks_count ?? null,
    language: w.language ?? null,
    topics: w.topics ?? [],
    license: w.license?.spdx_id ?? null,
    pushedAt: w.pushed_at ?? null,
    createdAt: w.created_at ?? null,
    archived: w.archived,
    fork: w.fork,
    defaultBranch: w.default_branch,
    via: "github_api",
    fetchedAt: new Date(now).toISOString(),
  };
}

function mapAnyApiRepo(w: z.output<typeof AnyApiRepoWire>, now: number): RepoSignals {
  const ownerLogin =
    typeof w.owner === "string" ? w.owner : (w.owner?.login ?? w.fullName.split("/")[0] ?? "");
  const ownerTypeRaw = typeof w.owner === "object" && w.owner ? w.owner.type : undefined;
  const license = typeof w.license === "string" ? w.license : (w.license?.spdxId ?? null);
  return {
    fullName: w.fullName,
    url: w.url ?? `https://github.com/${w.fullName}`,
    ownerLogin,
    ownerType: ownerTypeRaw === "User" || ownerTypeRaw === "Organization" ? ownerTypeRaw : null,
    homepage: w.homepage || null,
    domain: companyDomain(w.homepage),
    description: w.description ?? null,
    stars: w.stars,
    forks: w.forks ?? null,
    language: w.language ?? null,
    topics: w.topics ?? [],
    license,
    pushedAt: w.pushedAt ?? null,
    createdAt: w.createdUtc ?? null,
    archived: w.archived,
    fork: w.fork,
    defaultBranch: w.defaultBranch,
    via: "monid_anyapi",
    fetchedAt: new Date(now).toISOString(),
  };
}

export function createGithubSignals(o: GithubSignalsOptions = {}): GithubSignals {
  const base = o.baseUrl ?? DEFAULT_GITHUB_API;
  const budget = o.requestBudget ?? 40;
  const maxWaitMs = o.maxWaitMs ?? 60_000;
  const cache = o.cache ?? createMemoryCache();
  const doFetch: FetchLike = o.fetch ?? ((u, i) => fetch(u, i));
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  let used = 0;
  let exhausted = false;
  let fallbackSpent = 0n;

  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "anybench-outreach",
    "x-github-api-version": "2022-11-28",
  };
  if (o.token) headers.authorization = `Bearer ${o.token}`;

  /** One GitHub GET with budget + rate-limit handling. Returns null on 404. */
  async function gh(path: string): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (exhausted) throw new GithubSignalsError("GitHub rate limit exhausted", "RATE_LIMITED");
      if (used >= budget) {
        exhausted = true;
        throw new GithubSignalsError(`GitHub request budget ${budget} spent`, "BUDGET");
      }
      used++;
      const res = await doFetch(`${base}${path}`, { headers });
      const remaining = res.headers.get("x-ratelimit-remaining");
      if (res.status === 403 || res.status === 429) {
        const reset = Number(res.headers.get("x-ratelimit-reset") ?? "");
        const retryAfter = Number(res.headers.get("retry-after") ?? "");
        const waitMs =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : Number.isFinite(reset) && reset > 0
              ? reset * 1000 - now()
              : Number.POSITIVE_INFINITY;
        const limited = res.status === 429 || remaining === "0" || Number.isFinite(retryAfter);
        if (!limited) {
          throw new GithubSignalsError(
            `GitHub ${path}: HTTP ${res.status}`,
            "HTTP_ERROR",
            res.status,
          );
        }
        if (attempt === 0 && waitMs <= maxWaitMs) {
          await sleep(Math.max(0, waitMs) + 1000);
          continue;
        }
        exhausted = true;
        throw new GithubSignalsError(`GitHub ${path}: rate limited`, "RATE_LIMITED", res.status);
      }
      // Stop BEFORE the next call would be refused (other workers share the IP).
      if (remaining === "0") exhausted = true;
      if (res.status === 404) return null;
      if (res.status !== 200) {
        throw new GithubSignalsError(
          `GitHub ${path}: HTTP ${res.status}`,
          "HTTP_ERROR",
          res.status,
        );
      }
      return (await res.json()) as unknown;
    }
    throw new GithubSignalsError(`GitHub ${path}: rate limited`, "RATE_LIMITED");
  }

  async function viaMonid(fullName: string): Promise<RepoSignals> {
    if (!o.monid) {
      throw new GithubSignalsError(
        "GitHub is rate limited and no Monid fallback is configured",
        "RATE_LIMITED",
      );
    }
    const run = await o.monid.run({
      provider: "anyapi",
      endpoint: "/github.repository",
      input: { body: { url: `https://github.com/${fullName}` } },
      maxCostMicroUsd: ANYAPI_GITHUB_REPOSITORY_MICRO_USD,
    });
    fallbackSpent += run.costMicroUsd;
    const out = run.output as Record<string, unknown> | undefined;
    // Accept the object either bare or wrapped in {data} / {result}.
    const candidate = out && typeof out === "object" ? (out.data ?? out.result ?? out) : out;
    const p = AnyApiRepoWire.safeParse(candidate);
    if (!p.success) {
      throw new GithubSignalsError(`anyapi /github.repository: ${p.error.message}`, "BAD_RESPONSE");
    }
    return mapAnyApiRepo(p.data, now());
  }

  return {
    requestsUsed: () => used,
    exhausted: () => exhausted,
    fallbackSpentMicroUsd: () => fallbackSpent,

    async repo(owner, repo) {
      const key = `repo:${owner}/${repo}`.toLowerCase();
      const hit = RepoSignalsSchema.safeParse(cache.get(key));
      if (hit.success) return hit.data;
      let sig: RepoSignals;
      try {
        const body = await gh(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
        if (body === null)
          throw new GithubSignalsError(`${owner}/${repo} not found`, "NOT_FOUND", 404);
        const p = GhRepoWire.safeParse(body);
        if (!p.success) {
          throw new GithubSignalsError(
            `GitHub repo ${owner}/${repo}: ${p.error.message}`,
            "BAD_RESPONSE",
          );
        }
        sig = mapGhRepo(p.data, now());
      } catch (err) {
        const limited =
          err instanceof GithubSignalsError &&
          (err.code === "RATE_LIMITED" || err.code === "BUDGET");
        // No fallback configured, or Monid halted after an unknown charge: surface GitHub's reason.
        if (!limited || !o.monid || o.monid.halted() !== undefined) throw err;
        sig = await viaMonid(`${owner}/${repo}`);
      }
      cache.set(key, sig);
      return sig;
    },

    async readme(sig) {
      const key = `readme:${sig.fullName}`.toLowerCase();
      const hit = ReadmeSignalsSchema.safeParse(cache.get(key));
      if (hit.success) return hit.data;
      const unavailable: ReadmeSignals = {
        available: false,
        path: null,
        blobSha: null,
        commitSha: null,
        claims: [],
      };
      if (exhausted) return unavailable;
      let body: unknown;
      try {
        body = await gh(
          `/repos/${sig.fullName.split("/").map(encodeURIComponent).join("/")}/readme`,
        );
      } catch (err) {
        if (
          err instanceof GithubSignalsError &&
          (err.code === "RATE_LIMITED" || err.code === "BUDGET")
        ) {
          return unavailable;
        }
        throw err;
      }
      let out: ReadmeSignals;
      if (body === null) {
        out = { available: true, path: null, blobSha: null, commitSha: null, claims: [] };
      } else {
        const p = GhReadmeWire.safeParse(body);
        if (!p.success) {
          throw new GithubSignalsError(
            `GitHub readme ${sig.fullName}: ${p.error.message}`,
            "BAD_RESPONSE",
          );
        }
        const text =
          p.data.encoding === "base64"
            ? Buffer.from(p.data.content, "base64").toString("utf8")
            : p.data.content;
        // Pin claim URLs to a commit only with a token: one extra call per repo is fine at 5,000/h,
        // not at the shared 60/h. Without it, the blob SHA still records exactly what was cited.
        let commitSha: string | null = null;
        if (o.token) {
          try {
            const ref = GhRefWire.safeParse(
              await gh(
                `/repos/${sig.fullName.split("/").map(encodeURIComponent).join("/")}/git/ref/heads/${encodeURIComponent(sig.defaultBranch)}`,
              ),
            );
            if (ref.success) commitSha = ref.data.object.sha;
          } catch (err) {
            if (!(err instanceof GithubSignalsError)) throw err;
          }
        }
        out = {
          available: true,
          path: p.data.path,
          blobSha: p.data.sha ?? null,
          commitSha,
          claims: extractReadmeClaims(text, {
            fullName: sig.fullName,
            branch: commitSha ?? sig.defaultBranch,
            path: p.data.path,
          }),
        };
      }
      cache.set(key, out);
      return out;
    },

    async user(login) {
      const key = `user:${login}`.toLowerCase();
      const hit = GithubUserSchema.safeParse(cache.get(key));
      if (hit.success) return hit.data;
      if (exhausted) return null;
      let body: unknown;
      try {
        body = await gh(`/users/${encodeURIComponent(login)}`);
      } catch (err) {
        if (
          err instanceof GithubSignalsError &&
          (err.code === "RATE_LIMITED" || err.code === "BUDGET")
        ) {
          return null;
        }
        throw err;
      }
      if (body === null) return null;
      const p = GhUserWire.safeParse(body);
      if (!p.success) return null;
      // Deliberately NOT reading the profile `email`: addresses come from Hunter or the opt-in CSV.
      const u: GithubUser = {
        login: p.data.login,
        type: p.data.type ?? null,
        name: p.data.name?.trim() || null,
        company: p.data.company?.trim() || null,
        blog: p.data.blog?.trim() || null,
      };
      cache.set(key, u);
      return u;
    },
  };
}
