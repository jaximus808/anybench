"use client";
// The signed-in user's runs (runs.list), paged by cursor. Signed out → /signin.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ApiClientError, formatUsd, type ApiClient, type Run, type RunState } from "@anybench/core";
import { api } from "../../lib/api";
import { questionTitle } from "../../lib/question-title";
import styles from "./new/new-run.module.css";

const SIGNIN_RUNS = `/signin?redirect_to=${encodeURIComponent("/runs")}`;

export function RunsList({ client: injected }: { client?: ApiClient }) {
  const router = useRouter();
  const client = injected ?? api();
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (after: string | null) => {
      setLoading(true);
      try {
        const page = await client.runs.list({ query: after ? { cursor: after } : {} });
        setRuns((prev) => (after && prev ? [...prev, ...page.items] : page.items));
        setCursor(page.next_cursor);
        setError(null);
      } catch (err) {
        if (err instanceof ApiClientError && err.status === 401) {
          router.replace(SIGNIN_RUNS);
          return;
        }
        setError("Couldn't load your runs. Try again in a moment.");
      } finally {
        setLoading(false);
      }
    },
    [client, router],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  if (error && !runs)
    return (
      <p className={styles.errors} role="alert">
        {error}
      </p>
    );
  if (!runs) return <p className={styles.status}>Loading your runs…</p>;
  if (runs.length === 0)
    return (
      <div className={styles.empty}>
        <p>No runs yet.</p>
        <Link href="/runs/new" className="btn">
          Start your first run
        </Link>
      </div>
    );
  return (
    <>
      <ul className={styles.list}>
        {runs.map((r) => (
          <li key={r.id} className={styles.item}>
            <Link href={`/runs/${r.id}`}>{firstLine(r.question)}</Link>
            <span className={styles.state} data-tone={stateTone(r.state)}>
              {r.state.replace(/_/g, " ")}
            </span>
            <span className={styles.meta}>
              {formatUsd(r.spent_micro_usd)} of {formatUsd(r.budget_micro_usd)} ·{" "}
              <time dateTime={r.created_at}>{r.created_at.slice(0, 10)}</time>
            </span>
          </li>
        ))}
      </ul>
      {error && (
        <p className={styles.errors} role="alert">
          {error}
        </p>
      )}
      {cursor && (
        <p>
          <button
            type="button"
            className="btn btn-quiet"
            disabled={loading}
            onClick={() => void load(cursor)}
          >
            {loading ? "Loading…" : "Load more"}
          </button>
        </p>
      )}
    </>
  );
}

export type StateTone = "active" | "passed" | "failed" | "infra" | "muted";

/** Colour means state (docs/design/design-system.md): orange only while work is live. */
export function stateTone(state: RunState): StateTone {
  switch (state) {
    case "delivered":
      return "passed";
    case "failed":
      return "failed";
    case "cancelled":
      return "infra";
    case "awaiting_go":
    case "needs_human":
    case "paused_budget":
      return "muted";
    default:
      return "active";
  }
}

function firstLine(question: string): string {
  const title = questionTitle(question);
  return title.split("\n", 1)[0] ?? title;
}
