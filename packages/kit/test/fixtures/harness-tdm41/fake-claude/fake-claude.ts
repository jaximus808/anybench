// A stand-in for headless Claude Code in the harness driver tests (TDM-41). It costs nothing and
// needs no API key, but it drives the REAL Tandem board through the REAL MCP gateway named in
// `--mcp-config`, as `claude -p` would: initialize, tools/call canvas_connect, epic_propose,
// queue_next, task_claim, task_get, task_complete. Runs with Node 22.18+ type stripping (builtins
// only, erasable syntax) through the `claude` shim next to it.
//
// Role comes from the prompt run.sh rendered: "You are the Tandem planner" or
// "You are Tandem worker `worker-N`". The planner reads FAKE_PLAN.json from the workspace (the toy
// workload ships it) and proposes it as one epic; each ticket body carries a `FAKE_WRITE <path>
// <base64>` line that a worker applies. Output is stream-json with a final `result` line carrying
// a made-up cost, so the collector has something to sum.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type Obj = Record<string, unknown>;
const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write("0.0.0-fake (Claude Code stand-in, TDM-41)\n");
  process.exit(0);
}
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const prompt = opt("-p") ?? "";
const mcpPath = opt("--mcp-config");
if (!mcpPath) throw new Error("fake claude needs --mcp-config");
const disallowed: string[] = [];
const di = argv.indexOf("--disallowedTools");
for (let i = di + 1; di >= 0 && i < argv.length && !argv[i]!.startsWith("--"); i++)
  disallowed.push(argv[i]!);

const out = (e: Obj) => process.stdout.write(`${JSON.stringify(e)}\n`);
const started = Date.now();
let turns = 0;
let msg = 0;
out({
  type: "system",
  subtype: "init",
  model: opt("--model") ?? "fake-model",
  claude_code_version: "0.0.0-fake",
  session_id: `fake-${process.pid}`,
  // What reached this session (names and the model id only, never a secret's value).
  env_seen: {
    anthropic_base_url: process.env.ANTHROPIC_BASE_URL ?? null,
    anthropic_auth_token_set: process.env.ANTHROPIC_AUTH_TOKEN !== undefined,
    anthropic_api_key_set: process.env.ANTHROPIC_API_KEY !== undefined,
    anthropic_model: process.env.ANTHROPIC_MODEL ?? null,
    max_thinking_tokens: process.env.MAX_THINKING_TOKENS ?? null,
  },
  tools_disallowed: disallowed,
});

const cfg = JSON.parse(readFileSync(mcpPath, "utf8")) as {
  mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
};
const server = cfg.mcpServers.tandem;
if (!server) throw new Error("no tandem server in --mcp-config");
const code = server.env?.TANDEM_CANVAS_CODE ?? "";
const child = spawn(server.command, server.args ?? [], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, ...server.env },
});
let buf = "";
const waiting = new Map<number, (v: Obj) => void>();
child.stdout.on("data", (d: Buffer) => {
  buf += d.toString("utf8");
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line === "") continue;
    const m = JSON.parse(line) as Obj;
    const id = typeof m.id === "number" ? m.id : undefined;
    if (id !== undefined) waiting.get(id)?.(m);
  }
});
let nextId = 0;
const rpc = (method: string, params: Obj) =>
  new Promise<Obj>((resolve) => {
    const id = ++nextId;
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

let session: string | undefined;
async function tool(name: string, args: Obj): Promise<Obj> {
  turns++;
  const id = `msg_fake_${process.pid}_${++msg}`;
  out({
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      id,
      model: "fake-model",
      content: [{ type: "tool_use", name: `mcp__tandem__${name}` }],
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  });
  const r = await rpc("tools/call", { name, arguments: session ? { session, ...args } : args });
  const text =
    ((r.result as Obj | undefined)?.content as { text?: string }[] | undefined)?.[0]?.text ?? "{}";
  let j: Obj;
  try {
    j = JSON.parse(text) as Obj;
  } catch {
    j = { text };
  }
  if (typeof j.session === "string") session = j.session;
  out({ type: "user", message: { content: [{ type: "tool_result", is_error: false }] } });
  return j;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "fake-claude", version: "0" },
});
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

const worker = /You are Tandem worker `([^`]+)`/.exec(prompt)?.[1];
if (/You are the Tandem planner/.test(prompt)) {
  await tool("canvas_connect", { code, role: "planner", name: "planner" });
  // The toy workload ships FAKE_PLAN.json; any other workspace gets a two-note plan.
  const planFile = join(process.cwd(), "FAKE_PLAN.json");
  const plan = (
    existsSync(planFile)
      ? JSON.parse(readFileSync(planFile, "utf8"))
      : {
          title: "Notes",
          tickets: [
            { title: "note a", file: "NOTES-a.md", content: "a\n" },
            { title: "note b", file: "NOTES-b.md", content: "b\n" },
          ],
        }
  ) as { title: string; tickets: { title: string; file: string; content: string }[] };
  const tasks = plan.tickets.map((t) => ({
    title: t.title,
    body: `Surface: ${t.file}. Done when ${t.file} exists with the content below and the tests pass.\nFAKE_WRITE ${t.file} ${Buffer.from(t.content).toString("base64")}`,
  }));
  await tool("epic_propose", {
    title: plan.title,
    body: "Toy epic for the harness driver test.",
    tasks,
  });
} else if (worker) {
  await tool("canvas_connect", { code, role: "executor", name: worker });
  const deadline = Date.now() + 120_000;
  let idle = 0;
  while (Date.now() < deadline && idle < 6) {
    const q = await tool("queue_next", {});
    const ready = (Array.isArray(q.tasks) ? q.tasks : []) as Obj[];
    if (ready.length === 0) {
      idle++;
      await sleep(1000);
      continue;
    }
    idle = 0;
    // Every worker goes for the first ready ticket, so parallel workers really race for it.
    const id = String(ready[0]!.ticketId ?? ready[0]!.id);
    const c = await tool("task_claim", { id });
    if (c.claimed !== true) continue;
    const t = await tool("task_get", { id });
    const body = String(((t.action as Obj | undefined)?.payload as Obj | undefined)?.body ?? "");
    for (const m of body.matchAll(/^FAKE_WRITE (\S+) (\S+)$/gm)) {
      const file = join(process.cwd(), m[1]!);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, Buffer.from(m[2]!, "base64"));
    }
    await sleep(500);
    await tool("task_complete", { id, result: `wrote the files named in ${id}` });
  }
} else {
  throw new Error("fake claude: unknown role (prompt is neither planner nor worker)");
}

child.kill();
out({
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: Date.now() - started,
  num_turns: turns,
  total_cost_usd: 0.0125,
  usage: {
    input_tokens: turns * 100,
    output_tokens: turns * 20,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
  modelUsage: {
    "fake-model": {
      inputTokens: turns * 100,
      outputTokens: turns * 20,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: 0.0125,
    },
  },
  permission_denials: [],
});
process.exit(0);
