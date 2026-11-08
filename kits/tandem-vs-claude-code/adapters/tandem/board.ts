// Tandem board helper for the harness driver (TDM-41 [4.9]). Runs on the subject computer with
// Node 22.18+ type stripping (`node board.ts <command>`): builtins only, erasable TypeScript only.
// run.sh calls it; nothing here ever sees a secret (it starts before EVAL_SECRETS is read).
//
//   node board.ts free-port
//   node board.ts wait-healthy --api URL --timeout-s N          prints the server version
//   node board.ts mcp-config --from WS/.mcp.json --out FILE --gateway BIN --api URL
//                                                               prints the canvas code
//   node board.ts status --api URL --code CODE                 one JSON line (see BoardStatus)
//   node board.ts approve --api URL --code CODE --policy P [--poll-s N]
//                                                               built-in approver sidecar: JSONL
//   node board.ts dump --api URL --code CODE --out DIR          epics/actions/agents/metrics JSON
//   claude -p … | node board.ts tap --file FILE                 keep the transcript, forward spend
//
// Approvals (plan.md P3 "Approver"): Tandem epics are human-only under every policy, so the
// built-in approver plays the local human through the local-cookie path (GET / sets the
// `tandem_session` cookie, POST /api/mcp/auth {code} with it gives a human canvas token, then
// POST /api/canvas/actions/{id}/approve). `auto` also switches the canvas to the `auto` policy so
// tasks are born approved. `llm-reviewer` needs the approver package (@anybench/approver
// `eval-approver`, ticket 5.7), which run.sh prefers whenever it is installed; this command refuses
// llm-reviewer (exit 3) rather than approve blindly.
import { createServer } from "node:net";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

function args(argv: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`${a} needs a value`);
    m.set(a.slice(2), v);
    i++;
  }
  return m;
}

function need(m: Map<string, string>, k: string): string {
  const v = m.get(k);
  if (v === undefined || v === "") throw new Error(`--${k} is required`);
  return v;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function http(
  method: string,
  url: string,
  opts: { token?: string; cookie?: string; body?: Json } = {},
): Promise<{ status: number; json: Json; setCookies: string[] }> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(url, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json: Json = null;
  try {
    json = text === "" ? null : (JSON.parse(text) as Json);
  } catch {
    json = text.slice(0, 500);
  }
  return { status: res.status, json, setCookies: res.headers.getSetCookie() };
}

/** An agent-role canvas token (no cookie): enough for every read. */
async function agentToken(api: string, code: string): Promise<string> {
  const r = await http("POST", `${api}/api/mcp/auth`, { body: { code } });
  if (r.status !== 200 || !isObj(r.json) || typeof r.json.token !== "string")
    throw new Error(`POST /api/mcp/auth -> ${r.status}`);
  return r.json.token;
}

/** The local human: a session cookie from GET / and a canvas token minted with it. */
async function humanSession(api: string, code: string): Promise<{ cookie: string; token: string }> {
  const page = await http("GET", `${api}/`);
  const cookie = page.setCookies
    .map((c) => c.split(";")[0] as string)
    .find((c) => c.startsWith("tandem_session="));
  if (!cookie) throw new Error(`GET / set no tandem_session cookie (status ${page.status})`);
  const r = await http("POST", `${api}/api/mcp/auth`, { cookie, body: { code } });
  if (r.status !== 200 || !isObj(r.json) || typeof r.json.token !== "string")
    throw new Error(`POST /api/mcp/auth (human) -> ${r.status}`);
  return { cookie, token: r.json.token };
}

function listOf(j: Json, key: string): Obj[] {
  const arr = Array.isArray(j) ? j : isObj(j) && Array.isArray(j[key]) ? (j[key] as Json[]) : [];
  return arr.filter(isObj);
}

// ---------------------------------------------------------------------------------------------

async function freePort(): Promise<void> {
  const port = await new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const p = typeof a === "object" && a !== null ? a.port : 0;
      s.close(() => resolve(p));
    });
  });
  process.stdout.write(`${port}\n`);
}

async function waitHealthy(m: Map<string, string>): Promise<void> {
  const api = need(m, "api");
  const deadline = Date.now() + Number(m.get("timeout-s") ?? "60") * 1000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const r = await http("GET", `${api}/healthz`);
      if (r.status === 200 && isObj(r.json) && r.json.ok === true) {
        process.stdout.write(`${String(r.json.version ?? "unknown")}\n`);
        return;
      }
      last = `status ${r.status}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await sleep(250);
  }
  throw new Error(`Tandem at ${api} did not answer /healthz in time (${last})`);
}

/**
 * Turn the .mcp.json `tandem-mcp init` wrote into the config the agents get: the pinned gateway
 * binary instead of `npx -y @jaximus/tandem-mcp` (which would fetch whatever is newest), the
 * trial's API_URL, and TANDEM_AUTOSTART=0 so a gateway never starts its own server.
 */
function mcpConfig(m: Map<string, string>): void {
  const from = JSON.parse(readFileSync(need(m, "from"), "utf8")) as Json;
  const entry =
    isObj(from) && isObj(from.mcpServers) && isObj(from.mcpServers.tandem)
      ? from.mcpServers.tandem
      : undefined;
  const env = entry && isObj(entry.env) ? entry.env : undefined;
  const code = env?.TANDEM_CANVAS_CODE;
  if (typeof code !== "string" || !/^[A-Z0-9]{4,16}$/.test(code))
    throw new Error("tandem-mcp init wrote no TANDEM_CANVAS_CODE into .mcp.json");
  const out = {
    mcpServers: {
      tandem: {
        command: need(m, "gateway"),
        args: [],
        env: { TANDEM_CANVAS_CODE: code, API_URL: need(m, "api"), TANDEM_AUTOSTART: "0" },
      },
    },
  };
  writeFileSync(need(m, "out"), `${JSON.stringify(out, null, 2)}\n`);
  process.stdout.write(`${code}\n`);
}

interface BoardStatus {
  epics: number;
  epics_by_state: Record<string, number>;
  /** Approved epics whose every ticket is terminal (done or failed). */
  drained: number;
  tasks_by_state: Record<string, number>;
  /** Approved work exists (an approved epic, or an approved unepiced task). */
  has_approved_work: boolean;
  /** At least one approved epic, every approved epic drained, nothing proposed or open. */
  complete: boolean;
}

function add(into: Record<string, number>, from: Json | undefined): void {
  if (!isObj(from)) return;
  for (const [k, v] of Object.entries(from)) if (typeof v === "number") into[k] = (into[k] ?? 0) + v;
}

async function boardStatus(api: string, token: string): Promise<BoardStatus> {
  const r = await http("GET", `${api}/api/canvas/epics`, { token });
  if (r.status !== 200 || !isObj(r.json)) throw new Error(`GET /api/canvas/epics -> ${r.status}`);
  const epics = listOf(r.json.epics ?? [], "epics");
  const byState: Record<string, number> = {};
  const tasks: Record<string, number> = {};
  let drained = 0;
  let approvedOpen = 0;
  for (const e of epics) {
    const st = String(e.state);
    byState[st] = (byState[st] ?? 0) + 1;
    if (st === "rejected") continue;
    add(tasks, isObj(e.tasks) ? e.tasks.byState : undefined);
    if (st === "approved" || st === "done") {
      if (e.drained === true || st === "done") drained++;
      else approvedOpen++;
    }
  }
  const unepiced: Record<string, number> = {};
  add(unepiced, isObj(r.json.unepiced) ? r.json.unepiced.byState : undefined);
  add(tasks, unepiced);
  const live = (s: Record<string, number>) =>
    (s.proposed ?? 0) + (s.approved ?? 0) + (s.executing ?? 0);
  const approvedEpics = (byState.approved ?? 0) + (byState.done ?? 0);
  return {
    epics: epics.length,
    epics_by_state: byState,
    drained,
    tasks_by_state: tasks,
    has_approved_work: approvedEpics > 0 || (unepiced.approved ?? 0) + (unepiced.executing ?? 0) > 0,
    complete:
      approvedEpics > 0 && approvedOpen === 0 && (byState.proposed ?? 0) === 0 && live(tasks) === 0,
  };
}

async function status(m: Map<string, string>): Promise<void> {
  const api = need(m, "api");
  const s = await boardStatus(api, await agentToken(api, need(m, "code")));
  process.stdout.write(`${JSON.stringify(s)}\n`);
}

// ---------------------------------------------------------------------------------------------
// The built-in approver sidecar.

const BUILTIN_POLICIES = new Set(["auto", "human-sim"]);

async function approve(m: Map<string, string>): Promise<void> {
  const api = need(m, "api");
  const code = need(m, "code");
  const policy = need(m, "policy");
  const pollMs = Number(m.get("poll-s") ?? "2") * 1000;
  if (!BUILTIN_POLICIES.has(policy)) {
    process.stderr.write(
      `approver: policy '${policy}' is not built in (built in: auto, human-sim); ` +
        "install @anybench/approver (eval-approver, ticket 5.7) or set TANDEM_APPROVER_BIN\n",
    );
    process.exit(3);
  }
  const human = await humanSession(api, code);
  const log = (row: Obj) => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`);
  if (policy === "auto") {
    const r = await http("PATCH", `${api}/api/canvases/${encodeURIComponent(code)}/approval-policy`, {
      cookie: human.cookie,
      body: { approvalPolicy: "auto" },
    });
    if (r.status !== 200) throw new Error(`PATCH approval-policy auto -> ${r.status}`);
    log({ v: 1, simulated: true, kind: "tandem", event: "policy", policy: "auto" });
  }
  const seen = new Set<string>();
  let stop = false;
  process.on("SIGTERM", () => (stop = true));
  process.on("SIGINT", () => (stop = true));
  while (!stop) {
    // Epics first: approving an epic under the default `epic` policy approves its tickets.
    for (const type of ["epic", "task"]) {
      if (policy === "auto" && type === "task") continue; // born approved under `auto`
      const r = await http("GET", `${api}/api/canvas/actions?type=${type}&state=proposed`, {
        token: human.token,
      });
      if (r.status !== 200) continue;
      for (const a of listOf(r.json, "actions")) {
        const id = String(a.id);
        if (a.state !== "proposed" || seen.has(id)) continue;
        const res = await http("POST", `${api}/api/canvas/actions/${encodeURIComponent(id)}/approve`, {
          token: human.token,
          cookie: human.cookie,
          body: {},
        });
        seen.add(id);
        const created = typeof a.createdAt === "string" ? Date.parse(a.createdAt) : NaN;
        // Field names follow @anybench/approver's ApprovalEventSchema (decision, target,
        // decided_by, latency_ms, simulated), so one reader handles both approvers.
        log({
          v: 1,
          simulated: true,
          kind: "tandem",
          policy,
          decision: res.status === 200 ? "approve" : "approve_failed",
          target: { type, id, ...(typeof a.ticketId === "string" ? { ticket: a.ticketId } : {}) },
          decided_by: "human-sim",
          status: res.status,
          latency_ms: Number.isFinite(created) ? Math.max(0, Date.now() - created) : null,
        });
      }
    }
    await sleep(pollMs);
  }
}

// ---------------------------------------------------------------------------------------------

async function dump(m: Map<string, string>): Promise<void> {
  const api = need(m, "api");
  const out = need(m, "out");
  mkdirSync(out, { recursive: true });
  const token = await agentToken(api, need(m, "code"));
  const reads: [string, string, string | undefined][] = [
    ["epics.json", "/api/canvas/epics?full=1", token],
    ["actions.json", "/api/canvas/actions", token],
    ["agents.json", "/api/canvas/agents", token],
    ["gate.json", "/api/canvas/gate", token],
    ["metrics.json", "/api/metrics", undefined],
  ];
  for (const [file, path, tok] of reads) {
    const r = await http("GET", `${api}${path}`, tok ? { token: tok } : {});
    writeFileSync(join(out, file), `${JSON.stringify(r.status === 200 ? r.json : { status: r.status, error: r.json }, null, 2)}\n`);
  }
}

// ---------------------------------------------------------------------------------------------
// tap: one session's stream-json goes to its own file whole; run.sh's stdout gets only the two
// line types the runner's token cap (packages/runner token-cap.ts) reads, as compact lines. Every
// session's tap writes to the same stdout, and a line under PIPE_BUF (4 KiB) is written atomically,
// so lines from parallel sessions never interleave. The cost is forwarded as its JSON source text.

const COST = /"total_cost_usd"\s*:\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/;

async function tap(m: Map<string, string>): Promise<void> {
  const file = need(m, "file");
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    appendFileSync(file, `${line}\n`);
    let e: Json;
    try {
      e = JSON.parse(line) as Json;
    } catch {
      continue;
    }
    if (!isObj(e)) continue;
    if (e.type === "assistant" && isObj(e.message) && isObj(e.message.usage)) {
      const u = e.message.usage;
      const usage: Obj = {};
      for (const k of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"])
        if (typeof u[k] === "number") usage[k] = u[k];
      process.stdout.write(`${JSON.stringify({ type: "assistant", message: { id: e.message.id ?? null, usage } })}\n`);
    } else if (e.type === "result") {
      const cost = COST.exec(line)?.[1];
      if (cost !== undefined) process.stdout.write(`{"type":"result","total_cost_usd":${cost}}\n`);
    }
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const commands: Record<string, (m: Map<string, string>) => Promise<void> | void> = {
  "free-port": () => freePort(),
  "wait-healthy": waitHealthy,
  "mcp-config": mcpConfig,
  status,
  approve,
  dump,
  tap,
};
const run = cmd === undefined ? undefined : commands[cmd];
if (!run) {
  process.stderr.write(`usage: node board.ts <${Object.keys(commands).join("|")}> [--flag value...]\n`);
  process.exit(2);
}
try {
  await run(args(rest));
} catch (e) {
  process.stderr.write(`board.ts ${cmd}: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
