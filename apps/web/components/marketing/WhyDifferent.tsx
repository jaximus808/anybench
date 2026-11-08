import styles from "./marketing.module.css";

const POINTS = [
  [
    "It finds the baseline",
    "Competitors, the plain default, or your last release. The comparison a skeptic would ask for, not the one that flatters you.",
  ],
  [
    "Skipping work doesn't win",
    "Every speed number has a correctness gate, and every kit proves its gate catches a version that cuts corners.",
  ],
  [
    "It explains the result",
    "Where it wins, where it loses and why, with the evidence: profiles, traces and the lines of code that matter.",
  ],
] as const;

export function WhyDifferent() {
  return (
    <section className={styles.section} aria-labelledby="diff-h">
      <h2 id="diff-h">It knows what to compare against, and it can&apos;t be gamed</h2>
      <dl className={styles.why}>
        {POINTS.map(([title, body]) => (
          <div key={title}>
            <dt>{title}</dt>
            <dd>{body}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
