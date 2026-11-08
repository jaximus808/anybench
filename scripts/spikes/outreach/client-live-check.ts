// Free, read-only live check of the typed client in packages/outreach against real Monid:
// wallet balance, list-inboxes, list-messages, list-threads, threads/{id}. Every run uses maxCost 0.
import {
  createAgentMail,
  createMonidClient,
  isInboundReply,
} from "../../../packages/outreach/src/index.js";
import { key, record } from "./lib.js";

const INBOX = process.argv[2] ?? "anybench-outreach@agentmail.to";
const monid = createMonidClient({ apiKey: key("MONID_API_KEY"), spendCapMicroUsd: 0n });
const am = createAgentMail(monid);

const bal = await monid.balance();
const inboxes = await am.listInboxes();
const page = await am.listMessages({ inboxId: INBOX, limit: 10 });
const threads = await am.listThreads({ limit: 5 });
const first = threads.threads[0];
const thread = first ? await am.getThread(first.threadId) : undefined;
record("client-live-check", {
  balanceMicroUsd: bal.balanceMicroUsd.toString(),
  heldMicroUsd: bal.heldMicroUsd.toString(),
  inboxes,
  messages: page.messages.map((m) => ({
    id: m.messageId.slice(0, 24),
    threadId: m.threadId,
    labels: m.labels,
    inReplyTo: m.inReplyTo?.slice(0, 24),
    inbound: isInboundReply(m, INBOX),
  })),
  thread: thread && { threadId: thread.threadId, messageCount: thread.messageCount },
  spentMicroUsd: monid.spentMicroUsd().toString(),
});
