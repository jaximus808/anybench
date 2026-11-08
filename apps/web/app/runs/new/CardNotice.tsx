"use client";
// stripe-onboarding: on the New run screen, a signed-in user without a card sees one line pointing
// at the add-a-card step before they get to Go. Silent while loading, signed out, on any error, in
// BILLING_MODE=off, and once a card is on file.
import type { ApiClient, BillingSummary } from "@anybench/core";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "../../../lib/api";
import { useSession } from "../../../lib/session";
import styles from "./new-run.module.css";

export function needsCard(s: BillingSummary): boolean {
  if (s.mode === "off") return false;
  const card = s.account.payment_status === "ok" && s.account.has_payment_method;
  return !card && s.account.granted_remaining_micro_usd === 0n;
}

export function CardNotice({ client }: { client?: ApiClient }) {
  const session = useSession();
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (session.status !== "signed_in") return;
    let cancelled = false;
    (client ?? api()).billing.summary().then(
      (s) => !cancelled && setShow(needsCard(s)),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [session.status, client]);
  if (!show) return null;
  return (
    <p className={styles.notice} role="status" data-slot="card-notice">
      Add a card before you press Go: you&rsquo;re only charged for runs you start.{" "}
      <Link href="/billing">Add a card</Link>
    </p>
  );
}
