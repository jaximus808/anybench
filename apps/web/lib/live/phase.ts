// The live run page's "one phase at a time" view (TDM-199): pure selectors over a LiveRun. No
// React, no network, no clock of its own: callers pass `nowMs`, so every timer on the page is a
// real clock and every change is a real event.
//
// Counts only. No speed or quality number appears here: those come from the report, after the
// correctness gate and the statistics (plan.md 17.2).
import type { RunState, TrialState } from "@anybench/core";
import {
  countTrials,
  liveAgents,
  STAGES,
  stageIndex,
  tileTone,
  type LiveRun,
  type LiveTrial,
  type RunCounts,
} from "./model";

const t = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

/** Run states that pause or end the run: the page shows the reason, big. */
export type HoldState = "needs_human" | "paused_budget" | "failed" | "cancelled";
const HOLDS: readonly RunState[] = ["needs_human", "paused_budget", "failed", "cancelled"];

export interface PhaseRef {
  state: RunState;
  label: string;
  /** 1-based, the "§ 05" number. */
  n: number;
}

export interface DonePhase extends PhaseRef {
  /** null when the run was opened later and this phase's timing isn't in the history. */
  durationMs: number | null;
  /** One short line about what the phase produced, or null. */
  summary: string | null;
}

export interface PhaseView {
  current: PhaseRef & {
    /** When this phase began; null when unknown (opened mid-run without history). */
    startedAt: number | null;
    elapsedMs: number | null;
  };
  done: DonePhase[];
  /** The next happy phase, shown as a faint hint. Null at delivered or when held. */
  next: PhaseRef | null;
  hold: { state: HoldState; reason: string | null; at: number | null } | null;
  /** The run reached delivered. */
  delivered: boolean;
}

const ref = (i: number): PhaseRef => ({
  state: STAGES[i]!.state,
  label: STAGES[i]!.label,
  n: i + 1,
});

/**
 * Phase starts from the run's state history. Sorted by time; consecutive repeats collapse. The
 * snapshot's own entry is stamped with the run's created_at (model.initLive), so a non-intake
 * state at exactly created_at is "we don't know when it started".
 */
function phaseStarts(live: LiveRun): { state: RunState; at: number | null }[] {
  const created = t(live.createdAt);
  const sorted = live.stateHistory
    .map((h, i) => ({ ...h, i, ms: t(h.at) }))
    .sort((a, b) => a.ms - b.ms || a.i - b.i);
  const out: { state: RunState; at: number | null }[] = [];
  for (const h of sorted) {
    const unknown = h.ms === created && h.state !== "intake";
    // The snapshot's entry when the history also has the real transition: it marks nothing.
    if (unknown && sorted.some((x) => x.state === h.state && x.ms > created)) continue;
    if (out.length && out[out.length - 1]!.state === h.state) continue;
    out.push({ state: h.state, at: unknown ? null : h.ms });
  }
  return out;
}

export function phaseView(live: LiveRun, nowMs: number): PhaseView {
  const idx = stageIndex(live.state, live.stateHistory);
  const starts = phaseStarts(live);
  const held = HOLDS.includes(live.state) ? (live.state as HoldState) : null;

  const lastStart = (state: RunState): number | null => {
    for (let i = starts.length - 1; i >= 0; i--)
      if (starts[i]!.state === state) return starts[i]!.at;
    return null;
  };
  /** When `state` ended: the start of whatever came after its last run. */
  const endOf = (state: RunState): number | null => {
    for (let i = starts.length - 1; i >= 0; i--)
      if (starts[i]!.state === state) return starts[i + 1]?.at ?? null;
    return null;
  };

  const delivered = live.state === "delivered";
  const done: DonePhase[] = [];
  const doneUntil = delivered ? idx + 1 : idx;
  for (let i = 0; i < doneUntil; i++) {
    const p = ref(i);
    const s = lastStart(p.state);
    const e = endOf(p.state);
    done.push({
      ...p,
      durationMs: s !== null && e !== null && e >= s ? e - s : null,
      summary: phaseSummary(live, p.state),
    });
  }

  const startedAt = held ? lastStart(STAGES[idx]!.state) : lastStart(live.state);
  const holdAt = held ? lastStart(held) : null;
  // A held phase's clock stops when the hold began.
  const until = held ? (holdAt ?? nowMs) : nowMs;
  return {
    current: {
      ...ref(idx),
      startedAt,
      elapsedMs: startedAt === null ? null : Math.max(0, until - startedAt),
    },
    done,
    next: held || delivered || idx + 1 >= STAGES.length ? null : ref(idx + 1),
    hold: held ? { state: held, reason: live.holdReason, at: holdAt } : null,
    delivered,
  };
}

// ---------------------------------------------------------------------------------------------
// What the agents said, per phase

/** Agent roles that speak in each phase (real server roles first, simulator demo names after). */
export const PHASE_ROLES: Partial<Record<RunState, string[]>> = {
  intake: ["intake"],
  understand: ["understander"],
  research: ["researcher", "intake"],
  kit_draft: ["kit_designer", "kit designer"],
  env_build: ["env_builder"],
  proof: ["proof", "verifier"],
  running: ["reviewer"],
  scoring: ["reviewer"],
  analyzing: ["analyst", "investigator"],
};

export interface PhaseLine {
  seq: number;
  at: string;
  role: string;
  kind: "tool" | "message";
  text: string;
}

/** The agent lines for one phase, oldest first, newest last. */
export function phaseLog(live: LiveRun, state: RunState, limit = 50): PhaseLine[] {
  const roles = PHASE_ROLES[state] ?? [];
  const lines: PhaseLine[] = [];
  for (const a of liveAgents(live)) {
    if (!roles.includes(a.role)) continue;
    for (const x of a.activity)
      lines.push({ seq: x.seq, at: x.at, role: a.role, kind: x.kind, text: x.text });
  }
  lines.sort((a, b) => a.seq - b.seq);
  return lines.slice(-limit);
}

// ---------------------------------------------------------------------------------------------
// The image build (env_build), from env_builder lines (apps/server env-build.ts
// envBuildProgressText: "<image>: <text>")

export type EnvStepKey =
  "boot" | "toolchain" | "runner" | "kit" | "install" | "snapshot" | "cached" | "other";

export interface EnvStep {
  key: EnvStepKey;
  /** The server's words, without the image prefix. */
  label: string;
  at: string;
  seq: number;
}

export interface EnvImage {
  image: "trial" | "scoring";
  steps: EnvStep[];
  /** Capacity retries so far, and whether the image is waiting on one now. */
  retries: number;
  retrying: boolean;
  /** Snapshot saved (or reused from the cache). */
  done: boolean;
  /** Steps the server normally reports that haven't happened yet (a hint, never progress). */
  pending: EnvStepKey[];
  lastAt: string | null;
}

const ENV_EXPECTED: Record<EnvImage["image"], EnvStepKey[]> = {
  trial: ["boot", "toolchain", "runner", "kit", "install", "snapshot"],
  scoring: ["boot", "toolchain", "snapshot"],
};

export function classifyEnvLine(text: string): { key: EnvStepKey | "retry"; label: string } {
  const label = text.trim();
  if (/at capacity; retrying/i.test(label)) return { key: "retry", label };
  if (/^booted a na[iï]ve computer/i.test(label)) return { key: "boot", label };
  if (/^installed the base toolchain/i.test(label)) return { key: "toolchain", label };
  if (/^installed the anybench runner/i.test(label)) return { key: "runner", label };
  if (/^staged the kit files/i.test(label)) return { key: "kit", label };
  if (/^snapshot saved/i.test(label)) return { key: "snapshot", label };
  if (/already built.*reusing the snapshot/i.test(label)) return { key: "cached", label };
  if (/^installed /i.test(label)) return { key: "install", label };
  return { key: "other", label };
}

/** Split "scoring image: booted…" into the image and the line. No prefix means the trial image. */
function imageOf(text: string): { image: EnvImage["image"]; rest: string } {
  const m = /^(trial|scoring) image:\s*(.*)$/is.exec(text.trim());
  if (!m) return { image: "trial", rest: text.trim() };
  return { image: m[1]!.toLowerCase() as EnvImage["image"], rest: m[2]! };
}

export function envBuildSteps(live: LiveRun): EnvImage[] {
  const images: Record<EnvImage["image"], EnvImage> = {
    trial: {
      image: "trial",
      steps: [],
      retries: 0,
      retrying: false,
      done: false,
      pending: [],
      lastAt: null,
    },
    scoring: {
      image: "scoring",
      steps: [],
      retries: 0,
      retrying: false,
      done: false,
      pending: [],
      lastAt: null,
    },
  };
  for (const line of phaseLog(live, "env_build", 400)) {
    if (line.kind !== "message") continue;
    const { image, rest } = imageOf(line.text);
    const img = images[image];
    const c = classifyEnvLine(rest);
    img.lastAt = line.at;
    if (c.key === "retry") {
      img.retries++;
      img.retrying = true;
      continue;
    }
    img.retrying = false;
    img.steps.push({ key: c.key, label: c.label, at: line.at, seq: line.seq });
    if (c.key === "snapshot" || c.key === "cached") img.done = true;
  }
  for (const img of Object.values(images)) {
    const seen = new Set(img.steps.map((s) => s.key));
    img.pending = img.done ? [] : ENV_EXPECTED[img.image].filter((k) => !seen.has(k));
  }
  // The scoring image only shows once the server has said something about it.
  return [images.trial, ...(images.scoring.lastAt ? [images.scoring] : [])];
}

// ---------------------------------------------------------------------------------------------
// Running: the trials live now

export type TrialStage = "booting" | "running" | "grading";

export const TRIAL_STAGE: Partial<Record<TrialState, TrialStage>> = {
  forking: "booting",
  installing: "booting",
  warming: "booting",
  running: "running",
  collecting: "grading",
  gating: "grading",
  reviewing: "grading",
};

export interface LiveTrialCard {
  id: string;
  setup: string;
  task: string;
  repeat: number;
  attempt: number;
  state: TrialState;
  stage: TrialStage;
  startedAt: number | null;
  elapsedMs: number | null;
  /** Since the last heartbeat; null before the first one. */
  heartbeatAgeMs: number | null;
  heartbeatAt: string | null;
  costMicroUsd: bigint;
  logBytes: number;
}

export interface FinishedCard {
  id: string;
  setup: string;
  task: string;
  repeat: number;
  tone: "passed" | "failed" | "infra";
  endedAt: number;
}

export interface RunningView {
  live: LiveTrialCard[];
  /** Live trials beyond the cap (normally 0: the scheduler runs 5 at a time). */
  more: number;
  counts: RunCounts;
  /** Trials that ended within `recentMs` (newest first), for the resolve-out flash. */
  justFinished: FinishedCard[];
}

const setupName = (live: LiveRun, tr: LiveTrial) =>
  live.contenders.find((c) => c.id === tr.contenderId)?.name ?? "setup";

export function runningView(
  live: LiveRun,
  nowMs: number,
  opts: { cap?: number; recentMs?: number } = {},
): RunningView {
  const cap = opts.cap ?? 5;
  const recentMs = opts.recentMs ?? 4_000;
  const all = live.trialOrder.map((id) => live.trials[id]!);
  const active = all
    .filter((tr) => tileTone(tr) === "active")
    .sort((a, b) => (t(a.startedAt) || 0) - (t(b.startedAt) || 0));
  const cards = active.slice(0, cap).map((tr): LiveTrialCard => {
    const started = t(tr.startedAt);
    const beat = t(tr.heartbeatAt);
    return {
      id: tr.id,
      setup: setupName(live, tr),
      task: tr.workload,
      repeat: tr.repeat,
      attempt: tr.attempt,
      state: tr.state,
      stage: TRIAL_STAGE[tr.state] ?? "booting",
      startedAt: Number.isNaN(started) ? null : started,
      elapsedMs: Number.isNaN(started) ? null : Math.max(0, nowMs - started),
      heartbeatAgeMs: Number.isNaN(beat) ? null : Math.max(0, nowMs - beat),
      heartbeatAt: tr.heartbeatAt,
      costMicroUsd: tr.costMicroUsd,
      logBytes: tr.logBytes,
    };
  });
  const justFinished: FinishedCard[] = [];
  for (const tr of all) {
    const tone = tileTone(tr);
    if (tone !== "passed" && tone !== "failed" && tone !== "infra") continue;
    // An infra failure waiting for its retry has no endedAt cleared until requeued.
    const ended = t(tr.endedAt ?? tr.phaseAt);
    if (Number.isNaN(ended) || nowMs - ended > recentMs || ended > nowMs) continue;
    justFinished.push({
      id: tr.id,
      setup: setupName(live, tr),
      task: tr.workload,
      repeat: tr.repeat,
      tone,
      endedAt: ended,
    });
  }
  justFinished.sort((a, b) => b.endedAt - a.endedAt);
  return {
    live: cards,
    more: Math.max(0, active.length - cap),
    counts: countTrials(live),
    justFinished,
  };
}

// ---------------------------------------------------------------------------------------------
// One-line summaries for finished phases

function lastMessage(live: LiveRun, state: RunState): string | null {
  const lines = phaseLog(live, state).filter((l) => l.kind === "message");
  return lines.length ? lines[lines.length - 1]!.text : null;
}

const clip = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function phaseSummary(live: LiveRun, state: RunState): string | null {
  switch (state) {
    case "kit_draft": {
      const lines = phaseLog(live, "kit_draft").filter((l) => l.kind === "message");
      const profile = lines
        .map((l) => /^([\w-]+ profile: \d+ trials)/.exec(l.text)?.[1])
        .find(Boolean);
      return profile ?? (lines.length ? clip(lines[lines.length - 1]!.text) : null);
    }
    case "env_build": {
      const imgs = envBuildSteps(live);
      if (!imgs.some((i) => i.steps.length)) return null;
      const built = imgs.filter((i) => i.done).length;
      const retries = imgs.reduce((n, i) => n + i.retries, 0);
      return `${built} of ${imgs.length} image${imgs.length === 1 ? "" : "s"} ready${retries ? `, ${retries} capacity ${retries === 1 ? "retry" : "retries"}` : ""}`;
    }
    case "awaiting_go":
      return "started";
    case "running": {
      const c = countTrials(live);
      if (!c.total) return null;
      return `${c.total} trials: ${c.passed} passed, ${c.failed} failed${c.infra ? `, ${c.infra} ours` : ""}`;
    }
    case "intake":
    case "scoring":
    case "delivered":
      return null;
    default: {
      const m = lastMessage(live, state);
      return m ? clip(m) : null;
    }
  }
}
