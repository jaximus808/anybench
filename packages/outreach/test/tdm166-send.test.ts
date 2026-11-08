// TDM-166 [15.6a]: sending approved drafts. FakeAgentMail + an in-memory SendStore, no network.
import { describe, expect, it } from "vitest";
import { FakeAgentMail } from "../src/fake.js";
import {
  MonidError,
  runSend,
  SendConfigError,
  sendSelfTest,
  type ClaimResult,
  type QueueItem,
  type SendStore,
} from "../src/index.js";

const INBOX = "anybench-outreach@agentmail.to";
const POSTAL = "548 Market St, San Francisco, CA 94104";
const TEXT = `Hi team,\n\nHello.\n\nhttps://anybench.vercel.app\n\n--\nReply "unsubscribe" and we won't email you again.\nAnybench, ${POSTAL}\n`;

function item(n: number, over: Partial<QueueItem> = {}): QueueItem {
  return {
    id: `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`,
    leadId: `lead-${n}`,
    status: "approved",
    subject: `an independent benchmark of p${n}?`,
    text: TEXT,
    html: "<p>hi</p>",
    approvedBy: "Jaxon",
    sentAt: null,
    agentmailMessageId: null,
    createdAt: "2026-11-08T00:00:00Z",
    email: `p${n}@example.dev`,
    company: null,
    githubUrl: null,
    source: "public_contact",
    signals: {},
    brief: null,
    ...over,
  };
}

class MemSend implements SendStore {
  sent: { id: string; mid: string }[] = [];
  claimed = new Set<string>();
  released: string[] = [];
  constructor(
    public items: QueueItem[],
    public today = 0,
    public suppressed = new Set<string>(),
  ) {}
  async sendable(limit: number) {
    return this.items.filter((i) => !this.claimed.has(i.id)).slice(0, limit);
  }
  async sentToday() {
    return this.today;
  }
  async claim(id: string, dailyLimit: number): Promise<ClaimResult> {
    const it = this.items.find((i) => i.id === id)!;
    if (this.suppressed.has(it.email!)) return "suppressed";
    if (this.today >= dailyLimit) return "daily_limit";
    this.claimed.add(id);
    this.today++;
    return "claimed";
  }
  async markSent(id: string, mid: string) {
    this.sent.push({ id, mid });
  }
  async release(id: string) {
    this.claimed.delete(id);
    this.today--;
    this.released.push(id);
  }
}

async function mailbox() {
  const m = new FakeAgentMail();
  await m.createInbox({ username: "anybench-outreach" });
  return m;
}

describe("runSend (TDM-166)", () => {
  it("is a dry run unless send is true, and the dry run respects the daily limit", async () => {
    const mail = await mailbox();
    const store = new MemSend([item(1), item(2), item(3)], 23);
    const r = await runSend({
      store,
      agentmail: mail,
      inbox: INBOX,
      postalAddress: POSTAL,
      dailyLimit: 25,
    });
    expect(r.dryRun).toBe(true);
    expect(r.results.map((x) => x.outcome)).toEqual(["would_send", "would_send", "daily_limit"]);
    expect(mail.messages).toHaveLength(0);
  });

  it("sends with List-Unsubscribe, records the message id, stops at the limit, skips suppressed and lint failures", async () => {
    const mail = await mailbox();
    const store = new MemSend(
      [item(1), item(2, { text: TEXT.replace(POSTAL, "") }), item(3), item(4), item(5)],
      0,
      new Set(["p3@example.dev"]),
    );
    const r = await runSend({
      store,
      agentmail: mail,
      inbox: INBOX,
      postalAddress: POSTAL,
      dailyLimit: 2,
      limit: 10,
      send: true,
    });
    expect(r.results.map((x) => x.outcome)).toEqual([
      "sent",
      "lint_failed",
      "suppressed",
      "sent",
      "daily_limit",
    ]);
    expect(store.sent.map((s) => s.id)).toEqual([item(1).id, item(4).id]);
    const first = mail.messages.find((m) => m.to.includes("p1@example.dev"))!;
    expect(first.headers?.["List-Unsubscribe"]).toBe(`<mailto:${INBOX}?subject=unsubscribe>`);
    expect(r.spentMicroUsd).toBe(2_000n);
  });

  it("refuses with no postal address; releases a send Monid says never ran; stops on an unknown failure", async () => {
    const store = new MemSend([item(1)]);
    await expect(runSend({ store, inbox: INBOX, postalAddress: " ", send: false })).rejects.toThrow(
      SendConfigError,
    );
    const failing = (err: Error) =>
      ({ ...new FakeAgentMail(), send: async () => Promise.reject(err) }) as never;
    const s1 = new MemSend([item(1), item(2)]);
    const r1 = await runSend({
      store: s1,
      agentmail: failing(new MonidError("cap", "SPEND_CAP")),
      inbox: INBOX,
      postalAddress: POSTAL,
      send: true,
    });
    expect(r1.results[0]!.outcome).toBe("failed_released");
    expect(s1.released).toContain(item(1).id);
    const s2 = new MemSend([item(1), item(2)]);
    const r2 = await runSend({
      store: s2,
      agentmail: failing(new MonidError("net", "TRANSPORT_ERROR")),
      inbox: INBOX,
      postalAddress: POSTAL,
      send: true,
    });
    expect(r2.results.map((x) => x.outcome)).toEqual(["failed_unknown"]);
    expect(s2.released).toEqual([]);
  });

  it("self-test only ever goes to our own inbox", async () => {
    const mail = await mailbox();
    const r = await sendSelfTest({ agentmail: mail, inbox: INBOX, item: item(1) });
    expect(r.to).toBe(INBOX);
    expect(mail.messages.every((m) => m.to.every((t) => t === INBOX))).toBe(true);
    expect(mail.messages[0]!.subject?.startsWith("[self-test]")).toBe(true);
  });
});
