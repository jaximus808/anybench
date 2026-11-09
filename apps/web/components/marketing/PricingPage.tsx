import Link from "next/link";
import type { PublicFreePool, PublicPricing } from "@anybench/core";
import styles from "./pricing.module.css";
import { poolCopy, pricingCopy, PRICING_RULES, type ExampleCopy } from "./pricing-copy";

/**
 * /pricing (TDM-226). Rendered from GET /billing/pricing and GET /billing/free-pool: every rate,
 * limit and worked example is the server's billing config through packages/billing, so the page
 * cannot drift from what a run is billed. Dark like the landing page (.instrument).
 */
export function PricingPage({
  pricing,
  pool,
}: {
  pricing: PublicPricing | null;
  pool: PublicFreePool | null;
}) {
  const status = poolCopy(pool);
  const copy = pricing ? pricingCopy(pricing) : null;
  return (
    <div className={`instrument ${styles.shell}`}>
      <div className={styles.page}>
        <header className={styles.head}>
          <p className={styles.kicker}>Pricing</p>
          <h1 className={styles.title}>
            Your first benchmark is <em>free.</em>
          </h1>
          <p className={styles.lede}>
            After that you pay for what runs: a run fee, computer time at cost plus a markup, and
            model tokens only if they are ours. Every number on this page comes from our billing
            code.
          </p>
          <p className={styles.status} data-state={status.state} role="status">
            <span className={styles.dot} aria-hidden="true" />
            <span className={styles.statusLine}>{status.line}</span>
            <span className={styles.statusDetail}>{status.detail}</span>
          </p>
        </header>

        {copy === null ? (
          <section className={styles.section} aria-labelledby="pricing-unavailable">
            <h2 id="pricing-unavailable">Prices are unavailable</h2>
            <p className={styles.muted}>
              We couldn&rsquo;t load the current rates. Try again in a minute; every run also shows
              its price line by line before you press Go.
            </p>
          </section>
        ) : (
          <>
            <section className={styles.section} aria-labelledby="pricing-free">
              <h2 id="pricing-free">{copy.free.title}</h2>
              {copy.free.offered ? null : (
                <p className={styles.muted}>Free runs are switched off on this deployment.</p>
              )}
              <ul className={styles.includes} aria-label="What a free run includes">
                {copy.free.includes.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <p>
                <Link href="/signup" className={styles.cta}>
                  Start your free benchmark
                </Link>
              </p>
            </section>

            <section className={styles.section} aria-labelledby="pricing-rates">
              <h2 id="pricing-rates">Then, pay for what runs</h2>
              <dl className={styles.rates}>
                {copy.rates.map((r) => (
                  <div key={r.key} data-rate={r.key}>
                    <dt>{r.term}</dt>
                    <dd className={styles.rate}>{r.rate}</dd>
                    <dd className={styles.rateDetail}>{r.detail}</dd>
                  </div>
                ))}
              </dl>
            </section>

            <section className={styles.section} aria-labelledby="pricing-examples">
              <h2 id="pricing-examples">Two worked examples</h2>
              <p className={styles.muted}>
                Priced by the same estimate your run page shows before Go, from fixed example kits.
              </p>
              <div className={styles.examples}>
                {copy.examples.map((e) => (
                  <Example key={e.id} e={e} />
                ))}
              </div>
            </section>
          </>
        )}

        <section className={styles.section} aria-labelledby="pricing-rules">
          <h2 id="pricing-rules">The rules</h2>
          <dl className={styles.rules}>
            {PRICING_RULES.map((r) => (
              <div key={r.term}>
                <dt>{r.term}</dt>
                <dd>{r.desc}</dd>
              </div>
            ))}
          </dl>
          <p className={styles.muted}>
            The details, including refunds, are in <Link href="/refunds">refunds and billing</Link>.
          </p>
        </section>
      </div>
    </div>
  );
}

function Example({ e }: { e: ExampleCopy }) {
  const id = `example-${e.id}`;
  return (
    <article className={styles.example} aria-labelledby={id} data-example={e.id}>
      <h3 id={id}>{e.title}</h3>
      <p className={styles.muted}>{e.summary}</p>
      <p className={styles.exampleHead}>
        <span className={styles.exampleAmount}>{e.headline}</span>
        <span className={styles.muted}>{e.sub}</span>
      </p>
      <dl className={styles.lines}>
        {e.lines.map((l) => (
          <div key={l.key} data-line={l.key}>
            <dt>
              {l.label}
              <span className={styles.lineDetail}>{l.detail}</span>
            </dt>
            <dd>{l.amount}</dd>
          </div>
        ))}
      </dl>
      <p className={styles.muted}>{e.tokens}</p>
    </article>
  );
}
