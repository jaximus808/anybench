import { cx } from "./cx";
import styles from "./marketing.module.css";

const ROWS: Array<[label: string, agents: string, harnesses: string, software: string]> = [
  [
    "examples",
    "An art gallery guide agent, a support agent",
    "Tandem, a Claude Code setup",
    "A terminal emulator, an eye-tracking library, an API server",
  ],
  [
    "compared against",
    "The same agent on other models, plain Claude with the same tools, your last prompt",
    "Plain Claude Code, Claude Code with subagents, other harnesses",
    "Competitors the agents find (Ghostty, Alacritty, kitty), your last release",
  ],
  [
    "measured",
    "Task success, cost, turns, response time",
    "Tests passed, time, tokens, cost",
    "Throughput, latency, memory, startup time, accuracy",
  ],
  [
    "correctness gate",
    "The outcome matches a known answer",
    "Hidden tests pass",
    "Output matches a reference: same screen state, same API responses, error measured against labeled data",
  ],
  ["reviewed", "Tone, following policy", "Code quality", "API design, docs, ease of use"],
];

export function ProjectKinds() {
  return (
    <section className={styles.section} aria-labelledby="kinds-h">
      <h2 id="kinds-h">Three kinds of project, one way in</h2>
      <p className={styles.lede}>
        You always start the same way: point Anybench at the project. Agents work out which kind it
        is, what &quot;better&quot; means for it, and what to compare it against. Every kind gets
        the same kit structure: workloads, measured requirements, a correctness gate for each one,
        and reviewed requirements.
      </p>
      <div
        className={styles.tw}
        role="group"
        aria-label="Three kinds of project (scrolls sideways)"
        tabIndex={0}
      >
        <table className={cx(styles.table, styles.kinds)}>
          <thead>
            <tr>
              <td />
              <th scope="col">Agents</th>
              <th scope="col">Harnesses</th>
              <th scope="col">Software</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map(([label, a, h, s]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td>{a}</td>
                <td>{h}</td>
                <td>{s}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
