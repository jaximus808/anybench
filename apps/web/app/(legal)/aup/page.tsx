import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "../../../components/docs/LegalPage";
import { CONTACT_EMAIL } from "../../../components/docs/links";

export const metadata: Metadata = {
  title: "Acceptable use policy",
  description:
    "What you may and may not run on Anybench eval computers. Draft, pending founder and legal review.",
};

export default function AupPage() {
  return (
    <LegalPage
      path="/aup"
      title="Acceptable use policy"
      summary="Anybench runs your code on cloud computers we pay for. This policy says what that code, and your use of Anybench, may not do."
    >
      <section aria-labelledby="aup-never">
        <h2 id="aup-never">Never allowed</h2>
        <ul>
          <li>
            <strong>Cryptocurrency mining</strong>, or any other use of eval computers for work that
            is not the benchmark.
          </li>
          <li>
            <strong>Attacking or scanning anyone else.</strong> No port scans, vulnerability scans,
            brute-force attempts, denial-of-service or load tests against any system you do not own
            or have written permission to test. Load drivers (such as hey or k6) may only target the
            service running inside your own eval computer.
          </li>
          <li>
            <strong>Malware.</strong> No building, testing, storing or spreading malware,
            ransomware, botnet clients or exploit kits, and no phishing pages.
          </li>
          <li>
            <strong>Getting around limits.</strong> No attempts to escape an eval computer, avoid
            wall-clock, token, spend or concurrency caps, reach other customers&rsquo; data or our
            infrastructure, or open more than one account to collect extra signup credit.
          </li>
          <li>
            <strong>Illegal content</strong>, or content that infringes someone else&rsquo;s rights,
            including code or data you are not allowed to run or share.
          </li>
          <li>
            <strong>Spam and abuse</strong> sent from an eval computer: email, posts or messages to
            third parties.
          </li>
        </ul>
      </section>

      <section aria-labelledby="aup-eval">
        <h2 id="aup-eval">Rules for eval code</h2>
        <p>Your kit, adapters, workloads and the contenders they run must follow these rules.</p>
        <ul>
          <li>
            Do only what the benchmark needs. Network access should stay within the hosts the kit
            declares in <code>network.allow</code>; the runner records what each trial could reach.
          </li>
          <li>
            Do not tamper with the measurement: no editing gates, reference outputs or collectors
            from inside a trial, and no detecting the benchmark to behave differently than normal
            use would.
          </li>
          <li>
            Use only model keys and secrets that belong to you or that you are allowed to use, and
            list them by name in <code>secrets</code>. Never put a secret in the kit files; the
            proof checks reject a kit that contains one.
          </li>
          <li>
            Add a competitor as a contender only if its license lets you install and run it for
            benchmarking.
          </li>
          <li>
            Do not rely on anything surviving a trial. Your code runs on isolated computers created
            for your eval and destroyed when your trials finish.
          </li>
        </ul>
      </section>

      <section aria-labelledby="aup-publish">
        <h2 id="aup-publish">Publishing honestly</h2>
        <p>
          Do not publish a benchmark you know was rigged, for example one where a contender was set
          up to fail on purpose, and do not present a published result as saying more than it does.
          Every published benchmark shows all contenders and where each one breaks; keep it that way
          when you quote it.
        </p>
      </section>

      <section aria-labelledby="aup-enforce">
        <h2 id="aup-enforce">What we do about it</h2>
        <p>
          We may stop a trial or run, destroy its computers, withdraw a published benchmark, or
          suspend an account that breaks this policy, and we may report illegal activity. Where it
          is safe to, we will tell you why. See the <Link href="/terms">terms of service</Link>.
        </p>
        <p>
          To report abuse, email <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
        </p>
      </section>
    </LegalPage>
  );
}
