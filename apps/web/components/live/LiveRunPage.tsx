"use client";
// The live run page (plan.md section 6): the whole eval on one screen. Stage rail, counters,
// the trial matrix, every agent session, the activity feed, alerts, and drill-down drawers for
// any trial or agent (deep-linked with ?trial= / ?agent=). "/" or ⌘K searches everything.
//
// It shows counts and gate results only. Speed and quality numbers come from the report, after
// the correctness gate and the statistics (no number without a gate).
import { apiRoutes, type AlertId, type ApiClient } from "@anybench/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LiveApiContext, useLiveApi } from "../../lib/live/client";
import { countTrials, type FeedItem, type LiveRun, type SearchHit } from "../../lib/live/model";
import {
  describeApiError,
  useLiveRun,
  type LiveStatus,
  type UseLiveRunOptions,
} from "../../lib/live/useLiveRun";
import { ResultsPanel } from "../report/ResultsPanel";
import { ActivityFeed, type FeedState } from "./ActivityFeed";
import { AgentsPanel } from "./AgentsPanel";
import { Mark } from "../site/Mark";
import { CancelRun } from "./CancelRun";
import { AgentDrawer, TrialDrawer } from "./Drawers";
import { ms, span, usd } from "./format";
import styles from "./live.module.css";
import { PhaseRail, PhaseStage } from "./PhaseStage";
import { SearchPalette } from "./SearchPalette";
import { TrialMatrix, type GridFilter } from "./TrialMatrix";

type DrawerRef = { kind: "trial" | "agent"; id: string } | null;

function readDrawerFromUrl(): DrawerRef {
  if (typeof window === "undefined") return null;
  const p = new URLSearchParams(window.location.search);
  const trial = p.get("trial");
  if (trial) return { kind: "trial", id: trial };
  const agent = p.get("agent");
  if (agent) return { kind: "agent", id: agent };
  return null;
}

function writeDrawerToUrl(d: DrawerRef) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.delete("trial");
  url.searchParams.delete("agent");
  if (d) url.searchParams.set(d.kind, d.id);
  window.history.replaceState(window.history.state, "", url);
}

const RUN_STATE_WORD: Record<string, string> = {
  paused_budget: "paused: budget",
  needs_human: "needs you",
  failed: "failed",
  cancelled: "cancelled",
};

/**
 * The live run page. `client` defaults to the web app's API client (lib/api.ts); tests pass one
 * over a fake fetch.
 */
export function LiveRunPage({
  runId,
  client,
  options,
}: {
  runId: string;
  client?: ApiClient;
  options?: UseLiveRunOptions;
}) {
  return (
    <LiveApiContext.Provider value={client ?? null}>
      <LiveRunLoader runId={runId} options={options} />
    </LiveApiContext.Provider>
  );
}

function LiveRunLoader({ runId, options }: { runId: string; options?: UseLiveRunOptions }) {
  const { live, status, error } = useLiveRun(runId, options);

  if (!live) {
    return (
      <div className={styles.loading}>
        {status === "error" ? (
          <>
            <p className="eyebrow">Couldn’t open this run</p>
            <p role="alert">{error}</p>
          </>
        ) : (
          <>
            <p className="eyebrow">Connecting to the run…</p>
            {error ? <p role="status">{error} Retrying…</p> : null}
          </>
        )}
      </div>
    );
  }
  return <LiveRunView live={live} status={status} problem={error} />;
}

/** The page for a loaded run. Exported so tests can render it from a fixture. */
export function LiveRunView({
  live,
  status,
  problem = null,
  clockMs,
}: {
  live: LiveRun;
  status: LiveStatus;
  problem?: string | null;
  /** The page's "now" when it isn't the wall clock (the dev simulator's scaled clock). */
  clockMs?: number;
}) {
  const client = useLiveApi();
  const [ackProblem, setAckProblem] = useState<string | null>(null);
  const [filter, setFilter] = useState<GridFilter>("all");
  const [drawer, setDrawerState] = useState<DrawerRef>(null);
  const [palette, setPalette] = useState(false);
  const [focusSeq, setFocusSeq] = useState<number | null>(null);
  const [feed, setFeed] = useState<FeedState>({ query: "", sources: [], minSeverity: "info" });
  const [acked, setAcked] = useState<string[]>([]);
  const [wall, setWall] = useState(() => Date.now());

  // Deep links: open the drawer named in the URL once.
  useEffect(() => setDrawerState(readDrawerFromUrl()), []);
  const setDrawer = useCallback((d: DrawerRef) => {
    setDrawerState(d);
    writeDrawerToUrl(d);
  }, []);

  // A wall clock for elapsed time while the run is live.
  useEffect(() => {
    const id = window.setInterval(() => setWall(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const nowMs = status === "ended" ? ms(live.lastAt ?? live.createdAt) : (clockMs ?? wall);

  // Keyboard: "/" or ⌘K search, Esc closes the top layer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing =
        e.target instanceof HTMLElement &&
        (e.target.tagName === "INPUT" ||
          e.target.tagName === "TEXTAREA" ||
          e.target.tagName === "SELECT");
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        setPalette(true);
      } else if (e.key === "Escape") {
        if (palette) setPalette(false);
        else if (drawer) setDrawer(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [palette, drawer, setDrawer]);

  const counts = useMemo(() => countTrials(live), [live]);
  const elapsed = nowMs - ms(live.createdAt);
  const openTrial = useCallback((id: string) => setDrawer({ kind: "trial", id }), [setDrawer]);
  const openAgent = useCallback((id: string) => setDrawer({ kind: "agent", id }), [setDrawer]);
  const openSource = useCallback(
    (item: FeedItem) => {
      if (!item.sourceId) return;
      if (live.trials[item.sourceId]) openTrial(item.sourceId);
      else if (live.agents[item.sourceId]) openAgent(item.sourceId);
    },
    [live.trials, live.agents, openTrial, openAgent],
  );
  const pick = (hit: SearchHit) => {
    setPalette(false);
    if (hit.kind === "trial") openTrial(hit.id);
    else if (hit.kind === "agent") openAgent(hit.id);
    else {
      setFeed({ query: "", sources: [], minSeverity: "debug" });
      setFocusSeq(Number(hit.id));
    }
  };

  const openAlerts = live.alerts.filter((a) => a.status === "open" && !acked.includes(a.ruleKey));
  const ack = (ruleKey: string, id: string | null) => {
    setAcked((a) => [...a, ruleKey]);
    setAckProblem(null);
    // POST /alerts/:id/ack (idempotent). The id is the alert.fired event's source_id, or the
    // snapshot's row id. If the API refuses, the alert comes back and we say why.
    if (id) {
      void client.call(apiRoutes.alerts.ack, { params: { id: id as AlertId } }).catch((e) => {
        setAcked((a) => a.filter((k) => k !== ruleKey));
        setAckProblem(`Couldn't acknowledge the alert. ${describeApiError(e)}`);
      });
    }
  };

  const ended = status === "ended" || ["delivered", "failed", "cancelled"].includes(live.state);

  const chip = (tone: GridFilter, label: string, value: number, extra?: string) => (
    <button
      type="button"
      className={styles.counter}
      data-tone={tone}
      aria-pressed={filter === tone}
      onClick={() => setFilter((f) => (f === tone ? "all" : tone))}
      title={filter === tone ? "Show all trials" : `Highlight ${label}`}
    >
      <span className={styles.counterValue}>
        <span className="num">{value}</span>
        {extra ? <small className="num">{extra}</small> : null}
      </span>
      <span className={styles.counterLabel}>{label}</span>
    </button>
  );

  const drawerTrial = drawer?.kind === "trial" ? live.trials[drawer.id] : undefined;
  const drawerAgent = drawer?.kind === "agent" ? live.agents[drawer.id] : undefined;

  return (
    <div className={styles.page} data-drawer={drawer ? "open" : undefined}>
      {/* A one-screen monitor: the page never scrolls; the rail and the side pane scroll inside. */}
      <div className={styles.monitor}>
        <header className={styles.mTop}>
          <a href="/runs" className={styles.mHome} aria-label="Anybench: my runs" title="My runs">
            <Mark size={20} />
          </a>
          <p className={styles.topMeta}>
            <span className={styles.livePill} data-live={!ended || undefined}>
              <span className={styles.liveDot} aria-hidden="true" />
              {ended ? (RUN_STATE_WORD[live.state] ?? "ended") : "live"}
            </span>
            <span className="num">{span(elapsed)}</span>
            <span className={styles.sep}>·</span>
            <span className="num" data-testid="run-spend">
              {usd(live.spentMicroUsd)} spent of {usd(live.budgetMicroUsd, 0)}
              {live.estimateMicroUsd !== null ? ` · estimate ${usd(live.estimateMicroUsd)}` : ""}
            </span>
            <span className={styles.sep}>·</span>
            <span className="num">seq {live.lastSeq.toLocaleString("en-US")}</span>
            {RUN_STATE_WORD[live.state] && !ended ? (
              <span className={styles.holdPill}>{RUN_STATE_WORD[live.state]}</span>
            ) : null}
            {status === "reconnecting" || status === "error" ? (
              <span className={styles.holdPill} data-testid="stream-status">
                {status === "reconnecting" ? "reconnecting" : "offline"}
              </span>
            ) : null}
          </p>
          <h1 className={styles.question} title={live.question}>
            {live.question}
          </h1>
          <button type="button" className={styles.searchBtn} onClick={() => setPalette(true)}>
            <span>Search run</span>
            <kbd>/</kbd>
          </button>
        </header>

        {problem || ackProblem || openAlerts.length ? (
          <div className={styles.mAlerts}>
            {problem || ackProblem ? (
              <p className={styles.alert} data-sev="warn" role="status">
                <span className={styles.alertMsg}>{ackProblem ?? problem}</span>
              </p>
            ) : null}
            {openAlerts.map((a) => (
              <div key={a.ruleKey} className={styles.alert} data-sev={a.severity} role="alert">
                <span className={styles.alertSev}>{a.severity}</span>
                <span className={styles.alertMsg}>{a.message}</span>
                {a.count > 1 ? <span className="num">×{a.count}</span> : null}
                <button type="button" onClick={() => ack(a.ruleKey, a.id)}>
                  Acknowledge
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <aside className={styles.mRail}>
          <PhaseRail live={live} nowMs={nowMs} />
          {status !== "ended" && !["delivered", "failed", "cancelled"].includes(live.state) ? (
            <div className={styles.mCancel}>
              <CancelRun runId={live.runId} />
            </div>
          ) : null}
        </aside>

        <main className={styles.mCenter}>
          <PhaseStage live={live} nowMs={nowMs} ended={ended} onOpenTrial={openTrial} />
          {live.state === "failed" || live.state === "cancelled" ? (
            <ResultsPanel runId={live.runId} runState={live.state} holdReason={live.holdReason} />
          ) : null}
        </main>

        <aside className={styles.mSide} aria-label="Run details">
          <nav className={styles.mSideNav} aria-label="Jump to">
            <a href="#feed-h">Log</a>
            <a href="#matrix-h">Trials</a>
            <a href="#agents-h">Agents</a>
          </nav>
          <ActivityFeed
            live={live}
            state={feed}
            onState={(s) => {
              setFocusSeq(null);
              setFeed(s);
            }}
            focusSeq={focusSeq}
            onOpenSource={openSource}
            onClearFocus={() => setFocusSeq(null)}
          />
          <section className={styles.panel} aria-labelledby="matrix-h">
            <header className={styles.panelHead}>
              <h2 id="matrix-h" className={styles.panelTitle}>
                Trials
              </h2>
              <span className={styles.panelMeta}>
                {live.contenders.length} setups × {live.workloads.length} tasks × {live.repeats}{" "}
                runs
              </span>
            </header>
            <div className={styles.counters}>
              {chip("all", "trials done", counts.done, `/${counts.total}`)}
              {chip("active", "running now", counts.running)}
              {chip("passed", "passed gate", counts.passed)}
              {chip("failed", "failed", counts.failed)}
              {chip("infra", "our failures, not billed", counts.infra)}
            </div>
            <TrialMatrix
              live={live}
              filter={filter}
              selectedId={drawer?.kind === "trial" ? drawer.id : null}
              onOpen={openTrial}
            />
            <ul className={styles.legend} aria-label="Legend">
              <li data-tone="queued">queued</li>
              <li data-tone="active">running</li>
              <li data-tone="passed">passed gate</li>
              <li data-tone="failed">failed</li>
              <li data-tone="infra">our failure, not billed</li>
            </ul>
          </section>
          <AgentsPanel
            live={live}
            nowMs={nowMs}
            selectedId={drawer?.kind === "agent" ? drawer.id : null}
            onOpen={openAgent}
          />
        </aside>
      </div>

      {drawerTrial ? (
        <TrialDrawer
          key={drawerTrial.id}
          live={live}
          trial={drawerTrial}
          nowMs={nowMs}
          onClose={() => setDrawer(null)}
        />
      ) : null}
      {drawerAgent ? (
        <AgentDrawer
          key={drawerAgent.id}
          live={live}
          agent={drawerAgent}
          nowMs={nowMs}
          onClose={() => setDrawer(null)}
        />
      ) : null}
      {palette ? (
        <SearchPalette live={live} onPick={pick} onClose={() => setPalette(false)} />
      ) : null}
    </div>
  );
}
