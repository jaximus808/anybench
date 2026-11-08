import styles from "./marketing.module.css";

/**
 * Pricing copy as the founder set it (TDM-99, revised 2026-11-07; simplified the same day: no
 * per-unit rates on the page, but compute is still stated as at cost + 50%). Display strings
 * only: billing's source of truth is the server's micro-USD config (plan.md, E10),
 * and nothing on this page computes money.
 */
export const RUN_FEE_LABEL = "$2";
export const FREE_CREDIT_LABEL = "$5";

const LINES = [
  [
    "Computer time",
    "At cost + 50%, only while your trials run. Every trial gets a fresh computer.",
  ],
  ["Model tokens", "On your own key, paid to your model provider at their price."],
  ["Failures on our side", "If our infrastructure or pipeline fails the run, nothing is billed."],
  ["Cancelling", "If you cancel mid-run, you pay for the compute used, but no run fee."],
  [
    "Free credit",
    `${FREE_CREDIT_LABEL} free credit when you sign up, used before anything is charged.`,
  ],
  ["Billing", "Billed monthly by usage, to the card on file."],
] as const;

export function Pricing() {
  return (
    <section id="pricing" className={styles.section} aria-labelledby="pricing-h">
      <div className={styles.pricing}>
        <div className={styles.priceLead}>
          <h2 id="pricing-h">Pay for what runs</h2>
          <p className={styles.price}>
            <span className={styles.priceAmount}>{RUN_FEE_LABEL}</span>
            <span className={styles.priceUnit}>per benchmark run</span>
          </p>
          <p className={styles.lede}>
            Plus computer time at cost + 50%, and model tokens on your own key. Nothing else.
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
      <div className={styles.priceEstimate}>
        <p>
          A 60-trial Tandem vs Claude Code benchmark like the one above is about $17, plus your
          tokens. A typical CLI or API benchmark is $2–4.
        </p>
      </div>
    </section>
  );
}
