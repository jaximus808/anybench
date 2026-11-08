// The benchmark chart kit (TDM-203): clean, flat charts for a report. Every difference is drawn
// with its CI on a zero line and labelled with the report's own verdict; every setup is shown;
// a setup with no gated value is hatched and never ranked. No composite score.
import type { Report } from "@anybench/core";
import { proofBasis, splitAnswer } from "../report/model";
import styles from "./bench.module.css";
import {
  failureRows,
  formatDiff,
  passRates,
  requirementViews,
  taskGrid,
  VERDICT_WORD,
  type DiffItem,
  type RequirementView,
  type TaskGrid,
} from "./model";

/** Which side of a difference axis is "better": metric diffs where lower wins point left. */
function betterLeft(view: Pick<RequirementView, "lowerIsBetter">, d: Pick<DiffItem, "ciUnit">) {
  return d.ciUnit === "metric" && view.lowerIsBetter;
}

// ---- the difference vs the baseline, with its CI ----------------------------------------------

export function DiffChart({ view }: { view: RequirementView }) {
  if (!view.diffs.length) return null;
  const [d0, d1] = view.diffDomain;
  const W = 600;
  const x = (v: number) => ((v - d0) / (d1 - d0)) * W;
  const left = betterLeft(view, view.diffs[0]!);
  return (
    <div className={styles.diff} data-testid={`diff-${view.id}`}>
      <div className={styles.diffAxis} aria-hidden="true">
        <span>{left ? "← better" : "← worse"}</span>
        <span>vs baseline</span>
        <span>{left ? "worse →" : "better →"}</span>
      </div>
      {view.diffs.map((d) => (
        <div key={d.contenderId} className={styles.diffRow} data-verdict={d.verdict}>
          <div className={styles.diffName}>
            <b>{d.name}</b>
            <span className={styles.verdictTag} data-verdict={d.verdict}>
              {VERDICT_WORD[d.verdict]}
            </span>
          </div>
          <svg
            className={styles.diffSvg}
            viewBox={`0 0 ${W} 40`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`${d.name} vs ${d.baselineName}: ${formatDiff(d.lo, d, view.unit)} to ${formatDiff(d.hi, d, view.unit)} at ${Math.round(d.level * 100)}%`}
          >
            {/* the better half, faintly */}
            <rect
              className={styles.diffBetter}
              x={left ? 0 : x(0)}
              width={left ? x(0) : W - x(0)}
              y={6}
              height={28}
            />
            <line className={styles.diffZero} x1={x(0)} x2={x(0)} y1={2} y2={38} />
            <line className={styles.diffCi} x1={x(d.lo)} x2={x(d.hi)} y1={20} y2={20} />
            <line className={styles.diffCap} x1={x(d.lo)} x2={x(d.lo)} y1={13} y2={27} />
            <line className={styles.diffCap} x1={x(d.hi)} x2={x(d.hi)} y1={13} y2={27} />
            <circle className={styles.diffPoint} cx={x(d.point)} cy={20} r={6} />
          </svg>
          <div className={styles.diffNumbers}>
            <span className="num">
              {formatDiff(d.point, d, view.unit)}{" "}
              <small>
                [{formatDiff(d.lo, d, view.unit)}, {formatDiff(d.hi, d, view.unit)}] at{" "}
                {Math.round(d.level * 100)}%{d.attained ? "" : " (asked 95%; small n)"}
              </small>
            </span>
            {d.claim === "these_tasks" ? (
              <span className={styles.scopeTag}>on these {d.tasks} tasks only</span>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---- each setup's value, with n ---------------------------------------------------------------

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

// ---- correctness gate pass rate ---------------------------------------------------------------

export function PassRateBars({ report }: { report: Report }) {
  const rows = passRates(report);
  return (
    <ul className={styles.bars} data-kind="pass" data-testid="pass-rates">
      {rows.map((r) => (
        <li key={r.contenderId} data-gated={r.rate !== null || undefined} data-role={r.role}>
          <span className={styles.barName}>
            {r.name}
            {r.role === "baseline" ? <em>baseline</em> : null}
          </span>
          <span className={styles.barTrack}>
            <i style={{ width: r.rate === null ? "100%" : `${Math.max(1, r.rate * 100)}%` }} />
          </span>
          <span className={`num ${styles.barValue}`}>
            {r.rate === null ? "no gate result" : `${Math.round(r.rate * 100)}%`}
            {r.n !== null ? <small> n={r.n}</small> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ---- one requirement, both views --------------------------------------------------------------

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
      <ValueBars view={view} />
      <DiffChart view={view} />
    </section>
  );
}

// ---- per task: small multiples ----------------------------------------------------------------

function MiniCi({ c }: { c: TaskGrid["cells"][number] }) {
  const ext = Math.max(1e-9, Math.abs(c.lo), Math.abs(c.hi)) * 1.2;
  const x = (v: number) => ((v + ext) / (2 * ext)) * 100;
  return (
    <svg className={styles.mini} viewBox="0 0 100 14" preserveAspectRatio="none" aria-hidden="true">
      <line className={styles.diffZero} x1={50} x2={50} y1={1} y2={13} />
      <line className={styles.diffCi} x1={x(c.lo)} x2={x(c.hi)} y1={7} y2={7} />
    </svg>
  );
}

export function TaskGridChart({ report }: { report: Report }) {
  const g = taskGrid(report);
  if (!g) return null;
  return (
    <div className={styles.tasks} data-testid="task-grid">
      {g.headline.length ? (
        <ul className={styles.taskHeadline}>
          {g.headline.map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ul>
      ) : null}
      <div
        className={styles.taskTable}
        style={{ "--cols": g.requirements.length } as React.CSSProperties}
      >
        <span />
        {g.requirements.map((r) => (
          <span key={r.id} className={styles.taskColHead}>
            {r.title}
          </span>
        ))}
        {g.tasks.map((task) => (
          <div key={task} className={styles.taskRow}>
            <span className={styles.taskName}>{task}</span>
            {g.requirements.map((r) => {
              const cells = g.cells.filter((c) => c.task === task && c.requirementId === r.id);
              return (
                <span key={r.id} className={styles.taskCell}>
                  {cells.length
                    ? cells.map((c) => (
                        <span key={c.name} data-verdict={c.verdict} title={c.statement}>
                          <b>{VERDICT_WORD[c.verdict]}</b>
                          <MiniCi c={c} />
                        </span>
                      ))
                    : "–"}
                </span>
              );
            })}
          </div>
        ))}
      </div>
      <p className={styles.scope} data-testid="task-scope">
        {g.scope}
      </p>
    </div>
  );
}

// ---- proof, failures, where it breaks ---------------------------------------------------------

const CHECK_WORD: Record<string, string> = {
  oracle_passes: "The reference solution passes the gate",
  do_less_fails: "Doing less fails the gate",
  smoke_passes: "Every setup runs end to end",
  regression_scores_lower: "A planted regression scores lower",
  baselines_in_range: "Baselines land in the expected range",
  no_secret_in_kit: "No secret or answer in the kit",
};

export function ProofChecklist({ report }: { report: Report }) {
  const { proofLabel } = splitAnswer(report.answer);
  const basis = proofBasis(report, proofLabel);
  return (
    <div className={styles.proof} data-testid="proof">
      <p className={styles.proofBasis}>
        <span data-basis={basis.basis}>{basis.basis}</span>
        {basis.basis === "proven"
          ? `all ${basis.total} checks passed on this kit`
          : `${basis.passed}/${basis.total} checks passed here · ${basis.label}`}
      </p>
      <ul>
        {report.proof.map((p) => (
          <li key={p.check} data-pass={p.pass || undefined}>
            <span aria-hidden="true">{p.pass ? "✓" : "–"}</span>
            <b>{CHECK_WORD[p.check] ?? p.check.replace(/_/g, " ")}</b>
            <small>{p.reason}</small>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function FailuresAndBreaks({ report }: { report: Report }) {
  const fails = failureRows(report);
  return (
    <div className={styles.breaks} data-testid="where-it-breaks">
      {report.where_it_breaks.length ? (
        <ul className={styles.breakList}>
          {report.where_it_breaks.map((w, i) => (
            <li key={i}>
              <b>{w.workload_id}</b>
              {w.contender_id ? (
                <em>
                  {report.contenders.find((c) => c.contender_id === w.contender_id)?.name ?? ""}
                </em>
              ) : null}
              <span>{w.summary}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.muted}>No task broke a setup outright in this run.</p>
      )}
      {fails.length ? (
        <ul className={styles.failList} aria-label="Trials that didn't count">
          {fails.map((f) => (
            <li key={f.kind}>
              <span className="num">{f.count}</span> {f.word}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** All requirement blocks for a report, in report order. */
export function RequirementCharts({ report }: { report: Report }) {
  return (
    <div className={styles.reqs}>
      {requirementViews(report).map((v, i) => (
        <RequirementBlock key={v.id} view={v} n={i + 1} />
      ))}
    </div>
  );
}
