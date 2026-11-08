import { cx } from "./cx";
import styles from "./marketing.module.css";
import { EXAMPLE_RUN, EXAMPLE_TASKS, countTiles, taskGroups, type TileState } from "./run-example";

const TILE_CLASS: Record<TileState, string | undefined> = {
  p: styles.tP,
  f: styles.tF,
  r: styles.tR,
  q: styles.tQ,
};

export const RUN_SUMMARY = `${countTiles("p") + countTiles("f")} done, ${countTiles("r")} running, ${countTiles("q")} queued`;

/** The trial grid: one row per setup, one tile per trial, grouped by task. */
export function RunGrid() {
  return (
    <div
      className={styles.mockGrid}
      role="img"
      aria-label={`Trial grid, 4 setups by 15 trials: ${RUN_SUMMARY}`}
    >
      {EXAMPLE_RUN.map(([setup, tiles]) => (
        <div key={setup} className={styles.mockRow}>
          <span className={styles.runName}>{setup}</span>
          <div className={styles.groups}>
            {taskGroups(tiles).map((group, g) => (
              <div key={EXAMPLE_TASKS[g]} className={styles.group}>
                {group.map((state, i) => (
                  <i key={i} className={cx(styles.t, TILE_CLASS[state])} />
                ))}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function TileLegend({ extra }: { extra?: string }) {
  return (
    <ul className={styles.legend}>
      <li>
        <i className={cx(styles.t, styles.tP)} aria-hidden="true" />
        passed
      </li>
      <li>
        <i className={cx(styles.t, styles.tF)} aria-hidden="true" />
        failed
      </li>
      <li>
        <i className={cx(styles.t, styles.tR)} aria-hidden="true" />
        running
      </li>
      <li>
        <i className={cx(styles.t, styles.tQ)} aria-hidden="true" />
        queued
      </li>
      {extra ? <li>{extra}</li> : null}
    </ul>
  );
}
