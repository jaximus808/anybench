"use client";
// TDM-225: the price on the Go screen, from GET /runs/:id/estimate (the same rules Go applies). A
// starter run reads "Free" with what the same run would normally cost, line by line; past a starter
// limit, or with free runs paused, it reads the normal price and says whether Go needs a card.
// Silent while loading and on any error: the Go screen then shows the run row's estimate as before.
import type { ApiClient, RunEstimate } from "@anybench/core";
import { useEffect, useState } from "react";
import { useLiveApi } from "../../lib/live/client";
import { estimateCopy } from "./estimate-copy";
import styles from "./live.module.css";

/** Fetch the run's estimate; refetches when `refresh` changes (e.g. the kit was edited). */
export function useRunEstimate(runId: string, refresh: unknown = null): RunEstimate | null {
  const client = useLiveApi();
  const [estimate, setEstimate] = useState<RunEstimate | null>(null);
  useEffect(() => {
    let live = true;
    loadEstimate(client, runId).then((e) => {
      if (live) setEstimate(e);
    });
    return () => {
      live = false;
    };
  }, [client, runId, refresh]);
  return estimate;
}

/** The estimate, or null on any failure (an older server, no kit yet, a network error). */
export async function loadEstimate(client: ApiClient, runId: string): Promise<RunEstimate | null> {
  try {
    const { estimate } = await client.runs.estimate({
      params: { id: runId as RunEstimate["run_id"] },
    });
    return estimate;
  } catch {
    return null;
  }
}

export function EstimateBreakdown({ estimate }: { estimate: RunEstimate }) {
  const copy = estimateCopy(estimate);
  return (
    <section
      className={styles.estimate}
      data-slot="run-estimate"
      data-price={copy.price}
      aria-label="Price"
    >
      <p className={styles.estimateSummary} data-testid="estimate-summary">
        {copy.summary}
        {copy.card ? (
          <>
            {" "}
            <span data-testid="estimate-card">{copy.card}</span>{" "}
            <a href={`/billing?run=${estimate.run_id}`}>Add a card</a>
          </>
        ) : null}
      </p>
      <h3 className={styles.estimateTitle}>{copy.linesTitle}</h3>
      <dl className={styles.estimateLines}>
        {copy.lines.map((l) => (
          <div key={l.key} data-line={l.key}>
            <dt>
              {l.label}
              {l.detail ? <small>{l.detail}</small> : null}
            </dt>
            <dd className="num">{l.amount}</dd>
          </div>
        ))}
      </dl>
      {copy.tokens ? (
        <p className={styles.estimateNote} data-testid="estimate-tokens">
          {copy.tokens}
        </p>
      ) : null}
      {copy.managed ? (
        <p className={styles.estimateNote} data-testid="estimate-managed">
          {copy.managed}
        </p>
      ) : null}
    </section>
  );
}
