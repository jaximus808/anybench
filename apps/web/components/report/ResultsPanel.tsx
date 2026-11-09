"use client";
// The Results section (TDM-103 [11.6]): the run's report from GET /runs/:id/report, through the
// web app's API client (lib/api.ts, the same-origin /api proxy). Headline verdict first, then one
// chart per requirement (each setup's value with its interval, the difference vs the baseline with
// its CI and verdict), then the exact numbers: one row per requirement with every setup's value
// and n, the verdict with the CI of the difference, and the smallest detectable difference. Then how the setups ran (disclosure)
// and the proof basis. No composite score anywhere. TDM-225: a starter (free) run states its sample
// size next to the verdict (model.ts sampleSizeNote): a small run may well say "not significant".
//
// All report text is untrusted (it carries agent and kit text): it renders as React text nodes,
// which escape it. Never dangerouslySetInnerHTML here.
import {
  ApiClientError,
  apiRoutes,
  type ApiClient,
  type Report,
  type RunState,
} from "@anybench/core";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useLiveApi } from "../../lib/live/client";
import { RequirementCharts, TaskCharts } from "../bench/Charts";
import { describeApiError } from "../../lib/live/useLiveRun";
import { perTaskRows, proofBasis, resultRows, sampleSizeNote, splitAnswer } from "./model";
import styles from "./report.module.css";
import { TimeBreakdownSection } from "../trace/TimeBreakdown";
import { ScoreboardSection } from "./Scoreboard";

/** The verdict wording reads as a shrug; the numbers above it carry the point. */
function plain(text: string): string {
  return text.replace(/no detectable difference/g, "not significant");
}

/** The first sentence leads; the statistical detail after it stays, smaller. */
function leadSentence(text: string): [string, string] {
  const m = /^(.+?[.)])(\s+(?=[A-Z]).*)$/s.exec(text);
  return m ? [m[1]!, m[2]!] : [text, ""];
}

export type ResultsState =
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "report"; report: Report }
  | { kind: "error"; message: string };

/** Run states whose report may exist (or whose reason we must show). */
const SETTLED: readonly RunState[] = ["delivered", "failed", "cancelled", "needs_human"];

/** Fetch the report; a 404 means analyzing hasn't written it yet. */
export async function loadReport(client: ApiClient, runId: string): Promise<ResultsState> {
  try {
    const { report } = await client.call(apiRoutes.reports.get, {
      params: { id: runId as Report["run_id"] },
    });
    return { kind: "report", report };
  } catch (e) {
    if (e instanceof ApiClientError && e.status === 404) return { kind: "none" };
    return { kind: "error", message: describeApiError(e) };
  }
}

/** Fetches the report for a run and refetches when the run's state changes. */
export function ResultsPanel({
  runId,
  runState,
  holdReason = null,
  standalone = false,
  starterRun = false,
}: {
  runId: string;
  runState: RunState | null;
  holdReason?: string | null;
  standalone?: boolean;
  /** TDM-225: the run was the free starter run (budget_basis `free_run`). */
  starterRun?: boolean;
}) {
  const client = useLiveApi();
  const [state, setState] = useState<ResultsState>({ kind: "loading" });
  useEffect(() => {
    let live = true;
    void loadReport(client, runId).then((s) => {
      if (live) setState(s);
    });
    return () => {
      live = false;
    };
  }, [client, runId, runState]);

  // While the run is still going and there is no report, stay out of the way.
  if (!standalone && runState && !SETTLED.includes(runState) && state.kind !== "report")
    return null;
  return (
    <ResultsView
      runId={runId}
      state={state}
      runState={runState}
      holdReason={holdReason}
      standalone={standalone}
      starterRun={starterRun}
    />
  );
}

/** The section for a given fetch state. Exported so tests render it from a fixture. */
export function ResultsView({
  runId,
  state,
  runState,
  holdReason = null,
  standalone = false,
  starterRun = false,
}: {
  runId: string;
  state: ResultsState;
  runState: RunState | null;
  holdReason?: string | null;
  standalone?: boolean;
  starterRun?: boolean;
}) {
  const report = state.kind === "report" ? state.report : null;
  const needsHuman = runState === "needs_human";
  const reason = holdReason ?? report?.postmortem?.explanation ?? report?.postmortem?.error ?? null;

  return (
    <section className={styles.results} aria-labelledby="results-h" data-testid="results">
      <header className={styles.head}>
        <h2 id="results-h" className={styles.title}>
          Results
        </h2>
        {report ? (
          <span className={styles.meta}>
            {report.comped ? <span className={styles.tag}>comped</span> : null}
            <a href={`/api/runs/${runId}/report/markdown`}>Markdown</a>
            {standalone ? (
              <Link href={`/runs/${runId}`}>Live run</Link>
            ) : (
              <Link href={`/runs/${runId}/report`}>Open report</Link>
            )}
          </span>
        ) : null}
      </header>

      {needsHuman ? (
        <div className={styles.hold} role="alert" data-testid="results-needs-human">
          <span className={styles.holdTag}>needs you</span>
          <p>{reason ?? "The run stopped and needs a person to look at it."}</p>
        </div>
      ) : null}

      {state.kind === "loading" ? (
        <p className={styles.empty} role="status">
          Loading results…
        </p>
      ) : state.kind === "error" ? (
        <p className={styles.error} role="alert" data-testid="results-error">
          Couldn’t load the results. {state.message}
        </p>
      ) : state.kind === "none" ? (
        needsHuman ? null : (
          <p className={styles.empty} data-testid="results-empty">
            Results appear when the run finishes.
          </p>
        )
      ) : (
        <ReportBody report={state.report} runId={runId} starterRun={starterRun} />
      )}
    </section>
  );
}

function ReportBody({
  report,
  runId,
  starterRun,
}: {
  report: Report;
  runId: string;
  starterRun: boolean;
}) {
  const { headline, proofLabel, disclosure } = splitAnswer(report.answer);
  const proof = proofBasis(report, proofLabel);
  const rows = resultRows(report);
  const taskRows = perTaskRows(report);
  const setups = report.contenders;
  const [lead, rest] = leadSentence(plain(headline));
  const sample = starterRun ? sampleSizeNote(report) : null;

  return (
    <div className={styles.body}>
      <p className={styles.headline} data-testid="results-headline">
        {lead}
        {rest ? <span className={styles.headRest}>{rest}</span> : null}
      </p>
      {sample ? (
        <p className={styles.sampleSize} data-testid="results-sample-size">
          <span className={styles.tag}>free run</span> {sample}
        </p>
      ) : null}

      <ScoreboardSection
        runId={runId}
        setups={setups.map((c) => ({
          id: c.contender_id,
          name: c.name,
          baseline: c.role === "baseline",
        }))}
      />

      <details className={styles.stats}>
        <summary>
          Statistics: significance tests, confidence intervals, per-requirement charts
        </summary>

        {rows.length ? (
          <>
            <h3 className={styles.subTitle}>By requirement</h3>
            <RequirementCharts report={report} />
          </>
        ) : null}

        {rows.length ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Requirement</th>
                  {setups.map((c) => (
                    <th scope="col" key={c.contender_id} className={styles.numCol}>
                      {c.name}
                      {c.role === "baseline" ? <small> baseline</small> : null}
                    </th>
                  ))}
                  <th scope="col">Verdict vs baseline (CI of the difference)</th>
                  <th scope="col">Smallest detectable difference</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.requirementId} data-requirement={row.requirementId}>
                    <th scope="row">
                      <span className={styles.reqTitle}>{row.title}</span>
                      <span className={styles.reqId}>
                        {row.requirementId} · {row.type}
                      </span>
                    </th>
                    {setups.map((c) => {
                      const cell = row.cells.find((x) => x.contenderId === c.contender_id);
                      return (
                        <td key={c.contender_id} className={styles.numCol}>
                          {cell ? (
                            <>
                              <span className={styles.value} data-gated={cell.gated || undefined}>
                                {cell.value}
                              </span>
                              <span className={styles.n}>
                                {cell.n !== null ? `n=${cell.n}` : "n=–"}
                                {cell.survivorship ? " · solved only" : ""}
                              </span>
                            </>
                          ) : (
                            <span className={styles.n}>–</span>
                          )}
                        </td>
                      );
                    })}
                    <td>
                      {row.verdicts.length ? (
                        <ul className={styles.verdicts}>
                          {row.verdicts.map((v) => (
                            <li key={v.contenderId}>
                              {row.verdicts.length > 1 || setups.length > 2 ? (
                                <span className={styles.who}>{v.name}: </span>
                              ) : null}
                              <span className={styles.verdict} data-verdict={v.verdict}>
                                {v.word}
                              </span>{" "}
                              <span className={styles.ci}>{v.ci}</span>
                              {v.claim === "these_tasks" ? (
                                <span className={styles.note}> on these {v.tasks} tasks only</span>
                              ) : null}
                              {v.downgraded ? (
                                <span className={styles.note}> (downgraded: {v.downgraded})</span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className={styles.n}>no comparison</span>
                      )}
                    </td>
                    <td>
                      {row.verdicts.length ? (
                        <ul className={styles.verdicts}>
                          {row.verdicts.map((v) => (
                            <li key={v.contenderId} className={styles.ci}>
                              {row.verdicts.length > 1 ? `${v.name}: ` : ""}
                              {v.mde}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className={styles.n}>–</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className={styles.empty}>No requirement was scored.</p>
        )}

        {report.per_task ? (
          <div className={styles.perTask} data-testid="results-per-task">
            <h3 className={styles.subTitle}>Per task</h3>
            {report.per_task.headline.map((h) => (
              <p key={h} className={styles.headline} data-testid="results-per-task-headline">
                {plain(h)}
              </p>
            ))}
            <p className={styles.note} data-testid="results-per-task-scope">
              {report.per_task.scope} Each task’s repeats are the unit; Holm across{" "}
              {report.per_task.family} task × requirement tests.
            </p>
            <TaskCharts report={report} />
            {taskRows.length ? (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th scope="col">Requirement</th>
                      <th scope="col">Task</th>
                      <th scope="col">Verdict vs baseline (CI of the difference)</th>
                      <th scope="col">Smallest detectable difference</th>
                    </tr>
                  </thead>
                  <tbody>
                    {taskRows.flatMap((row) =>
                      row.cells.map((cell, i) => (
                        <tr
                          key={`${row.requirementId}:${cell.contenderId}:${cell.workloadId}`}
                          data-requirement={row.requirementId}
                          data-task={cell.workloadId}
                        >
                          {i === 0 ? (
                            <th scope="row" rowSpan={row.cells.length}>
                              <span className={styles.reqTitle}>{row.title}</span>
                              <span className={styles.reqId}>{row.requirementId}</span>
                            </th>
                          ) : null}
                          <td>
                            {setups.length > 2 ? `${cell.name}: ` : ""}
                            {cell.workloadId}
                          </td>
                          <td>
                            <span className={styles.verdict} data-verdict={cell.verdict}>
                              on {cell.workloadId}: {cell.word}
                            </span>{" "}
                            <span className={styles.ci}>{cell.ci}</span>
                            {cell.downgraded ? (
                              <span className={styles.note}> (downgraded: {cell.downgraded})</span>
                            ) : null}
                          </td>
                          <td className={styles.ci}>{cell.mde}</td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        ) : null}
      </details>

      <TimeBreakdownSection
        runId={runId}
        names={Object.fromEntries(setups.map((c) => [c.contender_id, c.name]))}
      />

      <dl className={styles.facts}>
        {disclosure ? (
          <div>
            <dt>How the setups ran</dt>
            <dd data-testid="results-disclosure">{disclosure}</dd>
          </div>
        ) : null}
        <div>
          <dt>Proof</dt>
          <dd data-testid="results-proof">
            <span className={styles.tag} data-basis={proof.basis}>
              {proof.basis}
            </span>{" "}
            {proof.label}
            <span className={styles.ci}>
              {" "}
              · {proof.passed}/{proof.total} checks
            </span>
          </dd>
        </div>
      </dl>

      {report.postmortem ? (
        <div className={styles.postmortem}>
          <p className={styles.dt}>
            What went wrong on our side: {report.postmortem.stage}
            {report.postmortem.agent ? ` (${report.postmortem.agent})` : ""}
          </p>
          <p>{report.postmortem.explanation}</p>
          <pre>{report.postmortem.error}</pre>
        </div>
      ) : null}
    </div>
  );
}
