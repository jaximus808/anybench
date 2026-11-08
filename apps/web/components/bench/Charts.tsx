// The benchmark chart kit (TDM-203), used by the public page (/r/<slug>) and the owner's Results
// panel. Honest by construction (plan.md 17.2):
// - every setup is shown; a setup with no gated value is hatched and never ranked;
// - each setup's interval and each difference are drawn in plain ink: green or red only when the
//   report's own (Holm-corrected) verdict says better or worse, so "no detectable difference"
//   never gets a winner colour;
// - no composite score.
// Drawn with positioned HTML rather than a stretched SVG, so dots stay round at any width.
import type { Report } from "@anybench/core";
import styles from "./bench.module.css";
import {
  formatDiff,
  formatMetric,
  requirementViews,
  taskViews,
  VERDICT_WORD,
  type DiffItem,
  type RequirementView,
} from "./model";

const pct = (v: number) => `${Math.max(0, Math.min(100, v * 100))}%`;

/** Which side of a difference axis is "better": metric diffs where lower wins point left. */
function betterLeft(view: Pick<RequirementView, "lowerIsBetter">, d: Pick<DiffItem, "ciUnit">) {
  return d.ciUnit === "metric" && view.lowerIsBetter;
}

function ticksFor(view: RequirementView): { at: number; label: string }[] {
  const [, max] = view.axis;
  const unit = view.unit === "rate" ? "ratio" : view.unit;
  const steps = view.intervals === "wilson" ? [0, 0.25, 0.5, 0.75, 1] : [0, 0.5, 1];
  return steps.map((f) => ({ at: f, label: formatMetric(f * max, unit) }));
}

// ---- each setup's value with its own 95% interval ---------------------------------------------

export function IntervalChart({ view }: { view: RequirementView }) {
  const [, max] = view.axis;
  const ticks = ticksFor(view);
  const unit = view.unit === "rate" ? "ratio" : view.unit;
  const what =
    view.intervals === "wilson"
      ? "95% Wilson interval for each setup's pass rate"
      : "the report's 95% interval for each setup";
  return (
    <figure className={styles.intervals} data-testid={`intervals-${view.id}`}>
      <ul className={styles.intervalRows}>
        {view.bars.map((b) => {
          const ci = b.ci;
          const has = ci !== null && b.estimate !== null;
          return (
            <li
              key={b.contenderId}
              data-role={b.role}
              data-gated={has || undefined}
              aria-label={
                has
                  ? `${b.name}: ${formatMetric(b.estimate!, unit)}, 95% interval ${formatMetric(ci[0], unit)} to ${formatMetric(ci[1], unit)}${b.n !== null ? `, n=${b.n}` : ""}`
                  : `${b.name}: no gated value`
              }
            >
              <span className={styles.barName}>
                {b.name}
                {b.role === "baseline" ? <em>baseline</em> : null}
              </span>
              <span className={styles.intervalTrack} aria-hidden="true">
                {ticks.map((t) => (
                  <i key={t.at} className={styles.grid} style={{ left: pct(t.at) }} />
                ))}
                {has ? (
                  <>
                    <i
                      className={styles.ciBar}
                      style={{ left: pct(ci[0] / max), width: pct((ci[1] - ci[0]) / max) }}
                    />
                    <i className={styles.dot} style={{ left: pct(b.estimate! / max) }} />
                  </>
                ) : (
                  <i className={styles.hatch} />
                )}
              </span>
              <span className={`num ${styles.barValue}`}>
                {has ? formatMetric(b.estimate!, unit) : "no gated value"}
                {b.count ? (
                  <small> {b.count}</small>
                ) : b.n !== null ? (
                  <small> n={b.n}</small>
                ) : null}
                {has ? (
                  <small className={styles.ciText}>
                    [{formatMetric(ci[0], unit)}, {formatMetric(ci[1], unit)}]
                  </small>
                ) : null}
              </span>
            </li>
          );
        })}
        <li className={styles.axisRow} aria-hidden="true">
          <span />
          <span className={styles.axisTicks}>
            {ticks.map((t) => (
              <span key={t.at} style={{ left: pct(t.at) }}>
                {t.label}
              </span>
            ))}
          </span>
          <span />
        </li>
      </ul>
      <figcaption className={styles.caption}>
        Dot: the value. Line: {what}. Whether two setups differ is decided by the test on the
        difference below, not by whether their lines overlap.
      </figcaption>
    </figure>
  );
}

// ---- each setup's value, with n (metrics without per-setup intervals) -------------------------

export function ValueBars({ view }: { view: RequirementView }) {
  return (
    <ul className={styles.bars} data-testid={`values-${view.id}`}>
      {view.bars.map((b) => (
        <li key={b.contenderId} data-gated={b.value !== null || undefined} data-role={b.role}>
          <span className={styles.barName}>
            {b.name}
            {b.role === "baseline" ? <em>baseline</em> : null}
          </span>
          <span className={styles.barTrack}>
            <i style={{ width: b.value === null ? "100%" : `${Math.max(2, b.frac * 100)}%` }} />
          </span>
          <span className={`num ${styles.barValue}`}>
            {b.label}
            {b.n !== null ? <small> n={b.n}</small> : null}
            {b.survivorship ? <small title="median over solved trials only"> †</small> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ---- the difference vs the baseline, with its CI ----------------------------------------------

export function DiffChart({ view, testId }: { view: RequirementView; testId?: string }) {
  if (!view.diffs.length) return null;
  const [d0, d1] = view.diffDomain;
  const x = (v: number) => (v - d0) / (d1 - d0);
  const left = betterLeft(view, view.diffs[0]!);
  return (
    <div className={styles.diff} data-testid={testId ?? `diff-${view.id}`}>
      <div className={styles.diffAxis} aria-hidden="true">
        <span>{left ? "← better" : "← worse"}</span>
        <span>difference vs baseline</span>
        <span>{left ? "worse →" : "better →"}</span>
      </div>
      {view.diffs.map((d) => {
        const decided = d.verdict !== "indistinguishable";
        return (
          <div key={d.key} className={styles.diffRow} data-verdict={d.verdict}>
            <div className={styles.diffName}>
              <span className={styles.diffLabel}>{d.name}</span>
              <span className={styles.verdictTag} data-verdict={d.verdict}>
                {VERDICT_WORD[d.verdict]}
              </span>
            </div>
            <div
              className={styles.diffTrack}
              role="img"
              aria-label={`${d.name} vs ${d.baselineName}: ${VERDICT_WORD[d.verdict]}; difference ${formatDiff(d.lo, d, view.unit)} to ${formatDiff(d.hi, d, view.unit)} at ${Math.round(d.level * 100)}%`}
            >
              {/* The better half is tinted only once the verdict is decided. */}
              {decided ? (
                <i
                  className={styles.diffBetter}
                  style={left ? { left: 0, width: pct(x(0)) } : { left: pct(x(0)), right: 0 }}
                />
              ) : null}
              <i className={styles.diffZero} style={{ left: pct(x(0)) }} />
              <i
                className={styles.ciBar}
                style={{ left: pct(x(d.lo)), width: pct(x(d.hi) - x(d.lo)) }}
              />
              <i className={styles.dot} style={{ left: pct(x(d.point)) }} />
            </div>
            <div className={styles.diffNumbers}>
              <span className="num">
                {formatDiff(d.point, d, view.unit)}{" "}
                <small>
                  [{formatDiff(d.lo, d, view.unit)}, {formatDiff(d.hi, d, view.unit)}] at{" "}
                  {Math.round(d.level * 100)}%{d.attained ? "" : " (asked 95%; small n)"}
                </small>
              </span>
              {decided ? null : (
                <span className={styles.mde}>smallest detectable difference: {d.mde}</span>
              )}
              {d.claim === "these_tasks" && d.tasks > 1 ? (
                <span className={styles.scopeTag}>on these {d.tasks} tasks only</span>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---- one requirement: each setup, then the difference -----------------------------------------

export function RequirementChart({ view }: { view: RequirementView }) {
  return (
    <div className={styles.reqChart}>
      {view.intervals ? <IntervalChart view={view} /> : <ValueBars view={view} />}
      {view.bars.some((b) => b.survivorship) ? (
        <p className={styles.caption}>† median over solved trials only; failures are not in it.</p>
      ) : null}
      <DiffChart view={view} />
    </div>
  );
}

export function RequirementBlock({ view, n }: { view: RequirementView; n: number }) {
  return (
    <section className={styles.req} aria-labelledby={`req-${view.id}`}>
      <header className={styles.reqHead}>
        <span className={styles.reqN}>{String(n).padStart(2, "0")}</span>
        <h3 id={`req-${view.id}`}>{view.title}</h3>
        <span className={styles.reqMeta}>
          {view.type === "reviewed" ? "reviewed" : "measured"} ·{" "}
          {view.lowerIsBetter ? "lower is better" : "higher is better"}
        </span>
      </header>
      <RequirementChart view={view} />
    </section>
  );
}

/** All requirement blocks for a report, in report order. */
export function RequirementCharts({ report }: { report: Report }) {
  return (
    <div className={styles.reqs} data-testid="requirement-charts">
      {requirementViews(report).map((v, i) => (
        <RequirementBlock key={v.id} view={v} n={i + 1} />
      ))}
    </div>
  );
}

// ---- per task: each task's difference on one shared axis (E18) --------------------------------

/** Per-task differences for every requirement that has them; show the report's scope line too. */
export function TaskCharts({ report }: { report: Report }) {
  const views = taskViews(report);
  if (!views.length) return null;
  return (
    <div className={styles.reqs} data-testid="task-charts">
      {views.map((v) => (
        <section key={v.id} className={styles.req} aria-label={`${v.title}, per task`}>
          <header className={styles.reqHead}>
            <h4>{v.title}</h4>
            <span className={styles.reqMeta}>per task</span>
          </header>
          <DiffChart view={v} testId={`task-diff-${v.id}`} />
        </section>
      ))}
    </div>
  );
}
