// Context.dev people-enrich on ONE public lead (20 credits per match; not_found is not charged per
// the docs badge "20 credits per match"). Usage: tsx context-dev-enrich.ts https://github.com/<login>
// or tsx context-dev-enrich.ts '<json body>' (name + company/location clues from the GitHub profile).
import { http, key, record } from "./lib.js";

const BASE = "https://api.context.dev/v1";
const auth = { authorization: `Bearer ${key("CONTEXT_DEV_API_KEY")}` };
const profile = process.argv[2];
if (!profile) throw new Error("usage: context-dev-enrich.ts <github profile url | json>");

const request = profile.startsWith("{")
  ? { ...JSON.parse(profile), timeoutOpts: { milliseconds: 60000 } }
  : { social_urls: [profile], timeoutOpts: { milliseconds: 60000 } };
const r = await http(`${BASE}/people/enrich`, { method: "POST", headers: auth, json: request });
// Mask the email before it reaches the log: the findings doc must not carry a lead's address.
const body = JSON.parse(
  JSON.stringify(r.body).replace(
    /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+)/g,
    "$1***@$2",
  ),
);
record("context.dev POST /people/enrich", { request, status: r.status, headers: r.headers, body });
const u = await http(`${BASE}/org/usage`, { headers: auth });
record("context.dev GET /org/usage (after enrich)", u);
