import { STAGES } from "../../lib/live/model";
import styles from "./landing.module.css";
import { EXAMPLE_RUN, EXAMPLE_TASKS, countTiles, taskGroups, type TileState } from "./run-example";

// The hero figure: a still of the live run page, drawn from the same run as the
// product mock (run-example.ts). Static: no simulated "live" run.
// Counts only (passed / failed gate / running), never a speed number (plan.md 17.2).

const TONE: Record<TileState, string | undefined> = {
  p: styles.cP,
  f: styles.cF,
  r: styles.cR,
  q: styles.cQ,
};

/** The figure is small: show the stages a visitor cares about. */
const HIDDEN = new Set(["intake", "awaiting_go", "env_build", "delivered"]);
const NOW = STAGES.findIndex((s) => s.state === "running");

const done = countTiles("p") + countTiles("f");
const total = EXAMPLE_RUN.length * 15;

export function ExampleRun() {
  return (
    <figure className={styles.inst} aria-label={`Run page: ${done} of ${total} trials done`}>
      <div className={styles.instHead}>
        <span className={styles.instTitle}>tandem-workers</span>
      </div>

      <ol className={styles.instStages} aria-label="Run stages">
        {STAGES.map((s, i) =>
          HIDDEN.has(s.state) ? null : (
            <li key={s.state} data-state={i < NOW ? "done" : i === NOW ? "now" : "todo"}>
              {s.label}
            </li>
          ),
        )}
      </ol>

      <dl className={styles.instStats}>
        <div>
          <dt>done</dt>
          <dd>
            {done}
            <small>/{total}</small>
          </dd>
        </div>
        <div>
          <dt>running</dt>
          <dd className={styles.amber}>{countTiles("r")}</dd>
        </div>
        <div>
          <dt>gate failed</dt>
          <dd>{countTiles("f")}</dd>
        </div>
        <div>
          <dt>queued</dt>
          <dd>{countTiles("q")}</dd>
        </div>
      </dl>

      <div
        className={styles.matrix}
        role="img"
        aria-label="Trial grid: 4 setups by 3 tasks by 5 runs"
      >
        {EXAMPLE_RUN.map(([setup, tiles]) => (
          <div key={setup} className={styles.mRow}>
            <span className={styles.mName}>{setup}</span>
            <div className={styles.mGroups}>
              {taskGroups(tiles).map((group, g) => (
                <div key={EXAMPLE_TASKS[g]} className={styles.mGroup}>
                  {group.map((t, i) => (
                    <i key={i} className={`${styles.cell} ${TONE[t]}`} />
                  ))}
                </div>
              ))}
            </div>
          </div>
        ))}
        <div className={styles.mAxis} aria-hidden="true">
          <span />
          <div className={styles.mGroups}>
            {EXAMPLE_TASKS.map((w) => (
              <span key={w}>{w}</span>
            ))}
          </div>
        </div>
      </div>

      <figcaption className={styles.instFoot}>
        4 setups × 3 tasks × 5 runs, each on a fresh computer.
      </figcaption>
    </figure>
  );
}
