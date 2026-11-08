import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "../../../components/docs/LegalPage";
import { Placeholder } from "../../../components/docs/Notices";

export const metadata: Metadata = {
  title: "Terms of service",
  description: "The terms for using Anybench. Draft, pending founder and legal review.",
};

export default function TermsPage() {
  return (
    <LegalPage
      path="/terms"
      title="Terms of service"
      summary="These terms cover your use of Anybench: the website, the app, the API, the CLI, the MCP server, and the benchmarks you run and publish with it."
    >
      <section aria-labelledby="terms-who">
        <h2 id="terms-who">Who we are</h2>
        <p>
          Anybench is run by <Placeholder>company legal name and entity type</Placeholder>{" "}
          (&ldquo;Anybench&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;). By creating an account or
          using the service you agree to these terms, the{" "}
          <Link href="/privacy">privacy policy</Link>, the{" "}
          <Link href="/refunds">refunds and billing policy</Link> and the{" "}
          <Link href="/aup">acceptable use policy</Link>. If you use Anybench for a company, you
          confirm you can agree on its behalf.
        </p>
      </section>

      <section aria-labelledby="terms-service">
        <h2 id="terms-service">What Anybench does</h2>
        <p>
          You point Anybench at a project: a GitHub repository, a binary with its docs, or a Claude
          Code setup. Our agents work out what it does, find what it should be compared against, and
          write an eval kit. The kit runs on cloud computers built for that eval, and you get a
          score for each contender, the reasons behind it, and the proof checks that show the test
          was fair. You can then publish the result.
        </p>
        <p>
          Every speed or quality number we report has passed a correctness gate first. A result is a
          measurement under the conditions the kit records (versions, machine, workload). It is not
          a guarantee of how the software behaves anywhere else.
        </p>
      </section>

      <section aria-labelledby="terms-account">
        <h2 id="terms-account">Your account</h2>
        <ul>
          <li>You sign in with GitHub. Keep your GitHub account and any Anybench API keys safe.</li>
          <li>
            API keys are shown once, can be limited to scopes and runs, and can be revoked at any
            time. You are responsible for what is done with keys you create.
          </li>
          <li>You must be old enough to form a binding contract where you live.</li>
        </ul>
      </section>

      <section aria-labelledby="terms-content">
        <h2 id="terms-content">Your code and your results</h2>
        <ul>
          <li>
            You keep every right you have in the code, binaries, setups and data you submit, and in
            the kits and reports made from them.
          </li>
          <li>
            You give us permission to copy, run, measure and analyze that material only as needed to
            provide the service to you: building the kit, running trials, scoring, writing the
            report, and publishing it if you choose to.
          </li>
          <li>
            You confirm you are allowed to submit the material and to run it for benchmarking,
            including any competitor you add as a contender.
          </li>
          <li>
            Run transcripts and logs are private to you. We never make them public. See the{" "}
            <Link href="/privacy">privacy policy</Link>.
          </li>
        </ul>
      </section>

      <section aria-labelledby="terms-computers">
        <h2 id="terms-computers">Eval computers</h2>
        <p>
          Your code runs on isolated cloud computers that we create for your eval, from our computer
          providers. Each trial gets its own computer, and that computer is destroyed when the trial
          ends. Orphaned computers are found and removed automatically. Correctness gates run on a
          separate scoring computer that never ran your code.
        </p>
        <p>
          Trials have wall-clock and spend caps. We may stop a trial or a run that goes over its
          caps, breaks the <Link href="/aup">acceptable use policy</Link>, or puts the service at
          risk.
        </p>
      </section>

      <section aria-labelledby="terms-keys">
        <h2 id="terms-keys">Model keys you bring</h2>
        <p>
          If the agent under test needs a model provider (for example Anthropic or OpenAI), you can
          store your own key. We encrypt it at rest, never show it back to you (only its last four
          characters), and decrypt it only to hand it to the eval computer right before a trial.
          Calls made with your key are billed to you by that provider under its own terms. The token
          caps in your kit limit how much a trial can use.
        </p>
      </section>

      <section aria-labelledby="terms-billing">
        <h2 id="terms-billing">Billing</h2>
        <p>
          Anybench is billed by usage through Stripe, with a card on file and monthly invoices.
          Trials that fail because of our infrastructure are never billed. The details, including
          credit grants, early invoices and refunds, are in the{" "}
          <Link href="/refunds">refunds and billing policy</Link>.
        </p>
      </section>

      <section aria-labelledby="terms-publish">
        <h2 id="terms-publish">Publishing benchmarks</h2>
        <ul>
          <li>
            Nothing is public until you publish it. Publishing is your choice, and you can make a
            benchmark public or unlisted.
          </li>
          <li>
            You can only publish a finished run whose proof checks all passed. A published benchmark
            shows every contender, every workload and where each one breaks; you cannot publish a
            subset.
          </li>
          <li>
            Each published version is frozen and signed, so anyone can check it was not changed.
            Runs we gave you for free say &ldquo;comped&rdquo;.
          </li>
          <li>
            You can unpublish at any time. Badges and embeds for a withdrawn benchmark then say
            &ldquo;withdrawn&rdquo; instead of disappearing silently.
          </li>
          <li>
            By publishing, you let us host and display the published version, its badge, embed and
            preview image, and let others view, link to and embed it.
          </li>
        </ul>
      </section>

      <section aria-labelledby="terms-ending">
        <h2 id="terms-ending">Suspension and ending</h2>
        <p>
          You can stop using Anybench and ask us to delete your account at any time. We may suspend
          or close an account that breaks these terms or the acceptable use policy, has unpaid
          invoices, or has an open payment dispute. Where we can, we will tell you first and let
          running trials finish. Usage before the account closed is still billed.
        </p>
      </section>

      <section aria-labelledby="terms-warranty">
        <h2 id="terms-warranty">Disclaimers and liability</h2>
        <p>
          Anybench is provided &ldquo;as is&rdquo;. We work hard to make every result correct and
          fair, but we do not promise the service will be uninterrupted or error-free, or that a
          result fits your purpose.
        </p>
        <p>
          <Placeholder>
            limitation of liability and indemnity clauses, after legal review
          </Placeholder>
        </p>
      </section>

      <section aria-labelledby="terms-law">
        <h2 id="terms-law">Changes and governing law</h2>
        <p>
          We will post changes to these terms on this page and tell account holders about material
          changes before they take effect. Governing law and venue:{" "}
          <Placeholder>jurisdiction</Placeholder>.
        </p>
      </section>
    </LegalPage>
  );
}
