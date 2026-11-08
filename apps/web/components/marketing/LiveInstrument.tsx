"use client";
// The hero's live panel: the simulated demo run playing on a loop, through the same model the
// live run page uses. Counts only (passed / failed gate / running), never a speed number: those
// come from the report, after the gate (plan.md 17.2).
import { formatUsd } from "@anybench/core";
import Link from "next/link";
import { useMemo } from "react";
import {
  STAGES,
  countTrials,
  stageIndex,
  tileTone,
  type FeedItem,
  type LiveRun,
} from "../../lib/live/model";
import { useLiveRun } from "../../lib/live/useLiveRun";
import styles from "./landing.module.css";

const TONE_CLASS = {
  queued: styles.cQ,
  active: styles.cR,
  passed: styles.cP,
  failed: styles.cF,
  infra: styles.cI,
  cancelled: styles.cQ,
} as const;

/** The panel is small: show the stages a visitor cares about. */
const HIDDEN_STAGES = new Set(["intake", "awaiting_go", "env_build", "delivered"]);

function clock(live: LiveRun, at: string | null): string {
  if (!at) return "00:00";
  const s = Math.max(0, Math.floor((Date.parse(at) - Date.parse(live.createdAt)) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** The feed lines worth showing in a small panel: agents, gates and stage changes. */
function headline(item: FeedItem): boolean {
  return (
    item.type === "agent.tool.started" ||
    item.type === "agent.message" ||
    item.type === "trial.gate" ||
    item.type === "run.state_changed"
  );
}

export function LiveInstrument() {
  const { live } = useLiveRun("demo", { startAt: 0.46, loop: true });

  const view = useMemo(() => {
    if (!live) return null;
    const counts = countTrials(live);
    const stage = stageIndex(live.state, live.stateHistory);
    const lines: FeedItem[] = [];
    for (let i = live.feed.length - 1; i >= 0 && lines.length < 5; i--)
      if (headline(live.feed[i]!)) lines.push(live.feed[i]!);
    return { counts, stage, lines };
  }, [live]);

  return (
    <figure className={styles.inst} aria-label="A simulated benchmark run playing live">
      <div className={styles.instHead}>
        <span className={styles.instTitle}>tandem-workers</span>
        <span className={styles.liveTag}>
          <span className={styles.liveDot} aria-hidden="true" />
          live · simulated run
        </span>
      </div>

      <ol className={styles.instStages} aria-label="Run stages">
        {STAGES.filter((s) => !HIDDEN_STAGES.has(s.state)).map((s) => {
          const i = STAGES.findIndex((x) => x.state === s.state);
          const state = !view
            ? "todo"
            : i < view.stage
              ? "done"
              : i === view.stage
                ? "now"
                : "todo";
          return (
            <li key={s.state} data-state={state}>
              {s.label}
            </li>
          );
        })}
      </ol>

      <dl className={styles.instStats}>
        <div>
          <dt>done</dt>
          <dd>
            {view?.counts.done ?? 0}
            <small>/{view?.counts.total ?? 60}</small>
          </dd>
        </div>
        <div>
          <dt>running</dt>
          <dd className={styles.amber}>{view?.counts.running ?? 0}</dd>
        </div>
        <div>
          <dt>gate failed</dt>
          <dd>{view?.counts.failed ?? 0}</dd>
        </div>
        <div>
          <dt>spent</dt>
          <dd>{live ? formatUsd(live.spentMicroUsd) : "$0.00"}</dd>
        </div>
      </dl>

      <div
        className={styles.matrix}
        role="img"
        aria-label="Trial grid: 4 setups by 3 tasks by 5 runs"
      >
        {(live?.contenders ?? []).map((c) => (
          <div key={c.id} className={styles.mRow}>
            <span className={styles.mName}>{c.name}</span>
            <div className={styles.mGroups}>
              {live!.workloads.map((w) => (
                <div key={w} className={styles.mGroup}>
                  {live!.trialOrder
                    .map((id) => live!.trials[id]!)
                    .filter((t) => t.contenderId === c.id && t.workload === w)
                    .map((t) => (
                      <i key={t.id} className={`${styles.cell} ${TONE_CLASS[tileTone(t)]}`} />
                    ))}
                </div>
              ))}
            </div>
          </div>
        ))}
        <div className={styles.mAxis} aria-hidden="true">
          <span />
          <div className={styles.mGroups}>
            {(live?.workloads ?? []).map((w) => (
              <span key={w}>{w}</span>
            ))}
          </div>
        </div>
      </div>

      <ol className={styles.ticker} aria-live="off" aria-label="Latest activity">
        {(view?.lines ?? []).map((l) => (
          <li key={l.seq} data-type={l.type}>
            <span className={styles.tkTime}>{live ? clock(live, l.at) : ""}</span>
            <span className={styles.tkText}>{l.text}</span>
          </li>
        ))}
      </ol>

      <figcaption className={styles.instFoot}>
        <span>Simulated: 4 setups × 3 tasks × 5 runs, each on a fresh computer.</span>
        <Link href="/runs/demo" className={styles.instLink}>
          Open the live page →
        </Link>
      </figcaption>
    </figure>
  );
}
