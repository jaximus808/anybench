// Placeholder until [11.3] sign-in ships and the API is deployed ([13.10]). Keeps /signin from 404ing.
import type { Metadata } from "next";
import Link from "next/link";
import { EARLY_ACCESS_EMAIL } from "../../components/marketing/EarlyAccessForm";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Sign in · Anybench",
  description:
    "Anybench sign-in opens soon. Email us for early access and we'll run your first benchmark.",
};

export default function SignInPage() {
  return (
    <main id="main" style={{ maxWidth: "36rem", margin: "0 auto", padding: "6rem 1rem" }}>
      <h1>Sign-in opens soon</h1>
      <p>
        Accounts aren&rsquo;t open yet. We&rsquo;re running early benchmarks by hand while sign-in
        with GitHub is finished.
      </p>
      <p>
        Email <a href={`mailto:${EARLY_ACCESS_EMAIL}`}>{EARLY_ACCESS_EMAIL}</a> with the repo you
        want benchmarked and we&rsquo;ll run your first one.
      </p>
      <p>
        <Link href="/">Back to the home page</Link> · <Link href="/docs">Read the docs</Link>
      </p>
    </main>
  );
}
