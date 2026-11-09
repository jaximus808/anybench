// TDM-187 [16.16]: what the skeptic reads from a kit directory. Pure reads, no network.
//
//   readKitFiles(dir)        every regular text file in the kit (skips node_modules, .git, binaries)
//   hiddenTestFiles(...)     files under gates/<gate>/<workload>/ (and a shared gates/<gate>/tests.json)
//   extractTestFacts(file)   test names, assertion literals and messages, with their lines
//
// "Hidden" here means scoring-only: gates/, reference/ and proof/ never reach the subject computer
// (plan.md 17.2 rule 5), so anything they say must not be readable from workloads/ or an adapter.
import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { KitSpec } from "@anybench/core";
import { KIT_LAYOUT, normalizeKitPath } from "../layout.js";

export interface KitTextFile {
  /** Kit-relative, `/`-separated. */
  path: string;
  text: string;
  sha256: string;
  size: number;
}

/** Larger files are hashed but not read as text. */
export const SKEPTIC_MAX_TEXT_BYTES = 512 * 1024;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "target", "__pycache__", ".venv"]);

/** Every regular file in the kit, text read when it is small and not binary. */
export async function readKitFiles(dir: string): Promise<KitTextFile[]> {
  const out: KitTextFile[] = [];
  async function walk(rel: string): Promise<void> {
    const abs = path.join(dir, rel);
    for (const e of await readdir(abs, { withFileTypes: true })) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(child);
        continue;
      }
      if (!e.isFile()) continue;
      const st = await lstat(path.join(dir, child));
      const buf = await readFile(path.join(dir, child));
      const sha256 = createHash("sha256").update(buf).digest("hex");
      const binary = buf.subarray(0, 8192).includes(0);
      out.push({
        path: child,
        text: !binary && st.size <= SKEPTIC_MAX_TEXT_BYTES ? buf.toString("utf8") : "",
        sha256,
        size: st.size,
      });
    }
  }
  await walk("");
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export const under = (p: string, dir: string): boolean => {
  const d = normalizeKitPath(dir);
  return p === d || p.startsWith(`${d}/`);
};

/** gates/, reference/, proof/ and mined/: never shipped to the subject computer. */
export function isScoringOnlyPath(p: string): boolean {
  return (
    under(p, KIT_LAYOUT.gatesDir) ||
    under(p, KIT_LAYOUT.referenceDir) ||
    under(p, KIT_LAYOUT.proofDir) ||
    under(p, "mined")
  );
}

export interface HiddenTestFile extends KitTextFile {
  gate: string;
  /** The workload it grades, or null when it is shared by every workload. */
  workload: string | null;
}

const TESTISH =
  /(\.(test|spec)\.[cm]?[jt]sx?$)|((^|\/)test_[^/]+\.py$)|(_test\.(py|go)$)|((^|\/)tests?\.json$)|((^|\/)tests\/[^/]+\.(rs|py|rb|[cm]?[jt]s)$)/;

/** The hidden test files of a kit: test-like files under gates/<gate>/, by workload. */
export function hiddenTestFiles(spec: KitSpec, files: readonly KitTextFile[]): HiddenTestFile[] {
  const workloadIds = new Set(spec.workloads.map((w) => w.id));
  const out: HiddenTestFile[] = [];
  for (const g of spec.gates) {
    const root = KIT_LAYOUT.gateDir(g.id);
    for (const f of files) {
      if (!under(f.path, root) || f.text === "") continue;
      const rest = f.path.slice(root.length + 1).split("/");
      const wl = rest.length > 1 && workloadIds.has(rest[0]!) ? rest[0]! : null;
      // A mined task keeps its hidden tests at their repo paths under files/: all of them count.
      const mined = wl !== null && rest[1] === "files";
      if (!mined && !TESTISH.test(f.path)) continue;
      out.push({ ...f, gate: g.id, workload: wl });
    }
  }
  return out;
}

// ---------- facts ----------

export interface TestFact {
  /** `name`: a test's title; `message`: an assertion message; `literal`: a value an assertion uses. */
  kind: "name" | "message" | "literal";
  /** As written in the source (escapes kept). */
  raw: string;
  /** Escapes resolved (`\n` → newline). */
  value: string;
  path: string;
  line: number;
}

const STRING_LITERAL = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
const TEST_CALL =
  /\b(?:test|it|describe|suite|specify|context)(?:\.(?:only|skip|todo|each\([^)]*\)))?\(\s*(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
const PY_TEST = /^\s*(?:async\s+)?def\s+(test_\w+)/;
const GO_TEST = /^\s*func\s+(Test\w+)\s*\(/;
const ASSERTION_LINE =
  /\b(assert\w*|expect|should|t\.(?:is|not|deepEqual|equal|true|false|throws|regex)|assertEquals|assert_eq!?|require\.\w+)\b/;

export function unescapeLiteral(raw: string): string {
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, e: string) => {
    switch (e[0]) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "u":
        return String.fromCodePoint(Number.parseInt(e.replace(/[u{}]/g, ""), 16));
      case "x":
        return String.fromCharCode(Number.parseInt(e.slice(1), 16));
      default:
        return e;
    }
  });
}

function identifierToWords(id: string): string {
  return id
    .replace(/^(test_?|Test)/, "")
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
}

/** Test names, assertion messages and assertion literals in one hidden test file. */
export function extractTestFacts(file: Pick<KitTextFile, "path" | "text">): TestFact[] {
  const facts: TestFact[] = [];
  if (file.path.endsWith(".json")) {
    // tests.json: `{tests: [{name}]}` (our kits) or `FAIL_TO_PASS: [...]` (mined).
    let data: unknown;
    try {
      data = JSON.parse(file.text) as unknown;
    } catch {
      return facts;
    }
    const lines = file.text.split("\n");
    const lineOf = (s: string) => {
      const i = lines.findIndex((l) => l.includes(JSON.stringify(s).slice(1, -1)));
      return i < 0 ? 1 : i + 1;
    };
    const visit = (v: unknown, key: string | null): void => {
      if (typeof v === "string") {
        if (key === "name" || key === "FAIL_TO_PASS" || key === "fail_to_pass") {
          facts.push({ kind: "name", raw: v, value: v, path: file.path, line: lineOf(v) });
        }
      } else if (Array.isArray(v)) v.forEach((x) => visit(x, key));
      else if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) visit(x, k);
      }
    };
    visit(data, null);
    return facts;
  }
  const lines = file.text.split("\n");
  lines.forEach((line, i) => {
    const n = i + 1;
    for (const m of line.matchAll(TEST_CALL)) {
      facts.push({
        kind: "name",
        raw: m[2]!,
        value: unescapeLiteral(m[2]!),
        path: file.path,
        line: n,
      });
    }
    const py = PY_TEST.exec(line) ?? GO_TEST.exec(line);
    if (py) {
      facts.push({
        kind: "name",
        raw: py[1]!,
        value: identifierToWords(py[1]!),
        path: file.path,
        line: n,
      });
    }
    if (!ASSERTION_LINE.test(line)) return;
    for (const m of line.matchAll(STRING_LITERAL)) {
      const raw = m[2]!;
      const value = unescapeLiteral(raw);
      // A message reads like a sentence: several words, letters only around them.
      const kind = /^[A-Za-z][\w'’,-]*(\s+[\w'’,()/-]+){3,}[.!]?$/.test(value)
        ? "message"
        : "literal";
      facts.push({ kind, raw, value, path: file.path, line: n });
    }
  });
  return facts;
}

// ---------- text helpers ----------

export const normText = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

/** The `inline code` spans of a markdown text, with their lines. */
export function codeSpans(text: string): { value: string; line: number }[] {
  const out: { value: string; line: number }[] = [];
  text.split("\n").forEach((l, i) => {
    for (const m of l.matchAll(/`([^`\n]+)`/g)) out.push({ value: m[1]!, line: i + 1 });
  });
  return out;
}

/** The 1-based line of the first occurrence of `needle` (case-insensitive), or 1. */
export function lineOfText(text: string, needle: string): number {
  const lower = text.toLowerCase();
  let at = lower.indexOf(needle.toLowerCase());
  if (at < 0) {
    // The needle wrapped across lines (markdown prose): match its words with any whitespace.
    const words = needle.trim().split(/\s+/).filter(Boolean);
    if (words.length > 1) {
      const re = new RegExp(
        words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"),
        "i",
      );
      at = re.exec(text)?.index ?? -1;
    }
  }
  if (at < 0) {
    // Last resort: the first word.
    const first = needle.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    const j = first ? lower.indexOf(first) : -1;
    return j < 0 ? 1 : lower.slice(0, j).split("\n").length;
  }
  return lower.slice(0, at).split("\n").length;
}

/**
 * A literal is worth matching when it is not a bare identifier, path, route, number or status
 * code: those are the public contract, and the instruction must name them.
 */
export function isTellingLiteral(v: string, min = 6): boolean {
  const s = v.trim();
  if (s.length < min) return false;
  if (/^[\w./:@#$-]+$/.test(s)) return false;
  if (/^[\d\s.,:-]+$/.test(s)) return false;
  // A template with interpolation is code, not a value.
  if (/\$\{/.test(s)) return false;
  return true;
}

/**
 * TDM-233: does kit path `p` match a declared pattern? A pattern is a kit-relative path; a
 * trailing `/` covers everything under it, and a segment that is exactly `*` matches any one
 * segment (`gates/hidden-tests/<asterisk>/fixtures/`). Nothing else is special.
 */
export function matchesKitPattern(pattern: string, p: string): boolean {
  const dir = pattern.endsWith("/");
  const want = pattern.replace(/\/+$/, "").split("/");
  const have = p.split("/");
  if (dir ? have.length <= want.length : have.length !== want.length) return false;
  return want.every((seg, i) => seg === "*" || seg === have[i]);
}
