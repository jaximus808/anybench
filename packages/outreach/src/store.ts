// Where sourcing and import write leads: the `leads` and `suppressions` tables (apps/server
// schema, migration 0000). `PgLeadStore` takes any `pg`-style client (`query(text, values)`), so
// this package doesn't depend on a driver; `MemoryLeadStore` backs the tests.

import { LeadIdSchema, newId } from "@anybench/core";
import { z } from "zod";

export const LEAD_SOURCES = ["context_dev", "hackathon_optin", "public_contact"] as const;
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
  /**
   * Which of these (lowercased) repo URLs, domains and emails already have a lead. A domain is
   * taken by a lead's company domain (`signals.domain`), contact domain (`signals.contactDomain`)
   * or the domain of its email.
   */
  existing(keys: {
    githubUrls: string[];
    domains: string[];
    emails: string[];
  }): Promise<ExistingKeys>;
  /** Which of these (lowercased) emails are on the suppression list. */
  suppressed(emails: string[]): Promise<Set<string>>;
  /** Which of these domains have any suppressed address (checked before paying for a lookup). */
  suppressedDomains(domains: string[]): Promise<Set<string>>;
  /**
   * Insert unless a lead with the same email or repo URL (case-insensitive) exists. The check is
   * the DB's partial unique indexes (migration 0006), so two concurrent runs can't both insert
   * the same person or repo; the loser gets `{ duplicate }` instead of an id.
   */
  insert(lead: NewLead): Promise<InsertResult>;
}

export type InsertResult =
  { id: string; duplicate?: undefined } | { id?: undefined; duplicate: "email" | "repo" };

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
        `select distinct k from (
           select lower(signals->>'domain') as k from leads
           union all select lower(signals->>'contactDomain') from leads
           union all select split_part(lower(email), '@', 2) from leads where email is not null
         ) d where k = any($1::text[])`,
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

  async suppressedDomains(domains: string[]) {
    const d = lower(domains);
    if (!d.length) return new Set<string>();
    const r = await this.db.query(
      "select distinct split_part(lower(email), '@', 2) as k from suppressions where split_part(lower(email), '@', 2) = any($1::text[])",
      [d],
    );
    return new Set(r.rows.map((row) => String(row.k)));
  }

  async insert(raw: NewLead): Promise<InsertResult> {
    const lead = NewLeadSchema.parse(raw);
    const email = lead.email?.toLowerCase() ?? null;
    // No conflict target: DO NOTHING covers both partial unique indexes
    // (leads_email_lower_uniq, leads_github_url_lower_uniq).
    const r = await this.db.query(
      `insert into leads (id, source, query, company, contact, email, github_url, signals, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
       on conflict do nothing
       returning id`,
      [
        newId(LeadIdSchema),
        lead.source,
        lead.query,
        lead.company,
        lead.contact,
        email,
        lead.githubUrl,
        JSON.stringify(lead.signals),
        lead.status,
      ],
    );
    const row = r.rows[0];
    if (row) return { id: String(row.id) };
    // Which index fired: the email one wins when both match.
    if (email) {
      const e = await this.db.query("select 1 from leads where lower(email) = $1 limit 1", [email]);
      if (e.rows.length) return { duplicate: "email" };
    }
    return { duplicate: "repo" };
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
      domains: new Set(
        [
          has(
            (l) => (typeof l.signals.domain === "string" ? l.signals.domain : null),
            keys.domains,
          ),
          has(
            (l) => (typeof l.signals.contactDomain === "string" ? l.signals.contactDomain : null),
            keys.domains,
          ),
          has((l) => l.email?.split("@")[1] ?? null, keys.domains),
        ].flatMap((x) => [...x]),
      ),
      emails: has((l) => l.email, keys.emails),
    };
  }

  async suppressed(emails: string[]) {
    return new Set(lower(emails).filter((e) => this.suppressions.has(e)));
  }

  async suppressedDomains(domains: string[]) {
    const sd = new Set([...this.suppressions].map((e) => e.split("@")[1] ?? ""));
    return new Set(lower(domains).filter((d) => sd.has(d)));
  }

  async insert(raw: NewLead): Promise<InsertResult> {
    const lead = NewLeadSchema.parse(raw);
    const email = lead.email?.toLowerCase() ?? null;
    const repo = lead.githubUrl?.toLowerCase() ?? null;
    // Same rule as the DB's unique indexes.
    if (email && this.leads.some((l) => l.email?.toLowerCase() === email))
      return { duplicate: "email" };
    if (repo && this.leads.some((l) => l.githubUrl?.toLowerCase() === repo))
      return { duplicate: "repo" };
    const id = newId(LeadIdSchema);
    this.leads.push({ ...lead, email, id });
    return { id };
  }
}
