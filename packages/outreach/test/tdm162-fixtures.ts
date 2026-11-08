// Trimmed copies of live Monid responses from the TDM-162 spike (2026-11-08). No secrets.
export const INBOX = "anybench-outreach@agentmail.to";

export const createInboxRun = {
  runId: "01M6WBKDP23P5732YW3QPH8RYZ",
  provider: "agentmail",
  endpoint: "/create-inboxes",
  status: "COMPLETED",
  output: {
    inbox_id: INBOX,
    email: INBOX,
    display_name: "Anybench",
    updated_at: "2026-11-08T01:15:43.660Z",
    created_at: "2026-11-08T01:15:43.660Z",
  },
  providerResponse: { httpStatus: 200 },
  price: { type: "PER_CALL", amount: { value: 1, currency: "USD" } },
  billing: { reportedCost: { currency: "USD", value: 1000000, unit: "MICRO_DOLLAR" } },
  resultCount: 1,
  billedUnits: 1,
  resources: [
    {
      action: "PROVISIONED",
      resourceId: "01M6WBKGNHZT41QBKNYDD06SCD",
      resourceType: "email_inbox",
      identifier: INBOX,
    },
  ],
  createdAt: "2026-11-08T01:15:41.430Z",
  completedAt: "2026-11-08T01:15:44.484Z",
};

const ORIGINAL_ID =
  "<010001a1b8ba3a6e-973d751e-8df8-4c7a-8a23-7f5818b6e7f4-000000@email.amazonses.com>";
const REPLY_ID =
  "<010001a1b8badf23-52e0dbcd-d001-49bf-b2e2-2a53ee616b92-000000@email.amazonses.com>";
export const THREAD_ID = "650985e6-09eb-4057-9a6c-ce4272d15369";

export const sendRun = {
  runId: "01M6WBM0000000000000000000",
  provider: "agentmail",
  endpoint: "/send-messages",
  status: "COMPLETED",
  output: { message_id: ORIGINAL_ID, thread_id: THREAD_ID },
  providerResponse: { httpStatus: 200 },
  price: { type: "PER_RESULT", amount: { value: 0.001, currency: "USD" } },
  billing: { reportedCost: { currency: "USD", value: 1000, unit: "MICRO_DOLLAR" } },
  createdAt: "2026-11-08T01:16:14.274Z",
};

export const threadRun = {
  runId: "01M6WBN0000000000000000000",
  provider: "agentmail",
  endpoint: "/threads/{id}",
  status: "COMPLETED",
  output: {
    inbox_id: INBOX,
    thread_id: THREAD_ID,
    labels: ["sent", "outreach-spike", "received", "unread"],
    timestamp: "2026-11-08T01:16:56.764Z",
    senders: [`Anybench <${INBOX}>`],
    recipients: [INBOX],
    subject: "TDM-162 spike self-send 2026-11-08T01:16:13.358Z",
    last_message_id: REPLY_ID,
    message_count: 2,
    messages: [
      {
        inbox_id: INBOX,
        thread_id: THREAD_ID,
        message_id: ORIGINAL_ID,
        labels: ["sent", "outreach-spike", "received", "unread"],
        timestamp: "2026-11-08T01:16:14.778Z",
        from: `Anybench <${INBOX}>`,
        to: [INBOX],
        subject: "TDM-162 spike self-send 2026-11-08T01:16:13.358Z",
        headers: { "List-Unsubscribe": `<mailto:${INBOX}?subject=unsubscribe>` },
        text: "Plain-text body. Reply 'unsubscribe' to opt out.",
        html: "<div><p>HTML body.</p></div>",
        extracted_text: "Plain-text body. Reply 'unsubscribe' to opt out.",
      },
      {
        inbox_id: INBOX,
        thread_id: THREAD_ID,
        message_id: REPLY_ID,
        labels: ["sent", "received"],
        timestamp: "2026-11-08T01:16:56.764Z",
        from: `Anybench <${INBOX}>`,
        to: [`Anybench <${INBOX}>`],
        subject: "Re: TDM-162 spike self-send 2026-11-08T01:16:13.358Z",
        in_reply_to: ORIGINAL_ID,
        references: [ORIGINAL_ID],
        text: "This is a reply.\n\nOn Sun, Nov 8, 2026 ... wrote:\n> Plain-text body.",
        extracted_text: "This is a reply.",
      },
    ],
  },
  providerResponse: { httpStatus: 200 },
  price: { type: "PER_CALL", amount: { value: 0, currency: "USD" } },
  billing: { reportedCost: { currency: "USD", value: 0, unit: "MICRO_DOLLAR" } },
  createdAt: "2026-11-08T01:17:06.960Z",
};

export const inspectSend = {
  provider: "agentmail",
  providerName: "AgentMail",
  endpoint: "/send-messages",
  method: "POST",
  summary: "Send an email from one of YOUR inboxes.",
  input: { body: { type: "object", required: ["inboxId", "to"] } },
  price: {
    type: "PER_RESULT",
    amount: { value: 0.001, currency: "USD" },
    notes: ["One email per recipient — billed per address across to/cc/bcc."],
  },
};

export const balance = {
  balance: { value: 18.898, currency: "USD" },
  held: { value: 0.1, currency: "USD" },
  topup: { stripe: "/v1/wallet/topup/sessions" },
};

export const maxCostExceeded = {
  code: 400,
  message: "Estimated cost 1 exceeds maxCost 0.5",
  errorCode: "MAX_COST_EXCEEDED",
};

export const blockedRun = {
  runId: "01M6WBB0000000000000000000",
  status: "BLOCKED",
  provider: "agentmail",
  endpoint: "/send-messages",
  reason: "workspace budget exhausted",
  price: { type: "PER_RESULT", amount: { value: 0.001, currency: "USD" } },
  controls: [],
  createdAt: "2026-11-08T01:00:00.000Z",
  completedAt: "2026-11-08T01:00:00.000Z",
};
