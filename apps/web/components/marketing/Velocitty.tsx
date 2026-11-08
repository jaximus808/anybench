import type { CSSProperties } from "react";
import { cx } from "./cx";
import styles from "./marketing.module.css";

/**
 * The centerpiece: a throughput benchmark that rewarded skipping the work, and how
 * an Anybench kit reports the same case. The chart is illustrative (labelled so):
 * throughput relative to Ghostty, with the run that failed the correctness gate
 * struck out and given no score.
 */
const ROWS = [
  { name: "ghostty", value: 1, label: "1.00×", gate: "screen + scrollback match 10/10 · scored" },
  {
    name: "alacritty",
    value: 0.96,
    label: "0.96×",
    gate: "screen + scrollback match 10/10 · scored",
  },
  {
    name: "velocitty 1.3",
    value: 1.9,
    label: "1.9×",
    gate: "mismatch 7/10 · 412,000 scrollback lines missing",
    cheat: true,
  },
] as const;
const MAX = 1.9;

export function Velocitty() {
  return (
    <section className={cx(styles.section, styles.gate)} aria-labelledby="velo-h">
      <div className={styles.gateIntro}>
        <h2 id="velo-h">The benchmark that skips the work</h2>
        <p>
          Velocitty 1.3.0 shipped automated throughput comparisons against Ghostty, and the numbers
          said it was faster. Mitchell Hashimoto read the source and replied:
        </p>
        <blockquote className={styles.quote}>
          <p>
            your read loop overwrites a 64 KiB ring. Everything older is discarded unparsed per
            tick. You&apos;re faster because you&apos;re not actually terminal emulating.
          </p>
          <footer>Mitchell Hashimoto, on X</footer>
        </blockquote>
        <p>What the benchmark really measured was how fast the terminal could throw output away.</p>
      </div>

      <figure className={styles.chart} aria-labelledby="velo-chart-title">
        <div className={styles.chartHead}>
          <span className={styles.example}>illustrative, not a real run</span>
          <span id="velo-chart-title" className={styles.chartTitle}>
            How an Anybench kit reports it
          </span>
          <span className={styles.chartSub}>
            terminal throughput vs ghostty · 150 MB mixed output · 10 runs each
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
          Output older than the 64 KiB read buffer is dropped before parsing. Throughput isn&apos;t
          comparable until every run matches the reference, so the 1.9× never reaches the report.
        </p>
      </figure>

      <div className={styles.gateLists}>
        <div className={styles.listOut}>
          <h3>What that benchmark checked</h3>
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
              parser, cell by cell
            </li>
            <li>A run that doesn&apos;t match gets no speed score</li>
            <li>
              The kit builds a version that drops chunks of output and confirms the gate catches it
            </li>
          </ul>
        </div>
      </div>

      <p className={styles.verdict}>No speed number without a correctness gate.</p>
      <p className={styles.src}>
        Sources:{" "}
        <a href="https://github.com/valvesky/velocitty/releases/tag/v1.3.0">
          Velocitty 1.3.0 release notes
        </a>{" "}
        and{" "}
        <a href="https://x.com/mitchellh/status/2115292243443519571">Hashimoto&apos;s reply on X</a>
        . The reply itself doesn&apos;t name a version.
      </p>
    </section>
  );
}
