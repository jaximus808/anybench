// Plan 17.2 rule 10: never assert results we haven't measured.
//
// The one honest-wording filter for outreach text. The scout (TDM-164) runs it on every free-text
// field of a brief; the writer (TDM-165) runs it on every email draft before a human sees it.
//
//   findRule10Violations(text)  every sentence that asserts an unmeasured result, with the words
//                               that assert it and the rule that caught them
//   violatesRule10(text)        true when there is at least one
//   unmeasuredAssertions(text)  just the offending sentences (what verifyScoutOutput reports)
//
// How it decides. Text is split into sentences, each sentence into clauses (`;`, "but",
// "however", "although", ", and", a spaced dash...). A sentence violates rule 10 when it holds an
// ASSERTION (a comparative or superlative about a product, a win/loss verb, "doesn't hold up",
// "fails ... tests", "the numbers are wrong", "we measured...") that is not GOVERNED by a hedge.
// A hedge governs only when it comes BEFORE the assertion in the same clause:
//
//   plan    "we'd measure whether X is faster", "to check if it is cheaper", "to see which is
//           faster". Bare test/check/measure/verify/confirm/will/may are NOT hedges: "we will
//           verify it, and X is slower" still asserts.
//   report  attribution to THEM: "your README claims 3x faster", "according to the README, Auto
//           used 57% less time". First person ("we claim") is not attribution.
//
// Judgments about their numbers ("your numbers are inflated", "the claim is false") and our own
// results ("we measured a 30% gap") are excused only by a plan hedge, never by attribution.
//
// The filter is deliberately conservative: a false positive costs a reworded sentence, a false
// negative costs an email that claims something we never measured.

export const RULE10_RULES = [
  "comparative",
  "comparative_than",
  "quantified_comparative",
  "superlative",
  "win_loss_verb",
  "doesnt_hold_up",
  "fails_tests",
  "bad_numbers",
  "first_person_result",
] as const;
export type Rule10Rule = (typeof RULE10_RULES)[number];

export interface Rule10Violation {
  /** The sentence as written (trimmed). */
  sentence: string;
  /** The words that assert the result. */
  match: string;
  rule: Rule10Rule;
}

// ---- vocabulary --------------------------------------------------------------------------------

/** Intensifiers and quantities between a copula and the comparative: "is MUCH faster", "is 2x slower". */
const ADV =
  String.raw`(?:(?:much|far|way|any|significantly|substantially|clearly|noticeably|considerably|dramatically|measurably|consistently|slightly|actually|really|indeed|in fact|about|roughly|nearly|almost|over|up to|at least|still|even|a lot|a bit|~?\d+(?:\.\d+)?\s?(?:x|%|times|percent))\s+)*`;

const MORE_LESS_ADJ = String.raw`(?:accurate|efficient|reliable|expensive|performant|capable|robust|stable|correct|scalable|token-efficient|cost-effective|productive|consistent)`;

/** Comparative degree. */
const COMP = String.raw`(?:faster|slower|quicker|cheaper|costlier|pricier|better(?!\s+to\s)|worse|leaner|smaller|bigger|larger|lighter|heavier|stronger|weaker|safer|smarter|fewer|(?:more|less)\s+${MORE_LESS_ADJ})`;

/** Positive-degree judgments, only after a copula: "X is slow", "it's unreliable". */
const JUDGMENT = String.raw`(?:slow|fast|cheap|expensive|costly|accurate|inaccurate|reliable|unreliable|efficient|inefficient|wasteful|bloated|buggy|flaky|broken)`;

/** Superlative degree. "best practices", "best effort", "at best", "our best guess" are not claims. */
const SUPER = String.raw`(?:fastest|slowest|quickest|cheapest|costliest|leanest|(?<!\b(?:at|our|their|your|my|its)\s)(?:best|worst)(?![- ](?:practices?|effort|guess|case|of (?:our|my) knowledge|regards|wishes)|,|\s*$)|(?:most|least)\s+${MORE_LESS_ADJ}|state[- ]of[- ]the[- ]art|sota)`;

/** Verbs that link a subject to a comparative, contractions included. */
const COPULA = String.raw`(?:'s|'re|\b(?:is|are|was|were|be|been|being|isn't|aren't|wasn't|weren't|runs?|ran|performs?|performed|looks?|seems?|appears?|feels?|proved?|proves|proven|turned out|turns out|comes? out|came out|gets?|got|stays?|remains?|scales?|scaled))`;

const NEGATED = String.raw`(?:doesn't|does not|don't|do not|didn't|did not|won't|will not|wouldn't|would not|can't|cannot|can not|couldn't|fails? to|failed to)`;

// ---- assertions --------------------------------------------------------------------------------

type Excuse = "plan" | "report" | "generic";

interface AssertionPattern {
  rule: Rule10Rule;
  re: RegExp;
  /** Which hedge kinds can excuse it when they precede it in its clause. */
  excusedBy: readonly Excuse[];
}

const rx = (src: string): RegExp => new RegExp(src, "gi");

const ASSERTIONS: readonly AssertionPattern[] = [
  {
    rule: "comparative",
    re: rx(
      String.raw`${COPULA}\s+(?:not\s+|to be\s+|not to be\s+)?${ADV}(?:the\s+)?(?:${COMP}|${SUPER}|${JUDGMENT})\b`,
    ),
    excusedBy: ["plan", "report"],
  },
  {
    rule: "comparative_than",
    re: rx(String.raw`\b(?:${COMP}|${JUDGMENT})\s+than\b|\bas\s+(?:fast|cheap|accurate|good|efficient|reliable)\s+as\b`),
    excusedBy: ["plan", "report"],
  },
  {
    rule: "quantified_comparative",
    re: rx(
      String.raw`(?:~?\b\d+(?:\.\d+)?\s?(?:x|%|times|percent)|\b(?:twice|half|double|triple))\s+(?:as\s+)?(?:${COMP}|fast|cheap|slow|speedup|slowdown|reduction|improvement|increase|decrease|savings?|less|more)\b`,
    ),
    excusedBy: ["plan", "report"],
  },
  {
    rule: "superlative",
    re: rx(String.raw`\b${SUPER}\b`),
    excusedBy: ["plan", "report"],
  },
  {
    rule: "win_loss_verb",
    re: rx(
      String.raw`\b(?:beats?|beating|beaten|outperforms?|outperformed|outperforming|outpaces?|outpaced|outruns?|surpass(?:es|ed)?|underperforms?|underperformed|loses to|lost to|losing to|wins against|won against|dominates|dominated|crushes|crushed|trounces|lags?\s+(?:far\s+|well\s+|way\s+)?behind|lagged\s+behind|lagging\s+behind|trails|trailed|falls?\s+behind|fell\s+behind|falls?\s+short|fell\s+short|wastes?|wasted|wasting|burns?\s+through|blows?\s+away|edges?\s+out|leapfrogs?)\b`,
    ),
    excusedBy: ["plan", "report"],
  },
  {
    rule: "doesnt_hold_up",
    re: rx(
      String.raw`\b${NEGATED}\s+(?:really\s+|actually\s+|even\s+)?(?:hold up|stand up|add up|replicate|reproduce|scale|keep up|live up|deliver|beat|outperform|match up|compete)\b`,
    ),
    excusedBy: ["plan"],
  },
  {
    rule: "fails_tests",
    re: rx(
      String.raw`\b(?:fails|failed|failing|breaks|broke)\s+(?:[\w'-]+\s+){0,4}?(?:tests?|checks?|cases?|tasks?|benchmarks?|suites?)\b`,
    ),
    excusedBy: ["plan", "generic"],
  },
  {
    rule: "bad_numbers",
    re: rx(
      String.raw`\b(?:numbers?|results?|benchmarks?|claims?|figures?|scores?|metrics?|stats|statistics|data|charts?|tables?|measurements?|speedups?)\s+(?:(?:is|are|was|were|seem|seems|look|looks|appear|appears)\s+|'re\s+)(?:all\s+)?(?:not\s+)?${ADV}(?:wrong|inflated|misleading|exaggerated|overstated|overblown|cherry[- ]picked|false|bogus|untrue|unsupported|incorrect|inaccurate|invalid|fake|rigged|fabricated|made up|true|correct|accurate|valid|verified|confirmed|legit(?:imate)?|reproducible|irreproducible|unreproducible)\b|\b(?:is|are|was|were)\s+(?:simply\s+|clearly\s+|just\s+|plainly\s+)?(?:false|wrong|inflated|misleading|exaggerated|overstated|bogus|untrue|cherry[- ]picked|fabricated)\b`,
    ),
    excusedBy: ["plan"],
  },
  {
    rule: "first_person_result",
    re: rx(
      String.raw`\b(?:we|we've|i|our\s+(?:tests?|runs?|benchmarks?|results?|measurements?|analysis|numbers|data|trials?|experiments?))\s+(?:have\s+|had\s+|already\s+|just\s+)?(?:measured|show|shows|showed|shown|observed|confirmed|proved?|proven|verified|benchmarked|tested|reproduced|demonstrated|clocked|recorded|found\s+(?:that|it\s+to|(?:a\s+|an\s+)?\d|(?:a|an)\s+(?:gap|regression|bug|difference|slowdown|speedup|improvement|drop)))\b(?!\s+(?:nothing|anything|none|no)\b)`,
    ),
    excusedBy: ["plan"],
  },
];

// ---- hedges ------------------------------------------------------------------------------------

/** A plan: whether/if, or a plan verb with a future or infinitive marker ("we'd measure", "to see"). */
const PLAN_HEDGE = new RegExp(
  String.raw`\bwhether\b|\b(?:we'd|we would|we'll|we will|we could|we can|we want to|we plan to|we'd like to|let's|to|would|could)\s+(?:also\s+|then\s+|first\s+|independently\s+)?(?:measure|test|check|verify|confirm|see|find out|compare|benchmark|determine|assess|evaluate|establish)\b|\b(?:unverified|untested|unmeasured|not yet (?:measured|verified|tested)|unclear|open question|hypothes[ie]s)\b`,
  "i",
);
/** "if" governs only up to the next comma: "If you care about cost, X is cheaper" still asserts. */
const IF_HEDGE = /\bif\b(?![^,]*,)/i;

/** Attribution to them. A first-person subject ("we claim") is not attribution. */
const REPORT_HEDGE = new RegExp(
  String.raw`(?<!\b(?:we|i)\s)\b(?:claims?|claimed|claiming|says?|said|saying|states?|stated|reports?|reported|reporting|advertis\w*|promis\w*|according to|cites?|cited|quotes?|quoted|describes?|described|calls?\s+(?:it|itself)|bills?\s+itself|positions?\s+itself|markets?\s+itself|touts?|touted|boasts?|headlines?|lists?|listed|shows?|showed|self-reported)\b`,
  "i",
);

/** A generic or conditional subject: "a run that fails its hidden tests counts as unsolved". */
const GENERIC_HEDGE =
  /\b(?:if|when|whenever|unless|until|any|each|every|whichever|that|a (?:run|task|trial|case|change|patch|solution|submission))\b/i;

/** Where a clause starts inside a sentence. */
const CLAUSE_BREAK =
  /\b(?:but|however|whereas|although|though|while|instead)\b|(?<!\bnot\s)\byet\b|\s[-–—]\s|—|[()]|,\s*(?:and|so|which)\b/gi;

function clauseBefore(sentence: string, at: number): string {
  let start = 0;
  for (const m of sentence.slice(0, at).matchAll(CLAUSE_BREAK)) {
    start = (m.index ?? 0) + m[0].length;
  }
  return sentence.slice(start, at);
}

function governed(prefix: string, excusedBy: readonly Excuse[]): boolean {
  for (const e of excusedBy) {
    if (e === "plan" && (PLAN_HEDGE.test(prefix) || IF_HEDGE.test(prefix))) return true;
    if (e === "report" && REPORT_HEDGE.test(prefix)) return true;
    if (e === "generic" && GENERIC_HEDGE.test(prefix)) return true;
  }
  return false;
}

/** Typographic apostrophes and quotes unified, whitespace collapsed (indices stay on this form). */
function normalize(s: string): string {
  return s
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐‑‒–]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** Sentences of `text`: split at `.`/`!`/`?`/`;` followed by space, and at line breaks. */
export function rule10Sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Every sentence of `text` that asserts a result we have not measured (plan 17.2 rule 10), at most
 * one violation per sentence (the first unexcused assertion). Empty when the text is honest.
 */
export function findRule10Violations(text: string): Rule10Violation[] {
  const out: Rule10Violation[] = [];
  for (const sentence of rule10Sentences(text)) {
    const s = normalize(sentence);
    let hit: { at: number; v: Rule10Violation } | null = null;
    for (const a of ASSERTIONS) {
      for (const m of s.matchAll(a.re)) {
        const at = m.index ?? 0;
        if (governed(clauseBefore(s, at), a.excusedBy)) continue;
        if (!hit || at < hit.at) hit = { at, v: { sentence, match: m[0].trim(), rule: a.rule } };
        break;
      }
    }
    if (hit) out.push(hit.v);
  }
  return out;
}

/** True when `text` asserts at least one unmeasured result. */
export function violatesRule10(text: string): boolean {
  return findRule10Violations(text).length > 0;
}

/** The sentences of `text` that assert an unmeasured result. Empty when the text is honest. */
export function unmeasuredAssertions(text: string): string[] {
  return findRule10Violations(text).map((v) => v.sentence);
}
