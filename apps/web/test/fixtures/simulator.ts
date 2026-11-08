// TEST-ONLY. A deterministic, simulated run for the live-model and live-page tests. It emits
// the same AnybenchEvent shapes the API streams (every event parses with AnybenchEventSchema;
// live-model.test.ts checks it). Never imported by app code: the site shows no simulated runs.
//
// Time is compressed: a ~2 h run plays in about two minutes at speed 1.
import {
  AgentSessionIdSchema,
  ContenderIdSchema,
  RunIdSchema,
  TrialIdSchema,
  type AgentSession,
  type AnybenchEvent,
  type EventActor,
  type EventSeverity,
  type RunState,
  type Trial,
  type TrialState,
} from "@anybench/core";
import type { LiveSnapshot } from "../../lib/live/model";

/** Seeded PRNG (mulberry32), so a demo run is the same every time. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function uuid(kind: number, n: number): string {
  const hex = (v: number, len: number) => v.toString(16).padStart(len, "0").slice(-len);
  return `${hex(0x0a7b0000 + kind, 8)}-0000-4000-8000-${hex(n, 12)}`;
}

export interface DemoOptions {
  seed?: number;
  /** Wall-clock ms for the whole run at speed 1. */
  contenders?: string[];
  workloads?: string[];
  repeats?: number;
  concurrency?: number;
}

export interface DemoRun {
  snapshot: LiveSnapshot;
  /** Every event, sorted by seq; `atMs` is the offset from the run's start, in demo ms. */
  timeline: { atMs: number; event: AnybenchEvent }[];
  durationMs: number;
}

const DEFAULT_CONTENDERS = [
  "claude code solo",
  "claude code + subagents",
  "tandem ×3",
  "tandem ×5",
];
const DEFAULT_WORKLOADS = ["todo-api", "auth-refactor", "bug-hunt"];

/** Per-contender odds, so the demo has a story without claiming anything real. */
const PROFILE = [
  { pass: 0.6, speed: 1.0 },
  { pass: 0.72, speed: 0.92 },
  { pass: 0.8, speed: 0.74 },
  { pass: 0.78, speed: 0.7 },
];

const TOOLS: Record<string, string[][]> = {
  understander: [
    ["read_file", "README.md"],
    ["list_dir", "src/"],
    ["read_file", "package.json"],
    ["grep", '"workers" src/'],
    ["read_file", "src/board/queue.ts"],
  ],
  researcher: [
    ["web_search", "tandem multi-agent claude code benchmark"],
    ["fetch", "github.com/anthropics/claude-code"],
    ["web_search", "claude code subagents parallel tasks"],
    ["fetch", "docs.anthropic.com/claude-code/sub-agents"],
  ],
  intake: [
    ["exec", "npm i -g @anthropic-ai/claude-code@2.1.4"],
    ["exec", "claude --version"],
    ["write_file", "adapters/subagents/install.sh"],
    ["exec", "./smoke.sh subagents"],
  ],
  "kit designer": [
    ["write_file", "anybench.yaml"],
    ["write_file", "workloads/todo-api/task.md"],
    ["write_file", "workloads/auth-refactor/task.md"],
    ["write_file", "workloads/bug-hunt/plant.patch"],
    ["write_file", "gates/tests-pass.sh"],
  ],
  verifier: [
    ["read_file", "proof/todo-api.log"],
    ["exec", "anybench kit validate"],
  ],
  reviewer: [
    ["read_file", "outputs/diff.patch"],
    ["read_file", "outputs/test-report.json"],
    ["score", "rubric.correctness"],
  ],
  investigator: [
    ["query", "time_to_solve by contender"],
    ["read_file", "trials/tandem-x5/bug-hunt-2/transcript.jsonl"],
    ["request_rerun", "tandem ×5 · bug-hunt (instrumented)"],
  ],
  analyst: [
    ["read_file", "stats.json"],
    ["write_file", "report/answer.md"],
  ],
};

const MESSAGES: Record<string, string[]> = {
  understander: [
    "Tandem is a shared task board that coordinates several Claude Code workers through MCP.",
    "Better means: more tasks solved, faster wall-clock, without more spend per solved task.",
  ],
  researcher: [
    "Baselines: plain Claude Code, and Claude Code with subagents (the obvious alternative).",
    "No published numbers to compare against; both baselines will run in the same kit.",
  ],
  intake: ["Adapter for claude code + subagents passes its smoke test."],
  "kit designer": [
    "3 workloads, 5 repeats each. Gate: the hidden test suite passes and the planted bug is fixed.",
  ],
  verifier: ["Proof passed on all 4 contenders: every gate can pass and can fail."],
  reviewer: ["Diff matches the task; gate evidence attached."],
  investigator: [
    "×5 loses time on bug-hunt to board contention; three workers claim the same lead.",
  ],
  analyst: ["Draft answer written. Numbers come from stats.json, not from me."],
};

export function createDemoRun(opts: DemoOptions = {}): DemoRun {
  const rand = rng(opts.seed ?? 7);
  const contenderNames = opts.contenders ?? DEFAULT_CONTENDERS;
  const workloads = opts.workloads ?? DEFAULT_WORKLOADS;
  const repeats = opts.repeats ?? 5;
  const concurrency = opts.concurrency ?? 14;

  const runId = RunIdSchema.parse(uuid(1, 1));
  const startedAt = Date.UTC(2026, 10, 7, 15, 0, 0);
  const contenders = contenderNames.map((name, i) => ({
    id: ContenderIdSchema.parse(uuid(2, i + 1)),
    name,
  }));

  const trials: Trial[] = [];
  let n = 0;
  contenders.forEach((c) => {
    workloads.forEach((w) => {
      for (let r = 0; r < repeats; r++) {
        trials.push({
          id: TrialIdSchema.parse(uuid(3, ++n)),
          run_id: runId,
          contender_id: c.id,
          workload_id: w,
          repeat: r,
          attempt: 1,
          state: "queued",
          failure_class: null,
          started_at: null,
          ended_at: null,
          cost_micro_usd: 0n,
        });
      }
    });
  });

  const roles = Object.keys(TOOLS);
  const agentIds = new Map(roles.map((r, i) => [r, AgentSessionIdSchema.parse(uuid(4, i + 1))]));
  const agents: AgentSession[] = roles.map((role) => ({
    id: agentIds.get(role)!,
    run_id: runId,
    role,
    status: "queued",
    budget_micro_usd: 2_000_000n,
    cost_micro_usd: 0n,
    last_tool: null,
    stop_reason: null,
    pending_action: null,
    started_at: null,
    ended_at: null,
  }));

  type Draft = { atMs: number; ev: Omit<AnybenchEvent, "seq" | "at"> };
  const drafts: Draft[] = [];
  const base = {
    run_id: runId as string,
    cost_delta_micro_usd: 0n,
  };
  const system: EventActor = { kind: "system" };
  const push = (atMs: number, ev: Record<string, unknown>) =>
    drafts.push({ atMs, ev: { ...base, actor: system, ...ev } as Draft["ev"] });

  // ---- pre-trial stages -------------------------------------------------------------------
  let t = 0;
  let runState: RunState = "intake";
  const runTo = (to: RunState, reason?: string) => {
    push(t, {
      type: "run.state_changed",
      source: "run",
      source_id: runId,
      severity: "info",
      payload: { from: runState, to, ...(reason ? { reason } : {}) },
    });
    runState = to;
  };
  // The snapshot starts at intake; the creation event is not replayed.

  const agentWork = (role: string, startMs: number, spanMs: number) => {
    const id = agentIds.get(role)!;
    const actor: EventActor = { kind: "agent", id };
    const tools = [...(TOOLS[role] ?? [])];
    const msgs = [...(MESSAGES[role] ?? [])];
    const steps = tools.length + msgs.length;
    let seqN = 0;
    let at = startMs;
    const gap = spanMs / Math.max(1, steps);
    for (let i = 0; i < steps; i++) {
      const isMsg = i % 3 === 2 || i >= tools.length;
      at += gap * (0.6 + rand() * 0.8);
      if (isMsg && msgs.length) {
        const text = msgs.shift()!;
        drafts.push({
          atMs: at,
          ev: {
            ...base,
            actor,
            type: "agent.message",
            source: "agent_session",
            source_id: id,
            severity: "info",
            cost_delta_micro_usd: BigInt(20_000 + Math.floor(rand() * 60_000)),
            payload: {
              agent_role: role,
              naive_seq: ++seqN,
              message_role: "assistant",
              text,
              truncated: false,
            },
          } as Draft["ev"],
        });
      } else if (tools.length) {
        const [tool, input] = tools.shift()!;
        drafts.push({
          atMs: at,
          ev: {
            ...base,
            actor,
            type: "agent.tool.started",
            source: "agent_session",
            source_id: id,
            severity: "info",
            cost_delta_micro_usd: BigInt(5_000 + Math.floor(rand() * 20_000)),
            payload: { agent_role: role, naive_seq: ++seqN, tool, input_preview: input },
          } as Draft["ev"],
        });
      }
    }
  };

  t = 600;
  runTo("understand");
  agentWork("understander", t, 5000);
  t += 5600;
  runTo("research");
  agentWork("researcher", t, 5200);
  agentWork("intake", t + 1500, 4800);
  t += 6600;
  runTo("kit_draft");
  agentWork("kit designer", t, 4600);
  t += 5000;
  runTo("env_build");
  const recipes = ["node22", "claude-code@2.1.4", "tandem", "git"];
  recipes.forEach((recipe, i) => {
    const at = t + i * 700;
    push(at, {
      type: "computer.recipe",
      source: "computer",
      source_id: uuid(5, 900 + i),
      severity: "info",
      payload: {
        recipe,
        version: "1",
        phase: "installed",
        step: "install",
        arch: "x64",
        duration_ms: 18_000 + i * 4000,
      },
    });
  });
  t += 3200;
  runTo("proof");
  agentWork("verifier", t, 2600);
  t += 3000;
  runTo("awaiting_go");
  t += 800;
  runTo("running", "estimate fits the run budget");
  const runningAt = t;

  // ---- trials -----------------------------------------------------------------------------
  // A simple scheduler: `concurrency` slots, trials start as slots free up.
  const slots: number[] = Array.from({ length: concurrency }, (_, i) => runningAt + i * 140);
  const PHASES: TrialState[] = [
    "forking",
    "installing",
    "warming",
    "running",
    "collecting",
    "gating",
    "reviewing",
    "done",
  ];
  // Interleave the order so the grid fills across contenders, not one row at a time.
  const order = [...trials].sort(
    (a, b) => a.repeat - b.repeat || a.workload_id.localeCompare(b.workload_id) || 0,
  );
  let reviewerAt = runningAt + 1000;
  let compN = 0;
  const queue = [...order];
  const attempts = new Map<string, number>();
  const notBefore = new Map<string, number>();
  while (queue.length) {
    const trial = queue.shift()!;
    slots.sort((a, b) => a - b);
    const start = Math.max(slots.shift()!, (notBefore.get(trial.id) ?? 0) + 150);
    const ci = contenders.findIndex((c) => c.id === trial.contender_id);
    const prof = PROFILE[ci % PROFILE.length]!;
    const attempt = (attempts.get(trial.id) ?? 0) + 1;
    attempts.set(trial.id, attempt);
    const tid = trial.id as string;
    const ev = (atMs: number, e: Record<string, unknown>) =>
      push(atMs, { source: "trial", source_id: tid, severity: "info", ...e });

    const work =
      (5200 + rand() * 6500) * prof.speed * (trial.workload_id === "bug-hunt" ? 1.25 : 1);
    const lens = [500, 900, 500, work, 500, 600, 700, 0];
    let at = start;
    let from: TrialState = "queued";
    const infraFail = attempt === 1 && rand() < 0.04;
    compN++;
    push(at, {
      type: "computer.created",
      source: "computer",
      source_id: uuid(5, compN),
      severity: "debug",
      payload: { provider: "naive", trial_id: tid, snapshot_id: "agent-cc-2026-11" },
    });
    let ended = false;
    let logOffset = 0;
    for (let p = 0; p < PHASES.length && !ended; p++) {
      const to = PHASES[p]!;
      if (to === "done") break;
      ev(at, { type: "trial.phase", payload: { from, to, attempt } });
      from = to;
      if (to === "warming")
        ev(at + 120, {
          type: "trial.network",
          payload: {
            allowed: { "api.anthropic.com": "ok", "registry.npmjs.org": "ok" },
            canary: "blocked",
            canary_url: "https://canary.anybench.dev/",
          },
        });
      if (to === "running") {
        if (infraFail) {
          at += lens[p]! * 0.4;
          ev(at, {
            type: "trial.phase",
            severity: "warn",
            payload: {
              from: "running",
              to: "failed_infra",
              attempt,
              reason: "computer lost heartbeat",
              failure_class: "infra",
            },
          });
          queue.push(trial);
          ended = true;
          break;
        }
        const beats = Math.max(1, Math.floor(lens[p]! / 1600));
        for (let b = 1; b <= beats; b++) {
          const bAt = at + (lens[p]! * b) / (beats + 1);
          const bytes = 2000 + Math.floor(rand() * 14000);
          ev(bAt, {
            type: "trial.log_chunk",
            severity: "debug",
            payload: {
              stream: "transcript",
              offset: logOffset,
              bytes,
              url: `https://r2.anybench.dev/logs/${tid}/${logOffset}`,
            },
          });
          logOffset += bytes;
          ev(bAt + 40, {
            type: "trial.heartbeat",
            severity: "debug",
            payload: {
              phase: "running",
              lease_owner: "worker-1",
              lease_until: new Date(startedAt + bAt + 90_000).toISOString(),
              log_offset: logOffset,
            },
          });
        }
      }
      if (to === "gating") {
        const passed = rand() < prof.pass;
        ev(at + lens[p]! * 0.8, {
          type: "trial.gate",
          severity: passed ? "info" : "warn",
          payload: passed
            ? {
                gate: "tests-pass",
                passed: true,
                summary: `${30 + Math.floor(rand() * 12)}/${30 + 12} hidden tests pass`,
              }
            : {
                gate: "tests-pass",
                passed: false,
                summary:
                  trial.workload_id === "bug-hunt"
                    ? "planted bug still reproduces"
                    : `${Math.floor(rand() * 8) + 2} hidden tests fail`,
              },
        });
        if (!passed) {
          at += lens[p]!;
          ev(at, {
            type: "trial.phase",
            severity: "warn",
            payload: {
              from: "gating",
              to: "failed_subject",
              attempt,
              reason: "correctness gate failed",
              failure_class: "gate",
            },
          });
          ended = true;
          break;
        }
      }
      if (to === "reviewing") {
        const rid = agentIds.get("reviewer")!;
        reviewerAt = Math.max(reviewerAt, at);
        drafts.push({
          atMs: at + 100,
          ev: {
            ...base,
            actor: { kind: "agent", id: rid },
            type: "agent.tool.started",
            source: "agent_session",
            source_id: rid,
            severity: "info",
            cost_delta_micro_usd: 4_000n,
            payload: {
              agent_role: "reviewer",
              naive_seq: compN,
              tool: "score",
              input_preview: `rubric · ${contenders[ci]!.name} · ${trial.workload_id} #${trial.repeat + 1}`,
            },
          } as Draft["ev"],
        });
      }
      at += lens[p]!;
    }
    if (!ended)
      ev(at, { type: "trial.phase", payload: { from: "reviewing", to: "done", attempt } });
    // ~$0.25 of compute per trial, recorded when the computer goes away.
    const cost = BigInt(180_000 + Math.floor(rand() * 140_000));
    push(at + 200, {
      type: "computer.destroyed",
      source: "computer",
      source_id: uuid(5, compN),
      severity: "debug",
      cost_delta_micro_usd: cost,
      payload: { provider: "naive", reason: "trial finished", trial_id: tid, blocks_billed: 3 },
    });
    if (infraFail) {
      // Retry after the backoff.
      const retryAt = at + 1500;
      ev(retryAt, {
        type: "trial.phase",
        payload: { from: "failed_infra", to: "queued", attempt: attempt + 1 },
      });
      notBefore.set(trial.id, retryAt);
    }
    slots.push(at + 300);
  }
  const trialsEnd = Math.max(...drafts.map((d) => d.atMs));

  // Spend alert part-way through, then acked.
  push(runningAt + (trialsEnd - runningAt) * 0.7, {
    type: "alert.fired",
    source: "alert",
    source_id: "run-spend-70",
    severity: "warn",
    payload: {
      rule_key: "run.spend_70",
      fingerprint: `run.spend_70:${runId}`,
      alert_severity: "warn",
      count: 1,
      message: "Run spend passed 70% of its cap",
    },
  });
  push(runningAt + (trialsEnd - runningAt) * 0.72, {
    type: "alert.acked",
    source: "alert",
    source_id: "run-spend-70",
    severity: "info",
    actor: { kind: "user", id: uuid(6, 1) },
    payload: { rule_key: "run.spend_70", acked_by: uuid(6, 1) },
  });

  t = trialsEnd + 800;
  runTo("scoring");
  t += 2200;
  runTo("analyzing");
  agentWork("investigator", t, 4200);
  agentWork("analyst", t + 2400, 3000);
  t += 6200;
  runTo("delivered");

  drafts.sort((a, b) => a.atMs - b.atMs);
  const timeline = drafts.map((d, i) => {
    const event = {
      ...d.ev,
      seq: i + 1,
      at: new Date(startedAt + Math.round(d.atMs)).toISOString(),
    } as AnybenchEvent;
    return { atMs: d.atMs, event };
  });

  return {
    snapshot: {
      run: {
        id: runId,
        question: "Does Tandem beat plain Claude Code, and do subagents close the gap?",
        state: "intake",
        budget_micro_usd: 25_000_000n,
        spent_micro_usd: 0n,
        estimate_micro_usd: 17_000_000n,
        created_at: new Date(startedAt).toISOString(),
      },
      contenders,
      trials,
      agents,
      alerts: [],
      lastSeq: 0,
    },
    timeline,
    durationMs: t,
  };
}

export const DEMO_SEVERITIES: EventSeverity[] = ["debug", "info", "warn", "error", "critical"];
