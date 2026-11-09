import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "../../../components/docs/LegalPage";
import { Placeholder, TableWrap } from "../../../components/docs/Notices";

export const metadata: Metadata = {
  title: "Refunds and billing",
  description:
    "How Anybench bills by usage, the free first benchmark, what is never billed, credit grants, refunds and disputes. Draft, pending founder and legal review.",
};

export default function RefundsPage() {
  return (
    <LegalPage
      path="/refunds"
      title="Refunds and billing"
      summary="Anybench bills by usage. Your first benchmark is free, with no card. After that you link a card once, usage adds up as your trials run, and Stripe sends a monthly invoice. Runs that fail because of us are never billed."
    >
      <section aria-labelledby="refunds-how">
        <h2 id="refunds-how">How billing works</h2>
        <ul>
          <li>
            <strong>Your first benchmark is free.</strong> It runs on your own model key and needs
            no card. See <a href="#refunds-free">the free first benchmark</a>.
          </li>
          <li>
            <strong>Card on file, no upfront charge.</strong> Linking a card through Stripe Checkout
            saves it and starts a usage-based subscription. Nothing is charged at that point.
          </li>
          <li>
            <strong>You see the estimate before you start.</strong> The test plan shows what a run
            should cost before you press Go, and each run has a budget you set, which is a hard cap.
          </li>
          <li>
            <strong>Monthly invoices.</strong> Stripe invoices your usage once a month.
          </li>
          <li>
            <strong>Early invoice at $50.</strong> If your unbilled usage reaches $50 before the
            month ends, Stripe invoices it early, so a new card never builds up a large balance.
          </li>
          <li>
            <strong>Invoices and receipts</strong> are in the Stripe billing portal, linked from
            your billing page, where you can also change your card.
          </li>
        </ul>
      </section>

      <section aria-labelledby="refunds-what">
        <h2 id="refunds-what">What we bill</h2>
        <p>
          Pricing is cost-plus, and the test plan shows the estimate before you press Go. The
          current amounts and two worked examples are on the{" "}
          <Link href="/pricing">pricing page</Link>, which is rendered from the same billing
          configuration that bills your runs.
        </p>
        <ul>
          <li>
            <strong>
              A run fee per benchmark run, charged only when the run is delivered or fails because
              of the subject.
            </strong>{" "}
            This covers the work of our own agents: understanding your project, finding what to
            compare it against, writing the kit, running the proof checks, reviewing and explaining
            the results. That work is not billed separately.
          </li>
          <li>
            <strong>Eval computer time at our cost plus a markup.</strong> We pass on what our
            computer provider charges us for the computers your trials ran on, plus the markup on
            the pricing page. It is metered from when each computer is created to when it is
            destroyed, in the same 10-minute blocks the provider bills us in.
          </li>
          <li>
            <strong>Model tokens, only if you use ours.</strong> By default the agent under test
            uses your own model key and your provider bills you directly; we charge nothing for
            those tokens. If a run uses Anybench&rsquo;s model tokens, we bill them as used at our
            cost plus the markup on the pricing page, and a card on file is required.
          </li>
        </ul>
      </section>

      <section aria-labelledby="refunds-never">
        <h2 id="refunds-never">What is never billed</h2>
        <ul>
          <li>
            <strong>Infrastructure failures.</strong> A trial that fails because of our side (a
            computer that would not start, a lost connection, a crashed worker) is marked as an
            infrastructure failure. We retry it automatically, and neither the trial nor its
            computer time is ever billed, however many times it is retried.
          </li>
          <li>
            <strong>Runs that fail because of us.</strong> If our pipeline or infrastructure fails
            the run, nothing is billed: no run fee and no computer time. That includes a kit whose
            proof checks still fail after our repairs, which stops the run for a person to look at.
          </li>
          <li>
            <strong>Runs we cancel.</strong> If we cancel a run (for example with our emergency
            stop, or because of a fault on our side), nothing is billed.
          </li>
          <li>
            <strong>Comped runs.</strong> Runs we give you for free are recorded but never sent to
            Stripe, and say &ldquo;comped&rdquo; on the report.
          </li>
        </ul>
      </section>

      <section aria-labelledby="refunds-outcomes">
        <h2 id="refunds-outcomes">How a run&rsquo;s outcome is billed</h2>
        <TableWrap>
          <table>
            <caption>Billing by run outcome</caption>
            <thead>
              <tr>
                <th scope="col">How the run ended</th>
                <th scope="col">Run fee</th>
                <th scope="col">Computer time</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Delivered</th>
                <td>Billed</td>
                <td>Billed</td>
              </tr>
              <tr>
                <th scope="row">Failed because of the subject (the software under test)</th>
                <td>Billed</td>
                <td>Billed</td>
              </tr>
              <tr>
                <th scope="row">
                  Failed because of us (our pipeline, infrastructure, or proof checks that still
                  fail after repairs)
                </th>
                <td>Not billed</td>
                <td>Not billed</td>
              </tr>
              <tr>
                <th scope="row">You cancelled it mid-run</th>
                <td>Not billed</td>
                <td>Billed for the time used</td>
              </tr>
              <tr>
                <th scope="row">We cancelled it</th>
                <td>Not billed</td>
                <td>Not billed</td>
              </tr>
            </tbody>
          </table>
        </TableWrap>
        <p>
          <strong>Budgets are a hard cap.</strong> Your budget is the most Anybench will charge for
          a run: the run fee, computer time and any model tokens we provide. A trial starts only if
          its worst case still fits; when the next one can&rsquo;t, the run pauses and asks you.
          Tokens on your own key are billed by your provider and are not counted.
        </p>
      </section>

      <section aria-labelledby="refunds-free">
        <h2 id="refunds-free">The free first benchmark</h2>
        <ul>
          <li>
            One free starter run per account, for accounts signed in with a GitHub account older
            than 90 days. It needs your own Anthropic or OpenAI key and no card.
          </li>
          <li>
            A starter run is small: a limited number of setups, trials and computer time, shown on
            the pricing page. Your run page says before you press Go whether a run is free.
          </li>
          <li>
            Its charges are covered by a credit grant recorded on your account, so they never reach
            your card. If it fails because of us, or we cancel it, you keep your free run.
          </li>
          <li>
            Free runs are paid from a shared pool. When the pool is used up, free runs pause and the
            site says so; runs are then billed at the normal prices.
          </li>
        </ul>
      </section>

      <section aria-labelledby="refunds-credits">
        <h2 id="refunds-credits">Credit grants</h2>
        <ul>
          <li>
            Credit granted to your account is used before your card is charged. Stripe applies it to
            your usage invoices first.
          </li>
          <li>
            We may also grant credit for demos, support or to make up for a problem. Each grant is
            recorded with its reason.
          </li>
          <li>
            Credit has no cash value, cannot be transferred, and may have an expiry date, which we
            show with the grant.
          </li>
        </ul>
      </section>

      <section aria-labelledby="refunds-refunds">
        <h2 id="refunds-refunds">Refunds</h2>
        <p>
          If you think a charge is wrong, for example computer time for a trial that failed because
          our kit or grader was wrong rather than because of the contender, email us within{" "}
          <Placeholder>refund request window</Placeholder> of the invoice with the run link. We
          review every request. An approved refund goes back to your card through Stripe or, if you
          prefer, as credit on your account.
        </p>
        <p>
          Every run has a written postmortem when it ends badly, which shows which stage failed and
          why. It is the fastest way for both of us to check a charge.
        </p>
      </section>

      <section aria-labelledby="refunds-disputes">
        <h2 id="refunds-disputes">Failed payments and disputes</h2>
        <ul>
          <li>
            If a payment fails, new runs are paused until the invoice is paid. Trials already
            running are allowed to finish.
          </li>
          <li>
            Please email us before you file a dispute with your bank; we will try to fix it quickly.
            While a dispute or chargeback is open, new runs on the account are paused.
          </li>
        </ul>
      </section>

      <section aria-labelledby="refunds-cancel">
        <h2 id="refunds-cancel">Cancelling your subscription</h2>
        <p>
          This is separate from cancelling a run (see{" "}
          <a href="#refunds-outcomes">how a run&rsquo;s outcome is billed</a>). You can remove your
          card and cancel your subscription at any time from the billing portal. There is no minimum
          term. Usage before you cancelled is invoiced as normal. See also the{" "}
          <Link href="/terms">terms of service</Link>.
        </p>
      </section>
    </LegalPage>
  );
}
