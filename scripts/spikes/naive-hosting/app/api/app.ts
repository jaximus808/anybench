// TDM-170 spike app: a minimal Hono app deployed as a Naïve `fullstack` app.
// The Naïve host builds `api/*` into functions (zero-config file map) and applies
// `vercel.json` rewrites, so every path is rewritten to this one function with `__path`.
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getRequestListener } from "@hono/node-server";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import pg from "pg";

// Debug log of every /mcp request into the app's own managed Postgres (read back with apps.query).
// One client per call (instances freeze between requests). libpq-compat sslmode: the platform's
// pooler presents a chain node-postgres cannot verify.
async function mcpLog(row: Record<string, unknown>) {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const u = new URL(url);
  u.searchParams.set("uselibpqcompat", "true");
  if (!u.searchParams.get("sslmode")) u.searchParams.set("sslmode", "require");
  const client = new pg.Client({ connectionString: u.toString() });
  try {
    await client.connect();
    await client.query(
      "create table if not exists spike_mcp_log (id bigserial primary key, at timestamptz default now(), row jsonb)",
    );
    await client.query("insert into spike_mcp_log (row) values ($1)", [JSON.stringify(row)]);
  } catch (e) {
    console.log("mcpLog failed", String((e as Error)?.message ?? e));
  } finally {
    await client.end().catch(() => {});
  }
}

const INSTANCE = randomUUID().slice(0, 8);
const BOOTED_AT = Date.now();
let requests = 0;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const same = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(sha(a), "hex"), Buffer.from(sha(b), "hex"));

const app = new Hono();

app.get("/health", (c) => {
  requests += 1;
  const secret = process.env.SPIKE_SECRET;
  return c.json({
    ok: true,
    instance: INSTANCE,
    cold: requests === 1,
    instance_age_ms: Date.now() - BOOTED_AT,
    requests,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    region: process.env.VERCEL_REGION ?? null,
    // Secret visibility without leaking it: presence, length and a hash prefix only.
    spike_secret: secret
      ? { present: true, length: secret.length, sha256_8: sha(secret).slice(0, 8) }
      : { present: false },
    env_names: Object.keys(process.env)
      .filter((k) =>
        /^(DATABASE|VETTA|VERCEL|NAIVE|DASHBOARD|PG|POSTGRES|SPIKE|AWS_LAMBDA)/.test(k),
      )
      .sort(),
  });
});

// Holds the request open for `seconds` before answering: finds the max request duration.
app.get("/sleep", async (c) => {
  const seconds = Math.min(Number(c.req.query("seconds") ?? "5"), 900);
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  return c.json({ slept_ms: Date.now() - t0, instance: INSTANCE });
});

// A streamed SSE response: one event per second for `seconds`.
app.get("/sse", (c) => {
  const seconds = Math.min(Number(c.req.query("seconds") ?? "90"), 900);
  return streamSSE(c, async (stream) => {
    const t0 = Date.now();
    await stream.writeSSE({
      event: "hello",
      data: JSON.stringify({ instance: INSTANCE }),
      retry: 3000,
    });
    for (let i = 1; i <= seconds; i++) {
      await stream.sleep(1000);
      await stream.writeSSE({
        id: String(i),
        event: "tick",
        data: JSON.stringify({ i, elapsed_ms: Date.now() - t0 }),
      });
    }
    await stream.writeSSE({ event: "done", data: JSON.stringify({ elapsed_ms: Date.now() - t0 }) });
  });
});

// MCP over streamable HTTP, the JSON-only subset (initialize, tools/list, tools/call).
const TOOLS = [
  {
    name: "spike_echo",
    description:
      "TDM-170 test tool. Returns the message you send plus the server time and instance id.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string", description: "Any text" } },
      required: ["message"],
    },
  },
];

app.all("/mcp", async (c) => {
  const token = process.env.VETTA_MCP_TOKEN ?? "";
  const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
  const raw = c.req.method === "POST" ? await c.req.text() : "";
  await mcpLog({
    method: c.req.method,
    rpc: raw.slice(0, 400),
    has_token_env: Boolean(token),
    has_bearer: Boolean(bearer),
    bearer_ok: Boolean(token && bearer && same(token, bearer)),
    accept: c.req.header("accept") ?? null,
    content_type: c.req.header("content-type") ?? null,
    ua: c.req.header("user-agent") ?? null,
    proto_version: c.req.header("mcp-protocol-version") ?? null,
    session: c.req.header("mcp-session-id") ?? null,
  });
  if (c.req.method !== "POST") return c.body(null, 405);
  if (!token || !bearer || !same(token, bearer)) {
    console.log(
      JSON.stringify({
        mcp: "unauthorized",
        has_token_env: Boolean(token),
        has_bearer: Boolean(bearer),
      }),
    );
    return c.json(
      { jsonrpc: "2.0", id: null, error: { code: -32001, message: "unauthorized" } },
      401,
    );
  }
  type Rpc = {
    id?: unknown;
    method?: string;
    params?: { protocolVersion?: string; name?: string; arguments?: { message?: string } };
  };
  let msg: Rpc | null;
  try {
    msg = JSON.parse(raw) as Rpc;
  } catch {
    msg = null;
  }
  console.log(
    JSON.stringify({ mcp: msg?.method ?? "parse_error", ua: c.req.header("user-agent") ?? null }),
  );
  if (!msg || typeof msg.method !== "string")
    return c.json(
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } },
      400,
    );
  // The platform's client sends `notifications/initialized` WITH an id (observed), so answer it
  // as a request when it carries one; a true notification gets 202 and no body.
  if (msg.method.startsWith("notifications/"))
    return msg.id === undefined || msg.id === null
      ? c.body(null, 202)
      : c.json({ jsonrpc: "2.0", id: msg.id, result: {} });
  if (msg.method === "initialize") {
    const asked = msg.params?.protocolVersion ?? "2025-06-18";
    return c.json({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: asked,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "anybench-spike", version: "0.0.0" },
      },
    });
  }
  if (msg.method === "tools/list")
    return c.json({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
  if (msg.method === "tools/call") {
    const name = msg.params?.name;
    if (name !== "spike_echo")
      return c.json({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true },
      });
    const text = JSON.stringify({
      echoed: msg.params?.arguments?.message ?? null,
      now: new Date().toISOString(),
      instance: INSTANCE,
      marker: "TDM170-OK",
    });
    return c.json({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } });
  }
  return c.json({
    jsonrpc: "2.0",
    id: msg.id,
    error: { code: -32601, message: "method not found" },
  });
});

app.notFound((c) => c.json({ error: "not_found", path: c.req.path }, 404));

const listener = getRequestListener(app.fetch);

// Node-style function entry. Restores the original path from the rewrite's `__path`.
type NodeReq = Parameters<ReturnType<typeof getRequestListener>>[0];
type NodeRes = Parameters<ReturnType<typeof getRequestListener>>[1];
export default function handler(req: NodeReq, res: NodeRes) {
  const url = new URL(req.url ?? "/", "http://app");
  const original = url.searchParams.get("__path");
  if (original) {
    url.searchParams.delete("__path");
    const qs = url.searchParams.toString();
    req.url = original + (qs ? `?${qs}` : "");
  }
  return listener(req, res);
}
