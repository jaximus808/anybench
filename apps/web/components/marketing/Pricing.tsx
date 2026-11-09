import Link from "next/link";
import styles from "./marketing.module.css";

/**
 * The landing page's short pricing section (TDM-99; TDM-226: the first benchmark is free). The
 * landing page is static and makes no API calls, so this section states the rules in words and
 * no amounts: the rates and worked examples live on /pricing, rendered from the billing config
 * (GET /billing/pricing), so they can never drift from what is billed.
 */
const LINES = [
  ["First benchmark", "Free, on your own model key. No card."],
  ["After that", "A run fee per benchmark, plus computer time at cost plus a markup."],
  [
    "Model tokens",
    "Free on your own key (your provider bills them), or ours at cost plus a markup, with a card.",
  ],
  ["Budgets", "A hard cap: the most a run can charge, including the tokens we provide."],
  ["Failures on our side", "Infrastructure failures and our retries are never billed."],
] as const;

export function Pricing() {
  return (
    <section id="pricing" className={styles.section} aria-labelledby="pricing-h">
      <div className={styles.pricing}>
        <div className={styles.priceLead}>
          <h2 id="pricing-h">Pay for what runs</h2>
          <p className={styles.price}>
            <span className={styles.priceAmount}>Free</span>
            <span className={styles.priceUnit}>your first benchmark</span>
          </p>
          <p className={styles.lede}>
            Then a run fee and computer time at cost plus a markup. Nothing else.
          </p>
          <p>
            <Link href="/pricing">See pricing and two worked examples</Link>
          </p>
        </div>
        <dl className={styles.priceList}>
          {LINES.map(([term, desc]) => (
            <div key={term}>
              <dt>{term}</dt>
              <dd>{desc}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
