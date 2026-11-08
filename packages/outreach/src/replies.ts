// TDM-167 [15.8a]: poll our AgentMail inbox for replies, classify each new one, suppress opt-outs.
//
//   list-messages (label "received", free) → isInboundReply (drops our own outbound copies)
//   → skip ids already in outreach_replies → get-message (free; full body + headers)
//   → classifyReplyByRules → (unsure and a model is wired) the Naïve account manager
//   → ONE statement per reply: insert outreach_replies + suppress + lead status + message status
//
// This module NEVER sends or replies to anyone. A reply that needs an answer (interested, question,
// unclear) is stored with `needs_founder = true`; the founder answers it by hand. The only outbound
// call is the optional Slack webhook for interested leads (our own channel, SLACK_WEBHOOK_URL).
//
// Opt-outs are honoured before anything else: an unsubscribe-looking reply is suppressed by the
// rules alone (no model call), and when rules and model disagree, any "unsubscribe" wins.

import { z } from "zod";
import { bareAddress, isInboundReply, type AgentMail, type Message } from "./agentmail.js";
import type { MicroUsd } from "./money.js";
import type { Queryable } from "./store.js";

// ---- categories ---------------------------------------------------------------------------------

export const REPLY_CATEGORIES = [
  "interested",
  "question",
  "not_now",
  "unsubscribe",
  "bounce_or_auto",
  "unclear",
] as const;
export type ReplyCategory = (typeof REPLY_CATEGORIES)[number];
export const ReplyCategorySchema = z.enum(REPLY_CATEGORIES);

/** Categories a human has to read (and maybe answer). Nothing answers them automatically. */
export const NEEDS_FOUNDER: ReadonlySet<ReplyCategory> = new Set([
  "interested",
  "question",
  "unclear",
]);

/** `leads.status` a reply moves the lead to (`undefined`: leave it). */
export const LEAD_STATUS_FOR: Readonly<Record<ReplyCategory, string | undefined>> = {
  interested: "interested",
  question: "replied",
  not_now: "not_now",
  unsubscribe: "unsubscribed",
  bounce_or_auto: undefined, // a bounce sets "bounced" below; an auto-reply changes nothing
  unclear: "replied",
};

// ---- text helpers -------------------------------------------------------------------------------

/**
 * The new text of a reply: AgentMail's `extracted_text` when present, else the body with the
 * quoted history cut off. The quote matters: our own email's footer says "unsubscribe", so a
 * classifier reading the quote would suppress everyone who replied.
 */
export function newReplyText(m: Pick<Message, "extractedText" | "text" | "preview">): string {
  const raw = m.extractedText?.trim() ? m.extractedText : (m.text ?? m.preview ?? "");
  return stripQuoted(raw);
}

const QUOTE_START = [
  /^On .{3,300}wrote:\s*$/, // Gmail / Apple Mail
  /^Le .{3,300}a écrit\s*:\s*$/,
  /^Am .{3,300}schrieb .{0,200}:\s*$/,
  /^-{2,}\s*Original Message\s*-{2,}/i,
  /^-{2,}\s*Forwarded message\s*-{2,}/i,
  /^From:\s.+/, // Outlook header block
  /^_{5,}\s*$/,
];

export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const t = line.trim();
    // "On Sun, Nov 8, 2026 at 9:00 AM Anybench <x@y>\nwrote:" wraps across two lines too.
    const joined = i + 1 < lines.length ? `${t} ${lines[i + 1]!.trim()}` : t;
    if (QUOTE_START.some((re) => re.test(t)) || /^On .{3,300}wrote:\s*$/.test(joined)) break;
    if (t.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

// ---- rules --------------------------------------------------------------------------------------

export interface RuleClassification {
  category: ReplyCategory;
  /** False when rules found nothing, or more than one human category: ask the model if there is one. */
  confident: boolean;
  /** For bounce_or_auto: a delivery failure (suppress the recipient) vs an auto-reply (don't). */
  bounce: boolean;
  reason: string;
}

const UNSUBSCRIBE_ANYWHERE = [
  /\bunsubscribe\b/i,
  /\bun-subscribe\b/i,
  /\bremove me\b/i,
  /\bremove (?:my (?:email|address)|us)\b/i,
  /\btake me off\b/i,
  /\bopt(?:-| )?(?:me |us )?out\b/i,
  /\b(?:unsub|remove|delete) (?:me|us|this (?:email|address))\b/i,
  /\b(?:stop|quit|cease) (?:emailing|e-mailing|mailing|contacting|messaging|sending|spamming)\b/i,
  /\b(?:do not|don'?t|dont|never) (?:email|e-mail|contact|message|write to|spam) (?:me|us)\b/i,
  /\b(?:do not|don'?t|dont) (?:email|e-mail|contact) (?:me|us)? ?(?:again|anymore|any more)\b/i,
  /\bno (?:more|further) (?:emails?|e-mails?|messages|contact)\b/i,
  /\bleave me alone\b/i,
  /\bthis is spam\b/i,
  /\breport(?:ed|ing)? (?:this |you )?(?:as|for) spam\b/i,
];
/** "stop" alone (or nearly alone) is an opt-out; inside a sentence it usually isn't. */
const UNSUBSCRIBE_SHORT =
  /^\W*(?:stop|unsubscribe|remove|end|cancel|quit)\W*(?:please|pls|thanks?)?\W*$/i;

const BOUNCE_FROM = /^(?:mailer-daemon|postmaster|mail-daemon|bounces?)(?:[+@]|$)/i;
const BOUNCE_SUBJECT = [
  /undeliver(?:able|ed)/i,
  /delivery (?:status notification|has failed|failure|incomplete)/i,
  /mail delivery (?:failed|failure|subsystem)/i,
  /returned mail/i,
  /failure notice/i,
  /could not be delivered/i,
  /address not found/i,
];
const AUTO_SUBJECT = [
  /\bout of (?:the )?office\b/i,
  /\bautomatic reply\b/i,
  /\bauto(?:matic)?[- ]?(?:reply|response|responder)\b/i,
  /\bvacation\b/i,
  /\babwesenheit/i,
  /\bon leave\b/i,
];
const AUTO_BODY = [
  /\bI(?:'m| am) (?:currently )?(?:out of (?:the )?office|on (?:vacation|holiday|leave|parental leave)|away)\b/i,
  /\bthis (?:mailbox|inbox|address) is (?:not|no longer) (?:monitored|in use|active)\b/i,
  /\bthis is an automated (?:reply|response|message)\b/i,
  /\bwe(?:'ve| have) received your (?:email|message|request)\b.*\b(?:ticket|case)\b/i,
];

const NOT_NOW = [
  /\bnot (?:right )?now\b/i,
  /\bnot at (?:the|this) (?:moment|time)\b/i,
  /\bmaybe (?:later|next|in a few)\b/i,
  /\b(?:circle|check|reach) back\b/i,
  /\bnext (?:month|quarter|year)\b/i,
  /\bno,? thanks?\b/i,
  /\bno thank you\b/i,
  /\bnot interested\b/i,
  /\bnot (?:a )?(?:priority|good fit|fit)\b/i,
  /\bpass(?:ing)? (?:for now|on this)\b/i,
  /\btoo busy\b/i,
  /\bwe(?:'re| are) good(?:,|\s+for now\b|\s+thanks?\b)/i,
];
const INTERESTED = [
  /\b(?:i'?m|i am|we'?re|we are|very|definitely|sounds|would be|be) interested\b/i,
  /^\W*interested\b/i,
  /\byes,? (?:please|let'?s|go|sure|run|do it|interested|that would)\b/i,
  /^\W*(?:yes|yep|yeah|sure|absolutely|definitely)\b/i,
  /\b(?:sounds|looks) (?:good|great|interesting|cool|awesome)\b/i,
  /\blet'?s do (?:it|this)\b/i,
  /\bgo (?:ahead|for it)\b/i,
  /^\W*(?:do it|run it|try it|ship it)\b/i,
  /\b(?:please )?(?:run|try) it\b/i,
  /\bhappy to (?:try|chat|talk|see|hop|jump|take a look)\b/i,
  /\bwould love (?:to|that|a|the)\b/i,
  /\b(?:send|share) (?:me |us )?(?:the )?(?:results|report|link|details|more)\b/i,
  /\b(?:let'?s|can we|could we) (?:chat|talk|set up|schedule|hop on|meet)\b/i,
  /\bbook a (?:call|time|meeting)\b/i,
];
const QUESTION = [/\?/, /^\s*(?:how|what|why|who|when|where|which)\b/im];

const firstMatch = (res: RegExp[], s: string) => res.find((re) => re.test(s));

export function classifyReplyByRules(input: {
  from: string;
  subject: string | undefined;
  text: string;
  headers?: Record<string, string>;
}): RuleClassification {
  const from = bareAddress(input.from);
  const subject = (input.subject ?? "").trim();
  const subjectNoRe = subject.replace(/^(?:\s*(?:re|aw|sv|fwd?|wg)\s*:\s*)+/i, "").trim();
  const text = input.text.trim();
  const headers = Object.fromEntries(
    Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
  );

  // 1. Delivery failures: the mail system, not a person.
  if (BOUNCE_FROM.test(from.split("@")[0] ?? "") || firstMatch(BOUNCE_SUBJECT, subject)) {
    return {
      category: "bounce_or_auto",
      confident: true,
      bounce: true,
      reason: "delivery failure notice",
    };
  }

  // 2. Opt-outs, from the subject (our List-Unsubscribe mailto sets subject=unsubscribe) or the
  //    new text. Checked before auto-replies: an opt-out must never be missed.
  const unsubSubject =
    firstMatch(UNSUBSCRIBE_ANYWHERE, subjectNoRe) ??
    (UNSUBSCRIBE_SHORT.test(subjectNoRe) ? UNSUBSCRIBE_SHORT : undefined);
  const unsubText =
    firstMatch(UNSUBSCRIBE_ANYWHERE, text) ??
    (UNSUBSCRIBE_SHORT.test(text) ? UNSUBSCRIBE_SHORT : undefined);
  if (unsubSubject || unsubText) {
    return {
      category: "unsubscribe",
      confident: true,
      bounce: false,
      reason: unsubSubject ? "opt-out in the subject" : "opt-out in the reply text",
    };
  }

  // 3. Auto-replies (out of office, ticket bots).
  const autoHeader =
    (headers["auto-submitted"] && headers["auto-submitted"].toLowerCase() !== "no") ||
    headers["x-autoreply"] !== undefined ||
    headers["x-autorespond"] !== undefined ||
    /^(?:auto_reply|bulk|junk)$/i.test(headers["precedence"] ?? "");
  if (autoHeader || firstMatch(AUTO_SUBJECT, subject) || firstMatch(AUTO_BODY, text)) {
    return { category: "bounce_or_auto", confident: true, bounce: false, reason: "auto-reply" };
  }

  // 4. A person wrote something. Not-now is checked first ("not interested" contains "interested").
  if (!text) return { category: "unclear", confident: false, bounce: false, reason: "empty reply" };
  const notNow = firstMatch(NOT_NOW, text);
  const interested = notNow ? undefined : firstMatch(INTERESTED, text);
  const question = firstMatch(QUESTION, text);
  if (notNow) {
    return {
      category: "not_now",
      confident: !question,
      bounce: false,
      reason: "decline / later wording",
    };
  }
  if (interested) {
    // "Yes, but how much?" is still interested; the founder sees the question anyway.
    return { category: "interested", confident: true, bounce: false, reason: "positive wording" };
  }
  if (question)
    return { category: "question", confident: true, bounce: false, reason: "asks a question" };
  return { category: "unclear", confident: false, bounce: false, reason: "no rule matched" };
}

// ---- the model fallback (packages/agents account manager, wired by the CLI) ---------------------

export interface ReplyModelClassifier {
  /** The most one call can spend. */
  readonly maxCostMicroUsd: MicroUsd;
  /** Throws on failure; an error with a numeric-bigint `costMicroUsd` reports what was spent anyway. */
  classify(reply: {
    messageId: string;
    from: string;
    subject: string | undefined;
    text: string;
  }): Promise<{ category: ReplyCategory; reason: string; costMicroUsd: MicroUsd }>;
}

// ---- the store ----------------------------------------------------------------------------------

export interface SentMatch {
  leadId: string;
  /** outreach_messages.id of our outbound message, when the reply cites it. */
  messageId: string | null;
  leadEmail: string | null;
}

export interface NewReply {
  agentmailMessageId: string;
  threadId: string;
  fromEmail: string;
  subject: string | null;
  text: string | null;
  receivedAt: string;
  category: ReplyCategory;
  classifiedBy: "rules" | "model";
  reason: string | null;
  leadId: string | null;
  messageId: string | null;
  /** Put on the suppression list in the same statement as the insert. */
  suppress: { email: string; reason: "unsubscribe" | "bounce" } | null;
  needsFounder: boolean;
  costMicroUsd: MicroUsd;
}

export interface ReplyStore {
  /** Newest `received_at` already stored (ISO), or null. */
  lastReceivedAt(): Promise<string | null>;
  /** Which of these AgentMail message ids are already stored. */
  known(agentmailMessageIds: string[]): Promise<Set<string>>;
  /** The lead (and our outbound message) a reply belongs to: cited message ids first, then sender. */
  matchSent(q: { citedMessageIds: string[]; fromEmail: string }): Promise<SentMatch | null>;
  /** A lead whose email is one of these (for bounces that name the failed recipient). */
  leadByEmail(emails: string[]): Promise<{ leadId: string; email: string } | null>;
  /**
   * Insert the reply and apply its effects atomically: suppression row (always, even if the
   * reply was already stored), lead status, outbound message status. `inserted: false` means
   * another poll stored this message first.
   */
  record(r: NewReply): Promise<{ inserted: boolean; suppressed: boolean }>;
}

const lowerAll = (xs: string[]) => [
  ...new Set(xs.map((x) => x.trim().toLowerCase()).filter(Boolean)),
];

export class PgReplyStore implements ReplyStore {
  constructor(private readonly db: Queryable) {}

  async lastReceivedAt() {
    const r = await this.db.query("select max(received_at) as t from outreach_replies");
    const t = r.rows[0]?.t;
    return t ? new Date(t as string | Date).toISOString() : null;
  }

  async known(ids: string[]) {
    if (!ids.length) return new Set<string>();
    const r = await this.db.query(
      "select agentmail_message_id as id from outreach_replies where agentmail_message_id = any($1::text[])",
      [ids],
    );
    return new Set(r.rows.map((row) => String(row.id)));
  }

  async matchSent(q: { citedMessageIds: string[]; fromEmail: string }) {
    if (q.citedMessageIds.length) {
      const r = await this.db.query(
        `select m.id as message_id, m.lead_id, l.email
           from outreach_messages m join leads l on l.id = m.lead_id
          where m.agentmail_message_id = any($1::text[])
          order by m.sent_at desc nulls last limit 1`,
        [q.citedMessageIds],
      );
      const row = r.rows[0];
      if (row) {
        return {
          leadId: String(row.lead_id),
          messageId: String(row.message_id),
          leadEmail: row.email ? String(row.email) : null,
        };
      }
    }
    const r = await this.db.query(
      `select l.id as lead_id, l.email,
              (select m.id from outreach_messages m where m.lead_id = l.id and m.sent_at is not null
                order by m.sent_at desc limit 1) as message_id
         from leads l where lower(l.email) = lower($1) limit 1`,
      [q.fromEmail],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      leadId: String(row.lead_id),
      messageId: row.message_id ? String(row.message_id) : null,
      leadEmail: row.email ? String(row.email) : null,
    };
  }

  async leadByEmail(emails: string[]) {
    const e = lowerAll(emails);
    if (!e.length) return null;
    const r = await this.db.query(
      "select id, lower(email) as email from leads where lower(email) = any($1::text[]) limit 1",
      [e],
    );
    const row = r.rows[0];
    return row ? { leadId: String(row.id), email: String(row.email) } : null;
  }

  async record(r: NewReply) {
    const leadStatus =
      r.category === "bounce_or_auto"
        ? r.suppress?.reason === "bounce"
          ? "bounced"
          : null
        : (LEAD_STATUS_FOR[r.category] ?? null);
    const messageStatus =
      r.category === "bounce_or_auto"
        ? r.suppress?.reason === "bounce"
          ? "bounced"
          : null
        : "replied";
    // One statement, so the suppression can't be lost between two round trips. `unsubscribed` is
    // sticky: a later reply never moves a lead out of it.
    const q = await this.db.query(
      `with ins as (
         insert into outreach_replies (agentmail_message_id, thread_id, from_email, subject, text,
           received_at, category, classified_by, reason, lead_id, message_id, suppressed_email,
           needs_founder, cost_micro_usd)
         values ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9, $10::uuid, $11::uuid, $12, $13, $14::bigint)
         on conflict (agentmail_message_id) do nothing
         returning id
       ),
       sup as (
         insert into suppressions (email, reason)
         select lower($12::text), $15::text where $12::text is not null
         on conflict (email) do nothing
         returning email
       ),
       lu as (
         update leads set status = $16::text, updated_at = now()
          where id = $10::uuid and $16::text is not null and exists (select 1 from ins)
            and (status <> 'unsubscribed' or $16::text = 'unsubscribed')
         returning id
       ),
       mu as (
         update outreach_messages set status = $17::text
          where id = $11::uuid and $17::text is not null and status = 'sent' and exists (select 1 from ins)
         returning id
       )
       select (select count(*) from ins)::int as inserted,
              ((select count(*) from sup) > 0
                or exists (select 1 from suppressions where email = lower($12::text))) as suppressed,
              (select count(*) from lu)::int as lu, (select count(*) from mu)::int as mu`,
      [
        r.agentmailMessageId,
        r.threadId,
        r.fromEmail.toLowerCase(),
        r.subject,
        r.text,
        r.receivedAt,
        r.category,
        r.classifiedBy,
        r.reason,
        r.leadId,
        r.messageId,
        r.suppress?.email.toLowerCase() ?? null,
        r.needsFounder,
        r.costMicroUsd.toString(),
        r.suppress?.reason ?? null,
        leadStatus,
        messageStatus,
      ],
    );
    const row = q.rows[0] ?? {};
    return {
      inserted: Number(row.inserted) > 0,
      suppressed: Boolean(r.suppress) && Boolean(row.suppressed),
    };
  }
}

// ---- in-memory store (tests, dry runs) ----------------------------------------------------------

export interface MemoryLead {
  id: string;
  email: string | null;
  status: string;
  githubUrl?: string | null;
  fit?: number | null;
  brief?: unknown;
}
export interface MemoryOutreachMessage {
  id: string;
  leadId: string;
  kind: "initial" | "followup" | "reply";
  status: "draft" | "approved" | "sent" | "bounced" | "replied";
  agentmailMessageId: string | null;
  approvedBy: string | null;
  sentAt: string | null;
}
export interface MemoryReply extends NewReply {
  id: string;
}

/** The outreach tables in memory, with PgReplyStore's semantics. Pass `alsoSuppressIn` (e.g. a
 *  `MemoryLeadStore`'s `suppressions` set) so sourcing and polling see the same list. */
export class MemoryReplyStore implements ReplyStore {
  readonly leads: MemoryLead[];
  readonly messages: MemoryOutreachMessage[];
  readonly replies: MemoryReply[] = [];
  /** email (lowercased) → reason. */
  readonly suppressions: Map<string, string>;
  private readonly shared: Set<string> | undefined;
  private seq = 0;

  constructor(
    init: {
      leads?: MemoryLead[];
      messages?: MemoryOutreachMessage[];
      suppressions?: Map<string, string>;
      alsoSuppressIn?: Set<string>;
    } = {},
  ) {
    this.leads = init.leads ?? [];
    this.messages = init.messages ?? [];
    this.suppressions = init.suppressions ?? new Map();
    this.shared = init.alsoSuppressIn;
  }

  private isSuppressed(email: string): boolean {
    return this.suppressions.has(email) || Boolean(this.shared?.has(email));
  }

  async lastReceivedAt() {
    const ts = this.replies.map((r) => r.receivedAt).sort();
    return ts.at(-1) ?? null;
  }

  async known(ids: string[]) {
    const have = new Set(this.replies.map((r) => r.agentmailMessageId));
    return new Set(ids.filter((i) => have.has(i)));
  }

  async matchSent(q: { citedMessageIds: string[]; fromEmail: string }) {
    const m = this.messages
      .filter((x) => x.agentmailMessageId && q.citedMessageIds.includes(x.agentmailMessageId))
      .sort((a, b) => (b.sentAt ?? "").localeCompare(a.sentAt ?? ""))[0];
    if (m) {
      const lead = this.leads.find((l) => l.id === m.leadId);
      return { leadId: m.leadId, messageId: m.id, leadEmail: lead?.email ?? null };
    }
    const lead = this.leads.find((l) => l.email?.toLowerCase() === q.fromEmail.toLowerCase());
    if (!lead) return null;
    const sent = this.messages
      .filter((x) => x.leadId === lead.id && x.sentAt)
      .sort((a, b) => (b.sentAt ?? "").localeCompare(a.sentAt ?? ""))[0];
    return { leadId: lead.id, messageId: sent?.id ?? null, leadEmail: lead.email };
  }

  async leadByEmail(emails: string[]) {
    const e = new Set(lowerAll(emails));
    const lead = this.leads.find((l) => l.email && e.has(l.email.toLowerCase()));
    return lead ? { leadId: lead.id, email: lead.email!.toLowerCase() } : null;
  }

  async record(r: NewReply) {
    const sup = r.suppress?.email.toLowerCase();
    if (sup && !this.isSuppressed(sup)) {
      this.suppressions.set(sup, r.suppress!.reason);
      this.shared?.add(sup);
    }
    const suppressed = sup ? this.isSuppressed(sup) : false;
    if (this.replies.some((x) => x.agentmailMessageId === r.agentmailMessageId)) {
      return { inserted: false, suppressed };
    }
    this.seq += 1;
    this.replies.push({ ...r, fromEmail: r.fromEmail.toLowerCase(), id: `reply-${this.seq}` });
    const bounce = r.suppress?.reason === "bounce";
    const leadStatus =
      r.category === "bounce_or_auto"
        ? bounce
          ? "bounced"
          : undefined
        : LEAD_STATUS_FOR[r.category];
    const lead = r.leadId ? this.leads.find((l) => l.id === r.leadId) : undefined;
    if (lead && leadStatus && (lead.status !== "unsubscribed" || leadStatus === "unsubscribed")) {
      lead.status = leadStatus;
    }
    const msgStatus =
      r.category === "bounce_or_auto" ? (bounce ? "bounced" : undefined) : "replied";
    const msg = r.messageId ? this.messages.find((m) => m.id === r.messageId) : undefined;
    if (msg && msgStatus && msg.status === "sent") msg.status = msgStatus;
    return { inserted: true, suppressed };
  }
}

// ---- Slack (optional, our own channel) ----------------------------------------------------------

export type SlackPoster = (text: string) => Promise<void>;

/** A poster for an incoming-webhook URL. Errors are the caller's to log; they never stop a poll. */
export function slackWebhookPoster(
  url: string,
  fetchFn: (input: string, init?: RequestInit) => Promise<Response> = fetch,
): SlackPoster {
  const u = z.url({ protocol: /^https$/ }).parse(url);
  return async (text) => {
    const res = await fetchFn(u, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`slack webhook answered ${res.status}`);
  };
}

// ---- the poll -----------------------------------------------------------------------------------

export interface PollOptions {
  agentmail: AgentMail;
  /** Our inbox address, e.g. anybench-outreach@agentmail.to. */
  inbox: string;
  store: ReplyStore;
  /** Optional Naïve fallback for replies the rules are unsure about. */
  model?: ReplyModelClassifier;
  /** Naïve spend cap for this poll. Default $0.20. */
  modelCapMicroUsd?: MicroUsd;
  slack?: SlackPoster;
  /** Classify but write nothing (no suppressions either) and post nothing. */
  dryRun?: boolean;
  /** Re-read this much before the newest stored reply (dedupe makes it free). Default 1 hour. */
  overlapMs?: number;
  pageSize?: number;
  maxPages?: number;
  /** Max new replies handled per poll. Default 200. */
  maxReplies?: number;
  log?: (line: string) => void;
}

export interface PolledReply {
  agentmailMessageId: string;
  threadId: string;
  from: string;
  subject: string | null;
  receivedAt: string;
  category: ReplyCategory;
  classifiedBy: "rules" | "model";
  reason: string;
  leadId: string | null;
  suppressed: string | null;
  needsFounder: boolean;
  costMicroUsd: MicroUsd;
  stored: boolean;
  modelError?: string;
}

export interface PollReport {
  after: string | null;
  listed: number;
  inbound: number;
  alreadyKnown: number;
  replies: PolledReply[];
  modelSpentMicroUsd: MicroUsd;
  modelCapMicroUsd: MicroUsd;
  modelSkipped: number;
  slackPosted: number;
  slackErrors: string[];
  truncated: boolean;
  dryRun: boolean;
}

export const DEFAULT_REPLY_MODEL_CAP_MICRO_USD: MicroUsd = 200_000n;

const EMAIL_IN_TEXT = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const MAX_STORED_TEXT = 10_000;

export async function pollReplies(o: PollOptions): Promise<PollReport> {
  const log = o.log ?? (() => undefined);
  const inbox = bareAddress(o.inbox);
  const pageSize = o.pageSize ?? 50;
  const maxPages = o.maxPages ?? 20;
  const maxReplies = o.maxReplies ?? 200;
  const modelCap = o.modelCapMicroUsd ?? DEFAULT_REPLY_MODEL_CAP_MICRO_USD;
  const overlap = o.overlapMs ?? 3_600_000;

  const last = await o.store.lastReceivedAt();
  const after = last ? new Date(Date.parse(last) - overlap).toISOString() : null;
  const report: PollReport = {
    after,
    listed: 0,
    inbound: 0,
    alreadyKnown: 0,
    replies: [],
    modelSpentMicroUsd: 0n,
    modelCapMicroUsd: modelCap,
    modelSkipped: 0,
    slackPosted: 0,
    slackErrors: [],
    truncated: false,
    dryRun: Boolean(o.dryRun),
  };

  // 1. List (newest first), keep inbound mail from other people.
  const inbound: Message[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const r = await o.agentmail.listMessages({
      inboxId: inbox,
      labels: ["received"],
      limit: pageSize,
      ...(after ? { after } : {}),
      ...(pageToken ? { pageToken } : {}),
    });
    report.listed += r.messages.length;
    for (const m of r.messages) if (isInboundReply(m, inbox)) inbound.push(m);
    pageToken = r.nextPageToken;
    if (!pageToken) break;
    if (page === maxPages - 1) report.truncated = true;
  }
  report.inbound = inbound.length;
  const known = await o.store.known(inbound.map((m) => m.messageId));
  report.alreadyKnown = known.size;
  let fresh = inbound
    .filter((m) => !known.has(m.messageId))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  if (fresh.length > maxReplies) {
    report.truncated = true;
    fresh = fresh.slice(0, maxReplies);
  }

  for (const listed of fresh) {
    // 2. Full message (list rows carry only a preview). Free.
    const m = await o.agentmail.getMessage(inbox, listed.messageId);
    const fromEmail = bareAddress(m.from);
    const text = newReplyText(m);
    const rules = classifyReplyByRules({
      from: m.from,
      subject: m.subject,
      text,
      headers: m.headers,
    });
    let category = rules.category;
    let classifiedBy: "rules" | "model" = "rules";
    let reason = rules.reason;
    let cost: MicroUsd = 0n;
    let modelError: string | undefined;

    // 3. Model only when the rules are unsure. An opt-out or bounce is always confident.
    if (!rules.confident && o.model) {
      if (modelCap - report.modelSpentMicroUsd < o.model.maxCostMicroUsd) {
        report.modelSkipped += 1;
        modelError = "model cap reached";
      } else {
        try {
          const c = await o.model.classify({
            messageId: m.messageId,
            from: fromEmail,
            subject: m.subject,
            text,
          });
          cost = c.costMicroUsd;
          category = ReplyCategorySchema.parse(c.category);
          classifiedBy = "model";
          reason = c.reason.slice(0, 400);
        } catch (err) {
          const spent = (err as { costMicroUsd?: unknown }).costMicroUsd;
          cost = typeof spent === "bigint" ? spent : o.model.maxCostMicroUsd;
          modelError = (err as Error).message;
          log(`model failed on ${m.messageId}: ${modelError}; keeping the rules' "${category}"`);
        }
        report.modelSpentMicroUsd += cost;
      }
    }
    // A model "bounce_or_auto" is treated as an auto-reply: only a rules-detected delivery failure
    // suppresses for "bounce" (a model can't tell us which address failed).
    const bounce = classifiedBy === "rules" && rules.bounce;

    // 4. Which lead, and which address to suppress.
    const cited = [...new Set([m.inReplyTo, ...m.references].filter((x): x is string => !!x))];
    let match = await o.store.matchSent({ citedMessageIds: cited, fromEmail });
    let suppress: NewReply["suppress"] = null;
    if (category === "unsubscribe") {
      suppress = { email: fromEmail, reason: "unsubscribe" };
    } else if (category === "bounce_or_auto" && bounce) {
      // The sender is the mail system; the failed address is our lead's.
      let failed = match?.leadEmail ?? null;
      if (!failed) {
        const named = (m.text ?? text).match(EMAIL_IN_TEXT) ?? [];
        const lead = await o.store.leadByEmail(named.filter((e) => bareAddress(e) !== inbox));
        if (lead) {
          failed = lead.email;
          match ??= { leadId: lead.leadId, messageId: null, leadEmail: lead.email };
        }
      }
      if (failed) suppress = { email: failed, reason: "bounce" };
    }
    // A bounce we can't attribute goes to the founder too (someone must find the address).
    const needsFounder =
      NEEDS_FOUNDER.has(category) || (category === "bounce_or_auto" && bounce && !suppress);

    const reply: NewReply = {
      agentmailMessageId: m.messageId,
      threadId: m.threadId,
      fromEmail,
      subject: m.subject ?? null,
      text: text.slice(0, MAX_STORED_TEXT) || null,
      receivedAt: new Date(m.timestamp).toISOString(),
      category,
      classifiedBy,
      reason,
      leadId: match?.leadId ?? null,
      messageId: match?.messageId ?? null,
      suppress,
      needsFounder,
      costMicroUsd: cost,
    };
    let stored = false;
    let suppressed: string | null = null;
    if (!o.dryRun) {
      const w = await o.store.record(reply);
      stored = w.inserted;
      suppressed = w.suppressed && suppress ? suppress.email : null;
    }
    const polled: PolledReply = {
      agentmailMessageId: m.messageId,
      threadId: m.threadId,
      from: fromEmail,
      subject: m.subject ?? null,
      receivedAt: reply.receivedAt,
      category,
      classifiedBy,
      reason,
      leadId: reply.leadId,
      suppressed: o.dryRun ? (suppress?.email ?? null) : suppressed,
      needsFounder,
      costMicroUsd: cost,
      stored,
      ...(modelError ? { modelError } : {}),
    };
    report.replies.push(polled);
    log(
      `${polled.receivedAt} ${fromEmail}: ${category} (${classifiedBy}: ${reason})` +
        `${polled.suppressed ? ` → suppressed ${polled.suppressed}` : ""}` +
        `${needsFounder ? " → needs founder" : ""}`,
    );

    // 5. Interested → our own Slack, if wired. Never the lead.
    if (category === "interested" && o.slack && !o.dryRun && stored) {
      try {
        await o.slack(
          `Interested reply from ${fromEmail}${reply.leadId ? ` (lead ${reply.leadId})` : ""}: ` +
            `"${text.slice(0, 280)}" (subject: ${m.subject ?? "-"}). Answer it by hand.`,
        );
        report.slackPosted += 1;
      } catch (err) {
        report.slackErrors.push((err as Error).message);
      }
    }
  }
  return report;
}
