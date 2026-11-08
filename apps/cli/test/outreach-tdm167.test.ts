// TDM-167 [15.8a]: `anybench outreach poll` and `outreach stats` with injected fakes (no network).
import { ACCOUNT_MANAGER_CATEGORIES, ACCOUNT_MANAGER_ROLE } from "@anybench/agents";
import { FakeNaive } from "@anybench/naive";
import {
  FakeAgentMail,
  MemoryFunnel,
  MemoryReplyStore,
  REPLY_CATEGORIES,
} from "@anybench/outreach";
import { describe, expect, it } from "vitest";
import { runOutreach } from "../src/commands/outreach.js";

const INBOX = "anybench-outreach@agentmail.to";
const LEAD = "dev@tdm167-cli.example";

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };
}

async function setup() {
  const mail = new FakeAgentMail();
  await mail.createInbox({ username: "anybench-outreach" });
  const sent = await mail.send({ inboxId: INBOX, to: LEAD, subject: "hi", text: "hello" });
  const store = new MemoryReplyStore({
    leads: [{ id: "tdm167-cli-lead", email: LEAD, status: "scored", brief: { status: "scored" } }],
    messages: [
      {
        id: "tdm167-cli-msg",
        leadId: "tdm167-cli-lead",
        kind: "initial",
        status: "sent",
        agentmailMessageId: sent.messageId,
        approvedBy: "founder",
        sentAt: "2026-11-08T09:00:00.000Z",
      },
    ],
  });
  const openReplyDb = async () => ({
    replies: store,
    funnel: new MemoryFunnel(store),
    close: async () => {},
  });
  return { mail, sent, store, openReplyDb };
}

describe("anybench outreach poll / stats (TDM-167)", () => {
  it("the account manager and the poller agree on the categories", () => {
    expect([...ACCOUNT_MANAGER_CATEGORIES]).toEqual([...REPLY_CATEGORIES]);
  });

  it("poll: rules, model fallback on FakeNaive, suppression, founder queue; then stats", async () => {
    const s = await setup();
    s.mail.simulateInboundReply({
      inboxId: INBOX,
      inReplyTo: s.sent.messageId,
      from: LEAD,
      text: "Hm, forwarding to my cofounder.",
    });
    s.mail.simulateInboundReply({
      inboxId: INBOX,
      inReplyTo: s.sent.messageId,
      from: LEAD,
      text: "Actually: unsubscribe",
    });
    const naive = new FakeNaive();
    naive.script(ACCOUNT_MANAGER_ROLE, {
      output: { category: "question", reason: "forwards" },
      costMicroUsd: 2_500n,
    });
    const posts: string[] = [];
    const t = io();
    const code = await runOutreach(["poll"], {
      ...t,
      env: { SLACK_WEBHOOK_URL: "https://hooks.slack.example/tdm167" },
      agentmail: s.mail,
      naive,
      openReplyDb: s.openReplyDb,
      fetch: async (_u, init) => {
        posts.push(String(init?.body));
        return new Response("ok");
      },
    });
    expect(t.err.join("\n")).not.toContain("outreach poll:");
    expect(code).toBe(0);
    const text = t.out.join("\n");
    expect(text).toContain("2 new");
    expect(text).toContain("question 1");
    expect(text).toContain("unsubscribe 1");
    expect(text).toContain(`suppressed 1: ${LEAD}`);
    expect(text).toContain("needs founder 1 (nothing was answered automatically)");
    expect(text).toContain("spent: $0.0025 Naïve (2500 micro-USD)");
    expect(posts).toEqual([]); // no interested reply → no Slack post
    expect(s.store.suppressions.get(LEAD)).toBe("unsubscribe");
    // The CLI never sent anything: still the one original send.
    expect(s.mail.messages.filter((m) => m.labels.includes("sent"))).toHaveLength(1);

    const st = io();
    expect(await runOutreach(["stats"], { ...st, openReplyDb: s.openReplyDb })).toBe(0);
    const stats = st.out.join("\n");
    expect(stats).toMatch(/sourced\s+1/);
    expect(stats).toMatch(/sent\s+1/);
    expect(stats).toMatch(/replied\s+1/);
    expect(stats).toMatch(/interested\s+0/);
    expect(stats).toMatch(/unsubscribed\s+1/);
    expect(stats).toContain("suppressions: 1 (unsubscribe 1)");
    expect(stats).toContain("replies 2500");
  });

  it("poll --no-model without Monid key fails cleanly; bad caps are usage errors", async () => {
    const t = io();
    expect(
      await runOutreach(["poll"], { ...t, env: {}, openReplyDb: (await setup()).openReplyDb }),
    ).toBe(1);
    expect(t.err.join("\n")).toContain("MONID_API_KEY is not set");
    const u = io();
    expect(await runOutreach(["poll", "--model-cap-micro-usd", "0.2"], { ...u, env: {} })).toBe(2);
  });

  it("replies is an alias; --dry-run writes nothing", async () => {
    const s = await setup();
    s.mail.simulateInboundReply({
      inboxId: INBOX,
      inReplyTo: s.sent.messageId,
      from: LEAD,
      text: "stop",
    });
    const t = io();
    expect(
      await runOutreach(["replies", "--dry-run", "--no-model", "--json"], {
        ...t,
        env: {},
        agentmail: s.mail,
        openReplyDb: s.openReplyDb,
      }),
    ).toBe(0);
    const j = JSON.parse(t.out.join("\n"));
    expect(j.dryRun).toBe(true);
    expect(j.replies[0].category).toBe("unsubscribe");
    expect(s.store.replies).toHaveLength(0);
    expect(s.store.suppressions.size).toBe(0);
  });
});
