"use client";
// Onboarding (TDM-224, E20 launch pricing): the step after sign-up.
//
//   1. Your model key: an Anthropic or OpenAI key, stored write-only through PUT /secrets/:provider
//      (user_secrets, envelope-encrypted; the API only ever shows its last 4). A free run uses it.
//   2. Your free run: the billing summary's `free_run` says whether the account still has it
//      (available, in use, used, not eligible, or paused when the pool can't fund one).
//   3. A card, optional: the existing Stripe Checkout flow (POST /billing/link-card). Needed for
//      runs after the free one, or when free runs are paused.
//
// "Start your first run" goes to /runs/new whether or not a card is on file: Go decides, and says
// why when a run needs a card.
import type { ApiClient, BillingSummary } from "@anybench/core";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, apiErrorMessage } from "../../lib/api";
import { useSession } from "../../lib/session";
import { cardReady } from "../billing/BillingView";
import { ModelKeysSection } from "../settings/ModelKeysSection";
import { FreeRunNote } from "./FreeRunNote";
import styles from "../settings/settings.module.css";

export function WelcomeView({
  client: injected,
  navigate = (url: string) => window.location.assign(url),
}: {
  client?: ApiClient;
  /** Full-page navigation to Stripe (tests pass a recorder). */
  navigate?: (url: string) => void;
} = {}) {
  const session = useSession();
  const client = injected ?? api();
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);

  const load = useCallback(async () => {
    try {
      setSummary(await client.billing.summary());
    } catch {
      // The free-run line and card status are extras here: onboarding works without them.
      setSummary(null);
    }
  }, [client]);

  useEffect(() => {
    if (session.status === "signed_in") void load();
  }, [session.status, load]);

  const addCard = async () => {
    setLinking(true);
    setError(null);
    try {
      const { url } = await client.billing.linkCard({
        body: { success_path: "/billing?linked=1", cancel_path: "/welcome" },
      });
      navigate(url);
    } catch (err) {
      setError(apiErrorMessage(err));
      setLinking(false);
    }
  };

  if (session.status === "loading")
    return (
      <div className={`wrap ${styles.page}`}>
        <h1>Welcome to Anybench</h1>
        <p className="muted" role="status">
          Loading…
        </p>
      </div>
    );

  if (session.status === "signed_out")
    return (
      <div className={`wrap ${styles.page}`}>
        <h1>Welcome to Anybench</h1>
        <p>
          <Link href="/signin?redirect_to=%2Fwelcome">Sign in</Link> to set up your account. New
          here? <Link href="/signup">Create an account</Link>.
        </p>
      </div>
    );

  if (session.status === "error")
    return (
      <div className={`wrap ${styles.page}`}>
        <h1>Welcome to Anybench</h1>
        <p className={styles.error} role="alert">
          {session.message}
        </p>
      </div>
    );

  const free = summary?.free_run;
  const card = summary ? cardReady(summary) : false;
  const billingOff = summary?.mode === "off";

  return (
    <div className={`wrap ${styles.page}`}>
      <h1>
        {free?.status === "available" ? "Your first benchmark is free" : "Welcome to Anybench"}
      </h1>
      <p className="lede">
        Add your model key, then point Anybench at your repo. No card needed to start.
      </p>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      <ModelKeysSection onChange={() => void load()} />

      {free ? (
        <section className={styles.card} aria-labelledby="free-run-title">
          <h2 id="free-run-title">Your free run</h2>
          <FreeRunNote free={free} />
        </section>
      ) : null}

      {billingOff ? null : (
        <section className={styles.card} aria-labelledby="card-title" data-slot="card-optional">
          <h2 id="card-title">Payment card (optional)</h2>
          {card ? (
            <p role="status">Card on file. Runs after your free one are billed to it.</p>
          ) : (
            <>
              <p>
                You don&rsquo;t need a card for your free run. Add one for the runs after it: $2 per
                run plus compute at cost + 50%, billed monthly. Nothing is charged today.
              </p>
              <button
                type="button"
                className="btn btn-quiet"
                disabled={linking}
                onClick={() => void addCard()}
              >
                {linking ? "Opening Stripe…" : "Add a card"}
              </button>
            </>
          )}
        </section>
      )}

      <section className={styles.card} aria-labelledby="next-title">
        <h2 id="next-title">Next</h2>
        <Link className="btn" href="/runs/new">
          Start your first run
        </Link>
      </section>
    </div>
  );
}
