// TDM-164 [15.3a]: the plan 17.2 rule-10 wording filter (shared with the writer, TDM-165) and the
// quote check's context rules (negation, elision, strikethrough).

import { describe, expect, it } from "vitest";
import {
  checkQuote,
  findRule10Violations,
  RULE10_RULES,
  ScoutMaterial,
  unmeasuredAssertions,
  violatesRule10,
  type Rule10Rule,
} from "../src/index.js";

// ---- rule 10 ----------------------------------------------------------------------------------

/** Sentences that assert a result we never measured, and the rule that must catch each. */
const MUST_CATCH: ReadonlyArray<[string, Rule10Rule]> = [
  // comparatives / superlatives / judgments after a copula
  ["Zippy is 2x slower than pi.", "comparative"],
  ["Zippy is significantly cheaper.", "comparative"],
  ["Zippy is more accurate than pi on SWE-bench.", "comparative"],
  ["It's faster on big repos.", "comparative"],
  ["Zippy isn't faster than plain Claude Code.", "comparative"],
  ["The harness wasn't any better.", "comparative"],
  ["Zippy will be faster than Claude Code.", "comparative"],
  ["Zippy may be cheaper per solved task.", "comparative"],
  ["Zippy is the fastest harness for Claude Code.", "comparative"],
  ["Their agent is unreliable under load.", "comparative"],
  ["Zippy runs 40% cheaper than pi.", "comparative"],
  // comparatives without a copula
  ["A harness faster than pi, with fewer tokens.", "comparative_than"],
  ["Zippy uses 46% fewer tokens.", "quantified_comparative"],
  ["Expect a 3x speedup over plain Claude Code.", "quantified_comparative"],
  ["The fastest coding agent on the market.", "superlative"],
  ["State-of-the-art results on SWE-bench Verified.", "superlative"],
  // win / loss verbs
  ["It beats Claude Code on every task.", "win_loss_verb"],
  ["Distill outperforms the native GPT-6 baselines.", "win_loss_verb"],
  ["Zippy lags behind aider on SWE-bench.", "win_loss_verb"],
  ["Their harness wastes tokens on retries.", "win_loss_verb"],
  ["It falls short of the README numbers.", "win_loss_verb"],
  // doesn't hold up / fails tests
  ["The 2x claim doesn't hold up on large repos.", "doesnt_hold_up"],
  ["It can't keep up with aider.", "doesnt_hold_up"],
  ["Zippy won't scale past 10 workers.", "doesnt_hold_up"],
  ["The benchmark does not add up.", "doesnt_hold_up"],
  ["Zippy fails half of the hidden tests.", "fails_tests"],
  ["The patch broke three passing tests.", "fails_tests"],
  // judgments about their numbers
  ["Your benchmark numbers are inflated.", "bad_numbers"],
  ["Your numbers are wrong.", "bad_numbers"],
  ["Their claim is inflated.", "bad_numbers"],
  ["Their results are cherry-picked.", "bad_numbers"],
  ["The claim is false, according to the README numbers.", "bad_numbers"],
  // our own results
  ["We measured a 30% gap.", "first_person_result"],
  ["Our tests showed regressions.", "first_person_result"],
  ["We found that zippy regresses on edits.", "first_person_result"],
  ["Our benchmarks show it is 2x faster.", "first_person_result"],
  // hedges that do NOT govern: after the claim, in another clause, bare plan words, a comma'd "if"
  ["Zippy is slower than pi, which we'd verify.", "comparative"],
  ["We will verify it, and zippy is slower.", "comparative"],
  ["We'd test it later; zippy is slower.", "comparative"],
  ["We'd check the README, but zippy is slower.", "comparative"],
  ["If you care about cost, zippy is cheaper.", "comparative"],
  ["Zippy is 2x faster than pi, the README says.", "comparative"],
  ["We claim zippy is 2x faster.", "comparative"],
  ["Check it: zippy is slower.", "comparative"],
  ["We test, measure and verify: zippy is slower.", "comparative"],
];

/** Plans, attributed reports of THEIR claims, and neutral text: never flagged. */
const MUST_ALLOW: readonly string[] = [
  "We'd measure whether zippy is faster than pi.",
  "We'd check whether zippy is faster than plain Claude Code.",
  "We'd check whether the claim is true on hidden tests.",
  "We'd verify whether the numbers are accurate.",
  "To test if it is cheaper per solved task.",
  "We'd like to benchmark zippy against pi to see which is faster.",
  "Your README claims 3x faster than Claude Code.",
  "The README says it beats pi on 20 tasks.",
  "The README says UltraSave cost 0.069x the credits of Normal.",
  "According to the README, Auto used 57% less total time.",
  "The README advertises 46% fewer tokens than pi.",
  "Their README reports 97.9% on tsbench at -80% tokens.",
  "Zippy describes itself as the fastest harness for Claude Code.",
  "Zippy claims 2x speed and 46% fewer tokens.",
  "The README states that Auto is 57% faster, and we'd check whether that holds.",
  "We have measured nothing yet.",
  "We have not measured anything yet.",
  "We found zippy through a search for coding-agent harnesses.",
  "Results depend on the pinned model version.",
  "A task counts as solved only if its hidden tests pass.",
  "A run that fails its hidden tests counts as unsolved.",
  "Hidden SWE-bench Verified tests, run out of process, decide pass/fail before any time or cost counts.",
  "Best practices for gated benchmarks apply.",
  "It's better to measure cost per solved task than raw tokens.",
  "Best,",
  "We'd measure cost per solved task and time-to-solve with failures counted at the cap.",
];

describe("rule 10 filter (plan 17.2): table-driven", () => {
  it.each(MUST_CATCH)("catches %j (%s)", (sentence, rule) => {
    const v = findRule10Violations(sentence);
    expect(v, sentence).toHaveLength(1);
    expect(v[0]!.rule).toBe(rule);
    // A `;` starts a new sentence, so the reported sentence may be the tail.
    expect(sentence).toContain(v[0]!.sentence);
    expect(v[0]!.match.length).toBeGreaterThan(0);
    expect(violatesRule10(sentence)).toBe(true);
  });

  it.each(MUST_ALLOW.map((s) => [s]))("allows %j", (sentence) => {
    expect(findRule10Violations(sentence), sentence).toEqual([]);
    expect(violatesRule10(sentence)).toBe(false);
  });

  it("every rule is exercised by the must-catch table", () => {
    const used = new Set(MUST_CATCH.map(([, r]) => r));
    for (const r of RULE10_RULES) expect(used, r).toContain(r);
  });

  it("checks each sentence of a multi-sentence draft and reports only the bad ones", () => {
    const draft = [
      "Hi Ada,",
      "Your README claims 3x faster than Claude Code. We'd measure whether that holds with a hidden-test gate.",
      "Honestly, zippy is slower on big repos.",
      "Best,",
      "Jaxon",
    ].join("\n");
    expect(unmeasuredAssertions(draft)).toEqual(["Honestly, zippy is slower on big repos."]);
  });

  it("treats typographic apostrophes like ASCII ones", () => {
    expect(violatesRule10("Zippy isn’t faster than pi.")).toBe(true);
    expect(violatesRule10("We’d measure whether zippy is faster than pi.")).toBe(false);
  });
});

// ---- quote check context ------------------------------------------------------------------------

const CONTEXT_README = [
  "# zippy",
  "Zippy is ~~10x faster~~ 2x faster than pi on our suite",
  "Cost: <del>3x cheaper per solved task</del> (old numbers)",
  "Zippy is not 10x faster than plain Claude Code",
  "We never claimed it was 5x cheaper per task",
  "Zippy is 4x faster on big repos (since retracted)",
  "Fixtures are not published yet, but zippy is 3x faster on our suite",
  "Zippy solves 33 of 50 tasks without a cache warm-up",
].join("\n");

const ctxMaterial = () =>
  new ScoutMaterial(
    [{ path: "README.md", text: CONTEXT_README }],
    "https://github.com/acme/zippy",
    "0".repeat(40),
  );

describe("checkQuote: strikethrough, elision and negation", () => {
  const mat = ctxMaterial();

  it("deletes struck-through text: a retracted number is never a quote", () => {
    expect(checkQuote(mat, "10x faster than pi on our suite", "README.md#L2")).toEqual({
      ok: false,
      reason: "quote_not_found",
    });
    expect(checkQuote(mat, "Zippy is 2x faster than pi on our suite", "README.md#L2")).toMatchObject(
      { ok: true, line: 2, relocated: false },
    );
    expect(checkQuote(mat, "3x cheaper per solved task", "README.md#L3")).toEqual({
      ok: false,
      reason: "quote_not_found",
    });
  });

  it("refuses an ellipsis inside the quote (it could splice out a 'not'); allows one at either end", () => {
    expect(checkQuote(mat, "Zippy is ... 10x faster than plain Claude Code", "README.md#L4")).toEqual(
      { ok: false, reason: "quote_elided" },
    );
    expect(checkQuote(mat, "Zippy is … 10x faster than plain Claude Code", "README.md#L4")).toEqual({
      ok: false,
      reason: "quote_elided",
    });
    expect(checkQuote(mat, "...2x faster than pi on our suite", "README.md#L2")).toMatchObject({
      ok: true,
      line: 2,
    });
    expect(checkQuote(mat, "“2x faster than pi on our suite…”", "README.md#L2")).toMatchObject({
      ok: true,
      line: 2,
    });
  });

  it("a negation or disclaimer before the span, or a retraction after it, is out of context", () => {
    expect(checkQuote(mat, "10x faster than plain Claude Code", "README.md#L4")).toEqual({
      ok: false,
      reason: "quote_out_of_context",
    });
    expect(checkQuote(mat, "5x cheaper per task", "README.md#L5")).toEqual({
      ok: false,
      reason: "quote_out_of_context",
    });
    expect(checkQuote(mat, "4x faster on big repos", "README.md#L6")).toEqual({
      ok: false,
      reason: "quote_out_of_context",
    });
    // Cited on the wrong line: relocation never lands on a negated occurrence either.
    expect(checkQuote(mat, "10x faster than plain Claude Code", "README.md#L1")).toEqual({
      ok: false,
      reason: "quote_out_of_context",
    });
  });

  it("a negation in an earlier clause does not taint the quote", () => {
    expect(checkQuote(mat, "zippy is 3x faster on our suite", "README.md#L7")).toMatchObject({
      ok: true,
      line: 7,
    });
  });

  it("a negation after the span (not a retraction) is fine", () => {
    expect(checkQuote(mat, "Zippy solves 33 of 50 tasks", "README.md#L8")).toMatchObject({
      ok: true,
      line: 8,
    });
  });
});
