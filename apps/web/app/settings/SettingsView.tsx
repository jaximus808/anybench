"use client";
import Link from "next/link";
import { useState } from "react";
import { apiErrorMessage, POST_SIGN_IN_PATH } from "../../lib/api";
import { signOut, useSession } from "../../lib/session";
import { ApiKeysSection } from "./ApiKeysSection";
import { ModelKeysSection } from "./ModelKeysSection";
import { RunStartSection } from "./RunStartSection";
import styles from "./settings.module.css";

export function SettingsView() {
  const session = useSession();

  if (session.status === "loading")
    return (
      <div className={`wrap ${styles.page}`}>
        <h1>Settings</h1>
        <p className="muted" role="status">
          Loading your account…
        </p>
      </div>
    );

  if (session.status === "error")
    return (
      <div className={`wrap ${styles.page}`}>
        <h1>Settings</h1>
        <p className={styles.error} role="alert">
          {session.message}
        </p>
      </div>
    );

  if (session.status === "signed_out")
    return (
      <div className={`wrap ${styles.page}`}>
        <h1>Settings</h1>
        <p>
          <Link href="/signin">Sign in</Link> to manage your API keys and model keys. New here?{" "}
          <Link href="/signup">Create an account</Link>.
        </p>
      </div>
    );

  const { user, settings } = session;
  return (
    <div className={`wrap ${styles.page}`}>
      <h1>Settings</h1>
      <section className={styles.card} aria-labelledby="account-title">
        <h2 id="account-title">Account</h2>
        <div className={styles.account}>
          {user.avatar_url ? (
            <img src={user.avatar_url} alt="" width={40} height={40} className={styles.avatar} />
          ) : null}
          <div>
            <strong>{user.github_login}</strong>
            {user.email ? <div className="muted">{user.email}</div> : null}
          </div>
          <div className={styles.accountActions}>
            <Link className="btn" href={POST_SIGN_IN_PATH}>
              New run
            </Link>
            <SignOutButton />
          </div>
        </div>
      </section>
      <section className={styles.card} aria-labelledby="billing-title">
        <h2 id="billing-title">Billing</h2>
        <p>
          Your card, this month&rsquo;s usage and invoices.{" "}
          <Link href="/billing">Open billing</Link>
        </p>
      </section>
      <RunStartSection settings={settings} />
      <ApiKeysSection />
      <ModelKeysSection />
    </div>
  );
}

function SignOutButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className="btn btn-quiet"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await signOut();
            window.location.assign("/");
          } catch (err) {
            setError(apiErrorMessage(err));
            setBusy(false);
          }
        }}
      >
        {busy ? "Signing out…" : "Sign out"}
      </button>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
