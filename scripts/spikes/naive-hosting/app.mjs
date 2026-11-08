// TDM-170 part 2: a Naïve `fullstack` app serving a minimal Hono app.
// Usage: SPIKE_STATE=<file> ./run.sh app.mjs <cmd> [args]
//   create | deploy <dir> | wait | secret | health | sleep <s> | sse <s> | mcp-noauth | info | delete
/* global process, fetch, TextDecoder */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { naive, step, log, sleep } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const STATE = process.env.SPIKE_STATE ?? join(here, ".state.json");
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));
const c = naive();
const [cmd, arg] = process.argv.slice(2);
const appId = () =>
  state.appId ??
  (() => {
    throw new Error("no appId in state");
  })();

function fileMap(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = readFileSync(p).toString("base64");
    }
  };
  walk(dir);
  return out;
}

async function timed(url, init) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, init);
    const text = await r.text();
    return {
      status: r.status,
      ms: Date.now() - t0,
      headers: Object.fromEntries(
        [...r.headers].filter(([k]) =>
          /^(x-vercel|server|content-type|x-matched|age|cache)/.test(k),
        ),
      ),
      body: text.slice(0, 1500),
    };
  } catch (e) {
    return { error: String(e?.cause?.code ?? e?.message ?? e), ms: Date.now() - t0 };
  }
}

const base = () =>
  state.appUrl ??
  (() => {
    throw new Error("no appUrl");
  })();

switch (cmd) {
  case "create": {
    const a = await step(
      "apps.create fullstack mcp=/mcp",
      () =>
        c.apps.create({
          name: "tdm170-spike",
          type: "fullstack",
          mcp: "/mcp",
          description: "TDM-170 hosting spike (delete me)",
        }),
      { rethrow: true },
    );
    state.appId = a.id;
    save();
    for (let i = 0; i < 60; i++) {
      const g = await c.apps.get(a.id);
      if (g.status !== "provisioning") {
        log("apps.get (terminal)", { after_s: i * 5, app: g });
        state.appUrl = g.url;
        save();
        break;
      }
      await sleep(5000);
    }
    break;
  }
  case "deploy": {
    const dir = join(here, arg ?? "app");
    const files = fileMap(dir);
    const hash = createHash("sha256").update(JSON.stringify(files)).digest("hex");
    log("deploy file list", Object.keys(files));
    const d = await step(`apps.deploy ${arg}`, () => c.apps.deploy(appId(), files, hash), {
      rethrow: true,
    });
    state.lastDeployment = d.id;
    save();
    const t0 = Date.now();
    let last = "";
    for (let i = 0; i < 120; i++) {
      const page = await c.apps.deployments(appId(), { limit: 1 });
      const row = page.data[0];
      if (row.status !== last) {
        log("apps.deployments status", { after_s: Math.round((Date.now() - t0) / 1000), row });
        last = row.status;
      }
      if (row.status === "ready" || row.status === "error") {
        if (row.url) {
          state.deployUrl = row.url;
          save();
        }
        break;
      }
      await sleep(5000);
    }
    const g = await step("apps.get", () => c.apps.get(appId()));
    if (g?.url) {
      state.appUrl = g.url;
      save();
    }
    break;
  }
  case "secret": {
    const value = randomBytes(18).toString("hex");
    state.secretSha8 = createHash("sha256").update(value).digest("hex").slice(0, 8);
    save();
    await step("apps.setSecret SPIKE_SECRET (value not logged)", () =>
      c.apps.setSecret(appId(), { name: "SPIKE_SECRET", value }),
    );
    log("expected SPIKE_SECRET sha256_8", state.secretSha8);
    await step("apps.secrets", () => c.apps.secrets(appId()));
    await step("apps.setSecret VETTA_MCP_TOKEN (expect forbidden)", () =>
      c.apps.setSecret(appId(), { name: "VETTA_MCP_TOKEN", value: "x" }),
    );
    break;
  }
  case "health":
    for (let i = 0; i < Number(arg ?? 3); i++)
      log(`GET /health #${i + 1}`, await timed(`${base()}/health`));
    break;
  case "path":
    log(`GET ${arg}`, await timed(`${base()}${arg}`));
    break;
  case "sleep":
    log(`GET /sleep?seconds=${arg}`, await timed(`${base()}/sleep?seconds=${arg}`));
    break;
  case "sse": {
    const t0 = Date.now();
    const r = await fetch(`${base()}/sse?seconds=${arg ?? 90}`, {
      headers: { accept: "text/event-stream" },
    });
    log("GET /sse headers", {
      status: r.status,
      ms_to_headers: Date.now() - t0,
      headers: Object.fromEntries(r.headers),
    });
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "",
      events = 0,
      firstAt = null,
      lastEvt = "",
      chunks = 0;
    const arrivals = [];
    try {
      for (let n = await reader.read(); !n.done; n = await reader.read()) {
        chunks += 1;
        buf += dec.decode(n.value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop();
        for (const p of parts) {
          if (!p.trim()) continue;
          events += 1;
          lastEvt = p.replace(/\n/g, " | ");
          const at = Date.now() - t0;
          firstAt ??= at;
          if (events <= 3 || events % 15 === 0) arrivals.push({ events, at_ms: at });
        }
      }
      log("GET /sse ended", {
        events,
        chunks,
        first_event_ms: firstAt,
        total_ms: Date.now() - t0,
        arrivals,
        last: lastEvt,
      });
    } catch (e) {
      log("GET /sse error", {
        events,
        chunks,
        total_ms: Date.now() - t0,
        arrivals,
        last: lastEvt,
        error: String(e?.cause?.code ?? e?.message ?? e),
      });
    }
    break;
  }
  case "mcp-noauth":
    log(
      "POST /mcp no auth",
      await timed(`${base()}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    log(
      "POST /mcp wrong bearer",
      await timed(`${base()}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer nope" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    break;
  case "info":
    await step("apps.get", () => c.apps.get(appId()));
    await step("apps.deployments", () => c.apps.deployments(appId(), { limit: 10 }));
    await step("apps.permissions", () => c.apps.permissions(appId()));
    await step("apps.domains", () => c.apps.domains(appId()));
    await step("apps.access (url only logged)", async () => {
      const a = await c.apps.access(appId());
      return { url: a.url, password_set: a.password !== null };
    });
    break;
  case "delete":
    await step("apps.delete", () => c.apps.delete(appId()));
    break;
  default:
    log(
      "usage",
      "create|deploy <dir>|secret|health [n]|path <p>|sleep <s>|sse <s>|mcp-noauth|info|delete",
    );
}
