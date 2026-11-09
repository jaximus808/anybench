"use client";
// stripe-onboarding: on the New run screen, a signed-in user without a card sees one line pointing
// at the add-a-card step before they get to Go. Silent while loading, signed out, on any error, in
// BILLING_MODE=off, and once a card is on file. TDM-224: an account that still has its free run
// needs no card for it, so it sees the free-run line instead (and a nudge to add a model key).
import type { ApiClient, BillingSummary } from "@anybench/core";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "../../../lib/api";
import { useSession } from "../../../lib/session";
import styles from "./new-run.module.css";

export function needsCard(s: BillingSummary): boolean {
  if (s.mode === "off") return false;
  if (s.free_run?.status === "available") return false;
  const card = s.account.payment_status === "ok" && s.account.has_payment_method;
  return !card && s.account.granted_remaining_micro_usd === 0n;
}

export function CardNotice({ client }: { client?: ApiClient }) {
  const session = useSession();
  const [show, setShow] = useState<"card" | "free" | "free_needs_key" | null>(null);
  useEffect(() => {
    if (session.status !== "signed_in") return;
    let cancelled = false;
    (client ?? api()).billing.summary().then(
      (s) => {
        if (cancelled) return;
        if (s.mode !== "off" && s.free_run?.status === "available") {
          setShow(s.free_run.has_model_key ? "free" : "free_needs_key");
        } else setShow(needsCard(s) ? "card" : null);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [session.status, client]);
  if (!show) return null;
  if (show !== "card")
    return (
      <p className={styles.notice} role="status" data-slot="free-run-notice">
        Your first benchmark is free: no card needed.
        {show === "free_needs_key" ? (
          <>
            {" "}
            It runs on your own model key:{" "}
            <Link href="/settings">add your Anthropic or OpenAI key</Link>.
          </>
        ) : null}
      </p>
    );
  return (
    <p className={styles.notice} role="status" data-slot="card-notice">
      Add a card before you press Go: you&rsquo;re only charged for runs you start.{" "}
      <Link href="/billing">Add a card</Link>
    </p>
  );
}
