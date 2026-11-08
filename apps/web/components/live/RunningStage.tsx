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
  slots,
}: {
  live: LiveRun;
  nowMs: number;
  onOpenTrial: (id: string, at?: { x: number; y: number }) => void;
  /** Stable slot → trial id (PhaseStage): a trial keeps its card until it ends. */
  slots?: (string | null)[];
}) {
  const v = runningView(live, nowMs, { cap: 99 });
  const byId = new Map(v.live.map((t) => [t.id, t]));
  const cardsInSlots = (slots ?? v.live.slice(0, 5).map((t) => t.id)).map((id) =>
    id ? (byId.get(id) ?? null) : null,
  );
  const more = Math.max(0, v.live.length - cardsInSlots.filter(Boolean).length);
  const c = v.counts;
  const spentPct = pctOf(live.spentMicroUsd, live.budgetMicroUsd);
  return (
    <div className={styles.running} data-testid="running-stage">
      <dl className={styles.tally} aria-label="Trials so far">
        <div data-tone="passed">
          <dt>passed</dt>
          <dd className="num" key={c.passed}>
            {c.passed}
          </dd>
        </div>
        <div data-tone="failed">
          <dt>failed</dt>
          <dd className="num" key={c.failed}>
            {c.failed}
          </dd>
        </div>
        <div data-tone="infra">
          <dt>ours, not billed</dt>
          <dd className="num" key={c.infra}>
            {c.infra}
          </dd>
        </div>
        <div data-tone="active">
          <dt>running</dt>
          <dd className="num" key={c.running}>
            {c.running}
          </dd>
        </div>
        <div data-tone="queued">
          <dt>queued</dt>
          <dd className="num" data-testid="queued-count" key={c.queued}>
            {c.queued}
          </dd>
        </div>
        <div data-tone="total">
          <dt>of</dt>
          <dd className="num">{c.total}</dd>
        </div>
      </dl>

      <ul className={styles.cards} aria-label="Trials running now">
        {cardsInSlots.map((t, i) =>
          t ? (
            <TrialCard key={t.id} card={t} bay={i + 1} onOpen={onOpenTrial} />
          ) : (
            <li key={`idle-${i}`} className={styles.card} data-idle>
              <span className={styles.cardIdle}>
                <span className={styles.cardVm}>
                  <b className={styles.cardBay}>{i + 1}</b>idle
                </span>
                {c.queued ? "starting the next trial" : "no trial"}
              </span>
            </li>
          ),
        )}
      </ul>

      {/* One fixed line, so the hero never changes height when a trial finishes. */}
      <p className={styles.finishedLine} aria-live="polite">
        {v.justFinished[0] ? (
          <button
            type="button"
            data-tone={v.justFinished[0].tone}
            onClick={(e) => onOpenTrial(v.justFinished[0]!.id, { x: e.clientX, y: e.clientY })}
          >
            <span className={styles.finishedMark} aria-hidden="true">
              {v.justFinished[0].tone === "passed"
                ? "✓"
                : v.justFinished[0].tone === "failed"
                  ? "✕"
                  : "↻"}
            </span>
            {v.justFinished[0].setup} · {v.justFinished[0].task} #{v.justFinished[0].repeat + 1}{" "}
            {TONE_WORD[v.justFinished[0].tone]}
          </button>
        ) : more ? (
          <span>
            + <span className="num">{more}</span> more running
          </span>
        ) : null}
      </p>

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
  bay,
  onOpen,
}: {
  card: LiveTrialCard;
  bay: number;
  onOpen: (id: string, at?: { x: number; y: number }) => void;
}) {
  const at = STAGES.indexOf(card.stage);
  const fresh = card.heartbeatAgeMs !== null && card.heartbeatAgeMs < 15_000;
  return (
    <li className={styles.card} data-stage={card.stage} data-testid="trial-card">
      <button
        type="button"
        onClick={(e) => onOpen(card.id, { x: e.clientX, y: e.clientY })}
        aria-label={`${card.setup} · ${card.task} #${card.repeat + 1}: ${card.state}`}
      >
        <span className={styles.cardVm}>
          <b className={styles.cardBay}>{bay}</b>
          {card.computerId ? `VM ${card.computerId.slice(-6)}` : "VM starting"}
        </span>
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
        <span className={styles.cardTask} data-setup={card.setup}>
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
