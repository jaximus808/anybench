// TDM-44: mutation operators on the oracle's source, for the mutation kill rate of a hidden-tests
// gate (plan.md 17.2 rule 9: "a mutation kill rate ≥90%, with survivors listed").
//
// Each mutant changes ONE site of ONE oracle source file with one of four operators:
//   flip-comparison     `===` ↔ `!==`, `==` ↔ `!=`, `<` ↔ `>=`, `>` ↔ `<=`
//   drop-error-branch   a `throw …` / `raise …` statement becomes a no-op
//   off-by-one          an integer literal n becomes n + 1
//   return-before-persist  a bare `return` right before a line that persists (write, save, commit…)
//   drop-statement      one statement or chained call (`.replace(…)`) is removed: one contract
//                       clause of the oracle left out
// Operators are textual and language-light (JS/TS, Python, Go, Rust, Ruby, shell-free sources):
// a mutant that does not parse still counts (the tests must catch it), and an equivalent mutant
// survives and is listed, which is the honest outcome. Comment lines and string literals are
// skipped where cheap to tell. Sites are taken in file order and capped, so the set is
// deterministic for a given oracle.

export const MUTATION_OPERATORS = [
  "flip-comparison",
  "drop-error-branch",
  "off-by-one",
  "return-before-persist",
  "drop-statement",
] as const;
export type MutationOperator = (typeof MUTATION_OPERATORS)[number];

/** Source files the operators apply to, by extension. */
export const MUTABLE_SOURCE_EXTENSIONS = [
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".mts",
  ".cts",
  ".jsx",
  ".tsx",
  ".py",
  ".go",
  ".rs",
  ".rb",
  ".java",
  ".kt",
  ".c",
  ".cc",
  ".cpp",
  ".h",
] as const;

export interface Mutant {
  /** `<operator>@<file>:<line>` (+ `#<n>` when one line has several sites): stable, for evidence. */
  id: string;
  operator: MutationOperator;
  /** The oracle file (path relative to the oracle's workload dir). */
  file: string;
  /** 1-based line of the change. */
  line: number;
  /** The whole mutated file. */
  content: string;
}

export function isMutableSource(file: string): boolean {
  const dot = file.lastIndexOf(".");
  return dot >= 0 && (MUTABLE_SOURCE_EXTENSIONS as readonly string[]).includes(file.slice(dot));
}

function isPython(file: string): boolean {
  return file.endsWith(".py");
}

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return (
    t.startsWith("//") ||
    t.startsWith("#") ||
    t.startsWith("/*") ||
    t.startsWith("*") ||
    t.startsWith("--")
  );
}

/** Character ranges of string literals on one line ('…', "…", `…`), to skip them. */
function stringRanges(line: string): [number, number][] {
  const out: [number, number][] = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    if (c === '"' || c === "'" || c === "`") {
      const start = i++;
      while (i < line.length && line[i] !== c) i += line[i] === "\\" ? 2 : 1;
      out.push([start, i]);
    } else if (c === "/" && line[i + 1] === "/") {
      out.push([i, line.length]); // trailing comment
      break;
    }
    i++;
  }
  return out;
}

function inRanges(i: number, ranges: readonly [number, number][]): boolean {
  return ranges.some(([a, b]) => i >= a && i <= b);
}

interface Site {
  operator: MutationOperator;
  line: number;
  apply: (lines: string[]) => string[];
}

const COMPARISON = /(===|!==|==|!=|<=|>=|(?<![<=-])<(?![<=])|(?<![>=-])>(?![>=]))/g;
const FLIP: Record<string, string> = {
  "===": "!==",
  "!==": "===",
  "==": "!=",
  "!=": "==",
  "<": ">=",
  ">=": "<",
  ">": "<=",
  "<=": ">",
};
const PERSIST =
  /\b(writeFile(?:Sync)?|appendFile(?:Sync)?|\.save\(|\.write\(|\.commit\(|\.insert\(|\.put\(|\.persist\(|json\.dump|\.set\(|localStorage\.setItem|\.flush\()/;
const THROW_JS = /\bthrow\b[^;]*;?/;
const RAISE_PY = /\braise\b.*$/;

function comparisonSites(lines: readonly string[]): Site[] {
  const sites: Site[] = [];
  lines.forEach((line, li) => {
    if (isCommentLine(line)) return;
    // Generics (`Array<T>`), arrows (`=>`, `->`), shifts and HTML-ish lines are skipped: only a
    // comparison with an operand on both sides counts.
    const ranges = stringRanges(line);
    for (const m of line.matchAll(COMPARISON)) {
      const op = m[0];
      const at = m.index;
      if (inRanges(at, ranges)) continue;
      if ((op === "<" || op === ">") && !/\s/.test(line[at - 1] ?? "")) continue;
      if ((op === "<" || op === ">") && !/\s/.test(line[at + 1] ?? "")) continue;
      sites.push({
        operator: "flip-comparison",
        line: li + 1,
        apply: (ls) => {
          const out = [...ls];
          out[li] = line.slice(0, at) + FLIP[op]! + line.slice(at + op.length);
          return out;
        },
      });
    }
  });
  return sites;
}

function errorBranchSites(lines: readonly string[], python: boolean): Site[] {
  const sites: Site[] = [];
  lines.forEach((line, li) => {
    if (isCommentLine(line)) return;
    const re = python ? RAISE_PY : THROW_JS;
    const m = re.exec(line);
    if (!m || inRanges(m.index, stringRanges(line))) return;
    sites.push({
      operator: "drop-error-branch",
      line: li + 1,
      apply: (ls) => {
        const out = [...ls];
        out[li] =
          line.slice(0, m.index) +
          (python ? "pass" : "void 0;") +
          line.slice(m.index + m[0].length);
        return out;
      },
    });
  });
  return sites;
}

function offByOneSites(lines: readonly string[]): Site[] {
  const sites: Site[] = [];
  lines.forEach((line, li) => {
    if (isCommentLine(line)) return;
    const ranges = stringRanges(line);
    for (const m of line.matchAll(/(?<![\w.$])(\d+)(?![\w.])/g)) {
      if (inRanges(m.index, ranges)) continue;
      const n = Number.parseInt(m[1]!, 10);
      if (!Number.isSafeInteger(n)) continue;
      const at = m.index;
      sites.push({
        operator: "off-by-one",
        line: li + 1,
        apply: (ls) => {
          const out = [...ls];
          out[li] = line.slice(0, at) + String(n + 1) + line.slice(at + m[1]!.length);
          return out;
        },
      });
    }
  });
  return sites;
}

function persistSites(lines: readonly string[], python: boolean): Site[] {
  const sites: Site[] = [];
  lines.forEach((line, li) => {
    if (isCommentLine(line) || !PERSIST.test(line)) return;
    const indent = /^\s*/.exec(line)![0];
    sites.push({
      operator: "return-before-persist",
      line: li + 1,
      apply: (ls) => {
        const out = [...ls];
        out.splice(li, 0, `${indent}${python ? "return" : "return;"}`);
        return out;
      },
    });
  });
  return sites;
}

const NOT_A_STATEMENT =
  /^(const|let|var|return|function|class|import|export|if|else|for|while|switch|case|default|try|catch|finally|def|elif|async|await|yield|pub|fn|use|package)\b/;

function dropStatementSites(lines: readonly string[]): Site[] {
  const sites: Site[] = [];
  lines.forEach((line, li) => {
    const t = line.trim();
    if (t === "" || isCommentLine(line)) return;
    const chained = /^\.[A-Za-z_$][\w$]*\(.*\)[;,]?$/.test(t);
    const statement = /;$/.test(t) && !NOT_A_STATEMENT.test(t) && !/[{}]/.test(t) && /\(/.test(t);
    if (!chained && !statement) return;
    sites.push({
      operator: "drop-statement",
      line: li + 1,
      apply: (ls) => {
        const out = [...ls];
        // A chained call that ends the expression hands its `;` to the line before.
        if (chained && t.endsWith(";") && li > 0)
          out[li - 1] = `${out[li - 1]!.replace(/\s+$/, "")};`;
        out.splice(li, 1);
        return out;
      },
    });
  });
  return sites;
}

export interface MutateOptions {
  /** At most this many mutants per operator per file (default 4), spread over the file. */
  perOperatorPerFile?: number;
  /** At most this many mutants in total (default 24). */
  max?: number;
  /**
   * TDM-60: only mutate these 1-based lines of these files (mined tasks: the lines the fix
   * changed; the rest of the file is the repo as it was, covered by PASS_TO_PASS, not the task).
   */
  lines?: ReadonlyMap<string, ReadonlySet<number>>;
}

/** Spread `n` picks over `xs` (first, last and evenly between), keeping order. */
function spread<T>(xs: readonly T[], n: number): T[] {
  if (xs.length <= n) return [...xs];
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(xs[Math.round((i * (xs.length - 1)) / (n - 1 || 1))]!);
  return [...new Set(out)];
}

/** Mutants of one source file. */
export function mutateSource(file: string, content: string, opts: MutateOptions = {}): Mutant[] {
  if (!isMutableSource(file)) return [];
  const per = opts.perOperatorPerFile ?? 4;
  const lines = content.split("\n");
  const python = isPython(file);
  const groups: Site[][] = [
    comparisonSites(lines),
    errorBranchSites(lines, python),
    offByOneSites(lines),
    persistSites(lines, python),
    dropStatementSites(lines),
  ];
  const out: Mutant[] = [];
  const perLine = new Map<string, number>();
  const only = opts.lines?.get(file);
  for (const all of groups) {
    const g = opts.lines ? all.filter((s) => only?.has(s.line) === true) : all;
    for (const s of spread(g, per)) {
      const mutated = s.apply(lines).join("\n");
      if (mutated === content) continue;
      const key = `${s.operator}@${file}:${s.line}`;
      const k = (perLine.get(key) ?? 0) + 1;
      perLine.set(key, k);
      out.push({
        id: k === 1 ? key : `${key}#${k}`,
        operator: s.operator,
        file,
        line: s.line,
        content: mutated,
      });
    }
  }
  return out;
}

/** Mutants of a set of oracle files (path → text), capped at `max`, spread over the files. */
export function mutateOracle(
  files: ReadonlyMap<string, string>,
  opts: MutateOptions = {},
): Mutant[] {
  const all: Mutant[] = [];
  for (const [file, content] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    all.push(...mutateSource(file, content, opts));
  }
  return spread(all, opts.max ?? 24);
}
