// TDM-34 [4.2]: ingest a GitHub repo (or a local git checkout) into a ProjectDigest.
//
// Everything goes through the git CLI. A GitHub repo is fetched into a temp dir with
// `--depth 200 --filter=blob:limit=1m` and never checked out: the tree, the few files we read
// (README, manifests, .mcp.json) and the commit log all come from git objects. A local repo is read
// the same way from its HEAD commit, read-only (no checkout, no index refresh, no writes).
//
// GITHUB_TOKEN (optional) reaches git through GIT_CONFIG_* env vars, never argv, and is redacted
// from every error and from the result.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  createRedactor,
  redactJson,
  type DigestEntrypoint,
  type DriverType,
  type ProjectDigest,
  type Redactor,
  type SubjectKind,
} from "@anybench/core";
import {
  REPO_INGEST_MAX_BYTES,
  RepoIngestSchema,
  type RepoContext,
  type RepoIngest,
  type RepoManifest,
  type RepoManifestKind,
  type RepoPathGroup,
  type RepoTestCommit,
} from "./repo-context.js";

// ---------------------------------------------------------------------------------------------
// Errors and options

export type IngestErrorCode =
  "bad_url" | "not_a_repo" | "no_github_remote" | "git_failed" | "too_large" | "invalid_digest";

export class IngestError extends Error {
  readonly code: IngestErrorCode;
  constructor(code: IngestErrorCode, message: string) {
    super(message);
    this.name = "IngestError";
    this.code = code;
  }
}

export interface IngestOptions {
  /** Defaults to `process.env.GITHUB_TOKEN`. Only used for fetching; never logged or returned. */
  githubToken?: string;
  /** Commits to fetch and scan for recent test changes. Default 200. */
  depth?: number;
  /** Clock for `ingested_at` (tests). */
  now?: () => Date;
  /** Max serialized size of the result in bytes. Default (and ceiling) 200 KB. */
  maxBytes?: number;
  /** Fetch timeout in ms. Default 180 s. */
  timeoutMs?: number;
}

export interface GitHubIngestOptions extends IngestOptions {
  /**
   * Fetch from here instead of the GitHub URL (a `file://` URL or path), while the digest still
   * names the GitHub URL. Used by tests so they never touch the network.
   */
  cloneUrl?: string;
  /** Keep the temp clone (debugging). Default false. */
  keepClone?: boolean;
}

export interface LocalIngestOptions extends IngestOptions {
  /** Commit-ish to read. Default `HEAD`. */
  rev?: string;
  /** GitHub URL for the digest's `source` when the repo has no github.com remote. */
  githubUrl?: string;
}

// ---------------------------------------------------------------------------------------------
// GitHub URL parsing

export interface GitHubRepoRef {
  owner: string;
  repo: string;
  /** Branch, tag or commit sha, when the input named one. */
  ref?: string;
  /** Canonical `https://github.com/<owner>/<repo>`. */
  url: string;
}

const NAME_RE = /^[A-Za-z0-9_.-]+$/;

/**
 * Accepts `https://github.com/o/r(.git)`, `https://github.com/o/r/tree/<ref>`, `github.com/o/r`,
 * `git@github.com:o/r.git`, `ssh://git@github.com/o/r`, `o/r`, each optionally with `#<ref>` or
 * `@<ref>` (shorthand only).
 */
export function parseGitHubUrl(input: string): GitHubRepoRef {
  let s = input.trim();
  let ref: string | undefined;
  const hash = s.indexOf("#");
  if (hash >= 0) {
    ref = s.slice(hash + 1) || undefined;
    s = s.slice(0, hash);
  }
  let path: string | undefined;
  const scp = /^(?:[^@/]+@)?github\.com:(.+)$/.exec(s);
  if (scp) {
    path = scp[1];
  } else if (
    /^[a-z+]+:\/\//i.test(s) ||
    /^github\.com\//i.test(s) ||
    /^www\.github\.com\//i.test(s)
  ) {
    let u: URL;
    try {
      u = new URL(/^[a-z+]+:\/\//i.test(s) ? s : `https://${s}`);
    } catch {
      throw new IngestError("bad_url", `not a GitHub URL: ${input}`);
    }
    const host = u.hostname.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") {
      throw new IngestError("bad_url", `not a github.com URL: ${u.hostname}`);
    }
    path = u.pathname.replace(/^\/+/, "");
  } else if (/^[^/\s]+\/[^/\s]+$/.test(s)) {
    const at = s.lastIndexOf("@");
    if (at > 0 && ref === undefined) {
      ref = s.slice(at + 1) || undefined;
      s = s.slice(0, at);
    }
    path = s;
  }
  if (!path) throw new IngestError("bad_url", `not a GitHub URL: ${input}`);
  const parts = path.replace(/\/+$/, "").split("/");
  const owner = parts[0];
  const repo = parts[1]?.replace(/\.git$/, "");
  if (!owner || !repo || !NAME_RE.test(owner) || !NAME_RE.test(repo)) {
    throw new IngestError("bad_url", `not a GitHub owner/repo: ${input}`);
  }
  if (ref === undefined && (parts[2] === "tree" || parts[2] === "commit") && parts.length > 3) {
    ref = parts.slice(3).join("/");
  }
  return { owner, repo, ref, url: `https://github.com/${owner}/${repo}` };
}

// ---------------------------------------------------------------------------------------------
// git runner

interface GitResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}

interface GitCtx {
  cwd: string;
  env: NodeJS.ProcessEnv;
  redact: Redactor;
  timeoutMs: number;
}

function baseGitEnv(token: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    // Never lazily download filtered-out blobs, and never take optional locks (read-only).
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GCM_INTERACTIVE: "never",
  };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  // The token goes in as config through the environment, never on the command line.
  delete env.GIT_CONFIG_COUNT;
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${basic}`;
  }
  return env;
}

function runGit(ctx: GitCtx, args: string[], input?: string): Promise<GitResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["-c", "core.quotePath=false", ...args], {
      cwd: ctx.cwd,
      env: ctx.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), ctx.timeoutMs);
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new IngestError("git_failed", ctx.redact(`could not run git: ${e.message}`)));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString("utf8") + (signal ? `\n(killed by ${signal})` : ""),
        code: code ?? 1,
      });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

async function git(ctx: GitCtx, args: string[], input?: string): Promise<string> {
  const r = await runGit(ctx, args, input);
  if (r.code !== 0) {
    const what = args
      .filter((a) => !a.includes("://"))
      .slice(0, 3)
      .join(" ");
    throw new IngestError(
      "git_failed",
      ctx.redact(`git ${what} failed (${r.code}): ${r.stderr.trim().slice(0, 500)}`),
    );
  }
  return r.stdout.toString("utf8");
}

// ---------------------------------------------------------------------------------------------
// Reading a commit

interface TreeEntry {
  path: string;
  mode: string;
  sha: string;
  /** Bytes; a lower bound (the filter limit + 1) when the blob was filtered out. */
  size: number;
  missing: boolean;
}

const FILTER_LIMIT = 1024 * 1024;

async function readTree(ctx: GitCtx, commit: string): Promise<TreeEntry[]> {
  const raw = await git(ctx, ["ls-tree", "-r", "-z", "--full-tree", commit]);
  const entries: TreeEntry[] = [];
  for (const rec of raw.split("\0")) {
    if (!rec) continue;
    const tab = rec.indexOf("\t");
    const [mode, type, sha] = rec.slice(0, tab).split(" ");
    if (type !== "blob" || !mode || !sha) continue; // submodules (type commit) are skipped
    entries.push({ path: rec.slice(tab + 1), mode, sha, size: 0, missing: false });
  }
  if (entries.length === 0) return entries;
  const check = await git(
    ctx,
    ["cat-file", "--batch-check=%(objectname) %(objectsize)"],
    entries.map((e) => e.sha).join("\n") + "\n",
  );
  const sizes = new Map<string, number>();
  for (const line of check.split("\n")) {
    const [sha, size] = line.split(" ");
    if (sha && size && /^\d+$/.test(size)) sizes.set(sha, Number(size));
  }
  for (const e of entries) {
    const size = sizes.get(e.sha);
    if (size === undefined) {
      e.missing = true;
      e.size = FILTER_LIMIT + 1;
    } else {
      e.size = size;
    }
  }
  return entries;
}

async function readBlob(ctx: GitCtx, entry: TreeEntry, cap: number): Promise<string | undefined> {
  if (entry.missing || entry.mode === "120000") return undefined;
  const r = await runGit(ctx, ["cat-file", "blob", entry.sha]);
  if (r.code !== 0) return undefined;
  const buf = r.stdout.subarray(0, cap * 4);
  if (buf.includes(0)) return undefined; // binary
  return buf.toString("utf8");
}

interface CommitInfo {
  sha: string;
  date: string;
  subject: string;
  files: string[];
}

async function readCommits(
  ctx: GitCtx,
  commit: string,
  depth: number,
  shallow: Set<string>,
): Promise<{ scanned: number; commits: CommitInfo[] }> {
  const raw = await git(ctx, [
    "log",
    `-n${depth}`,
    "--no-renames",
    "--no-merges",
    "--name-only",
    "--format=%x1e%H%x1f%cI%x1f%s",
    commit,
  ]);
  const commits: CommitInfo[] = [];
  let scanned = 0;
  for (const rec of raw.split("\x1e")) {
    if (!rec.trim()) continue;
    const [head = "", ...rest] = rec.split("\n");
    const [sha = "", date = "", subject = ""] = head.split("\x1f");
    if (!/^[a-f0-9]{40}$/.test(sha)) continue;
    scanned++;
    // A shallow boundary commit diffs against nothing, so it "touches" every file: skip it.
    if (shallow.has(sha)) continue;
    commits.push({ sha, date, subject, files: rest.filter((l) => l.length > 0) });
  }
  return { scanned, commits };
}

async function readShallow(ctx: GitCtx): Promise<Set<string>> {
  const gitDir = (await git(ctx, ["rev-parse", "--absolute-git-dir"])).trim();
  try {
    const text = await readFile(join(gitDir, "shallow"), "utf8");
    return new Set(text.split("\n").filter((l) => /^[a-f0-9]{40}$/.test(l)));
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------------------------
// Path classification

const NOISE_DIR_RE =
  /(^|\/)(node_modules|vendor|third_party|dist|build|out|target|\.next|\.nuxt|coverage|__pycache__|\.venv|venv|\.git)\//;
const GENERATED_RE = /(\.min\.(js|css)|\.map|-lock\.(json|yaml)|\.lock|\.lockb|go\.sum)$/;

const TEST_RE =
  /(^|\/)(tests?|__tests__|specs?|e2e|integration[-_]tests?|testdata|test[-_]?data)\/|(\.|_)(test|spec)\.[A-Za-z0-9]+$|(^|\/)test_[^/]+\.py$|(^|\/)[^/]+_test\.(go|py|rb|exs?)$|(^|\/)conftest\.py$/i;
const BENCH_RE =
  /(^|\/)(bench|benches|benchmarks?|perf)\/|(\.|_)(bench|benchmark)\.[A-Za-z0-9]+$|(^|\/)bench_[^/]+\.py$|(^|\/)[^/]+_bench(mark)?_test\.go$/i;

export function isTestPath(path: string): boolean {
  return TEST_RE.test(path) && !NOISE_DIR_RE.test(path);
}

export function isBenchPath(path: string): boolean {
  return BENCH_RE.test(path) && !NOISE_DIR_RE.test(path);
}

const LANGUAGES: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  py: "Python",
  rs: "Rust",
  go: "Go",
  c: "C",
  h: "C",
  cc: "C++",
  cpp: "C++",
  cxx: "C++",
  hpp: "C++",
  hh: "C++",
  java: "Java",
  kt: "Kotlin",
  kts: "Kotlin",
  swift: "Swift",
  rb: "Ruby",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  fish: "Shell",
  ps1: "PowerShell",
  cs: "C#",
  fs: "F#",
  php: "PHP",
  lua: "Lua",
  zig: "Zig",
  ex: "Elixir",
  exs: "Elixir",
  erl: "Erlang",
  scala: "Scala",
  clj: "Clojure",
  hs: "Haskell",
  ml: "OCaml",
  nim: "Nim",
  dart: "Dart",
  r: "R",
  jl: "Julia",
  m: "Objective-C",
  mm: "Objective-C++",
  vue: "Vue",
  svelte: "Svelte",
  html: "HTML",
  css: "CSS",
  scss: "SCSS",
  sql: "SQL",
  proto: "Protocol Buffers",
  tf: "HCL",
  nix: "Nix",
  vim: "Vim Script",
  el: "Emacs Lisp",
};

function languageOf(path: string): string | undefined {
  const name = basename(path);
  if (name === "Dockerfile") return "Dockerfile";
  if (name === "Makefile") return "Makefile";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return LANGUAGES[name.slice(dot + 1).toLowerCase()];
}

function manifestKind(path: string): RepoManifestKind | undefined {
  const name = basename(path);
  switch (name) {
    case "package.json":
    case "pyproject.toml":
    case "setup.py":
    case "requirements.txt":
    case "go.mod":
    case "Cargo.toml":
    case "Gemfile":
    case "pom.xml":
    case "Makefile":
    case "justfile":
    case "CMakeLists.txt":
    case "Dockerfile":
    case "pnpm-workspace.yaml":
      return name;
    case "build.gradle":
    case "build.gradle.kts":
      return "build.gradle";
    case "docker-compose.yml":
    case "docker-compose.yaml":
    case "compose.yml":
    case "compose.yaml":
      return "docker-compose";
    default:
      return undefined;
  }
}

const depthOf = (p: string): number => p.split("/").length - 1;
const dirOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".");

function groupPaths(paths: string[], maxDirs: number, maxSample: number): RepoPathGroup {
  const byDir = new Map<string, number>();
  for (const p of paths) byDir.set(dirOf(p), (byDir.get(dirOf(p)) ?? 0) + 1);
  const dirs = [...byDir.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxDirs)
    .map(([d]) => d);
  const sample = [...paths]
    .sort((a, b) => depthOf(a) - depthOf(b) || a.localeCompare(b))
    .slice(0, maxSample);
  return { files: paths.length, dirs, sample };
}

// ---------------------------------------------------------------------------------------------
// Manifest parsing (tolerant: a manifest we cannot parse just contributes nothing)

interface PackageJson {
  name?: string;
  description?: string;
  bin?: string | Record<string, string>;
  main?: string;
  module?: string;
  exports?: unknown;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  private?: boolean;
}

function parsePackageJson(text: string): PackageJson | undefined {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as PackageJson) : undefined;
  } catch {
    return undefined;
  }
}

/** A tiny TOML reader: `[section]` / `[[array]]` headers and `key = "string"` lines only. */
function tomlSections(text: string): Map<string, Array<Record<string, string>>> {
  const out = new Map<string, Array<Record<string, string>>>();
  let cur: Record<string, string> = {};
  out.set("", [cur]);
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    const arr = /^\[\[\s*([^\]]+?)\s*\]\]/.exec(line);
    const sec = arr ? undefined : /^\[\s*([^\]]+?)\s*\]/.exec(line);
    if (arr?.[1] || sec?.[1]) {
      const name = (arr?.[1] ?? sec?.[1]) as string;
      cur = {};
      const list = out.get(name) ?? [];
      list.push(cur);
      out.set(name, list);
      continue;
    }
    const kv = /^("?[A-Za-z0-9_.-]+"?)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(line);
    if (kv?.[1]) cur[kv[1].replace(/"/g, "")] = kv[2] ?? kv[3] ?? "";
  }
  return out;
}

function makeTargets(text: string): Set<string> {
  const t = new Set<string>();
  for (const m of text.matchAll(/^([A-Za-z0-9_.-]+)\s*:(?!=)/gm)) if (m[1]) t.add(m[1]);
  return t;
}

const NPM_DEFAULT_TEST = /no test specified/;
const SERVER_DEPS = [
  "express",
  "fastify",
  "hono",
  "koa",
  "@nestjs/core",
  "@hapi/hapi",
  "@modelcontextprotocol/sdk",
];
const WEB_DEPS = [
  "next",
  "nuxt",
  "@remix-run/react",
  "@sveltejs/kit",
  "vite",
  "astro",
  "react-scripts",
  "@angular/core",
  "gatsby",
];
const AGENT_DEPS = [
  "@anthropic-ai/sdk",
  "@anthropic-ai/claude-agent-sdk",
  "@anthropic-ai/claude-code",
  "openai",
  "langchain",
  "@langchain/core",
  "ai",
  "@openai/agents",
  "@usenaive-sdk/managed-agents",
];
const PY_AGENT_DEPS =
  /\b(anthropic|openai|langchain|langgraph|crewai|autogen|claude-agent-sdk|pydantic-ai|smolagents)\b/i;

// ---------------------------------------------------------------------------------------------
// Analysis: tree + file reader -> digest + context

interface Analysis {
  name: string;
  source: ProjectDigest["source"];
  tree: TreeEntry[];
  commit: string;
  tags: string[];
  commits: { scanned: number; commits: CommitInfo[] };
  read: (entry: TreeEntry, cap: number) => Promise<string | undefined>;
  now: Date;
  redact: Redactor;
  maxBytes: number;
}

const CAPS = {
  treePaths: 1500,
  treeDirs: 200,
  readme: 24 * 1024,
  manifestText: 8 * 1024,
  manifests: 24,
  manifestTotal: 64 * 1024,
  groupDirs: 40,
  groupSample: 80,
  testCommits: 40,
  testFilesPerCommit: 10,
  tags: 50,
  docs: 60,
  entrypoints: 30,
  summary: 400,
  largeFiles: 50,
};

function capText(text: string, cap: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= cap) return { text, truncated: false };
  let cut = text.slice(0, cap);
  while (Buffer.byteLength(cut, "utf8") > cap) cut = cut.slice(0, -64);
  return { text: cut, truncated: true };
}

function semverKey(tag: string): number[] | undefined {
  const m = /^(?:[A-Za-z_-]*?)v?(\d+)\.(\d+)(?:\.(\d+))?(-[0-9A-Za-z.-]+)?$/.exec(tag);
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0), m[4] ? 0 : 1];
}

function sortTags(tags: string[]): { latest?: string; tags: string[] } {
  const semver = tags
    .map((t) => ({ t, k: semverKey(t) }))
    .filter((x): x is { t: string; k: number[] } => x.k !== undefined)
    .sort((a, b) => {
      for (let i = 0; i < 4; i++) {
        const d = (b.k[i] ?? 0) - (a.k[i] ?? 0);
        if (d !== 0) return d;
      }
      return a.t.localeCompare(b.t);
    })
    .map((x) => x.t);
  const rest = tags
    .filter((t) => semverKey(t) === undefined)
    .sort()
    .reverse();
  const ordered = [...semver, ...rest];
  const latestStable = semver.find((t) => semverKey(t)?.[3] === 1);
  return { latest: latestStable ?? semver[0] ?? rest[0], tags: ordered };
}

function readmeSummary(text: string): string | undefined {
  const paras = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .split(/\n\s*\n/)
    .map((p) =>
      p
        .split("\n")
        .filter((l) => !/^\s*(#|!\[|\[!\[|```|[-=]{3,}\s*$|\|)/.test(l))
        .join(" ")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[*_`]/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((p) => p.length >= 20);
  return paras[0];
}

function oneLine(s: string, cap: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= cap ? t : `${t.slice(0, cap - 1).trimEnd()}…`;
}

async function analyze(a: Analysis): Promise<RepoIngest> {
  const r = a.redact;
  const files = a.tree;
  const paths = files.map((f) => f.path);
  const byPath = new Map(files.map((f) => [f.path, f]));

  // --- manifests: root first, then shallow ones; never from noise dirs
  const manifestEntries = files
    .filter((f) => manifestKind(f.path) && !NOISE_DIR_RE.test(f.path) && depthOf(f.path) <= 3)
    .sort((x, y) => depthOf(x.path) - depthOf(y.path) || x.path.localeCompare(y.path))
    .slice(0, CAPS.manifests);
  const manifests: RepoManifest[] = [];
  const manifestFull = new Map<string, string>();
  let manifestBytes = 0;
  for (const f of manifestEntries) {
    const text = await a.read(f, 256 * 1024);
    if (text === undefined) continue;
    manifestFull.set(f.path, text);
    const room = Math.min(CAPS.manifestText, CAPS.manifestTotal - manifestBytes);
    if (room <= 256) continue;
    const capped = capText(r(text), room);
    manifestBytes += Buffer.byteLength(capped.text, "utf8");
    manifests.push({ path: f.path, kind: manifestKind(f.path) as RepoManifestKind, ...capped });
  }
  const rootText = (name: string): string | undefined => manifestFull.get(name);

  // --- README
  const readmeEntry = files
    .filter(
      (f) => depthOf(f.path) === 0 && /^readme(\.(md|markdown|rst|txt|adoc|org))?$/i.test(f.path),
    )
    .sort(
      (x, y) =>
        (x.path.toLowerCase().endsWith(".md") ? -1 : 0) -
        (y.path.toLowerCase().endsWith(".md") ? -1 : 0),
    )[0];
  const readmeText = readmeEntry ? await a.read(readmeEntry, CAPS.readme * 2) : undefined;
  const readme =
    readmeEntry && readmeText !== undefined
      ? { path: readmeEntry.path, ...capText(r(readmeText), CAPS.readme) }
      : undefined;

  // --- languages
  const langBytes = new Map<string, number>();
  for (const f of files) {
    if (NOISE_DIR_RE.test(f.path) || GENERATED_RE.test(f.path) || f.missing) continue;
    const lang = languageOf(f.path);
    if (lang) langBytes.set(lang, (langBytes.get(lang) ?? 0) + f.size);
  }
  const languages = [...langBytes.entries()]
    .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
    .slice(0, 15)
    .map(([name, bytes]) => ({ name, bytes }));

  // --- entrypoints and commands
  const entrypoints: DigestEntrypoint[] = [];
  const build = new Set<string>();
  const test = new Set<string>();
  let summary: string | undefined;
  let manifestName: string | undefined;
  let agentSignal = false;
  let serverSignal = false;
  let webSignal = false;
  const addEntry = (e: DigestEntrypoint): void => {
    if (entrypoints.length >= CAPS.entrypoints) return;
    if (entrypoints.some((x) => x.kind === e.kind && x.name === e.name && x.path === e.path))
      return;
    entrypoints.push(e);
  };

  const pm = byPath.has("pnpm-lock.yaml")
    ? "pnpm"
    : byPath.has("yarn.lock")
      ? "yarn"
      : byPath.has("bun.lockb") || byPath.has("bun.lock")
        ? "bun"
        : "npm";
  const pkgs = [...manifestFull.entries()]
    .filter(([p]) => basename(p) === "package.json")
    .map(([p, t]) => ({ path: p, pkg: parsePackageJson(t) }))
    .filter((x): x is { path: string; pkg: PackageJson } => x.pkg !== undefined);
  for (const { path, pkg } of pkgs) {
    const root = path === "package.json";
    const dir = dirOf(path);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const depNames = Object.keys(deps);
    if (depNames.some((d) => AGENT_DEPS.includes(d))) agentSignal = true;
    const isServer = depNames.some((d) => SERVER_DEPS.includes(d));
    const isWeb = depNames.some((d) => WEB_DEPS.includes(d));
    if (isServer) serverSignal = true;
    if (isWeb) webSignal = true;
    if (root) {
      manifestName = pkg.name;
      if (pkg.description) summary ??= pkg.description;
      build.add(`${pm} install`);
      if (pkg.scripts?.build) build.add(`${pm} run build`);
      if (pkg.scripts?.test && !NPM_DEFAULT_TEST.test(pkg.scripts.test)) test.add(`${pm} test`);
    } else if (pkg.scripts?.test && !NPM_DEFAULT_TEST.test(pkg.scripts.test)) {
      test.add(`${pm} --dir ${dir} test`);
    }
    if (typeof pkg.bin === "string" && pkg.name) {
      const name = pkg.name.replace(/^@[^/]+\//, "");
      addEntry({ kind: "bin", name, command: name, path: join(dir, pkg.bin) });
    } else if (pkg.bin && typeof pkg.bin === "object") {
      for (const [name, p] of Object.entries(pkg.bin)) {
        if (typeof p === "string")
          addEntry({ kind: "bin", name, command: name, path: join(dir, p) });
      }
    }
    const label = pkg.name ?? (root ? "root" : dir);
    if (isWeb) {
      addEntry({
        kind: "web",
        name: label,
        command: pkg.scripts?.dev
          ? root
            ? `${pm} run dev`
            : `${pm} --dir ${dir} run dev`
          : undefined,
        path: dir === "." ? undefined : dir,
      });
    }
    if (pkg.scripts?.start) {
      addEntry({
        kind:
          isServer || /\b(serve|server|next start|listen)\b/.test(pkg.scripts.start)
            ? "service"
            : "script",
        name: `${label}:start`,
        command: root ? `${pm} start` : `${pm} --dir ${dir} start`,
        path: dir === "." ? undefined : dir,
      });
    } else if (isServer && pkg.scripts?.dev) {
      addEntry({
        kind: "service",
        name: `${label}:dev`,
        command: root ? `${pm} run dev` : `${pm} --dir ${dir} run dev`,
        path: dir === "." ? undefined : dir,
      });
    }
    if (!pkg.bin && !isWeb && !pkg.private && (pkg.main || pkg.module || pkg.exports) && pkg.name) {
      addEntry({
        kind: "library",
        name: pkg.name,
        path: pkg.main ? join(dir, pkg.main) : dir === "." ? undefined : dir,
      });
    }
  }

  // Native toolchains, per directory (root first, then up to two levels down).
  const inDir = (dir: string, cmd: string): string => (dir === "." ? cmd : `cd ${dir} && ${cmd}`);
  const at = (dir: string, p: string): string => (dir === "." ? p : `${dir}/${p}`);
  const under = (dir: string): string[] =>
    dir === "."
      ? paths
      : paths.filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1));
  const toolDirs = [
    ...new Set([...manifestFull.keys()].filter((p) => depthOf(p) <= 2).map(dirOf)),
  ].sort((x, y) =>
    x === "." ? -1 : y === "." ? 1 : depthOf(x) - depthOf(y) || x.localeCompare(y),
  );
  for (const dir of toolDirs) {
    const text = (name: string): string | undefined => manifestFull.get(at(dir, name));
    const rel = under(dir);
    const has = (p: string): boolean => byPath.has(at(dir, p));
    const isRoot = dir === ".";

    const cargo = text("Cargo.toml");
    if (cargo !== undefined) {
      const t = tomlSections(cargo);
      const pkgSec = t.get("package")?.[0];
      if (isRoot) manifestName ??= pkgSec?.name;
      if (isRoot && pkgSec?.description) summary ??= pkgSec.description;
      build.add(inDir(dir, "cargo build --release"));
      test.add(inDir(dir, "cargo test"));
      for (const b of t.get("bin") ?? []) {
        if (b.name)
          addEntry({
            kind: "bin",
            name: b.name,
            command: b.name,
            path: b.path ? at(dir, b.path) : undefined,
          });
      }
      if (has("src/main.rs") && pkgSec?.name) {
        addEntry({
          kind: "bin",
          name: pkgSec.name,
          command: pkgSec.name,
          path: at(dir, "src/main.rs"),
        });
      }
      for (const p of rel) {
        const m = /^src\/bin\/([^/]+)\.rs$/.exec(p);
        if (m?.[1]) addEntry({ kind: "bin", name: m[1], command: m[1], path: at(dir, p) });
      }
      if (has("src/lib.rs"))
        addEntry({ kind: "library", name: pkgSec?.name ?? "lib", path: at(dir, "src/lib.rs") });
    }

    const gomod = text("go.mod");
    if (gomod !== undefined) {
      const mod = /^module\s+(\S+)/m.exec(gomod)?.[1];
      if (isRoot) manifestName ??= mod ? basename(mod) : undefined;
      build.add(inDir(dir, "go build ./..."));
      test.add(inDir(dir, "go test ./..."));
      for (const p of rel) {
        const m = /^cmd\/([^/]+)\/main\.go$/.exec(p);
        if (m?.[1]) addEntry({ kind: "bin", name: m[1], command: m[1], path: at(dir, dirOf(p)) });
      }
      if (has("main.go") && mod) {
        addEntry({
          kind: "bin",
          name: basename(mod),
          command: basename(mod),
          path: at(dir, "main.go"),
        });
      }
    }

    const pyproject = text("pyproject.toml");
    const requirements = text("requirements.txt");
    const setupPy = text("setup.py");
    if (pyproject !== undefined || setupPy !== undefined || requirements !== undefined) {
      const t =
        pyproject !== undefined
          ? tomlSections(pyproject)
          : new Map<string, Array<Record<string, string>>>();
      const proj = t.get("project")?.[0] ?? t.get("tool.poetry")?.[0];
      if (isRoot) manifestName ??= proj?.name;
      if (isRoot && proj?.description) summary ??= proj.description;
      const pyText = `${pyproject ?? ""}\n${requirements ?? ""}`;
      if (PY_AGENT_DEPS.test(pyText)) agentSignal = true;
      if (/\b(fastapi|flask|django|uvicorn|starlette|aiohttp)\b/i.test(pyText)) serverSignal = true;
      build.add(
        inDir(
          dir,
          has("uv.lock")
            ? "uv sync"
            : has("poetry.lock")
              ? "poetry install"
              : pyproject !== undefined || setupPy !== undefined
                ? "pip install -e ."
                : "pip install -r requirements.txt",
        ),
      );
      if (
        rel.some((p) => /(^|\/)(test_[^/]+|[^/]+_test)\.py$/.test(p)) ||
        /pytest/.test(pyproject ?? "")
      ) {
        test.add(inDir(dir, has("uv.lock") ? "uv run pytest" : "pytest"));
      }
      for (const sec of ["project.scripts", "tool.poetry.scripts"]) {
        // Targets are `module:function`, not paths.
        for (const name of Object.keys(t.get(sec)?.[0] ?? {}))
          addEntry({ kind: "bin", name, command: name });
      }
      for (const p of rel) {
        if (/^(src\/)?[^/]+\/__main__\.py$/.test(p)) {
          const mod = dirOf(p).replace(/^src\//, "");
          addEntry({
            kind: "script",
            name: mod,
            command: inDir(dir, `python -m ${mod}`),
            path: at(dir, p),
          });
        }
      }
    }

    const makefile = text("Makefile");
    if (makefile !== undefined) {
      const targets = makeTargets(makefile);
      if (targets.has("build")) build.add(inDir(dir, "make build"));
      else if (targets.has("all") && isRoot && build.size === 0) build.add("make");
      if (targets.has("test")) test.add(inDir(dir, "make test"));
      else if (targets.has("check")) test.add(inDir(dir, "make check"));
    }
    const cmake = text("CMakeLists.txt");
    if (cmake !== undefined && isRoot) {
      build.add("cmake -B build && cmake --build build");
      if (/enable_testing|add_test/.test(cmake)) test.add("ctest --test-dir build");
    }
  }
  const dockerfile = rootText("Dockerfile");
  if (dockerfile !== undefined && /^\s*EXPOSE\s+\d+/im.test(dockerfile)) {
    serverSignal = true;
    addEntry({
      kind: "service",
      name: "docker",
      command: "docker build -t subject . && docker run subject",
      path: "Dockerfile",
    });
  }

  // --- Claude Code setup (paths only, plus .mcp.json server names)
  const agents = paths
    .filter((p) => /^\.claude\/agents\/[^/]+\.md$/.test(p))
    .map((p) => basename(p, ".md"));
  const skills = [
    ...new Set(
      paths
        .map((p) => /^\.claude\/skills\/([^/]+)\/SKILL\.md$/.exec(p)?.[1])
        .filter((x): x is string => !!x),
    ),
  ];
  const commands = paths
    .filter((p) => /^\.claude\/commands\/.+\.md$/.test(p))
    .map((p) => p.slice(".claude/commands/".length, -3));
  let mcpServers: string[] = [];
  const mcp = byPath.get(".mcp.json");
  if (mcp) {
    try {
      const v = JSON.parse((await a.read(mcp, 64 * 1024)) ?? "{}") as {
        mcpServers?: Record<string, unknown>;
      };
      mcpServers = Object.keys(v.mcpServers ?? {});
    } catch {
      mcpServers = [];
    }
  }
  const claudeMd = byPath.has("CLAUDE.md") || byPath.has(".claude/CLAUDE.md");
  const hasClaude =
    claudeMd || agents.length + skills.length + commands.length + mcpServers.length > 0;
  const claude_code = hasClaude
    ? {
        claude_md: claudeMd,
        agents: agents.slice(0, 50),
        skills: skills.slice(0, 50),
        commands: commands.slice(0, 50),
        mcp_servers: mcpServers.slice(0, 50),
      }
    : undefined;

  // --- summary and kind
  summary ??= readmeText !== undefined ? readmeSummary(readmeText) : undefined;
  const name = a.name || manifestName || "project";
  summary = oneLine(
    r(summary ?? `${name}: a ${languages[0]?.name ?? "software"} repository.`),
    CAPS.summary,
  );
  const prose = `${summary}\n${readmeText?.slice(0, 4000) ?? ""}`;
  const harnessSignal =
    /\b(harness|orchestrat\w*|multi-agent|swarm|agent fleet|task board|subagents?)\b/i.test(prose);
  const agentWords = /\b(ai agent|coding agent|llm|agentic|autonomous agent)\b/i.test(prose);
  let kind: SubjectKind = "software";
  if (harnessSignal && (agentSignal || hasClaude || agentWords)) kind = "harness";
  else if (agentSignal || agentWords) kind = "agent";
  if (kind !== "software" && !entrypoints.some((e) => e.kind === "agent")) {
    addEntry({ kind: "agent", name, path: undefined });
  }

  // --- suggested driver types, most likely first
  const drivers: DriverType[] = [];
  const push = (d: DriverType): void => {
    if (!drivers.includes(d)) drivers.push(d);
  };
  if (kind === "harness") push("harness");
  if (kind === "harness" || kind === "agent")
    push(hasClaude || kind === "harness" ? "coding-agent" : "http-agent");
  if (kind === "agent") push(serverSignal ? "http-agent" : "coding-agent");
  const hasKind = (k: DigestEntrypoint["kind"]): boolean => entrypoints.some((e) => e.kind === k);
  if (hasKind("bin")) push("cli");
  if (hasKind("service") || serverSignal) push("service");
  if (hasKind("web") || webSignal) push("web");
  if (hasKind("library")) push("lib");
  if (drivers.length === 0 && languages.length > 0) push("cli");

  // --- docs
  const docs = [
    ...(readmeEntry ? [readmeEntry.path] : []),
    ...paths.filter(
      (p) => depthOf(p) === 0 && /\.(md|rst|adoc)$/i.test(p) && p !== readmeEntry?.path,
    ),
    ...paths.filter(
      (p) => /^(docs?|documentation|man)\//i.test(p) && /\.(md|mdx|rst|adoc|txt|\d)$/i.test(p),
    ),
  ].slice(0, CAPS.docs);

  // --- tests, benchmarks, recent commits touching tests
  const testPaths = paths.filter(isTestPath);
  const benchPaths = paths.filter(isBenchPath);
  const recent: RepoTestCommit[] = [];
  for (const c of a.commits.commits) {
    if (recent.length >= CAPS.testCommits) break;
    const touched = c.files.filter(isTestPath);
    if (touched.length === 0) continue;
    recent.push({
      sha: c.sha,
      date: c.date,
      subject: oneLine(r(c.subject), 200),
      files_changed: c.files.length,
      test_files: touched.slice(0, CAPS.testFilesPerCommit),
    });
  }

  // --- tree (noise last), dirs
  const dirStats = new Map<string, { files: number; bytes: number }>();
  for (const f of files) {
    const parts = f.path.split("/");
    for (let i = 1; i < parts.length && i <= 3; i++) {
      const d = parts.slice(0, i).join("/");
      const s = dirStats.get(d) ?? { files: 0, bytes: 0 };
      s.files++;
      s.bytes += f.size;
      dirStats.set(d, s);
    }
  }
  const orderedPaths = [
    ...paths.filter((p) => !NOISE_DIR_RE.test(p) && !GENERATED_RE.test(p)),
    ...paths.filter((p) => NOISE_DIR_RE.test(p) || GENERATED_RE.test(p)),
  ];

  const tagInfo = sortTags(a.tags);
  const hash = createHash("sha256");
  for (const f of files) hash.update(`${f.mode} ${f.sha}\t${f.path}\n`);

  const build_commands = [...build].slice(0, 12);
  const test_commands = [...test].slice(0, 12);

  const make = (treeCap: number, dirCap: number, readmeCap: number): RepoIngest => {
    const digest: ProjectDigest = {
      source: a.source,
      name,
      kind,
      summary,
      languages,
      entrypoints,
      build_commands,
      test_commands,
      docs,
      ...(claude_code ? { claude_code } : {}),
      releases: {
        ...(tagInfo.latest ? { latest: tagInfo.latest } : {}),
        tags: tagInfo.tags.slice(0, CAPS.tags),
      },
      files: { count: files.length, total_bytes: files.reduce((n, f) => n + f.size, 0) },
      suggested_driver_types: drivers,
      ingested_at: a.now.toISOString(),
      hash: hash.copy().digest("hex"),
    };
    const context: RepoContext = {
      tree: {
        paths: orderedPaths.slice(0, treeCap),
        dirs: [...dirStats.entries()]
          .sort((x, y) => y[1].bytes - x[1].bytes || x[0].localeCompare(y[0]))
          .slice(0, dirCap)
          .map(([path, s]) => ({ path, ...s })),
        truncated: orderedPaths.length > treeCap || dirStats.size > dirCap,
      },
      ...(readme
        ? {
            readme: {
              path: readme.path,
              ...(() => {
                const c = capText(readme.text, readmeCap);
                return { text: c.text, truncated: readme.truncated || c.truncated };
              })(),
            },
          }
        : {}),
      manifests,
      tests: groupPaths(testPaths, CAPS.groupDirs, CAPS.groupSample),
      benchmarks: groupPaths(benchPaths, CAPS.groupDirs, CAPS.groupSample),
      commits_scanned: a.commits.scanned,
      recent_test_commits: recent,
      large_files: files
        .filter((f) => f.missing || f.size > FILTER_LIMIT)
        .map((f) => f.path)
        .slice(0, CAPS.largeFiles),
    };
    return redactJson({ digest, context }, r);
  };

  // Shrink the tree, then the README, until the result fits the byte budget.
  let treeCap = CAPS.treePaths;
  let dirCap = CAPS.treeDirs;
  let readmeCap = CAPS.readme;
  for (let i = 0; i < 10; i++) {
    const result = make(treeCap, dirCap, readmeCap);
    if (serializeRepoIngest(result).length <= a.maxBytes) return validate(result);
    treeCap = Math.floor(treeCap / 2);
    dirCap = Math.max(20, Math.floor(dirCap / 2));
    if (i >= 3) readmeCap = Math.floor(readmeCap / 2);
  }
  throw new IngestError("too_large", `digest for ${name} does not fit in ${a.maxBytes} bytes`);
}

function validate(result: RepoIngest): RepoIngest {
  const parsed = RepoIngestSchema.safeParse(result);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new IngestError(
      "invalid_digest",
      `ingest produced an invalid digest: ${issues.join("; ")}`,
    );
  }
  return parsed.data;
}

/** The exact bytes a digest fixture is stored as (pretty JSON + newline). */
export function serializeRepoIngest(result: RepoIngest): Buffer {
  return Buffer.from(`${JSON.stringify(result, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------------------------
// Public entry points

function resolveOpts(opts: IngestOptions): {
  token?: string;
  depth: number;
  now: Date;
  maxBytes: number;
  timeoutMs: number;
  redact: Redactor;
} {
  const token = opts.githubToken ?? process.env.GITHUB_TOKEN ?? undefined;
  const depth = Math.max(1, Math.min(opts.depth ?? 200, 5000));
  return {
    token: token || undefined,
    depth,
    now: (opts.now ?? (() => new Date()))(),
    maxBytes: Math.min(opts.maxBytes ?? REPO_INGEST_MAX_BYTES, REPO_INGEST_MAX_BYTES),
    timeoutMs: opts.timeoutMs ?? 180_000,
    redact: createRedactor({ GITHUB_TOKEN: token }),
  };
}

const SHA_RE = /^[a-f0-9]{40}$/;

/** Fetch a GitHub repo into a temp dir (partial, shallow, no checkout) and digest it. */
export async function ingestGitHubRepo(
  input: string,
  opts: GitHubIngestOptions = {},
): Promise<RepoIngest> {
  const ref = parseGitHubUrl(input);
  const o = resolveOpts(opts);
  const dir = await mkdtemp(join(tmpdir(), "anybench-ingest-"));
  const ctx: GitCtx = {
    cwd: dir,
    env: baseGitEnv(o.token),
    redact: o.redact,
    timeoutMs: o.timeoutMs,
  };
  const remote = opts.cloneUrl ?? `${ref.url}.git`;
  try {
    await git(ctx, ["init", "-q"]);
    await git(ctx, ["remote", "add", "origin", remote]);
    let wantRef = ref.ref;
    let refName = ref.ref;
    if (!wantRef) {
      // Default branch name, via the remote's HEAD symref.
      const head = await git(ctx, ["ls-remote", "--symref", "origin", "HEAD"]);
      refName = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(head)?.[1] ?? "HEAD";
      wantRef = "HEAD";
    }
    const tagsRaw = await git(ctx, ["ls-remote", "--tags", "--refs", "origin"]);
    const tags = tagsRaw
      .split("\n")
      .map((l) => /\srefs\/tags\/(.+)$/.exec(l)?.[1])
      .filter((t): t is string => !!t);
    await git(ctx, [
      "-c",
      "remote.origin.promisor=true",
      "-c",
      "remote.origin.partialclonefilter=blob:limit=1m",
      "fetch",
      "-q",
      "--no-tags",
      `--depth=${o.depth}`,
      "--filter=blob:limit=1m",
      "origin",
      wantRef,
    ]);
    const commit = (await git(ctx, ["rev-parse", "FETCH_HEAD^{commit}"])).trim();
    const tree = await readTree(ctx, commit);
    const commits = await readCommits(ctx, commit, o.depth, await readShallow(ctx));
    return await analyze({
      name: ref.repo,
      source: {
        kind: "github",
        url: ref.url,
        ref: refName ?? commit,
        ...(SHA_RE.test(commit) ? { commit } : {}),
      },
      tree,
      commit,
      tags,
      commits,
      read: (e, cap) => readBlob(ctx, e, cap),
      now: o.now,
      redact: o.redact,
      maxBytes: o.maxBytes,
    });
  } finally {
    if (!opts.keepClone) await rm(dir, { recursive: true, force: true });
  }
}

/** Find a github.com remote (origin first) and return its canonical URL. */
async function githubRemote(ctx: GitCtx): Promise<string | undefined> {
  const raw = await runGit(ctx, ["remote", "-v"]);
  if (raw.code !== 0) return undefined;
  const lines = raw.stdout
    .toString("utf8")
    .split("\n")
    .filter((l) => l.endsWith("(fetch)"));
  lines.sort((x, y) => (x.startsWith("origin\t") ? -1 : 0) - (y.startsWith("origin\t") ? -1 : 0));
  for (const l of lines) {
    const url = l.split(/\s+/)[1];
    if (!url) continue;
    try {
      return parseGitHubUrl(url.replace(/^(https?:\/\/)[^@/]+@/, "$1")).url;
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Digest a local git checkout from its committed tree (`HEAD` by default). Read-only: nothing in
 * the repo is written, uncommitted changes are ignored. The digest's `source` is the repo's
 * github.com remote, or `opts.githubUrl`.
 */
export async function ingestLocalRepo(
  path: string,
  opts: LocalIngestOptions = {},
): Promise<RepoIngest> {
  const abs = resolve(path);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new IngestError("not_a_repo", `not a directory: ${abs}`);
  }
  const o = resolveOpts(opts);
  const ctx: GitCtx = {
    cwd: abs,
    env: baseGitEnv(undefined),
    redact: o.redact,
    timeoutMs: o.timeoutMs,
  };
  const top = await runGit(ctx, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) throw new IngestError("not_a_repo", `not a git repository: ${abs}`);
  ctx.cwd = top.stdout.toString("utf8").trim();
  const rev = opts.rev ?? "HEAD";
  const commitR = await runGit(ctx, ["rev-parse", "--verify", "-q", `${rev}^{commit}`]);
  if (commitR.code !== 0) throw new IngestError("not_a_repo", `no commit at ${rev} in ${ctx.cwd}`);
  const commit = commitR.stdout.toString("utf8").trim();

  const url = opts.githubUrl ? parseGitHubUrl(opts.githubUrl).url : await githubRemote(ctx);
  if (!url) {
    throw new IngestError(
      "no_github_remote",
      `${ctx.cwd} has no github.com remote; pass githubUrl (core's DigestSource has no local kind)`,
    );
  }
  let refName = rev;
  if (rev === "HEAD") {
    const branch = await runGit(ctx, ["symbolic-ref", "--short", "-q", "HEAD"]);
    refName = branch.code === 0 ? branch.stdout.toString("utf8").trim() : commit;
  }
  const tagsRaw = await git(ctx, ["for-each-ref", "--format=%(refname:short)", "refs/tags"]);
  const tags = tagsRaw.split("\n").filter((t) => t.length > 0);
  const tree = await readTree(ctx, commit);
  const commits = await readCommits(ctx, commit, o.depth, await readShallow(ctx));
  return analyze({
    name: parseGitHubUrl(url).repo || basename(ctx.cwd),
    source: { kind: "github", url, ref: refName || commit, commit },
    tree,
    commit,
    tags,
    commits,
    read: (e, cap) => readBlob(ctx, e, cap),
    now: o.now,
    redact: o.redact,
    maxBytes: o.maxBytes,
  });
}

/** A local directory is read in place; anything else is treated as a GitHub URL. */
export async function ingestRepo(
  input: string,
  opts: GitHubIngestOptions & LocalIngestOptions = {},
): Promise<RepoIngest> {
  const local = existsSync(input) && statSync(input).isDirectory();
  return local ? ingestLocalRepo(input, opts) : ingestGitHubRepo(input, opts);
}
