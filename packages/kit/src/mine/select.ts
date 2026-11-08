// TDM-186 [16.15]: candidate selection, from a local clone's history alone (no computer).
//
// A candidate is a non-merge commit that adds or modifies test files AND changes non-test source
// (the fix), with a small diff. Everything else is dropped with a reason: merges, docs-only and
// lockfile-only commits, vendored-only changes, tests without a fix, fixes that delete or rename
// files (the oracle is an overlay of files, so it cannot express a deletion), binary changes and
// oversized diffs.
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { isTestPath } from "../ingest/github.js";
import { git, repoTop, resolveCommit } from "./git.js";
import {
  MineCandidateSchema,
  type MineCandidate,
  type MineDrop,
  type MineDropCode,
  type MineFileChange,
} from "./schema.js";

export interface MineSizeLimits {
  maxTestFiles: number;
  maxFixFiles: number;
  /** Added + deleted lines over the fix files. */
  maxFixLines: number;
  /** Added + deleted lines over the test files. */
  maxTestLines: number;
}

export const DEFAULT_MINE_SIZE_LIMITS: MineSizeLimits = {
  maxTestFiles: 8,
  maxFixFiles: 6,
  maxFixLines: 300,
  maxTestLines: 600,
};

export interface SelectMineCandidatesOptions {
  /** Newest commit to scan from. Default HEAD. */
  rev?: string;
  /** How many commits to scan (newest first). Default 1000. */
  depth?: number;
  limits?: Partial<MineSizeLimits>;
}

export interface SelectMineCandidatesResult {
  head: string;
  commits_scanned: number;
  /** Newest first. */
  candidates: MineCandidate[];
  dropped: MineDrop[];
}

// ---------------------------------------------------------------------------------------------
// Path classes

const VENDORED_RE =
  /(^|\/)(vendor|vendored|third[_-]party|node_modules|bower_components|external|extern)\//i;
const GENERATED_RE = /(^|\/)(dist|build|out|coverage)\/|\.min\.(js|css)$|\.map$/i;
/** CI and repo-housekeeping config: never part of a fix's oracle. */
const CI_RE =
  /^(\.github|\.circleci|\.gitlab|\.buildkite|\.husky|\.devcontainer)\/|^\.(travis\.yml|pre-commit-config\.yaml|pre-commit-hooks\.yaml|editorconfig|gitignore|gitattributes|mailmap|bumpversion\.cfg|git-blame-ignore-revs)$/;
const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "pdm.lock",
  "go.sum",
  "Gemfile.lock",
  "composer.lock",
]);
const DOC_EXT_RE = /\.(md|mdx|markdown|rst|adoc|asciidoc)$/i;
const DOC_NAME_RE =
  /^(license|licence|copying|changelog|changes|history|news|authors|contributors|notice|readme|code_of_conduct|security|support)(\.[a-z0-9]+)?$/i;
const SOURCE_EXT_RE =
  /\.(m?[jt]sx?|c[jt]s|py|pyi|go|rs|rb|java|kt|kts|scala|swift|c|h|cc|cpp|cxx|hpp|hh|cs|fs|php|lua|ex|exs|erl|clj|hs|ml|nim|dart|zig|jl|r|sh|bash|vue|svelte|sql)$/i;

export function isLockfilePath(path: string): boolean {
  return LOCKFILES.has(basename(path));
}

export function isDocPath(path: string): boolean {
  if (DOC_EXT_RE.test(path) || DOC_NAME_RE.test(basename(path))) return true;
  return /^(docs?|documentation)\//i.test(path) && !SOURCE_EXT_RE.test(path);
}

export function isVendoredPath(path: string): boolean {
  return VENDORED_RE.test(path) || GENERATED_RE.test(path);
}

export function isSourcePath(path: string): boolean {
  return SOURCE_EXT_RE.test(path);
}

// ---------------------------------------------------------------------------------------------
// Reading the log

interface RawChange {
  path: string;
  status: string;
  added: number | null;
  deleted: number | null;
}

interface LogCommit {
  sha: string;
  parents: string[];
  author_date: string;
  commit_date: string;
  subject: string;
  changes: RawChange[];
}

/** git's C-style quoted path ("a\tb", octal bytes) back to text. */
function unquote(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const bytes: number[] = [];
  const s = p.slice(1, -1);
  const esc: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, "\\": 92, a: 7, b: 8 };
  for (let i = 0; i < s.length; i++) {
    const c = s[i] ?? "";
    if (c !== "\\") {
      bytes.push(...Buffer.from(c, "utf8"));
      continue;
    }
    const n = s[i + 1] ?? "";
    if (/[0-7]/.test(n)) {
      bytes.push(parseInt(s.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(esc[n] ?? n.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

async function readLog(repo: string, head: string, depth: number): Promise<LogCommit[]> {
  const raw = await git(repo, [
    "log",
    `-n${depth}`,
    "--no-renames",
    "--raw",
    "--numstat",
    "--format=%x1e%H%x1f%P%x1f%aI%x1f%cI%x1f%s",
    "--end-of-options",
    head,
  ]);
  const out: LogCommit[] = [];
  for (const rec of raw.split("\x1e")) {
    if (!rec.trim()) continue;
    const [headLine = "", ...lines] = rec.split("\n");
    const [sha = "", parents = "", author_date = "", commit_date = "", subject = ""] =
      headLine.split("\x1f");
    if (!/^[a-f0-9]{40}$/.test(sha)) continue;
    const byPath = new Map<string, RawChange>();
    for (const line of lines) {
      if (!line) continue;
      if (line.startsWith(":")) {
        const tab = line.indexOf("\t");
        const meta = line.slice(1, tab).split(" ");
        const path = unquote(line.slice(tab + 1));
        const c = byPath.get(path) ?? { path, status: "", added: null, deleted: null };
        c.status = (meta[4] ?? "").charAt(0);
        // A mode change to/from a symlink or submodule is a type change.
        if (meta[0] === "160000" || meta[1] === "160000") c.status = "T";
        byPath.set(path, c);
        continue;
      }
      const m = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(line);
      if (!m) continue;
      const path = unquote(m[3] ?? "");
      const c = byPath.get(path) ?? { path, status: "", added: null, deleted: null };
      c.added = m[1] === "-" ? null : Number(m[1]);
      c.deleted = m[2] === "-" ? null : Number(m[2]);
      byPath.set(path, c);
    }
    out.push({
      sha,
      parents: parents.split(" ").filter((p) => /^[a-f0-9]{40}$/.test(p)),
      author_date,
      commit_date,
      // eslint-disable-next-line no-control-regex
      subject: subject.replace(/[\x00-\x1f]/g, " ").slice(0, 200),
      changes: [...byPath.values()],
    });
  }
  return out;
}

async function readShallow(repo: string): Promise<Set<string>> {
  const p = (await git(repo, ["rev-parse", "--git-path", "shallow"])).trim();
  try {
    const text = await readFile(resolve(repo, p), "utf8");
    return new Set(text.split("\n").filter((l) => /^[a-f0-9]{40}$/.test(l)));
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------------------------
// Classification

type Verdict =
  { ok: true; candidate: MineCandidate } | { ok: false; code: MineDropCode; detail: string };

function toChange(c: RawChange): MineFileChange {
  return {
    path: c.path,
    status: c.status === "A" ? "added" : "modified",
    added: c.added ?? 0,
    deleted: c.deleted ?? 0,
  };
}

const lines = (cs: readonly RawChange[]): number =>
  cs.reduce((n, c) => n + (c.added ?? 0) + (c.deleted ?? 0), 0);

/** Decide one commit. Exported for the tests. */
export function classifyMineCommit(
  c: LogCommit,
  shallow: ReadonlySet<string>,
  limits: MineSizeLimits,
): Verdict {
  const drop = (code: MineDropCode, detail: string): Verdict => ({ ok: false, code, detail });
  if (c.parents.length > 1) return drop("merge", `merge of ${c.parents.length} parents`);
  if (shallow.has(c.sha)) return drop("shallow_boundary", "shallow clone boundary");
  const parent = c.parents[0];
  if (!parent) return drop("root_commit", "root commit (no parent tree)");
  const files = c.changes;
  if (files.length === 0) return drop("no_test_change", "empty commit");
  if (files.every((f) => isDocPath(f.path))) return drop("docs_only", "only docs changed");
  if (files.every((f) => isLockfilePath(f.path))) return drop("lockfile_only", "only lockfiles");

  const tests = files.filter((f) => isTestPath(f.path) && !isVendoredPath(f.path));
  if (tests.length === 0) return drop("no_test_change", "no test file changed");
  const rest = files.filter((f) => !tests.includes(f));
  const ignored = rest.filter((f) => isDocPath(f.path) || CI_RE.test(f.path));
  const vendored = rest.filter((f) => !ignored.includes(f) && isVendoredPath(f.path));
  const fix = rest.filter((f) => !ignored.includes(f) && !vendored.includes(f));
  if (fix.length === 0) {
    return vendored.length > 0
      ? drop("vendored_only", `only vendored/generated files besides tests: ${vendored[0]?.path}`)
      : drop("tests_only", "tests changed without a fix");
  }
  if (!fix.some((f) => isSourcePath(f.path))) {
    return drop(
      "no_source_change",
      `no source file in the fix (${fix.map((f) => f.path).join(", ")})`,
    );
  }
  const graded = [...tests, ...fix];
  const bad = graded.find((f) => f.status !== "A" && f.status !== "M");
  if (bad) {
    return drop(
      "deletes_or_renames",
      `${bad.path} is ${bad.status === "D" ? "deleted" : `status ${bad.status || "?"}`}`,
    );
  }
  const binary = graded.find((f) => f.added === null || f.deleted === null);
  if (binary) return drop("binary_change", `${binary.path} is binary`);
  const fixLines = lines(fix);
  const testLines = lines(tests);
  if (tests.length > limits.maxTestFiles)
    return drop("too_large", `${tests.length} test files > ${limits.maxTestFiles}`);
  if (fix.length > limits.maxFixFiles)
    return drop("too_large", `${fix.length} fix files > ${limits.maxFixFiles}`);
  if (fixLines > limits.maxFixLines)
    return drop("too_large", `${fixLines} fix lines > ${limits.maxFixLines}`);
  if (testLines > limits.maxTestLines)
    return drop("too_large", `${testLines} test lines > ${limits.maxTestLines}`);

  const candidate = MineCandidateSchema.parse({
    sha: c.sha,
    parent,
    author_date: c.author_date,
    commit_date: c.commit_date,
    subject: c.subject,
    test_files: tests.map(toChange),
    fix_files: fix.map(toChange),
    ignored_files: [...ignored, ...vendored].map((f) => f.path),
    stats: { files_changed: files.length, test_lines: testLines, fix_lines: fixLines },
  });
  return { ok: true, candidate };
}

/** Scan `depth` commits from `rev` and split them into candidates and drops. */
export async function selectMineCandidates(
  repoDir: string,
  opts: SelectMineCandidatesOptions = {},
): Promise<SelectMineCandidatesResult> {
  const repo = await repoTop(repoDir);
  const head = await resolveCommit(repo, opts.rev ?? "HEAD");
  const limits = { ...DEFAULT_MINE_SIZE_LIMITS, ...opts.limits };
  const log = await readLog(repo, head, opts.depth ?? 1000);
  const shallow = await readShallow(repo);
  const candidates: MineCandidate[] = [];
  const dropped: MineDrop[] = [];
  for (const c of log) {
    const v = classifyMineCommit(c, shallow, limits);
    if (v.ok) candidates.push(v.candidate);
    else dropped.push({ sha: c.sha, stage: "select", code: v.code, detail: v.detail });
  }
  return { head, commits_scanned: log.length, candidates, dropped };
}

export type { LogCommit as MineLogCommit };
