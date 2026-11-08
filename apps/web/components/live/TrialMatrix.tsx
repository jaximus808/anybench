"use client";
// The trial matrix: rows are contenders, column groups are workloads, one cell per repeat.
// Every cell is a button that opens the trial drawer. Arrow keys move between cells.
import { TRIAL_PHASES } from "@anybench/core";
import { memo, useMemo, useState, type KeyboardEvent } from "react";
import {
  tallyByContender,
  tileTone,
  trialLabel,
  type LiveRun,
  type LiveTrial,
  type TileTone,
} from "../../lib/live/model";
import { ms, span } from "./format";
import styles from "./live.module.css";

export type GridFilter = TileTone | "all";

const TONE_CLASS: Record<TileTone, string | undefined> = {
  queued: styles.cQueued,
  active: styles.cActive,
  passed: styles.cPassed,
  failed: styles.cFailed,
  infra: styles.cInfra,
  cancelled: styles.cCancelled,
};

const TONE_WORD: Record<TileTone, string> = {
  queued: "queued",
  active: "running",
  passed: "passed gate",
  failed: "failed",
  infra: "infra failure",
  cancelled: "cancelled",
};

function cellKey(row: number, col: number) {
  return `cell-${row}-${col}`;
}

function onGridKey(e: KeyboardEvent<HTMLDivElement>) {
  const el = e.target as HTMLElement;
  const row = Number(el.dataset.row);
  const col = Number(el.dataset.col);
  if (Number.isNaN(row)) return;
  const d: Record<string, [number, number]> = {
    ArrowRight: [0, 1],
    ArrowLeft: [0, -1],
    ArrowDown: [1, 0],
    ArrowUp: [-1, 0],
  };
  const step = d[e.key];
  if (!step) return;
  const next = e.currentTarget.querySelector<HTMLElement>(
    `[data-key="${cellKey(row + step[0], col + step[1])}"]`,
  );
  if (next) {
    e.preventDefault();
    next.focus();
  }
}

export const TrialMatrix = memo(function TrialMatrix({
  live,
  filter,
  selectedId,
  onOpen,
}: {
  live: LiveRun;
  filter: GridFilter;
  selectedId: string | null;
  onOpen: (id: string) => void;
}) {
  const tallies = useMemo(() => tallyByContender(live), [live]);
  const byCell = useMemo(() => {
    const m = new Map<string, LiveTrial>();
    for (const id of live.trialOrder) {
      const t = live.trials[id]!;
      m.set(`${t.contenderId}|${t.workload}|${t.repeat}`, t);
    }
    return m;
  }, [live.trials, live.trialOrder]);

  if (live.trialOrder.length === 0) {
    return (
      <div className={styles.matrixEmpty}>
        <p className="eyebrow">Trial grid</p>
        <p>
          Trials appear here once the kit passes its proof. Right now the agents are working out
          what to compare and how to check it; watch them on the right.
        </p>
      </div>
    );
  }

  const cols = live.workloads.length * live.repeats;
  return (
    <div className={styles.matrix} onKeyDown={onGridKey} data-filter={filter}>
      <div className={styles.matrixHead} aria-hidden="true">
        <span />
        <div className={styles.matrixGroups}>
          {live.workloads.map((w) => (
            <span key={w} className={styles.groupLabel} style={{ "--n": live.repeats } as never}>
              {w}
            </span>
          ))}
        </div>
      </div>
      {live.contenders.map((c, row) => {
        const tally = tallies[row];
        return (
          <div key={c.id} className={styles.matrixRow}>
            <span className={styles.rowName} title={c.name}>
              <span className={styles.rowLetter}>{String.fromCharCode(65 + row)}</span>
              <span className={styles.rowText}>
                <span className={styles.rowLabel}>{c.name}</span>
                {tally ? (
                  <span className={styles.rowTally}>
                    <b className="num">
                      {tally.passed}
                      <span className={styles.of}>/{tally.total}</span>
                    </b>{" "}
                    passed gate
                    {tally.running ? (
                      <span className={styles.tallyRun}> · {tally.running} live</span>
                    ) : null}
                  </span>
                ) : null}
              </span>
            </span>
            <div className={styles.matrixGroups}>
              {live.workloads.map((w, g) => (
                <div key={w} className={styles.cellGroup}>
                  {Array.from({ length: live.repeats }, (_, r) => {
                    const t = byCell.get(`${c.id}|${w}|${r}`);
                    const col = g * live.repeats + r;
                    if (!t) return <span key={r} className={styles.cellVoid} />;
                    const tone = tileTone(t);
                    const dim = filter !== "all" && filter !== tone;
                    const label = `${trialLabel(live, t)}: ${TONE_WORD[tone]}${tone === "active" ? ` (${t.state})` : ""}${t.attempt > 1 ? `, attempt ${t.attempt}` : ""}`;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        className={`${styles.cell} ${TONE_CLASS[tone] ?? ""}`}
                        data-dim={dim || undefined}
                        data-selected={selectedId === t.id || undefined}
                        data-row={row}
                        data-col={col}
                        data-key={cellKey(row, col)}
                        aria-label={label}
                        title={label}
                        onClick={() => onOpen(t.id)}
                      >
                        {tone === "active" ? (
                          <span
                            className={styles.cellFill}
                            aria-hidden="true"
                            style={
                              {
                                "--p":
                                  TRIAL_PHASES.indexOf(t.state as (typeof TRIAL_PHASES)[number]) /
                                  (TRIAL_PHASES.length - 1),
                              } as never
                            }
                          />
                        ) : null}
                        {t.attempt > 1 ? (
                          <span className={styles.cellRetry} aria-hidden="true" />
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        );
      })}
      <span className="visually-hidden">{cols} trials per contender row</span>
    </div>
  );
});

/** Active trials with a pip per phase, newest phase change first. */
export const NowRunning = memo(function NowRunning({
  live,
  nowMs,
  onOpen,
}: {
  live: LiveRun;
  nowMs: number;
  onOpen: (id: string) => void;
}) {
  const [all, setAll] = useState(false);
  const active = live.trialOrder
    .map((id) => live.trials[id]!)
    .filter((t) => tileTone(t) === "active")
    .sort((a, b) => ms(a.startedAt) - ms(b.startedAt));
  if (!active.length) return null;
  const phases = TRIAL_PHASES.slice(1);
  const CAP = 8;
  const shown = all ? active : active.slice(0, CAP);
  return (
    <section className={styles.nowRunning} aria-labelledby="now-running-h">
      <h2 id="now-running-h" className={styles.panelTitle}>
        Now running <span className="num">{active.length}</span>
      </h2>
      <ul>
        {shown.map((t) => {
          const at = phases.indexOf(t.state as (typeof phases)[number]);
          return (
            <li key={t.id}>
              <button type="button" onClick={() => onOpen(t.id)} className={styles.nrRow}>
                <span className={styles.nrName}>{trialLabel(live, t)}</span>
                <span className={styles.pips} aria-label={`phase ${t.state}`}>
                  {phases.map((p, i) => (
                    <i
                      key={p}
                      data-on={i < at || undefined}
                      data-now={i === at || undefined}
                      title={p}
                    />
                  ))}
                </span>
                <span className={styles.nrPhase}>{t.state}</span>
                <span className={`num ${styles.nrTime}`}>
                  {t.startedAt ? span(nowMs - ms(t.startedAt)) : "–"}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {active.length > CAP ? (
        <button type="button" className={styles.moreBtn} onClick={() => setAll((a) => !a)}>
          {all ? "Show fewer" : `Show all ${active.length}`}
        </button>
      ) : null}
    </section>
  );
});
