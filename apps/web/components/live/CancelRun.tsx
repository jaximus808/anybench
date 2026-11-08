"use client";
// Cancel a run from its page (POST /runs/:id/cancel). Two clicks: "Cancel run", then "Yes, cancel".
// The worker stops sessions and destroys computers; a user cancel bills compute used, no run fee.
import type { RunId } from "@anybench/core";
import { useState } from "react";
import { apiErrorMessage } from "../../lib/api";
import { useLiveApi } from "../../lib/live/client";
import styles from "./live.module.css";

export function CancelRun({
  runId,
  confirmFirst = false,
  onKeep,
}: {
  runId: string;
  /** Open straight on "Yes, cancel" (the run menu's item already asked once). */
  confirmFirst?: boolean;
  /** "Keep it" when opened from a menu: close the menu instead of going back to idle. */
  onKeep?: () => void;
}) {
  const client = useLiveApi();
  const [phase, setPhase] = useState<"idle" | "confirm" | "busy" | "done">(
    confirmFirst ? "confirm" : "idle",
  );
  const [error, setError] = useState<string | null>(null);

  const cancel = async () => {
    setPhase("busy");
    setError(null);
    try {
      await client.runs.cancel({
        params: { id: runId as RunId },
        body: { reason: "cancelled from the run page" },
      });
      setPhase("done");
    } catch (err) {
      setError(apiErrorMessage(err));
      setPhase("confirm");
    }
  };

  if (phase === "done")
    return (
      <p className={styles.alert} data-slot="cancel-run" role="status">
        <span className={styles.alertMsg}>Cancelling: stopping agents and computers…</span>
      </p>
    );

  return (
    <div className={styles.alert} data-slot="cancel-run" data-sev="warn">
      <span className={styles.alertMsg}>
        {phase === "idle"
          ? "Want to stop this run?"
          : (error ?? "Cancel this run? Computer time used so far is billed; no run fee.")}
      </span>
      {phase === "idle" ? (
        <button type="button" onClick={() => setPhase("confirm")}>
          Cancel run
        </button>
      ) : (
        <>
          <button type="button" onClick={() => void cancel()} disabled={phase === "busy"}>
            {phase === "busy" ? "Cancelling…" : "Yes, cancel"}
          </button>
          <button
            type="button"
            onClick={() => (onKeep ? onKeep() : setPhase("idle"))}
            disabled={phase === "busy"}
          >
            Keep it
          </button>
        </>
      )}
    </div>
  );
}
