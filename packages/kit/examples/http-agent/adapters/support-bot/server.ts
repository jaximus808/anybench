// Stub support agent for the http-agent example kit (TDM-40 [4.8]). No dependencies: run with
// `node --experimental-strip-types server.ts` (Node >= 22.6; plain `node` on Node >= 23.6).
//
//   POST /chat   {conversation_id, messages: [{role, content}]}
//             -> {reply, session_id, tool_calls: [{name, args}], outcome, usage}
//   GET  /health -> {ok: true}
//
// Env:
//   PORT                  listen port; 0 (default) picks a free one
//   STUB_AGENT_PORT_FILE  when set, the bound port is written here once listening
//   STUB_AGENT_MODE       correct (default) | oracle (same answers) | canned (do-less: one fixed reply)
//   STUB_AGENT_DELAY_MS   extra delay before every reply (the planted regression)
//
// It answers from a fixed order table with plain rules, so the right answers are known exactly.
import { writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

interface Order {
  item: string;
  status: "shipped" | "in transit" | "delivered";
  eta?: string;
  location?: string;
  deliveredDaysAgo?: number;
}

const ORDERS: Record<string, Order> = {
  "1042": { item: "Widget Pro", status: "shipped", eta: "2026-11-12" },
  "1077": { item: "Gadget Mini", status: "delivered", deliveredDaysAgo: 10 },
  "2001": { item: "Widget Pro", status: "in transit", location: "Denver hub", eta: "2026-11-10" },
  "3003": { item: "Gadget Mini", status: "delivered", deliveredDaysAgo: 45 },
};

/** Unit prices in integer cents. */
const PRICES_CENTS: Record<string, number> = { "widget pro": 1999, "gadget mini": 899 };
const REFUND_WINDOW_DAYS = 30;
const CANNED_REPLY =
  "Thanks for contacting support! We have received your message and will get back to you shortly.";

interface Message {
  role: string;
  content: string;
}
interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}
interface Answer {
  reply: string;
  tool_calls: ToolCall[];
  outcome?: string;
}

const dollars = (cents: number) =>
  `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;

function orderIdIn(text: string): string | undefined {
  return /\b(\d{4})\b/.exec(text)?.[1];
}

function answer(messages: Message[]): Answer {
  const userTurns = messages.filter((m) => m.role === "user");
  const last = userTurns[userTurns.length - 1]?.content ?? "";
  const text = last.toLowerCase();
  // The order in this message, else the latest one mentioned earlier in the conversation.
  let orderId = orderIdIn(last);
  for (let i = userTurns.length - 2; orderId === undefined && i >= 0; i--)
    orderId = orderIdIn(userTurns[i]?.content ?? "");

  const quote = /how much|price|cost/.test(text);
  if (quote) {
    const qty = Number(/\b(\d{1,3})\b/.exec(text)?.[1] ?? "1");
    const product = Object.keys(PRICES_CENTS).find((p) => text.includes(p));
    if (product === undefined)
      return { reply: "Which product would you like a price for?", tool_calls: [] };
    const unit = PRICES_CENTS[product] as number;
    const name = product.replace(/\b\w/g, (c) => c.toUpperCase());
    return {
      reply: `${qty} x ${name} at ${dollars(unit)} each comes to ${dollars(unit * qty)}.`,
      tool_calls: [{ name: "price_lookup", args: { product: name, quantity: qty } }],
      outcome: "resolved",
    };
  }

  if (orderId === undefined) {
    if (/thank/.test(text))
      return { reply: "You're welcome!", tool_calls: [], outcome: "resolved" };
    return { reply: "Sure, I can help. What is your order number?", tool_calls: [] };
  }
  const order = ORDERS[orderId];
  const lookup: ToolCall = { name: "lookup_order", args: { order_id: orderId } };
  if (order === undefined)
    return {
      reply: `I can't find an order ${orderId}. Could you check the number?`,
      tool_calls: [lookup],
    };

  if (/refund|return|money back/.test(text)) {
    const policy: ToolCall = { name: "check_refund_policy", args: { order_id: orderId } };
    const days = order.deliveredDaysAgo;
    if (days === undefined)
      return {
        reply: `Order ${orderId} has not been delivered yet, so it can't be refunded until it arrives.`,
        tool_calls: [lookup, policy],
      };
    if (days <= REFUND_WINDOW_DAYS)
      return {
        reply: `Order ${orderId} (${order.item}) was delivered ${days} days ago, inside the ${REFUND_WINDOW_DAYS}-day window, so it is eligible for a refund. Your refund reference is RF-${orderId}.`,
        tool_calls: [lookup, policy, { name: "issue_refund", args: { order_id: orderId } }],
        outcome: "resolved",
      };
    return {
      reply: `Order ${orderId} was delivered ${days} days ago, outside the ${REFUND_WINDOW_DAYS}-day refund window, so it is not eligible for a refund. I've passed this to a human agent who can review it.`,
      tool_calls: [lookup, policy],
      outcome: "escalated",
    };
  }

  if (/status|where|when|track|arrive/.test(text)) {
    if (order.status === "shipped")
      return {
        reply: `Order ${orderId} (${order.item}) has shipped and should arrive on ${order.eta}.`,
        tool_calls: [lookup],
        outcome: "resolved",
      };
    if (order.status === "in transit")
      return {
        reply: `Order ${orderId} is in transit: it was last scanned at the ${order.location} and should arrive on ${order.eta}.`,
        tool_calls: [lookup],
        outcome: "resolved",
      };
    return {
      reply: `Order ${orderId} was delivered ${order.deliveredDaysAgo} days ago.`,
      tool_calls: [lookup],
      outcome: "resolved",
    };
  }
  return {
    reply: `Thanks, I have order ${orderId} (${order.item}) pulled up. What would you like to know about it?`,
    tool_calls: [lookup],
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const mode = process.env.STUB_AGENT_MODE ?? "correct";
if (!["correct", "oracle", "canned"].includes(mode)) {
  console.error(`unknown STUB_AGENT_MODE ${mode}`);
  process.exit(2);
}
const delayMs = Number(process.env.STUB_AGENT_DELAY_MS ?? "0");

const server = createServer((req, res) => {
  void (async () => {
    if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, mode });
    if (req.method !== "POST" || req.url !== "/chat") return send(res, 404, { error: "not found" });
    let body: { conversation_id?: unknown; messages?: unknown };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      return send(res, 400, { error: "body is not JSON" });
    }
    if (!Array.isArray(body.messages))
      return send(res, 400, { error: "messages must be an array" });
    const messages = (body.messages as Message[]).filter(
      (m) => typeof m?.role === "string" && typeof m?.content === "string",
    );
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    const a: Answer =
      mode === "canned"
        ? { reply: CANNED_REPLY, tool_calls: [], outcome: "resolved" }
        : answer(messages);
    const input = messages.reduce((n, m) => n + m.content.split(/\s+/).length, 0);
    const output = a.reply.split(/\s+/).length;
    send(res, 200, {
      reply: a.reply,
      session_id:
        typeof body.conversation_id === "string" ? `sess-${body.conversation_id}` : "sess",
      tool_calls: a.tool_calls,
      ...(a.outcome ? { outcome: a.outcome } : {}),
      // Integer micro-USD: a flat 100 plus 3 per input word and 15 per output word.
      usage: {
        input_tokens: input,
        output_tokens: output,
        cost_micro_usd: 100 + 3 * input + 15 * output,
      },
    });
  })().catch((e: unknown) => send(res, 500, { error: String(e) }));
});

server.listen(Number(process.env.PORT ?? "0"), "127.0.0.1", () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  if (process.env.STUB_AGENT_PORT_FILE)
    writeFileSync(process.env.STUB_AGENT_PORT_FILE, `${port}\n`);
  console.log(`stub-agent listening on http://127.0.0.1:${port} (mode ${mode})`);
});

const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
