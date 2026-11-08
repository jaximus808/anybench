// Where sourcing and import write leads: the `leads` and `suppressions` tables (apps/server
// schema, migration 0000). `PgLeadStore` takes any `pg`-style client (`query(text, values)`), so
// this package doesn't depend on a driver; `MemoryLeadStore` backs the tests.

import { LeadIdSchema, newId } from "@anybench/core";
import { z } from "zod";

export const LEAD_SOURCES = ["context_dev", "hackathon_optin"] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const NewLeadSchema = z.object({
  source: z.enum(LEAD_SOURCES),
  query: z.string().nullable(),
  company: z.string().nullable(),
  contact: z.string().nullable(),
  email: z.email().nullable(),
  githubUrl: z.url().nullable(),
  /** Repo signals + `provenance` (where the lead came from, with each cited claim line and URL). */
  signals: z.record(z.string(), z.unknown()),
  status: z.literal("new"),
});
export type NewLead = z.infer<typeof NewLeadSchema>;

export interface ExistingKeys {
  githubUrls: Set<string>;
  domains: Set<string>;
  emails: Set<string>;
}

export interface LeadStore {
  /** Which of these (lowercased) repo URLs, company domains and emails already have a lead. */
  existing(keys: {
    githubUrls: string[];
    domains: string[];
    emails: string[];
  }): Promise<ExistingKeys>;
  /** Which of these (lowercased) emails are on the suppression list. */
  suppressed(emails: string[]): Promise<Set<string>>;
  insert(lead: NewLead): Promise<{ id: string }>;
}

const lower = (xs: string[]) => [...new Set(xs.map((x) => x.trim().toLowerCase()).filter(Boolean))];

export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export class PgLeadStore implements LeadStore {
  constructor(private readonly db: Queryable) {}

  async existing(keys: { githubUrls: string[]; domains: string[]; emails: string[] }) {
    const g = lower(keys.githubUrls);
    const d = lower(keys.domains);
    const e = lower(keys.emails);
    const out: ExistingKeys = { githubUrls: new Set(), domains: new Set(), emails: new Set() };
    if (g.length) {
      const r = await this.db.query(
        "select distinct lower(github_url) as k from leads where lower(github_url) = any($1::text[])",
        [g],
      );
      for (const row of r.rows) out.githubUrls.add(String(row.k));
    }
    if (d.length) {
      const r = await this.db.query(
        "select distinct lower(signals->>'domain') as k from leads where lower(signals->>'domain') = any($1::text[])",
        [d],
      );
      for (const row of r.rows) out.domains.add(String(row.k));
    }
    if (e.length) {
      const r = await this.db.query(
        "select distinct lower(email) as k from leads where lower(email) = any($1::text[])",
        [e],
      );
      for (const row of r.rows) out.emails.add(String(row.k));
    }
    return out;
  }

  async suppressed(emails: string[]) {
    const e = lower(emails);
    if (!e.length) return new Set<string>();
    const r = await this.db.query(
      "select lower(email) as k from suppressions where lower(email) = any($1::text[])",
      [e],
    );
    return new Set(r.rows.map((row) => String(row.k)));
  }

  async insert(raw: NewLead) {
    const lead = NewLeadSchema.parse(raw);
    const id = newId(LeadIdSchema);
    await this.db.query(
      `insert into leads (id, source, query, company, contact, email, github_url, signals, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [
        id,
        lead.source,
        lead.query,
        lead.company,
        lead.contact,
        lead.email?.toLowerCase() ?? null,
        lead.githubUrl,
        JSON.stringify(lead.signals),
        lead.status,
      ],
    );
    return { id };
  }
}

export interface StoredLead extends NewLead {
  id: string;
}

/** In-memory store with the same semantics (tests, dry runs). */
export class MemoryLeadStore implements LeadStore {
  readonly leads: StoredLead[] = [];
  readonly suppressions = new Set<string>();

  constructor(init: { leads?: NewLead[]; suppressions?: string[] } = {}) {
    for (const l of init.leads ?? []) this.leads.push({ ...l, id: newId(LeadIdSchema) });
    for (const s of init.suppressions ?? []) this.suppressions.add(s.toLowerCase());
  }

  async existing(keys: { githubUrls: string[]; domains: string[]; emails: string[] }) {
    const has = (pick: (l: StoredLead) => string | null | undefined, xs: string[]) => {
      const present = new Set(
        this.leads.map((l) => pick(l)?.toLowerCase()).filter((x): x is string => !!x),
      );
      return new Set(lower(xs).filter((x) => present.has(x)));
    };
    return {
      githubUrls: has((l) => l.githubUrl, keys.githubUrls),
      domains: has((l) => {
        const d = l.signals.domain;
        return typeof d === "string" ? d : null;
      }, keys.domains),
      emails: has((l) => l.email, keys.emails),
    };
  }

  async suppressed(emails: string[]) {
    return new Set(lower(emails).filter((e) => this.suppressions.has(e)));
  }

  async insert(raw: NewLead) {
    const lead = NewLeadSchema.parse(raw);
    const id = newId(LeadIdSchema);
    this.leads.push({ ...lead, email: lead.email?.toLowerCase() ?? null, id });
    return { id };
  }
}
