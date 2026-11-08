import { EarlyAccessForm } from "./EarlyAccessForm";
import styles from "./marketing.module.css";
import { RunGrid, TileLegend } from "./RunGrid";
import { EXAMPLE_TASKS, countTiles } from "./run-example";

const QUESTIONS = [
  "Is my terminal really faster than Ghostty?",
  "Does Tandem beat plain Claude Code?",
  "Is my eye tracker more accurate than the alternatives?",
  "Do subagents make it faster, or just pricier?",
  "Did my API get slower this release?",
  "Which model should my agent run on?",
];

export function Hero() {
  const done = countTiles("p") + countTiles("f");
  return (
    <section className={styles.hero} aria-labelledby="hero-h">
      <div className={styles.heroCopy}>
        <h1 id="hero-h">Find out if what you built is actually better.</h1>
        <p className={styles.heroSub}>
          Point Anybench at an agent, a harness or any other software. Agents work out what it
          should be compared against and write a benchmark that measures the real work. Naïve&apos;s
          cloud computers run it. You get a score for each contender, the reasons behind it, and
          proof the test was fair.
        </p>
        <EarlyAccessForm />
      </div>

      <figure className={styles.run} aria-labelledby="run-caption">
        <div className={styles.runHead}>
          <span className={styles.runTitle}>tandem-workers</span>
          <span className={styles.example}>example run</span>
        </div>
        <dl className={styles.runStats}>
          <div>
            <dt>trials done</dt>
            <dd>
              {done}
              <small> / 60</small>
            </dd>
          </div>
          <div>
            <dt>running now</dt>
            <dd>{countTiles("r")}</dd>
          </div>
          <div>
            <dt>elapsed</dt>
            <dd>
              23<small> min</small>
            </dd>
          </div>
        </dl>
        <RunGrid animate />
        <div className={styles.axis} aria-hidden="true">
          {EXAMPLE_TASKS.map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
        <TileLegend />
        <figcaption id="run-caption" className={styles.runCaption}>
          An illustrative run: Tandem against plain Claude Code, 4 setups, 3 tasks, 5 runs each,
          every trial on its own fresh cloud computer.
        </figcaption>
      </figure>

      <div className={styles.asks}>
        <span className={styles.lbl} id="people-ask">
          People ask
        </span>
        <ul className={styles.asksList} aria-labelledby="people-ask">
          {QUESTIONS.map((q) => (
            <li key={q}>{q}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
