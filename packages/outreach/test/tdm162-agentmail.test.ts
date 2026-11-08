import { describe, expect, it } from "vitest";
import {
  createAgentMail,
  isInboundReply,
  listUnsubscribeHeaders,
  recipientCount,
} from "../src/agentmail.js";
import { createMonidClient } from "../src/monid.js";
import { FakeAgentMail } from "../src/fake.js";
import { scriptedFetch } from "./tdm162-fake-fetch.js";
import * as fx from "./tdm162-fixtures.js";

function mail(responses: { status: number; body: unknown }[]) {
  const f = scriptedFetch(responses);
  const monid = createMonidClient({ apiKey: "monid_live_test", fetch: f.fetchFn });
  return { am: createAgentMail(monid), calls: f.calls, monid };
}

describe("AgentMail via Monid", () => {
  it("createInbox budgets $1 and maps the address", async () => {
    const { am, calls } = mail([{ status: 200, body: fx.createInboxRun }]);
    const inbox = await am.createInbox({ username: "anybench-outreach", displayName: "Anybench" });
    expect(inbox).toMatchObject({ inboxId: fx.INBOX, email: fx.INBOX, costMicroUsd: 1_000_000n });
    expect(calls[0]!.body).toMatchObject({
      provider: "agentmail",
      endpoint: "/create-inboxes",
      input: { body: { username: "anybench-outreach", displayName: "Anybench" } },
      maxCost: 1,
    });
  });

  it("send budgets $0.001 per recipient and passes List-Unsubscribe through", async () => {
    const { am, calls } = mail([{ status: 200, body: fx.sendRun }]);
    const sent = await am.send({
      inboxId: fx.INBOX,
      to: ["a@example.com", "b@example.com"],
      cc: "c@example.com",
      subject: "hi",
      text: "t",
      html: "<p>t</p>",
      headers: listUnsubscribeHeaders(fx.INBOX),
    });
    expect(sent).toEqual({
      messageId: fx.sendRun.output.message_id,
      threadId: fx.THREAD_ID,
      costMicroUsd: 1_000n,
    });
    const body = calls[0]!.body as { maxCost: number; input: { body: { headers: object } } };
    expect(body.maxCost).toBe(0.003);
    expect(body.input.body.headers).toEqual({
      "List-Unsubscribe": `<mailto:${fx.INBOX}?subject=unsubscribe>`,
    });
  });

  it("send without a body is refused before any network call", async () => {
    const { am, calls } = mail([]);
    await expect(
      am.send({ inboxId: fx.INBOX, to: "a@example.com", subject: "x" }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("getThread maps the live thread shape; reads are free (maxCost 0)", async () => {
    const { am, calls } = mail([{ status: 200, body: fx.threadRun }]);
    const t = await am.getThread(fx.THREAD_ID);
    expect(calls[0]!.body).toMatchObject({
      endpoint: "/threads/{id}",
      input: { body: { threadId: fx.THREAD_ID } },
      maxCost: 0,
    });
    expect(t.messageCount).toBe(2);
    expect(t.messages[1]!.inReplyTo).toBe(t.messages[0]!.messageId);
    expect(t.messages[1]!.extractedText).toBe("This is a reply.");
    expect(t.messages[0]!.headers["List-Unsubscribe"]).toContain("mailto:");
    // A self-send is labelled sent+received but is NOT an inbound reply.
    expect(t.messages.some((m) => isInboundReply(m, fx.INBOX))).toBe(false);
  });

  it("recipientCount counts every address", () => {
    expect(recipientCount("a", ["b", "c"], undefined)).toBe(3);
  });
});

describe("FakeAgentMail", () => {
  it("self-send is one message labelled sent+received; a lead's reply threads and is detected", async () => {
    const fake = new FakeAgentMail();
    const inbox = await fake.createInbox({
      username: "anybench-outreach",
      displayName: "Anybench",
    });
    const sent = await fake.send({
      inboxId: inbox.inboxId,
      to: "lead@example.com",
      subject: "Your benchmark claim",
      text: "hello",
      headers: listUnsubscribeHeaders(inbox.inboxId),
    });
    expect(fake.spentMicroUsd).toBe(1_001_000n);

    const reply = fake.simulateInboundReply({
      inboxId: inbox.inboxId,
      inReplyTo: sent.messageId,
      from: "Lead <lead@example.com>",
      text: "sounds good, run it",
    });
    expect(reply.threadId).toBe(sent.threadId);

    const page = await fake.listMessages({ inboxId: inbox.inboxId, labels: ["received"] });
    const inbound = page.messages.filter((m) => isInboundReply(m, inbox.inboxId));
    expect(inbound).toHaveLength(1);
    expect(inbound[0]!.inReplyTo).toBe(sent.messageId);
    expect(inbound[0]!.text).toBeUndefined(); // list rows carry previews only

    const thread = await fake.getThread(sent.threadId);
    expect(thread.messageCount).toBe(2);

    const self = await fake.send({
      inboxId: inbox.inboxId,
      to: inbox.inboxId,
      subject: "s",
      text: "t",
    });
    const selfMsg = await fake.getMessage(inbox.inboxId, self.messageId);
    expect(selfMsg.labels).toEqual(expect.arrayContaining(["sent", "received"]));
    expect(isInboundReply(selfMsg, inbox.inboxId)).toBe(false);

    await fake.reply({ inboxId: inbox.inboxId, messageId: reply.messageId, text: "on it" });
    const t2 = await fake.getThread(sent.threadId);
    expect(t2.messageCount).toBe(3);
    expect(t2.messages[2]!.inReplyTo).toBe(reply.messageId);
  });
});
