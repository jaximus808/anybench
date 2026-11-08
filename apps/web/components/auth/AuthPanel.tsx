"use client";
// The /signin and /signup card (TDM-100). Sign-up is open to anyone: the API creates the account
// on the first GitHub sign-in, so both pages start the same OAuth round trip and land on a
// same-origin `?redirect_to=` (else POST_SIGN_IN_PATH). The email-and-password form ([17.2]) goes in
// the marked slot below.
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  githubSignInUrl,
  POST_SIGN_IN_PATH,
  POST_SIGN_UP_PATH,
  safeRedirectPath,
} from "../../lib/api";
import { useSession } from "../../lib/session";
import styles from "./AuthPanel.module.css";

export type AuthMode = "signin" | "signup";

const COPY: Record<AuthMode, { title: string; lede: string; cta: string }> = {
  signin: {
    title: "Sign in to Anybench",
    lede: "Pick up where you left off: your runs, reports and keys.",
    cta: "Continue with GitHub",
  },
  signup: {
    title: "Create your Anybench account",
    lede: "Benchmark your agent, harness or software against the alternatives. Free to start.",
    cta: "Continue with GitHub",
  },
};

/** Messages for the `auth_error` query the API adds when GitHub sign-in fails. */
const AUTH_ERRORS: Record<string, string> = {
  access_denied: "GitHub sign-in was cancelled. Try again when you're ready.",
};

export function authErrorMessage(code: string | null): string | null {
  if (!code) return null;
  return AUTH_ERRORS[code] ?? "GitHub sign-in didn't complete. Try again.";
}

export function AuthPanel({ mode }: { mode: AuthMode }) {
  const session = useSession();
  const [authError, setAuthError] = useState<string | null>(null);
  // Sign-up lands on the add-a-card step (/billing?welcome=1) unless a redirect_to says otherwise.
  const fallback = mode === "signup" ? POST_SIGN_UP_PATH : POST_SIGN_IN_PATH;
  const [redirectTo, setRedirectTo] = useState<string>(fallback);
  const copy = COPY[mode];

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setAuthError(authErrorMessage(q.get("auth_error")));
    const raw = q.get("redirect_to");
    setRedirectTo(raw ? safeRedirectPath(raw, window.location.origin) : fallback);
  }, [fallback]);

  return (
    <section className={styles.panel} aria-labelledby="auth-title">
      <h1 id="auth-title" className={styles.title}>
        {copy.title}
      </h1>
      <p className={styles.lede}>{copy.lede}</p>

      {session.status === "signed_in" ? (
        <p className={styles.notice} role="status">
          You&rsquo;re signed in as <strong>{session.user.github_login}</strong>.{" "}
          <Link href={POST_SIGN_IN_PATH}>Start a new run</Link> or{" "}
          <Link href="/settings">open settings</Link>.
        </p>
      ) : null}
      {session.status === "error" ? (
        <p className={styles.error} role="alert">
          {session.message}
          {session.unreachable ? " Sign-in won't work until it's back." : null}
        </p>
      ) : null}
      {authError ? (
        <p className={styles.error} role="alert">
          {authError}
        </p>
      ) : null}

      <div className={styles.providers}>
        <a className={`btn ${styles.github}`} href={githubSignInUrl(redirectTo)}>
          <GitHubIcon />
          {copy.cta}
        </a>
      </div>

      {/* [17.2] email-and-password form slot: render <EmailForm mode={mode} /> here. */}
      <div className={styles.emailSlot} data-slot="email-form" data-mode={mode} />

      <p className={styles.switch}>
        {mode === "signin" ? (
          <>
            New to Anybench? <Link href="/signup">Create an account</Link>
          </>
        ) : (
          <>
            Already have an account? <Link href="/signin">Sign in</Link>
          </>
        )}
      </p>
      <p className={styles.legal}>
        By continuing you agree to the <Link href="/terms">Terms</Link> and{" "}
        <Link href="/privacy">Privacy Policy</Link>.
      </p>
    </section>
  );
}

function GitHubIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
