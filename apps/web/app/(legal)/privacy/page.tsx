import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "../../../components/docs/LegalPage";
import { Placeholder, TableWrap } from "../../../components/docs/Notices";
import { RETENTION_ROWS } from "../../../components/docs/retention";

export const metadata: Metadata = {
  title: "Privacy policy",
  description:
    "What Anybench collects, why, who processes it and how long it is kept. Draft, pending founder and legal review.",
};

export default function PrivacyPage() {
  return (
    <LegalPage
      path="/privacy"
      title="Privacy policy"
      summary="What we collect when you use Anybench, why we need it, who processes it for us, and how long we keep it."
    >
      <section aria-labelledby="privacy-collect">
        <h2 id="privacy-collect">What we collect</h2>
        <ul>
          <li>
            <strong>Your GitHub profile</strong> when you sign in: login, numeric id, the date the
            account was created (used to decide whether a free credit grant applies) and your email
            address.
          </li>
          <li>
            <strong>What you submit</strong>: repository links, binaries and docs, Claude Code
            setups (<code>CLAUDE.md</code>, <code>.claude/</code>, <code>.mcp.json</code>), and the
            kits, workloads and settings you write or edit.
          </li>
          <li>
            <strong>What your runs produce</strong>: trial outputs, metrics, logs, transcripts of
            the agent under test, gate results, reports and machine information.
          </li>
          <li>
            <strong>Model keys you bring</strong>: stored encrypted. See{" "}
            <a href="#privacy-keys">model keys</a>.
          </li>
          <li>
            <strong>Billing records</strong>: Stripe holds your card. We keep your Stripe customer
            id, payment status, usage records, credit grants and invoices.
          </li>
          <li>
            <strong>Embed and badge counts</strong>: for published benchmarks we count views and
            clicks per day and per referring website. We do not track who the viewer is.
          </li>
          <li>
            <strong>Service logs</strong>: request logs and error reports, with secrets, auth
            headers and cookies removed before they are stored.
          </li>
        </ul>
      </section>

      <section aria-labelledby="privacy-use">
        <h2 id="privacy-use">How we use it</h2>
        <ul>
          <li>
            To run your evals: our AI agents read your project to understand it, find what to
            compare it against and write the kit; eval computers run the trials; reviewer and
            investigator agents score and explain the results.
          </li>
          <li>To bill you, prevent abuse, and keep the service secure and working.</li>
          <li>To send you run notices and alerts you asked for, and service messages.</li>
          <li>
            We do not sell your data, and we do not use your private code or results to market
            Anybench without your permission.
          </li>
        </ul>
      </section>

      <section aria-labelledby="privacy-isolation">
        <h2 id="privacy-isolation">Where your code runs</h2>
        <p>
          Each trial runs on its own isolated cloud computer, which is destroyed when the trial
          ends. Correctness gates run on a separate scoring computer that never ran your code. Trial
          outputs move between them through our private object storage with short-lived signed
          links.
        </p>
      </section>

      <section aria-labelledby="privacy-keys">
        <h2 id="privacy-keys">Model keys</h2>
        <p>
          Keys you store for the agent under test are encrypted at rest with a per-key data key
          (AES-256-GCM) that is itself wrapped by a master key. The API is write-only: we never show
          a key back to you, only its last four characters. A key is decrypted only right before a
          trial, written to that trial&rsquo;s computer as a private file, and never put on a
          command line or in a log. Any value of a key that appears in output is redacted before it
          is stored.
        </p>
      </section>

      <section aria-labelledby="privacy-public">
        <h2 id="privacy-public">What is public and what is private</h2>
        <ul>
          <li>Runs, kits, reports, logs and transcripts are private to your account by default.</li>
          <li>
            A benchmark becomes public only when you publish it, and you choose public or unlisted.
            Published versions are signed so anyone can verify them.
          </li>
          <li>
            Transcripts are never public, even on a published benchmark. Logs appear only if you opt
            in.
          </li>
          <li>Your GitHub login is shown as the owner of benchmarks you publish.</li>
        </ul>
      </section>

      <section aria-labelledby="privacy-processors">
        <h2 id="privacy-processors">Who processes data for us</h2>
        <p>We use these providers to run Anybench. Each one gets only what its job needs.</p>
        <TableWrap>
          <table>
            <caption>Service providers</caption>
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col">What for</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Naïve</td>
                <td>Eval computers, and the AI agents that build kits and review results</td>
              </tr>
              <tr>
                <td>Vercel</td>
                <td>Hosting the website and API</td>
              </tr>
              <tr>
                <td>Neon</td>
                <td>Database</td>
              </tr>
              <tr>
                <td>Cloudflare R2</td>
                <td>Object storage for logs, transcripts, kits, artifacts and backups</td>
              </tr>
              <tr>
                <td>Stripe</td>
                <td>Payments, invoices and card storage</td>
              </tr>
              <tr>
                <td>GitHub</td>
                <td>Sign-in, and reading repositories you point us at</td>
              </tr>
              <tr>
                <td>Resend and AgentMail</td>
                <td>Sending email (notices, alerts and outreach)</td>
              </tr>
              <tr>
                <td>Sentry</td>
                <td>Error reports, with secrets scrubbed</td>
              </tr>
              <tr>
                <td>Context.dev</td>
                <td>Searching the public web for projects that could use a benchmark</td>
              </tr>
            </tbody>
          </table>
        </TableWrap>
        <p>
          Model providers you choose for the agent under test (for example Anthropic or OpenAI)
          receive the prompts that agent sends, under your own account with them.
        </p>
      </section>

      <section aria-labelledby="privacy-outreach">
        <h2 id="privacy-outreach">If we emailed you</h2>
        <p>
          We sometimes email people whose public projects make speed or quality claims, offering a
          free eval kit. We find these projects in public sources such as GitHub repositories and
          public web pages, and may use a data provider to find a work email address. Every outreach
          email says who we are, includes our postal address and lets you unsubscribe by replying
          &ldquo;unsubscribe&rdquo;. Once you unsubscribe we add your address to a suppression list
          and do not email you again. To have your lead record deleted as well, email us.
        </p>
      </section>

      <section aria-labelledby="privacy-retention">
        <h2 id="privacy-retention">How long we keep it</h2>
        <TableWrap>
          <table>
            <caption>Retention</caption>
            <thead>
              <tr>
                <th scope="col">Data</th>
                <th scope="col">Kept for</th>
              </tr>
            </thead>
            <tbody>
              {RETENTION_ROWS.map((r) => (
                <tr key={r.what}>
                  <td>{r.what}</td>
                  <td>{r.kept}</td>
                </tr>
              ))}
              <tr>
                <td>Billing and tax records</td>
                <td>
                  <Placeholder>period required by law</Placeholder>
                </td>
              </tr>
              <tr>
                <td>Database backups</td>
                <td>
                  <Placeholder>backup retention window</Placeholder>
                </td>
              </tr>
            </tbody>
          </table>
        </TableWrap>
        <p>
          When you unpublish a benchmark, its public page and embeds stop showing results and its
          badge reads &ldquo;withdrawn&rdquo;.
        </p>
      </section>

      <section aria-labelledby="privacy-cookies">
        <h2 id="privacy-cookies">Cookies</h2>
        <p>
          We set one session cookie when you sign in (<code>anybench_session</code>, secure and not
          readable by scripts) and a short-lived state cookie during GitHub sign-in. We do not use
          advertising cookies.
        </p>
      </section>

      <section aria-labelledby="privacy-rights">
        <h2 id="privacy-rights">Your choices</h2>
        <ul>
          <li>Delete a model key, revoke an API key or unpublish a benchmark at any time.</li>
          <li>
            Ask us for a copy of your data, to correct it, or to delete your account and its data by
            emailing us. Some billing records must be kept as required by law.
          </li>
          <li>
            <Placeholder>jurisdiction-specific rights (for example GDPR, CCPA)</Placeholder>
          </li>
        </ul>
        <p>
          See also the <Link href="/terms">terms of service</Link>.
        </p>
      </section>
    </LegalPage>
  );
}
