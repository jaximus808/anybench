// The live run page's state: a snapshot (runs.get + trials.list + runs.contenders) folded with
// every AnybenchEvent from GET /runs/:id/stream (plan.md section 6). Pure: no React, no network,
// so the reducer is tested on its own and the landing-page demo reuses it with simulated events.
//
// Money stays integer micro-USD (bigint). Spend comes from each event's cost_delta_micro_usd,
// which is "the spend this event adds to the run" per the core event contract.
import type {
  AgentSession,
  Alert,
  AnybenchEvent,
  EventSeverity,
  EventSource,
  Run,
  RunState,
  Trial,
  TrialState,
} from "@anybench/core";

export interface LiveContender {
  id: string;
  name: string;
}

export interface LiveSnapshot {
  run: Pick<
    Run,
    | "id"
    | "question"
    | "state"
    | "budget_micro_usd"
    | "spent_micro_usd"
    | "estimate_micro_usd"
    | "created_at"
  >;
  contenders: LiveContender[];
  trials: Trial[];
  agents: AgentSession[];
  alerts: Alert[];
  lastSeq: number;
}

export interface LiveGate {
  gate: string;
  passed: boolean;
  summary: string | null;
}

export interface LiveTrial {
  id: string;
  contenderId: string;
  workload: string;
  repeat: number;
  attempt: number;
  state: TrialState;
  failureClass: string | null;
  startedAt: string | null;
  endedAt: string | null;
  phaseAt: string | null;
  heartbeatAt: string | null;
  costMicroUsd: bigint;
  gate: LiveGate | null;
  logBytes: number;
  /** Seqs of this trial's events, newest last (capped). */
  seqs: number[];
}

export type AgentActivityKind = "tool" | "message";

export interface LiveAgentActivity {
  seq: number;
  at: string;
  kind: AgentActivityKind;
  text: string;
}

export interface LiveAgent {
  id: string;
  role: string;
  status: AgentSession["status"];
  budgetMicroUsd: bigint;
  costMicroUsd: bigint;
  lastTool: string | null;
  lastMessage: string | null;
  toolCalls: number;
  startedAt: string | null;
  endedAt: string | null;
  lastAt: string | null;
  pending: AgentSession["pending_action"];
  activity: LiveAgentActivity[];
}

export interface FeedItem {
  seq: number;
  at: string;
  type: AnybenchEvent["type"];
  source: EventSource;
  sourceId: string | null;
  severity: EventSeverity;
  /** One line a person can read. */
  text: string;
  costMicroUsd: bigint;
  /** trial.phase only: the state the trial moved to (the drawer's phase timeline). */
  phaseTo: TrialState | null;
  /** agent events only: the agent's role. */
  role: string | null;
}

export interface LiveAlert {
  /** The alert row id when known (from the snapshot); alert.fired events don't carry it. */
  id: string | null;
  ruleKey: string;
  severity: "info" | "warn" | "critical" | "page";
  message: string;
  count: number;
  status: "open" | "acked";
  firstSeen: string;
}

export interface LiveRun {
  runId: string;
  question: string;
  state: RunState;
  budgetMicroUsd: bigint;
  spentMicroUsd: bigint;
  estimateMicroUsd: bigint | null;
  createdAt: string;
  contenders: LiveContender[];
  workloads: string[];
  repeats: number;
  trials: Record<string, LiveTrial>;
  trialOrder: string[];
  agents: Record<string, LiveAgent>;
  agentOrder: string[];
  feed: FeedItem[];
  alerts: LiveAlert[];
  stateHistory: { state: RunState; at: string }[];
  lastSeq: number;
  /** The newest event time seen; the page's clock when replaying. */
  lastAt: string | null;
  /** A trial event named a trial the snapshot didn't have: refetch trials.list. */
  needsTrialRefresh: boolean;
}

export const FEED_CAP = 5000;
const TRIAL_SEQ_CAP = 400;
const AGENT_ACTIVITY_CAP = 200;

export function trialFromApi(t: Trial): LiveTrial {
  return {
    id: t.id,
    contenderId: t.contender_id,
    workload: t.workload_id,
    repeat: t.repeat,
    attempt: t.attempt,
    state: t.state,
    failureClass: t.failure_class,
    startedAt: t.started_at,
    endedAt: t.ended_at,
    phaseAt: t.started_at,
    heartbeatAt: null,
    costMicroUsd: t.cost_micro_usd,
    gate: null,
    logBytes: 0,
    seqs: [],
  };
}

export function agentFromApi(a: AgentSession): LiveAgent {
  return {
    id: a.id,
    role: a.role,
    status: a.status,
    budgetMicroUsd: a.budget_micro_usd,
    costMicroUsd: a.cost_micro_usd,
    lastTool: a.last_tool,
    lastMessage: null,
    toolCalls: 0,
    startedAt: a.started_at,
    endedAt: a.ended_at,
    lastAt: a.started_at,
    pending: a.pending_action,
    activity: [],
  };
}

function orderTrials(trials: Record<string, LiveTrial>, contenders: LiveContender[]): string[] {
  const rank = new Map(contenders.map((c, i) => [c.id, i]));
  return Object.values(trials)
    .sort(
      (a, b) =>
        (rank.get(a.contenderId) ?? 999) - (rank.get(b.contenderId) ?? 999) ||
        a.workload.localeCompare(b.workload) ||
        a.repeat - b.repeat,
    )
    .map((t) => t.id);
}

function workloadsOf(trials: Iterable<LiveTrial>): string[] {
  const seen: string[] = [];
  for (const t of trials) if (!seen.includes(t.workload)) seen.push(t.workload);
  return seen;
}

export function initLive(s: LiveSnapshot): LiveRun {
  const trials: Record<string, LiveTrial> = {};
  for (const t of s.trials) trials[t.id] = trialFromApi(t);
  const agents: Record<string, LiveAgent> = {};
  for (const a of s.agents) agents[a.id] = agentFromApi(a);
  const repeats = s.trials.reduce((m, t) => Math.max(m, t.repeat + 1), 0);
  return {
    runId: s.run.id,
    question: s.run.question,
    state: s.run.state,
    budgetMicroUsd: s.run.budget_micro_usd,
    spentMicroUsd: s.run.spent_micro_usd,
    estimateMicroUsd: s.run.estimate_micro_usd,
    createdAt: s.run.created_at,
    contenders: s.contenders,
    workloads: workloadsOf(Object.values(trials)),
    repeats,
    trials,
    trialOrder: orderTrials(trials, s.contenders),
    agents,
    agentOrder: s.agents.map((a) => a.id),
    feed: [],
    alerts: s.alerts
      .filter((a) => a.status !== "resolved")
      .map((a) => ({
        id: a.id as string,
        ruleKey: a.rule_key,
        severity: a.severity,
        message: a.message,
        count: a.count,
        status: a.status === "acked" ? "acked" : "open",
        firstSeen: a.first_seen,
      })),
    stateHistory: [{ state: s.run.state, at: s.run.created_at }],
    lastSeq: s.lastSeq,
    lastAt: null,
    needsTrialRefresh: false,
  };
}

/** Add trials that appeared after the snapshot (from a trials.list refetch). */
export function mergeTrials(live: LiveRun, list: Trial[]): LiveRun {
  const trials = { ...live.trials };
  for (const t of list) if (!trials[t.id]) trials[t.id] = trialFromApi(t);
  const all = Object.values(trials);
  return {
    ...live,
    trials,
    trialOrder: orderTrials(trials, live.contenders),
    workloads: workloadsOf(all),
    repeats: all.reduce((m, t) => Math.max(m, t.repeat + 1), 0),
    needsTrialRefresh: false,
  };
}

const short = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A trial's human label: "tandem ×3 · auth-refactor #2". */
export function trialLabel(live: LiveRun, t: LiveTrial): string {
  const c = live.contenders.find((x) => x.id === t.contenderId)?.name ?? "contender";
  return `${c} · ${t.workload} #${t.repeat + 1}`;
}

export function describeEvent(live: LiveRun, ev: AnybenchEvent): string {
  const trial = ev.source_id ? live.trials[ev.source_id] : undefined;
  const who = trial ? trialLabel(live, trial) : null;
  const agent = ev.source_id ? live.agents[ev.source_id] : undefined;
  switch (ev.type) {
    case "run.state_changed":
      return `Run ${ev.payload.from ?? "created"} → ${ev.payload.to}${ev.payload.reason ? `: ${ev.payload.reason}` : ""}`;
    case "trial.phase":
      return `${who ?? "trial"}: ${ev.payload.to.replace("_", " ")}${ev.payload.reason ? ` (${ev.payload.reason})` : ""}${ev.payload.attempt > 1 ? `, attempt ${ev.payload.attempt}` : ""}`;
    case "trial.heartbeat":
      return `${who ?? "trial"}: heartbeat in ${ev.payload.phase}`;
    case "trial.log_chunk":
      return `${who ?? "trial"}: ${ev.payload.bytes.toLocaleString("en-US")} bytes of ${ev.payload.stream}`;
    case "trial.network":
      return `${who ?? "trial"}: network probe, canary ${ev.payload.canary}`;
    case "trial.gate":
      return `${who ?? "trial"}: gate ${ev.payload.gate} ${ev.payload.passed ? "passed" : "FAILED"}${ev.payload.summary ? ` (${ev.payload.summary})` : ""}`;
    case "agent.tool.started":
      return `${ev.payload.agent_role} → ${ev.payload.tool}${ev.payload.input_preview ? ` ${short(ev.payload.input_preview, 90)}` : ""}`;
    case "agent.message":
      return `${ev.payload.agent_role}: ${short(ev.payload.text)}`;
    case "computer.created":
      return `Computer up on ${ev.payload.provider}${ev.payload.trial_id && live.trials[ev.payload.trial_id] ? ` for ${trialLabel(live, live.trials[ev.payload.trial_id]!)}` : ""}`;
    case "computer.destroyed":
      return `Computer destroyed${ev.payload.reason ? `: ${ev.payload.reason}` : ""}`;
    case "computer.leaked":
      return `Leaked computer (${ev.payload.idle_s}s idle), ${ev.payload.action}`;
    case "computer.recipe":
      return `Recipe ${ev.payload.recipe}@${ev.payload.version} ${ev.payload.phase}${ev.payload.error ? `: ${ev.payload.error}` : ""}`;
    case "usage.recorded":
      return `Usage: ${ev.payload.kind.replace("_", " ")}${ev.payload.comped ? " (comped)" : ""}`;
    case "alert.fired":
      return `Alert ${ev.payload.alert_severity}: ${ev.payload.message}`;
    case "alert.acked":
      return `Alert ${ev.payload.rule_key} acknowledged`;
    case "alert.resolved":
      return `Alert ${ev.payload.rule_key} resolved`;
    case "billing.payment_failed":
      return "Payment failed";
    case "publish.version_created":
      return `Published ${ev.payload.slug} v${ev.payload.version}`;
    default: {
      void agent;
      return (ev as { type: string }).type;
    }
  }
}

function pushCapped<T>(arr: T[], item: T, cap: number): T[] {
  const next = arr.length >= cap ? arr.slice(arr.length - cap + 1) : arr.slice();
  next.push(item);
  return next;
}

function touchAgent(
  live: LiveRun,
  ev: Extract<AnybenchEvent, { type: "agent.tool.started" | "agent.message" }>,
): Pick<LiveRun, "agents" | "agentOrder"> {
  const id = ev.source_id ?? `role:${ev.payload.agent_role}`;
  const prev: LiveAgent = live.agents[id] ?? {
    id,
    role: ev.payload.agent_role,
    status: "running",
    budgetMicroUsd: 0n,
    costMicroUsd: 0n,
    lastTool: null,
    lastMessage: null,
    toolCalls: 0,
    startedAt: ev.at,
    endedAt: null,
    lastAt: null,
    pending: null,
    activity: [],
  };
  const isTool = ev.type === "agent.tool.started";
  const text = isTool
    ? `${ev.payload.tool}${ev.payload.input_preview ? ` ${ev.payload.input_preview}` : ""}`
    : ev.payload.text;
  const next: LiveAgent = {
    ...prev,
    status: prev.status === "queued" ? "running" : prev.status,
    lastTool: isTool ? ev.payload.tool : prev.lastTool,
    lastMessage: isTool ? prev.lastMessage : ev.payload.text,
    toolCalls: prev.toolCalls + (isTool ? 1 : 0),
    costMicroUsd: prev.costMicroUsd + ev.cost_delta_micro_usd,
    lastAt: ev.at,
    activity: pushCapped(
      prev.activity,
      { seq: ev.seq, at: ev.at, kind: isTool ? "tool" : "message", text },
      AGENT_ACTIVITY_CAP,
    ),
  };
  return {
    agents: { ...live.agents, [id]: next },
    agentOrder: live.agentOrder.includes(id) ? live.agentOrder : [...live.agentOrder, id],
  };
}

/** Fold one event into the run. Events at or below lastSeq are ignored (replay is idempotent). */
export function applyEvent(live: LiveRun, ev: AnybenchEvent): LiveRun {
  if (ev.seq <= live.lastSeq) return live;
  let next: LiveRun = {
    ...live,
    lastSeq: Math.max(live.lastSeq, ev.seq),
    lastAt: ev.at,
    spentMicroUsd: live.spentMicroUsd + ev.cost_delta_micro_usd,
  };

  const trialId =
    ev.source === "trial"
      ? ev.source_id
      : ev.type === "usage.recorded"
        ? (ev.payload.trial_id ?? null)
        : ev.type === "computer.created" || ev.type === "computer.destroyed"
          ? (ev.payload.trial_id ?? null)
          : null;
  const trial = trialId ? next.trials[trialId] : undefined;
  if (trialId && !trial && ev.source === "trial") next.needsTrialRefresh = true;

  if (trial) {
    const t: LiveTrial = {
      ...trial,
      seqs: pushCapped(trial.seqs, ev.seq, TRIAL_SEQ_CAP),
      costMicroUsd: trial.costMicroUsd + ev.cost_delta_micro_usd,
    };
    switch (ev.type) {
      case "trial.phase":
        t.state = ev.payload.to;
        t.attempt = ev.payload.attempt;
        t.phaseAt = ev.at;
        if (ev.payload.failure_class) t.failureClass = ev.payload.failure_class;
        if (ev.payload.to === "forking" && !t.startedAt) t.startedAt = ev.at;
        if (["done", "failed_infra", "failed_subject", "cancelled"].includes(ev.payload.to))
          t.endedAt = ev.at;
        if (ev.payload.to === "queued") {
          t.endedAt = null;
          t.gate = null;
        }
        break;
      case "trial.heartbeat":
        t.heartbeatAt = ev.at;
        break;
      case "trial.log_chunk":
        t.logBytes = Math.max(t.logBytes, ev.payload.offset + ev.payload.bytes);
        break;
      case "trial.gate":
        t.gate = {
          gate: ev.payload.gate,
          passed: ev.payload.passed,
          summary: ev.payload.summary ?? null,
        };
        break;
      default:
        break;
    }
    next.trials = { ...next.trials, [t.id]: t };
  }

  switch (ev.type) {
    case "run.state_changed":
      next.state = ev.payload.to;
      next.stateHistory = [...next.stateHistory, { state: ev.payload.to, at: ev.at }];
      break;
    case "agent.tool.started":
    case "agent.message":
      next = { ...next, ...touchAgent(next, ev) };
      break;
    case "alert.fired": {
      const prior = next.alerts.find((a) => a.ruleKey === ev.payload.rule_key);
      const rest = next.alerts.filter((a) => a.ruleKey !== ev.payload.rule_key);
      next.alerts = [
        ...rest,
        {
          id: prior?.id ?? null,
          ruleKey: ev.payload.rule_key,
          severity: ev.payload.alert_severity,
          message: ev.payload.message,
          count: ev.payload.count,
          status: "open",
          firstSeen: ev.at,
        },
      ];
      break;
    }
    case "alert.acked":
      next.alerts = next.alerts.map((a) =>
        a.ruleKey === ev.payload.rule_key ? { ...a, status: "acked" } : a,
      );
      break;
    case "alert.resolved":
      next.alerts = next.alerts.filter((a) => a.ruleKey !== ev.payload.rule_key);
      break;
    default:
      break;
  }

  // Heartbeats are noise in the feed; they still update the trial above.
  if (ev.type !== "trial.heartbeat") {
    next.feed = pushCapped(
      next.feed,
      {
        seq: ev.seq,
        at: ev.at,
        type: ev.type,
        source: ev.source,
        sourceId: ev.source_id,
        severity: ev.severity,
        text: describeEvent(next, ev),
        costMicroUsd: ev.cost_delta_micro_usd,
        phaseTo: ev.type === "trial.phase" ? ev.payload.to : null,
        role:
          ev.type === "agent.tool.started" || ev.type === "agent.message"
            ? ev.payload.agent_role
            : null,
      },
      FEED_CAP,
    );
  }
  return next;
}

export function applyEvents(live: LiveRun, events: AnybenchEvent[]): LiveRun {
  return events.reduce(applyEvent, live);
}

// ---------------------------------------------------------------------------------------------
// Derived views

export type TileTone = "queued" | "active" | "passed" | "failed" | "infra" | "cancelled";

export function tileTone(t: LiveTrial): TileTone {
  if (t.state === "done") return t.gate && !t.gate.passed ? "failed" : "passed";
  if (t.state === "failed_subject") return "failed";
  if (t.state === "failed_infra") return "infra";
  if (t.state === "cancelled") return "cancelled";
  if (t.state === "queued") return "queued";
  return "active";
}

export interface RunCounts {
  total: number;
  done: number;
  passed: number;
  failed: number;
  running: number;
  queued: number;
  infra: number;
}

export function countTrials(live: LiveRun): RunCounts {
  const c: RunCounts = { total: 0, done: 0, passed: 0, failed: 0, running: 0, queued: 0, infra: 0 };
  for (const id of live.trialOrder) {
    const tone = tileTone(live.trials[id]!);
    c.total++;
    if (tone === "passed") {
      c.passed++;
      c.done++;
    } else if (tone === "failed") {
      c.failed++;
      c.done++;
    } else if (tone === "infra") {
      // Waiting for its retry, so not done.
      c.infra++;
    } else if (tone === "cancelled") c.done++;
    else if (tone === "active") c.running++;
    else c.queued++;
  }
  return c;
}

export interface ContenderTally {
  contender: LiveContender;
  total: number;
  finished: number;
  passed: number;
  failed: number;
  running: number;
}

/**
 * Per-contender gate tally for the leaderboard strip. Only counts, never a speed or quality
 * number: those come from the report, after the gate and the statistics (plan.md 17.2).
 */
export function tallyByContender(live: LiveRun): ContenderTally[] {
  return live.contenders.map((contender) => {
    const tally: ContenderTally = {
      contender,
      total: 0,
      finished: 0,
      passed: 0,
      failed: 0,
      running: 0,
    };
    for (const id of live.trialOrder) {
      const t = live.trials[id]!;
      if (t.contenderId !== contender.id) continue;
      tally.total++;
      const tone = tileTone(t);
      if (tone === "passed") {
        tally.passed++;
        tally.finished++;
      } else if (tone === "failed") {
        tally.failed++;
        tally.finished++;
      } else if (tone === "active") tally.running++;
    }
    return tally;
  });
}

export function liveAgents(live: LiveRun): LiveAgent[] {
  return live.agentOrder.map((id) => live.agents[id]!).filter(Boolean);
}

export interface FeedFilter {
  query: string;
  sources: EventSource[];
  minSeverity: EventSeverity;
  sourceId?: string | null;
}

const SEV_RANK: Record<EventSeverity, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  critical: 4,
};

export function filterFeed(feed: FeedItem[], f: FeedFilter): FeedItem[] {
  const q = f.query.trim().toLowerCase();
  const min = SEV_RANK[f.minSeverity];
  return feed.filter(
    (item) =>
      SEV_RANK[item.severity] >= min &&
      (f.sources.length === 0 || f.sources.includes(item.source)) &&
      (!f.sourceId || item.sourceId === f.sourceId) &&
      (!q || item.text.toLowerCase().includes(q) || item.type.includes(q)),
  );
}

export interface SearchHit {
  kind: "trial" | "agent" | "event";
  id: string;
  label: string;
  detail: string;
}

/** The ⌘K / "/" search: trials, agents and events in one list. */
export function searchRun(live: LiveRun, query: string, limit = 30): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: SearchHit[] = [];
  for (const id of live.agentOrder) {
    const a = live.agents[id]!;
    if (`${a.role} ${a.lastTool ?? ""} ${a.status}`.toLowerCase().includes(q))
      hits.push({ kind: "agent", id, label: a.role, detail: `${a.status} · ${a.toolCalls} tools` });
  }
  for (const id of live.trialOrder) {
    const t = live.trials[id]!;
    const label = trialLabel(live, t);
    if (`${label} ${t.state} ${t.gate?.summary ?? ""}`.toLowerCase().includes(q))
      hits.push({ kind: "trial", id, label, detail: t.state.replace("_", " ") });
    if (hits.length >= limit) return hits;
  }
  for (let i = live.feed.length - 1; i >= 0 && hits.length < limit; i--) {
    const e = live.feed[i]!;
    if (e.text.toLowerCase().includes(q))
      hits.push({
        kind: "event",
        id: String(e.seq),
        label: e.text,
        detail: `#${e.seq} · ${e.type}`,
      });
  }
  return hits;
}

export const STAGES: { state: RunState; label: string }[] = [
  { state: "intake", label: "Intake" },
  { state: "understand", label: "Understand" },
  { state: "research", label: "Research" },
  { state: "kit_draft", label: "Kit" },
  { state: "env_build", label: "Computers" },
  { state: "proof", label: "Proof" },
  { state: "awaiting_go", label: "Go" },
  { state: "running", label: "Running" },
  { state: "scoring", label: "Scoring" },
  { state: "analyzing", label: "Analyzing" },
  { state: "delivered", label: "Delivered" },
];

export function stageIndex(state: RunState, history: { state: RunState }[]): number {
  const i = STAGES.findIndex((s) => s.state === state);
  if (i >= 0) return i;
  // Hold/terminal states (paused_budget, needs_human, failed, cancelled): the last happy stage.
  for (let h = history.length - 1; h >= 0; h--) {
    const j = STAGES.findIndex((s) => s.state === history[h]!.state);
    if (j >= 0) return j;
  }
  return 0;
}
