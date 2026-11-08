"use client";
// The running phase's hero (TDM-201): only the trials that are live now, as big cards. Finished
// trials are a tally (passed / failed / ours), queued ones a single count. Each card's timer is a
// real clock; its stage moves on trial.phase; its heartbeat dot flashes on each trial.heartbeat.
//
// Counts only. A live trial's running timer is shown; a finished trial's duration is not (speed
// numbers come from the report, after the gate and the statistics).
import { memo } from "react";
import type { LiveRun } from "../../lib/live/model";
import {
  runningView,
  type FinishedCard,
  type LiveTrialCard,
  type TrialStage,
} from "../../lib/live/phase";
import { bytes, clock, pctOf, usd, usdSmall } from "./format";
import styles from "./live.module.css";

const STAGES: TrialStage[] = ["booting", "running", "grading"];
const STAGE_WORD: Record<TrialStage, string> = {
  booting: "boot",
  running: "run",
  grading: "grade",
};
const TONE_WORD: Record<FinishedCard["tone"], string> = {
  passed: "passed its gate",
  failed: "failed its gate",
  infra: "our failure, retrying",
};

export function RunningStage({
  live,
  nowMs,
  onOpenTrial,
}: {
  live: LiveRun;
  nowMs: number;
  onOpenTrial: (id: string) => void;
}) {
  const v = runningView(live, nowMs);
  const c = v.counts;
  const spentPct = pctOf(live.spentMicroUsd, live.budgetMicroUsd);
  return (
    <div className={styles.running} data-testid="running-stage">
      <dl className={styles.tally} aria-label="Trials so far">
        <div data-tone="passed">
          <dt>passed</dt>
          <dd className="num">{c.passed}</dd>
        </div>
        <div data-tone="failed">
          <dt>failed</dt>
          <dd className="num">{c.failed}</dd>
        </div>
        <div data-tone="infra">
          <dt>ours, not billed</dt>
          <dd className="num">{c.infra}</dd>
        </div>
        <div data-tone="active">
          <dt>running</dt>
          <dd className="num">{c.running}</dd>
        </div>
        <div data-tone="queued">
          <dt>queued</dt>
          <dd className="num" data-testid="queued-count">
            {c.queued}
          </dd>
        </div>
        <div data-tone="total">
          <dt>of</dt>
          <dd className="num">{c.total}</dd>
        </div>
      </dl>

      {v.live.length ? (
        <ul className={styles.cards} aria-label="Trials running now">
          {v.live.map((t) => (
            <TrialCard key={t.id} card={t} onOpen={onOpenTrial} />
          ))}
        </ul>
      ) : (
        <p className={styles.streamWait}>
          {c.queued ? "Starting the next trials" : "Waiting on the last results"}
          <span className={styles.caret} aria-hidden="true" />
        </p>
      )}
      {v.more ? (
        <p className={styles.moreLive}>
          + <span className="num">{v.more}</span> more running
        </p>
      ) : null}

      {v.justFinished.length ? (
        <ul className={styles.finished} aria-label="Just finished">
          {v.justFinished.slice(0, 3).map((f) => (
            <li key={f.id} data-tone={f.tone}>
              <button type="button" onClick={() => onOpenTrial(f.id)}>
                <span className={styles.finishedMark} aria-hidden="true">
                  {f.tone === "passed" ? "✓" : f.tone === "failed" ? "✕" : "↻"}
                </span>
                {f.setup} · {f.task} #{f.repeat + 1} {TONE_WORD[f.tone]}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className={styles.runSpend}>
        <span className={styles.runSpendBar} aria-hidden="true">
          <i style={{ width: `${spentPct}%` }} data-hot={spentPct >= 70 || undefined} />
        </span>
        <span className="num">{usd(live.spentMicroUsd)}</span>
        <span className={styles.runSpendOf}>
          spent of the <span className="num">{usd(live.budgetMicroUsd, 0)}</span> cap
        </span>
      </div>
    </div>
  );
}

const TrialCard = memo(function TrialCard({
  card,
  onOpen,
}: {
  card: LiveTrialCard;
  onOpen: (id: string) => void;
}) {
  const at = STAGES.indexOf(card.stage);
  const fresh = card.heartbeatAgeMs !== null && card.heartbeatAgeMs < 15_000;
  return (
    <li className={styles.card} data-stage={card.stage} data-testid="trial-card">
      <button
        type="button"
        onClick={() => onOpen(card.id)}
        aria-label={`${card.setup} · ${card.task} #${card.repeat + 1}: ${card.state}`}
      >
        <span className={styles.cardTop}>
          <span className={styles.cardSetup}>{card.setup}</span>
          {/* Remounts on every heartbeat, so the flash is one real heartbeat. */}
          <i
            key={card.heartbeatAt ?? "none"}
            className={styles.beat}
            data-fresh={fresh || undefined}
            aria-hidden="true"
          />
        </span>
        <span className={styles.cardTask}>
          {card.task} <span className="num">#{card.repeat + 1}</span>
          {card.attempt > 1 ? (
            <span className={styles.cardRetry}>attempt {card.attempt}</span>
          ) : null}
        </span>
        <span className={`num ${styles.cardClock}`} data-testid="trial-clock">
          {card.elapsedMs === null ? "–" : clock(card.elapsedMs)}
        </span>
        <span className={styles.cardTrack} aria-label={`stage ${card.stage}`}>
          {STAGES.map((s, i) => (
            <span key={s} data-on={i < at || undefined} data-now={i === at || undefined}>
              {STAGE_WORD[s]}
            </span>
          ))}
        </span>
        <span className={styles.cardMeta}>
          {card.costMicroUsd > 0n ? (
            <span className="num">{usdSmall(card.costMicroUsd)}</span>
          ) : null}
          {card.logBytes ? <span className="num">{bytes(card.logBytes)} of log</span> : null}
          <span>
            {card.heartbeatAgeMs === null ? (
              card.state
            ) : (
              <>
                beat <span className="num">{Math.round(card.heartbeatAgeMs / 1000)}s</span> ago
              </>
            )}
          </span>
        </span>
      </button>
    </li>
  );
});
