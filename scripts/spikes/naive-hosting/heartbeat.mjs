// Runs ON the Naïve computer (copied there with fs.write). Reads secrets from
// ~/.anybench/env (written via the fs API, chmod 600) — never from argv.
// Every 30 s it inserts a row into the Neon dev scratch table spike_heartbeats.
/* global process, setTimeout, setInterval */
import { readFileSync, appendFileSync } from "node:fs";
import { homedir, hostname, uptime } from "node:os";
import pg from "pg";

const env = Object.fromEntries(
  readFileSync(`${homedir()}/.anybench/env`, "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const label = process.argv[2] ?? "worker";
const intervalMs = Number(process.argv[3] ?? 30000);
// Hard stop so a forgotten soak cannot run forever (default 60 min).
const maxMs = Number(process.argv[4] ?? 3600000);
const startedAt = Date.now();
let seq = 0;

async function beat() {
  seq += 1;
  const client = new pg.Client({
    connectionString: env.DATABASE_URL_DIRECT,
    ssl: { rejectUnauthorized: true },
  });
  const t0 = Date.now();
  try {
    await client.connect();
    await client.query(
      "insert into spike_heartbeats (label, host, pid, seq, proc_uptime_s, os_uptime_s) values ($1,$2,$3,$4,$5,$6)",
      [
        label,
        hostname(),
        process.pid,
        seq,
        Math.round((Date.now() - startedAt) / 1000),
        Math.round(uptime()),
      ],
    );
    appendFileSync(
      `${homedir()}/spike/hb.txt`,
      `${new Date().toISOString()} seq=${seq} ok ${Date.now() - t0}ms\n`,
    );
  } catch (e) {
    appendFileSync(
      `${homedir()}/spike/hb.txt`,
      `${new Date().toISOString()} seq=${seq} ERR ${e?.code ?? ""} ${e?.message ?? e}\n`,
    );
  } finally {
    await client.end().catch(() => {});
  }
}

process.on("SIGTERM", () => {
  appendFileSync(`${homedir()}/spike/hb.txt`, `${new Date().toISOString()} SIGTERM, draining\n`);
  process.exit(0);
});
await beat();
setInterval(beat, intervalMs);
setTimeout(() => {
  appendFileSync(
    `${homedir()}/spike/hb.txt`,
    `${new Date().toISOString()} hard stop after ${maxMs} ms\n`,
  );
  process.exit(0);
}, maxMs);
