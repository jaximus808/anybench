// TDM-167 [15.8a]: reply polling against real Postgres (migration 0008 outreach_replies):
// suppression lands in the same statement as the reply, PgLeadStore then reports the address as
// suppressed, re-polls are idempotent, `unsubscribed` is sticky, and the funnel counts rows.
import {
  FakeAgentMail,
  PgFunnel,
  PgLeadStore,
  PgReplyStore,
  pollReplies,
  type Message,
} from "@anybench/outreach";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";

const available = await pgAvailableTdm11();
const INBOX = "anybench-outreach@agentmail.to";
const LEAD = "dev@tdm167-pg.example";

describe.skipIf(!available)("outreach replies (TDM-167, local Postgres)", () => {
  let db: FreshDbTdm11;
  let q: { query: (t: string, v?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };
  let mail: FakeAgentMail;
  let sentId: string;
  let leadId: string;

  beforeAll(async () => {
    db = await freshMigratedDbTdm11({ max: 4 });
    q = { query: (text, values) => db.pool.query(text, values) };
    mail = new FakeAgentMail();
    await mail.createInbox({ username: "anybench-outreach" });
    const sent = await mail.send({ inboxId: INBOX, to: LEAD, subject: "hi", text: "hello" });
    sentId = sent.messageId;
    const lead = await new PgLeadStore(q).insert({
      source: "hackathon_optin",
      query: null,
      company: null,
      contact: "Dev",
      email: LEAD,
      githubUrl: "https://github.com/tdm167/pg",
      signals: {},
      status: "new",
    });
    leadId = lead.id!;
    await q.query(
      `update leads set status = 'scored', fit = 80,
         brief = '{"status":"scored","naive":{"cost_micro_usd":"3557"},"contact_lookup":{"cost_micro_usd":"24500"}}'::jsonb
       where id = $1`,
      [leadId],
    );
    await q.query(
      `insert into outreach_messages (lead_id, kind, subject, text, status, agentmail_message_id, approved_by, sent_at)
       values ($1, 'initial', 'hi', 'hello', 'sent', $2, 'founder', now())`,
      [leadId, sentId],
    );
  }, 60_000);
  afterAll(async () => {
    await db?.drop();
  }, 60_000);

  it("an unsubscribe reply → suppressions row in the same write; PgLeadStore reports it suppressed", async () => {
    const leads = new PgLeadStore(q);
    expect(await leads.suppressed([LEAD])).toEqual(new Set());
    mail.simulateInboundReply({
      inboxId: INBOX,
      inReplyTo: sentId,
      from: `Dev <${LEAD}>`,
      text: "unsubscribe",
    });

    const r = await pollReplies({ agentmail: mail, inbox: INBOX, store: new PgReplyStore(q) });
    expect(r.replies).toHaveLength(1);
    expect(r.replies[0]).toMatchObject({
      category: "unsubscribe",
      leadId,
      suppressed: LEAD,
      stored: true,
    });

    expect(await leads.suppressed(["Dev@TDM167-pg.example"])).toEqual(new Set([LEAD]));
    expect(await leads.suppressedDomains(["tdm167-pg.example"])).toEqual(
      new Set(["tdm167-pg.example"]),
    );
    const sup = await q.query("select email, reason from suppressions");
    expect(sup.rows).toEqual([{ email: LEAD, reason: "unsubscribe" }]);
    const lead = await q.query("select status from leads where id = $1", [leadId]);
    expect(lead.rows[0]!.status).toBe("unsubscribed");
    const msg = await q.query("select status from outreach_messages where lead_id = $1", [leadId]);
    expect(msg.rows[0]!.status).toBe("replied");
  });

  it("re-polling is idempotent; a later 'interested' doesn't lift unsubscribed", async () => {
    const again = await pollReplies({ agentmail: mail, inbox: INBOX, store: new PgReplyStore(q) });
    expect(again.replies).toHaveLength(0);
    expect(again.alreadyKnown).toBe(1);

    const m: Message = {
      inboxId: INBOX,
      threadId: "tdm167-t2",
      messageId: "<tdm167-pg-2@x>",
      labels: ["received"],
      timestamp: "2026-11-08T12:00:00.000Z", // after the fake clock's first reply
      from: LEAD,
      to: [INBOX],
      cc: [],
      subject: "Re: hi",
      preview: "Actually yes, interested!",
      text: "Actually yes, interested!",
      html: undefined,
      extractedText: "Actually yes, interested!",
      inReplyTo: sentId,
      references: [sentId],
      headers: {},
    };
    mail.messages.push(m);
    const r = await pollReplies({ agentmail: mail, inbox: INBOX, store: new PgReplyStore(q) });
    expect(r.replies[0]).toMatchObject({ category: "interested", needsFounder: true });
    const lead = await q.query("select status from leads where id = $1", [leadId]);
    expect(lead.rows[0]!.status).toBe("unsubscribed");
  });

  it("two concurrent records of one message: one insert", async () => {
    const store = new PgReplyStore(q);
    const reply = {
      agentmailMessageId: "<tdm167-race@x>",
      threadId: "t",
      fromEmail: "race@tdm167-pg.example",
      subject: null,
      text: "stop",
      receivedAt: new Date().toISOString(),
      category: "unsubscribe" as const,
      classifiedBy: "rules" as const,
      reason: "opt-out",
      leadId: null,
      messageId: null,
      suppress: { email: "race@tdm167-pg.example", reason: "unsubscribe" as const },
      needsFounder: false,
      costMicroUsd: 0n,
    };
    const rs = await Promise.all([store.record(reply), store.record(reply), store.record(reply)]);
    expect(rs.filter((x) => x.inserted)).toHaveLength(1);
    expect(rs.every((x) => x.suppressed)).toBe(true);
    const n = await q.query(
      "select count(*)::int as n from outreach_replies where agentmail_message_id = $1",
      [reply.agentmailMessageId],
    );
    expect(n.rows[0]!.n).toBe(1);
  });

  it("the funnel counts rows", async () => {
    const f = await new PgFunnel(q).funnel();
    expect(f.stages).toEqual({
      sourced: 1,
      scouted: 1,
      fit: 1,
      drafted: 1,
      approved: 1,
      sent: 1,
      replied: 1,
      interested: 1,
      unsubscribed: 1,
    });
    expect(f.repliesTotal).toBe(3);
    expect(f.suppressions).toEqual({ total: 2, byReason: { unsubscribe: 2 } });
    expect(f.needsFounder).toBe(1);
    expect(f.spend).toEqual({
      naiveScoutMicroUsd: 3_557n,
      naiveRepliesMicroUsd: 0n,
      naiveTotalMicroUsd: 3_557n,
      monidLookupsMicroUsd: 24_500n,
      contextDevCredits: null,
    });
  });
});
