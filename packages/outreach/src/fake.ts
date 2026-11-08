// FakeAgentMail: the AgentMail interface in memory, for offline tests of sending (15.6a) and reply
// polling (15.8a). It mirrors what the live spike observed (docs/findings/outreach-spike.md):
//   - outbound mail is labelled "sent" (+ caller labels) in the sender's inbox;
//   - mail to an inbox this workspace owns is also delivered there, labelled "received"+"unread";
//     a self-send is ONE message carrying both "sent" and "received";
//   - a reply keeps the thread_id and sets in_reply_to/references to the parent message_id;
//   - list-messages is newest first.
// Costs follow AGENTMAIL_PRICES (micro-USD), so spend assertions in tests match production.

import {
  AGENTMAIL_PRICES,
  CreateInboxInputSchema,
  ListMessagesInputSchema,
  ReplyInputSchema,
  SendInputSchema,
  bareAddress,
  recipientCount,
  type AgentMail,
  type Inbox,
  type Message,
  type Thread,
  type ThreadSummary,
} from "./agentmail.js";
import type { MicroUsd } from "./money.js";

const asList = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

export class FakeAgentMail implements AgentMail {
  readonly inboxes = new Map<string, Inbox>();
  /** Every stored message across inboxes (a delivered copy per owned recipient inbox). */
  readonly messages: Message[] = [];
  spentMicroUsd: MicroUsd = 0n;
  private seq = 0;
  private clock: () => Date;

  constructor(opts: { now?: () => Date } = {}) {
    this.clock = opts.now ?? (() => new Date(Date.UTC(2026, 10, 8, 9, 0, 0) + this.seq * 1000));
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${String(this.seq).padStart(4, "0")}`;
  }

  async createInbox(input: Parameters<AgentMail["createInbox"]>[0] = {}) {
    const body = CreateInboxInputSchema.parse(input);
    const address = `${body.username ?? this.nextId("inbox")}@${body.domain ?? "agentmail.to"}`;
    if (this.inboxes.has(address)) throw new Error(`already_exists: ${address}`);
    const inbox: Inbox = {
      inboxId: address,
      email: address,
      displayName: body.displayName,
      createdAt: this.clock().toISOString(),
    };
    this.inboxes.set(address, inbox);
    this.spentMicroUsd += AGENTMAIL_PRICES.createInbox;
    return { ...inbox, costMicroUsd: AGENTMAIL_PRICES.createInbox };
  }

  async listInboxes() {
    return [...this.inboxes.values()].map((i) => ({
      inboxId: i.inboxId,
      displayName: i.displayName,
      state: "ACTIVE",
    }));
  }

  private requireInbox(inboxId: string): Inbox {
    const inbox = this.inboxes.get(inboxId);
    if (!inbox) throw new Error(`not_found: inbox ${inboxId} is not owned by this workspace`);
    return inbox;
  }

  private deliver(args: {
    from: Inbox | string;
    to: string[];
    cc: string[];
    subject: string | undefined;
    text: string | undefined;
    html: string | undefined;
    labels: string[];
    headers: Record<string, string>;
    threadId: string;
    inReplyTo?: string | undefined;
    references?: string[];
  }): Message {
    const messageId = `<${this.nextId("msg")}@fake.agentmail>`;
    const timestamp = this.clock().toISOString();
    const fromStr =
      typeof args.from === "string"
        ? args.from
        : args.from.displayName
          ? `${args.from.displayName} <${args.from.inboxId}>`
          : args.from.inboxId;
    const base = {
      threadId: args.threadId,
      messageId,
      timestamp,
      from: fromStr,
      to: args.to,
      cc: args.cc,
      subject: args.subject,
      preview: (args.text ?? "").slice(0, 200),
      text: args.text,
      html: args.html,
      extractedText: args.text,
      inReplyTo: args.inReplyTo,
      references: args.references ?? [],
      headers: args.headers,
    };
    const senderInbox = typeof args.from === "string" ? undefined : args.from.inboxId;
    const owned = [...args.to, ...args.cc].map(bareAddress).filter((a) => this.inboxes.has(a));
    let first: Message | undefined;
    if (senderInbox) {
      const selfDelivered = owned.includes(senderInbox);
      first = {
        ...base,
        inboxId: senderInbox,
        labels: ["sent", ...args.labels, ...(selfDelivered ? ["received", "unread"] : [])],
      };
      this.messages.push(first);
    }
    for (const inboxId of new Set(owned)) {
      if (inboxId === senderInbox) continue;
      const copy: Message = { ...base, inboxId, labels: ["received", "unread"] };
      this.messages.push(copy);
      first ??= copy;
    }
    if (!first) throw new Error("fake: inbound mail must target an owned inbox");
    return first;
  }

  async send(input: Parameters<AgentMail["send"]>[0]) {
    const body = SendInputSchema.parse(input);
    const inbox = this.requireInbox(body.inboxId);
    const cost = AGENTMAIL_PRICES.perRecipient * BigInt(recipientCount(body.to, body.cc, body.bcc));
    const m = this.deliver({
      from: inbox,
      to: asList(body.to),
      cc: asList(body.cc),
      subject: body.subject,
      text: body.text,
      html: body.html,
      labels: body.labels ?? [],
      headers: body.headers ?? {},
      threadId: this.nextId("thread"),
    });
    this.spentMicroUsd += cost;
    return { messageId: m.messageId, threadId: m.threadId, costMicroUsd: cost };
  }

  async reply(input: Parameters<AgentMail["reply"]>[0]) {
    const body = ReplyInputSchema.parse(input);
    const inbox = this.requireInbox(body.inboxId);
    const parent = this.messages.find(
      (m) => m.inboxId === body.inboxId && m.messageId === body.messageId,
    );
    if (!parent) throw new Error(`not_found: message ${body.messageId}`);
    const to = [parent.from];
    const cost = AGENTMAIL_PRICES.perRecipient * BigInt(1 + recipientCount(body.cc, body.bcc));
    const m = this.deliver({
      from: inbox,
      to,
      cc: asList(body.cc),
      subject: parent.subject?.startsWith("Re:") ? parent.subject : `Re: ${parent.subject ?? ""}`,
      text: body.text,
      html: body.html,
      labels: body.labels ?? [],
      headers: {},
      threadId: parent.threadId,
      inReplyTo: parent.messageId,
      references: [...parent.references, parent.messageId],
    });
    this.spentMicroUsd += cost;
    return { messageId: m.messageId, threadId: m.threadId, costMicroUsd: cost };
  }

  /** Test hook: an outside sender (a lead) replies to one of our messages. Free, like real inbound mail. */
  simulateInboundReply(args: {
    inboxId: string;
    inReplyTo: string;
    from: string;
    text: string;
  }): Message {
    const inbox = this.requireInbox(args.inboxId);
    const parent = this.messages.find(
      (m) => m.inboxId === inbox.inboxId && m.messageId === args.inReplyTo,
    );
    if (!parent) throw new Error(`not_found: message ${args.inReplyTo}`);
    return this.deliver({
      from: args.from,
      to: [inbox.inboxId],
      cc: [],
      subject: `Re: ${parent.subject ?? ""}`,
      text: args.text,
      html: undefined,
      labels: [],
      headers: {},
      threadId: parent.threadId,
      inReplyTo: parent.messageId,
      references: [...parent.references, parent.messageId],
    });
  }

  async listMessages(input: Parameters<AgentMail["listMessages"]>[0]) {
    const q = ListMessagesInputSchema.parse(input);
    let rows = this.messages.filter((m) => m.inboxId === q.inboxId);
    if (q.labels) rows = rows.filter((m) => q.labels!.every((l) => m.labels.includes(l)));
    if (q.after) rows = rows.filter((m) => m.timestamp > q.after!);
    if (q.before) rows = rows.filter((m) => m.timestamp < q.before!);
    rows.sort((a, b) => (q.ascending ? 1 : -1) * a.timestamp.localeCompare(b.timestamp));
    const start = q.pageToken ? Number(q.pageToken) : 0;
    const limit = q.limit ?? 50;
    const page = rows.slice(start, start + limit);
    // List rows carry a preview, not the full body (as the live API does).
    const stripped = page.map(({ text: _t, html: _h, extractedText: _e, ...rest }) => ({
      ...rest,
      text: undefined,
      html: undefined,
      extractedText: undefined,
    }));
    return {
      messages: stripped,
      nextPageToken: start + limit < rows.length ? String(start + limit) : undefined,
    };
  }

  private summary(threadId: string): Thread {
    const msgs = this.messages
      .filter((m) => m.threadId === threadId)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const first = msgs[0];
    if (!first) throw new Error(`not_found: thread ${threadId}`);
    const last = msgs[msgs.length - 1]!;
    return {
      inboxId: first.inboxId,
      threadId,
      labels: [...new Set(msgs.flatMap((m) => m.labels))],
      subject: first.subject,
      senders: [...new Set(msgs.map((m) => m.from))],
      recipients: [...new Set(msgs.flatMap((m) => m.to))],
      lastMessageId: last.messageId,
      messageCount: new Set(msgs.map((m) => m.messageId)).size,
      updatedAt: last.timestamp,
      messages: msgs,
    };
  }

  async listThreads() {
    const ids = [...new Set(this.messages.map((m) => m.threadId))];
    const threads: ThreadSummary[] = ids
      .map((id) => {
        const { messages: _m, ...s } = this.summary(id);
        return s;
      })
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return { threads, nextPageToken: undefined };
  }

  async getThread(threadId: string) {
    return this.summary(threadId);
  }

  async getMessage(inboxId: string, messageId: string) {
    const m = this.messages.find((x) => x.inboxId === inboxId && x.messageId === messageId);
    if (!m) throw new Error(`not_found: message ${messageId}`);
    return m;
  }
}
