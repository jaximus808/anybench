import type { CSSProperties } from "react";
import { cx } from "./cx";
import styles from "./marketing.module.css";

/**
 * The centerpiece: why a speed number needs a correctness gate.
 *
 * Founder rules (TDM-99 review): the only facts about Velocitty are what its public
 * release notes say, quoted and linked. The chart is a labelled hypothetical with
 * made-up terminals; it attributes no numbers, mechanism or fault to any real project.
 */
export const VELOCITTY_RELEASE_URL = "https://github.com/valvesky/velocitty/releases/tag/v1.3.0";

const ROWS = [
  {
    name: "terminal A",
    value: 1,
    label: "1.00×",
    gate: "screen + scrollback match 10/10 · scored",
  },
  {
    name: "terminal B",
    value: 0.96,
    label: "0.96×",
    gate: "screen + scrollback match 10/10 · scored",
  },
  {
    name: "terminal C",
    value: 1.9,
    label: "1.9×",
    gate: "drops output · mismatch 7/10 · scrollback lines missing",
    cheat: true,
  },
] as const;
const MAX = 1.9;

export function Velocitty() {
  return (
    <section className={cx(styles.section, styles.gate)} aria-labelledby="velo-h">
      <div className={styles.gateIntro}>
        <h2 id="velo-h">A faster number only counts if the screen is right</h2>
        <p>
          Terminal emulators publish throughput comparisons, and the good ones publish their method
          and raw data. Velocitty&apos;s v1.3.0 release notes, for example, list this change:
        </p>
        <blockquote className={styles.quote} cite={VELOCITTY_RELEASE_URL}>
          <p>
            Added automated Ghostty throughput comparisons with raw samples and generated charts.
          </p>
          <footer>
            <a href={VELOCITTY_RELEASE_URL}>Velocitty v1.3.0 release notes</a>
          </footer>
        </blockquote>
        <p>
          Anybench would run a comparison like that with a correctness gate. After every run, the
          final screen and the full scrollback are compared with a reference grid, cell by cell. A
          faster number only counts if the screen and scrollback are right.
        </p>
      </div>

      <figure className={styles.chart} aria-labelledby="velo-chart-title">
        <div className={styles.chartHead}>
          <span className={styles.example}>hypothetical, not a real run</span>
          <span id="velo-chart-title" className={styles.chartTitle}>
            Example: a terminal that drops output
          </span>
          <span className={styles.chartSub}>
            made-up terminals · throughput vs terminal A · 150 MB mixed output · 10 runs each
          </span>
        </div>
        <ul className={styles.bars}>
          {ROWS.map((r) => {
            const width = {
              width: `calc(${Math.round((r.value / MAX) * 100)}% - 72px)`,
            } as CSSProperties;
            const cheat = "cheat" in r && r.cheat;
            return (
              <li key={r.name} className={cx(styles.barRow, cheat && styles.cheat)}>
                <span className={styles.barName}>{r.name}</span>
                <span className={styles.barTrack}>
                  <span className={styles.barFill} style={width} aria-hidden="true">
                    {cheat ? <span className={styles.strike} /> : null}
                  </span>
                  <span className={styles.barValue}>
                    {cheat ? <span className={styles.srOnly}>claimed, not scored: </span> : null}
                    {r.label}
                  </span>
                </span>
                <span className={styles.barGate}>{r.gate}</span>
                {cheat ? <span className={styles.stamp}>No score: gate failed</span> : null}
              </li>
            );
          })}
        </ul>
        <p className={styles.chartWhy}>
          In this example, terminal C skips part of its input, so its screen and scrollback
          don&apos;t match the reference. Its 1.9× never reaches the report.
        </p>
      </figure>

      <div className={styles.gateLists}>
        <div className={styles.listOut}>
          <h3>What a throughput number alone tells you</h3>
          <ul>
            <li>Bytes in per second</li>
            <li>Nothing about whether those bytes ended up on screen</li>
          </ul>
        </div>
        <div className={styles.listIn}>
          <h3>What an Anybench kit checks</h3>
          <ul>
            <li>Every terminal gets the same byte stream on identical computers</li>
            <li>
              After each run, the final screen and the full scrollback are compared with a reference
              grid, cell by cell
            </li>
            <li>A run that doesn&apos;t match gets no speed score</li>
            <li>
              The kit builds a version that drops chunks of output and confirms the gate catches it
            </li>
          </ul>
        </div>
      </div>

      <p className={styles.verdict}>No speed number without a correctness gate.</p>
    </section>
  );
}
