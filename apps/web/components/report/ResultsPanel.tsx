"use client";
// The Results section (TDM-103 [11.6]): the run's report from GET /runs/:id/report, through the
// web app's API client (lib/api.ts, the same-origin /api proxy). Headline verdict first, then one
// row per requirement with every setup's value and n, the verdict vs the baseline with the CI of
// the difference, and the smallest detectable difference. Then how the setups ran (disclosure)
// and the proof basis. No composite score anywhere.
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
import { describeApiError } from "../../lib/live/useLiveRun";
import { proofBasis, resultRows, splitAnswer } from "./model";
import styles from "./report.module.css";

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
}: {
  runId: string;
  runState: RunState | null;
  holdReason?: string | null;
  standalone?: boolean;
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
}: {
  runId: string;
  state: ResultsState;
  runState: RunState | null;
  holdReason?: string | null;
  standalone?: boolean;
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
        <ReportBody report={state.report} />
      )}
    </section>
  );
}

function ReportBody({ report }: { report: Report }) {
  const { headline, proofLabel, disclosure } = splitAnswer(report.answer);
  const proof = proofBasis(report, proofLabel);
  const rows = resultRows(report);
  const setups = report.contenders;

  return (
    <div className={styles.body}>
      <p className={styles.headline} data-testid="results-headline">
        {headline}
      </p>

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
