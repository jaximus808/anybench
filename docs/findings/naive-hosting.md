# Naïve as the control-plane host (TDM-170 [2.9] spike, 2026-11-07)

Can Anybench's always-on worker, its API and its MCP endpoint run on Naïve? Every claim below comes from a live call. The scripts are in `scripts/spikes/naive-hosting/`. Run them as `SPIKE_STATE=<file> SPIKE_LOG=<file> ./run.sh <script> <cmd>`. `run.sh` loads `.env` into the process environment with `node --env-file` and sets `NAIVE_LIVE=1`. No script prints a secret, and `lib.mjs` redacts known secret values from every log line. Outputs below are trimmed copies of the JSON-lines log. Read this file together with `naive-platform-hosting.md`, which records the facts from the docs.

SDK: `@usenaive-sdk/managed-agents` 0.12.3, called directly. `packages/naive` exposes only agents and sessions, so this spike did not go through it.

## Summary

| Question | Answer |
|---|---|
| Does a detached worker process survive separate `exec` calls? | **Yes.** It even survives the `exec` that started it hitting its timeout (`setsid nohup … &`, and also plain `nohup &` and bare `&`). |
| Does it keep running with no exec traffic? | **Yes.** The full 60-min soak ran to its hard stop: 120 of 120 heartbeats to Neon over 59.5 min, no gap over 45 s (see "Final soak result"). The computer stayed `running` and never auto-paused. |
| Outbound reach from the computer | Neon direct TCP+TLS (and `LISTEN`), api.stripe.com, R2, the Naïve API, npm and GitHub: all reached, at 37–135 ms. |
| Cost of an always-on worker (1 vCPU / 1 GiB) | **11,100 µ$ per 10-min block**, measured as a ledger debit. That is $0.0666/h, or **≈ $47.95 per 30-day month**. |
| Snapshot then restore | **The snapshot captures memory and processes**, not only the disk. A successor booted from it resumes the running worker in place, with a new hostname. The handoff design has to account for this (see below). |
| What is a `fullstack` app? | **A Vercel project in Naïve's Vercel team** (`*.vercel.app`, `server: Vercel`, region `iad1`, Fluid compute, Node 22). It uses Vercel's zero-config `api/*` functions and `vercel.json`, plus a managed Postgres. |
| Plain TS entry with package.json | **Accepted.** `api/app.ts` (Hono + @hono/node-server + pg) was built with no bundling and was `ready` in 6–13 s. |
| SSE | **Works.** A 100 s stream delivered events in real time (1 event/s, 102 events, 100.5 s). |
| Max request duration | A 120 s request succeeded. A 310 s request was cut at exactly 300 s with `maxDuration: 300`. With `maxDuration: 800`, a 400 s request was **also cut at 300 s**. **The platform caps requests at 300 s.** |
| `setSecret` | It shows up as `process.env` **on the next deploy**. A running deployment keeps the old value. |
| `mcp: "/mcp"` | **Works.** Agents get the tool as a direct tool, `tdm170-spike.spike_echo`. A Naïve agent session called it and got `TDM170-OK` back. The platform runs initialize, then notifications/initialized, then tools/list on every turn. |
| `connectDomain` for api.anybench.jaxonp.com | The domain object and the connect call both succeed and stay `pending`. **Naïve returned only email records (Resend, SES) and no CNAME/A record for app hosting.** I deleted it again and changed no DNS. |
| Spend for the whole spike | **80,921 µ$ (≈ $0.08)** final, after the soak computer was deleted at 00:37:56Z: 76,192 for computers and 4,729 for 5 agent sessions. **The app was not billed at all.** |

## 0. Account state

```
credits.show        → {"balance_micro_usd":250999379,"mode":"live"}            (2026-11-07T23:34:28Z, before anything)
credits.subscription→ {"status":"active","plan":"pro","price_micro_usd":200000000,"included_credit_micro_usd":200000000,
                       "current_period_end":"2026-12-01T08:00:00.000Z","cancel_at_period_end":true, …}
computers.list / apps.list / domains.list → []
```

The current key now has `billing:read`, so `credits.show` works. It failed with 403 earlier today. Note `cancel_at_period_end: true`: the Pro plan ends on 2026-12-01 unless it is renewed. **Every non-billing route returns 402 once the plan lapses, and that would take the worker and the app down with it.**

## 1. Worker on a Naïve computer

### Create and probe

```
computers.create {name:"tdm170-worker", vcpu:1, memory_mb:1024}   (4.0 s)
→ {"id":"cmp_01a1b85e26a37b7286d45eb92f06253f","vcpu":1,"memory_mb":1024,"disk_gb":5,"status":"running",
   "created_at":"2026-11-07T23:35:43.431Z"}

computers.exec "uname -a; …; node -v; npm -v; ps …"   (2.6 s round trip, 1.1 s on the box)
→ Linux lucky-river-96c7 6.18.60 x86_64 · Ubuntu 24.04.5 LTS · user tenki · HOME=/home/tenki · nproc 1
  Mem total 958 MiB, used 172 · /dev/root 4.9G (2.6G used) · node v24.22.1 · npm 11.19.1 · git, curl present
  docker: not installed · PID 1 = systemd · passwordless sudo works

computers.inspect → {"status":"running","home":"/home/naive","probe":{"uptime_seconds":14,"processes":105,
                     "memory_used_mb":204,"memory_total_mb":959,"disk_used_gb":2.51,"disk_total_gb":4.84}}
```

- The default disk is **5 GiB** (2.1 GiB free), not the larger default the docs imply.
- The `fs` API's `/home/naive` maps to the shell user's real home, `/home/tenki`. `fs write /home/naive/t.txt` landed at `/home/tenki/t.txt`, which `sudo find` confirmed. Scripts should use `~` or `os.homedir()` and never hard-code `/home/naive`. An `ls ~` run about 0.7 s after the fs write did not see the file yet; a second look did.

### Secrets and setup

```
computers.fs mkdir /home/naive/.anybench, /home/naive/spike           → {"created":true}
computers.fs write /home/naive/.anybench/env   (DATABASE_URL_DIRECT, S3_ENDPOINT, NAIVE_BASE_URL; value never logged) → 276 bytes
computers.fs write ~/spike/{heartbeat.mjs,reach.mjs,package.json}
computers.exec "chmod 600 ~/.anybench/env && ls -l ~/.anybench/env && cd ~/spike && npm i pg@8"   (2.3 s)
→ -rw------- 1 tenki tenki 276 … /home/tenki/.anybench/env
```

No secret ever appeared on an exec command line. The scripts read `~/.anybench/env` themselves.

### Outbound reach (`reach.mjs`, run on the computer)

```
{"neon_direct":{"ok":true,"ms":135,"version":"PostgreSQL 18.6 (ac70818) on aarch64-unk"},
 "neon_listen":{"ok":true,"ms":10},
 "stripe":{"status":401,"ms":129},        // unauthenticated GET /v1/charges: TLS + HTTP reach
 "r2":{"status":400,"ms":37},             // unsigned GET on S3_ENDPOINT
 "naive_api":{"status":401,"ms":44},      // GET /v1/credits/balance without a key
 "npm":{"status":200,"ms":39},
 "github":{"status":200,"ms":38}}
```

The computer can reach every service the worker needs, and `LISTEN` works on the Neon direct endpoint, which graphile-worker requires.

### Detached process survival

```
computers.exec "cd ~/spike && setsid nohup node heartbeat.mjs worker-1 30000 3600000 > hb.log 2>&1 < /dev/null & echo setsid_pid=$!;
                nohup sleep 7200 > /dev/null 2>&1 & echo nohup_pid=$!; sleep 7201 & echo bare_pid=$!; sleep 1; echo done"   (timeout 120 s)
→ {"stdout":"setsid_pid=1747\nnohup_pid=1749\nbare_pid=1750\ndone\n","stderr":"command timed out after 120000ms",
   "exit_code":124,"duration_ms":127195,"timed_out":true}

computers.exec "ps -eo pid,ppid,pgid,sid,etimes,args | grep -E 'heartbeat|sleep 72'; tail -3 ~/spike/hb.txt"   (9 s later)
→  1748  1747 1748 1748 135 node heartbeat.mjs worker-1 30000 3600000
   1749     1 1742 1563 135 sleep 7200
   1750     1 1742 1563 135 sleep 7201
   2026-11-07T23:38:50.174Z seq=5 ok 71ms
```

Findings:
1. **The exec call waits until every process holding its stdout or stderr has exited.** The bare `sleep 7201 &` kept stdout open, so the call hung until the 120 s timeout. **Rule: redirect all three fds (`> log 2>&1 < /dev/null`) on anything you background.** With the fds redirected, the exec returns at once.
2. **A timeout does not kill detached children.** The docs say "the command and the processes it started are killed", but all three background processes survived the timeout, including the bare `&`. In practice the kill reaches only the foreground `bash -c` tree. Even so, use `setsid` for the worker so it does not depend on this behaviour.
3. The process kept running across later, separate exec calls.

### Soak: heartbeat to Neon dev with no exec traffic

`heartbeat.mjs` inserts one row into `spike_heartbeats` every 30 s, with a fresh `pg.Client` per beat and verified TLS. It stops itself after 60 min. The only exec traffic after 23:39:06 was the snapshot test at 23:55 (see below). Status checks used `computers.get`, which does not touch the machine.

```
worker.mjs check   (2026-11-07T23:53:55Z, ~17 min into the soak)
computers.get → {"status":"running", …}
neon heartbeats summary → [{"label":"worker-1","host":"lucky-river-96c7","pid":1748,"n":35,"min_seq":1,"max_seq":35,
                            "first_at":"2026-11-07T23:36:50.071Z","last_at":"2026-11-07T23:53:50.331Z","age_s":6,"span_s":1020}]
neon heartbeat gaps > 45 s → []
```

```
worker.mjs check   (2026-11-08T00:10:26Z, 33.5 min into the soak; 31 min since the last exec on this computer, 23:39:06,
                    apart from the snapshot-test execs at 23:55)
computers.get → {"status":"running", …}
neon heartbeats summary → [{"host":"lucky-river-96c7","pid":1748,"n":68,"min_seq":1,"max_seq":68,
                            "first_at":"2026-11-07T23:36:50.071Z","last_at":"2026-11-08T00:10:20.532Z","age_s":6,"span_s":2010},
                           {"host":"lucky-valley-482c","pid":1748,"n":1,"min_seq":39,"max_seq":39}]   ← the snapshot successor (deleted)
neon heartbeat gaps > 45 s → []
```

**Observed so far: 33.5 min, 68 of 68 heartbeats, no gap over 45 s.** The soak is still running for the planner's long-run check (see below).

- The computer never paused. Every `computers.get` returned `status: "running"`. Our own computers do not idle-pause; that applies only to agent-owned computers.
- **The soak computer was left running for the planner on purpose**: `cmp_01a1b85e26a37b7286d45eb92f06253f`, table `spike_heartbeats` on Neon **dev**. The heartbeat process exits at about 00:36:50Z (its 60-min hard stop). The computer itself keeps billing at 11,100 µ$ per block until someone deletes it. If nobody does, the platform destroys it at 12 h (≈ 2026-11-08T11:35Z), which caps the cost at ≈ $0.80. To check and clean up: `./run.sh worker.mjs check`, then `./run.sh worker.mjs destroy`, then `./run.sh worker.mjs droptable`.

### Measured cost

```
credits.ledger {type:"debit", from: createdAt}
→ {"type":"debit","amount_micro_usd":-11100,"actor":{"type":"system","id":"cron"},
   "resource_id":"cmp_01a1b85e26a37b7286d45eb92f06253f","line_items":[{"tier":"computer","amount_micro_usd":-11100}],
   "created_at":"2026-11-07T23:50:08.683Z"}          // one per 10-min block, billed in advance
credits.spend {from: createdAt} → {"by_tier":{"computer":22200, …}}   // 2 blocks at 23:54
```

- How billing works, from the ledger: `create` charges at once for the part-block up to the next wall-clock :x0 boundary, prorated at 18.5 µ$/s. The worker was created at 23:35:43 and charged −4,747, which is 257 s × 18.5. After that a `system:cron` debit of −11,100 lands at each boundary (23:40:11, 23:50:08, 00:01:50, 00:10:18). The successor was created at 23:55:38 and charged −4,845; deleting it 33 s later refunded nothing.
- 1 vCPU and 1 GiB cost **11,100 µ$ per 10-min block**, which is 8,400 for the vCPU plus 2,700 for the GiB, matching the published prices. That is **66,600 µ$/h**, **1,598,400 µ$/day** and **47,952,000 µ$ (≈ $47.95) per 30-day month**.
- The vCPU is 76% of the cost. 1 vCPU with 512 MiB would be 9,750 µ$ per block, about $42 a month. A fractional vCPU is not possible (the minimum is 1).
- The 11 h handoff adds about one overlap block per cycle: ≈ 65 blocks a month, about $0.72.
- **Projected always-on worker on Naïve: ≈ $48.7 a month**, paid from the Naïve credit pool. That pool also funds every agent session, so the worker competes with product work for credit.

### Snapshot and restore: the building block for the 11 h handoff

```
computers.snapshot(cmp_01a1b85e…)            (7.0 s) → {"snapshot_id":"snp_033329219dd747bd94a3c87114dc5894"}
computers.create {snapshot_id, vcpu:1, memory_mb:1024, name:"tdm170-worker-successor"}  (2.2 s)
→ {"id":"cmp_01a1b870681f77d380c50e1397d4fe60","status":"running","snapshot_id":"snp_0333…"}
computers.exec (successor) "uptime; ls …; pgrep -af heartbeat; tail -2 ~/spike/hb.txt"   (1.1 s)
→ 23:55:39 up 19 min · ~/.anybench/env present (600) · node_modules present
  1748 node heartbeat.mjs worker-1 30000 3600000          ← the worker process is RUNNING on the successor
fork timings → {"snapshot_ms":7026,"create_to_first_exec_ms":3342}

neon (30 s later):
  {"seq":39,"host":"lucky-river-96c7","pid":1748,"os_uptime_s":1209,"at":"23:55:50.358Z"}   ← original
  {"seq":39,"host":"lucky-valley-482c","pid":1748,"os_uptime_s":1210,"at":"23:55:57.722Z"}  ← successor, same pid and seq
computers.delete(successor) → deleted · computers.deleteSnapshot(snp_0333…) → deleted
```

**A Naïve snapshot is a full VM snapshot: memory, processes and uptime.** A computer created from a snapshot of a live worker boots with that worker already running, mid-loop. The process keeps the same pid and in-memory state, but gets a new hostname and its TCP connections are broken. It also carries every secret file that was on the disk. The snapshot took 7 s, and the successor accepted its first exec 3.3 s after the create call.

### 11 h handoff: design on paper (not run)

Lifetime is 12 h from `created_at`, and the computer is destroyed after that. graphile-worker keeps its state in Postgres and two instances can safely run side by side (SKIP LOCKED). The existing `worker_heartbeats` table (TDM-14) is the liveness signal.

1. **Golden snapshot, taken once per release, not from the live worker.** Use a builder computer: `computers.create` → `exec` to install Node, the worker bundle and the dependencies → `computers.snapshot` → `computers.delete`. The builder never holds secrets and never starts the worker, so a restore boots to an idle machine. Do not snapshot the live worker: per the result above, the successor would wake up as a second copy of the old worker, with dead connections and the old worker's identity.
2. At `created_at + 11h`, the running worker (or the cron backstop) runs `computers.create({ name: "anybench-worker-<n>", vcpu: 1, memory_mb: 1024, snapshot_id: GOLDEN })`.
3. It calls `computers.fs(new, "write", { path: "/home/naive/.anybench/env", content })` and then `exec "chmod 600 ~/.anybench/env"`. This writes fresh secrets, which never go into a snapshot.
4. It calls `exec "setsid nohup node ~/worker/main.js > ~/worker/log 2>&1 < /dev/null & echo $!"`, which returns at once because all fds are redirected.
5. Wait for the successor's row in `worker_heartbeats`: poll Neon for a new `worker_id` (hostname:pid) with an age under 60 s, with a timeout of about 3 min. On timeout, `computers.delete(new)` and retry with backoff. The old worker keeps running in the meantime.
6. Drain the old worker: stop taking jobs (graphile `runner.stop()` waits for jobs in flight), write a final heartbeat with `draining=true`, and exit. The new worker then calls `computers.delete(old)`. This way the step does not depend on the old worker being alive to delete itself.
7. Backstop: a Naïve deployment (cron every 5 min or more, tiny budget) or the API's own cron route checks `worker_heartbeats`. If no live worker is found, or the newest computer is more than 11.5 h old, it runs steps 2–5. This is the safety net for a crashed or OOM-killed worker.
8. Detecting a restore: if a worker ever finds `os.hostname()` changed under it, it should exit at once. That guards against someone snapshotting a live box by mistake.

SDK calls needed: `computers.snapshot`, `computers.create({snapshot_id})`, `computers.fs("write")`, `computers.exec`, `computers.get` and `computers.list` (for the age check), `computers.delete`, `computers.deleteSnapshot` (for old golden images), plus `deployments.create({schedule, budget_micro_usd, …})` for the backstop.

## 2. `fullstack` app serving a Hono app

### What the platform is

Naïve's docs do not document the deploy format. The CLI docs say `naive app deploy` skips `.wrangler`, `.open-next` and `.dev.vars*`. Naïve's public `usenaive/agency-blueprint` repo ships `dist/api/app.js`, `dist/vercel.json` and `dist/package.json`, with the comment "the host's zero-config file map turns `dist/api/app.js` into `/api/app`". I tried that layout and it worked on the first deploy. The live responses settle the question: the app runs on **Vercel**.

```
apps.create {name:"tdm170-spike", type:"fullstack", mcp:"/mcp"}   (9.9 s)
→ {"id":"app_nr5jcvxy3m4p1db6wqj4qr7e2c","type":"fullstack","status":"provisioning","url":null,"mcp":"/mcp"}
apps.get (immediately) → {"status":"active","url":null}
apps.secrets → DATABASE_REST_URL, DATABASE_SERVICE_KEY, DATABASE_URL, VETTA_MCP_TOKEN (platform-managed, created at app create)
```

The deployed files are `scripts/spikes/naive-hosting/app/`:
- `api/app.ts`: a Hono app wrapped with `@hono/node-server`'s `getRequestListener` and exported as a Node `(req, res)` function. It is plain TypeScript with no build step.
- `package.json`: `hono`, `@hono/node-server` and `pg` as dependencies, with `engines.node: 22.x`.
- `vercel.json`: `rewrites: [{source:"/(.*)", destination:"/api/app?__path=/$1"}]` and `functions["api/app.ts"].maxDuration`.
- `index.html`.

```
apps.deploy(app, {api/app.ts, index.html, package.json, vercel.json}, sha256)   (2.4 s)
→ {"id":"apd_dsgpzddf8wz2ybaqye8e7nhe2w","status":"building",
   "url":"https://tdm170-spike-sj1arspaf10q-jo2nmqh47-naive-e9517ea2.vercel.app"}
apps.deployments (poll) → building … ready after 7 s
apps.get → {"status":"active","url":"https://tdm170-spike-sj1arspaf10q.vercel.app"}
```

Four more deploys took 6–13 s each to reach `ready`. **There is no API for build logs or runtime logs.** An `AppDeployment` carries only `status` and `error`. Runtime visibility has to come from the app itself. I logged every `/mcp` request into the app's managed Postgres and read it back with `apps.query`, which worked well.

### GET /health, cold start, environment

```
GET /health #1 → 200 in 551 ms  x-vercel-id: sfo1::iad1::…  server: Vercel
  {"instance":"a9176621","cold":true,"instance_age_ms":9958,"node":"v22.23.4","platform":"linux/x64","region":"iad1",
   "spike_secret":{"present":true,"length":36,"sha256_8":"5890d5e8"},          // matches the value set (sha8 5890d5e8)
   "env_names":["DATABASE_REST_URL","DATABASE_SERVICE_KEY","DATABASE_URL","SPIKE_SECRET","VERCEL","VERCEL_FLUID",
                "VERCEL_REGION","VERCEL_URL", … ,"VETTA_MCP_TOKEN"]}
GET /health #2 → 200 in 101 ms (same instance, warm) · #3 → 101 ms
GET /nope → 404 {"error":"not_found","path":"/nope"} (the rewrite sends every path to the function)
```

- The runtime is a **Vercel Node 22 function with Fluid compute** (`VERCEL_FLUID`) in `iad1`, the same AWS region as our Neon. One instance serves many requests at once: the SSE stream, two long sleeps and the health checks all ran on instance `a9176621`.
- First request on a fresh deployment: 403–710 ms end to end, where a warm request takes about 100 ms. That deployment's instance was about 7–10 s old, so Vercel pre-warms on deploy. After **11 min with no traffic** (last request 23:58:54Z, probe at 00:10:02Z), the same instance `705cba37` answered, now 995 s old, in 434 ms and then 199 ms. **There was no real cold start in 11 min**, because Fluid keeps an instance alive between requests. I did not observe a cold boot after a long idle (hours). Budget about 0.5–1 s for one.
- Platform env: `DATABASE_URL`, `DATABASE_REST_URL` and `DATABASE_SERVICE_KEY` for the managed Postgres, and `VETTA_MCP_TOKEN`. A `DATABASE_URL_DIRECT` for our Neon would have to be set as a secret under a different name, such as `NEON_DATABASE_URL`, because the platform owns every `DATABASE_*` name.

### setSecret

```
apps.setSecret {name:"SPIKE_SECRET"} → {"object":"app_secret","name":"SPIKE_SECRET","value_hash":null}
apps.setSecret {name:"VETTA_MCP_TOKEN"} → 403 forbidden "VETTA_MCP_TOKEN is managed by the platform and cannot be set or deleted"
rotate SPIKE_SECRET (new sha8 402e41a4), no redeploy:  GET /health → sha256_8 "5890d5e8"   (old value still served)
redeploy, then GET /health → instance 705cba37, sha256_8 "402e41a4"                     (new value)
```

These are Vercel env semantics: **a secret reaches the runtime only with the next deployment**. After a rotation, call `apps.redeploy(id, latestDeploymentId)`. It reuses the stored files and uploads nothing.

### SSE and request duration

```
GET /sse?seconds=100 → 200, headers in 438 ms, content-type text/event-stream
  ended: {"events":102,"chunks":101,"first_event_ms":477,"total_ms":100516,
          "arrivals":[{1,477ms},{2,1374ms},{3,2391ms},{15,14531},{30,29389},{45,44395},{60,59497},{75,74416},{90,89435}]}
GET /sleep?seconds=120 → 200 in 120,829 ms {"slept_ms":120001}
GET /sleep?seconds=310 (maxDuration 300) → connection closed at 300,261 ms (UND_ERR_INFO)
GET /sleep?seconds=400 (maxDuration 800, deployed 23:53:32) → connection closed at 300,611 ms (UND_ERR_INFO)
```

- **Streaming is real.** Each event arrived about 1 s after the one before it. There is no buffering, and one chunk carries one event.
- The cap is **300 s**. `maxDuration` can lower it, but raising it to 800 has no effect, so the cap is set by Naïve's Vercel plan or project. Long work belongs in the worker, not in a request.
- The TDM-154 SSE design (poll `events` by seq, end near the max duration, reconnect with `Last-Event-ID`) fits this host as-is.

### `mcp: "/mcp"` and a Naïve agent calling the tool

The app implements MCP streamable HTTP as JSON-only over POST (initialize, tools/list, tools/call), with one tool, `spike_echo`. It checks `Authorization: Bearer $VETTA_MCP_TOKEN` in constant time.

```
POST /mcp (no auth) → 401 · POST /mcp "Bearer nope" → 401

agents.create {name:"tdm170-mcp-probe", model:"google/gemini-2.5-flash-lite", handoffs:false,
               budget:{cap_micro_usd:500000, max_task_micro_usd:200000, period:"month"},
               tools:{default_config:{permission:"deny"}, configs:{"tdm170-spike.spike_echo":{enabled:true,permission:"allow"},
                      apps:{enabled:true,permission:"allow",config:{allowed_apps:["app_nr5jcvxy3m4p1db6wqj4qr7e2c"]}}}}}
→ agt_v81c4gx69g668xfsk374fb2y3b

sessions.create {budget_micro_usd:100000, message:"First, write out the exact names of every function/tool you were
                 given directly … Then call vetta.tools_search with query \"echo\" …"}
→ ses_2zw319jncjrrqad70z74mhk515
  tool.completed {"tool_call_id":"tool_tdm170-spike__spike_echo_6Jzt…","name":"tdm170-spike.spike_echo",
                  "output":"{\"echoed\":\"hello\",\"now\":\"2026-11-07T23:52:52.378Z\",\"instance\":\"3c722928\",\"marker\":\"TDM170-OK\"}",
                  "is_error":false}
  session.idle {stop_reason:"end_turn"} · consumed_micro_usd 705

apps.query "select … from spike_mcp_log" (what the platform sent to our endpoint):
  initialize {"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"vetta","version":"1"}}
    accept "application/json, text/event-stream", bearer_ok true
  notifications/initialized  WITH "id":2   ← a notification that carries an id
  tools/list {"id":3}
  tools/call {"id":4,"name":"spike_echo","arguments":{"message":"hello"}}   ← 23:52:52, the call above
  24 requests in total: 23 handshake/list, 1 call
```

- **It works, and the platform does the auth.** It sends the bearer server-side, and the agent sandbox never sees it.
- **The tool is a direct tool named `<app>.<tool>`. It is not in the `vetta.tools_search` catalogue.** In four earlier sessions (three on the deny-default agent, one on the allow-all agent), given the prompt "list the tools whose names start with tdm170-spike…", the cheap model searched the catalogue, found nothing (it holds only `domains_*` for this key), and tried `vetta.tools_execute("tdm170-spike__spike_echo")`, which fails with "no such tool". The fifth session, whose prompt asked the model to name its direct tools first, called the direct tool. Anybench's agent prompts should name the tool directly (`anybench.<tool>`), as the agency blueprint does (`dashboard.get_site`).
- The same thing happened with `default_config.permission: "allow"`, so the allow/deny setting was not the cause. That session was cancelled at 2,302 µ$.
- **The platform re-runs initialize, notifications/initialized and tools/list on each turn** (observed at 23:48:46, 23:49:15, 23:49:25, 23:49:36 …). Each agent turn therefore costs our API about 3 requests plus the calls themselves. Keep `/mcp` cheap and do no database work on `tools/list`.
- The platform's `notifications/initialized` arrives with an `id`. The spike app answers `{result:{}}` when an id is present and 202 otherwise. The successful call came after that change. I did not isolate whether a plain 202 also works: the sessions before the change failed for the reason above, not visibly because of the handshake.
- Cost: 448–718 µ$ per probe session on `google/gemini-2.5-flash-lite`.

## 3. Domain: api.anybench.jaxonp.com

```
domains.create {name:"api.anybench.jaxonp.com", kind:"external", receive:false}   (5.7 s)
→ {"id":"dom_grfap07xa0tx5r4ea9yhd2633g","status":"pending_dns","dns_status":"pending_verification",
   "inbound_status":"failed","app_connect_status":"pending",
   "records":[
     {"type":"TXT","host":"resend._domainkey.api.anybench","value":"p=MIGfMA0…IDAQAB","managed":true},
     {"type":"MX","host":"send.api.anybench","value":"feedback-smtp.us-east-1.amazonses.com","priority":10},
     {"type":"TXT","host":"send.api.anybench","value":"v=spf1 include:amazonses.com ~all"},
     {"type":"CNAME","host":"rsend.api.anybench","value":"send.forge.rmta.net"},
     {"type":"TXT","host":"_dmarc","value":"v=DMARC1; p=none;","managed":true}]}
apps.connectDomain(app, dom) → {"object":"app_domain","domain":"api.anybench.jaxonp.com","status":"pending"}
apps.domains (+5 s, +20 s) → status "pending"
domains.verify → unchanged (pending), last_verified_at set
apps.disconnectDomain → deleted:true · domains.delete → deleted:true · domains.list → []
```

DNS today: `jaxonp.com` NS is `ns-cloud-a{1..4}.googledomains.com` (Google Cloud DNS). Neither `anybench.jaxonp.com` nor `api.anybench.jaxonp.com` resolves yet.

- Creating the object costs nothing and can be undone: it was deleted again within 30 s, and no DNS was touched.
- **The records Naïve returns are for email sending only** (Resend DKIM, SES SPF/MX, a bounce CNAME). That holds even with `receive:false` and after `connectDomain`. Nothing tells us which record would make the app connect move from pending to connected. The host is Vercel, so it is almost certainly `CNAME api.anybench → cname.vercel-dns.com`, possibly with a `_vercel` TXT challenge if jaxonp.com is already claimed by another Vercel team. **This is unverified; Naïve does not expose it.**
- Hosts are relative to the zone apex. That puts the managed `_dmarc` record at `_dmarc.jaxonp.com`, which is **zone-wide DMARC**. Publishing it would change the email policy for all of jaxonp.com, so do not publish it as-is.
- Verdict: `connectDomain` can probably serve api.anybench.jaxonp.com. Doing so means adding a guessed Vercel CNAME and waiting for `app_connect_status: connected`, and there is no documented record to rely on. The fallback is to keep the `*.vercel.app` URL behind a CNAME and a proxy we control, or to use our own Vercel project (TDM-154), where the domain flow is documented.

## 4. Recommendation

| Role | Option | Monthly cost | Fit | Risks |
|---|---|---|---|---|
| **Worker** | **Naïve computer** (1 vCPU / 1 GiB, 11 h handoff) | **≈ $48.7** (measured 11,100 µ$ per block, plus overlap), from Naïve credit | Works today. Outbound to everything, detached processes survive, never pauses. Uses the SDK we already depend on. | 12 h lifetime means building and testing the handoff (golden snapshot, heartbeat gate, cron backstop). Spends the $250 Naïve credit that also funds agents (about 5 months of the whole pool). Snapshots copy RAM, so a careless snapshot means duplicate workers. A lapsed plan (`cancel_at_period_end: true` today) means 402s and a dead worker. 5 GiB disk, no Docker. |
| Worker | Oracle Cloud PAYG A1 (Ampere) | ≈ $0 inside the Always Free allowance (4 OCPU / 24 GB); list price ≈ $0.01/OCPU-h + $0.0015/GB-h beyond it (not verified today) | Long-lived, arm64, Docker. A PAYG account gets A1 capacity much more reliably than a free-tier one. | Needs a card and an account upgrade. We run the VM, patching and the systemd unit ourselves. TDM-155 is on hold for capacity. |
| Worker | Paid small VM (Hetzner / Vultr / DO, 1–2 vCPU, 1–2 GB) | ≈ $4–6 (list prices, not verified today) | Long-lived, any arch, Docker. TDM-155's compose plan applies unchanged. | One more vendor and VM to run. |
| **API + MCP** | **Naïve `fullstack` app** | $0 observed: **no ledger debit for the app** over the whole spike (5 deploys, about 200 requests, SSE, 300 s+ requests) | It is Vercel Fluid underneath: Node 22, iad1 next to Neon, real SSE, maxDuration ≥ 300 s, zero-config `api/`. `mcp: "/mcp"` gives every Naïve agent Anybench's tools with platform-held auth, which was proven live. | No build or runtime logs API, so we must log into our own DB. Secrets need a redeploy to take effect. The custom-domain record is undocumented and `_dmarc` is apex-scoped. We cannot see or configure the Vercel project (regions, firewall, cron, analytics). Pricing is unpublished and could change. It goes down with the Naïve subscription. The `DATABASE_*` names are taken. |
| API | Own Vercel project (TDM-154) | Hobby $0 (non-commercial) / Pro $20 | Same runtime, with full control: logs, domains, env, cron, firewall. Custom domain is documented. | Our MCP would not be a Naïve app tool. Agents would need it as an `mcp_servers` entry instead (not tested here). |

**Recommendation:**

1. **API and MCP: a Naïve `fullstack` app is viable.** It is the same Vercel runtime the TDM-154 design already assumes, and it adds native agent tools for free. Keep `createApp` transport-agnostic so the identical bundle can move to our own Vercel project if logs, domains or pricing become a problem. Before committing, open one follow-up to prove the custom domain: add the Vercel CNAME for `api.anybench.jaxonp.com` in Cloud DNS, skip the `_dmarc` record, and watch `app_connect_status`. If it will not connect, serve the API from our own Vercel project and keep a thin Naïve app only for `/mcp`.
2. **Worker: run it on a Naïve computer now as the working host, and move it to a paid VM or Oracle PAYG when one is ready.** Everything the worker needs works on Naïve today. At ≈ $49 a month, though, it costs about 10× a $5 VM and draws from the same credit as the product's agents, and the 12 h handoff is a new moving part. Build the handoff behind the host-agnostic worker image (golden snapshot plus `worker_heartbeats` gate plus cron backstop, as designed above), so that moving off Naïve later is a config change.
3. **Fix the plan risk first:** the Naïve Pro plan is set to `cancel_at_period_end: true` (2026-12-01). If Anybench is hosted on Naïve, a lapsed plan takes the API, the MCP and the worker down together.

## Credits

| When | balance_micro_usd |
|---|---|
| Before anything (23:34:28Z) | 250,999,379 |
| 23:53:55Z (worker 2 blocks, app, 5 probe sessions) | 250,967,703 |
| After app/agent cleanup | 250,940,658 (00:11:26Z, with the soak computer still running) |
| Final, after deleting the soak computer | **250,918,458** (00:37:56Z). Total spike spend 80,921 µ$. |

## Resources created and their state

| Resource | Id | State at hand-off |
|---|---|---|
| Worker computer | `cmp_01a1b85e26a37b7286d45eb92f06253f` | Soak finished (heartbeat hard stop 00:36:50Z). Deleted 00:37:56Z by the reviewer (`computers.delete` → deleted:true). |
| Successor computer | `cmp_01a1b870681f77d380c50e1397d4fe60` | Deleted 23:56:11Z |
| Snapshot | `snp_033329219dd747bd94a3c87114dc5894` | Deleted 23:56:13Z |
| App | `app_nr5jcvxy3m4p1db6wqj4qr7e2c` (tdm170-spike) | Deleted 00:11:21Z (`apps.delete` → deleted:true). Not needed for TDM-155. After the delete, the production alias `tdm170-spike-sj1arspaf10q.vercel.app` answered 200 at +5 s and 404 at +34 s. **The per-deployment URL `…-jjo02jhh6-naive-e9517ea2.vercel.app/health` still answered 200 at +34 s, and 404 at +41 s (00:12:02Z).** Both URLs were gone within a minute. |
| Agents | `agt_v81c4gx69g668xfsk374fb2y3b`, `agt_fhwwtscpsj8st8678r012yekgz` | Both deleted 00:11:09Z / 00:11:13Z |
| Domain | `dom_grfap07xa0tx5r4ea9yhd2633g` | Disconnected and deleted 23:55:11Z |
| Neon dev table | `spike_heartbeats` | Dropped 00:37:57Z (`worker.mjs droptable`). |

## Final soak result and cleanup (reviewer, 2026-11-08)

Run from the worktree after the heartbeat's 60-min hard stop:

```
SPIKE_STATE=<state file> ./run.sh worker.mjs check   (2026-11-08T00:37:31Z)
computers.get → {"id":"cmp_01a1b85e26a37b7286d45eb92f06253f","status":"running","vcpu":1,"memory_mb":1024,"disk_gb":5,…}
neon heartbeats summary → [{"label":"worker-1","host":"lucky-river-96c7","pid":1748,"n":120,"min_seq":1,"max_seq":120,
                            "first_at":"2026-11-07T23:36:50.071Z","last_at":"2026-11-08T00:36:20.805Z","span_s":3571},
                           {"label":"worker-1","host":"lucky-valley-482c","pid":1748,"n":1,"min_seq":39,"max_seq":39}]  ← snapshot successor
neon heartbeat gaps > 45 s → []

computers.exec "pgrep -af heartbeat || echo no-heartbeat-process; tail -3 ~/spike/hb.txt"   (00:37:42Z)
→ (only the pgrep's own bash matched: the node process is gone)
  2026-11-08T00:35:50.661Z seq=119 ok 78ms
  2026-11-08T00:36:20.661Z seq=120 ok 74ms
  2026-11-08T00:36:50.085Z hard stop after 3600000 ms
```

**Soak: 60 min (23:36:50Z → 00:36:50Z hard stop), 120 of 120 heartbeats (one every 30 s; the last at 59.5 min), zero gaps over 45 s, zero failed beats.** The computer was `running` throughout. The only exec traffic during the soak was the setup at 23:39 and the snapshot test at 23:55.

```
credits.ledger {type:"debit"} → system:cron debits of −11,100 at 00:20:08Z and 00:30:19Z (after the ones listed above)
SPIKE_STATE=<state file> ./run.sh worker.mjs destroy     (00:37:56Z)
computers.delete → {"id":"cmp_01a1b85e26a37b7286d45eb92f06253f","object":"computer","deleted":true}
credits.show (after destroy) → {"balance_micro_usd":250918458}
SPIKE_STATE=<state file> ./run.sh worker.mjs droptable   (00:37:57Z) → drop table if exists spike_heartbeats → ok

Verification (00:38Z): computers.list → [] · computers.listSnapshots → [] · apps.list → [] · domains.list → []
                       deployments.list → [] · agents.list → only the pre-existing "CEO" agent (no tdm170-* agents)
```

Total spike spend: 250,999,379 − 250,918,458 = **80,921 µ$ (≈ $0.08)**, well under the $5 budget. The soak computer was billed 71,347 µ$ over its 62 min of life: the 4,747 part-block at create plus 6 cron blocks of 11,100. Deleting it at 00:37:56Z refunded nothing for the block that started at 00:30:19Z. Nothing was kept for TDM-155.
