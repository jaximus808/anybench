"use client";
// The Go bar (stripe-onboarding): while a run waits in `awaiting_go`, press Go here. The server's
// billing gate answers 402 {reason, link_card_url} when no card is on file; the bar then links to
// the billing page for this run (which can press Go itself once the card is saved). Admin runs are
// comped by the gate (founder demo) and simply start.
import { ApiClientError, type RunId } from "@anybench/core";
import { useState } from "react";
import { apiErrorMessage } from "../../lib/api";
import { useLiveApi } from "../../lib/live/client";
import { usd } from "./format";
import styles from "./live.module.css";

type GoFailure =
  { kind: "payment"; href: string; reason: string } | { kind: "message"; text: string };

const PAYMENT_WORDS: Record<string, string> = {
  no_payment_method: "Add a card to start this run. You aren't charged until it runs.",
  insufficient_credit: "Your credit doesn't cover this run. Add a card to start it.",
  payment_past_due: "Your last payment failed. Update your card to start this run.",
  account_blocked: "Your account is on hold. Contact support.",
  spend_limit: "This run would pass the spend limit for new accounts.",
  daily_cap: "You've reached today's spend cap.",
};

/** The 402's link when it is https on any host, else our own billing page for this run. */
export function goCardHref(linkCardUrl: string, runId: string): string {
  try {
    if (new URL(linkCardUrl).protocol === "https:") return linkCardUrl;
  } catch {
    // fall through
  }
  return `/billing?run=${runId}`;
}

export function GoBar({ runId, estimate }: { runId: string; estimate: bigint | null }) {
  const client = useLiveApi();
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const [failure, setFailure] = useState<GoFailure | null>(null);

  const go = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await client.runs.go({ params: { id: runId as RunId } });
      setStarted(true);
    } catch (err) {
      if (err instanceof ApiClientError && err.paymentRequired) {
        setFailure({
          kind: "payment",
          href: goCardHref(err.paymentRequired.link_card_url, runId),
          reason: err.paymentRequired.reason,
        });
      } else {
        setFailure({ kind: "message", text: apiErrorMessage(err) });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.alert} data-slot="go-bar" role="region" aria-label="Start the run">
      <span className={styles.alertSev}>go</span>
      <span className={styles.alertMsg}>
        {started ? (
          "Starting the run…"
        ) : failure?.kind === "payment" ? (
          <>
            {PAYMENT_WORDS[failure.reason] ?? "Billing needs attention before this run can start."}{" "}
            <a href={failure.href}>Add a card</a>
          </>
        ) : failure?.kind === "message" ? (
          failure.text
        ) : (
          `The test plan is ready.${estimate !== null ? ` Estimated cost ${usd(estimate)}.` : ""} Press Go to start.`
        )}
      </span>
      {started ? null : (
        <button type="button" onClick={() => void go()} disabled={busy}>
          {busy ? "Starting…" : "Go"}
        </button>
      )}
    </div>
  );
}
