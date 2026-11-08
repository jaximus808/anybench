import Link from "next/link";
import { EarlyAccessForm } from "./EarlyAccessForm";
import styles from "./landing.module.css";
import { LiveInstrument } from "./LiveInstrument";
import { TrialField } from "./TrialField";

const QUESTIONS = [
  "Is my terminal really faster than Ghostty?",
  "Does Tandem beat plain Claude Code?",
  "Is my eye tracker more accurate than the alternatives?",
  "Do subagents make it faster, or just pricier?",
  "Did my API get slower this release?",
  "Which model should my agent run on?",
];

export function Hero() {
  return (
    <section className={styles.hero} aria-labelledby="hero-h">
      <TrialField className={styles.field} />
      <div className={styles.heroGrid}>
        <div className={styles.heroCopy}>
          <p className={styles.kicker}>
            <span className={styles.kickerBox} aria-hidden="true" />
            Benchmarks for anything you build
          </p>
          <h1 id="hero-h" className={styles.h1}>
            <span className={styles.h1Line}>Find out if</span>{" "}
            <span className={styles.h1Line}>what you built</span>{" "}
            <span className={styles.h1Line}>
              is <em>actually better.</em>
            </span>
          </h1>
          <p className={styles.heroSub}>
            Point it at an agent, a harness or any software. Agents write the benchmark, run it, and
            tell you whether it&apos;s better and why.
          </p>
          <EarlyAccessForm />
          <Link href="/runs/demo" className={styles.watch}>
            <span className={styles.liveDot} aria-hidden="true" />
            Watch a run live
            <span aria-hidden="true">→</span>
          </Link>
          <p className={styles.powered}>
            Powered by{" "}
            <a href="https://usenaive.ai" rel="noopener">
              Naïve
            </a>
          </p>
        </div>
        <LiveInstrument />
      </div>

      <div className={styles.asks}>
        <span className={styles.asksLbl} id="people-ask">
          People ask
        </span>
        <div className={styles.marquee}>
          <ul className={styles.asksList} aria-labelledby="people-ask">
            {QUESTIONS.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
          <ul className={styles.asksList} aria-hidden="true">
            {QUESTIONS.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
