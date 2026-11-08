"use client";
// The live run page's hero (TDM-200): one phase on screen at a time, full width and big.
// Finished phases collapse to one "✓" line each above it; the next phase is a faint hint below.
// When run.state_changed moves the run on, the hero remounts (key = phase) and slides in, and the
// phase it replaced lands in the done list.
//
// Real data only: every line here is an event the run emitted, every timer is a real clock
// (`nowMs`), and nothing shows progress the run didn't report. Counts only, never a speed or
// quality number (those come from the report, after the gate and the statistics).
import type { RunState } from "@anybench/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { countTrials, STAGES, type LiveRun } from "../../lib/live/model";
import {
  envBuildSteps,
  phaseLog,
  phaseView,
  runningView,
  type EnvImage,
  type EnvStepKey,
  type PhaseLine,
  type PhaseView,
} from "../../lib/live/phase";
import { useLiveApi } from "../../lib/live/client";
import { SharePanel } from "../publish/SharePanel";
import { ResultsPanel } from "../report/ResultsPanel";
import { clock, span, usd } from "./format";
import { GoFailureText, useGoAction } from "./GoBar";
import styles from "./live.module.css";
import { useStableSlots } from "../../lib/live/slots";
import { Inspector } from "./Inspector";
import { PhaseFigure, type FocusTarget } from "./PhaseFigure";
import { RunningStage } from "./RunningStage";

/** What is really happening in each phase, in a sentence. */
const PHASE_WHAT: Partial<Record<RunState, string>> = {
  intake: "Reading your request and the repo.",
  understand: "Reading the repo to learn what it is and what “better” means for it.",
  research: "Picking the setups to compare it against.",
  kit_draft: "Designing the test: the tasks, the correctness gate and the repeats.",
  env_build: "Building the cloud computers every trial will start from.",
  proof: "Checking the test can tell a right answer from a wrong one.",
  awaiting_go: "The test plan is ready. Nothing runs, and nothing is billed, until you press Go.",
  running: "Every trial runs on its own Naïve computer, a few at a time.",
  scoring: "Grading every trial against its correctness gate.",
  analyzing: "Running the statistics. A difference only counts if it survives them.",
  delivered: "The verdict, with the evidence behind it.",
};

/** Who we're waiting on when a phase has nothing new to show yet. */
const PHASE_WAITING: Partial<Record<RunState, string>> = {
  intake: "the intake agent",
  understand: "the understander",
  research: "the researcher",
  kit_draft: "the kit designer",
  env_build: "Naïve to boot a computer",
  proof: "the proof checks",
  scoring: "the gates",
  analyzing: "the analyst",
};

const HOLD_WORD = {
  needs_human: "Needs you",
  paused_budget: "Paused: budget",
  failed: "Failed",
  cancelled: "Cancelled",
} as const;

const two = (n: number) => String(n).padStart(2, "0");

export function PhaseStage({
  live,
  nowMs,
  ended,
  onOpenTrial,
  viewing = null,
  onBackToLive,
}: {
  live: LiveRun;
  nowMs: number;
  ended: boolean;
  onOpenTrial: (id: string) => void;
  /** A finished phase the viewer picked in the rail; null watches the run live. */
  viewing?: RunState | null;
  onBackToLive?: () => void;
}) {
  const liveView = phaseView(live, nowMs);
  const past = viewing ? liveView.done.find((d) => d.state === viewing) : undefined;
  const reviewing = !!past && viewing !== liveView.current.state;
  // Looking back: the picked phase as it ended (its duration, not a running clock).
  const view: PhaseView =
    reviewing && past
      ? {
          current: { ...past, startedAt: null, elapsedMs: past.durationMs },
          done: liveView.done,
          next: null,
          hold: null,
          delivered: false,
        }
      : liveView;
  const key = reviewing
    ? `past:${viewing}`
    : view.hold
      ? `hold:${view.hold.state}`
      : view.current.state;
  const showFigure = !view.delivered;
  // One stable trial → bay assignment, shared by the figure's computers and the cards.
  const slots = useStableSlots(
    runningView(live, nowMs, { cap: 99 }).live.map((t) => t.id),
    5,
  );
  const hero = useRef<HTMLElement>(null);
  const [focus, setFocus] = useState<{
    target: FocusTarget;
    origin: { x: number; y: number };
  } | null>(null);
  // A new phase closes the inspector.
  useEffect(() => setFocus(null), [key]);
  const focusAt = useCallback((target: FocusTarget, at: { x: number; y: number }) => {
    const r = hero.current?.getBoundingClientRect();
    setFocus({ target, origin: r ? { x: at.x - r.left, y: at.y - r.top } : { x: 0, y: 0 } });
  }, []);
  const focusTrial = useCallback(
    (id: string, at?: { x: number; y: number }) =>
      at ? focusAt({ kind: "trial", id }, at) : onOpenTrial(id),
    [focusAt, onOpenTrial],
  );

  return (
    <article
      key={key}
      ref={hero}
      className={styles.hero}
      data-phase={view.current.state}
      data-hold={view.hold?.state}
      aria-live="polite"
      data-testid="phase-hero"
    >
      <span className={styles.heroPulse} aria-hidden="true" data-on={!ended || undefined} />
      <HeroHead
        view={view}
        live={live}
        nowMs={nowMs}
        reviewing={reviewing}
        liveLabel={liveView.hold ? HOLD_WORD[liveView.hold.state] : liveView.current.label}
        onBackToLive={onBackToLive}
      />
      {showFigure ? (
        <div className={styles.heroFigure}>
          <PhaseFigure
            live={live}
            view={view}
            nowMs={nowMs}
            active={!ended && !view.hold && !reviewing}
            onFocus={focusAt}
            slots={slots}
          />
        </div>
      ) : null}
      <div className={styles.heroBody} data-fill={!showFigure || undefined}>
        {view.hold ? (
          <HoldBody view={view} />
        ) : (
          <PhaseBody live={live} view={view} nowMs={nowMs} onOpenTrial={focusTrial} slots={slots} />
        )}
      </div>
      {focus ? (
        <Inspector
          live={live}
          nowMs={nowMs}
          target={focus.target}
          origin={focus.origin}
          onClose={() => setFocus(null)}
          onOpenTrial={(id) => {
            setFocus(null);
            onOpenTrial(id);
          }}
        />
      ) : null}
    </article>
  );
}

/** The phase that just finished, for one beat of highlight in the rail. */
function useLanded(view: PhaseView): RunState | null {
  const prev = useRef<RunState | null>(null);
  const [landed, setLanded] = useState<RunState | null>(null);
  const now = view.current.state;
  useEffect(() => {
    const before = prev.current;
    prev.current = now;
    if (!before || before === now) return;
    setLanded(before);
    const id = window.setTimeout(() => setLanded(null), 1600);
    return () => window.clearTimeout(id);
  }, [now]);
  return landed;
}

/**
 * Every phase as one line: finished ones with ✓, how long they took and what they produced; the
 * current one live with its clock; later ones dim. Held runs mark where they stopped.
 */
export function PhaseRail({
  live,
  nowMs,
  viewing = null,
  onSelect,
}: {
  live: LiveRun;
  nowMs: number;
  /** The finished phase being looked at, or null when watching live. */
  viewing?: RunState | null;
  /** Pick a phase: a finished one to look back at, the current one to watch live again. */
  onSelect?: (state: RunState, isCurrent: boolean) => void;
}) {
  const view = phaseView(live, nowMs);
  const landed = useLanded(view);
  const done = new Map(view.done.map((d) => [d.state, d]));
  return (
    <ol className={styles.rail} aria-label="Run phases" data-testid="phase-rail">
      {STAGES.map((st, i) => {
        const d = done.get(st.state);
        const now = !d && i + 1 === view.current.n;
        const state = d ? "done" : now ? (view.hold ? "held" : "now") : "todo";
        return (
          <li
            key={st.state}
            data-state={state}
            data-landed={st.state === landed || undefined}
            data-viewing={(viewing ? viewing === st.state : now) || undefined}
            aria-current={now ? "step" : undefined}
            onClick={d || now ? () => onSelect?.(st.state, now) : undefined}
            onKeyDown={
              d || now
                ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect?.(st.state, now);
                    }
                  }
                : undefined
            }
            role={onSelect && (d || now) ? "button" : undefined}
            tabIndex={onSelect && (d || now) ? 0 : undefined}
            title={d ? `Look back at ${st.label}` : now ? "Watch live" : undefined}
          >
            <span className={styles.railMark} aria-hidden="true">
              {d ? "✓" : now ? (view.hold ? "!" : "") : ""}
            </span>
            <span className={styles.railN}>{two(i + 1)}</span>
            <span className={styles.railLabel}>{st.label}</span>
            <span className={`num ${styles.railTime}`}>
              {d
                ? d.durationMs === null
                  ? ""
                  : span(d.durationMs)
                : now && view.current.elapsedMs !== null
                  ? clock(view.current.elapsedMs)
                  : ""}
            </span>
            {d?.summary ? <span className={styles.railSummary}>{d.summary}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

function HeroHead({
  view,
  live,
  nowMs,
  reviewing = false,
  liveLabel,
  onBackToLive,
}: {
  view: PhaseView;
  live: LiveRun;
  nowMs: number;
  reviewing?: boolean;
  liveLabel?: string;
  onBackToLive?: () => void;
}) {
  const c = view.current;
  const runMs = nowMs - Date.parse(live.createdAt);
  const timer = c.elapsedMs ?? runMs;
  return (
    <header className={styles.heroHead}>
      <p className={styles.heroKicker}>
        <span className="num">§ {two(c.n)}</span>
        <span className={styles.heroOf}>of {two(11)}</span>
        {reviewing ? (
          <>
            <span className={styles.heroDoneTag}>done · looking back</span>
            {onBackToLive ? (
              <button type="button" className={styles.backToLive} onClick={onBackToLive}>
                <i aria-hidden="true" />
                Back to live{liveLabel ? `: ${liveLabel}` : ""}
              </button>
            ) : null}
          </>
        ) : view.hold ? (
          <span className={styles.heroHoldTag}>{HOLD_WORD[view.hold.state]}</span>
        ) : view.delivered ? (
          <span className={styles.heroDoneTag}>done</span>
        ) : (
          <span className={styles.heroNowTag}>
            <i aria-hidden="true" />
            now
          </span>
        )}
      </p>
      <h2 className={styles.heroTitle}>{view.hold ? HOLD_WORD[view.hold.state] : c.label}</h2>
      <p className={styles.heroWhat}>
        {view.hold ? `Stopped at ${two(c.n)} ${c.label}.` : PHASE_WHAT[c.state]}
      </p>
      {view.delivered ? null : (
        <p className={styles.heroClock}>
          <span className="num" data-testid="phase-clock">
            {reviewing && c.elapsedMs === null ? "–" : clock(timer)}
          </span>
          <small>
            {reviewing
              ? "it took"
              : view.hold
                ? "before it stopped"
                : c.elapsedMs === null
                  ? "run time"
                  : "in this phase"}
          </small>
        </p>
      )}
    </header>
  );
}

function HoldBody({ view }: { view: PhaseView }) {
  const h = view.hold!;
  return (
    <div className={styles.holdBody} role="alert" data-testid="phase-hold">
      <p className={styles.holdReason}>
        {h.reason ??
          (h.state === "needs_human"
            ? "The run stopped and needs a person to look at it."
            : h.state === "cancelled"
              ? "The run was cancelled."
              : "The run stopped.")}
      </p>
      {h.state === "failed" || h.state === "cancelled" ? (
        <p className={styles.holdNote}>
          Our failures are never billed. Computers for this run are shut down.
        </p>
      ) : null}
    </div>
  );
}

function PhaseBody({
  live,
  view,
  nowMs,
  onOpenTrial,
  slots,
  reviewing = false,
}: {
  live: LiveRun;
  view: PhaseView;
  nowMs: number;
  onOpenTrial: (id: string, at?: { x: number; y: number }) => void;
  slots: (string | null)[];
  reviewing?: boolean;
}) {
  switch (view.current.state) {
    case "env_build":
      return <EnvBuildBody live={live} nowMs={nowMs} />;
    case "awaiting_go":
      return <GoBody live={live} reviewing={reviewing} />;
    case "running":
      return <RunningStage live={live} nowMs={nowMs} onOpenTrial={onOpenTrial} slots={slots} />;
    case "delivered":
      return <DeliveredBody live={live} />;
    default:
      return <AgentStream live={live} state={view.current.state} nowMs={nowMs} />;
  }
}

// ---- delivered: share the result, then the results --------------------------------------------

function DeliveredBody({ live }: { live: LiveRun }) {
  const client = useLiveApi();
  return (
    <>
      <SharePanel runId={live.runId} runState={live.state} client={client} />
      <ResultsPanel runId={live.runId} runState={live.state} holdReason={live.holdReason} />
    </>
  );
}

// ---- agent phases: streaming lines --------------------------------------------------------

function AgentStream({ live, state, nowMs }: { live: LiveRun; state: RunState; nowMs: number }) {
  const lines = phaseLog(live, state, 8);
  if (!lines.length)
    return (
      <p className={styles.streamWait} data-testid="phase-waiting">
        Waiting on {PHASE_WAITING[state] ?? "the run"}
        <span className={styles.caret} aria-hidden="true" />
      </p>
    );
  return <Stream lines={lines} nowMs={nowMs} />;
}

function Stream({ lines, nowMs }: { lines: PhaseLine[]; nowMs: number }) {
  const last = lines[lines.length - 1]!;
  return (
    <div className={styles.stream}>
      <ol className={styles.streamLines} data-testid="phase-lines">
        {lines.map((l, i) => (
          <li
            key={l.seq}
            data-kind={l.kind}
            data-age={Math.min(4, lines.length - 1 - i)}
            style={{ "--chars": Math.min(l.text.length, 160) } as React.CSSProperties}
          >
            <span className={styles.streamRole}>{l.kind === "tool" ? "→" : l.role}</span>
            <span className={styles.streamText}>{l.text}</span>
          </li>
        ))}
      </ol>
      <p className={styles.streamMeta}>
        last line <span className="num">{span(nowMs - Date.parse(last.at))}</span> ago
        <span className={styles.caret} aria-hidden="true" />
      </p>
    </div>
  );
}

// ---- env_build: two image tracks ----------------------------------------------------------

const STEP_WORD: Record<EnvStepKey, string> = {
  boot: "boot",
  toolchain: "toolchain",
  runner: "runner",
  kit: "kit files",
  install: "contenders",
  snapshot: "snapshot",
  cached: "cached",
  other: "step",
};

function EnvBuildBody({ live, nowMs }: { live: LiveRun; nowMs: number }) {
  const images = envBuildSteps(live);
  return (
    <div className={styles.envTracks} data-testid="env-tracks">
      {images.map((img) => (
        <EnvTrack key={img.image} img={img} nowMs={nowMs} />
      ))}
    </div>
  );
}

function EnvTrack({ img, nowMs }: { img: EnvImage; nowMs: number }) {
  const latest = img.steps[img.steps.length - 1];
  const nextKey = img.pending[0];
  return (
    <section
      className={styles.envTrack}
      data-done={img.done || undefined}
      data-retrying={img.retrying || undefined}
      aria-label={`${img.image} image`}
      data-testid={`env-${img.image}`}
    >
      <header className={styles.envHead}>
        <h3>{img.image === "trial" ? "Trial image" : "Scoring image"}</h3>
        <span className={styles.envState}>
          {img.done ? "ready" : img.retrying ? "waiting on Naïve" : "building"}
        </span>
      </header>
      <ol className={styles.envSteps}>
        {img.steps.map((s) => (
          <li key={s.seq} data-state="done" title={s.label}>
            <i aria-hidden="true" />
            <span>
              {s.key === "install" ? s.label.replace(/^installed /i, "") : STEP_WORD[s.key]}
            </span>
          </li>
        ))}
        {img.pending.map((k, i) => (
          <li key={k} data-state={i === 0 ? "now" : "todo"}>
            <i aria-hidden="true" />
            <span>{STEP_WORD[k]}</span>
          </li>
        ))}
      </ol>
      {img.retrying ? (
        <p className={styles.envRetry} role="status">
          Naïve is at capacity; retrying
          {img.retries > 1 ? <span className="num"> (attempt {img.retries + 1})</span> : null}
        </p>
      ) : (
        <p className={styles.envLatest}>
          {latest ? latest.label : "asking Naïve for a computer"}
          {!img.done && nextKey && latest ? (
            <span className={styles.envNext}> · next: {STEP_WORD[nextKey]}</span>
          ) : null}
        </p>
      )}
      {!img.done && img.lastAt ? (
        <p className={styles.envAgo}>
          last update <span className="num">{span(nowMs - Date.parse(img.lastAt))}</span> ago
        </p>
      ) : null}
    </section>
  );
}

// ---- awaiting_go: the big moment -----------------------------------------------------------

/** The plan's trial count: the trials list when the API has it, else the kit designer's line. */
function plannedTrials(live: LiveRun): number | null {
  const n = countTrials(live).total;
  if (n) return n;
  for (const l of phaseLog(live, "kit_draft").reverse()) {
    const m = /(\d+) trials/.exec(l.text);
    if (m) return Number(m[1]);
  }
  return null;
}

function GoBody({ live, reviewing = false }: { live: LiveRun; reviewing?: boolean }) {
  const { busy, started, failure, go } = useGoAction(live.runId);
  const trials = plannedTrials(live);
  const setups = live.contenders.filter((c) => c.id !== "unplaced");
  const tasks = live.workloads.filter((w) => w !== "unplaced");
  return (
    <div className={styles.goBody} data-slot="go-hero">
      <dl className={styles.goPlan}>
        <div>
          <dt>trials</dt>
          <dd className="num">{trials ?? "–"}</dd>
        </div>
        <div>
          <dt>setups</dt>
          <dd className="num">{setups.length || "–"}</dd>
        </div>
        <div>
          <dt>tasks</dt>
          <dd className="num">{tasks.length || "–"}</dd>
        </div>
        <div>
          <dt>repeats</dt>
          <dd className="num">{live.repeats || "–"}</dd>
        </div>
        <div>
          <dt>estimated cost</dt>
          <dd className="num">
            {live.estimateMicroUsd !== null ? usd(live.estimateMicroUsd) : "–"}
          </dd>
        </div>
      </dl>
      {setups.length || tasks.length ? (
        <div className={styles.goWho}>
          {setups.length ? (
            <p>
              <span>setups</span> {setups.map((s) => s.name).join(" vs ")}
            </p>
          ) : null}
          {tasks.length ? (
            <p>
              <span>tasks</span> {tasks.join(" · ")}
            </p>
          ) : null}
        </div>
      ) : null}
      {reviewing ? (
        <p className={styles.goNote}>Go was pressed and the run started.</p>
      ) : (
        <div className={styles.goAction}>
          <button
            type="button"
            className={styles.goButton}
            onClick={() => void go()}
            disabled={busy || started}
            data-testid="go-button"
          >
            {started ? "Starting…" : busy ? "Starting…" : "Go"}
          </button>
          <p className={styles.goNote} role="status">
            {started ? (
              "Starting the run…"
            ) : failure ? (
              <GoFailureText failure={failure} />
            ) : (
              <>
                Cap <span className="num">{usd(live.budgetMicroUsd, 0)}</span>. Failures that are
                ours are never billed.
              </>
            )}
          </p>
        </div>
      )}
    </div>
  );
}
