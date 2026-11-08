import { cx } from "./cx";
import styles from "./marketing.module.css";

type ScanStatus = "ready" | "needs hardware" | "skipped";

const REPOS: Array<[name: string, kind: string, plan: string, status: ScanStatus]> = [
  [
    "agentcanvas",
    "harness",
    "Tandem against plain Claude Code and Claude Code with subagents. Measures tests passed, time and tokens.",
    "ready",
  ],
  [
    "eyetrax",
    "software",
    "Webcam eye tracking against the other open trackers the researcher finds. Measures gaze error on a labeled recording, and frames per second.",
    "ready",
  ],
  [
    "obrist",
    "agent",
    "Art gallery guide against plain Claude with vision and the same tools. Measures artwork identification on a labeled set, and cost per conversation.",
    "ready",
  ],
  [
    "web-helper",
    "agent",
    "Screenshot to headless Claude Code against pasting the screenshot into Claude. Measures correct answers on a question set, and time to answer.",
    "ready",
  ],
  [
    "quant-grader",
    "software",
    "The grader against its last release. Measures verdicts on known right and wrong solutions, and run time.",
    "ready",
  ],
  [
    "SHTRM / Telehand",
    "robotics",
    "End-to-end latency needs the physical hand. The hand-tracking part alone could run against a standard tracker.",
    "needs hardware",
  ],
  [
    "PersonalWebsite",
    "website",
    "Nothing to compare against beyond a page speed check.",
    "skipped",
  ],
];

const STATUS_CLASS: Record<ScanStatus, string | undefined> = {
  ready: styles.stOk,
  "needs hardware": styles.stHw,
  skipped: styles.stSkip,
};

export function ScanExample() {
  return (
    <section className={styles.section} aria-labelledby="scan-h">
      <h2 id="scan-h">Connect GitHub, and it proposes a benchmark for every repo</h2>
      <p className={styles.lede}>
        The agents read each repo, say what kind of project it is, pick the baseline a skeptic would
        use and the numbers that matter, and tell you which ones aren&apos;t worth running or need
        hardware. You choose which to run.
      </p>
      <div className={styles.scan}>
        <div className={styles.scanhead}>
          <span className={styles.muted}>
            7 repos read · 5 ready · 1 needs hardware · 1 skipped
          </span>
        </div>
        <ul className={styles.repos} aria-label="Scan results">
          {REPOS.map(([name, kind, plan, status]) => (
            <li key={name} className={styles.repo}>
              <div>
                <b>{name}</b>
                <span className={styles.kind}>{kind}</span>
              </div>
              <p>{plan}</p>
              <span className={cx(styles.st, STATUS_CLASS[status])}>{status}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
