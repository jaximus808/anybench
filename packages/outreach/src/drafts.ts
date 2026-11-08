// TDM-165 [15.5a]: the founder review queue over `outreach_messages` (kind initial).
//
//   draftable()   leads with a brief, an address, no initial message yet, not suppressed
//   insertDraft() one draft row (status draft) + the lead's status → drafted, in one statement
//   queue()       drafts and approved-but-unsent messages, with the lead they go to
//   approve()     draft → approved, approved_by, and an `interventions` row, in one statement
//   reject()      deletes the draft, lead → rejected, and an `interventions` row
//   edit()        new subject/text/html; an approved message goes back to draft
//
// Every write is a single SQL statement (data-modifying CTEs), so the founder's action and its
// audit row commit together or not at all. Ids may be given as an unambiguous prefix.

import { z } from "zod";
import { ScoutBriefSchema } from "./scout-brief.js";
import type { DraftEmail, DraftLeadInput } from "./writer.js";

export interface DraftQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export const QUEUE_STATUSES = ["draft", "approved"] as const;
export type QueueStatus = (typeof QUEUE_STATUSES)[number];

export interface QueueItem {
  id: string;
  leadId: string;
  status: string;
  subject: string;
  text: string;
  html: string;
  approvedBy: string | null;
  sentAt: string | null;
  agentmailMessageId: string | null;
  createdAt: string;
  email: string | null;
  company: string | null;
  githubUrl: string | null;
  source: string | null;
  signals: Record<string, unknown>;
  brief: unknown;
}

export interface DraftableOptions {
  limit: number;
  ids?: string[];
  /** Also draft briefs the scout skipped as below_threshold / no_verified_claims (never contact_not_ok). */
  allowSkipped?: boolean;
}

export interface DraftStore {
  draftable(o: DraftableOptions): Promise<DraftLeadInput[]>;
  insertDraft(leadId: string, d: DraftEmail): Promise<string | null>;
  queue(statuses?: readonly string[]): Promise<QueueItem[]>;
  get(idOrPrefix: string): Promise<QueueItem>;
  approve(id: string, by: string, why: string): Promise<boolean>;
  reject(id: string, by: string, why: string): Promise<boolean>;
  edit(id: string, d: DraftEmail): Promise<boolean>;
}

export class DraftNotFoundError extends Error {
  constructor(
    readonly idOrPrefix: string,
    readonly matches: number,
  ) {
    super(
      matches === 0
        ? `no outreach message matches "${idOrPrefix}"`
        : `"${idOrPrefix}" matches ${matches} messages; give more of the id`,
    );
    this.name = "DraftNotFoundError";
  }
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const iso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : typeof v === "string" ? v : null;
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const ID_PREFIX_RE = /^[0-9a-f-]{4,36}$/i;

/** Which scout skip reasons `allowSkipped` may still draft. */
const SKIPPABLE = ["below_threshold", "no_verified_claims"];

function toItem(r: Record<string, unknown>): QueueItem {
  return {
    id: String(r.id),
    leadId: String(r.lead_id),
    status: String(r.status),
    subject: str(r.subject) ?? "",
    text: str(r.text) ?? "",
    html: str(r.html) ?? "",
    approvedBy: str(r.approved_by),
    sentAt: iso(r.sent_at),
    agentmailMessageId: str(r.agentmail_message_id),
    createdAt: iso(r.created_at) ?? "",
    email: str(r.email),
    company: str(r.company),
    githubUrl: str(r.github_url),
    source: str(r.source),
    signals: rec(r.signals),
    brief: r.brief ?? null,
  };
}

const ITEM_COLS = `m.id, m.lead_id, m.status, m.subject, m.text, m.html, m.approved_by, m.sent_at,
  m.agentmail_message_id, m.created_at, l.email, l.company, l.github_url, l.source, l.signals, l.brief`;

export class PgDraftStore implements DraftStore {
  constructor(private readonly db: DraftQueryable) {}

  async draftable(o: DraftableOptions): Promise<DraftLeadInput[]> {
    const ids = o.ids?.length ? o.ids : null;
    const r = await this.db.query(
      `select l.id, l.source, l.company, l.contact, l.email, l.github_url, l.signals, l.brief
         from leads l
        where l.email is not null and l.github_url is not null and l.brief is not null
          and (l.status = 'scored'
               or ($3::boolean and l.status = 'skipped' and l.brief->>'skip_reason' = any($4::text[])))
          and ($2::uuid[] is null or l.id = any($2::uuid[]))
          and not exists (select 1 from outreach_messages m where m.lead_id = l.id and m.kind = 'initial')
          and not exists (select 1 from suppressions s where s.email = lower(l.email))
        order by l.fit desc nulls last, l.created_at asc
        limit $1`,
      [o.limit, ids, o.allowSkipped ?? false, SKIPPABLE],
    );
    return r.rows.flatMap((row) => {
      const brief = ScoutBriefSchema.safeParse(row.brief);
      if (!brief.success) return [];
      return [
        {
          id: String(row.id),
          source: str(row.source),
          company: str(row.company),
          contact: str(row.contact),
          email: String(row.email),
          githubUrl: String(row.github_url),
          signals: rec(row.signals),
          brief: brief.data,
        },
      ];
    });
  }

  async insertDraft(leadId: string, d: DraftEmail): Promise<string | null> {
    // The not-exists guard keeps one initial message per lead even if two runs race.
    const r = await this.db.query(
      `with ins as (
         insert into outreach_messages (lead_id, kind, subject, text, html, status)
         select $1::uuid, 'initial', $2, $3, $4, 'draft'
          where not exists (select 1 from outreach_messages where lead_id = $1::uuid and kind = 'initial')
         returning id, lead_id),
       up as (update leads set status = 'drafted', updated_at = now()
               where id in (select lead_id from ins))
       select id from ins`,
      [leadId, d.subject, d.text, d.html],
    );
    return r.rows[0] ? String(r.rows[0].id) : null;
  }

  async queue(statuses: readonly string[] = QUEUE_STATUSES): Promise<QueueItem[]> {
    const r = await this.db.query(
      `select ${ITEM_COLS} from outreach_messages m join leads l on l.id = m.lead_id
        where m.kind = 'initial' and m.status = any($1::text[])
        order by m.created_at asc`,
      [[...statuses]],
    );
    return r.rows.map(toItem);
  }

  async get(idOrPrefix: string): Promise<QueueItem> {
    if (!ID_PREFIX_RE.test(idOrPrefix)) throw new DraftNotFoundError(idOrPrefix, 0);
    const r = await this.db.query(
      `select ${ITEM_COLS} from outreach_messages m join leads l on l.id = m.lead_id
        where m.id::text like $1 || '%' limit 2`,
      [idOrPrefix.toLowerCase()],
    );
    if (r.rows.length !== 1) throw new DraftNotFoundError(idOrPrefix, r.rows.length);
    return toItem(r.rows[0]!);
  }

  async approve(id: string, by: string, why: string): Promise<boolean> {
    const r = await this.db.query(
      `with m as (
         update outreach_messages set status = 'approved', approved_by = $2
          where id = $1::uuid and status = 'draft' and kind = 'initial'
         returning id, lead_id),
       i as (
         insert into interventions (who, what, why)
         select $2, 'approved outreach draft ' || m.id || ' to ' || coalesce(l.email, '?'), $3
           from m join leads l on l.id = m.lead_id
         returning id)
       select m.id, (select count(*) from i)::int as audited from m`,
      [id, by, why],
    );
    return r.rows.length === 1;
  }

  async reject(id: string, by: string, why: string): Promise<boolean> {
    const r = await this.db.query(
      `with d as (
         delete from outreach_messages
          where id = $1::uuid and status in ('draft', 'approved') and kind = 'initial'
         returning id, lead_id),
       up as (update leads set status = 'rejected', updated_at = now()
               where id in (select lead_id from d)),
       i as (
         insert into interventions (who, what, why)
         select $2, 'rejected outreach draft ' || d.id || ' for lead ' || d.lead_id, $3 from d
         returning id)
       select d.id from d`,
      [id, by, why],
    );
    return r.rows.length === 1;
  }

  async edit(id: string, d: DraftEmail): Promise<boolean> {
    const r = await this.db.query(
      `update outreach_messages set subject = $2, text = $3, html = $4, status = 'draft', approved_by = null
        where id = $1::uuid and status in ('draft', 'approved') and kind = 'initial'
       returning id`,
      [id, d.subject, d.text, d.html],
    );
    return r.rows.length === 1;
  }
}

// ---- in memory (tests) ----------------------------------------------------------------------------

export const MemoryLeadRowSchema = z.object({
  id: z.string(),
  source: z.string().nullable().default(null),
  company: z.string().nullable().default(null),
  contact: z.string().nullable().default(null),
  email: z.string().nullable(),
  githubUrl: z.string().nullable(),
  signals: z.record(z.string(), z.unknown()).default({}),
  brief: z.unknown(),
  status: z.string().default("scored"),
  fit: z.number().nullable().default(null),
});
export type MemoryLeadRow = z.infer<typeof MemoryLeadRowSchema>;

export interface MemoryMessage {
  id: string;
  leadId: string;
  kind: "initial";
  status: string;
  subject: string;
  text: string;
  html: string;
  approvedBy: string | null;
  sentAt: string | null;
  agentmailMessageId: string | null;
  createdAt: string;
}

export class MemoryDraftStore implements DraftStore {
  readonly leads: MemoryLeadRow[];
  readonly messages: MemoryMessage[] = [];
  readonly interventions: { who: string; what: string; why: string }[] = [];
  readonly suppressed = new Set<string>();
  private seq = 0;

  constructor(leads: z.input<typeof MemoryLeadRowSchema>[] = []) {
    this.leads = leads.map((l) => MemoryLeadRowSchema.parse(l));
  }

  async draftable(o: DraftableOptions): Promise<DraftLeadInput[]> {
    return this.leads
      .filter((l) => l.email && l.githubUrl && l.brief)
      .filter((l) => {
        if (l.status === "scored") return true;
        const b = ScoutBriefSchema.safeParse(l.brief);
        return (
          !!o.allowSkipped &&
          l.status === "skipped" &&
          b.success &&
          SKIPPABLE.includes(b.data.skip_reason ?? "")
        );
      })
      .filter((l) => !o.ids?.length || o.ids.includes(l.id))
      .filter((l) => !this.messages.some((m) => m.leadId === l.id))
      .filter((l) => !this.suppressed.has(l.email!.toLowerCase()))
      .sort((a, b) => (b.fit ?? -1) - (a.fit ?? -1))
      .slice(0, o.limit)
      .flatMap((l) => {
        const brief = ScoutBriefSchema.safeParse(l.brief);
        return brief.success
          ? [
              {
                id: l.id,
                source: l.source,
                company: l.company,
                contact: l.contact,
                email: l.email!,
                githubUrl: l.githubUrl!,
                signals: l.signals,
                brief: brief.data,
              },
            ]
          : [];
      });
  }

  async insertDraft(leadId: string, d: DraftEmail): Promise<string | null> {
    if (this.messages.some((m) => m.leadId === leadId)) return null;
    const id = `00000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`;
    this.messages.push({
      id,
      leadId,
      kind: "initial",
      status: "draft",
      ...d,
      approvedBy: null,
      sentAt: null,
      agentmailMessageId: null,
      createdAt: new Date(Date.UTC(2026, 10, 8, 0, 0, this.seq)).toISOString(),
    });
    const lead = this.leads.find((l) => l.id === leadId);
    if (lead) lead.status = "drafted";
    return id;
  }

  private item(m: MemoryMessage): QueueItem {
    const l = this.leads.find((x) => x.id === m.leadId);
    return {
      ...m,
      email: l?.email ?? null,
      company: l?.company ?? null,
      githubUrl: l?.githubUrl ?? null,
      source: l?.source ?? null,
      signals: l?.signals ?? {},
      brief: l?.brief ?? null,
    };
  }

  async queue(statuses: readonly string[] = QUEUE_STATUSES): Promise<QueueItem[]> {
    return this.messages.filter((m) => statuses.includes(m.status)).map((m) => this.item(m));
  }

  async get(idOrPrefix: string): Promise<QueueItem> {
    const hits = ID_PREFIX_RE.test(idOrPrefix)
      ? this.messages.filter((m) => m.id.startsWith(idOrPrefix.toLowerCase()))
      : [];
    if (hits.length !== 1) throw new DraftNotFoundError(idOrPrefix, hits.length);
    return this.item(hits[0]!);
  }

  async approve(id: string, by: string, why: string): Promise<boolean> {
    const m = this.messages.find((x) => x.id === id && x.status === "draft");
    if (!m) return false;
    m.status = "approved";
    m.approvedBy = by;
    const email = this.leads.find((l) => l.id === m.leadId)?.email ?? "?";
    this.interventions.push({ who: by, what: `approved outreach draft ${id} to ${email}`, why });
    return true;
  }

  async reject(id: string, by: string, why: string): Promise<boolean> {
    const i = this.messages.findIndex(
      (x) => x.id === id && (x.status === "draft" || x.status === "approved"),
    );
    if (i < 0) return false;
    const [m] = this.messages.splice(i, 1);
    const lead = this.leads.find((l) => l.id === m!.leadId);
    if (lead) lead.status = "rejected";
    this.interventions.push({
      who: by,
      what: `rejected outreach draft ${id} for lead ${m!.leadId}`,
      why,
    });
    return true;
  }

  async edit(id: string, d: DraftEmail): Promise<boolean> {
    const m = this.messages.find(
      (x) => x.id === id && (x.status === "draft" || x.status === "approved"),
    );
    if (!m) return false;
    Object.assign(m, d, { status: "draft", approvedBy: null });
    return true;
  }
}
