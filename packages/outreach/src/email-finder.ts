// Email lookup for leads that passed the fit check: Hunter `/email-finder` through Monid.
// PER_RESULT $0.0245, charged only when an address is found (inspect, 2026-11-08). Context.dev
// people-enrich returned no email in the spike, and we never read addresses from GitHub (no commit
// harvesting, no profile scraping), so this and the hackathon opt-in CSV are the only sources.

import { z } from "zod";
import type { MonidClient } from "./monid.js";
import type { MicroUsd } from "./money.js";

export const HUNTER_EMAIL_FINDER_MICRO_USD: MicroUsd = 24_500n;

export interface EmailFinderQuery {
  /** Company domain, e.g. trailhq.com. Required: Hunter guesses badly from a company name. */
  domain: string;
  fullName: string;
}

export interface FoundEmail {
  email: string;
  /** Hunter's 0-100 confidence. */
  score: number | null;
  verification: string | null;
  costMicroUsd: MicroUsd;
  runId: string;
}

const HunterOut = z.looseObject({
  email: z.string().nullish(),
  score: z.number().nullish(),
  verification: z.union([z.string(), z.looseObject({ status: z.string().nullish() })]).nullish(),
});

/** Split "Ada Lovelace" into Hunter's first/last name; a single word goes in as full_name. */
export function hunterNameParams(fullName: string): Record<string, string> {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return { first_name: parts[0]!, last_name: parts[parts.length - 1]! };
  }
  return { full_name: fullName.trim() };
}

/** null when Hunter has no address (free). Throws MonidError on SPEND_CAP and provider errors. */
export async function findEmailViaHunter(
  monid: MonidClient,
  q: EmailFinderQuery,
): Promise<FoundEmail | null> {
  const run = await monid.run({
    provider: "hunterio",
    endpoint: "/email-finder",
    input: { queryParams: { domain: q.domain, ...hunterNameParams(q.fullName), max_duration: 10 } },
    maxCostMicroUsd: HUNTER_EMAIL_FINDER_MICRO_USD,
  });
  const raw = run.output as Record<string, unknown> | undefined;
  const candidate = raw && typeof raw === "object" && "data" in raw ? raw.data : raw;
  const p = HunterOut.safeParse(candidate);
  if (!p.success || !p.data.email) return null;
  const email = z.email().safeParse(p.data.email.trim().toLowerCase());
  if (!email.success) return null;
  const v = p.data.verification;
  return {
    email: email.data,
    score: p.data.score ?? null,
    verification: typeof v === "string" ? v : (v?.status ?? null),
    costMicroUsd: run.costMicroUsd,
    runId: run.runId,
  };
}
