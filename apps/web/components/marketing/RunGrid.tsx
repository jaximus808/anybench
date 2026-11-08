import type { CSSProperties } from "react";
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

/**
 * The trial grid: one row per setup, one tile per trial, grouped by task.
 * With `animate`, tiles land in column order on page load (CSS only, no JS; off
 * under prefers-reduced-motion). `compact` puts the setup name beside the tiles.
 */
export function RunGrid({
  animate = false,
  compact = false,
}: {
  animate?: boolean;
  compact?: boolean;
}) {
  const rows = EXAMPLE_RUN.length;
  return (
    <div
      className={cx(compact ? styles.mockGrid : styles.runRows, animate && styles.fill)}
      role="img"
      aria-label={`Example trial grid, 4 setups by 15 trials: ${RUN_SUMMARY}`}
    >
      {EXAMPLE_RUN.map(([setup, tiles], row) => (
        <div key={setup} className={compact ? styles.mockRow : styles.runRow}>
          <span className={styles.runName}>{setup}</span>
          <div className={styles.groups}>
            {taskGroups(tiles).map((group, g) => (
              <div key={EXAMPLE_TASKS[g]} className={styles.group}>
                {group.map((state, i) => {
                  const col = g * 5 + i;
                  const style = animate
                    ? ({ "--d": `${250 + (col * rows + row) * 26}ms` } as CSSProperties)
                    : undefined;
                  return <i key={i} className={cx(styles.t, TILE_CLASS[state])} style={style} />;
                })}
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
