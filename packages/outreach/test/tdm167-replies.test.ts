// TDM-167 [15.8a]: reply polling, rules classification, suppression and the funnel, offline
// (FakeAgentMail + the in-memory stores). The Postgres path is in
// apps/server/test/outreach-replies-tdm167.test.ts.
import { describe, expect, it } from "vitest";
import {
  FakeAgentMail,
  MemoryFunnel,
  MemoryLeadStore,
  MemoryReplyStore,
  classifyReplyByRules,
  formatFunnel,
  newReplyText,
  pollReplies,
  stripQuoted,
  type Message,
  type ReplyModelClassifier,
} from "../src/index.js";

const INBOX = "anybench-outreach@agentmail.to";

const rules = (
  text: string,
  subject = "Re: your harness benchmark",
  from = "dev@tdm167-lead.example",
) => classifyReplyByRules({ from, subject, text });

describe("classifyReplyByRules (TDM-167)", () => {
  it.each([
    ["unsubscribe", "unsubscribe"],
    ["Please remove me from your list.", "unsubscribe"],
    ["STOP", "unsubscribe"],
    ["stop.", "unsubscribe"],
    ["Stop emailing me.", "unsubscribe"],
    ["Don't contact me again", "unsubscribe"],
    ["please opt me out", "unsubscribe"],
    ["Take me off this list", "unsubscribe"],
    ["No more emails please", "unsubscribe"],
    ["Yes! Interested, please run it on our repo.", "interested"],
    ["Sounds great, let's do it", "interested"],
    ["Sure, go ahead.", "interested"],
    ["How much does this cost?", "question"],
    ["What exactly would you measure", "question"],
    ["Not right now, maybe next quarter.", "not_now"],
    ["No thanks.", "not_now"],
    ["We're not interested.", "not_now"],
  ])("%j → %s", (text, category) => {
    const r = rules(text);
    expect(r.category).toBe(category);
    expect(r.confident).toBe(true);
  });

  it("an unsubscribe subject wins even when the body says yes", () => {
    expect(rules("yes", "unsubscribe").category).toBe("unsubscribe");
    expect(rules("", "Re: Unsubscribe").category).toBe("unsubscribe");
  });

  it("'stop' inside a sentence is not an opt-out, and 'not interested' is not interested", () => {
    expect(rules("We can't stop talking about your tool, we're interested!").category).toBe(
      "interested",
    );
    expect(rules("not interested, thanks").category).toBe("not_now");
  });

  it("bounces (from the mail system) and auto-replies are bounce_or_auto; only bounces are flagged", () => {
    const b = classifyReplyByRules({
      from: "MAILER-DAEMON@amazonses.com",
      subject: "Delivery Status Notification (Failure)",
      text: "An error occurred while trying to deliver the mail to dev@tdm167-lead.example",
    });
    expect(b).toMatchObject({ category: "bounce_or_auto", bounce: true });
    const ooo = rules(
      "I'm currently out of the office until Monday.",
      "Automatic reply: your benchmark",
    );
    expect(ooo).toMatchObject({ category: "bounce_or_auto", bounce: false });
    const hdr = classifyReplyByRules({
      from: "dev@tdm167-lead.example",
      subject: "Re: x",
      text: "Thanks for your message",
      headers: { "Auto-Submitted": "auto-replied" },
    });
    expect(hdr).toMatchObject({ category: "bounce_or_auto", bounce: false });
  });

  it("nothing matched → unclear and not confident (the model may be asked)", () => {
    expect(rules("Hmm.")).toMatchObject({ category: "unclear", confident: false });
    expect(rules("")).toMatchObject({ category: "unclear", confident: false });
  });
});

describe("quoted history is ignored (our footer says 'unsubscribe')", () => {
  const body = [
    "Sounds good, run it!",
    "",
    "On Sun, Nov 8, 2026 at 9:00 AM Anybench <anybench-outreach@agentmail.to> wrote:",
    "> Hi, we benchmarked ...",
    "> Reply 'unsubscribe' to stop these emails. 123 Example St.",
  ].join("\n");

  it("stripQuoted cuts at 'On ... wrote:' and drops > lines", () => {
    expect(stripQuoted(body)).toBe("Sounds good, run it!");
    expect(stripQuoted("ok\n> unsubscribe\nthanks")).toBe("ok\nthanks");
    expect(
      stripQuoted("ok\n\nOn Sun, Nov 8, 2026 at 9:00 AM Anybench\n<x@y> wrote:\n> unsubscribe"),
    ).toBe("ok");
  });

  it("newReplyText prefers extracted_text, else strips the body", () => {
    expect(newReplyText({ extractedText: "yes please", text: body, preview: undefined })).toBe(
      "yes please",
    );
    expect(newReplyText({ extractedText: undefined, text: body, preview: undefined })).toBe(
      "Sounds good, run it!",
    );
    expect(
      rules(newReplyText({ extractedText: undefined, text: body, preview: undefined })).category,
    ).toBe("interested");
  });
});

// ---- the poll -----------------------------------------------------------------------------------

/** Our inbox, one lead, one approved+sent initial email to it; returns ids to reply to. */
async function world(leadEmail = "dev@tdm167-lead.example") {
  const mail = new FakeAgentMail();
  await mail.createInbox({ username: "anybench-outreach", displayName: "Anybench" });
  const sent = await mail.send({
    inboxId: INBOX,
    to: leadEmail,
    subject: "Your harness, benchmarked with a correctness gate",
    text: "Hi ... Reply 'unsubscribe' to opt out.",
  });
  const leadStore = new MemoryLeadStore();
  const store = new MemoryReplyStore({
    leads: [
      {
        id: "tdm167-lead-1",
        email: leadEmail,
        status: "scored",
        brief: { status: "scored", naive: { cost_micro_usd: "3557" } },
      },
      { id: "tdm167-lead-2", email: "other@tdm167-lead2.example", status: "new" },
    ],
    messages: [
      {
        id: "tdm167-msg-1",
        leadId: "tdm167-lead-1",
        kind: "initial",
        status: "sent",
        agentmailMessageId: sent.messageId,
        approvedBy: "founder",
        sentAt: "2026-11-08T09:00:00.000Z",
      },
      {
        id: "tdm167-msg-2",
        leadId: "tdm167-lead-2",
        kind: "initial",
        status: "draft",
        agentmailMessageId: null,
        approvedBy: null,
        sentAt: null,
      },
    ],
    alsoSuppressIn: leadStore.suppressions,
  });
  return { mail, sent, store, leadStore, leadEmail };
}

/** An inbound message with any from/subject/headers (bounces, auto-replies), straight into the fake. */
function inbound(
  mail: FakeAgentMail,
  m: Partial<Message> & { from: string; text: string; messageId: string },
) {
  const msg: Message = {
    inboxId: INBOX,
    threadId: m.threadId ?? `thread-${m.messageId}`,
    labels: ["received", "unread"],
    timestamp: m.timestamp ?? "2026-11-08T10:00:00.000Z",
    to: [INBOX],
    cc: [],
    subject: m.subject ?? "Re: x",
    preview: m.text.slice(0, 200),
    html: undefined,
    extractedText: m.text,
    inReplyTo: undefined,
    references: [],
    headers: {},
    ...m,
  };
  mail.messages.push(msg);
  return msg;
}

describe("pollReplies (TDM-167)", () => {
  it("an unsubscribe reply is suppressed at once and the lead store reports it as suppressed", async () => {
    const w = await world();
    w.mail.simulateInboundReply({
      inboxId: INBOX,
      inReplyTo: w.sent.messageId,
      from: `Dev <${w.leadEmail}>`,
      text: "Please remove me.",
    });
    expect(await w.leadStore.suppressed([w.leadEmail])).toEqual(new Set());

    const r = await pollReplies({ agentmail: w.mail, inbox: INBOX, store: w.store });
    expect(r.replies).toHaveLength(1);
    expect(r.replies[0]).toMatchObject({
      category: "unsubscribe",
      classifiedBy: "rules",
      leadId: "tdm167-lead-1",
      suppressed: w.leadEmail,
      needsFounder: false,
      stored: true,
    });
    // The suppression list the sender (TDM-166) checks: LeadStore.suppressed.
    expect(await w.leadStore.suppressed(["DEV@tdm167-lead.example"])).toEqual(
      new Set([w.leadEmail]),
    );
    expect(w.store.suppressions.get(w.leadEmail)).toBe("unsubscribe");
    expect(w.store.leads[0]!.status).toBe("unsubscribed");
    expect(w.store.messages[0]!.status).toBe("replied");
    // Nothing was sent: the only send is the original email (one recipient).
    expect(w.mail.spentMicroUsd).toBe(1_001_000n); // inbox $1 + one send
    expect(w.mail.messages.filter((m) => m.labels.includes("sent"))).toHaveLength(1);
  });

  it("interested → lead interested, needs founder, Slack posted; never answered", async () => {
    const w = await world();
    w.mail.simulateInboundReply({
      inboxId: INBOX,
      inReplyTo: w.sent.messageId,
      from: w.leadEmail,
      text: "Yes please, run it! What do you need from us?",
    });
    const posts: string[] = [];
    const r = await pollReplies({
      agentmail: w.mail,
      inbox: INBOX,
      store: w.store,
      slack: async (t) => {
        posts.push(t);
      },
    });
    expect(r.replies[0]).toMatchObject({
      category: "interested",
      needsFounder: true,
      suppressed: null,
    });
    expect(w.store.leads[0]!.status).toBe("interested");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain(w.leadEmail);
    expect(r.slackPosted).toBe(1);
    expect(w.mail.messages.filter((m) => m.labels.includes("sent"))).toHaveLength(1);
  });

  it("re-polling stores nothing twice; our own outbound/self-sent copies are never replies", async () => {
    const w = await world();
    // A self-send is ONE message with sent+received: not inbound.
    await w.mail.send({ inboxId: INBOX, to: INBOX, subject: "self", text: "unsubscribe" });
    w.mail.simulateInboundReply({
      inboxId: INBOX,
      inReplyTo: w.sent.messageId,
      from: w.leadEmail,
      text: "How does pricing work?",
    });
    const first = await pollReplies({ agentmail: w.mail, inbox: INBOX, store: w.store });
    expect(first.inbound).toBe(1);
    expect(first.replies.map((x) => x.category)).toEqual(["question"]);
    expect(w.store.suppressions.size).toBe(0);
    const again = await pollReplies({ agentmail: w.mail, inbox: INBOX, store: w.store });
    expect(again.after).not.toBeNull();
    expect(again.replies).toHaveLength(0);
    expect(again.alreadyKnown).toBe(1);
    expect(w.store.replies).toHaveLength(1);
  });

  it("a bounce suppresses the lead's address (not the mailer-daemon); an auto-reply suppresses nothing", async () => {
    const w = await world();
    inbound(w.mail, {
      messageId: "<tdm167-bounce@ses>",
      from: "MAILER-DAEMON@amazonses.com",
      subject: "Delivery Status Notification (Failure)",
      text: `Delivery to ${w.leadEmail} failed permanently.`,
    });
    inbound(w.mail, {
      messageId: "<tdm167-ooo@x>",
      from: "other@tdm167-lead2.example",
      subject: "Automatic reply: hi",
      text: "I am out of the office until 2026-11-20.",
      timestamp: "2026-11-08T10:05:00.000Z",
    });
    const r = await pollReplies({ agentmail: w.mail, inbox: INBOX, store: w.store });
    const [bounce, ooo] = r.replies;
    expect(bounce).toMatchObject({
      category: "bounce_or_auto",
      suppressed: w.leadEmail,
      leadId: "tdm167-lead-1",
    });
    expect(ooo).toMatchObject({
      category: "bounce_or_auto",
      suppressed: null,
      needsFounder: false,
    });
    expect(w.store.suppressions.get(w.leadEmail)).toBe("bounce");
    expect(w.store.leads[0]!.status).toBe("bounced");
    expect(w.store.leads[1]!.status).toBe("new");
  });

  it("an unsubscribe from an address that matches no lead is still suppressed", async () => {
    const w = await world();
    inbound(w.mail, {
      messageId: "<tdm167-stranger@x>",
      from: "Stranger <Stranger@tdm167-x.example>",
      text: "stop",
    });
    const r = await pollReplies({ agentmail: w.mail, inbox: INBOX, store: w.store });
    expect(r.replies[0]).toMatchObject({
      category: "unsubscribe",
      leadId: null,
      suppressed: "stranger@tdm167-x.example",
    });
    expect(await w.leadStore.suppressed(["stranger@tdm167-x.example"])).toEqual(
      new Set(["stranger@tdm167-x.example"]),
    );
  });

  it("the model runs only when the rules are unsure, within its cap, and an opt-out never reaches it", async () => {
    const w = await world();
    w.mail.simulateInboundReply({
      inboxId: INBOX,
      inReplyTo: w.sent.messageId,
      from: w.leadEmail,
      text: "Hmm, maybe. Ping my cofounder.",
    });
    inbound(w.mail, {
      messageId: "<tdm167-u@x>",
      from: "a@tdm167-x.example",
      text: "unsubscribe",
      timestamp: "2026-11-08T11:00:00.000Z",
    });
    inbound(w.mail, {
      messageId: "<tdm167-v@x>",
      from: "b@tdm167-x.example",
      text: "Hm.",
      timestamp: "2026-11-08T11:01:00.000Z",
    });
    const seen: string[] = [];
    const model: ReplyModelClassifier = {
      maxCostMicroUsd: 50_000n,
      async classify(r) {
        seen.push(r.text);
        return { category: "interested", reason: "model says yes", costMicroUsd: 45_000n };
      },
    };
    const r = await pollReplies({
      agentmail: w.mail,
      inbox: INBOX,
      store: w.store,
      model,
      modelCapMicroUsd: 90_000n,
    });
    // 90k cap - 45k spent = 45k left < the 50k a call may cost: the second unsure reply stays rules.
    expect(seen).toEqual(["Hmm, maybe. Ping my cofounder."]);
    expect(r.replies.map((x) => [x.category, x.classifiedBy])).toEqual([
      ["interested", "model"],
      ["unsubscribe", "rules"],
      ["unclear", "rules"],
    ]);
    expect(r.modelSpentMicroUsd).toBe(45_000n);
    expect(r.modelSkipped).toBe(1);
    expect(w.store.replies[0]!.costMicroUsd).toBe(45_000n);
  });

  it("dry run classifies but writes nothing", async () => {
    const w = await world();
    w.mail.simulateInboundReply({
      inboxId: INBOX,
      inReplyTo: w.sent.messageId,
      from: w.leadEmail,
      text: "unsubscribe",
    });
    const r = await pollReplies({ agentmail: w.mail, inbox: INBOX, store: w.store, dryRun: true });
    expect(r.replies[0]).toMatchObject({
      category: "unsubscribe",
      stored: false,
      suppressed: w.leadEmail,
    });
    expect(w.store.replies).toHaveLength(0);
    expect(w.store.suppressions.size).toBe(0);
    expect(w.store.leads[0]!.status).toBe("scored");
  });

  it("a failed model call keeps the rules' answer and books its spend", async () => {
    const w = await world();
    w.mail.simulateInboundReply({
      inboxId: INBOX,
      inReplyTo: w.sent.messageId,
      from: w.leadEmail,
      text: "Hm.",
    });
    const model: ReplyModelClassifier = {
      maxCostMicroUsd: 50_000n,
      async classify() {
        throw Object.assign(new Error("naive down"), { costMicroUsd: 1_200n });
      },
    };
    const r = await pollReplies({ agentmail: w.mail, inbox: INBOX, store: w.store, model });
    expect(r.replies[0]).toMatchObject({
      category: "unclear",
      classifiedBy: "rules",
      needsFounder: true,
      modelError: "naive down",
    });
    expect(r.modelSpentMicroUsd).toBe(1_200n);
  });
});

describe("funnel stats (TDM-167)", () => {
  it("counts each stage from the stored rows (no estimates)", async () => {
    const w = await world();
    w.mail.simulateInboundReply({
      inboxId: INBOX,
      inReplyTo: w.sent.messageId,
      from: w.leadEmail,
      text: "Interested!",
    });
    inbound(w.mail, {
      messageId: "<tdm167-s@x>",
      from: "z@tdm167-x.example",
      text: "unsubscribe",
      timestamp: "2026-11-08T12:00:00.000Z",
    });
    await pollReplies({ agentmail: w.mail, inbox: INBOX, store: w.store });
    const f = await new MemoryFunnel(w.store).funnel();
    expect(f.stages).toEqual({
      sourced: 2,
      scouted: 1,
      fit: 1,
      drafted: 2,
      approved: 1,
      sent: 1,
      replied: 1,
      interested: 1,
      unsubscribed: 0, // the unsubscribe came from an address with no lead
    });
    expect(f.suppressions).toEqual({ total: 1, byReason: { unsubscribe: 1 } });
    expect(f.needsFounder).toBe(1);
    expect(f.spend.naiveScoutMicroUsd).toBe(3_557n);
    expect(f.spend.contextDevCredits).toBeNull();
    const text = formatFunnel(f, (m) => `$${m}`).join("\n");
    expect(text).toContain("interested    1");
    expect(text).toContain("Context.dev credits not recorded");
  });
});
