// TDM-170 part 1: an always-on worker on a Naïve computer we create.
// Usage: NAIVE_LIVE=1 SPIKE_STATE=<file> node --env-file=<.env> worker.mjs <cmd>
//   table | create | probe | setup | reach | start | survive | check | ledger | destroy | droptable
/* global process */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { naive, step, log, need, pg } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const STATE = process.env.SPIKE_STATE ?? join(here, ".state.json");
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));
const c = naive();
const cmd = process.argv[2];
const id = () =>
  state.computerId ??
  (() => {
    throw new Error("no computerId in state");
  })();
const exec = (label, command, timeoutMs = 120000) =>
  step(`computers.exec ${label}`, () => c.computers.exec(id(), command, timeoutMs));

async function db(sql, params = []) {
  const client = new pg.Client({
    connectionString: need("DATABASE_URL_DIRECT"),
    ssl: { rejectUnauthorized: true },
  });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows;
  } finally {
    await client.end();
  }
}

switch (cmd) {
  case "table":
    await step("neon create spike_heartbeats", () =>
      db(`create table if not exists spike_heartbeats (
      id bigserial primary key, label text not null, host text, pid int, seq int,
      proc_uptime_s int, os_uptime_s int, at timestamptz not null default now())`),
    );
    break;
  case "create": {
    await step("credits.show (before create)", () => c.credits.show());
    const comp = await step(
      "computers.create",
      () => c.computers.create({ name: "tdm170-worker", vcpu: 1, memory_mb: 1024 }),
      { rethrow: true },
    );
    state.computerId = comp.id;
    state.createdAt = new Date().toISOString();
    save();
    await step("computers.get", () => c.computers.get(comp.id));
    break;
  }
  case "probe":
    await exec(
      "probe",
      "uname -a; . /etc/os-release; echo $PRETTY_NAME; whoami; echo HOME=$HOME; nproc; free -m | head -2; df -h $HOME | tail -1; which node npm git curl docker; node -v; npm -v; cat /proc/1/comm; ps -eo pid,ppid,pgid,sid,comm | head -20",
    );
    break;
  case "setup": {
    const envFile =
      [
        `DATABASE_URL_DIRECT=${need("DATABASE_URL_DIRECT")}`,
        `S3_ENDPOINT=${need("S3_ENDPOINT")}`,
        `NAIVE_BASE_URL=${process.env.NAIVE_BASE_URL || "https://api.vetta.sh"}`,
      ].join("\n") + "\n";
    await step("computers.fs mkdir ~/.anybench", () =>
      c.computers.fs(id(), "mkdir", { path: "/home/naive/.anybench" }),
    );
    await step("computers.fs mkdir ~/spike", () =>
      c.computers.fs(id(), "mkdir", { path: "/home/naive/spike" }),
    );
    await step("computers.fs write ~/.anybench/env (secret, value not logged)", async () => {
      await c.computers.fs(id(), "write", { path: "/home/naive/.anybench/env", content: envFile });
      return { bytes: envFile.length };
    });
    for (const f of ["heartbeat.mjs", "reach.mjs"]) {
      await step(`computers.fs write ~/spike/${f}`, () =>
        c.computers.fs(id(), "write", {
          path: `/home/naive/spike/${f}`,
          content: readFileSync(join(here, f), "utf8"),
        }),
      );
    }
    await step("computers.fs write ~/spike/package.json", () =>
      c.computers.fs(id(), "write", {
        path: "/home/naive/spike/package.json",
        content: JSON.stringify({ name: "spike", type: "module", private: true }),
      }),
    );
    await exec(
      "chmod + npm i pg",
      "chmod 600 ~/.anybench/env && ls -l ~/.anybench/env && cd ~/spike && npm i pg@8 --no-audit --no-fund 2>&1 | tail -3",
      300000,
    );
    break;
  }
  case "reach":
    await exec("reach", "cd ~/spike && node reach.mjs");
    break;
  case "start":
    // Detached worker + two controls: plain nohup & and bare &.
    await exec(
      "start detached",
      "cd ~/spike && setsid nohup node heartbeat.mjs worker-1 30000 3600000 > hb.log 2>&1 < /dev/null & echo setsid_pid=$!; nohup sleep 7200 > /dev/null 2>&1 & echo nohup_pid=$!; sleep 7201 & echo bare_pid=$!; sleep 1; echo done",
    );
    state.startedAt = new Date().toISOString();
    save();
    break;
  case "survive":
    await exec(
      "survive",
      "ps -eo pid,ppid,pgid,sid,etimes,args | grep -E 'heartbeat|sleep 72' | grep -v grep; echo ---; tail -3 ~/spike/hb.txt; cat ~/spike/hb.log",
    );
    break;
  case "check": {
    await step("computers.get", async () => {
      const x = await c.computers.get(id());
      return { id: x.id, status: x.status, ...x };
    });
    await step("credits.show", () => c.credits.show());
    await step("neon heartbeats summary", () =>
      db(`select label, host, pid, count(*)::int n, min(seq) min_seq, max(seq) max_seq,
      min(at) first_at, max(at) last_at, extract(epoch from now()-max(at))::int age_s,
      extract(epoch from max(at)-min(at))::int span_s from spike_heartbeats group by 1,2,3 order by first_at`),
    );
    await step("neon heartbeat gaps > 45 s", () =>
      db(`select * from (select seq, at, extract(epoch from at - lag(at) over (partition by label, pid order by seq))::int gap_s
      from spike_heartbeats) t where gap_s > 45 order by at`),
    );
    break;
  }
  case "inspect":
    await step("computers.inspect", () => c.computers.inspect(id()));
    break;
  case "ledger":
    await step(
      "credits.ledger (debits)",
      async () =>
        (await c.credits.ledger({ type: "debit", from: state.createdAt, limit: 50 })).data,
    );
    await step("credits.spend", () => c.credits.spend({ from: state.createdAt }));
    break;
  case "destroy":
    await step("computers.delete", () => c.computers.delete(id()));
    await step("credits.show (after destroy)", () => c.credits.show());
    break;
  case "fork": {
    // Handoff building block: snapshot the live worker, boot a successor from it, see what carried over.
    const t0 = Date.now();
    const snap = await step("computers.snapshot", () => c.computers.snapshot(id()), {
      rethrow: true,
    });
    state.snapshotId = snap.snapshot_id ?? snap.id;
    save();
    const t1 = Date.now();
    const fork = await step(
      "computers.create from snapshot",
      () =>
        c.computers.create({
          name: "tdm170-worker-successor",
          vcpu: 1,
          memory_mb: 1024,
          snapshot_id: state.snapshotId,
        }),
      { rethrow: true },
    );
    state.forkId = fork.id;
    save();
    await step("computers.exec on successor", () =>
      c.computers.exec(
        fork.id,
        "uptime; ls -la ~/.anybench ~/spike | head -20; ls ~/spike/node_modules | head -3; pgrep -af heartbeat || echo no-heartbeat-process; tail -2 ~/spike/hb.txt",
        60000,
      ),
    );
    log("fork timings", { snapshot_ms: t1 - t0, create_to_first_exec_ms: Date.now() - t1 });
    // The original must be untouched.
    await exec("original still beating", "pgrep -af heartbeat; tail -1 ~/spike/hb.txt");
    break;
  }
  case "unfork":
    if (state.forkId)
      await step("computers.delete successor", () => c.computers.delete(state.forkId));
    if (state.snapshotId)
      await step("computers.deleteSnapshot", () => c.computers.deleteSnapshot(state.snapshotId));
    break;
  case "droptable":
    await step("neon drop spike_heartbeats", () => db("drop table if exists spike_heartbeats"));
    break;
  default:
    log(
      "usage",
      "table|create|probe|setup|reach|start|survive|check|inspect|ledger|destroy|droptable",
    );
}
