/* eslint-disable @typescript-eslint/no-explicit-any -- spike scripts read untyped JSON */
// TDM-162 [15.1a] spike helpers. Keys are read from the repo's .env file with quotes and
// whitespace stripped (a shell `source` of .env gave Monid 401s). Nothing here prints a key:
// every logged string goes through `redact`, and the raw log lives in $SPIKE_OUT (default: a
// scratch dir outside the repo).
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Find .env: $ANYBENCH_ENV_FILE, else walk up from this file (worktrees fall back to the main checkout). */
function envPath(): string {
  const explicit = process.env.ANYBENCH_ENV_FILE;
  if (explicit) return explicit;
  const candidates = [
    join(here, "../../../.env"),
    join(here, "../../../../../anybench/.env"), // worktree at ../anybench-wt/<ticket>
  ];
  for (const c of candidates) {
    try {
      readFileSync(c, "utf8");
      return c;
    } catch {
      /* try next */
    }
  }
  throw new Error("no .env found; set ANYBENCH_ENV_FILE");
}

/** Parse KEY=VALUE lines, stripping inline comments, surrounding quotes and whitespace. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const q = value[0]!;
      const end = value.indexOf(q, 1);
      value = end > 0 ? value.slice(1, end) : value.slice(1);
    } else {
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash);
    }
    out[key] = value.trim();
  }
  return out;
}

const env = parseDotEnv(readFileSync(envPath(), "utf8"));
const secrets: string[] = [];

export function key(name: string, required = true): string {
  const v = env[name] ?? "";
  if (!v && required) throw new Error(`${name} is empty in .env`);
  if (v) secrets.push(v);
  return v;
}

export function redact(text: string): string {
  let out = text;
  for (const s of secrets) if (s.length >= 8) out = out.split(s).join("[REDACTED]");
  return out;
}

const outDir = process.env.SPIKE_OUT ?? join(tmpdir(), "anybench-outreach-spike");
mkdirSync(outDir, { recursive: true });

/** Append one call (request + response) to the raw JSONL log and print a trimmed line. */
export function record(step: string, data: unknown): void {
  const line = redact(JSON.stringify({ at: new Date().toISOString(), step, data }));
  appendFileSync(join(outDir, "outreach-spike.jsonl"), line + "\n");
  console.log(`--- ${step}\n${redact(JSON.stringify(data, null, 2)).slice(0, 4000)}`);
}

export async function http(
  url: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  const res = await fetch(url, { ...init, headers, body });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep text */
  }
  const h: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (/ratelimit|credit|cost|request-id|x-request/i.test(k)) h[k] = v;
  });
  return { status: res.status, headers: h, body: parsed };
}

/** POST /v1/run on Monid. Always passes maxCost (USD float, Monid's wire format). */
export async function monidRun(
  provider: string,
  endpoint: string,
  input: { body?: unknown; queryParams?: unknown; pathParams?: unknown },
  maxCost: number,
): Promise<{ status: number; body: any }> {
  const k = key("MONID_API_KEY");
  const request = { provider, endpoint, input, maxCost };
  const res = await http("https://api.monid.ai/v1/run", {
    method: "POST",
    headers: { authorization: `Bearer ${k}` },
    json: request,
  });
  record(`monid run ${provider} ${endpoint}`, { request, ...res });
  return res as { status: number; body: any };
}

export async function monidGet(path: string): Promise<any> {
  const k = key("MONID_API_KEY");
  const res = await http(`https://api.monid.ai${path}`, {
    headers: { authorization: `Bearer ${k}` },
  });
  record(`monid GET ${path}`, res);
  return res.body;
}
