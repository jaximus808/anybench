// Ingest a Claude Code setup upload (CLAUDE.md, .claude/agents, .claude/skills, .claude/commands,
// .claude/settings*.json, .mcp.json) into a ProjectDigest with kind=harness (plan.md P2).
//
// Uploads routinely carry secrets (MCP server env, auth headers, keys pasted into CLAUDE.md).
// Every file's text comes back redacted: .mcp.json env and header values are replaced
// structurally (any length), their values (8+ chars) are then exact-matched in every other file,
// and the core key patterns (`sk-ant-...`, `ghp_...`, ...) run over everything.
import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, join, posix, relative, sep } from "node:path";
import {
  createRedactor,
  KitSha256Schema,
  ProjectDigestSchema,
  redactedToken,
  redactJson,
  type ProjectDigestInput,
  type SecretsInScope,
} from "@anybench/core";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const ClaudeSetupFileSchema = z.strictObject({
  /** POSIX path relative to the setup root, e.g. `.claude/agents/reviewer.md`. */
  path: z.string().min(1),
  bytes: z.int().min(0),
  /** sha256 of the original bytes. */
  sha256: KitSha256Schema,
  /** Redacted text. */
  text: z.string(),
});
export type ClaudeSetupFile = z.infer<typeof ClaudeSetupFileSchema>;

export const ClaudeSetupItemSchema = z.strictObject({
  name: z.string().min(1),
  path: z.string().min(1),
  description: z.string().optional(),
});
export type ClaudeSetupItem = z.infer<typeof ClaudeSetupItemSchema>;

export const ClaudeSetupMcpServerSchema = z.strictObject({
  name: z.string().min(1),
  /** `stdio` when it has a command, else the declared `type` (http, sse, ...). */
  transport: z.string().min(1),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  url: z.string().optional(),
  /** Names only; the values are never returned. */
  env_keys: z.array(z.string()).default([]),
  header_keys: z.array(z.string()).default([]),
});
export type ClaudeSetupMcpServer = z.infer<typeof ClaudeSetupMcpServerSchema>;

export const ClaudeSetupIngestResultSchema = z.strictObject({
  digest: ProjectDigestSchema,
  files: z.array(ClaudeSetupFileSchema),
  agents: z.array(ClaudeSetupItemSchema),
  skills: z.array(ClaudeSetupItemSchema),
  commands: z.array(ClaudeSetupItemSchema),
  mcp_servers: z.array(ClaudeSetupMcpServerSchema),
  /** Files present in the upload but not read (binary, too large, over the file cap). */
  skipped: z.array(z.strictObject({ path: z.string(), reason: z.string() })),
});
export type ClaudeSetupIngestResult = z.infer<typeof ClaudeSetupIngestResultSchema>;

export const ClaudeSetupIngestInputSchema = z.union([
  z.strictObject({
    /** Directory holding the extracted upload (CLAUDE.md and/or .claude/ and/or .mcp.json). */
    dir: z.string().min(1),
    name: z.string().min(1).optional(),
  }),
  z.strictObject({
    /** In-memory upload: relative POSIX path -> contents. */
    files: z.record(z.string().min(1), z.union([z.string(), z.instanceof(Uint8Array)])),
    name: z.string().min(1),
  }),
]);
export type ClaudeSetupIngestInput = z.input<typeof ClaudeSetupIngestInputSchema>;

export type ClaudeSetupIngestErrorCode = "invalid_input" | "empty_setup" | "bad_path";

export class ClaudeSetupIngestError extends Error {
  readonly code: ClaudeSetupIngestErrorCode;
  constructor(code: ClaudeSetupIngestErrorCode, message: string) {
    super(message);
    this.name = "ClaudeSetupIngestError";
    this.code = code;
  }
}

export interface ClaudeSetupIngestOptions {
  now?: () => Date;
  /** Extra secrets to redact (e.g. the uploader's known keys). */
  secrets?: SecretsInScope;
  /** Per-file cap. Default 1 MiB. */
  maxFileBytes?: number;
  /** File count cap. Default 500. */
  maxFiles?: number;
}

/** Which paths belong to a Claude Code setup. */
export function isClaudeSetupPath(p: string): boolean {
  return (
    p === "CLAUDE.md" || p === "CLAUDE.local.md" || p === ".mcp.json" || p.startsWith(".claude/")
  );
}

interface RawFile {
  path: string;
  data: Buffer;
}

function safeRel(p: string): string {
  const n = posix.normalize(p.replace(/\\/g, "/")).replace(/^\.\//, "");
  if (n.startsWith("/") || n === ".." || n.startsWith("../") || n.length === 0) {
    throw new ClaudeSetupIngestError("bad_path", `unsafe path in upload: ${p}`);
  }
  return n;
}

async function readDirFiles(
  root: string,
  maxFiles: number,
  skipped: ClaudeSetupIngestResult["skipped"],
  maxFileBytes: number,
): Promise<RawFile[]> {
  const out: RawFile[] = [];
  const visit = async (abs: string): Promise<void> => {
    const st = await lstat(abs).catch(() => undefined);
    if (!st) return;
    const rel = relative(root, abs).split(sep).join("/");
    if (st.isSymbolicLink()) {
      skipped.push({ path: rel, reason: "symlink" });
      return;
    }
    if (st.isDirectory()) {
      const ents = (await readdir(abs)).sort();
      for (const e of ents) await visit(join(abs, e));
      return;
    }
    if (!st.isFile()) return;
    if (out.length >= maxFiles) {
      skipped.push({ path: rel, reason: "file cap reached" });
      return;
    }
    if (st.size > maxFileBytes) {
      skipped.push({ path: rel, reason: `larger than ${maxFileBytes} bytes` });
      return;
    }
    out.push({ path: rel, data: await readFile(abs) });
  };
  for (const top of ["CLAUDE.md", "CLAUDE.local.md", ".mcp.json", ".claude"]) {
    await visit(join(root, top));
  }
  return out;
}

function parseFrontmatter(text: string): Record<string, unknown> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) return {};
  try {
    const v: unknown = parseYaml(m[1] ?? "");
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function item(path: string, fallbackName: string, text: string): ClaudeSetupItem {
  const fm = parseFrontmatter(text);
  const name = typeof fm.name === "string" && fm.name.trim() ? fm.name.trim() : fallbackName;
  const out: ClaudeSetupItem = { name, path };
  if (typeof fm.description === "string" && fm.description.trim()) {
    out.description = fm.description.trim();
  }
  return out;
}

const SECRETY_KEY = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|COOKIE|SESSION)/i;
const MIN_EXACT_SECRET = 8;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function isObj(v: unknown): v is Record<string, Json> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Structurally redact .mcp.json: every env value and header value becomes a `[REDACTED:...]`
 * token. Returns the redacted config, the server summaries and the original values (for exact
 * matching in other files).
 */
function redactMcpConfig(cfg: unknown): {
  redacted: unknown;
  servers: ClaudeSetupMcpServer[];
  secrets: Record<string, string>;
} {
  const secrets: Record<string, string> = {};
  const servers: ClaudeSetupMcpServer[] = [];
  if (!isObj(cfg)) return { redacted: cfg, servers, secrets };
  const redacted: Record<string, Json> = { ...cfg };
  const rawServers = cfg.mcpServers;
  if (!isObj(rawServers)) return { redacted, servers, secrets };
  const outServers: Record<string, Json> = {};
  for (const [sname, raw] of Object.entries(rawServers)) {
    if (!isObj(raw)) {
      outServers[sname] = raw;
      continue;
    }
    const s: Record<string, Json> = { ...raw };
    const summary: ClaudeSetupMcpServer = {
      name: sname,
      transport:
        typeof raw.command === "string"
          ? "stdio"
          : typeof raw.type === "string"
            ? raw.type
            : "unknown",
      args: Array.isArray(raw.args)
        ? raw.args.filter((a): a is string => typeof a === "string")
        : [],
      env_keys: [],
      header_keys: [],
    };
    if (typeof raw.command === "string") summary.command = raw.command;
    if (typeof raw.url === "string") summary.url = raw.url;
    for (const field of ["env", "headers"] as const) {
      const block = raw[field];
      if (!isObj(block)) continue;
      const rb: Record<string, Json> = {};
      for (const [k, v] of Object.entries(block)) {
        const tokenName = `MCP_${sname}_${field === "env" ? "" : "HEADER_"}${k}`;
        rb[k] = redactedToken(tokenName);
        if (typeof v === "string" && v.length >= MIN_EXACT_SECRET) secrets[tokenName] = v;
        // `Bearer <token>`: also catch the bare token elsewhere.
        if (typeof v === "string") {
          const bearer = /^\s*(?:Bearer|Basic|token)\s+(\S{8,})\s*$/i.exec(v);
          if (bearer?.[1]) secrets[`${tokenName}_VALUE`] = bearer[1];
        }
        (field === "env" ? summary.env_keys : summary.header_keys).push(k);
      }
      s[field] = rb;
    }
    outServers[sname] = s;
    servers.push(summary);
  }
  redacted.mcpServers = outServers;
  return { redacted, servers, secrets };
}

/** settings.json `env`: redact values whose key looks secret; returns the originals. */
function redactSettingsEnv(cfg: unknown): { redacted: unknown; secrets: Record<string, string> } {
  const secrets: Record<string, string> = {};
  if (!isObj(cfg) || !isObj(cfg.env)) return { redacted: cfg, secrets };
  const env: Record<string, Json> = {};
  for (const [k, v] of Object.entries(cfg.env)) {
    if (SECRETY_KEY.test(k) && typeof v === "string" && v.length > 0) {
      env[k] = redactedToken(k);
      if (v.length >= MIN_EXACT_SECRET) secrets[k] = v;
    } else env[k] = v;
  }
  return { redacted: { ...cfg, env }, secrets };
}

function isBinary(data: Buffer): boolean {
  return data.subarray(0, 8192).includes(0);
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function listed(items: readonly string[]): string {
  return items.length > 0 ? ` (${items.join(", ")})` : "";
}

/**
 * Ingest a Claude Code setup. Returns a harness digest plus the redacted files and what was
 * found in them. Throws ClaudeSetupIngestError on bad input or an upload with no setup files.
 */
export async function ingestClaudeSetup(
  rawInput: ClaudeSetupIngestInput,
  options: ClaudeSetupIngestOptions = {},
): Promise<ClaudeSetupIngestResult> {
  const parsed = ClaudeSetupIngestInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ClaudeSetupIngestError(
      "invalid_input",
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
    );
  }
  const input = parsed.data;
  const now = options.now ?? (() => new Date());
  const maxFileBytes = options.maxFileBytes ?? 1024 * 1024;
  const maxFiles = options.maxFiles ?? 500;
  const skipped: ClaudeSetupIngestResult["skipped"] = [];

  let raw: RawFile[];
  let name: string;
  if ("dir" in input) {
    raw = await readDirFiles(input.dir, maxFiles, skipped, maxFileBytes);
    name = input.name ?? basename(input.dir);
  } else {
    raw = [];
    for (const [p, v] of Object.entries(input.files)) {
      const path = safeRel(p);
      if (!isClaudeSetupPath(path)) {
        skipped.push({ path, reason: "not part of a Claude Code setup" });
        continue;
      }
      const data = typeof v === "string" ? Buffer.from(v, "utf8") : Buffer.from(v);
      if (data.length > maxFileBytes)
        skipped.push({ path, reason: `larger than ${maxFileBytes} bytes` });
      else if (raw.length >= maxFiles) skipped.push({ path, reason: "file cap reached" });
      else raw.push({ path, data });
    }
    raw.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    name = input.name;
  }
  const text = raw.filter((f) => {
    if (isBinary(f.data)) {
      skipped.push({ path: f.path, reason: "binary file" });
      return false;
    }
    return true;
  });
  if (text.length === 0) {
    throw new ClaudeSetupIngestError(
      "empty_setup",
      "no CLAUDE.md, .claude/ or .mcp.json text files found in the upload",
    );
  }

  // Pass 1: structured configs, collecting the secret values they hold.
  const secrets: Record<string, string> = {};
  for (const [k, v] of Object.entries(options.secrets ?? {})) {
    if (typeof v === "string" && v.length > 0) secrets[k] = v;
  }
  const structured = new Map<string, string>();
  let mcpServers: ClaudeSetupMcpServer[] = [];
  for (const f of text) {
    const isMcp = f.path === ".mcp.json";
    const isSettings = /^\.claude\/settings(\.local)?\.json$/.test(f.path);
    if (!isMcp && !isSettings) continue;
    let cfg: unknown;
    try {
      cfg = JSON.parse(f.data.toString("utf8"));
    } catch {
      continue; // left to the pattern redactor below
    }
    if (isMcp) {
      const r = redactMcpConfig(cfg);
      mcpServers = r.servers;
      Object.assign(secrets, r.secrets);
      structured.set(f.path, JSON.stringify(r.redacted, null, 2) + "\n");
    } else {
      const r = redactSettingsEnv(cfg);
      Object.assign(secrets, r.secrets);
      structured.set(f.path, JSON.stringify(r.redacted, null, 2) + "\n");
    }
  }

  // Pass 2: redact every file (exact values from pass 1, then the core key patterns).
  const redactor = createRedactor(secrets);
  const files: ClaudeSetupFile[] = text.map((f) => ({
    path: f.path,
    bytes: f.data.length,
    sha256: sha256(f.data),
    text: redactor(structured.get(f.path) ?? f.data.toString("utf8")),
  }));

  const agents: ClaudeSetupItem[] = [];
  const skills: ClaudeSetupItem[] = [];
  const commands: ClaudeSetupItem[] = [];
  for (const f of files) {
    let m: RegExpExecArray | null;
    if ((m = /^\.claude\/agents\/(.+)\.md$/.exec(f.path))) {
      agents.push(item(f.path, posix.basename(m[1] ?? f.path), f.text));
    } else if ((m = /^\.claude\/skills\/([^/]+)\/SKILL\.md$/i.exec(f.path))) {
      skills.push(item(f.path, m[1] ?? f.path, f.text));
    } else if ((m = /^\.claude\/commands\/(.+)\.md$/.exec(f.path))) {
      commands.push(item(f.path, (m[1] ?? f.path).replace(/\//g, ":"), f.text));
    }
  }
  const claudeMd = files.some((f) => f.path === "CLAUDE.md" || f.path === ".claude/CLAUDE.md");

  const names = (xs: readonly { name: string }[]): string[] => xs.map((x) => x.name);
  const summary =
    `Claude Code setup${claudeMd ? " with CLAUDE.md" : " without CLAUDE.md"}: ` +
    [
      plural(agents.length, "agent") + listed(names(agents)),
      plural(skills.length, "skill") + listed(names(skills)),
      plural(commands.length, "command") + listed(names(commands)),
      plural(mcpServers.length, "MCP server") + listed(names(mcpServers)),
    ].join(", ") +
    ".";

  // Cache key over the original bytes, in path order.
  const treeHash = createHash("sha256");
  for (const f of files) treeHash.update(`${f.path}\0${f.sha256}\n`);

  const digestInput: ProjectDigestInput = {
    source: { kind: "claude-code-setup", files: files.map((f) => f.path) },
    name: redactor(name),
    kind: "harness",
    summary: redactor(summary),
    entrypoints: agents.map((a) => ({ kind: "agent" as const, name: a.name, path: a.path })),
    docs: files
      .map((f) => f.path)
      .filter((p) => /(^|\/)CLAUDE(\.local)?\.md$/.test(p) || /\/SKILL\.md$/i.test(p)),
    claude_code: {
      claude_md: claudeMd,
      agents: names(agents),
      skills: names(skills),
      commands: names(commands),
      mcp_servers: names(mcpServers),
    },
    files: { count: files.length, total_bytes: files.reduce((n, f) => n + f.bytes, 0) },
    suggested_driver_types: ["harness", "coding-agent"],
    ingested_at: now().toISOString(),
    hash: treeHash.digest("hex"),
  };

  // Belt and braces: every string in the result (server args, URLs, names) goes through the
  // redactor once more; file texts are already redacted, so this is a no-op for them.
  return ClaudeSetupIngestResultSchema.parse(
    redactJson(
      {
        digest: ProjectDigestSchema.parse(digestInput),
        files,
        agents,
        skills,
        commands,
        mcp_servers: mcpServers,
        skipped,
      },
      redactor,
    ),
  );
}
