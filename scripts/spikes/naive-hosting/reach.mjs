// Runs ON the Naïve computer: outbound reach checks (Neon direct TCP+TLS, Stripe, R2, Naïve API, npm).
/* global console, fetch, AbortSignal */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import pg from "pg";

const env = Object.fromEntries(
  readFileSync(`${homedir()}/.anybench/env`, "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const out = {};
async function http(name, url) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { method: "GET", signal: AbortSignal.timeout(15000) });
    out[name] = { status: r.status, ms: Date.now() - t0 };
  } catch (e) {
    out[name] = { error: String(e?.cause?.code ?? e?.message ?? e), ms: Date.now() - t0 };
  }
}
{
  const t0 = Date.now();
  const c = new pg.Client({
    connectionString: env.DATABASE_URL_DIRECT,
    ssl: { rejectUnauthorized: true },
  });
  try {
    await c.connect();
    const r = await c.query(
      "select version() as v, now() as now, inet_server_addr()::text as addr",
    );
    out.neon_direct = { ok: true, ms: Date.now() - t0, version: r.rows[0].v.slice(0, 40) };
    const l = Date.now();
    await c.query("listen spike_channel");
    out.neon_listen = { ok: true, ms: Date.now() - l };
  } catch (e) {
    out.neon_direct = { ok: false, ms: Date.now() - t0, error: String(e?.code ?? e?.message) };
  } finally {
    await c.end().catch(() => {});
  }
}
await http("stripe", "https://api.stripe.com/v1/charges"); // expect 401 (no auth sent)
await http("r2", env.S3_ENDPOINT); // expect 400/403 (unsigned)
await http("naive_api", (env.NAIVE_BASE_URL || "https://api.vetta.sh") + "/v1/credits/balance"); // expect 401
await http("npm", "https://registry.npmjs.org/pg");
await http("github", "https://api.github.com/");
console.log(JSON.stringify(out));
