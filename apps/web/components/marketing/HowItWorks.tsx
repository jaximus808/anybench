import styles from "./landing.module.css";

const STEPS = [
  {
    title: "Understand it",
    who: "understander",
    body: 'Agents read the project and work out what it does and what "better" means for it.',
  },
  {
    title: "Find the baseline",
    who: "researcher · intake",
    body: "Competitors, the plain default, or your last release. Whatever a skeptic would compare it to.",
  },
  {
    title: "Generate the eval kit",
    who: "kit designer · verifier",
    body: "Workloads plus clear requirements: measured, a correctness gate for each, and reviewed.",
  },
  {
    title: "Run it, many times",
    who: "powered by Naïve",
    body: "Every contender on identical fresh computers, many times over.",
  },
  {
    title: "Get the verdict and the why",
    who: "reviewer · analyst",
    body: "A verdict on each comparison and the reasons behind it: where it wins, where it loses, and what explains it.",
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className={styles.how} aria-labelledby="how-h">
      <div className={styles.secHead}>
        <h2 id="how-h">Five steps from your repo to an answer</h2>
        <p className={styles.secLede}>
          You bring the project and the question. Agents do the rest, and the kit they write is
          plain files you can read and edit.
        </p>
      </div>
      <ol className={styles.rail}>
        {STEPS.map((s, i) => (
          <li key={s.title} style={{ ["--i" as string]: i }}>
            <span className={styles.railNode} aria-hidden="true" />
            <span className={styles.railNum} aria-hidden="true">
              {String(i + 1).padStart(2, "0")}
            </span>
            <h3>{s.title}</h3>
            <p>{s.body}</p>
            <span className={styles.railWho}>{s.who}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
