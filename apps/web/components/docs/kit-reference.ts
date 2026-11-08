// Reference data for /docs/kits (plan.md P2). Driver rows are keyed by DriverType from
// @anybench/core, so adding a driver type to the schema fails typecheck until it is documented
// here; profiles and default collectors are read from core, not copied.
import {
  DRIVER_DEFAULT_COLLECTORS,
  DRIVER_DEFAULT_PROFILE,
  DriverTypeSchema,
  type CollectorName,
  type DriverType,
} from "@anybench/core";

export interface KitLayer {
  id: string;
  name: string;
  field: string;
  files: string;
  contract: string;
}

export const KIT_LAYERS: readonly KitLayer[] = [
  {
    id: "L0",
    name: "Source",
    field: "contenders[].source",
    files: "—",
    contract: "{github, ref} · {binary_url, sha256} · {upload}",
  },
  {
    id: "L1",
    name: "Install",
    field: "contenders[].install",
    files: "adapters/<id>/install.sh, healthcheck.sh",
    contract:
      "Runs once, when the computer snapshot is built, so install time never enters a measurement. Exit 0 and the health check passes.",
  },
  {
    id: "L2",
    name: "Driver",
    field: "contenders[].driver",
    files: "adapters/<id>/driver.sh",
    contract:
      "Verbs start, ready, run <in> <out>, stop. Env EVAL_IN, EVAL_WS, EVAL_OUT, EVAL_SECRETS (a file path). driver.type picks the collectors and the computer profile.",
  },
  {
    id: "L3",
    name: "Workload",
    field: "workloads[]",
    files: "workloads/<id>/{input/*, instruction.md, setup.sh}",
    contract: "Deterministic bytes; the sha256 of the input is recorded on every trial.",
  },
  {
    id: "L4",
    name: "Probes",
    field: "collectors[]",
    files: "built into the runner",
    contract:
      "Write EVAL_OUT/metrics.jsonl, events.jsonl, machine.json, and artifacts/ from the collect: globs. Omit collectors[] to get the driver type's defaults.",
  },
  {
    id: "L5",
    name: "Gate",
    field: "requirements[].gate_id → gates[]",
    files: "gates/<id>/check.sh, reference/",
    contract:
      "Runs only on the scoring computer, which never ran the contender. Writes gate.json {pass, reason, evidence[]}.",
  },
  {
    id: "L6",
    name: "Review",
    field: "requirements[].rubric",
    files: "rubric.md",
    contract:
      "A reviewer agent on a different model scores the requirement against the rubric and quotes evidence paths.",
  },
  {
    id: "L7",
    name: "Proof",
    field: "proof",
    files: "proof/{oracle, do_less, regression}/",
    contract:
      "Each is a contender overlay (a driver patch or env) run through L1–L5: the oracle must pass, do-less must fail, the regression must score lower.",
  },
];

export interface DriverDoc {
  className: string;
  drivenBy: string;
  measured: string;
  gate: string;
  /** Drivers on the roadmap are documented but not yet runnable. */
  roadmap?: true;
}

export const DRIVER_DOCS: Readonly<Record<DriverType, DriverDoc>> = {
  cli: {
    className: "CLI tool",
    drivenBy: "hyperfine --export-json, /usr/bin/time -v",
    measured: "wall time, CPU, peak memory",
    gate: "stdout or file diff against the oracle's output",
  },
  service: {
    className: "Service or API",
    drivenBy: "start + a ready URL, then hey or k6",
    measured: "p50 and p95 latency, requests/s, memory",
    gate: "golden request set and response diff; database state check",
  },
  lib: {
    className: "Library",
    drivenBy: "a generated bench shim (tinybench, pytest-benchmark, criterion)",
    measured: "ops/s, allocations",
    gate: "property tests against a reference implementation",
  },
  pty: {
    className: "Terminal emulator or TUI",
    drivenBy:
      "the emulator under Xvfb, input streamed through a PTY shim, ending with a sentinel the runner waits for",
    measured: "time to sentinel, bytes/s, memory",
    gate: "a reference grid from a VT parser at the same size; final screen compared cell by cell, scrollback by line hash",
  },
  x11: {
    className: "GUI app",
    drivenBy: "xdotool scripts, screenshots",
    measured: "task time (no frame rates)",
    gate: "the accessibility tree or the app's export file",
    roadmap: true,
  },
  web: {
    className: "Web app",
    drivenBy: "Playwright and k6",
    measured: "TTFB, p95, Lighthouse",
    gate: "DOM assertions and golden responses",
  },
  "coding-agent": {
    className: "Coding agent",
    drivenBy: "claude -p --output-format stream-json on instruction.md in EVAL_WS",
    measured: "tokens, turns, cost, wall time",
    gate: "hidden tests on the scoring computer",
  },
  "http-agent": {
    className: "API or chat agent",
    drivenBy: "the runner posts a conversation set; a reviewer-model session can play the user",
    measured: "latency, cost, outcome",
    gate: "labeled answers or oracle match",
  },
  harness: {
    className: "Harness with approvals",
    drivenBy: "run.sh plus an approver sidecar (human_in_loop: {kind, policy})",
    measured: "tests passed, time, tokens, claims, conflicts, approvals",
    gate: "hidden tests on the scoring computer",
  },
};

export interface DriverRow extends DriverDoc {
  type: DriverType;
  profile: string;
  collectors: readonly CollectorName[];
}

/** One row per driver type, in schema order. */
export function driverRows(): DriverRow[] {
  return DriverTypeSchema.options.map((type) => ({
    type,
    ...DRIVER_DOCS[type],
    profile: DRIVER_DEFAULT_PROFILE[type],
    collectors: DRIVER_DEFAULT_COLLECTORS[type],
  }));
}

/** The other top-level anybench.yaml fields, beyond the layers. */
export const KIT_OTHER_FIELDS: readonly { field: string; meaning: string }[] = [
  { field: "schema_version", meaning: "Always 2." },
  {
    field: "subject",
    meaning: "{kind: agent | harness | software, name, summary, better_means[]}.",
  },
  { field: "vary", meaning: "Each value is one setup to compare, e.g. WORKERS: [1, 3, 5]." },
  {
    field: "human_in_loop",
    meaning:
      "{kind: tandem | naive, policy: auto | llm-reviewer | human-sim}. Required for harness drivers.",
  },
  { field: "secrets", meaning: "Names only. Values are injected at run time, never stored." },
  { field: "collect", meaning: "Globs under EVAL_OUT copied into artifacts/." },
  { field: "transfer", meaning: "{max_mb}: the most output a trial may upload." },
  {
    field: "scoring.weights",
    meaning: "One integer weight per requirement; they must sum to 100.",
  },
  { field: "repeats", meaning: "Measured trials per contender × workload (1–100)." },
  { field: "env", meaning: "Optional inline EnvSpec: profile, size, packages, services, network." },
  { field: "schedule", meaning: "Optional: warm-ups, packing of short trials, billing block." },
];
