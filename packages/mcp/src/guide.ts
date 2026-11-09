// get_kit_guide (TDM-220 [19.4]): how to write an eval kit, as text for the user's coding agent.
// The /anybench kit skill (19.5) leans on it. Every list, limit and name that has a constant in
// code comes from that constant, so the guide cannot drift from what validate_kit and the proof
// enforce: the layout (KIT_LAYOUT), the manifest fields (KitSpecSchema's shape), templates, driver
// and gate kinds, the six proof checks (PROOF_CHECKS, with a description record the compiler keeps
// exhaustive), the partial-credit metric names, the horizon thresholds, the upload limits. The
// fairness rules are plan.md 17.2 in a kit author's words; a test checks every rule's title from
// plan.md appears here.
import {
  COMPARABLE_CAPS,
  DEFAULT_GATE_REPEATS,
  DEFAULT_KIT_TEMPLATE,
  DEFAULT_LOCAL_PROOF_IMAGE,
  DEFAULT_MUTATION_TARGET,
  KIT_LAYOUT,
  KIT_TEMPLATES,
  KIT_TEMPLATE_SUMMARIES,
  LOCAL_PROOF_CHECKS,
} from "@anybench/kit";
import {
  DriverTypeSchema,
  GateKindSchema,
  GateResultSchema,
  HIDDEN_TEST_FRACTION_METRIC,
  HIDDEN_TESTS_PASSED_METRIC,
  HIDDEN_TESTS_TOTAL_METRIC,
  KIT_SCHEMA_VERSION,
  KIT_UPLOAD_LIMITS,
  KitSpecSchema,
  LONG_HORIZON_MIN_FEATURE_AREAS,
  LONG_HORIZON_MIN_WALL_S,
  MeasuredAggregateSchema,
  PROOF_CHECKS,
  ProofOverlaySchema,
  SubjectKindSchema,
  TaskHorizonSchema,
  WorkloadSchema,
} from "@anybench/core";

type ProofCheck = (typeof PROOF_CHECKS)[number];

/** What each of the six proof checks demands of a kit. Keyed by PROOF_CHECKS: a new check fails to compile here. */
export const PROOF_CHECK_GUIDE: Readonly<Record<ProofCheck, string>> = {
  oracle_passes: `proof.oracle (a reference solution, applied by a driver patch) passes every gate it covers on every workload, and each gate gives the same verdict ${DEFAULT_GATE_REPEATS} times on the same frozen output.`,
  do_less_fails: `every proof.do_less overlay fails some gate on some workload. A kit whose only do-less is a no-op fails (too weak); add a partial-oracle (the oracle with one contract clause removed) or a cheat. For hidden-tests gates the oracle's mutants must be killed (>= ${Math.round(DEFAULT_MUTATION_TARGET * 100)}%, survivors listed).`,
  smoke_passes:
    "each subject contender, un-overlaid, runs the first workload on the real eval computer: the runner finishes, every gate returns a real verdict, every measured metric is collected.",
  regression_scores_lower:
    "proof.regression (a planted regression, e.g. a CLAUDE.md that says not to test) fails the gate more often, or scores worse on a measured requirement, than the honest contender.",
  baselines_in_range:
    "every baseline contender passes every gate on every workload with every measured metric present (a known-good baseline that fails means the gate or its reference is wrong).",
  no_secret_in_kit:
    "no file in the kit holds a secret (API keys, tokens, private keys). Runs first; a kit with a secret never reaches a computer. Declare secret NAMES under `secrets:`; values are injected at run time.",
};

/**
 * plan.md 17.2, the rules a kit author can break, in the order and with the titles plan.md uses.
 * tdm220 guide test: each title here is a bold rule title in plan.md 17.2.
 */
export const FAIRNESS_RULES: readonly { n: number; title: string; forKits: string }[] = [
  {
    n: 1,
    title: "Correctness first, always.",
    forKits:
      "Every `measured` requirement names a `gate_id`: no speed, cost or quality number without a correctness gate. Cost is all spend ÷ solved tasks; time-to-solve counts failures at the cap (agent and harness kits must give `wall_s` a cap).",
  },
  {
    n: 2,
    title: "Every comparison has a verdict:",
    forKits:
      "better | worse | indistinguishable, computed by Anybench. Do not encode a winner in the kit; design workloads where a real difference shows.",
  },
  {
    n: 3,
    title: "Sample sizes come from a power estimate shown on the test plan.",
    forKits:
      'Agents: >= 10 `repeats` per cell (floor 4). A claim that one agent beats another needs >= 20 tasks, or it is reported as "on these N tasks".',
  },
  {
    n: 4,
    title: "Comparable setups or no comparison.",
    forKits: `Pin model ids and CLI / harness versions (no \`latest\` or \`main\`, also not as a \`\${VAR:-latest}\` fallback in an adapter script). Caps must be equal across contenders (${COMPARABLE_CAPS.map((c) => c.label).join("; ")}) unless the cap is the \`vary\` axis or \`unequal_caps_reason\` says why. Every assist (reviewer, tools, CLAUDE.md help) goes to every contender or to none. Set \`schedule.order_seed\` so contender order rotates.`,
  },
  {
    n: 5,
    title: "The agent under test can't touch the measurement.",
    forKits: `\`${KIT_LAYOUT.gatesDir}/\`, \`${KIT_LAYOUT.referenceDir}/\`, \`${KIT_LAYOUT.proofOracleDir}/\` and \`${KIT_LAYOUT.rubric}\` never reach the subject computer. Never put an answer, expected output or hidden test under \`${KIT_LAYOUT.workloadsDir}/\`. Gates read only the frozen outputs (EVAL_OUT), on a separate scoring computer.`,
  },
  {
    n: 6,
    title: "Preregistered.",
    forKits:
      "The whole-kit hash, weights, primary requirement and repeats are frozen before the first contender trial. Set `scoring.primary`; every later edit is logged with a reason.",
  },
  {
    n: 7,
    title: "Headline = per-requirement table, not a composite.",
    forKits:
      "Give each requirement its own clear title and unit; `scoring.weights` (integers summing to 100) only feed a composite that is always shown with its breakdown.",
  },
  {
    n: 8,
    title: "LLM-judged quality is optional and audited.",
    forKits:
      "A `reviewed` requirement needs `rubric.md` with binary per-criterion checks; it is kept out of the headline when the judges disagree.",
  },
  {
    n: 9,
    title: "The proof suite proves the gate discriminates, not just that it runs:",
    forKits:
      "Ship an oracle, do-less variants that are near misses, and a planted regression. Every hidden assertion must trace to `instruction.md` (or declare the instruction a contract: see Contracts and fixtures).",
  },
  {
    n: 10,
    title: "Honest wording.",
    forKits:
      'Never call synthetic tasks "from your history" or describe a simulated approver as a human. Titles and summaries say what is measured, not what you hope.',
  },
];

/** An object schema's fields, `?` after each one that may be left out (optional or defaulted). */
function fieldList(shape: Record<string, { safeParse(v: unknown): { success: boolean } }>): string {
  return Object.entries(shape)
    .map(([k, s]) => `${k}${s.safeParse(undefined).success ? "?" : ""}`)
    .join(", ");
}

function layout(): string {
  const L = KIT_LAYOUT;
  const rows: [string, string][] = [
    [L.manifest, `the manifest (KitSpec v${KIT_SCHEMA_VERSION})`],
    [L.installScript("<contender>"), "L1: installs the contender, at snapshot build"],
    [L.healthcheckScript("<contender>"), "L1: exits 0 when the install works"],
    [L.driverScript("<contender>"), "L2: verbs start | ready | run <task> <workspace> | stop"],
    [`${L.workloadInput("<workload>")}/`, "L3: the starting files, hashed per file"],
    [L.workloadInstruction("<workload>"), "L3: the task text the agent gets"],
    [L.workloadSetup("<workload>"), "L3: prepares EVAL_WS before the run"],
    [L.gateCheck("<gate>"), "L5: runs only on the scoring computer"],
    [`${L.referenceDir}/`, "L5: reference outputs shared by gates"],
    [L.rubric, "L6: rubric for reviewed requirements"],
    [`${L.proofOracleDir}/`, "L7: the reference solution overlay"],
    [`${L.proofDoLessDir}/<id>/`, "L7: overlays that skip work (each must fail a gate)"],
    [`${L.proofRegressionDir}/<id>/`, "L7: a planted regression (must score lower)"],
  ];
  const w = Math.max(...rows.map(([p]) => p.length)) + 2;
  return rows.map(([p, note]) => `${p.padEnd(w)}${note}`).join("\n");
}

function enumList(o: readonly string[]): string {
  return o.map((x) => `\`${x}\``).join(", ");
}

const bytes = (n: number) => `${Math.round(n / (1024 * 1024))} MiB`;

/** The guide, Markdown. Pure: the same text every call. */
export function kitGuide(): string {
  const L = KIT_LAYOUT;
  const gateResultFields = fieldList(GateResultSchema.shape);
  const doLessKinds = (ProofOverlaySchema.shape.kind.unwrap() as { options: readonly string[] })
    .options;
  const instructionKinds = (
    WorkloadSchema.shape.instruction_kind.unwrap() as { options: readonly string[] }
  ).options;
  return `# Writing an Anybench eval kit (KitSpec v${KIT_SCHEMA_VERSION})

An eval kit is a folder with \`${L.manifest}\` at its root. It says what is under test (the subject), what it is compared with (contenders), the tasks (workloads), how correctness is decided (gates), what is measured (requirements) and how the kit proves its own gates work (proof). You build it here, for free; Anybench reruns the proof on its own computers before any billed trial. An uploaded kit is never trusted as is.

## Steps
1. \`scaffold_kit {dir, template}\`: start from a shipped example. Templates: ${KIT_TEMPLATES.map((t) => `\`${t}\` (${KIT_TEMPLATE_SUMMARIES[t]})`).join("; ")}. Default \`${DEFAULT_KIT_TEMPLATE}\`.
2. Edit the manifest, workloads, gates and proof into your own benchmark (below).
3. \`validate_kit {dir}\` until it returns ok. Errors are \`file:line:col: field: message\`.
4. \`run_local_proof {dir}\`: ${LOCAL_PROOF_CHECKS.map((c) => `\`${c}\``).join(" and ")}, locally in Docker (image \`${DEFAULT_LOCAL_PROOF_IMAGE}\`, no network). Fix the kit until it passes; it costs nothing.
5. \`push_kit {dir}\`: validates again, packs and uploads; returns a \`kit_id\`.
6. \`start_run {kit_id, question, budget_usd}\`: Anybench reruns all six proof checks, then waits for Go. \`watch_run\`, \`get_run\`, \`list_trials\`, \`get_trial\`, \`get_report\` follow it.

## Layout
\`\`\`
${layout()}
\`\`\`
Subject side vs scoring side: the subject computer gets the kit without \`${L.gatesDir}/\` and \`${L.referenceDir}/\`; the gates get only the frozen outputs (EVAL_OUT) of the trial.

## The manifest
Top-level fields (\`?\` = optional or defaulted): ${fieldList(KitSpecSchema.shape)}.
- \`subject.kind\`: ${enumList(SubjectKindSchema.options)}. At least one contender has \`role: subject\`.
- \`contenders[].driver.type\`: ${enumList(DriverTypeSchema.options)}. A \`harness\` driver needs \`human_in_loop\`.
- \`gates[].kind\`: ${enumList(GateKindSchema.options)}.
- \`requirements[]\`: \`measured\` (a metric, \`better: lower|higher\`, and a \`gate_id\`) or \`reviewed\` (a rubric). \`aggregate\`: ${enumList(MeasuredAggregateSchema.options)}.
- \`scoring.weights\`: one integer per requirement, summing to 100; \`scoring.primary\` is the preregistered headline (weight > 0).
- \`proof.oracle\` must cover every gate a measured requirement uses (\`proof.oracle.gates\`, or omit it to cover all).
- \`secrets\`: names only, never values. \`repeats\`: trials per contender × workload.

## Gates
\`check.sh <frozen-out> <workload-id> <gate.json>\` writes \`gate.json\` {${gateResultFields}} and exits 0 whenever it wrote a verdict (pass or fail); exit 2 means the kit is broken. \`applicable: false\` takes the trial out of that gate's tally instead of failing it. Hidden tests live under \`${L.gateDir("<gate>")}/<workload>/\`, never in the workspace. The coding-agent oracle must freeze its workspace to \`$EVAL_OUT/workspace\`, as the template's \`proof/oracle/driver.sh\` does: gates see only EVAL_OUT.

## Partial-credit hidden tests
A gate passes only when every hidden test passes; partial credit is a metric, never a pass. A hidden-tests gate may also write \`<frozen-out>/<gate>.metrics.jsonl\`, one JSON row per metric \`{"metric", "value", "unit", "source"}\`: \`${HIDDEN_TEST_FRACTION_METRIC}\` (passed / total, 0..1), \`${HIDDEN_TESTS_PASSED_METRIC}\`, \`${HIDDEN_TESTS_TOTAL_METRIC}\`. A requirement on \`${HIDDEN_TEST_FRACTION_METRIC}\` is correctness itself, so it uses \`aggregate: all_trials\` (averaged over every trial, failed ones too) and names the hidden-tests gate; \`per_test_passed\` prices a money metric per hidden test passed. Speed and cost from failed trials are never averaged in.

## Task horizon
Subject horizon (\`subject.horizon.horizon\`): ${enumList(TaskHorizonSchema.options)}, with a rationale. A subject that coordinates several agents (a \`harness\`, or an agent whose summary describes an orchestrator, planner + workers, parallel agents or a task board) is never \`short\`: its kit needs at least one long-horizon workload: a wall cap of at least ${LONG_HORIZON_MIN_WALL_S} s (\`workloads[].timeout_s\`, else the tightest contender \`wall_clock_cap_s\`) that spans at least ${LONG_HORIZON_MIN_FEATURE_AREAS} feature areas, graded with partial credit (\`${HIDDEN_TEST_FRACTION_METRIC}\`). Small tasks alone measure a coordination tool's overhead, never its point; Anybench's skeptic flags such a kit as \`horizon_mismatch\`.

## Contracts and fixtures
- \`workloads[].instruction_kind\`: ${enumList(instructionKinds)}. \`task\` (default): the instruction must not name the hidden tests or quote the values they assert. \`contract\`: the instruction IS the public spec of a build-to-spec task (every route, field, status and exact response the tests check), so naming them is not leakage; it must still hold none of the oracle's or the tests' code.
- \`gates[].fixtures\`: the grader's own copies of workload input files (a seed data file the tests load), each a path under \`${L.gateDir("<id>")}/\` (a trailing \`/\` covers a directory; a \`*\` segment matches one path segment; \`**\` is not allowed), so a contender's edit to the workspace copy can't change the grade. Never an expected output.

## Proof (the six checks Anybench runs before any billed trial)
${PROOF_CHECKS.map((c) => `- \`${c}\`: ${PROOF_CHECK_GUIDE[c]}`).join("\n")}
do-less \`kind\`: ${enumList(doLessKinds)}. \`run_local_proof\` runs only ${LOCAL_PROOF_CHECKS.map((c) => `\`${c}\``).join(" and ")}; the rest need the real eval computer and run after push.

## Fairness rules (plan.md 17.2)
${FAIRNESS_RULES.map((r) => `${r.n}. **${r.title}** ${r.forKits}`).join("\n")}

## Upload limits
At most ${bytes(KIT_UPLOAD_LIMITS.maxBytes)} packed, ${bytes(KIT_UPLOAD_LIMITS.maxUnpackedBytes)} unpacked, ${KIT_UPLOAD_LIMITS.maxEntries} entries, ${KIT_UPLOAD_LIMITS.maxDepth} path segments. Regular files and directories only: no symlinks, no absolute or \`..\` paths.

## Money
Budgets are integer micro-USD (1 USD = 1000000). \`start_run\` takes \`budget_micro_usd\` as an integer, or \`budget_usd\` as a decimal string like "12.50"; nothing is billed until Go.
`;
}
