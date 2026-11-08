// TDM-167 [15.8a]: the outreach funnel, counted from the DB. Every number is a COUNT of rows (or
// a sum of recorded micro-USD); nothing is estimated, and a figure the DB doesn't hold is reported
// as `null` ("not recorded"), never as 0.
//
// Stages (distinct leads):
//   sourced      leads
//   scouted      leads with a scout brief (TDM-164 writes `brief` + `fit`)
//   fit          briefs with status "scored" (fit >= threshold, verified claims, contact ok)
//   drafted      leads with an initial outreach_messages row
//   approved     ... whose initial message has approved_by set (the founder approved it)
//   sent         leads with an initial/followup message that has sent_at
//   replied      leads with a reply from a person (any category but bounce_or_auto)
//   interested   leads with an "interested" reply
//   unsubscribed leads with an "unsubscribe" reply (suppressions are counted separately: they
//                include addresses that matched no lead)

import type { MicroUsd } from "./money.js";
import type { MemoryReplyStore } from "./replies.js";
import type { Queryable } from "./store.js";

export const FUNNEL_STAGES = [
  "sourced",
  "scouted",
  "fit",
  "drafted",
  "approved",
  "sent",
  "replied",
  "interested",
  "unsubscribed",
] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export interface Funnel {
  stages: Record<FunnelStage, number>;
  bounced: number;
  autoReplies: number;
  /** Replies waiting for the founder (needs_founder and not handled). */
  needsFounder: number;
  repliesTotal: number;
  suppressions: { total: number; byReason: Record<string, number> };
  spend: {
    /** Scout briefs (`leads.brief.naive.cost_micro_usd`). */
    naiveScoutMicroUsd: MicroUsd;
    /** Reply classification (`outreach_replies.cost_micro_usd`). */
    naiveRepliesMicroUsd: MicroUsd;
    naiveTotalMicroUsd: MicroUsd;
    /** Email lookups recorded on briefs (`leads.brief.contact_lookup.cost_micro_usd`, Monid). */
    monidLookupsMicroUsd: MicroUsd;
    /** Context.dev credits are not stored per lead; `outreach source` prints them per run. */
    contextDevCredits: number | null;
  };
}

export interface FunnelReader {
  funnel(): Promise<Funnel>;
}

const DIGITS = "'^[0-9]+$'";

export class PgFunnel implements FunnelReader {
  constructor(private readonly db: Queryable) {}

  async funnel(): Promise<Funnel> {
    const r = await this.db.query(`
      select
        (select count(*) from leads)::int as sourced,
        (select count(*) from leads where brief is not null)::int as scouted,
        (select count(*) from leads where brief->>'status' = 'scored')::int as fit,
        (select count(distinct lead_id) from outreach_messages where kind = 'initial')::int as drafted,
        (select count(distinct lead_id) from outreach_messages
          where kind = 'initial' and approved_by is not null)::int as approved,
        (select count(distinct lead_id) from outreach_messages
          where kind in ('initial', 'followup') and sent_at is not null)::int as sent,
        (select count(distinct lead_id) from outreach_replies
          where lead_id is not null and category <> 'bounce_or_auto')::int as replied,
        (select count(distinct lead_id) from outreach_replies
          where lead_id is not null and category = 'interested')::int as interested,
        (select count(distinct lead_id) from outreach_replies
          where lead_id is not null and category = 'unsubscribe')::int as unsubscribed,
        (select count(*) from outreach_replies
          where category = 'bounce_or_auto' and suppressed_email is not null)::int as bounced,
        (select count(*) from outreach_replies
          where category = 'bounce_or_auto' and suppressed_email is null)::int as auto_replies,
        (select count(*) from outreach_replies where needs_founder and handled_at is null)::int
          as needs_founder,
        (select count(*) from outreach_replies)::int as replies_total,
        (select coalesce(json_object_agg(reason, n), '{}'::json)
           from (select reason, count(*)::int as n from suppressions group by reason) s) as sup,
        (select coalesce(sum((brief->'naive'->>'cost_micro_usd')::numeric), 0)::text from leads
          where brief->'naive'->>'cost_micro_usd' ~ ${DIGITS}) as naive_scout,
        (select coalesce(sum(cost_micro_usd), 0)::text from outreach_replies) as naive_replies,
        (select coalesce(sum((brief->'contact_lookup'->>'cost_micro_usd')::numeric), 0)::text
           from leads where brief->'contact_lookup'->>'cost_micro_usd' ~ ${DIGITS}) as monid_lookups
    `);
    const row = r.rows[0] ?? {};
    const n = (k: string) => Number(row[k] ?? 0);
    const byReason = Object.fromEntries(
      Object.entries((row.sup ?? {}) as Record<string, unknown>).map(([k, v]) => [k, Number(v)]),
    );
    const scout = BigInt(String(row.naive_scout ?? "0"));
    const replies = BigInt(String(row.naive_replies ?? "0"));
    return {
      stages: {
        sourced: n("sourced"),
        scouted: n("scouted"),
        fit: n("fit"),
        drafted: n("drafted"),
        approved: n("approved"),
        sent: n("sent"),
        replied: n("replied"),
        interested: n("interested"),
        unsubscribed: n("unsubscribed"),
      },
      bounced: n("bounced"),
      autoReplies: n("auto_replies"),
      needsFounder: n("needs_founder"),
      repliesTotal: n("replies_total"),
      suppressions: { total: Object.values(byReason).reduce((a, b) => a + b, 0), byReason },
      spend: {
        naiveScoutMicroUsd: scout,
        naiveRepliesMicroUsd: replies,
        naiveTotalMicroUsd: scout + replies,
        monidLookupsMicroUsd: BigInt(String(row.monid_lookups ?? "0")),
        contextDevCredits: null,
      },
    };
  }
}

const microFrom = (v: unknown): MicroUsd =>
  typeof v === "string" && /^\d+$/.test(v)
    ? BigInt(v)
    : typeof v === "bigint"
      ? v
      : typeof v === "number" && Number.isInteger(v)
        ? BigInt(v)
        : 0n;

/** The same counts over a `MemoryReplyStore` (tests, dry runs). */
export class MemoryFunnel implements FunnelReader {
  constructor(private readonly s: MemoryReplyStore) {}

  async funnel(): Promise<Funnel> {
    const s = this.s;
    const distinct = (xs: (string | null)[]) => new Set(xs.filter((x): x is string => !!x)).size;
    const brief = (b: unknown) =>
      b && typeof b === "object" ? (b as Record<string, unknown>) : null;
    const initial = s.messages.filter((m) => m.kind === "initial");
    const person = s.replies.filter((r) => r.category !== "bounce_or_auto");
    const byReason: Record<string, number> = {};
    for (const reason of s.suppressions.values()) byReason[reason] = (byReason[reason] ?? 0) + 1;
    const scout = s.leads.reduce(
      (a, l) => a + microFrom((brief(brief(l.brief)?.naive) ?? {}).cost_micro_usd),
      0n,
    );
    const lookups = s.leads.reduce(
      (a, l) => a + microFrom((brief(brief(l.brief)?.contact_lookup) ?? {}).cost_micro_usd),
      0n,
    );
    const replies = s.replies.reduce((a, r) => a + r.costMicroUsd, 0n);
    return {
      stages: {
        sourced: s.leads.length,
        scouted: s.leads.filter((l) => brief(l.brief)).length,
        fit: s.leads.filter((l) => brief(l.brief)?.status === "scored").length,
        drafted: distinct(initial.map((m) => m.leadId)),
        approved: distinct(initial.filter((m) => m.approvedBy).map((m) => m.leadId)),
        sent: distinct(
          s.messages.filter((m) => m.kind !== "reply" && m.sentAt).map((m) => m.leadId),
        ),
        replied: distinct(person.map((r) => r.leadId)),
        interested: distinct(
          s.replies.filter((r) => r.category === "interested").map((r) => r.leadId),
        ),
        unsubscribed: distinct(
          s.replies.filter((r) => r.category === "unsubscribe").map((r) => r.leadId),
        ),
      },
      bounced: s.replies.filter((r) => r.category === "bounce_or_auto" && r.suppress).length,
      autoReplies: s.replies.filter((r) => r.category === "bounce_or_auto" && !r.suppress).length,
      needsFounder: s.replies.filter((r) => r.needsFounder).length,
      repliesTotal: s.replies.length,
      suppressions: { total: s.suppressions.size, byReason },
      spend: {
        naiveScoutMicroUsd: scout,
        naiveRepliesMicroUsd: replies,
        naiveTotalMicroUsd: scout + replies,
        monidLookupsMicroUsd: lookups,
        contextDevCredits: null,
      },
    };
  }
}

/** Plain-text funnel, one stage per line; money as micro-USD and dollars. */
export function formatFunnel(f: Funnel, formatMicroUsd: (m: MicroUsd) => string): string[] {
  const w = Math.max(...FUNNEL_STAGES.map((s) => s.length));
  const lines = ["outreach funnel (distinct leads, counted from the DB)"];
  for (const s of FUNNEL_STAGES) lines.push(`  ${s.padEnd(w)}  ${f.stages[s]}`);
  lines.push(
    `replies: ${f.repliesTotal} stored, ${f.needsFounder} waiting for the founder, ` +
      `${f.bounced} bounces, ${f.autoReplies} auto-replies`,
  );
  const reasons = Object.entries(f.suppressions.byReason)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  lines.push(`suppressions: ${f.suppressions.total}${reasons ? ` (${reasons})` : ""}`);
  lines.push(
    `spend: Naïve ${f.spend.naiveTotalMicroUsd} micro-USD (${formatMicroUsd(f.spend.naiveTotalMicroUsd)}; ` +
      `scout ${f.spend.naiveScoutMicroUsd}, replies ${f.spend.naiveRepliesMicroUsd}), ` +
      `Monid email lookups ${f.spend.monidLookupsMicroUsd} micro-USD, ` +
      `Context.dev credits ${f.spend.contextDevCredits ?? "not recorded in the DB (see `outreach source` output)"}`,
  );
  return lines;
}
