// Context.dev REST: usage before/after + one web-search with site:github.com claim phrases.
// Base https://api.context.dev/v1, header Authorization: Bearer $CONTEXT_DEV_API_KEY.
import { http, key, record } from "./lib.js";

const BASE = "https://api.context.dev/v1";
const auth = { authorization: `Bearer ${key("CONTEXT_DEV_API_KEY")}` };

const u0 = await http(`${BASE}/org/usage`, { headers: auth });
record("context.dev GET /org/usage (before)", u0);

const request = {
  query:
    'site:github.com ("faster than" OR benchmark OR "fewer tokens") ("Claude Code" OR "coding agent") harness',
  freshness: "last_month",
  numResults: 10,
};
const s = await http(`${BASE}/web/search`, { method: "POST", headers: auth, json: request });
record("context.dev POST /web/search", { request, ...s });

const u1 = await http(`${BASE}/org/usage`, { headers: auth });
record("context.dev GET /org/usage (after)", u1);
