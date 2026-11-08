"use client";
// The activity feed: every event as one line, newest at the bottom. It follows the tail until
// you scroll up, then counts what you missed and offers "jump to live" (the deploy-log pattern).
import type { EventSeverity, EventSource } from "@anybench/core";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { filterFeed, type FeedItem, type LiveRun } from "../../lib/live/model";
import { clock, ms, usdSmall } from "./format";
import styles from "./live.module.css";

export const FEED_SOURCES: { source: EventSource; label: string }[] = [
  { source: "run", label: "run" },
  { source: "trial", label: "trials" },
  { source: "agent_session", label: "agents" },
  { source: "computer", label: "computers" },
  { source: "ledger", label: "spend" },
  { source: "alert", label: "alerts" },
];

const SOURCE_TAG: Partial<Record<EventSource, string>> = {
  run: "RUN",
  trial: "TRL",
  agent_session: "AGT",
  computer: "CMP",
  ledger: "USD",
  alert: "ALR",
  billing: "BIL",
  publish: "PUB",
  system: "SYS",
};

/** Rows rendered at once; older matches stay searchable but aren't in the DOM. */
export const FEED_WINDOW = 300;

export interface FeedState {
  query: string;
  sources: EventSource[];
  minSeverity: EventSeverity;
}

export const ActivityFeed = memo(function ActivityFeed({
  live,
  state,
  onState,
  focusSeq,
  onOpenSource,
  onClearFocus,
}: {
  live: LiveRun;
  state: FeedState;
  onState: (s: FeedState) => void;
  focusSeq: number | null;
  onOpenSource: (item: FeedItem) => void;
  onClearFocus: () => void;
}) {
  const matching = useMemo(() => filterFeed(live.feed, state), [live.feed, state]);
  const rows = matching.length > FEED_WINDOW ? matching.slice(-FEED_WINDOW) : matching;
  const hidden = matching.length - rows.length;
  const box = useRef<HTMLOListElement>(null);
  const [follow, setFollow] = useState(true);
  const [seenSeq, setSeenSeq] = useState(0);
  const lastSeq = rows[rows.length - 1]?.seq ?? 0;
  const missed = follow ? 0 : rows.filter((r) => r.seq > seenSeq).length;
  const start = ms(live.createdAt);

  useLayoutEffect(() => {
    const el = box.current;
    if (el && follow && focusSeq === null) el.scrollTop = el.scrollHeight;
  }, [lastSeq, follow, focusSeq]);

  useEffect(() => {
    if (focusSeq === null) return;
    setFollow(false);
    const row = box.current?.querySelector<HTMLElement>(`[data-seq="${focusSeq}"]`);
    row?.scrollIntoView?.({ block: "center" });
  }, [focusSeq]);

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom !== follow) {
      setFollow(atBottom);
      if (!atBottom) setSeenSeq(lastSeq);
    }
  };

  const toggleSource = (s: EventSource) =>
    onState({
      ...state,
      sources: state.sources.includes(s)
        ? state.sources.filter((x) => x !== s)
        : [...state.sources, s],
    });

  return (
    <section className={`${styles.panel} ${styles.feedPanel}`} aria-labelledby="feed-h">
      <header className={styles.panelHead}>
        <h2 id="feed-h" className={styles.panelTitle}>
          Activity
        </h2>
        <span className={styles.panelMeta}>
          <span className="num">{matching.length.toLocaleString("en-US")}</span> events
        </span>
      </header>
      <div className={styles.feedTools}>
        <label className={styles.feedSearch}>
          <span className="visually-hidden">Filter activity</span>
          <input
            type="search"
            placeholder="Filter: gate, tandem ×5, researcher…"
            value={state.query}
            onChange={(e) => onState({ ...state, query: e.target.value })}
          />
        </label>
        <label className={styles.sevSelect}>
          <span className="visually-hidden">Minimum severity</span>
          <select
            value={state.minSeverity}
            onChange={(e) => onState({ ...state, minSeverity: e.target.value as EventSeverity })}
          >
            <option value="debug">all levels</option>
            <option value="info">info +</option>
            <option value="warn">warn +</option>
            <option value="error">error +</option>
          </select>
        </label>
        <div className={styles.chips} role="group" aria-label="Sources">
          {FEED_SOURCES.map(({ source, label }) => (
            <button
              key={source}
              type="button"
              className={styles.chip}
              aria-pressed={state.sources.includes(source)}
              onClick={() => toggleSource(source)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <ol className={styles.feed} ref={box} onScroll={onScroll} aria-live="off">
        {hidden > 0 ? (
          <li className={styles.feedMore}>
            {hidden.toLocaleString("en-US")} earlier events match; narrow the filter to see them
          </li>
        ) : null}
        {rows.length === 0 ? <li className={styles.feedEmpty}>No events match.</li> : null}
        {rows.map((item) => {
          const clickable =
            !!item.sourceId && (!!live.trials[item.sourceId] || !!live.agents[item.sourceId]);
          return (
            <li
              key={item.seq}
              data-seq={item.seq}
              data-sev={item.severity}
              data-focus={focusSeq === item.seq || undefined}
              className={styles.feedRow}
            >
              <span className={`num ${styles.feedTime}`}>{clock(ms(item.at) - start)}</span>
              <span className={styles.feedTag} data-source={item.source}>
                {SOURCE_TAG[item.source] ?? item.source}
              </span>
              {clickable ? (
                <button
                  type="button"
                  className={styles.feedText}
                  onClick={() => onOpenSource(item)}
                >
                  {item.text}
                </button>
              ) : (
                <span className={styles.feedText}>{item.text}</span>
              )}
              {item.costMicroUsd > 0n ? (
                <span className={`num ${styles.feedCost}`}>+{usdSmall(item.costMicroUsd)}</span>
              ) : null}
            </li>
          );
        })}
      </ol>
      {!follow ? (
        <button
          type="button"
          className={styles.jump}
          onClick={() => {
            onClearFocus();
            setFollow(true);
            const el = box.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
        >
          ↓ {missed > 0 ? `${missed} new · ` : ""}jump to live
        </button>
      ) : null}
    </section>
  );
});
