// TDM-16 [2.2] spike: Claude Code on a Naïve computer, with model tokens from the Naïve proxy.
//
// Run: ENV_FILE=<repo>/.env SPIKE_STATE=<0600 json file> ../naive-hosting/run.sh spike.ts <cmd>
// (run.sh loads .env into the process with `node --env-file` and sets NAIVE_LIVE=1.)
// Secrets: NAIVE_API_KEY and the minted proxy key are never printed. The proxy key reaches the
// computer only through `fs write` into a file that is then chmod 600; never on an exec argv.
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const sdkPath = join(
  root,
  "packages/naive/node_modules/@usenaive-sdk/managed-agents/dist/index.js",
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sdk: any = await import(sdkPath);

const BASE = process.env.NAIVE_BASE_URL ?? "https://api.vetta.sh";
const STATE = process.env.SPIKE_STATE;
const LOG = process.env.SPIKE_LOG;
if (process.env.NAIVE_LIVE !== "1")
  throw new Error("set NAIVE_LIVE=1 (use ../naive-hosting/run.sh)");
const adminKey = process.env.NAIVE_API_KEY;
if (!adminKey) throw new Error("missing NAIVE_API_KEY");

interface State {
  helperKeyId?: string;
  keyId?: string;
  keySecret?: string;
  computerId?: string;
}
function readState(): State {
  if (!STATE || !existsSync(STATE)) return {};
  return JSON.parse(readFileSync(STATE, "utf8")) as State;
}
function writeState(s: State): void {
  if (!STATE) throw new Error("set SPIKE_STATE");
  writeFileSync(STATE, JSON.stringify(s), { mode: 0o600 });
  chmodSync(STATE, 0o600);
}

function redact(v: unknown): string {
  let out = typeof v === "string" ? v : JSON.stringify(v);
  const st = readState();
  for (const s of [adminKey, st.keySecret])
    if (s && s.length >= 8) out = out.split(s).join("<secret>");
  return out
    .replace(/sk_(live|test)_[A-Za-z0-9_-]+/g, "sk_<redacted>")
    .replace(/mcp_[A-Za-z0-9]{12,}/g, "mcp_<redacted>");
}
function log(step: string, data: unknown): void {
  const line = redact({ at: new Date().toISOString(), step, data });
  console.log(line.length > 6000 ? line.slice(0, 6000) + "…" : line);
  if (LOG) appendFileSync(LOG, line + "\n");
}
async function step<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  const t0 = Date.now();
  try {
    const result = await fn();
    log(label, { ok: true, ms: Date.now() - t0, result });
    return result;
  } catch (e) {
    const err = e as { status?: number; code?: string; message?: string; requestId?: string };
    log(label, {
      ok: false,
      ms: Date.now() - t0,
      status: err.status,
      code: err.code,
      message: err.message,
      requestId: err.requestId,
    });
    return undefined;
  }
}

const admin = sdk.createClient({ apiKey: adminKey, baseUrl: BASE });

async function listAll(
  fn: (q: {
    limit: number;
    after?: string;
  }) => Promise<{ data: unknown[]; has_more: boolean; next_cursor: string | null }>,
) {
  const all: unknown[] = [];
  let after: string | undefined;
  for (let i = 0; i < 20; i++) {
    const page = await fn({ limit: 100, ...(after ? { after } : {}) });
    all.push(...page.data);
    if (!page.has_more || !page.next_cursor) break;
    after = page.next_cursor;
  }
  return all;
}

async function rawProxy(path: string, body: unknown, headers: Record<string, string> = {}) {
  const secret = readState().keySecret;
  if (!secret) throw new Error("mint first");
  const t0 = Date.now();
  const res = await fetch(`${BASE}/v1/proxy/anthropic${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": secret,
      "anthropic-version": "2023-06-01",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    ms: Date.now() - t0,
    requestId: res.headers.get("x-request-id"),
    body: text.slice(0, 3000),
  };
}

const cmd = process.argv[2];
const arg = process.argv[3];

switch (cmd) {
  case "discover": {
    await step("auth.me", () => admin.auth.me());
    await step("credits.show", () => admin.credits.show());
    for (const search of ["claude", "anthropic", "opus", "sonnet", "haiku"]) {
      await step(`models.list search=${search}`, () =>
        listAll((q) => admin.models.list({ ...q, search })),
      );
    }
    await step("harnesses.list", () => listAll((q) => admin.harnesses.list(q)));
    await step("harnesses.retrieve claude_code", () => admin.harnesses.retrieve("claude_code"));
    break;
  }
  case "models-all": {
    const all = (await listAll((q) => admin.models.list(q))) as { id: string }[];
    log("models.list all ids", { count: all.length, ids: all.map((m) => m.id) });
    break;
  }
  case "model": {
    await step(`models.retrieve ${arg}`, () => admin.models.retrieve(arg));
    break;
  }
  case "mint": {
    const key = await step("keys.create proxy:write", () =>
      admin.keys.create({ name: "tdm16-spike-proxy", scopes: ["proxy:write"] }),
    );
    if (key)
      writeState({
        ...readState(),
        keyId: (key as { id: string }).id,
        keySecret: (key as { secret: string }).secret,
      });
    break;
  }
  case "whoami-proxy": {
    const c = sdk.createClient({ apiKey: readState().keySecret, baseUrl: BASE });
    await step("auth.me (proxy key)", () => c.auth.me());
    await step("credits.show (proxy key)", () => c.credits.show());
    await step("computers.list (proxy key)", () => c.computers.list({ limit: 5 }));
    break;
  }
  case "probe": {
    // arg = model id. Plain call, then the fields Claude Code sends.
    const model = arg;
    const base = {
      model,
      max_tokens: 64,
      messages: [{ role: "user", content: "Reply with the word OK." }],
    };
    log("probe plain", await rawProxy("/v1/messages", base));
    log("probe stream", await rawProxy("/v1/messages", { ...base, stream: true }));
    log(
      "probe cache_control",
      await rawProxy("/v1/messages", {
        ...base,
        system: [{ type: "text", text: "You are terse.", cache_control: { type: "ephemeral" } }],
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Reply OK.", cache_control: { type: "ephemeral" } }],
          },
        ],
      }),
    );
    log(
      "probe thinking enabled",
      await rawProxy("/v1/messages", {
        ...base,
        max_tokens: 2048,
        thinking: { type: "enabled", budget_tokens: 1024 },
      }),
    );
    log(
      "probe beta header",
      await rawProxy("/v1/messages", base, {
        "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14",
      }),
    );
    log(
      "probe count_tokens",
      await rawProxy("/v1/messages/count_tokens", { model, messages: base.messages }),
    );
    break;
  }
  case "computer-create": {
    let c: unknown;
    for (let attempt = 1; attempt <= 6 && !c; attempt++) {
      c = await step(`computers.create attempt ${attempt}`, () =>
        admin.computers.create({ name: "tdm16-cc-proxy", vcpu: 2, memory_mb: 4096, disk_gb: 10 }),
      );
      if (!c) await new Promise((r) => setTimeout(r, 20000));
    }
    if (!c) throw new Error("no computer");
    writeState({ ...readState(), computerId: (c as { id: string }).id });
    for (let i = 0; i < 40; i++) {
      const g = (await admin.computers.get(readState().computerId)) as { status: string };
      if (g.status === "running") break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    await step("computers.get", () => admin.computers.get(readState().computerId));
    break;
  }
  case "exec": {
    // arg = shell command (must not contain secrets). Optional timeout ms in argv[4].
    const timeout_ms = Number(process.argv[4] ?? 120000);
    for (let attempt = 1; attempt <= 8; attempt++) {
      const r = await step(`exec#${attempt} ${arg.slice(0, 200)}`, () =>
        admin.computers.exec(readState().computerId, arg, timeout_ms),
      );
      if (r) break;
      await new Promise((res) => setTimeout(res, 20000));
    }
    break;
  }
  case "write-env": {
    // arg = model id for ANTHROPIC_MODEL. Writes ~/.anybench/cc.env via fs (never argv), then chmod 600.
    const st = readState();
    const env = [
      `ANTHROPIC_BASE_URL=${BASE}/v1/proxy/anthropic`,
      `ANTHROPIC_AUTH_TOKEN=${st.keySecret}`,
      `ANTHROPIC_MODEL=${arg}`,
      `ANTHROPIC_SMALL_FAST_MODEL=${process.argv[4] ?? arg}`,
      `ANTHROPIC_DEFAULT_HAIKU_MODEL=${process.argv[4] ?? arg}`,
      `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`,
      `DISABLE_TELEMETRY=1`,
      `DISABLE_ERROR_REPORTING=1`,
      "",
    ].join("\n");
    await step("fs mkdir ~/.anybench", () =>
      admin.computers.fs(st.computerId, "mkdir", { path: "/home/naive/.anybench" }),
    );
    await step("fs write ~/.anybench/cc.env", () =>
      admin.computers.fs(st.computerId, "write", {
        path: "/home/naive/.anybench/cc.env",
        encoding: "base64",
        content: Buffer.from(env).toString("base64"),
      }),
    );
    await step("exec chmod", () =>
      admin.computers.exec(
        st.computerId,
        "chmod 600 ~/.anybench/cc.env && ls -l ~/.anybench/cc.env && wc -l ~/.anybench/cc.env",
        20000,
      ),
    );
    break;
  }
  case "provision": {
    // The packages/naive helper end to end: mint a trial key + write ~/.anybench/proxy.env.
    const naive = await import(join(root, "packages/naive/dist/index.js"));
    const keys = naive.liveProxyKeys({ apiKey: adminKey, baseUrl: BASE });
    const computers = naive.createNaiveClient({ apiKey: adminKey, baseUrl: BASE }).computers;
    const out = await step("provisionClaudeCodeProxyEnv", async () => {
      const r = await naive.provisionClaudeCodeProxyEnv(
        { keys, computers },
        {
          trialId: "tdm16-spike",
          computerId: readState().computerId,
          baseUrl: BASE,
          model: arg,
          smallFastModel: process.argv[4],
        },
      );
      writeState({ ...readState(), helperKeyId: r.credential.keyId });
      return {
        keyId: r.credential.keyId,
        anthropicBaseUrl: r.credential.anthropicBaseUrl,
        envFile: r.envFile,
      };
    });
    if (out)
      await step("exec ls+names", () =>
        admin.computers.exec(
          readState().computerId,
          "ls -l ~/.anybench/ && cut -d= -f1 ~/.anybench/proxy.env | tr '\\n' ' '",
          20000,
        ),
      );
    break;
  }
  case "put": {
    // put <local file> <fs path under /home/naive>; for non-secret test fixtures only.
    const dest = process.argv[4];
    await step(`fs mkdir ${dirname(dest)}`, () =>
      admin.computers.fs(readState().computerId, "mkdir", { path: dirname(dest) }),
    );
    await step(`fs write ${dest}`, () =>
      admin.computers.fs(readState().computerId, "write", {
        path: dest,
        encoding: "base64",
        content: readFileSync(arg).toString("base64"),
      }),
    );
    break;
  }
  case "scope-probe": {
    // Mint a fresh trial proxy:write key (and an MCP-session credential), then call every route that
    // could reach a computer, an agent or a session, against made-up ids / invalid bodies.
    // 403 = scope blocks the route; 400/404 = the scope lets the request through to the handler.
    const naive = await import(join(root, "packages/naive/dist/index.js"));
    const keys = naive.liveProxyKeys({ apiKey: adminKey, baseUrl: BASE });
    const cred = await naive.mintTrialProxyCredential(keys, {
      trialId: "tdm16-scope-probe",
      baseUrl: BASE,
    });
    writeState({ ...readState(), keyId: cred.keyId, keySecret: naive.trialProxySecret(cred) });
    log("minted", { keyId: cred.keyId, credJson: JSON.parse(JSON.stringify(cred)) });
    const mcs = await step("mcpSessions.create proxy:write", () =>
      admin.mcpSessions.create({
        name: "tdm16-scope-probe",
        scopes: ["proxy:write"],
        allowed_tools: ["models_list_catalog"],
        expires_in_seconds: 300,
      }),
    );
    const mcsSecret = (mcs as { secret?: string } | undefined)?.secret;
    const mcsId = (mcs as { id?: string } | undefined)?.id;
    const FAKE = "cmp_00000000000000000000000000000000";
    const routes: Array<[string, string, unknown]> = [
      ["POST", `/v1/computers/${FAKE}/exec`, { command: "true" }],
      ["POST", `/v1/computers/${FAKE}/fs/read`, { path: "/home/naive/x" }],
      [
        "POST",
        `/v1/computers/${FAKE}/fs/write`,
        { path: "/home/naive/x", encoding: "base64", content: "" },
      ],
      ["POST", `/v1/computers/${FAKE}/fs/remove`, { path: "/home/naive/x" }],
      ["POST", `/v1/computers/${FAKE}/fs/list`, { path: "/home/naive" }],
      ["DELETE", `/v1/computers/${FAKE}`, undefined],
      ["POST", `/v1/computers/${FAKE}/pause`, {}],
      ["POST", `/v1/computers/${FAKE}/resume`, {}],
      ["POST", `/v1/computers/${FAKE}/snapshot`, {}],
      ["PATCH", `/v1/computers/${FAKE}`, { name: "x" }],
      ["GET", `/v1/computers/${FAKE}`, undefined],
      ["GET", `/v1/computers/${FAKE}/inspect`, undefined],
      ["GET", `/v1/computers/${FAKE}/commands`, undefined],
      ["GET", `/v1/computers`, undefined],
      ["POST", `/v1/computers`, { vcpu: -1, memory_mb: 1 }],
      ["POST", `/v1/sessions`, { agent_id: "agt_00000000000000000000000000", message: 1 }],
      ["POST", `/v1/agents`, { name: 1 }],
      ["GET", `/v1/agents`, undefined],
      ["GET", `/v1/sessions`, undefined],
      ["POST", `/v1/api_keys`, { name: 1 }],
      ["POST", `/v1/mcp_sessions`, { name: 1 }],
      ["GET", `/v1/proxy/calls`, undefined],
      ["GET", `/v1/credits/ledger`, undefined],
      ["GET", `/v1/files`, undefined],
      ["POST", `/v1/apps`, { name: 1 }],
    ];
    const probe = async (label: string, token: string) => {
      const rows: Array<Record<string, unknown>> = [];
      for (const [method, path, body] of routes) {
        const res = await fetch(`${BASE}${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await res.text();
        let code: string | undefined;
        let message: string | undefined;
        try {
          const j = JSON.parse(text) as { error?: { code?: string; message?: string } };
          code = j.error?.code;
          message = j.error?.message?.slice(0, 120);
        } catch {
          /* not json */
        }
        rows.push({
          method,
          path: path.replace(FAKE, "<fake>"),
          status: res.status,
          code,
          message,
          body: code ? undefined : text.slice(0, 120),
        });
      }
      log(`scope probe (${label})`, rows);
    };
    await probe("trial proxy:write key", naive.trialProxySecret(cred));
    if (mcsSecret) {
      log(
        "proxy call with mcp-session bearer",
        await (async () => {
          const res = await fetch(`${BASE}/v1/proxy/anthropic/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${mcsSecret}` },
            body: JSON.stringify({
              model: "anthropic/claude-haiku-4.5",
              max_tokens: 8,
              messages: [{ role: "user", content: "Reply OK." }],
            }),
          });
          return { status: res.status, body: (await res.text()).slice(0, 400) };
        })(),
      );
      await probe("mcp-session proxy:write", mcsSecret);
    }
    log(
      "proxy call with trial key",
      await rawProxy("/v1/messages", {
        model: "anthropic/claude-haiku-4.5",
        max_tokens: 8,
        messages: [{ role: "user", content: "Reply OK." }],
      }),
    );
    if (mcsId) await step("mcpSessions.revoke", () => admin.mcpSessions.revoke(mcsId));
    await step("revokeTrialProxyCredential", () => naive.revokeTrialProxyCredential(keys, cred));
    log(
      "proxy call after revoke",
      await rawProxy("/v1/messages", {
        model: "anthropic/claude-haiku-4.5",
        max_tokens: 8,
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    writeState({});
    break;
  }
  case "mcs-probe": {
    // Can a proxy:write key mint an MCP session (which could carry wider scopes)? Revokes anything made.
    const naive = await import(join(root, "packages/naive/dist/index.js"));
    const keys = naive.liveProxyKeys({ apiKey: adminKey, baseUrl: BASE });
    const cred = await naive.mintTrialProxyCredential(keys, {
      trialId: "tdm16-mcs-probe",
      baseUrl: BASE,
    });
    writeState({ ...readState(), keyId: cred.keyId, keySecret: naive.trialProxySecret(cred) });
    for (const body of [
      { name: "tdm16-mcs-probe" },
      {
        name: "tdm16-mcs-probe",
        scopes: ["computers:write"],
        allowed_tools: ["computers_exec_command"],
        expires_in_seconds: 60,
      },
      {
        name: "tdm16-mcs-probe",
        scopes: ["proxy:write"],
        allowed_tools: ["models_list_catalog"],
        expires_in_seconds: 60,
      },
    ]) {
      const res = await fetch(`${BASE}/v1/mcp_sessions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${naive.trialProxySecret(cred)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      log(`POST /v1/mcp_sessions ${JSON.stringify(body)}`, {
        status: res.status,
        body: text.slice(0, 300),
      });
      const id = (() => {
        try {
          return (JSON.parse(text) as { id?: string }).id;
        } catch {
          return undefined;
        }
      })();
      if (res.ok && id) await step(`admin revoke ${id}`, () => admin.mcpSessions.revoke(id));
    }
    await step("revokeTrialProxyCredential", () => naive.revokeTrialProxyCredential(keys, cred));
    writeState({});
    break;
  }
  case "traces": {
    await step("proxy.calls", async () => {
      const page = (await admin.proxy.calls({ limit: Number(arg ?? 10) })) as {
        data: Record<string, unknown>[];
      };
      return page.data.map((c) => ({
        id: c.id,
        created_at: c.created_at,
        model: c.model,
        resolved_model: c.resolved_model,
        provider: c.provider,
        window: c.window,
        usage: c.usage,
        stop: c.stop,
        duration_ms: c.duration_ms,
        billed_micro_usd: c.billed_micro_usd,
        vendor_cost_micro_usd: c.vendor_cost_micro_usd,
        actor: c.actor,
        source: c.source,
        request_bytes: c.request_bytes,
      }));
    });
    break;
  }
  case "ledger": {
    await step("credits.ledger", () => admin.credits.ledger({ limit: Number(arg ?? 10) }));
    break;
  }
  case "cleanup": {
    const st = readState();
    if (st.keyId) await step("keys.revoke", () => admin.keys.revoke(st.keyId));
    if (st.helperKeyId) await step("keys.revoke helper", () => admin.keys.revoke(st.helperKeyId));
    if (st.keySecret)
      log(
        "proxy call with revoked key",
        await rawProxy("/v1/messages", {
          model: "anthropic/claude-haiku-4.5",
          max_tokens: 8,
          messages: [{ role: "user", content: "hi" }],
        }),
      );
    if (st.computerId) await step("computers.delete", () => admin.computers.delete(st.computerId));
    await step("computers.list after", () => admin.computers.list({ limit: 20 }));
    await step("credits.show after", () => admin.credits.show());
    writeState({});
    break;
  }
  default:
    throw new Error(`unknown cmd ${cmd}`);
}
