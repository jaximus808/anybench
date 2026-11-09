// TDM-187 [16.16]: the skeptic's deterministic checks on a kit directory, run before (and fed to)
// the Naïve skeptic. Each check returns findings `{id, severity, check, evidence: path:line, why}`.
//
//   no-leak lint         TDM-60's generate/lint.ts noLeakIssues, reused as findings: answer names
//                        and scoring-identical files under workloads/, test names, asserted values
//                        and scoring paths in instructions.
//   solution_leakage     instruction.md copies an assertion message, quotes the
//                        values the assertions expect, or (a bug ticket) lists the rules the
//                        hidden tests assert as bullets: the fix spelled out (SWE-bench+).
//   answer_in_workloads  a file under workloads/ names hidden tests or holds a reference output (block when it ships: input/,
//                        instruction.md, setup.sh; warn for kit-side notes).
//   contract (TDM-233)   a workload with `instruction_kind: contract` (a build-to-spec task whose
//                        instruction IS the contract the tests check, 17.2 rule 9): hidden test
//                        names, assertion messages and asserted values in its instruction are the
//                        contract, not leakage. Instead it must hold no line of the oracle's or
//                        the hidden tests' code (beyond what the starting repo already has): a
//                        copy blocks. The declaration is always reported as a warning. The bug-
//                        ticket rule list, scoring paths and test file names still block.
//   fixtures (TDM-233)   a file under a workload's input/ byte-identical to a gate's declared
//                        `fixtures` copy (the grader's own copy of an input) is a disclosed warning,
//                        not an answer; any other identical scoring file still blocks.
//   noop_passable        the proof's do-less runs passed the gate (a no-op passing = the hidden
//                        tests already pass on the untouched input), or a gate script that has no
//                        way to fail.
//   weak_do_less         no do-less variant, or only a no-op.
//   one_sided_assist     an instruction file (CLAUDE.md, AGENTS.md, ...) for some agent contenders
//                        of a driver type and not others; adapter help that names the tasks.
//   one_sided_weight     weight on a metric only some contenders' collectors produce; weight on a
//                        vanity metric (17.4 "never a headline"); LLM-judged quality with weight.
//   contamination        the reference captured from the subject's own output; mined tasks dated
//                        before a contender model's training cutoff (or with no known cutoff).
//   comparability        the comparability validator's issues, reused (validateKitDir), not redone.
//   ungated_measure      a measured requirement without a gate (the schema refuses it; checked again).
//   too_few_tasks        an agent kit under 20 tasks (the report must say "on these N tasks"),
//                        a "beats" claim in the kit text without that wording, too few repeats.
//
// The final verdict is decideSkepticVerdict (finding.ts). Nothing here sees contender scores.
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  DRIVER_DEFAULT_COLLECTORS,
  isAgentDriver,
  type CollectorName,
  type KitSpec,
  type ProofCheckResult,
} from "@anybench/core";
import type { KitIssue, KitIssueCode } from "../issues.js";
import { ANSWER_NAME, hiddenTestMarkers, noLeakIssues } from "../generate/lint.js";
import { KIT_LAYOUT } from "../layout.js";
import { parseKitManifest } from "../manifest.js";
import { doLessKind } from "../proof/suite.js";
import { validateKitDir } from "../validate.js";
import { positionOf, type KitYamlSource } from "../yaml-source.js";
import { SkepticFindingSchema, type SkepticFinding, type SkepticFindingInput } from "./finding.js";
import {
  codeSpans,
  extractTestFacts,
  hiddenTestFiles,
  isTellingLiteral,
  lineOfText,
  matchesKitPattern,
  normText,
  readKitFiles,
  under,
  type HiddenTestFile,
  type KitTextFile,
  type TestFact,
} from "./material.js";

export interface SkepticChecksOptions {
  /** Proof results for this kit, when the proof stage already ran (a repair). */
  proof?: readonly ProofCheckResult[] | null;
  /**
   * Training-data cutoffs (`YYYY-MM-DD`) by contender model id. A mined task dated on or before a
   * contender's cutoff blocks; with no cutoff known it warns. No cutoffs are built in: add them
   * with a cited source.
   */
  modelCutoffs?: Readonly<Record<string, string>>;
}

/** What the checks read, reused by the Naïve skeptic's input (packages/agents skeptic.ts). */
export interface SkepticKitMaterial {
  dir: string;
  spec: KitSpec;
  files: KitTextFile[];
  hidden: HiddenTestFile[];
  facts: TestFact[];
}

export interface SkepticChecksResult {
  findings: SkepticFinding[];
  /** Null when the manifest itself does not parse (then the findings say why). */
  material: SkepticKitMaterial | null;
}

/** Validator codes that are comparability rules (comparability.ts): reported as `comparability`. */
const COMPARABILITY_CODES: ReadonlySet<KitIssueCode> = new Set<KitIssueCode>([
  "model_unpinned",
  "model_mismatch",
  "service_unpinned",
  "ref_unpinned",
  "version_unpinned",
  "version_mismatch",
  "caps_unequal",
  "token_cap_deprecated",
  "token_cap_conflict",
  "assist_unequal",
  "subagents_not_disabled",
  "token_source_unequal",
  "order_not_rotated",
]);

/** Tasks an agent "beats" claim needs (17.2 rule 3). */
export const MIN_TASKS_FOR_BEATS = 20;
/** Agent repeats per cell: default and floor (17.2 rule 3). */
export const AGENT_REPEATS_DEFAULT = 10;
export const AGENT_REPEATS_FLOOR = 4;
export const SOFTWARE_REPEATS_DEFAULT = 5;
/** Distinct oracle / hidden-test code lines a contract instruction may carry before it blocks. */
export const CONTRACT_COPY_LINES = 3;
/** Share of a bug ticket's hidden tests its own bullets restate before it counts as the fix spelled out. */
export const RULE_LISTING_SHARE = 0.6;

/** 17.4 "never a headline": raw tokens, turns, claims, lines of code, user CPU alone, ... */
const VANITY_METRIC =
  /^(raw_)?(total_|input_|output_)?tokens?(_used)?$|^(num_)?turns$|^claims$|^tickets(_\w+)?$|^(loc|lines(_of_code|_changed|_added)?)$|^user_cpu(_s|_ms)?$|^tone(_score)?$|^lighthouse(_score)?$|^peak_rps$|^bytes_per_s$/;

/** Metrics only one collector produces. */
const METRIC_COLLECTOR: readonly (readonly [RegExp, CollectorName])[] = [
  [/^(board_|claims|conflicts|approvals|tickets)/, "tandem-board"],
  [/^(turns|num_turns|(input_|output_|cache_|total_)?tokens?)$/, "stream-json"],
  [/^lighthouse/, "lighthouse"],
  [/^(time_to_sentinel|pty_)/, "pty-sentinel"],
];

const INSTRUCTION_FILE =
  /(^|\/)(CLAUDE\.md|AGENTS\.md|GEMINI\.md|\.cursorrules|copilot-instructions\.md|CONVENTIONS\.md)$/i;

const BUG_SHAPED =
  /\b(bug|bugs|fix|fixes|broken|breaks|regression|crash(es)?|fails?|failing|ticket|issue|reported)\b/i;
const BEATS_CLAIM = /\b(beats|outperforms|(faster|cheaper|better|stronger) than)\b/i;
const ON_THESE_N = /\bon these (\d+|[a-z]+) (tasks|workloads)\b/i;

const STOP = new Set(
  (
    "the and for with that this from into onto when then than are was were has have had its " +
    "not but all any can will must should may per via a an of to in on is it be by as or at " +
    "one two each every same other new test tests returns return keep keeps only also"
  ).split(" "),
);

// ---------------------------------------------------------------------------------------------

/** What a contract instruction (TDM-233) shares with the hidden tests, for its disclosure. */
interface ContractTally {
  names: Set<string>;
  messages: Set<string>;
  values: Set<string>;
}

interface Ctx {
  m: SkepticKitMaterial;
  source: Pick<KitYamlSource, "doc" | "lineCounter"> | null;
  out: SkepticFinding[];
  ids: Map<string, number>;
  /** Contract workloads by id (instruction_kind: contract), filled by the leakage checks. */
  contract: Map<string, ContractTally>;
}

function add(c: Ctx, f: Omit<SkepticFindingInput, "id"> & { id?: string }): void {
  const base = f.id ?? f.check;
  const n = (c.ids.get(base) ?? 0) + 1;
  c.ids.set(base, n);
  c.out.push(SkepticFindingSchema.parse({ ...f, id: n === 1 ? base : `${base}-${n}` }));
}

/** `anybench.yaml:<line>` of a KitSpec field. */
function yamlAt(c: Ctx, at: readonly PropertyKey[]): string {
  const pos = c.source ? positionOf(c.source, at) : undefined;
  return `${KIT_LAYOUT.manifest}:${pos?.line ?? 1}`;
}

const fileText = (m: SkepticKitMaterial, p: string): string | undefined =>
  m.files.find((f) => f.path === p)?.text;

type KitWorkload = KitSpec["workloads"][number];
const instructionPath = (w: KitWorkload): string =>
  w.instruction ?? KIT_LAYOUT.workloadInstruction(w.id);
const inputPath = (w: KitWorkload): string =>
  (w.input ?? KIT_LAYOUT.workloadInput(w.id)).replace(/\/+$/, "");

/** TDM-233: the tally of a workload whose instruction is declared the contract, else null. */
function contractTally(c: Ctx, w: KitWorkload): ContractTally | null {
  if (w.instruction_kind !== "contract") return null;
  let t = c.contract.get(w.id);
  if (!t) {
    t = { names: new Set(), messages: new Set(), values: new Set() };
    c.contract.set(w.id, t);
  }
  return t;
}

const cut = (s: string, n = 80): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : `${flat.slice(0, n - 1)}…`;
};

function stem(w: string): string {
  let s = w;
  if (s.length > 5 && s.endsWith("ing")) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith("ed")) s = s.slice(0, -2);
  else if (s.length > 4 && /(ss|x|ch|sh)es$/.test(s)) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  if (s.length > 4 && s.endsWith("e")) s = s.slice(0, -1);
  return s;
}

/** Content words: no stopwords, no camelCase / snake_case identifiers (API names), stemmed. */
export function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const tok of text.split(/[^A-Za-z0-9_'’-]+/)) {
    if (tok === "" || /[a-z][A-Z]|_/.test(tok) || /^\d/.test(tok)) continue;
    for (const part of tok.toLowerCase().split(/[-'’]/)) {
      if (part.length < 3 || STOP.has(part)) continue;
      out.add(stem(part));
    }
  }
  return out;
}

const workloadFacts = (m: SkepticKitMaterial, id: string): TestFact[] => {
  const paths = new Set(
    m.hidden.filter((h) => h.workload === id || h.workload === null).map((h) => h.path),
  );
  return m.facts.filter((f) => paths.has(f.path));
};

/** Distinct test names (by normalized text). */
function testNames(facts: readonly TestFact[]): TestFact[] {
  const seen = new Set<string>();
  return facts.filter((f) => {
    if (f.kind !== "name") return false;
    const k = normText(f.value);
    if (k.length === 0 || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------- solution_leakage ----------

function checkLeakage(c: Ctx): void {
  const { m } = c;
  for (const w of m.spec.workloads) {
    const ipath = instructionPath(w);
    const instr = fileText(m, ipath);
    if (!instr) continue;
    // A declared contract states what the tests check (17.2 rule 9): checks 1 and 2 are its
    // content, tallied for the disclosure; checkContracts looks for copied code instead.
    const contract = contractTally(c, w);
    const facts = workloadFacts(m, w.id);
    if (facts.length === 0) continue;
    const instrNorm = normText(instr);
    const at = (needle: string) => `${ipath}:${lineOfText(instr, needle)}`;

    // 1. Assertion messages copied into the task (test names: the no-leak lint, lintFindings).
    for (const f of facts) {
      if (f.kind !== "message") continue;
      const v = normText(f.value);
      if (v.length < 16 || !instrNorm.includes(v)) continue;
      if (contract) {
        contract.messages.add(f.value);
        continue;
      }
      add(c, {
        severity: "block",
        check: "solution_leakage",
        evidence: at(f.value),
        why: `${ipath} copies the hidden assertion message "${cut(f.value)}" (${f.path}:${f.line}): the task must not name what the grader checks`,
      });
    }

    // 2. Values the assertions use, quoted in the task.
    const matches = new Map<string, { instrLine: number; test: string }>();
    for (const f of facts) {
      if (f.kind === "name") continue;
      for (const v of new Set([f.raw, f.value])) {
        // Plain lowercase prose ("wrong password") is weak evidence from the test side: want
        // punctuation, digits or capitals, or a long phrase.
        const prose = /^[a-z ]+$/.test(v.trim()) && v.trim().split(/\s+/).length < 4;
        if (!isTellingLiteral(v, 8) || prose || matches.has(v)) continue;
        if (instr.includes(v))
          matches.set(v, { instrLine: lineOfText(instr, v), test: `${f.path}:${f.line}` });
      }
    }
    for (const span of codeSpans(instr)) {
      if (!isTellingLiteral(span.value, 6) || matches.has(span.value)) continue;
      const f = facts.find(
        (x) => x.kind !== "name" && (x.raw.includes(span.value) || x.value.includes(span.value)),
      );
      if (f) matches.set(span.value, { instrLine: span.line, test: `${f.path}:${f.line}` });
    }
    if (contract) for (const v of matches.keys()) contract.values.add(v);
    else if (matches.size > 0) {
      const list = [...matches.entries()];
      const shown = list
        .slice(0, 3)
        .map(([v, x]) => `"${cut(v, 40)}" (${x.test})`)
        .join(", ");
      add(c, {
        severity: list.length >= 2 ? "block" : "warn",
        check: "solution_leakage",
        evidence: `${ipath}:${list[0]![1].instrLine}`,
        why: `${ipath} quotes ${list.length} value(s) the hidden assertions use: ${shown}${list.length > 3 ? ", …" : ""}. Describe the behaviour, not the expected outputs`,
      });
    }

    // 3. A bug ticket whose bullets restate the rules the hidden tests assert.
    const names = testNames(facts);
    const head = instr.split("\n").slice(0, 8).join("\n");
    if (names.length >= 3 && BUG_SHAPED.test(head)) {
      const bullets = instr
        .split("\n")
        .map((text, i) => ({ text, line: i + 1 }))
        .filter((b) => /^\s*(?:[-*+]|\d+[.)])\s+/.test(b.text));
      const bulletWords = bullets.map((b) => ({ ...b, words: contentWords(b.text) }));
      let covered = 0;
      let rated = 0;
      let firstLine: number | null = null;
      for (const n of names) {
        const kw = contentWords(n.value);
        if (kw.size < 2) continue;
        rated++;
        for (const b of bulletWords) {
          const hit = [...kw].filter((k) => b.words.has(k)).length;
          if (hit >= 2 && hit / kw.size >= 0.5) {
            covered++;
            firstLine ??= b.line;
            break;
          }
        }
      }
      if (rated >= 3 && covered / rated >= RULE_LISTING_SHARE) {
        add(c, {
          severity: "block",
          check: "solution_leakage",
          evidence: `${ipath}:${firstLine ?? 1}`,
          why: `${ipath} is a bug ticket whose bullet list restates ${covered} of the ${rated} hidden tests' rules: the fix is spelled out. Keep the user-visible symptoms; drop the rule list`,
        });
      }
    }
  }
}

// ---------- answer_in_workloads ----------

function checkAnswers(c: Ctx): void {
  const { m } = c;
  const hiddenNames = testNames(m.facts).filter((n) => normText(n.value).length >= 16);
  const hiddenBasenames = new Set(
    m.hidden.filter((h) => !h.path.endsWith(".json")).map((h) => path.posix.basename(h.path)),
  );
  const references = m.files.filter(
    (f) => under(f.path, KIT_LAYOUT.referenceDir) && f.text.trim().length >= 64,
  );

  for (const w of m.spec.workloads) {
    const root = KIT_LAYOUT.workloadDir(w.id);
    const input = inputPath(w);
    const shipped = (p: string) =>
      under(p, input) ||
      p === instructionPath(w) ||
      p === (w.setup ?? KIT_LAYOUT.workloadSetup(w.id));
    const contract = contractTally(c, w);
    for (const f of m.files.filter((x) => under(x.path, root))) {
      const ships = shipped(f.path);
      const where = ships ? "ships to the subject computer" : "is a kit-side note under workloads/";
      if (f.text === "") continue;
      const lower = normText(f.text);
      // A contract instruction restates the requirements the tests are named after (TDM-233);
      // a test FILE name or a reference output in it still blocks below.
      const named = hiddenNames.filter((n) => lower.includes(normText(n.value)));
      const contractText = contract !== null && f.path === instructionPath(w);
      if (contractText) for (const n of named) contract.names.add(n.value);
      const name = contractText ? undefined : named[0];
      const base = [...hiddenBasenames].find((b) => f.text.includes(b));
      const ref = references.find((r) => f.text.includes(r.text.trim()));
      const hit = name
        ? `the hidden test "${cut(name.value)}"`
        : base
          ? `the hidden test file ${base}`
          : ref
            ? `the reference output ${ref.path}`
            : null;
      if (!hit) continue;
      const needle = name?.value ?? base ?? ref!.text.trim().split("\n")[0]!;
      add(c, {
        severity: ships || ref ? "block" : "warn",
        check: "answer_in_workloads",
        evidence: `${f.path}:${lineOfText(f.text, needle)}`,
        why: `${f.path} names ${hit} and ${where}${ships ? "" : ": move it to proof/ or gates/ so it can never be copied into a workspace"}`,
      });
    }
  }
}

// ---------- the generated-kit no-leak lint (TDM-60), reused ----------

/**
 * packages/kit/src/generate lint.ts `noLeakIssues` as findings: answer-bearing names and files
 * identical to scoring files under workloads/, instructions that name a hidden test, quote an
 * asserted value or point at scoring-only files. Not re-implemented here.
 */
function lintFindings(c: Ctx, issues: readonly string[]): void {
  for (const line of issues) {
    const sep = line.indexOf(": ");
    const file = sep > 0 ? line.slice(0, sep) : KIT_LAYOUT.manifest;
    const msg = sep > 0 ? line.slice(sep + 2) : line;
    const text = fileText(c.m, file) ?? "";
    const named = /^names the hidden test '(.*)'$/.exec(msg)?.[1];
    const instruction = c.m.spec.workloads.some((w) => instructionPath(w) === file);
    // A declared contract (TDM-233): test names and asserted values are its content.
    const contractOf = c.m.spec.workloads.find(
      (w) => w.instruction_kind === "contract" && instructionPath(w) === file,
    );
    if (contractOf && (named !== undefined || /expected value/.test(msg))) {
      const t = contractTally(c, contractOf)!;
      if (named !== undefined) t.names.add(named);
      continue;
    }
    // A gate's declared fixture (TDM-233): the grader's own copy of an input, not an answer.
    const copyOf = /^identical to the scoring file (.+)$/.exec(msg)?.[1];
    const fixture = copyOf !== undefined ? declaredFixture(c.m, file, copyOf) : null;
    if (fixture) {
      add(c, {
        severity: "warn",
        check: "answer_in_workloads",
        evidence: `${file}:1`,
        why: `${file} is byte-identical to ${copyOf}, which gate '${fixture}' declares as its own copy of this input (gates[].fixtures): the task ships it and the grader reads its copy, so a contender's edit can't change the grade. Disclosed, not an answer`,
      });
      continue;
    }
    // Our own value check already blocked this instruction with the values it found.
    if (
      /expected value/.test(msg) &&
      c.out.some(
        (f) =>
          f.check === "solution_leakage" &&
          f.severity === "block" &&
          f.evidence.startsWith(`${file}:`) &&
          /value\(s\) the hidden assertions use/.test(f.why),
      )
    )
      continue;
    if (/expected value/.test(msg)) {
      // The lint does not say which value: find them with its own marker extractor, and keep
      // the block only for values that are not the public contract (a route, an error code).
      const values = c.m.hidden
        .flatMap((h) => hiddenTestMarkers(h.text).values)
        .filter((v, i, all) => all.indexOf(v) === i && text.includes(v));
      const telling = values.filter((v) => isTellingLiteral(v, 8));
      const shown = (telling.length > 0 ? telling : values).slice(0, 3);
      add(c, {
        severity: telling.length > 0 || values.length === 0 ? "block" : "warn",
        check: "solution_leakage",
        evidence: `${file}:${shown[0] ? lineOfText(text, shown[0]) : 1}`,
        why: `${file}: ${msg}${shown.length > 0 ? `: ${shown.map((v) => `"${cut(v, 40)}"`).join(", ")}` : ""} (no-leak lint)${telling.length === 0 && values.length > 0 ? "; only contract identifiers (routes, codes), which the task must name" : ""}`,
      });
      continue;
    }
    add(c, {
      severity: "block",
      check: instruction ? "solution_leakage" : "answer_in_workloads",
      evidence: `${file}:${named ? lineOfText(text, named) : 1}`,
      why: `${file}: ${msg} (no-leak lint)`,
    });
  }
}

/**
 * TDM-233: the gate that declares `scoringPath` one of its fixtures, when `workloadFile` is an
 * input file of a workload (not its instruction, setup or kit-side notes) and the fixture's own
 * name is not answer-shaped (expected / golden / reference / ...). Else null.
 */
function declaredFixture(
  m: SkepticKitMaterial,
  workloadFile: string,
  scoringPath: string,
): string | null {
  // An input file of a declared workload, or under the default input/ of a workload dir the
  // manifest does not list yet (a workload being added: it ships nothing until it is listed).
  const isInput =
    m.spec.workloads.some((x) => under(workloadFile, inputPath(x))) ||
    (/^workloads\/[^/]+\/input\//.test(workloadFile) &&
      !m.spec.workloads.some((x) => under(workloadFile, KIT_LAYOUT.workloadDir(x.id))));
  if (!isInput) return null;
  for (const g of m.spec.gates) {
    const root = KIT_LAYOUT.gateDir(g.id);
    if (!under(scoringPath, root) || scoringPath === root) continue;
    if (ANSWER_NAME.test(scoringPath.slice(root.length + 1))) continue;
    if (
      (g.fixtures ?? []).some((p) => p.startsWith(`${root}/`) && matchesKitPattern(p, scoringPath))
    )
      return g.id;
  }
  return null;
}

// ---------- contract instructions (TDM-233) ----------

const CODE_PUNCT = /[(){};=]/;

/** Normalized code-looking lines of a text (≥ 24 chars, code punctuation, not a comment or import). */
function codeLines(text: string): Map<string, number> {
  const out = new Map<string, number>();
  text.split("\n").forEach((raw, i) => {
    const n = raw.replace(/\s+/g, " ").trim();
    if (n.length < 24 || !CODE_PUNCT.test(n)) return;
    if (/^(\/\/|\/\*|\*|#|import\b)/.test(n)) return;
    if (!out.has(n)) out.set(n, i + 1);
  });
  return out;
}

/**
 * A contract instruction holds no line of the oracle's or the hidden tests' code that the
 * starting repo does not already have (≥ CONTRACT_COPY_LINES distinct lines block), and every
 * declaration is reported as a warning with what it covered.
 */
function checkContracts(c: Ctx): void {
  const { m } = c;
  m.spec.workloads.forEach((w, i) => {
    const t = contractTally(c, w);
    if (!t) return;
    const ipath = instructionPath(w);
    const instr = fileText(m, ipath);
    if (!instr) return;
    const given = new Set<string>();
    for (const f of m.files.filter((x) => under(x.path, inputPath(w))))
      for (const l of codeLines(f.text).keys()) given.add(l);
    const oracle = m.spec.proof.oracle;
    const oracleDir = oracle ? oracle.dir.replace(/\/+$/, "") : null;
    const perWorkload = oracleDir
      ? m.files.filter((f) => under(f.path, `${oracleDir}/${w.id}`))
      : [];
    const oracleFiles =
      perWorkload.length > 0 || !oracleDir
        ? perWorkload
        : m.files.filter((f) => under(f.path, oracleDir) && f.path !== oracle?.driver_patch);
    const testFiles = m.hidden.filter(
      (h) => (h.workload === w.id || h.workload === null) && !h.path.endsWith(".json"),
    );
    const instrLines = codeLines(instr);
    const copied = new Map<string, { at: number; from: string }>();
    let compared = { oracle: 0, tests: 0 };
    for (const [kind, files] of [
      ["oracle", oracleFiles],
      ["tests", testFiles],
    ] as const) {
      for (const f of files) {
        for (const [line, n] of codeLines(f.text)) {
          if (given.has(line)) continue;
          compared = { ...compared, [kind]: compared[kind] + 1 };
          const at = instrLines.get(line);
          if (at !== undefined && !copied.has(line))
            copied.set(line, { at, from: `${f.path}:${n}` });
        }
      }
    }
    const list = [...copied.entries()].sort((a, b) => a[1].at - b[1].at);
    const shown = list
      .slice(0, 3)
      .map(([l, x]) => `"${cut(l, 50)}" (${x.from})`)
      .join(", ");
    if (list.length >= CONTRACT_COPY_LINES) {
      add(c, {
        severity: "block",
        check: "solution_leakage",
        evidence: `${ipath}:${list[0]![1].at}`,
        why: `${ipath} is declared a contract (instruction_kind: contract) but carries ${list.length} line(s) of the oracle's or the hidden tests' code: ${shown}${list.length > 3 ? ", …" : ""}. A contract states the behaviour; it must not hand over the implementation or the tests`,
      });
      return;
    }
    add(c, {
      severity: "warn",
      check: "solution_leakage",
      evidence: yamlAt(c, ["workloads", i, "instruction_kind"]),
      why: `workload '${w.id}' declares its instruction a contract (instruction_kind: contract): ${t.names.size} hidden test name(s), ${t.messages.size} assertion message(s) and ${t.values.size} asserted value(s) appear in ${ipath} as the contract it is graded on (plan.md 17.2 rule 9) and are not counted as leakage. Checked instead: it copies ${list.length === 0 ? "no line" : `only ${list.length} line(s) (${shown})`} of the oracle's code (${compared.oracle} lines compared${oracleFiles.length === 0 ? "; no oracle for this workload yet" : ""}) or the hidden tests' code (${compared.tests} lines compared)`,
    });
  });
}

// ---------- noop_passable, weak_do_less ----------

/** `do-less '<id>' (<kind>): passed every gate on every workload` (proof/suite.ts evidence). */
const DO_LESS_PASSED_EVIDENCE =
  /^do-less '([^']+)' \((noop|partial-oracle|cheat)\): passed every gate/;

function checkDoLess(c: Ctx, proof: readonly ProofCheckResult[] | null | undefined): void {
  const { spec } = c.m;
  const doLess = spec.proof.do_less;
  if (doLess.length === 0) {
    add(c, {
      severity: "block",
      check: "weak_do_less",
      evidence: yamlAt(c, ["proof"]),
      why: "the kit has no do-less variant: nothing shows the gate refuses work that was skipped or done halfway",
    });
  } else if (doLess.every((o) => doLessKind(o) === "noop")) {
    add(c, {
      severity: "block",
      check: "weak_do_less",
      evidence: yamlAt(c, ["proof", "do_less", 0]),
      why: `the only do-less variant${doLess.length > 1 ? "s are no-ops" : ` '${doLess[0]!.id}' is a no-op`}, the weakest check: add partial oracles (the oracle with one contract clause removed each) so the gate is shown to reject near-misses`,
    });
  }

  for (const r of proof ?? []) {
    if (r.check !== "do_less_fails" || r.pass) continue;
    for (const e of r.evidence) {
      const m = DO_LESS_PASSED_EVIDENCE.exec(e);
      if (!m) continue;
      const i = doLess.findIndex((o) => o.id === m[1]);
      add(c, {
        severity: "block",
        check: "noop_passable",
        evidence: yamlAt(c, i >= 0 ? ["proof", "do_less", i] : ["proof"]),
        why:
          m[2] === "noop"
            ? `proof: the no-op '${m[1]}' passed every gate, so the hidden tests already pass on the untouched input`
            : `proof: do-less '${m[1]}' (${m[2]}) passed every gate, so the gate cannot tell it from real work`,
      });
    }
  }

  // A gate script with no way to write a failing verdict.
  for (const g of spec.gates) {
    const p = g.check ?? KIT_LAYOUT.gateCheck(g.id);
    const text = fileText(c.m, p);
    if (!text) continue;
    const code = text
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    const canFail =
      /false|fail|exit\s+[1-9]|\|\|/i.test(code) ||
      /\b(node|python3?|bash|sh|exec|diff|cmp|grep|test|jq|npm|npx|pnpm|cargo|go|pytest)\b|\[\s|\.\//.test(
        code,
      );
    if (!canFail) {
      add(c, {
        severity: "block",
        check: "noop_passable",
        evidence: `${p}:1`,
        why: `gate '${g.id}' (${p}) has no failing path: it can only write a passing verdict, so any contender, including a no-op, passes`,
      });
    }
  }
}

// ---------- one_sided_assist ----------

function uploadedInstructionFiles(m: SkepticKitMaterial, upload: readonly string[]): string[] {
  const out: string[] = [];
  for (const u of upload) {
    const p = u.replace(/\/+$/, "");
    if (INSTRUCTION_FILE.test(p)) out.push(p);
    else
      for (const f of m.files)
        if (under(f.path, p) && INSTRUCTION_FILE.test(f.path)) out.push(f.path);
  }
  return out;
}

function checkAssists(c: Ctx): void {
  const { m } = c;
  const agents = m.spec.contenders
    .map((x, i) => ({ c: x, i }))
    .filter(({ c: x }) => isAgentDriver(x.driver));
  const byType = new Map<
    string,
    { c: (typeof agents)[number]["c"]; i: number; help: string[] }[]
  >();
  for (const a of agents) {
    const upload = "upload" in a.c.source ? a.c.source.upload : [];
    const help = uploadedInstructionFiles(m, upload);
    const list = byType.get(a.c.driver.type) ?? [];
    list.push({ ...a, help });
    byType.set(a.c.driver.type, list);
  }
  for (const [type, list] of byType) {
    if (list.length < 2) continue;
    const withHelp = list.filter((x) => x.help.length > 0);
    const without = list.filter((x) => x.help.length === 0);
    if (withHelp.length === 0 || without.length === 0) continue;
    const giver = withHelp[0]!;
    add(c, {
      severity: "block",
      check: "one_sided_assist",
      evidence: yamlAt(c, ["contenders", giver.i, "source"]),
      why: `${type} contender '${giver.c.id}' gets ${giver.help.join(", ")} but ${without.map((x) => `'${x.c.id}'`).join(", ")} get${without.length === 1 ? "s" : ""} no instruction file: give every ${type} contender the same kind of help, or none`,
    });
  }

  // Adapter help (CLAUDE.md, prompts) that carries task-specific hints.
  const workloadIds = m.spec.workloads.map((w) => w.id);
  const names = testNames(m.facts).filter((n) => normText(n.value).length >= 16);
  const basenames = [
    ...new Set(
      m.hidden.filter((h) => !h.path.endsWith(".json")).map((h) => path.posix.basename(h.path)),
    ),
  ];
  const literals = m.facts.filter((f) => f.kind !== "name" && isTellingLiteral(f.value, 10));
  for (const f of m.files) {
    if (!under(f.path, KIT_LAYOUT.adaptersDir) || f.text === "") continue;
    if (!/\.(md|txt|markdown)$/i.test(f.path) && !INSTRUCTION_FILE.test(f.path)) continue;
    const lower = f.text.toLowerCase();
    const wl = workloadIds.find((id) =>
      new RegExp(`(^|[^\\w-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w-]|$)`, "i").test(
        f.text,
      ),
    );
    const nm = names.find((n) => lower.includes(normText(n.value)));
    const bn = basenames.find((b) => f.text.includes(b));
    const lit = literals.find((l) => f.text.includes(l.value));
    const hit = nm
      ? [`the hidden test "${cut(nm.value)}"`, nm.value]
      : bn
        ? [`the hidden test file ${bn}`, bn]
        : lit
          ? [`the asserted value "${cut(lit.value, 40)}" (${lit.path}:${lit.line})`, lit.value]
          : wl
            ? [`the workload '${wl}'`, wl]
            : null;
    if (!hit) continue;
    add(c, {
      severity: "block",
      check: "one_sided_assist",
      evidence: `${f.path}:${lineOfText(f.text, hit[1]!)}`,
      why: `contender help ${f.path} names ${hit[0]}: a contender's setup must be task-agnostic, or it is a hint only that contender gets`,
    });
  }
}

// ---------- one_sided_weight ----------

function collectorsOf(spec: KitSpec, i: number): Set<CollectorName> {
  const d = spec.contenders[i]!.driver;
  return new Set(spec.collectors ?? DRIVER_DEFAULT_COLLECTORS[d.type]);
}

function checkWeights(c: Ctx): void {
  const { spec } = c.m;
  spec.requirements.forEach((r, i) => {
    const weight = spec.scoring.weights[r.id] ?? 0;
    const at = yamlAt(c, ["scoring", "weights", r.id]);
    if (r.type === "reviewed") {
      if (weight > 0) {
        add(c, {
          severity: "warn",
          check: "one_sided_weight",
          evidence: at,
          why: `reviewed requirement '${r.id}' (LLM-judged) carries weight ${weight} before a judge panel is audited (17.2 rule 8): the report must also show the verdict at reviewed weight 0`,
        });
      }
      return;
    }
    if (VANITY_METRIC.test(r.metric)) {
      add(c, {
        severity: weight > 0 ? "block" : "warn",
        check: "one_sided_weight",
        evidence: weight > 0 ? at : yamlAt(c, ["requirements", i, "metric"]),
        why: `requirement '${r.id}' measures ${r.metric}, a vanity metric that is never a headline (plan.md 17.4)${weight > 0 ? `, yet it carries weight ${weight}` : ""}`,
      });
    }
    const collector = METRIC_COLLECTOR.find(([re]) => re.test(r.metric))?.[1];
    if (collector && weight > 0) {
      const lacking = spec.contenders
        .filter((_, j) => !collectorsOf(spec, j).has(collector))
        .map((x) => x.id);
      if (lacking.length > 0 && lacking.length < spec.contenders.length) {
        add(c, {
          severity: "block",
          check: "one_sided_weight",
          evidence: at,
          why: `requirement '${r.id}' (${r.metric}, weight ${weight}) comes from the ${collector} collector, which ${lacking.map((x) => `'${x}'`).join(", ")} ${lacking.length === 1 ? "does" : "do"} not have: weight on a metric only some contenders are measured on decides the ranking by itself`,
        });
      }
    }
  });
}

// ---------- ungated_measure ----------

function checkGates(c: Ctx): void {
  const { spec } = c.m;
  const gateIds = new Set(spec.gates.map((g) => g.id));
  spec.requirements.forEach((r, i) => {
    if (r.type === "measured" && (!r.gate_id || !gateIds.has(r.gate_id))) {
      add(c, {
        severity: "block",
        check: "ungated_measure",
        evidence: yamlAt(c, ["requirements", i]),
        why: `measured requirement '${r.id}' has no correctness gate${r.gate_id ? ` ('${r.gate_id}' is not defined)` : ""}: no speed or quality number without one`,
      });
    }
    if (r.type === "reviewed" && !r.gate_id && (spec.scoring.weights[r.id] ?? 0) > 0) {
      add(c, {
        severity: "warn",
        check: "ungated_measure",
        evidence: yamlAt(c, ["requirements", i]),
        why: `reviewed requirement '${r.id}' has weight but no gate: quality would be reviewed on work that fails its tests`,
      });
    }
  });
}

// ---------- contamination ----------

interface MinedRecord {
  id: string;
  date: string;
  where: string;
}

async function minedRecords(c: Ctx): Promise<MinedRecord[]> {
  const out: MinedRecord[] = [];
  for (const f of c.m.files) {
    if (!/^mined\/[^/]+\.json$/.test(f.path) || f.text === "") continue;
    try {
      const v = JSON.parse(f.text) as Record<string, unknown>;
      const commit = (v.commit ?? v.candidate ?? v) as Record<string, unknown>;
      const date = [v.commit_date, commit.commit_date, v.author_date, commit.author_date].find(
        (x): x is string => typeof x === "string",
      );
      if (date)
        out.push({
          id: String(v.id ?? path.posix.basename(f.path, ".json")),
          date,
          where: `${f.path}:${lineOfText(f.text, "commit_date")}`,
        });
    } catch {
      // not a mined record
    }
  }
  c.m.spec.workloads.forEach((w, i) => {
    const d = w.params?.commit_date ?? w.params?.mined_commit_date;
    if (typeof d === "string" && !out.some((r) => r.id === w.id)) {
      out.push({ id: w.id, date: d, where: yamlAt(c, ["workloads", i, "params"]) });
    }
  });
  return out;
}

/** Every model a contender runs: driver.model and env values of *MODEL* keys. */
export function contenderModels(spec: KitSpec): string[] {
  const out = new Set<string>();
  for (const x of spec.contenders) {
    const d = x.driver;
    if (isAgentDriver(d) && d.model) out.add(d.model);
    for (const [k, v] of Object.entries(d.env ?? {}))
      if (/MODEL/.test(k) && /[a-z]/i.test(v)) out.add(v);
  }
  return [...out];
}

async function checkContamination(
  c: Ctx,
  cutoffs: Readonly<Record<string, string>>,
): Promise<void> {
  const { spec } = c.m;
  const oracle = spec.proof.oracle;
  const subject = spec.contenders.find((x) => x.role === "subject");
  const deterministic = spec.contenders.every((x) => !isAgentDriver(x.driver));
  if (oracle && subject && deterministic) {
    const oracleContender = oracle.contender ?? subject.id;
    if (oracleContender === subject.id && !oracle.driver_patch) {
      const captured = spec.gates.filter((g) => g.capture?.from === "oracle");
      // The kit-builder plan (v1 cli): the reference is the subject's pinned release, cross-checked
      // by an independent implementation that must agree through the same gate (smoke_passes).
      const crossCheck = spec.contenders.filter((x) => x.id !== subject.id).map((x) => `'${x.id}'`);
      const ids = captured.map((g) => `'${g.id}'`).join(", ");
      add(c, {
        severity: captured.length > 0 && crossCheck.length === 0 ? "block" : "warn",
        check: "contamination",
        evidence: yamlAt(c, ["proof", "oracle", "contender"]),
        why:
          captured.length === 0
            ? `the oracle is the subject '${subject.id}' run unchanged: say which independent check backs the reference`
            : crossCheck.length === 0
              ? `the oracle is the subject '${subject.id}' itself, gate(s) ${ids} capture their reference from it and no other implementation is checked against it: the gate only measures agreement with the subject. Add an independent baseline that must agree through the same gate`
              : `gate(s) ${ids} capture their reference from the subject '${subject.id}'; its independence rests on ${crossCheck.join(", ")} agreeing through the same gate (proof smoke_passes). Report the reference as the subject's output, cross-checked`,
      });
    }
  }

  const mined = await minedRecords(c);
  const models = contenderModels(spec).filter((x) => !/^\$/.test(x));
  if (mined.length === 0 || models.length === 0) return;
  for (const t of mined) {
    const day = t.date.slice(0, 10);
    const before = models.filter((x) => cutoffs[x] !== undefined && day <= cutoffs[x]!);
    const unknown = models.filter((x) => cutoffs[x] === undefined);
    if (before.length > 0) {
      add(c, {
        severity: "block",
        check: "contamination",
        evidence: t.where,
        why: `mined task '${t.id}' is dated ${day}, on or before the training cutoff of ${before.map((x) => `${x} (${cutoffs[x]})`).join(", ")}: the fix may be in the model's training data. Mine commits after the cutoff`,
      });
    } else if (unknown.length > 0) {
      add(c, {
        severity: "warn",
        check: "contamination",
        evidence: t.where,
        why: `mined task '${t.id}' is dated ${day} and the training cutoff of ${unknown.join(", ")} is not known: contamination cannot be ruled out, and the fix is in public history`,
      });
    }
  }
}

// ---------- too_few_tasks ----------

function checkTaskCount(c: Ctx): void {
  const { spec } = c.m;
  const agent = spec.contenders.some((x) => isAgentDriver(x.driver));
  const n = spec.workloads.length;
  if (agent) {
    if (n < MIN_TASKS_FOR_BEATS) {
      add(c, {
        severity: "warn",
        check: "too_few_tasks",
        evidence: yamlAt(c, ["workloads"]),
        why: `${n} task(s): an agent "beats" claim needs at least ${MIN_TASKS_FOR_BEATS} stratified tasks (17.2 rule 3), so every claim must read "on these ${n} tasks"`,
      });
      const texts: [string, string][] = [
        [KIT_LAYOUT.manifest, [spec.subject.summary, ...spec.subject.better_means].join("\n")],
      ];
      const readme = fileText(c.m, "README.md");
      if (readme) texts.push(["README.md", readme]);
      for (const [p, t] of texts) {
        const claim = BEATS_CLAIM.exec(t);
        if (!claim || ON_THESE_N.test(t)) continue;
        const file = p === KIT_LAYOUT.manifest ? (fileText(c.m, p) ?? t) : t;
        add(c, {
          severity: "block",
          check: "too_few_tasks",
          evidence: `${p}:${lineOfText(file, claim[0])}`,
          why: `${p} claims "${claim[0]}" on ${n} task(s) without saying "on these ${n} tasks" (17.2 rules 3 and 10)`,
        });
      }
    }
    if (spec.repeats < AGENT_REPEATS_FLOOR) {
      add(c, {
        severity: "block",
        check: "too_few_tasks",
        evidence: yamlAt(c, ["repeats"]),
        why: `repeats ${spec.repeats} is below the agent floor of ${AGENT_REPEATS_FLOOR} per cell (17.2 rule 3)`,
      });
    } else if (spec.repeats < AGENT_REPEATS_DEFAULT) {
      add(c, {
        severity: "warn",
        check: "too_few_tasks",
        evidence: yamlAt(c, ["repeats"]),
        why: `repeats ${spec.repeats} is below the agent default of ${AGENT_REPEATS_DEFAULT} per cell (17.2 rule 3): show the power estimate that justifies it`,
      });
    }
  } else if (spec.repeats < SOFTWARE_REPEATS_DEFAULT) {
    add(c, {
      severity: "warn",
      check: "too_few_tasks",
      evidence: yamlAt(c, ["repeats"]),
      why: `repeats ${spec.repeats} is below the software default of ${SOFTWARE_REPEATS_DEFAULT} (17.2 rule 3)`,
    });
  }
}

// ---------- validator issues ----------

function issueEvidence(i: KitIssue): string {
  const file = path.isAbsolute(i.file)
    ? KIT_LAYOUT.manifest
    : i.file.replace(/\/+$/, "") || KIT_LAYOUT.manifest;
  return `${file}:${i.line ?? 1}`;
}

function addValidatorIssues(
  c: Ctx,
  errors: readonly KitIssue[],
  warnings: readonly KitIssue[],
): void {
  for (const i of errors) {
    add(c, {
      severity: "block",
      check: COMPARABILITY_CODES.has(i.code) ? "comparability" : "kit_invalid",
      evidence: issueEvidence(i),
      why: `${i.path ? `${i.path}: ` : ""}${i.message}`,
    });
  }
  for (const i of warnings) {
    if (!COMPARABILITY_CODES.has(i.code)) continue;
    add(c, {
      severity: "warn",
      check: "comparability",
      evidence: issueEvidence(i),
      why: `${i.path ? `${i.path}: ` : ""}${i.message}`,
    });
  }
}

// ---------------------------------------------------------------------------------------------

/** Read the kit and its hidden tests (the material the checks and the Naïve skeptic share). */
export async function loadSkepticMaterial(dir: string, spec: KitSpec): Promise<SkepticKitMaterial> {
  const abs = path.resolve(dir);
  const files = await readKitFiles(abs);
  const hidden = hiddenTestFiles(spec, files);
  const facts = hidden.flatMap((h) => extractTestFacts(h));
  return { dir: abs, spec, files, hidden, facts };
}

/** Every deterministic skeptic check on the kit in `kitDir`. Never throws for a bad kit. */
export async function runSkepticChecks(
  kitDir: string,
  opts: SkepticChecksOptions = {},
): Promise<SkepticChecksResult> {
  const v = await validateKitDir(kitDir);
  let spec = v.kit?.spec;
  let source: Ctx["source"] = null;
  try {
    const parsed = parseKitManifest(await readFile(path.join(v.dir, KIT_LAYOUT.manifest), "utf8"));
    source = parsed.source;
    spec ??= parsed.spec;
  } catch {
    // no manifest: the validator's issue says so
  }
  const out: SkepticFinding[] = [];
  const c0: Ctx = { m: null as never, source, out, ids: new Map(), contract: new Map() };
  addValidatorIssues(c0, v.errors, v.warnings);
  if (!spec) return { findings: out, material: null };

  const m = await loadSkepticMaterial(v.dir, spec);
  const c: Ctx = { ...c0, m };
  checkLeakage(c);
  lintFindings(c, await noLeakIssues(v.dir, spec));
  checkAnswers(c);
  checkContracts(c);
  checkDoLess(c, opts.proof);
  checkAssists(c);
  checkWeights(c);
  checkGates(c);
  await checkContamination(c, opts.modelCutoffs ?? {});
  checkTaskCount(c);
  return { findings: out, material: m };
}
