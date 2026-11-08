// Lead sourcing (15.2a): saved claim queries → Context.dev web-search (site:github.com) → repo
// roots only → GitHub signals (stars, last push, README claim lines) → a cheap fit check →
// Hunter-via-Monid email lookup for leads that pass → dedupe (repo URL, company domain, email) and
// suppression → `leads` rows (source=context_dev, status=new).
//
// Budgets, all per run: Context.dev credits (ContextDevClient.creditCap), GitHub calls
// (GithubSignals requestBudget), Monid micro-USD (the MonidClient's spendCapMicroUsd). Hitting one
// stops that kind of spend and says so in the report; it never overspends.

import type { MicroUsd } from "./money.js";
import { MonidError, type MonidClient } from "./monid.js";
import {
  ContextDevError,
  estimateSearchCredits,
  githubRepoRoot,
  type ContextDevClient,
  type WebSearchResult,
} from "./context-dev.js";
import {
  GithubSignalsError,
  companyDomain,
  isClaimProse,
  proseOf,
  type GithubSignals,
  type GithubUser,
  type RepoSignals,
} from "./github-signals.js";
import { findEmailViaHunter, type FoundEmail } from "./email-finder.js";
import type { LeadStore, NewLead } from "./store.js";

export interface SavedClaimQuery {
  id: string;
  description: string;
  /** Run in order until the limit is reached or credits run out. */
  queries: string[];
  freshness: "last_week" | "last_month" | "last_year";
}

/** Saved claim queries: perf/quality claims with (usually) no correctness gate behind them. */
export const SAVED_CLAIM_QUERIES: readonly SavedClaimQuery[] = [
  {
    id: "harness-perf",
    description: "Coding-agent harnesses claiming speed or token wins over Claude Code",
    queries: [
      'site:github.com ("faster than" OR benchmark OR "fewer tokens") ("Claude Code" OR "coding agent") harness',
    ],
    freshness: "last_month",
  },
  {
    id: "token-savings",
    description: "MCP servers and tools claiming token or cost savings",
    queries: [
      'site:github.com ("fewer tokens" OR "less tokens" OR "token savings" OR "cheaper") ("Claude Code" OR MCP OR "coding agent")',
    ],
    freshness: "last_month",
  },
  {
    id: "agent-benchmark",
    description: "Agents citing SWE-bench / Terminal-Bench numbers",
    queries: [
      'site:github.com ("SWE-bench" OR "Terminal-Bench") (solved OR "pass rate" OR resolved) agent -awesome',
    ],
    freshness: "last_month",
  },
  {
    id: "cli-faster",
    description: "CLIs and dev tools claiming to be N x faster",
    queries: [
      'site:github.com ("x faster" OR "faster than") CLI (agent OR LLM OR "developer tool")',
    ],
    freshness: "last_month",
  },
];

export function savedQuery(id: string): SavedClaimQuery | undefined {
  return SAVED_CLAIM_QUERIES.find((q) => q.id === id);
}

export interface FitOptions {
  /** Default 10. */
  minStars?: number;
  /** Default 180: a repo not pushed for longer isn't worth an email. */
  maxPushAgeDays?: number;
}

export interface SourceOptions {
  queryId: string;
  /** Leads to write. */
  limit: number;
  contextDev: ContextDevClient;
  github: GithubSignals;
  store: LeadStore;
  /** For Hunter email lookups (and the GitHub fallback). Its spendCapMicroUsd caps the run. */
  monid?: MonidClient | undefined;
  /** Look up emails with Hunter for leads that pass fit. Default: true when `monid` is given. */
  findEmails?: boolean;
  /** Results per search. Default: limit x 3, rounded up to 10, between 10 and 30. */
  numResults?: number;
  fit?: FitOptions;
  /** Don't write rows. */
  dryRun?: boolean;
  now?: () => number;
  log?: (line: string) => void;
}

export type SkipReason =
  | "not_repo_root"
  | "duplicate_repo"
  | "duplicate_domain"
  | "duplicate_email"
  | "suppressed"
  | "not_found"
  | "archived"
  | "fork"
  | "low_stars"
  | "stale"
  | "no_claim"
  | "github_error";

export type StopReason =
  | "limit"
  | "queries_exhausted"
  | "credit_cap"
  | "github_exhausted"
  | "spend_cap"
  /** A Monid run ended without a terminal run body; its maxCost was booked and Monid halted. */
  | "monid_charge_unknown";

export interface SourcedLead {
  id: string | null;
  githubUrl: string;
  email: string | null;
  claims: number;
}

export interface SourceReport {
  queryId: string;
  dryRun: boolean;
  searches: {
    query: string;
    results: number;
    creditsUsed: number;
    requestId?: string | undefined;
  }[];
  written: SourcedLead[];
  skipped: { url: string; reason: SkipReason; detail?: string }[];
  stoppedBy: StopReason;
  contextDevCredits: number;
  githubRequests: number;
  githubExhausted: boolean;
  emailLookups: number;
  emailsFound: number;
  /** Set when Hunter lookups stopped early (spend cap) while sourcing continued. */
  emailStoppedBy?: "spend_cap" | "monid_charge_unknown" | undefined;
  /** Why the Monid client halted (unknown charge), if it did. */
  monidHalted?: string | undefined;
  monidSpentMicroUsd: MicroUsd;
}

/** A claim cited for provenance. */
export interface CitedClaim {
  text: string;
  url: string;
  line?: number;
  from: "readme" | "search_snippet";
}

function defaultNumResults(limit: number): number {
  return Math.min(30, Math.max(10, Math.ceil((limit * 3) / 10) * 10));
}

function prefit(sig: RepoSignals, fit: Required<FitOptions>, now: number): SkipReason | null {
  if (sig.archived) return "archived";
  if (sig.fork) return "fork";
  if (sig.stars < fit.minStars) return "low_stars";
  if (sig.pushedAt) {
    const age = (now - Date.parse(sig.pushedAt)) / 86_400_000;
    if (Number.isFinite(age) && age > fit.maxPushAgeDays) return "stale";
  }
  return null;
}

/** The snippet sentence that carries the claim, when the search snippet has one. */
function snippetClaim(r: WebSearchResult): string | null {
  const text = proseOf(`${r.description ?? ""}`);
  if (!text) return null;
  const sentences = text.split(/(?<=[.!?])\s+|\s\.\.\.\s?/).map((s) => s.trim());
  return sentences.find((s) => isClaimProse(s))?.slice(0, 240) ?? null;
}

export async function runSourcing(o: SourceOptions): Promise<SourceReport> {
  const q = savedQuery(o.queryId);
  if (!q) {
    throw new Error(
      `unknown saved query "${o.queryId}"; known: ${SAVED_CLAIM_QUERIES.map((x) => x.id).join(", ")}`,
    );
  }
  if (!Number.isInteger(o.limit) || o.limit < 1)
    throw new Error("--limit must be a positive integer");
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => {});
  const fit: Required<FitOptions> = {
    minStars: o.fit?.minStars ?? 10,
    maxPushAgeDays: o.fit?.maxPushAgeDays ?? 180,
  };
  const findEmails = o.findEmails ?? o.monid !== undefined;
  const numResults = o.numResults ?? defaultNumResults(o.limit);

  const report: SourceReport = {
    queryId: q.id,
    dryRun: o.dryRun ?? false,
    searches: [],
    written: [],
    skipped: [],
    stoppedBy: "queries_exhausted",
    contextDevCredits: 0,
    githubRequests: 0,
    githubExhausted: false,
    emailLookups: 0,
    emailsFound: 0,
    monidSpentMicroUsd: 0n,
  };
  const seenRepos = new Set<string>();
  const seenDomains = new Set<string>();
  const seenEmails = new Set<string>();
  let emailsOff = !findEmails || o.monid === undefined;
  const skip = (url: string, reason: SkipReason, detail?: string) => {
    report.skipped.push({ url, reason, ...(detail ? { detail } : {}) });
    log(`skip ${reason} ${url}${detail ? ` (${detail})` : ""}`);
  };

  const finish = (stop: StopReason): SourceReport => {
    report.stoppedBy = stop;
    report.contextDevCredits = o.contextDev.creditsUsed();
    report.githubRequests = o.github.requestsUsed();
    report.githubExhausted = o.github.exhausted();
    report.monidSpentMicroUsd = o.monid?.spentMicroUsd() ?? 0n;
    const halted = o.monid?.halted();
    if (halted) report.monidHalted = halted;
    return report;
  };

  for (const text of q.queries) {
    if (report.written.length >= o.limit) return finish("limit");
    const remaining = o.contextDev.creditCap - o.contextDev.creditsUsed();
    if (estimateSearchCredits(numResults) > remaining) return finish("credit_cap");
    let results: WebSearchResult[];
    try {
      const r = await o.contextDev.webSearch({ query: text, freshness: q.freshness, numResults });
      results = r.results;
      report.searches.push({
        query: text,
        results: r.results.length,
        creditsUsed: r.creditsUsed,
        requestId: r.requestId,
      });
      log(`search "${text}" → ${r.results.length} results, ${r.creditsUsed} credits`);
    } catch (err) {
      if (
        err instanceof ContextDevError &&
        (err.code === "CREDIT_CAP" || err.code === "USAGE_EXCEEDED")
      ) {
        return finish("credit_cap");
      }
      throw err;
    }
    const searchedAt = new Date(now()).toISOString();

    const refs = results.map((r, i) => ({ r, rank: i + 1, ref: githubRepoRoot(r.url) }));
    const keys = refs.flatMap((x) => (x.ref ? [x.ref.key] : []));
    const existing = await o.store.existing({ githubUrls: keys, domains: [], emails: [] });

    for (const { r, rank, ref } of refs) {
      if (report.written.length >= o.limit) return finish("limit");
      if (!ref) {
        skip(r.url, "not_repo_root");
        continue;
      }
      if (seenRepos.has(ref.key) || existing.githubUrls.has(ref.key)) {
        skip(ref.url, "duplicate_repo");
        continue;
      }
      seenRepos.add(ref.key);

      let sig: RepoSignals;
      try {
        sig = await o.github.repo(ref.owner, ref.repo);
      } catch (err) {
        if (err instanceof GithubSignalsError && err.code === "NOT_FOUND") {
          skip(ref.url, "not_found");
          continue;
        }
        if (
          err instanceof GithubSignalsError &&
          (err.code === "RATE_LIMITED" || err.code === "BUDGET")
        ) {
          return finish("github_exhausted");
        }
        if (err instanceof MonidError && err.code === "SPEND_CAP") return finish("spend_cap");
        if (err instanceof MonidError && (err.chargeUnknown || err.code === "HALTED")) {
          return finish("monid_charge_unknown");
        }
        if (err instanceof GithubSignalsError || err instanceof MonidError) {
          skip(ref.url, "github_error", err.message);
          continue;
        }
        throw err;
      }
      const repoUrl = `https://github.com/${sig.fullName}`;
      const repoKey = repoUrl.toLowerCase();
      if (repoKey !== ref.key) {
        // Canonical casing/rename differs from the search URL: check the canonical one too.
        const again = await o.store.existing({ githubUrls: [repoKey], domains: [], emails: [] });
        if (seenRepos.has(repoKey) || again.githubUrls.has(repoKey)) {
          skip(repoUrl, "duplicate_repo");
          continue;
        }
        seenRepos.add(repoKey);
      }

      const bad = prefit(sig, fit, now());
      if (bad) {
        skip(repoUrl, bad);
        continue;
      }
      if (sig.domain) {
        const d = await o.store.existing({ githubUrls: [], domains: [sig.domain], emails: [] });
        if (seenDomains.has(sig.domain) || d.domains.has(sig.domain)) {
          skip(repoUrl, "duplicate_domain", sig.domain);
          continue;
        }
      }

      let readme;
      try {
        readme = await o.github.readme(sig);
      } catch (err) {
        if (err instanceof GithubSignalsError) {
          skip(repoUrl, "github_error", err.message);
          continue;
        }
        throw err;
      }
      const claims: CitedClaim[] = readme.claims.map((c) => ({ ...c, from: "readme" as const }));
      const snippet = snippetClaim(r);
      if (snippet) claims.push({ text: snippet, url: r.url, from: "search_snippet" });
      if (claims.length === 0) {
        skip(repoUrl, "no_claim", readme.available ? undefined : "README not fetched");
        continue;
      }

      // Passed fit. Cheap checks first (free GitHub user lookup, DB dedupe and suppression by
      // domain); Hunter is paid, so it runs last and only for leads we would actually keep.
      let user: GithubUser | null = null;
      if (sig.ownerType !== "Organization") user = await o.github.user(sig.ownerLogin);
      const contactDomain =
        sig.domain ?? (sig.ownerType !== "Organization" ? companyDomain(user?.blog) : null);
      if (contactDomain && contactDomain !== sig.domain) {
        const d = await o.store.existing({ githubUrls: [], domains: [contactDomain], emails: [] });
        if (seenDomains.has(contactDomain) || d.domains.has(contactDomain)) {
          skip(repoUrl, "duplicate_domain", contactDomain);
          continue;
        }
      }
      if (contactDomain) {
        const sd = await o.store.suppressedDomains([contactDomain]);
        if (sd.has(contactDomain)) {
          skip(repoUrl, "suppressed", `an address at ${contactDomain} unsubscribed`);
          continue;
        }
      }

      let found: FoundEmail | null = null;
      if (
        !emailsOff &&
        o.monid &&
        sig.ownerType !== "Organization" &&
        user?.name &&
        contactDomain
      ) {
        try {
          report.emailLookups++;
          found = await findEmailViaHunter(o.monid, { domain: contactDomain, fullName: user.name });
          if (found) report.emailsFound++;
        } catch (err) {
          if (!(err instanceof MonidError)) throw err;
          if (err.code === "SPEND_CAP" || err.code === "HALTED") report.emailLookups--; // never ran
          if (err.code === "SPEND_CAP") {
            emailsOff = true;
            report.emailStoppedBy = "spend_cap";
          } else if (err.chargeUnknown || err.code === "HALTED") {
            // Booked at maxCost by the client, which now refuses runs: no more Hunter, no more
            // GitHub fallback for the rest of this run.
            emailsOff = true;
            report.emailStoppedBy = "monid_charge_unknown";
            log(`monid charge unknown for ${repoUrl}: ${err.code}; stopping Monid spend`);
          } else {
            log(`hunter error for ${repoUrl}: ${err.code}`);
          }
        }
      }
      const emailDomain = found ? contactDomain : null;
      const email = found?.email ?? null;
      if (email) {
        const sup = await o.store.suppressed([email]);
        if (sup.has(email)) {
          skip(repoUrl, "suppressed");
          continue;
        }
        const ex = await o.store.existing({ githubUrls: [], domains: [], emails: [email] });
        if (seenEmails.has(email) || ex.emails.has(email)) {
          skip(repoUrl, "duplicate_email");
          continue;
        }
      }

      const company =
        sig.ownerType === "Organization"
          ? sig.ownerLogin
          : user?.company?.replace(/^@/, "").trim() || null;
      const lead: NewLead = {
        source: "context_dev",
        query: q.id,
        company,
        contact: user?.name ?? sig.ownerLogin,
        email,
        githubUrl: repoUrl,
        status: "new",
        signals: {
          ...sig,
          readmePath: readme.path,
          contactDomain,
          claims,
          provenance: {
            source: "context_dev",
            queryId: q.id,
            query: text,
            searchedAt,
            searchRequestId: report.searches.at(-1)?.requestId ?? null,
            rank,
            resultUrl: r.url,
            resultTitle: r.title,
            claims,
            readme: { path: readme.path, blobSha: readme.blobSha, commitSha: readme.commitSha },
            repoVia: sig.via,
            email: found
              ? {
                  source: "hunter",
                  via: "monid",
                  domain: emailDomain,
                  score: found.score,
                  verification: found.verification,
                  runId: found.runId,
                  costMicroUsd: found.costMicroUsd.toString(),
                }
              : null,
          },
        },
      };
      let id: string | null = null;
      if (!o.dryRun) {
        const res = await o.store.insert(lead);
        if (res.duplicate) {
          // Another run inserted the same person or repo between our checks and this insert.
          skip(
            repoUrl,
            res.duplicate === "email" ? "duplicate_email" : "duplicate_repo",
            "insert conflict",
          );
          continue;
        }
        id = res.id;
      }
      if (sig.domain) seenDomains.add(sig.domain);
      if (contactDomain) seenDomains.add(contactDomain);
      if (email) seenEmails.add(email);
      report.written.push({ id, githubUrl: repoUrl, email, claims: claims.length });
      log(`lead ${repoUrl}${email ? ` <${email}>` : ""} (${claims.length} claims)`);
    }
  }
  return finish(report.written.length >= o.limit ? "limit" : "queries_exhausted");
}
