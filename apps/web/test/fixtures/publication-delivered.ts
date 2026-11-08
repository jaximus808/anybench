// The delivered run 01a1b9ee… as a published snapshot, for designing the /r charts against real
// numbers (no DB): Claude Code solo 7/7 solved (wall 35–105 s, cost $0.12–0.52), Tandem ×3 2/4
// (wall 228–329 s, cost $1.99–2.80). The statistics below were computed with @anybench/bench
// (wilsonCi, newcombeCi, fisherExact, mannWhitney, hodgesLehmannCi) from per-trial values in
// those ranges; every verdict is "no detectable difference" (n too small; Holm across 3).
// Parsed with core PublicPublicationSchema so it stays valid.
import {
  PROOF_CHECKS,
  PUBLICATION_SCHEMA,
  PublicPublicationSchema,
  ReportSchema,
  type PublicPublication,
  type Report,
} from "@anybench/core";

export const DELIVERED_SLUG = "q7m2x9k4v8t3b6n1p5zr";
export const DELIVERED_RUN_ID = "01a1b9ee-a665-73d4-9511-3c24e921d864";
const SOLO = "019a5f3e-7c00-7000-8000-0000000000a1";
const TANDEM = "019a5f3e-7c00-7000-8000-0000000000a3";
const TASKS = ["todo-api", "auth-refactor", "bug-hunt"];
const SCOPE =
  "3 tasks: this doesn't generalise to other tasks; ≥8 tasks needed for a general claim.";

type Cmp = {
  test: "fisher_exact" | "mann_whitney_exact";
  p: number;
  pAdj: number;
  family: number;
  effect: number;
  hl: number | null;
  lo: number;
  hi: number;
  level: number;
  n: [number, number];
  tasks: number;
  mde: number | null;
};

function cmp(c: Cmp) {
  const rate = c.test === "fisher_exact";
  const mdeText =
    c.mde === null ? "none at this n" : rate ? `${Math.round(c.mde * 100)} pp` : `|δ| ${c.mde}`;
  return {
    baseline_id: SOLO,
    verdict: "indistinguishable",
    test: c.test,
    p: c.p,
    p_adjusted: c.pAdj,
    alpha: 0.05,
    family: c.family,
    effect: { measure: rate ? "rate_diff" : "cliffs_delta", value: c.effect, hodges_lehmann: c.hl },
    diff_ci: {
      lo: c.lo,
      hi: c.hi,
      level: c.level,
      requested_level: 0.95,
      attained: c.level >= 0.95,
      unit: rate ? "rate" : "metric",
    },
    n: { candidate: c.n[0], baseline: c.n[1], tasks: c.tasks },
    mde: { value: c.mde, unit: rate ? "rate" : "cliffs_delta", metric_shift: null },
    claim: "these_tasks",
    downgraded: null,
    statement: `no detectable difference at n=${c.n[0]} vs ${c.n[1]}, smallest detectable difference=${mdeText}`,
  };
}

const W = 0.9444444444444444; // the widest exact Hodges–Lehmann interval at 2 vs 7
const task = (workload_id: string, c: Omit<Cmp, "family" | "tasks">) => ({
  workload_id,
  comparison: cmp({ ...c, family: 7, tasks: 1 }),
});

export function deliveredReport(): Report {
  const req = (
    id: "tests-pass" | "wall" | "cost",
    value: number,
    n: number,
    rate: number,
    extra: Record<string, unknown> = {},
  ) => ({
    requirement_id: id,
    type: "measured",
    title:
      id === "tests-pass"
        ? "Hidden tests pass (42 tests across 3 tasks)"
        : id === "wall"
          ? "Wall-clock time to solve"
          : "Cost per solved task",
    value,
    unit: id === "tests-pass" ? "ratio" : id === "wall" ? "s" : "micro-USD",
    ci95: null,
    gate_id: "hidden-tests",
    gate_pass_rate: rate,
    score: null,
    n,
    survivorship: false,
    comparison: null,
    ...extra,
  });
  const contenders = [
    {
      contender_id: SOLO,
      name: "A · Claude Code solo",
      role: "baseline",
      score: null,
      ci95: null,
      delta_vs_baseline: null,
      requirements: [req("tests-pass", 1, 7, 1), req("wall", 61, 7, 1), req("cost", 260_000, 7, 1)],
      wins: [],
      losses: [],
    },
    {
      contender_id: TANDEM,
      name: "D · Tandem ×3",
      role: "subject",
      score: null,
      ci95: null,
      delta_vs_baseline: null,
      requirements: [
        req("tests-pass", 0.5, 4, 0.5, {
          comparison: cmp({
            test: "fisher_exact",
            p: 0.1090909090909091,
            pAdj: 0.16666666666666666,
            family: 3,
            effect: -0.5,
            hl: null,
            lo: -0.8499610108478504,
            hi: -0.001981158661444604,
            level: 0.95,
            n: [4, 7],
            tasks: 3,
            mde: 0.7326626355061308,
          }),
          by_task: [
            task("todo-api", {
              test: "fisher_exact",
              p: 0.4,
              pAdj: 1,
              effect: -0.5,
              hl: null,
              lo: -0.9054687942657693,
              hi: 0.19259213090610783,
              level: 0.95,
              n: [2, 3],
              mde: null,
            }),
            task("auth-refactor", {
              test: "fisher_exact",
              p: 1,
              pAdj: 1,
              effect: 0,
              hl: null,
              lo: -0.7934506856227626,
              hi: 0.6576197724933468,
              level: 0.95,
              n: [1, 2],
              mde: null,
            }),
            task("bug-hunt", {
              test: "fisher_exact",
              p: 0.33333333333333337,
              pAdj: 1,
              effect: -1,
              hl: null,
              lo: -1,
              hi: 0.030547308807040263,
              level: 0.95,
              n: [1, 2],
              mde: null,
            }),
          ],
        }),
        req("wall", 262.5, 2, 0.5, {
          survivorship: true,
          comparison: cmp({
            test: "mann_whitney_exact",
            p: 0.05555555555555555,
            pAdj: 0.16666666666666666,
            family: 3,
            effect: -1,
            hl: 192.5,
            lo: 123,
            hi: 262,
            level: W,
            n: [2, 7],
            tasks: 3,
            mde: null,
          }),
          by_task: [
            task("todo-api", {
              test: "mann_whitney_exact",
              p: 0.5,
              pAdj: 1,
              effect: -1,
              hl: 176,
              lo: 154,
              hi: 193,
              level: 0.5,
              n: [1, 3],
              mde: null,
            }),
            task("auth-refactor", {
              test: "mann_whitney_exact",
              p: 0.6666666666666666,
              pAdj: 1,
              effect: -1,
              hl: 214,
              lo: 192,
              hi: 236,
              level: 0.33333333333333337,
              n: [1, 2],
              mde: null,
            }),
          ],
        }),
        req("cost", 2_265_000, 2, 0.5, {
          survivorship: true,
          comparison: cmp({
            test: "mann_whitney_exact",
            p: 0.05555555555555555,
            pAdj: 0.16666666666666666,
            family: 3,
            effect: -1,
            hl: 1_945_000,
            lo: 1_470_000,
            hi: 2_420_000,
            level: W,
            n: [2, 7],
            tasks: 3,
            mde: null,
          }),
        }),
      ],
      wins: [],
      losses: [],
    },
  ];
  return ReportSchema.parse({
    run_id: DELIVERED_RUN_ID,
    kit_id: null,
    answer: `On the tasks tested: no requirement differed on every task. Result on tests-pass (the primary requirement): Tandem ×3 vs Claude Code solo: no detectable difference at n=4 vs 7. (2 setups; 11 measured trials; Holm-corrected across 3 comparisons.) No setup is ranked by a composite score. ${SCOPE} proof: curated (verified offline at bebb77e) tokens: naive-proxy, effort: naive-min, thinking: off; simulated approvals`,
    comped: false,
    contenders,
    where_it_breaks: [],
    bottlenecks: [],
    proof: PROOF_CHECKS.map((check) =>
      check === "oracle_passes" || check === "do_less_fails"
        ? {
            check,
            pass: true,
            reason: "proof: curated (verified offline at bebb77e): oracle 42/42",
            evidence: [],
          }
        : { check, pass: false, reason: "not run: proof suite not available yet", evidence: [] },
    ),
    failures: { infra: 0, subject: 0, gate: 2, kit: 0, budget: 0, timeout: 0 },
    per_task: { tasks: TASKS, family: 7, alpha: 0.05, scope: SCOPE, headline: [] },
    postmortem: null,
    generated_at: "2026-11-07T22:41:09.000Z",
  });
}

export function deliveredPublication(): Extract<PublicPublication, { status: "live" }> {
  const report = deliveredReport();
  const setups = [
    { id: SOLO, name: "A · Claude Code solo", role: "baseline", n: 7 },
    { id: TANDEM, name: "D · Tandem ×3", role: "subject", n: 4 },
  ];
  const payload = {
    schema: PUBLICATION_SCHEMA,
    slug: DELIVERED_SLUG,
    version: 1,
    run_id: DELIVERED_RUN_ID,
    published_at: "2026-11-08T00:12:00.000Z",
    title: "Does Tandem with 3 workers beat plain Claude Code?",
    subject: { name: "tandem", kind: "harness" },
    verdict:
      "Result on tests-pass (the primary requirement): Tandem ×3 vs Claude Code solo: no detectable difference at n=4 vs 7. (2 setups; 11 measured trials; Holm-corrected across 3 comparisons.) No setup is ranked by a composite score.",
    badge: {
      subject: "Tandem",
      baseline: "Claude Code solo",
      requirement: "tests-pass",
      verdict: "indistinguishable",
      message: "Tandem vs Claude Code solo: no detectable difference",
      scope: "on these 3 tasks",
    },
    report,
    evaluation: {
      kit_hash: "3f2a9c41d07be8a5c6f1e2d3b4a59687e1f0c2d3a4b5c6d7e8f90a1b2c3d4e5f",
      kit_version: 1,
      kit_files_sha256: "b81c4e0f9a2d3c5e7f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e",
      preregistered_at: "2026-11-07T20:58:31.000Z",
      run_started_at: "2026-11-07T20:41:02.000Z",
      run_delivered_at: "2026-11-07T22:41:09.000Z",
      disclosure: "tokens: naive-proxy, effort: naive-min, thinking: off; simulated approvals",
      setups: setups.map((s) => ({
        contender_id: s.id,
        name: s.name,
        role: s.role,
        model: "anthropic/claude-opus-5.5",
        version: s.name.includes("Tandem") ? "tandem@0.2.0" : null,
        versions: s.name.includes("Tandem")
          ? { CLAUDE_CODE_VERSION: "2.1.319", TANDEM_MCP_VERSION: "3.2.0", TANDEM_VERSION: "0.2.0" }
          : { CLAUDE_CODE_VERSION: "2.1.319" },
        graded_trials: s.n,
      })),
      tasks: [
        {
          id: "todo-api",
          title: "Build a REST API with auth and tests",
          hidden_tests: 16,
          shape: "splits-cleanly",
        },
        {
          id: "auth-refactor",
          title: "Move sessions to JWT across 9 files",
          hidden_tests: 14,
          shape: "tightly-coupled",
        },
        {
          id: "bug-hunt",
          title: "Fix a planted CSV quoting bug (RFC 4180)",
          hidden_tests: 12,
          shape: "planted-bug",
        },
      ],
      gates: [
        {
          id: "hidden-tests",
          kind: "hidden-tests",
          description:
            "Runs the workload's hidden tests (never in the workspace) against a copy of the frozen workspace, offline. Passes only when every hidden test passes.",
        },
      ],
      proof: {
        basis: "curated",
        label: "curated (verified offline at bebb77e)",
        checks: report.proof,
      },
      trials: { graded: 11, gate_passed: 9, infra_excluded: 0, cancelled: 0, warmups: 0 },
      stats: { alpha: 0.05, family: 3, per_task_family: 7, per_task_scope: SCOPE },
      metrics: { wall_clock: true, cost: true },
    },
  };
  return PublicPublicationSchema.parse({
    status: "live",
    signed: {
      payload,
      alg: "Ed25519",
      key_id: "ab-2026-11",
      signature:
        "Vf3n0q8m1x2c5b7z9k4j6h8g0f2d4s6a8p0o2i4u6y8t0r2e4w6q8a0s2d4f6g8h0j2k4l6z8x0c2v4b6n8m0q2w==",
    },
    verification: { valid: true, key_id: "ab-2026-11", reason: "signed by ab-2026-11 (current)" },
    versions: [{ version: 1, published_at: "2026-11-08T00:12:00.000Z" }],
  }) as Extract<PublicPublication, { status: "live" }>;
}
