import Link from "next/link";
import styles from "./landing.module.css";

const FEATURES = [
  [
    "Watch",
    "Every trial, every agent and every computer updates on one page as it happens: stages, the trial grid, spend against your cap.",
  ],
  [
    "Search",
    "Press / to find any trial, agent or event. Filter the activity feed by source and severity.",
  ],
  [
    "Drill in",
    "Open a trial for its phase timeline, gate result and log tail, or an agent for every tool call it made. Without leaving the page.",
  ],
  [
    "Get told",
    "Spend, stuck trials and leaked computers raise alerts on the page, by email or in Slack.",
  ],
] as const;

export function WatchLive() {
  return (
    <section className={styles.watchSec} aria-labelledby="watch-h">
      <div className={styles.secHead}>
        <h2 id="watch-h">Watch every agent work, on one page</h2>
        <p className={styles.secLede}>
          Nothing runs in a black box. The run page streams every event the agents and computers
          send, and you can stop on any of them.
        </p>
      </div>
      <dl className={styles.feat}>
        {FEATURES.map(([k, v], i) => (
          <div key={k}>
            <dt>
              <span aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>
              {k}
            </dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <Link href="/runs/demo" className={styles.watchCta}>
        <span className={styles.liveDot} aria-hidden="true" />
        Open the live demo run
        <span aria-hidden="true">→</span>
      </Link>
    </section>
  );
}
