import styles from "./marketing.module.css";

const STEPS = [
  {
    title: "Understand it",
    body: 'Agents read the project and work out what it does and what "better" means for it.',
  },
  {
    title: "Find the baseline",
    body: "Competitors, the plain default, or your last release. Whatever a skeptic would compare it to.",
  },
  {
    title: "Generate the eval kit",
    body: "Workloads plus clear requirements: measured, a correctness gate for each, and reviewed.",
  },
  {
    title: "Run on Naïve compute",
    body: "Every contender on identical fresh computers, many times over.",
  },
  {
    title: "Get the verdict and the why",
    body: "A verdict on each comparison and the reasons behind it: where it wins, where it loses, and what explains it.",
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className={styles.section} aria-labelledby="how-h">
      <h2 id="how-h">Five steps from your repo to an answer</h2>
      <p className={styles.lede}>
        You bring the project and the question. Agents do the rest, and the kit they write is plain
        files you can read and edit.
      </p>
      <ol className={styles.steps}>
        {STEPS.map((s, i) => (
          <li key={s.title}>
            <span className={styles.stepNum} aria-hidden="true">
              {i + 1}
            </span>
            <h3>{s.title}</h3>
            <p>{s.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
