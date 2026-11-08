"use client";
// The Go bar (stripe-onboarding): while a run waits in `awaiting_go`, press Go here. The server's
// billing gate answers 402 {reason, link_card_url} when no card is on file; the bar then links to
// the billing page for this run (which can press Go itself once the card is saved). Admin runs are
// comped by the gate (founder demo) and simply start.
import { ApiClientError, type RunId } from "@anybench/core";
import { useState } from "react";
import { apiErrorMessage } from "../../lib/api";
import { useLiveApi } from "../../lib/live/client";
import { saveSettings } from "../../lib/session";
import { usd } from "./format";
import styles from "./live.module.css";

export type GoFailure =
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

export interface GoAction {
  busy: boolean;
  started: boolean;
  failure: GoFailure | null;
  go: () => Promise<void>;
}

/** Press Go: POST /runs/:id/go, with the billing gate's 402 turned into a card link. */
export function useGoAction(runId: string): GoAction {
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
  return { busy, started, failure, go };
}

/** What to say about a failed Go (or null when there is nothing wrong). */
export function GoFailureText({ failure }: { failure: GoFailure | null }) {
  if (!failure) return null;
  if (failure.kind === "payment")
    return (
      <>
        {PAYMENT_WORDS[failure.reason] ?? "Billing needs attention before this run can start."}{" "}
        <a href={failure.href}>Add a card</a>
      </>
    );
  return <>{failure.text}</>;
}

/**
 * "Go, and don't ask again": press Go, and turn on Settings' "Start runs automatically"
 * (auto_start_runs) so future runs skip this bar; `undo` turns it back off.
 */
export function useDontAskAgain(go: () => Promise<void>) {
  const client = useLiveApi();
  const [remembered, setRemembered] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = async (value: boolean) => {
    setError(null);
    try {
      await saveSettings({ auto_start_runs: value }, client);
      setRemembered(value);
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };
  const goAndRemember = async () => {
    await Promise.all([go(), save(true)]);
  };
  return { remembered, error, goAndRemember, undo: () => save(false) };
}

export function GoBar({ runId, estimate }: { runId: string; estimate: bigint | null }) {
  const { busy, started, failure, go } = useGoAction(runId);
  const remember = useDontAskAgain(go);
  return (
    <div className={styles.alert} data-slot="go-bar" role="region" aria-label="Start the run">
      <span className={styles.alertSev}>go</span>
      <span className={styles.alertMsg}>
        {started ? (
          "Starting the run…"
        ) : failure ? (
          <GoFailureText failure={failure} />
        ) : (
          `The test plan is ready.${estimate !== null ? ` Estimated cost ${usd(estimate)}.` : ""} Press Go to start.`
        )}
      </span>
      {started ? null : (
        <button type="button" onClick={() => void go()} disabled={busy}>
          {busy ? "Starting…" : "Go"}
        </button>
      )}
      <span data-slot="go-remember">
        {remember.error ? (
          remember.error
        ) : remember.remembered ? (
          <>
            Future runs start automatically ·{" "}
            <a
              href="#undo"
              onClick={(e) => {
                e.preventDefault();
                void remember.undo();
              }}
            >
              undo
            </a>
          </>
        ) : remember.remembered === false ? (
          "Future runs wait for Go"
        ) : started ? null : (
          <a
            href="#go-dont-ask"
            aria-disabled={busy}
            onClick={(e) => {
              e.preventDefault();
              if (!busy) void remember.goAndRemember();
            }}
          >
            Go, and don&rsquo;t ask again
          </a>
        )}
      </span>
    </div>
  );
}
