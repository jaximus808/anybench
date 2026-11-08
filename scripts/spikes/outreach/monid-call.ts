// Usage: tsx monid-call.ts <path> '<json body>'   e.g. /v1/inspect '{"provider":"agentmail","endpoint":"/create-inboxes"}'
import { http, key, record } from "./lib.js";

const [path, body] = process.argv.slice(2);
if (!path) throw new Error("usage: monid-call.ts <path> [json]");
const k = key("MONID_API_KEY");
const res = await http(`https://api.monid.ai${path}`, {
  method: body ? "POST" : "GET",
  headers: { authorization: `Bearer ${k}` },
  ...(body ? { json: JSON.parse(body) } : {}),
});
record(`monid ${path}`, { request: body ? JSON.parse(body) : null, ...res });
