// TDM-75 fixture: a recorded 60-trial run (4 setups × 3 workloads × 5 repeats) as the wire events
// the API's SSE stream would send, plus a fake API that serves a snapshot as of any seq and an SSE
// stream that honours Last-Event-ID. The fake folds events on its own (it does not use the page's
// model), so tests can check the page against it.
import {
  AnybenchEventSchema,
  formatSseFrame,
  type AnybenchEventInput,
  type RunState,
  type TrialState,
} from "@anybench/core";

export const uuid = (n: number) => `00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

export const RUN_ID = uuid(1);
export const ALERT_ID = uuid(0x300);
export const CAP_MICRO_USD = 120_000_000n;
export const ESTIMATE_MICRO_USD = 113_000_000n;
export const T0 = Date.parse("2026-11-07T10:00:00Z");

export const CONTENDERS = [
  { id: uuid(0x100), name: "Claude Code solo" },
  { id: uuid(0x101), name: "Claude Code + subagents" },
  { id: uuid(0x102), name: "Tandem ×3" },
  { id: uuid(0x103), name: "Tandem ×5" },
] as const;
export const WORKLOADS = ["auth-refactor", "bug-hunt", "todo-api"] as const;
export const REPEATS = 5;

export const AGENTS = {
  understander: uuid(0x200),
  researcher: uuid(0x201),
  kitDesigner: uuid(0x202),
  reviewer: uuid(0x203),
} as const;

export const EVIL_URL = "https://runner.evil.example/steal?token=abc";
export const EVIL_HTML = '<img src=x onerror="alert(1)"> <a href="https://evil.example">here</a>';

export interface TrialSlot {
  id: string;
  contenderId: string;
  workloadId: string;
  repeat: number;
}

export const TRIALS: TrialSlot[] = [];
for (const [ci, c] of CONTENDERS.entries())
  for (const [wi, w] of WORKLOADS.entries())
    for (let r = 0; r < REPEATS; r++)
      TRIALS.push({
        id: uuid(0x1000 + ci * 100 + wi * 10 + r),
        contenderId: c.id,
        workloadId: w,
        repeat: r,
      });

/** Special trial outcomes, by index into TRIALS. */
export const FAILED_SUBJECT = new Set([3, 22, 41]);
export const FAILED_INFRA_RETRIED = 10;
export const FAILED_INFRA_FINAL = 50;
export const CANCELLED = 59;
export const GATE_FAILED = new Set([14, 28]);

export interface Recording {
  events: AnybenchEventInput[];
  /** Seq checkpoints. */
  marks: Record<
    | "created"
    | "understand"
    | "research"
    | "kit"
    | "running"
    | "queued"
    | "wave1"
    | "alert"
    | "wave2"
    | "allTrials"
    | "end",
    number
  >;
  /** [start seq, end seq) per agent session. */
  agentSpans: Record<string, { role: string; start: number; end: number }>;
}

export function recordRun(): Recording {
  const events: AnybenchEventInput[] = [];
  const marks = {} as Recording["marks"];
  const agentSpans: Recording["agentSpans"] = {};
  let usageN = 0;
  const push = (
    e: Omit<AnybenchEventInput, "seq" | "at" | "run_id" | "actor" | "severity"> & {
      severity?: AnybenchEventInput["severity"];
    },
  ) => {
    const seq = events.length + 1;
    const ev = {
      run_id: RUN_ID,
      seq,
      at: new Date(T0 + seq * 10_000).toISOString(),
      actor: { kind: "worker", id: "worker-1" },
      severity: "info",
      ...e,
    } as AnybenchEventInput;
    AnybenchEventSchema.parse(ev); // the recording must be valid wire data
    events.push(ev);
    return seq;
  };
  const runTo = (from: RunState | null, to: RunState) =>
    push({ type: "run.state_changed", source: "run", source_id: RUN_ID, payload: { from, to } });
  const usage = (micro: bigint, trialId?: string) =>
    push({
      type: "usage.recorded",
      source: "ledger",
      source_id: uuid(0x5000 + usageN++),
      cost_delta_micro_usd: micro.toString(),
      payload: {
        user_id: uuid(0x900),
        kind: trialId ? "trial_fee" : "managed_tokens",
        amount_micro_usd: micro.toString(),
        ...(trialId ? { trial_id: trialId } : {}),
      },
    });
  const tool = (session: string, role: string, name: string, micro: bigint, n: number) =>
    push({
      type: "agent.tool.started",
      source: "agent_session",
      source_id: session,
      cost_delta_micro_usd: micro.toString(),
      payload: { agent_role: role, naive_seq: n, tool: name, input_preview: `${name} input` },
    });
  const phase = (
    t: TrialSlot,
    from: TrialState | null,
    to: TrialState,
    attempt = 1,
    reason?: string,
  ) =>
    push({
      type: "trial.phase",
      source: "trial",
      source_id: t.id,
      severity: to === "failed_subject" ? "warn" : to === "failed_infra" ? "warn" : "info",
      payload: { from, to, attempt, ...(reason ? { reason } : {}) },
    });

  marks.created = runTo(null, "intake");
  marks.understand = runTo("intake", "understand");
  agentSpans[AGENTS.understander] = { role: "understander", start: 0, end: 0 };
  agentSpans[AGENTS.understander]!.start = tool(
    AGENTS.understander,
    "understander",
    "Read",
    400_000n,
    1,
  );
  push({
    type: "agent.message",
    source: "agent_session",
    source_id: AGENTS.understander,
    payload: {
      agent_role: "understander",
      naive_seq: 2,
      message_role: "assistant",
      text: "The project is a task board for coding agents.",
    },
  });
  marks.research = runTo("understand", "research");
  agentSpans[AGENTS.understander]!.end = marks.research;
  agentSpans[AGENTS.researcher] = {
    role: "researcher",
    start: tool(AGENTS.researcher, "researcher", "WebSearch", 600_000n, 1),
    end: 0,
  };
  marks.kit = runTo("research", "kit_draft");
  agentSpans[AGENTS.researcher]!.end = marks.kit;
  agentSpans[AGENTS.kitDesigner] = {
    role: "kit designer",
    start: tool(AGENTS.kitDesigner, "kit designer", "Write", 1_200_000n, 1),
    end: 0,
  };
  const envBuild = runTo("kit_draft", "env_build");
  agentSpans[AGENTS.kitDesigner]!.end = envBuild;
  push({
    type: "computer.recipe",
    source: "computer",
    source_id: uuid(0x600),
    payload: { recipe: "node", version: "22", phase: "started" },
  });
  push({
    type: "computer.recipe",
    source: "computer",
    source_id: uuid(0x600),
    payload: { recipe: "node", version: "22", phase: "healthy" },
  });
  runTo("env_build", "proof");
  runTo("proof", "awaiting_go");
  marks.running = runTo("awaiting_go", "running");
  for (const t of TRIALS) phase(t, null, "queued");
  marks.queued = events.length;
  agentSpans[AGENTS.reviewer] = {
    role: "reviewer",
    start: tool(AGENTS.reviewer, "reviewer", "Read", 300_000n, 1),
    end: 0,
  };
  push({
    type: "agent.message",
    source: "agent_session",
    source_id: AGENTS.reviewer,
    payload: {
      agent_role: "reviewer",
      naive_seq: 2,
      message_role: "assistant",
      text: `<script>alert("x")</script> ${EVIL_HTML}`,
    },
  });

  const runTrial = (i: number, t: TrialSlot, attempt: number) => {
    if (i === CANCELLED) {
      phase(t, "queued", "cancelled", attempt, "run budget reached for this cell");
      return;
    }
    phase(t, "queued", "forking", attempt);
    phase(t, "forking", "installing", attempt);
    if ((i === FAILED_INFRA_RETRIED && attempt === 1) || i === FAILED_INFRA_FINAL) {
      phase(t, "installing", "failed_infra", attempt, "the computer lost its network");
      return;
    }
    phase(t, "installing", "warming", attempt);
    phase(t, "warming", "running", attempt);
    push({
      type: "trial.heartbeat",
      source: "trial",
      source_id: t.id,
      severity: "debug",
      payload: {
        phase: "running",
        lease_owner: "worker-1",
        lease_until: new Date(T0 + 3_600_000).toISOString(),
        log_offset: 100,
      },
    });
    if (i === 0)
      push({
        type: "trial.log_chunk",
        source: "trial",
        source_id: t.id,
        payload: { stream: "stdout", offset: 0, bytes: 4096, url: EVIL_URL },
      });
    if (FAILED_SUBJECT.has(i)) {
      phase(t, "running", "failed_subject", attempt, "the build failed");
      usage(1_850_000n, t.id);
      return;
    }
    phase(t, "running", "collecting", attempt);
    phase(t, "collecting", "gating", attempt);
    push({
      type: "trial.gate",
      source: "trial",
      source_id: t.id,
      payload: {
        gate: "hidden-tests",
        passed: !GATE_FAILED.has(i),
        summary: i === 0 ? `${EVIL_HTML} 42/42` : GATE_FAILED.has(i) ? "3 of 42 failed" : "42/42",
        ...(i === 0 ? { evidence_url: EVIL_URL } : {}),
      },
    });
    phase(t, "gating", "done", attempt);
    usage(1_850_000n, t.id);
  };

  const wave = (from: number, to: number) => {
    for (let i = from; i < to; i++) runTrial(i, TRIALS[i]!, 1);
  };
  wave(0, 15);
  // Retry the infra failure as attempt 2.
  phase(TRIALS[FAILED_INFRA_RETRIED]!, "failed_infra", "queued", 1);
  runTrial(FAILED_INFRA_RETRIED, TRIALS[FAILED_INFRA_RETRIED]!, 2);
  marks.wave1 = events.length;
  wave(15, 30);
  marks.alert = push({
    type: "alert.fired",
    source: "alert",
    source_id: ALERT_ID,
    severity: "error",
    payload: {
      rule_key: "trial_failures",
      fingerprint: `${RUN_ID}:trial_failures`,
      alert_severity: "critical",
      count: 1,
      message: "2 trials failed on the setup under test in the last 10 minutes",
    },
  });
  marks.wave2 = events.length;
  wave(30, 60);
  marks.allTrials = events.length;
  agentSpans[AGENTS.reviewer]!.end = marks.allTrials + 1;
  runTo("running", "scoring");
  runTo("scoring", "analyzing");
  marks.end = runTo("analyzing", "delivered");
  return { events, marks, agentSpans };
}

// ---------------------------------------------------------------------------------------------
// Folding the recording (the fake server's view)

export interface Fold {
  state: RunState;
  spent: bigint;
  trials: Map<string, { state: TrialState; attempt: number; cost: bigint }>;
  alertOpen: boolean;
}

export function fold(rec: Recording, upTo: number): Fold {
  const f: Fold = { state: "intake", spent: 0n, trials: new Map(), alertOpen: false };
  for (const e of rec.events) {
    if (e.seq > upTo) break;
    f.spent += BigInt(String(e.cost_delta_micro_usd ?? "0"));
    if (e.type === "run.state_changed") f.state = e.payload.to;
    if (e.type === "trial.phase" && e.source_id) {
      const cur = f.trials.get(e.source_id) ?? { state: "queued", attempt: 1, cost: 0n };
      f.trials.set(e.source_id, { ...cur, state: e.payload.to, attempt: e.payload.attempt });
    }
    if (e.type === "usage.recorded" && e.payload.trial_id) {
      const cur = f.trials.get(e.payload.trial_id);
      if (cur) cur.cost += BigInt(String(e.payload.amount_micro_usd));
    }
    if (e.type === "alert.fired") f.alertOpen = true;
    if (e.type === "alert.resolved") f.alertOpen = false;
  }
  return f;
}

export function expectedCounts(f: Fold) {
  const states = [...f.trials.values()].map((t) => t.state);
  const finished = states.filter((s) =>
    ["done", "failed_subject", "failed_infra", "cancelled"].includes(s),
  ).length;
  const queued = states.filter((s) => s === "queued").length;
  return {
    total: states.length,
    finished,
    queued,
    running: states.length - finished - queued,
  };
}

// ---------------------------------------------------------------------------------------------
// The fake API

export interface FakeRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export interface FakeApiOptions {
  /** Route ids that answer 404, like an API that hasn't shipped them yet. */
  missing?: ReadonlyArray<
    "trials.list" | "runs.contenders" | "events.list" | "alerts.ack" | "trials.log" | "trials.get"
  >;
}

export function createFakeApi(rec: Recording, initialSeq: number, opts: FakeApiOptions = {}) {
  const missing = new Set(opts.missing ?? []);
  let released = initialSeq;
  let acked = false;
  const requests: FakeRequest[] = [];
  const conns = new Set<{
    pump: () => void;
    fail: () => void;
    close: () => void;
  }>();
  const enc = new TextEncoder();
  const iso = (seq: number) => new Date(T0 + seq * 10_000).toISOString();

  function detail() {
    const f = fold(rec, released);
    const c = expectedCounts(f);
    const agents = Object.entries(rec.agentSpans)
      .filter(([, s]) => s.start > 0 && s.start <= released)
      .map(([id, s]) => ({
        id,
        run_id: RUN_ID,
        role: s.role,
        status: s.end > 0 && released >= s.end ? "done" : "running",
        budget_micro_usd: "5000000",
        cost_micro_usd: "0",
        last_tool: null,
        stop_reason: null,
        pending_action: null,
        started_at: iso(s.start),
        ended_at: s.end > 0 && released >= s.end ? iso(s.end) : null,
      }));
    const alertFired = released >= rec.marks.alert && f.alertOpen;
    return {
      run: {
        id: RUN_ID,
        project_id: null,
        question: "Does Tandem with 3 or 5 workers beat plain Claude Code with subagents?",
        state: f.state,
        budget_micro_usd: CAP_MICRO_USD.toString(),
        spent_micro_usd: f.spent.toString(),
        estimate_micro_usd: ESTIMATE_MICRO_USD.toString(),
        kit_id: null,
        paused_reason: null,
        cancel_requested_at: null,
        comped: false,
        created_at: iso(0),
        updated_at: iso(released),
      },
      counters: {
        trials_total: c.total,
        trials_done: c.finished,
        trials_running: c.running,
        trials_failed: 0,
        spent_micro_usd: f.spent.toString(),
        projected_micro_usd: ESTIMATE_MICRO_USD.toString(),
        elapsed_s: released * 10,
        eta_s: null,
        last_seq: released,
      },
      open_alerts: alertFired
        ? [
            {
              id: ALERT_ID,
              rule_key: "trial_failures",
              fingerprint: `${RUN_ID}:trial_failures`,
              run_id: RUN_ID,
              severity: "critical",
              status: acked ? "acked" : "open",
              message: "2 trials failed on the setup under test in the last 10 minutes",
              first_seen: iso(rec.marks.alert),
              last_seen: iso(rec.marks.alert),
              count: 1,
              acked_by: null,
              resolved_at: null,
              auto_action: null,
              payload: {},
            },
          ]
        : [],
      agents,
    };
  }

  function trialItems() {
    const f = fold(rec, released);
    return TRIALS.filter((t) => f.trials.has(t.id)).map((t) => {
      const s = f.trials.get(t.id)!;
      return {
        id: t.id,
        run_id: RUN_ID,
        contender_id: t.contenderId,
        workload_id: t.workloadId,
        repeat: t.repeat,
        attempt: s.attempt,
        state: s.state,
        failure_class: null,
        started_at: null,
        ended_at: null,
        cost_micro_usd: s.cost.toString(),
      };
    });
  }

  function stream(after: number, signal: AbortSignal | undefined): Response {
    let cursor = after;
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    let open = true;
    const conn = {
      pump() {
        if (!open) return;
        while (cursor < released && cursor < rec.events.length) {
          const e = rec.events[cursor]!;
          ctrl.enqueue(enc.encode(formatSseFrame({ id: String(e.seq), data: JSON.stringify(e) })));
          cursor++;
        }
        if (cursor >= rec.events.length) {
          ctrl.enqueue(
            enc.encode(
              formatSseFrame({
                event: "end",
                data: JSON.stringify({ state: "delivered", last_seq: rec.events.length }),
              }),
            ),
          );
          conn.close();
        }
      },
      fail() {
        if (!open) return;
        open = false;
        conns.delete(conn);
        ctrl.error(new TypeError("network connection was lost"));
      },
      close() {
        if (!open) return;
        open = false;
        conns.delete(conn);
        ctrl.close();
      },
    };
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
        c.enqueue(enc.encode("retry: 5\n\n: hello\n\n"));
        conns.add(conn);
        conn.pump();
      },
      cancel() {
        open = false;
        conns.delete(conn);
      },
    });
    signal?.addEventListener("abort", () => conn.fail(), { once: true });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const u = new URL(url);
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const method = init.method ?? "GET";
    requests.push({ method, path: u.pathname + u.search, headers });
    const p = u.pathname;
    const notFound = () =>
      json({ error: { code: "not_found", message: `no route ${method} ${p}` } }, 404);
    if (method === "GET" && p === `/runs/${RUN_ID}`) return json(detail());
    if (method === "GET" && p === `/runs/${RUN_ID}/trials`)
      return missing.has("trials.list")
        ? notFound()
        : json({ items: trialItems(), next_cursor: null });
    if (method === "GET" && p === `/runs/${RUN_ID}/events`) {
      if (missing.has("events.list")) return notFound();
      const after = Number(u.searchParams.get("after") ?? 0);
      const limit = Number(u.searchParams.get("limit") ?? 200);
      const types = u.searchParams.get("types")?.split(",");
      const all = rec.events.filter(
        (e) => e.seq > after && e.seq <= released && (!types || types.includes(e.type)),
      );
      const items = all.slice(0, limit);
      const more = all.length > limit;
      return json({ items, next_after: more ? items[items.length - 1]!.seq : null });
    }
    if (method === "GET" && p.startsWith("/trials/") && p.endsWith("/log")) {
      if (missing.has("trials.log")) return notFound();
      const tid = p.split("/")[2]!;
      const st = fold(rec, released).trials.get(tid)?.state;
      const final = st === "done" || st === "failed_subject" || st === "cancelled";
      const offset = Number(u.searchParams.get("offset") ?? 0);
      const text = offset === 0 ? `${EVIL_HTML}\nbuilding ${tid.slice(-4)}\n` : "";
      return json({ offset, next_offset: offset + text.length, text, eof: final });
    }
    if (method === "GET" && p.startsWith("/trials/")) return notFound();
    if (method === "GET" && p === `/runs/${RUN_ID}/contenders`)
      if (missing.has("runs.contenders")) return notFound();
    if (method === "GET" && p === `/runs/${RUN_ID}/contenders`)
      return json({
        items: CONTENDERS.map((c, i) => ({
          id: c.id,
          kit_id: null,
          name: c.name,
          role: i === 0 ? "baseline" : "subject",
          status: "kept",
          reason: null,
          found_by: null,
          spec: null,
        })),
      });
    if (method === "GET" && p === `/runs/${RUN_ID}/agents`) return json({ items: detail().agents });
    if (method === "GET" && p === `/runs/${RUN_ID}/stream`) {
      const last = headers["last-event-id"];
      const after = last !== undefined ? Number(last) : Number(u.searchParams.get("after") ?? 0);
      return stream(after, init.signal ?? undefined);
    }
    if (method === "POST" && p === `/alerts/${ALERT_ID}/ack`) {
      if (missing.has("alerts.ack")) return notFound();
      acked = true;
      const a = detail().open_alerts[0];
      return a
        ? json({ alert: { ...a, status: "acked" } })
        : json({ error: { code: "not_found", message: "no" } }, 404);
    }
    return json({ error: { code: "not_found", message: `no route ${method} ${p}` } }, 404);
  };

  return {
    fetch,
    requests,
    get released() {
      return released;
    },
    /** Make events up to `seq` available and push them to open streams. */
    release(seq: number) {
      released = Math.min(seq, rec.events.length);
      for (const c of [...conns]) c.pump();
    },
    /** Drop every open stream with a network error. */
    failStreams() {
      for (const c of [...conns]) c.fail();
    },
    /** Close every open stream cleanly without an end frame (Vercel max duration). */
    closeStreams() {
      for (const c of [...conns]) c.close();
    },
    openStreams: () => conns.size,
  };
}
