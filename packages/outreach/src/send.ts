// TDM-166 [15.6a]: send founder-approved drafts through AgentMail (via Monid), with limits.
//
// Dry run unless `send: true`. For every approved, unsent initial message:
//   lintDraft again (postal address from COMPANY_POSTAL_ADDRESS, unsubscribe line, link, rule 10)
//   → claim it: in ONE transaction under an advisory lock, check the suppression list and the UTC
//     day's send count against OUTREACH_DAILY_SEND_LIMIT, then mark it sent (at-most-once)
//   → AgentMail send with List-Unsubscribe (mailto: our inbox, subject unsubscribe)
//   → record the AgentMail message id (replies are matched on it, TDM-167); lead → emailed
// A send that Monid says never ran (cost cap, wallet, rate limit, blocked, halted, 4xx) is released
// back to approved. Any other failure leaves it marked sent with no message id, so it is never sent
// twice; the founder checks the inbox.
//
// `sendSelfTest` sends a draft to OUR inbox only (for checking rendering); it never touches the DB.

import { listUnsubscribeHeaders, type AgentMail } from "./agentmail.js";
import type { QueueItem } from "./drafts.js";
import type { MicroUsd } from "./money.js";
import { MonidError } from "./monid.js";
import { lintDraft } from "./writer.js";

export const DEFAULT_DAILY_SEND_LIMIT = 25;

export interface SendQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export type ClaimResult = "claimed" | "daily_limit" | "suppressed" | "gone";

export interface SendStore {
  /** Approved (approved_by set), unsent initial messages with an address, oldest approval first. */
  sendable(limit: number): Promise<QueueItem[]>;
  sentToday(): Promise<number>;
  claim(id: string, dailyLimit: number): Promise<ClaimResult>;
  markSent(id: string, agentmailMessageId: string): Promise<void>;
  release(id: string): Promise<void>;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const DAY_START = `(date_trunc('day', now() at time zone 'utc') at time zone 'utc')`;

/** Needs ONE connection (a pg.Client, not a Pool) so the claim transaction holds. */
export class PgSendStore implements SendStore {
  constructor(private readonly db: SendQueryable) {}

  async sendable(limit: number): Promise<QueueItem[]> {
    const r = await this.db.query(
      `select m.id, m.lead_id, m.status, m.subject, m.text, m.html, m.approved_by, m.sent_at,
              m.agentmail_message_id, m.created_at, l.email, l.company, l.github_url, l.source,
              l.signals, l.brief
         from outreach_messages m join leads l on l.id = m.lead_id
        where m.kind = 'initial' and m.status = 'approved' and m.approved_by is not null
          and m.sent_at is null and l.email is not null
        order by m.created_at asc limit $1`,
      [limit],
    );
    return r.rows.map((x) => ({
      id: String(x.id),
      leadId: String(x.lead_id),
      status: String(x.status),
      subject: str(x.subject) ?? "",
      text: str(x.text) ?? "",
      html: str(x.html) ?? "",
      approvedBy: str(x.approved_by),
      sentAt: null,
      agentmailMessageId: null,
      createdAt: x.created_at instanceof Date ? x.created_at.toISOString() : String(x.created_at),
      email: str(x.email),
      company: str(x.company),
      githubUrl: str(x.github_url),
      source: str(x.source),
      signals: (x.signals as Record<string, unknown>) ?? {},
      brief: x.brief ?? null,
    }));
  }

  async sentToday(): Promise<number> {
    const r = await this.db.query(
      `select count(*)::int as n from outreach_messages where sent_at >= ${DAY_START}`,
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  async claim(id: string, dailyLimit: number): Promise<ClaimResult> {
    await this.db.query("begin");
    try {
      await this.db.query("select pg_advisory_xact_lock(hashtext('anybench_outreach_send'))");
      const sup = await this.db.query(
        `select 1 from outreach_messages m join leads l on l.id = m.lead_id
           join suppressions s on s.email = lower(l.email) where m.id = $1::uuid`,
        [id],
      );
      if (sup.rows.length) {
        await this.db.query("rollback");
        return "suppressed";
      }
      if ((await this.sentToday()) >= dailyLimit) {
        await this.db.query("rollback");
        return "daily_limit";
      }
      const u = await this.db.query(
        `update outreach_messages set status = 'sent', sent_at = now()
          where id = $1::uuid and status = 'approved' and approved_by is not null and sent_at is null
         returning id`,
        [id],
      );
      await this.db.query("commit");
      return u.rows.length ? "claimed" : "gone";
    } catch (e) {
      await this.db.query("rollback").catch(() => undefined);
      throw e;
    }
  }

  async markSent(id: string, agentmailMessageId: string): Promise<void> {
    await this.db.query(
      `with m as (update outreach_messages set agentmail_message_id = $2 where id = $1::uuid returning lead_id)
       update leads set status = 'emailed', updated_at = now() where id in (select lead_id from m)`,
      [id, agentmailMessageId],
    );
  }

  async release(id: string): Promise<void> {
    await this.db.query(
      `update outreach_messages set status = 'approved', sent_at = null
        where id = $1::uuid and status = 'sent' and agentmail_message_id is null`,
      [id],
    );
  }
}

export interface SendOptions {
  store: SendStore;
  agentmail?: AgentMail;
  /** Our AgentMail inbox (OUTREACH_FROM_ADDRESS). */
  inbox: string;
  postalAddress: string | undefined;
  dailyLimit?: number;
  limit?: number;
  /** False (default): report what would be sent, send nothing. */
  send?: boolean;
  log?: (line: string) => void;
}

export interface SendResult {
  id: string;
  to: string;
  subject: string;
  outcome:
    | "would_send"
    | "sent"
    | "lint_failed"
    | "suppressed"
    | "daily_limit"
    | "gone"
    | "failed_released"
    | "failed_unknown";
  detail?: string;
  agentmailMessageId?: string;
  costMicroUsd: MicroUsd;
}

export interface SendReport {
  dryRun: boolean;
  dailyLimit: number;
  sentTodayBefore: number;
  results: SendResult[];
  spentMicroUsd: MicroUsd;
}

/** Monid errors that mean the send never ran (safe to retry later). */
const NOT_SENT: ReadonlySet<string> = new Set([
  "MAX_COST_EXCEEDED",
  "WALLET_INSUFFICIENT_FUNDS",
  "RATE_LIMITED",
  "UNAUTHORIZED",
  "BAD_REQUEST",
  "BLOCKED",
  "SPEND_CAP",
  "HALTED",
]);

export class SendConfigError extends Error {
  override readonly name = "SendConfigError";
}

export async function runSend(o: SendOptions): Promise<SendReport> {
  const log = o.log ?? (() => undefined);
  const postal = o.postalAddress?.trim();
  if (!postal) {
    throw new SendConfigError("COMPANY_POSTAL_ADDRESS is not set: refusing to send (CAN-SPAM)");
  }
  const dailyLimit = o.dailyLimit ?? DEFAULT_DAILY_SEND_LIMIT;
  if (!Number.isInteger(dailyLimit) || dailyLimit < 0) {
    throw new SendConfigError("OUTREACH_DAILY_SEND_LIMIT must be a non-negative integer");
  }
  if (o.send && !o.agentmail) throw new SendConfigError("sending needs an AgentMail client");
  const items = await o.store.sendable(o.limit ?? dailyLimit);
  const report: SendReport = {
    dryRun: !o.send,
    dailyLimit,
    sentTodayBefore: await o.store.sentToday(),
    results: [],
    spentMicroUsd: 0n,
  };
  let wouldSend = report.sentTodayBefore;
  for (const item of items) {
    const base = { id: item.id, to: item.email ?? "", subject: item.subject, costMicroUsd: 0n };
    const lint = lintDraft(item, { postalAddress: postal });
    if (lint.length) {
      report.results.push({ ...base, outcome: "lint_failed", detail: lint.join("; ") });
      continue;
    }
    if (!o.send) {
      const over = wouldSend >= dailyLimit;
      report.results.push({ ...base, outcome: over ? "daily_limit" : "would_send" });
      if (!over) wouldSend++;
      continue;
    }
    const claim = await o.store.claim(item.id, dailyLimit);
    if (claim !== "claimed") {
      report.results.push({ ...base, outcome: claim });
      if (claim === "daily_limit") {
        log(`daily limit (${dailyLimit}) reached; stopping`);
        break;
      }
      continue;
    }
    try {
      const sent = await o.agentmail!.send({
        inboxId: o.inbox,
        to: item.email!,
        subject: item.subject,
        text: item.text,
        html: item.html,
        headers: listUnsubscribeHeaders(o.inbox),
        labels: ["outreach", "initial"],
      });
      await o.store.markSent(item.id, sent.messageId);
      report.spentMicroUsd += sent.costMicroUsd;
      report.results.push({
        ...base,
        outcome: "sent",
        agentmailMessageId: sent.messageId,
        costMicroUsd: sent.costMicroUsd,
      });
      log(`sent ${item.id} to ${item.email}`);
    } catch (e) {
      const known = e instanceof MonidError && NOT_SENT.has(e.code) && !e.chargeUnknown;
      if (known) await o.store.release(item.id);
      report.results.push({
        ...base,
        outcome: known ? "failed_released" : "failed_unknown",
        detail: (e as Error).message,
      });
      log(
        `send ${item.id} failed (${known ? "not sent, back to approved" : "UNKNOWN: check the inbox"}): ${(e as Error).message}`,
      );
      if (!known) break;
    }
  }
  return report;
}

/** Sends one draft to our own inbox and nowhere else. Never changes the message's status. */
export async function sendSelfTest(o: {
  agentmail: AgentMail;
  inbox: string;
  item: Pick<QueueItem, "subject" | "text" | "html">;
}): Promise<{ messageId: string; costMicroUsd: MicroUsd; to: string }> {
  const sent = await o.agentmail.send({
    inboxId: o.inbox,
    to: o.inbox,
    subject: `[self-test] ${o.item.subject}`,
    text: o.item.text,
    html: o.item.html,
    headers: listUnsubscribeHeaders(o.inbox),
    labels: ["outreach-self-test"],
  });
  return { messageId: sent.messageId, costMicroUsd: sent.costMicroUsd, to: o.inbox };
}
