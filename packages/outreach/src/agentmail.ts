// AgentMail through Monid (provider "agentmail"), paid from Monid credit; there is no separate
// AGENTMAIL_API_KEY. Shapes below are from live calls on 2026-11-08 (docs/findings/outreach-spike.md).
// Prices from POST /v1/inspect that day: create-inboxes $1 per call, send-messages and
// reply-messages $0.001 per recipient (to+cc+bcc), every read endpoint free.
//
// Inputs go in `input.body` for every agentmail endpoint, path params included
// (e.g. /threads/{id} takes { body: { threadId } }).

import { z } from "zod";
import type { MonidClient } from "./monid.js";
import type { MicroUsd } from "./money.js";

export const AGENTMAIL_PROVIDER = "agentmail";
export const AGENTMAIL_PRICES = {
  createInbox: 1_000_000n,
  perRecipient: 1_000n,
  read: 0n,
} as const satisfies Record<string, MicroUsd>;

// ---- schemas ------------------------------------------------------------------------------------

const Addresses = z.union([z.string().min(3), z.array(z.string().min(3)).min(1)]);

export const CreateInboxInputSchema = z.object({
  username: z.string().min(1).max(64).optional(),
  domain: z.string().min(3).max(255).optional(),
  displayName: z.string().min(1).max(120).optional(),
});
export type CreateInboxInput = z.input<typeof CreateInboxInputSchema>;

export const SendInputSchema = z
  .object({
    inboxId: z.string().min(3).max(320),
    to: Addresses,
    cc: Addresses.optional(),
    bcc: Addresses.optional(),
    replyTo: Addresses.optional(),
    subject: z.string().max(998),
    text: z.string().max(400_000).optional(),
    html: z.string().max(400_000).optional(),
    labels: z.array(z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .refine((v) => v.text !== undefined || v.html !== undefined, {
    message: "provide text, html, or both",
  });
export type SendInput = z.input<typeof SendInputSchema>;

export const ReplyInputSchema = z
  .object({
    inboxId: z.string().min(3).max(320),
    messageId: z.string().min(1).max(998),
    replyAll: z.boolean().optional(),
    cc: Addresses.optional(),
    bcc: Addresses.optional(),
    text: z.string().max(400_000).optional(),
    html: z.string().max(400_000).optional(),
    labels: z.array(z.string()).optional(),
  })
  .refine((v) => v.text !== undefined || v.html !== undefined, {
    message: "provide text, html, or both",
  });
export type ReplyInput = z.input<typeof ReplyInputSchema>;

export const ListMessagesInputSchema = z.object({
  inboxId: z.string().min(3).max(320),
  limit: z.number().int().positive().optional(),
  pageToken: z.string().min(1).optional(),
  labels: z.array(z.string()).min(1).optional(),
  before: z.iso.datetime({ offset: true }).optional(),
  after: z.iso.datetime({ offset: true }).optional(),
  ascending: z.boolean().optional(),
  from: z.array(z.string()).min(1).optional(),
  to: z.array(z.string()).min(1).optional(),
  subject: z.array(z.string()).min(1).optional(),
});
export type ListMessagesInput = z.input<typeof ListMessagesInputSchema>;

export const ListThreadsInputSchema = z.object({
  limit: z.number().int().positive().optional(),
  pageToken: z.string().min(1).optional(),
  labels: z.array(z.string().min(1)).optional(),
  before: z.string().min(1).optional(),
  after: z.string().min(1).optional(),
  ascending: z.boolean().optional(),
  senders: z.array(z.string().min(1)).optional(),
  recipients: z.array(z.string().min(1)).optional(),
  subject: z.array(z.string().min(1)).optional(),
});
export type ListThreadsInput = z.input<typeof ListThreadsInputSchema>;

const InboxWire = z.looseObject({
  inbox_id: z.string(),
  email: z.string().optional(),
  display_name: z.string().nullish(),
  created_at: z.string().optional(),
});
export interface Inbox {
  inboxId: string;
  email: string;
  displayName: string | undefined;
  createdAt: string | undefined;
}
const toInbox = (w: z.output<typeof InboxWire>): Inbox => ({
  inboxId: w.inbox_id,
  email: w.email ?? w.inbox_id,
  displayName: w.display_name ?? undefined,
  createdAt: w.created_at,
});

// /list-inboxes items come from Monid's resource table (resourceId, inboxId, state, displayName).
const InboxListItemWire = z.looseObject({
  inboxId: z.string().optional(),
  inbox_id: z.string().optional(),
  resourceId: z.string().optional(),
  state: z.string().optional(),
  displayName: z.string().nullish(),
  display_name: z.string().nullish(),
});
const ListInboxesWire = z.looseObject({
  count: z.number().int().optional(),
  inboxes: z.array(InboxListItemWire).default([]),
});

const SentWire = z.looseObject({ message_id: z.string(), thread_id: z.string() });
export interface SentMessage {
  messageId: string;
  threadId: string;
  costMicroUsd: MicroUsd;
}

export const MessageWireSchema = z.looseObject({
  inbox_id: z.string(),
  thread_id: z.string(),
  message_id: z.string(),
  labels: z.array(z.string()).default([]),
  timestamp: z.string(),
  from: z.string(),
  to: z.array(z.string()).default([]),
  cc: z.array(z.string()).optional(),
  subject: z.string().optional(),
  preview: z.string().optional(),
  text: z.string().optional(),
  html: z.string().optional(),
  extracted_text: z.string().optional(),
  in_reply_to: z.string().optional(),
  references: z.array(z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
});
export interface Message {
  inboxId: string;
  threadId: string;
  messageId: string;
  labels: string[];
  timestamp: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string | undefined;
  preview: string | undefined;
  /** Full body (thread and single-message reads only; list rows carry `preview`). */
  text: string | undefined;
  html: string | undefined;
  /** The new text of a reply without the quoted history (AgentMail's `extracted_text`). */
  extractedText: string | undefined;
  inReplyTo: string | undefined;
  references: string[];
  headers: Record<string, string>;
}
const toMessage = (w: z.output<typeof MessageWireSchema>): Message => ({
  inboxId: w.inbox_id,
  threadId: w.thread_id,
  messageId: w.message_id,
  labels: w.labels,
  timestamp: w.timestamp,
  from: w.from,
  to: w.to,
  cc: w.cc ?? [],
  subject: w.subject,
  preview: w.preview,
  text: w.text,
  html: w.html,
  extractedText: w.extracted_text,
  inReplyTo: w.in_reply_to,
  references: w.references ?? [],
  headers: w.headers ?? {},
});

const ListMessagesWire = z.looseObject({
  count: z.number().int().optional(),
  messages: z.array(MessageWireSchema).default([]),
  next_page_token: z.string().nullish(),
});
export interface MessagePage {
  messages: Message[];
  nextPageToken: string | undefined;
}

const ThreadSummaryWire = z.looseObject({
  inbox_id: z.string(),
  thread_id: z.string(),
  labels: z.array(z.string()).default([]),
  subject: z.string().optional(),
  senders: z.array(z.string()).default([]),
  recipients: z.array(z.string()).default([]),
  last_message_id: z.string().optional(),
  message_count: z.number().int().optional(),
  timestamp: z.string().optional(),
  received_timestamp: z.string().optional(),
  sent_timestamp: z.string().optional(),
});
export interface ThreadSummary {
  inboxId: string;
  threadId: string;
  labels: string[];
  subject: string | undefined;
  senders: string[];
  recipients: string[];
  lastMessageId: string | undefined;
  messageCount: number;
  updatedAt: string | undefined;
}
const toThreadSummary = (w: z.output<typeof ThreadSummaryWire>): ThreadSummary => ({
  inboxId: w.inbox_id,
  threadId: w.thread_id,
  labels: w.labels,
  subject: w.subject,
  senders: w.senders,
  recipients: w.recipients,
  lastMessageId: w.last_message_id,
  messageCount: w.message_count ?? 0,
  updatedAt: w.timestamp,
});
const ListThreadsWire = z.looseObject({
  threads: z.array(ThreadSummaryWire).default([]),
  next_page_token: z.string().nullish(),
});
const ThreadWire = ThreadSummaryWire.extend({ messages: z.array(MessageWireSchema).default([]) });
export interface Thread extends ThreadSummary {
  messages: Message[];
}

// ---- helpers ------------------------------------------------------------------------------------

/** CAN-SPAM opt-out for the hackathon cut: a mailto List-Unsubscribe back to our own inbox. */
export function listUnsubscribeHeaders(inboxAddress: string): Record<string, string> {
  return { "List-Unsubscribe": `<mailto:${inboxAddress}?subject=unsubscribe>` };
}

/** Number of billed recipients (send/reply bill per address across to/cc/bcc). */
export function recipientCount(...fields: (string | string[] | undefined)[]): number {
  return fields.reduce<number>(
    (n, f) => n + (f === undefined ? 0 : Array.isArray(f) ? f.length : 1),
    0,
  );
}

/** Bare address from `Name <addr>` or `addr`, lower-cased. */
export function bareAddress(s: string): string {
  const m = /<([^>]+)>/.exec(s);
  return (m?.[1] ?? s).trim().toLowerCase();
}

/**
 * True for a message someone else sent INTO our inbox (a lead's reply), as opposed to our own
 * outbound copy. Observed: AgentMail labels outbound mail "sent"; a self-send is ONE message with
 * both "sent" and "received", so the sender check is what actually separates the two.
 */
export function isInboundReply(m: Message, ourInbox: string): boolean {
  return m.labels.includes("received") && bareAddress(m.from) !== bareAddress(ourInbox);
}

// ---- client -------------------------------------------------------------------------------------

export interface AgentMail {
  createInbox(input?: CreateInboxInput): Promise<Inbox & { costMicroUsd: MicroUsd }>;
  listInboxes(): Promise<
    { inboxId: string; displayName: string | undefined; state: string | undefined }[]
  >;
  send(input: SendInput): Promise<SentMessage>;
  reply(input: ReplyInput): Promise<SentMessage>;
  listMessages(input: ListMessagesInput): Promise<MessagePage>;
  listThreads(
    input?: ListThreadsInput,
  ): Promise<{ threads: ThreadSummary[]; nextPageToken: string | undefined }>;
  getThread(threadId: string): Promise<Thread>;
  getMessage(inboxId: string, messageId: string): Promise<Message>;
}

export function createAgentMail(monid: MonidClient): AgentMail {
  const run = <T>(
    endpoint: string,
    body: unknown,
    maxCostMicroUsd: MicroUsd,
    schema: z.ZodType<T>,
  ) =>
    monid.run({ provider: AGENTMAIL_PROVIDER, endpoint, input: { body }, maxCostMicroUsd }, schema);

  return {
    async createInbox(input = {}) {
      const body = CreateInboxInputSchema.parse(input);
      const r = await run("/create-inboxes", body, AGENTMAIL_PRICES.createInbox, InboxWire);
      return { ...toInbox(r.output), costMicroUsd: r.costMicroUsd };
    },
    async listInboxes() {
      const r = await run("/list-inboxes", {}, 0n, ListInboxesWire);
      return r.output.inboxes.map((i) => ({
        inboxId: i.inboxId ?? i.inbox_id ?? "",
        displayName: i.displayName ?? i.display_name ?? undefined,
        state: i.state,
      }));
    },
    async send(input) {
      const body = SendInputSchema.parse(input);
      const n = BigInt(recipientCount(body.to, body.cc, body.bcc));
      const r = await run("/send-messages", body, AGENTMAIL_PRICES.perRecipient * n, SentWire);
      return {
        messageId: r.output.message_id,
        threadId: r.output.thread_id,
        costMicroUsd: r.costMicroUsd,
      };
    },
    async reply(input) {
      const body = ReplyInputSchema.parse(input);
      // Unknown original recipient count under replyAll: budget for a small thread.
      const base = body.replyAll ? 5 : 1;
      const n = BigInt(base + recipientCount(body.cc, body.bcc));
      const r = await run(
        "/reply-messages/{id}",
        body,
        AGENTMAIL_PRICES.perRecipient * n,
        SentWire,
      );
      return {
        messageId: r.output.message_id,
        threadId: r.output.thread_id,
        costMicroUsd: r.costMicroUsd,
      };
    },
    async listMessages(input) {
      const body = ListMessagesInputSchema.parse(input);
      const r = await run("/list-messages", body, 0n, ListMessagesWire);
      return {
        messages: r.output.messages.map(toMessage),
        nextPageToken: r.output.next_page_token ?? undefined,
      };
    },
    async listThreads(input = {}) {
      const body = ListThreadsInputSchema.parse(input);
      const r = await run("/list-threads", body, 0n, ListThreadsWire);
      return {
        threads: r.output.threads.map(toThreadSummary),
        nextPageToken: r.output.next_page_token ?? undefined,
      };
    },
    async getThread(threadId) {
      const id = z.string().min(1).parse(threadId);
      const r = await run("/threads/{id}", { threadId: id }, 0n, ThreadWire);
      return { ...toThreadSummary(r.output), messages: r.output.messages.map(toMessage) };
    },
    async getMessage(inboxId, messageId) {
      const r = await run("/messages/{id}", { inboxId, messageId }, 0n, MessageWireSchema);
      return toMessage(r.output);
    },
  };
}
