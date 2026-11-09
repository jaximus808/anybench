import { CodeLines, type Line } from "./CodeLines";
import styles from "./marketing.module.css";

/** An /anybench session, adapted from the product page's "What you'd see". */
const SESSION: Line[] = [
  [[">", "a"], [" /anybench does tandem with 3 or 5 workers beat plain"]],
  [["  claude code with subagents?"]],
  [],
  [["●", "a"], [" Read the repo: Go binary + SQLite, stdio MCP server via npx,"]],
  [["  agents are Claude Code sessions."]],
  [["●", "a"], [" Wrote "], ["eval/harness.yaml", "a"], [" and "], ["eval/run.sh", "a"]],
  [
    ["●", "a"],
    [" Tasks: todo-api "],
    ["(splits cleanly)", "d"],
    [", auth-refactor "],
    ["(coupled)", "d"],
    [","],
  ],
  [["  bug-hunt "], ["(a planted bug)", "d"]],
  [["●", "a"], [" Human stand-in: Tandem approvals → llm-reviewer"]],
  [["  (a different model; sees the spec, not the tests)", "d"]],
  [["●", "a"], [" Proof"]],
  [["    oracle              3/3 tasks at 100%            "], ["pass", "g"]],
  [["    do-less             3/3 do-nothing runs fail     "], ["pass", "g"]],
  [["    smoke               tandem ×3 hello-api, 4m12s   "], ["pass", "g"]],
  [['    planted regression  "skip tests" 0.21 vs 0.67   '], ["pass", "g"]],
  [["●", "a"], [" Plan: 4 setups × 3 tasks × 5 runs = 60 trials"]],
  [["    about 2 h, 14 at a time · the price is shown before you start", "d"]],
  [["    tokens ≈ $96 on your key (cap $120)", "d"]],
  [],
  [["  Upload kit and start? "], ["(y/n)", "a"]],
];

const POINTS = [
  "Claude already has your repo, your .claude/ setup and your shell, so it writes the kit locally.",
  "It runs the smoke check in Docker before anything is uploaded. Your code leaves your machine only once it works.",
  "You see the proof checks and the estimate before a single trial runs.",
];

export function ClaudeCodeSession() {
  return (
    <section className={styles.section} aria-labelledby="cc-h">
      <div className={styles.split}>
        <div className={styles.splitCopy}>
          <h2 id="cc-h">
            Or type <code>/anybench</code> in Claude Code
          </h2>
          <p className={styles.lede}>
            A skill you install once. Ask your question where you already work.
          </p>
          <ul className={styles.points}>
            {POINTS.map((p) => (
              <li key={p}>
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path
                    d="M4.5 10.5l3.5 3.5 7.5-8"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span>{p}</span>
              </li>
            ))}
          </ul>
        </div>
        <figure className={styles.term} aria-label="/anybench session in Claude Code">
          <figcaption className={styles.termBar}>
            <span className={styles.termTitle}>
              <span className={styles.dots} aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              claude · ~/code/agentcanvas
            </span>
          </figcaption>
          <CodeLines lines={SESSION} label="/anybench session transcript" />
        </figure>
      </div>
    </section>
  );
}
