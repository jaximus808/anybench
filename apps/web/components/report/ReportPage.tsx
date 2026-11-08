"use client";
// /runs/[id]/report (TDM-103 [11.6]): the Results section on its own, for sharing a finished run.
// Reads the run (state, hold reason) and the report through the web API client (lib/api.ts).
// The share panel (publish, link, badge, embed, X) sits under the results.
import { apiRoutes, type ApiClient, type Run, type RunId } from "@anybench/core";
import { useEffect, useState } from "react";
import { LiveApiContext, useLiveApi } from "../../lib/live/client";
import { describeApiError } from "../../lib/live/useLiveRun";
import styles from "../live/live.module.css";
import { SharePanel } from "../publish/SharePanel";
import { ResultsPanel, ResultsView } from "./ResultsPanel";

export function ReportPage({ runId, client }: { runId: string; client?: ApiClient }) {
  return (
    <LiveApiContext.Provider value={client ?? null}>
      <ReportLoader runId={runId} />
    </LiveApiContext.Provider>
  );
}

function ReportLoader({ runId }: { runId: string }) {
  const client = useLiveApi();
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    client
      .call(apiRoutes.runs.get, { params: { id: runId as RunId } })
      .then((d) => live && setRun(d.run))
      .catch((e: unknown) => live && setError(describeApiError(e)));
    return () => {
      live = false;
    };
  }, [client, runId]);

  return (
    <div className={styles.page}>
      <div className={styles.shell}>
        {run ? <h1 className={styles.question}>{run.question}</h1> : null}
        {error ? (
          <ResultsView runId={runId} state={{ kind: "error", message: error }} runState={null} />
        ) : run ? (
          <>
            <ResultsPanel
              runId={runId}
              runState={run.state}
              holdReason={run.paused_reason}
              standalone
            />
            <SharePanel runId={runId} runState={run.state} client={client} />
          </>
        ) : (
          <ResultsView runId={runId} state={{ kind: "loading" }} runState={null} standalone />
        )}
      </div>
    </div>
  );
}
