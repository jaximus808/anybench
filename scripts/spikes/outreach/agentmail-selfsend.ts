// Step 2: self-send from the outreach inbox to itself (never a third party), then read it back with
// /list-messages, /list-threads and /threads/{id}, then reply to it to show how a reply threads.
// Cost: 2 sends x $0.001 (send-messages and reply-messages bill per recipient).
import { monidGet, monidRun } from "./lib.js";

const INBOX = process.argv[2] ?? "anybench-outreach@agentmail.to";
const stamp = new Date().toISOString();
const before = await monidGet("/v1/wallet/balance");

const sent = await monidRun(
  "agentmail",
  "/send-messages",
  {
    body: {
      inboxId: INBOX,
      to: INBOX,
      subject: `TDM-162 spike self-send ${stamp}`,
      text: "Plain-text body. Reply 'unsubscribe' to opt out.\n\nAnybench, <postal address>",
      html: "<p>HTML body. Reply <b>unsubscribe</b> to opt out.</p><p>Anybench, &lt;postal address&gt;</p>",
      headers: {
        "List-Unsubscribe": `<mailto:${INBOX}?subject=unsubscribe>`,
      },
      labels: ["outreach-spike"],
    },
  },
  0.002,
);
const messageId: string = sent.body?.output?.message_id;
const threadId: string = sent.body?.output?.thread_id;
console.log("sent", { messageId, threadId });

// Delivery to the same inbox is async; poll list-messages (free) a few times.
for (let i = 0; i < 6; i++) {
  await new Promise((r) => setTimeout(r, 4000));
  const msgs = await monidRun(
    "agentmail",
    "/list-messages",
    { body: { inboxId: INBOX, limit: 10 } },
    0,
  );
  const n = (msgs.body?.output?.messages ?? []).length;
  console.log("list-messages count", n);
  if (n >= 2) break; // the sent copy + the received copy
}

await monidRun("agentmail", "/list-threads", { body: { limit: 5 } }, 0);
await monidRun("agentmail", "/threads/{id}", { body: { threadId } }, 0);

// Reply to the received copy (goes back to the original sender = this inbox).
const msgs = await monidRun(
  "agentmail",
  "/list-messages",
  { body: { inboxId: INBOX, limit: 10, labels: ["received"] } },
  0,
);
const received = (msgs.body?.output?.messages ?? [])[0];
if (received) {
  await monidRun(
    "agentmail",
    "/reply-messages/{id}",
    {
      body: {
        inboxId: INBOX,
        messageId: received.message_id,
        text: "This is a reply. Polling should see it on the same thread_id.",
      },
    },
    0.002,
  );
  await new Promise((r) => setTimeout(r, 8000));
  await monidRun("agentmail", "/threads/{id}", { body: { threadId } }, 0);
  await monidRun("agentmail", "/list-messages", { body: { inboxId: INBOX, limit: 10 } }, 0);
}
const after = await monidGet("/v1/wallet/balance");
console.log("balance before", before?.balance, "after", after?.balance);
