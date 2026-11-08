// Placeholder until [11.3] sign-in ships and the API is deployed ([13.10]). Keeps /signin from 404ing.
import type { Metadata } from "next";
import Link from "next/link";
import { EARLY_ACCESS_EMAIL } from "../../components/marketing/EarlyAccessForm";
import styles from "./signin.module.css";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Sign in · Anybench",
  description:
    "Anybench sign-in opens soon. Email us for early access and we'll run your first benchmark.",
};

export default function SignInPage() {
  return (
    <div className={`wrap ${styles.page}`}>
      <div className={styles.card}>
        <p className="eyebrow">Sign in</p>
        <h1>Sign-in opens soon</h1>
        <p className="lede">
          Accounts aren&rsquo;t open yet. We&rsquo;re running early benchmarks by hand while sign-in
          with GitHub is finished.
        </p>
        <p className="muted">
          Email <a href={`mailto:${EARLY_ACCESS_EMAIL}`}>{EARLY_ACCESS_EMAIL}</a> with the repo you
          want benchmarked and we&rsquo;ll run your first one.
        </p>
        <div className={styles.actions}>
          <a className="btn" href={`mailto:${EARLY_ACCESS_EMAIL}`}>
            Email for early access
          </a>
          <Link className="btn btn-quiet" href="/docs">
            Read the docs
          </Link>
        </div>
        <p className={styles.links}>
          <Link href="/">Back to the home page</Link>
        </p>
      </div>
    </div>
  );
}
