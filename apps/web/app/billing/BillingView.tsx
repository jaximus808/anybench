"use client";
// Billing (stripe-onboarding, plan.md section 8): where the run gate's 402 "Add a card" link lands
// (/settings/billing redirects here). Since TDM-224 sign-up lands on /welcome instead (the first
// benchmark is free, the card optional); this page also shows whether the free run is left.
//
//   ?run=<id>    a run is waiting on the card: once it is saved, "Start your run" presses Go.
//   ?linked=1    back from Stripe Checkout: poll the summary until the card shows (the server
//                re-reads Stripe, so this works even while the webhook is on its way).
//
// Adding a card opens Stripe Checkout (mode subscription, the metered usage price): $0 today,
// usage billed monthly. Nothing here ever charges a card.
import {
  ApiClientError,
  RunIdSchema,
  type ApiClient,
  type BillingSummary,
  type RunId,
} from "@anybench/core";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { usd } from "../../components/live/format";
import { api, apiErrorMessage } from "../../lib/api";
import { useSession } from "../../lib/session";
import styles from "../settings/settings.module.css";
import { FreeRunNote } from "../welcome/FreeRunNote";

/** How long to wait for Stripe to confirm a card after Checkout returns. */
const LINK_POLL_MS = 2_000;
const LINK_POLL_TRIES = 20;

interface Params {
  linked: boolean;
  runId: RunId | null;
}

function readParams(): Params {
  if (typeof window === "undefined") return { linked: false, runId: null };
  const q = new URLSearchParams(window.location.search);
  const run = RunIdSchema.safeParse(q.get("run"));
  return {
    linked: q.get("linked") === "1",
    runId: run.success ? run.data : null,
  };
}

export function cardReady(s: BillingSummary): boolean {
  return s.account.payment_status === "ok" && s.account.has_payment_method;
}

const GO_REFUSALS: Record<string, string> = {
  no_payment_method: "Stripe hasn't confirmed your card yet. Wait a few seconds and try again.",
  insufficient_credit: "Your credit doesn't cover this run. Add a card to continue.",
  payment_past_due: "Your last payment failed. Update your card, then try again.",
  account_blocked: "Your account is on hold. Contact support.",
  spend_limit: "This run would take you over the spend limit for new accounts.",
  daily_cap: "You've reached today's spend cap. Try again tomorrow.",
};

export function BillingView({
  client: injected,
  navigate = (url: string) => window.location.assign(url),
}: {
  client?: ApiClient;
  /** Full-page navigation to Stripe (tests pass a recorder). */
  navigate?: (url: string) => void;
} = {}) {
  const session = useSession();
  const router = useRouter();
  const client = injected ?? api();
  const [params, setParams] = useState<Params>({ linked: false, runId: null });
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"link" | "portal" | "go" | null>(null);
  const [waiting, setWaiting] = useState(false);

  useEffect(() => setParams(readParams()), []);

  const load = useCallback(async () => {
    try {
      const s = await client.billing.summary();
      setSummary(s);
      setError(null);
      return s;
    } catch (err) {
      setError(apiErrorMessage(err));
      return null;
    }
  }, [client]);

  useEffect(() => {
    if (session.status !== "signed_in") return;
    let cancelled = false;
    void (async () => {
      let s = await load();
      if (!params.linked || cancelled) return;
      // Back from Checkout: Stripe confirms the card within seconds.
      setWaiting(true);
      for (let i = 0; i < LINK_POLL_TRIES && s && !cardReady(s) && !cancelled; i++) {
        await new Promise((r) => setTimeout(r, LINK_POLL_MS));
        s = await load();
      }
      if (!cancelled) setWaiting(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [session.status, params.linked, load]);

  const returnQuery = params.runId ? `run=${params.runId}` : "";
  const addCard = async () => {
    setBusy("link");
    setError(null);
    try {
      const { url } = await client.billing.linkCard({
        body: {
          success_path: `/billing?linked=1${returnQuery ? `&${returnQuery}` : ""}`,
          cancel_path: `/billing${returnQuery ? `?${returnQuery}` : ""}`,
        },
      });
      navigate(url);
    } catch (err) {
      setError(apiErrorMessage(err));
      setBusy(null);
    }
  };

  const openPortal = async () => {
    setBusy("portal");
    setError(null);
    try {
      const { url } = await client.billing.portal({
        body: { return_path: `/billing${returnQuery ? `?${returnQuery}` : ""}` },
      });
      navigate(url);
    } catch (err) {
      setError(apiErrorMessage(err));
      setBusy(null);
    }
  };

  const startRun = async (runId: RunId) => {
    setBusy("go");
    setError(null);
    try {
      await client.runs.go({ params: { id: runId } });
      router.push(`/runs/${runId}`);
    } catch (err) {
      if (err instanceof ApiClientError && err.paymentRequired) {
        setError(GO_REFUSALS[err.paymentRequired.reason] ?? "The run can't start yet.");
      } else if (err instanceof ApiClientError && err.status === 409) {
        setError("This run can't start right now. Open it to see why.");
      } else {
        setError(apiErrorMessage(err));
      }
      setBusy(null);
    }
  };

  if (session.status === "loading" || (session.status === "signed_in" && !summary && !error))
    return (
      <div className={`wrap ${styles.page}`}>
        <h1>Billing</h1>
        <p className="muted" role="status">
          Loading your billing…
        </p>
      </div>
    );

  if (session.status === "signed_out")
    return (
      <div className={`wrap ${styles.page}`}>
        <h1>Billing</h1>
        <p>
          <Link href="/signin?redirect_to=%2Fbilling">Sign in</Link> to add a card. New here?{" "}
          <Link href="/signup">Create an account</Link>.
        </p>
      </div>
    );

  if (session.status === "error")
    return (
      <div className={`wrap ${styles.page}`}>
        <h1>Billing</h1>
        <p className={styles.error} role="alert">
          {session.message}
        </p>
      </div>
    );

  const ready = summary ? cardReady(summary) : false;
  const status = summary?.account.payment_status ?? "none";

  return (
    <div className={`wrap ${styles.page}`}>
      <h1>Billing</h1>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      <section className={styles.card} aria-labelledby="card-title" data-slot="card-status">
        <h2 id="card-title">Payment card</h2>
        {ready ? (
          <>
            <p role="status">Card on file. You can start runs.</p>
            <button
              type="button"
              className="btn btn-quiet"
              disabled={busy !== null}
              onClick={openPortal}
            >
              {busy === "portal" ? "Opening Stripe…" : "Manage card and invoices"}
            </button>
          </>
        ) : status === "past_due" ? (
          <>
            <p role="status">Your last payment failed. Update your card to start new runs.</p>
            <button type="button" className="btn" disabled={busy !== null} onClick={openPortal}>
              {busy === "portal" ? "Opening Stripe…" : "Update card"}
            </button>
          </>
        ) : status === "blocked" ? (
          <p role="status">Your account is on hold. Contact support to start new runs.</p>
        ) : waiting ? (
          <p role="status">Confirming your card with Stripe…</p>
        ) : (
          <>
            <p>
              No card yet. Stripe saves it securely; Anybench never sees the number. Nothing is
              charged today.
            </p>
            <button type="button" className="btn" disabled={busy !== null} onClick={addCard}>
              {busy === "link" ? "Opening Stripe…" : "Add a card"}
            </button>
          </>
        )}
        {summary?.mode === "test" ? (
          <p className="muted" data-slot="test-mode">
            Test mode: no real money moves. Use card 4242 4242 4242 4242, any future date, any CVC.
          </p>
        ) : null}
      </section>

      {summary?.free_run && summary.mode !== "off" ? (
        <section className={styles.card} aria-labelledby="free-run-title">
          <h2 id="free-run-title">Your free run</h2>
          <FreeRunNote free={summary.free_run} />
        </section>
      ) : null}

      {params.runId ? (
        <section className={styles.card} aria-labelledby="run-title">
          <h2 id="run-title">Your run is waiting</h2>
          {ready ? (
            <button
              type="button"
              className="btn"
              disabled={busy !== null}
              onClick={() => void startRun(params.runId!)}
            >
              {busy === "go" ? "Starting…" : "Start your run"}
            </button>
          ) : (
            <p>Add a card above, then start it from here.</p>
          )}{" "}
          <Link href={`/runs/${params.runId}`}>Open the run</Link>
        </section>
      ) : ready ? (
        <section className={styles.card} aria-labelledby="next-title">
          <h2 id="next-title">Next</h2>
          <Link className="btn" href="/runs/new">
            Start a new run
          </Link>
        </section>
      ) : null}

      <section className={styles.card} aria-labelledby="price-title">
        <h2 id="price-title">How you&rsquo;re billed</h2>
        <ul>
          <li>$2 per benchmark run, plus eval computer time at cost + 50%.</li>
          <li>You see the estimate before you press Go.</li>
          <li>If our pipeline or infrastructure fails the run, you pay nothing.</li>
          <li>If you cancel a run, you pay for the computer time used, not the run fee.</li>
          <li>
            Usage is invoiced monthly, or early once it reaches{" "}
            {summary ? usd(summary.account.invoice_threshold_micro_usd, 0) : "$50"}.
          </li>
        </ul>
        {summary ? (
          <p className="muted" data-slot="usage">
            This month: <span className="num">{usd(summary.period.usage_micro_usd)}</span> · not yet
            invoiced: <span className="num">{usd(summary.account.unbilled_micro_usd)}</span>
            {summary.account.granted_remaining_micro_usd > 0n ? (
              <>
                {" "}
                · credit left:{" "}
                <span className="num">{usd(summary.account.granted_remaining_micro_usd)}</span>
              </>
            ) : null}{" "}
            · new-account limit:{" "}
            <span className="num">{usd(summary.account.spend_limit_micro_usd, 0)}</span>
          </p>
        ) : null}
      </section>
    </div>
  );
}
