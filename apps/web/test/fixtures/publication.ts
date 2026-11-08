// A published snapshot shaped like the real Tandem run (01a1b9ee…): five setups, three tasks,
// 11 graded trials, a curated proof, every comparison "no detectable difference". With
// `withMetrics` it also carries wall-clock and cost requirements (the run once metrics land).
// Parsed with core PublicPublicationSchema so it stays valid.
import {
  PROOF_CHECKS,
  PUBLICATION_SCHEMA,
  PublicPublicationSchema,
  type PublicPublication,
} from "@anybench/core";

export const PUB_SLUG = "k3v9q2m7x4t8b6n1p5zd";
export const PUB_RUN_ID = "01a1b9ee-a665-73d4-9511-3c24e921d864";
const ID = (n: number) => `019a5f3e-7c00-7000-8000-0000000000${String(n).padStart(2, "0")}`;
const SETUPS = [
  { id: ID(1), name: "A · Claude Code solo", role: "baseline", n: 3, pass: 2 },
  { id: ID(2), name: "B · Claude Code + subagents", role: "competitor", n: 2, pass: 1 },
  { id: ID(3), name: "C · Tandem ×1", role: "subject", n: 2, pass: 1 },
  { id: ID(4), name: "D · Tandem ×3", role: "subject", n: 2, pass: 2 },
  { id: ID(5), name: "E · Tandem ×5", role: "subject", n: 2, pass: 1 },
] as const;
const TASKS = ["todo-api", "auth-refactor", "bug-hunt"];
const SCOPE =
  "3 tasks: this doesn't generalise to other tasks; ≥8 tasks needed for a general claim.";

function cmp(opts: {
  n: number;
  baseN: number;
  diff: number;
  tasks: number;
  test?: "fisher_exact" | "mann_whitney_exact";
  unit?: "rate" | "metric";
}) {
  const rate = (opts.unit ?? "rate") === "rate";
  return {
    baseline_id: ID(1),
    verdict: "indistinguishable",
    test: opts.test ?? "fisher_exact",
    p: 1,
    p_adjusted: 1,
    alpha: 0.05,
    family: rate ? 4 : 8,
    effect: rate
      ? { measure: "rate_diff", value: opts.diff, hodges_lehmann: null }
      : { measure: "cliffs_delta", value: 0.25, hodges_lehmann: opts.diff },
    diff_ci: rate
      ? {
          lo: Math.max(-1, opts.diff - 0.7),
          hi: Math.min(1, opts.diff + 0.7),
          level: 0.95,
          requested_level: 0.95,
          attained: true,
          unit: "rate",
        }
      : { lo: -820, hi: 310, level: 0.8, requested_level: 0.95, attained: false, unit: "metric" },
    n: { candidate: opts.n, baseline: opts.baseN, tasks: opts.tasks },
    mde: { value: null, unit: rate ? "rate" : "cliffs_delta", metric_shift: null },
    claim: "these_tasks",
    downgraded: null,
    statement: `no detectable difference at n=${opts.n} vs ${opts.baseN}, smallest detectable difference=none at this n`,
  };
}

export function publicationFixture(opts: { withMetrics?: boolean; valid?: boolean } = {}) {
  const withMetrics = opts.withMetrics ?? false;
  const contenders = SETUPS.map((s, i) => {
    const base = s.role === "baseline";
    const rate = s.pass / s.n;
    const reqs: unknown[] = [
      {
        requirement_id: "tests-pass",
        type: "measured",
        title: "Hidden tests pass (42 tests across 3 tasks)",
        value: rate,
        unit: "ratio",
        ci95: null,
        gate_id: "hidden-tests",
        gate_pass_rate: rate,
        score: null,
        n: s.n,
        survivorship: false,
        comparison: base ? null : cmp({ n: s.n, baseN: 3, diff: rate - 2 / 3, tasks: 3 }),
        ...(base
          ? {}
          : {
              by_task: TASKS.map((t) => ({
                workload_id: t,
                comparison: cmp({ n: 1, baseN: 1, diff: 0, tasks: 1 }),
              })),
            }),
      },
    ];
    if (withMetrics)
      reqs.push({
        requirement_id: "wall",
        type: "measured",
        title: "Wall-clock time to solve (failures at the cap)",
        value: [1260, 1140, 980, 610, 702][i],
        unit: "s",
        ci95: null,
        gate_id: "hidden-tests",
        gate_pass_rate: rate,
        score: null,
        n: s.n,
        survivorship: false,
        comparison: base
          ? null
          : cmp({
              n: s.n,
              baseN: 3,
              diff: -300,
              tasks: 3,
              test: "mann_whitney_exact",
              unit: "metric",
            }),
      });
    return {
      contender_id: s.id,
      name: s.name,
      role: s.role,
      score: null,
      ci95: null,
      delta_vs_baseline: null,
      requirements: reqs,
      wins: [],
      losses: [],
    };
  });
  const report = {
    run_id: PUB_RUN_ID,
    kit_id: null,
    answer: `On the tasks tested: no requirement differed on every task. Result on tests-pass (the primary requirement): every setup vs claude-code-solo: no detectable difference at n=2 vs 3. (5 setups; 11 measured trials; Holm-corrected across 4 comparisons.) No setup is ranked by a composite score. ${SCOPE} proof: curated (verified offline at bebb77e) tokens: naive-proxy, effort: naive-min, thinking: off; simulated approvals`,
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
    failures: { infra: 2, subject: 1, gate: 3, kit: 0, budget: 0, timeout: 0 },
    per_task: { tasks: TASKS, family: 12, alpha: 0.05, scope: SCOPE, headline: [] },
    postmortem: null,
    generated_at: "2026-11-07T22:41:09.000Z",
  };
  const payload = {
    schema: PUBLICATION_SCHEMA,
    slug: PUB_SLUG,
    version: 1,
    run_id: PUB_RUN_ID,
    published_at: "2026-11-08T00:12:00.000Z",
    title: "Does Tandem with 1, 3 or 5 workers beat plain Claude Code, solo or with subagents?",
    subject: { name: "tandem", kind: "harness" },
    verdict:
      "Result on tests-pass (the primary requirement): every setup vs claude-code-solo: no detectable difference at n=2 vs 3. (5 setups; 11 measured trials; Holm-corrected across 4 comparisons.) No setup is ranked by a composite score.",
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
      setups: SETUPS.map((s) => ({
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
      trials: { graded: 11, gate_passed: 7, infra_excluded: 2, cancelled: 0, warmups: 0 },
      stats: { alpha: 0.05, family: 4, per_task_family: 12, per_task_scope: SCOPE },
      metrics: { wall_clock: withMetrics, cost: false },
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
    verification:
      opts.valid === false
        ? { valid: false, key_id: null, reason: "signature does not match the payload" }
        : { valid: true, key_id: "ab-2026-11", reason: "signed by ab-2026-11 (current)" },
    versions: [{ version: 1, published_at: "2026-11-08T00:12:00.000Z" }],
  }) as Extract<PublicPublication, { status: "live" }>;
}
