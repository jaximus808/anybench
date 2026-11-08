"use client";
// The inspector: click a computer, a trial block or a trial card and it opens out of that spot
// (a circular reveal from the click) to show what that computer is doing right now. Everything
// here is the run's own data: the trial's state, its computer, its heartbeats, its events.
import { useEffect } from "react";
import { filterFeed, tileTone, TRIAL_STATE_WORD, type LiveRun } from "../../lib/live/model";
import { TRIAL_STAGE } from "../../lib/live/phase";
import { bytes, clock, ms, usdSmall } from "./format";
import styles from "./live.module.css";
import type { FocusTarget } from "./PhaseFigure";

const STEPS = ["queued", "booting", "running", "grading", "result"] as const;

export function Inspector({
  live,
  nowMs,
  target,
  origin,
  onClose,
  onOpenTrial,
}: {
  live: LiveRun;
  nowMs: number;
  target: FocusTarget;
  /** Where the click landed, relative to the hero. */
  origin: { x: number; y: number };
  onClose: () => void;
  onOpenTrial: (id: string) => void;
}) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", esc, true);
    return () => window.removeEventListener("keydown", esc, true);
  }, [onClose]);

  return (
    <div
      className={styles.inspector}
      style={{ "--ox": `${origin.x}px`, "--oy": `${origin.y}px` } as React.CSSProperties}
      role="dialog"
      aria-label="Inspector"
      data-testid="inspector"
    >
      <button type="button" className={styles.inspectorClose} onClick={onClose} aria-label="Close">
        ×
      </button>
      {target.kind === "trial" ? (
        <TrialView live={live} nowMs={nowMs} id={target.id} onOpenTrial={onOpenTrial} />
      ) : (
        <GraderView live={live} />
      )}
    </div>
  );
}

function TrialView({
  live,
  nowMs,
  id,
  onOpenTrial,
}: {
  live: LiveRun;
  nowMs: number;
  id: string;
  onOpenTrial: (id: string) => void;
}) {
  const t = live.trials[id];
  if (!t) return <p className={styles.inspectorWhat}>This trial isn’t in the run any more.</p>;
  const setup = live.contenders.find((c) => c.id === t.contenderId)?.name ?? "setup";
  const tone = tileTone(t);
  const stage =
    tone === "queued"
      ? "queued"
      : tone === "active"
        ? (TRIAL_STAGE[t.state] ?? "booting")
        : "result";
  const at = STEPS.indexOf(stage as (typeof STEPS)[number]);
  const events = filterFeed(live.feed, {
    query: "",
    sources: [],
    minSeverity: "info",
    sourceId: id,
  }).slice(-6);
  const vm = t.computerId
    ? `VM ${t.computerId.slice(-6)}`
    : tone === "active"
      ? "VM starting"
      : "no computer";
  const beat = t.heartbeatAt ? nowMs - ms(t.heartbeatAt) : null;

  return (
    <div className={styles.inspectorBody}>
      <p className={styles.inspectorKicker}>
        <span>{vm}</span>
        <span>Naïve computer · its own, fresh</span>
      </p>
      <h3 className={styles.inspectorTitle}>
        {setup} <span>·</span> {t.workload} #{t.repeat + 1}
      </h3>
      <p className={styles.inspectorWhat}>
        {stage === "grading"
          ? "The agent is done. Its work is being graded on the grader, a separate computer it never had access to."
          : stage === "result"
            ? tone === "passed"
              ? `Passed its gate${t.gate?.summary ? `: ${t.gate.summary}` : "."}`
              : tone === "failed"
                ? `Failed its gate${t.gate?.summary ? `: ${t.gate.summary}` : "."}`
                : tone === "infra"
                  ? "Our failure, not billed. It goes back to the queue on a fresh computer."
                  : "Cancelled."
            : stage === "queued"
              ? "Waiting for a computer."
              : `${setup} is working on ${t.workload} in a sealed sandbox. The hidden tests aren’t on this computer.`}
      </p>
      <ol className={styles.inspectorSteps} aria-label="Where it is">
        {STEPS.map((s, i) => (
          <li
            key={s}
            data-on={i < at || undefined}
            data-now={i === at || undefined}
            data-tone={i === at && s === "result" ? tone : undefined}
          >
            {s === "result" && i === at
              ? tone === "passed"
                ? "passed"
                : tone === "failed"
                  ? "failed"
                  : tone === "infra"
                    ? "ours"
                    : "done"
              : s}
          </li>
        ))}
      </ol>
      <dl className={styles.inspectorFacts}>
        <div>
          <dt>state</dt>
          <dd>{TRIAL_STATE_WORD[t.state]}</dd>
        </div>
        <div>
          <dt>in this state</dt>
          <dd className="num">{t.phaseAt ? clock(nowMs - ms(t.phaseAt)) : "–"}</dd>
        </div>
        <div>
          <dt>heartbeat</dt>
          <dd className="num">{beat === null ? "–" : `${Math.round(beat / 1000)}s ago`}</dd>
        </div>
        <div>
          <dt>log</dt>
          <dd className="num">{t.logBytes ? bytes(t.logBytes) : "–"}</dd>
        </div>
        <div>
          <dt>attempt</dt>
          <dd className="num">{t.attempt}</dd>
        </div>
        <div>
          <dt>spend</dt>
          <dd className="num">{t.costMicroUsd > 0n ? usdSmall(t.costMicroUsd) : "–"}</dd>
        </div>
      </dl>
      {events.length ? (
        <ol className={styles.inspectorEvents} aria-label="Latest events">
          {events.map((e) => (
            <li key={e.seq}>
              <span className="num">#{e.seq}</span> {e.text.replace(/^[^:]+: /, "")}
            </li>
          ))}
        </ol>
      ) : null}
      <button type="button" className={styles.inspectorMore} onClick={() => onOpenTrial(id)}>
        Full trial details →
      </button>
    </div>
  );
}

function GraderView({ live }: { live: LiveRun }) {
  const trials = live.trialOrder.map((id) => live.trials[id]!);
  const grading = trials.filter(
    (t) => tileTone(t) === "active" && TRIAL_STAGE[t.state] === "grading",
  );
  const gate = trials.map((t) => t.gate?.gate).find(Boolean) ?? "the hidden tests";
  const passed = trials.filter((t) => tileTone(t) === "passed").length;
  const failed = trials.filter((t) => tileTone(t) === "failed").length;
  const name = (id: string) => live.contenders.find((c) => c.id === id)?.name ?? "setup";
  return (
    <div className={styles.inspectorBody}>
      <p className={styles.inspectorKicker}>
        <span>GRADER</span>
        <span>a separate computer, built from the scoring image</span>
      </p>
      <h3 className={styles.inspectorTitle}>The gate: {gate}</h3>
      <p className={styles.inspectorWhat}>
        When an agent finishes, its work is copied here and checked against hidden tests the agent’s
        computer never had. A result that fails the gate is never ranked.
      </p>
      <dl className={styles.inspectorFacts}>
        <div>
          <dt>grading now</dt>
          <dd className="num">{grading.length}</dd>
        </div>
        <div>
          <dt>passed</dt>
          <dd className="num" data-tone="pass">
            {passed}
          </dd>
        </div>
        <div>
          <dt>failed</dt>
          <dd className="num" data-tone="fail">
            {failed}
          </dd>
        </div>
      </dl>
      {grading.length ? (
        <ol className={styles.inspectorEvents} aria-label="Grading now">
          {grading.map((t) => (
            <li key={t.id}>
              {name(t.contenderId)} · {t.workload} #{t.repeat + 1}: {t.state}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
