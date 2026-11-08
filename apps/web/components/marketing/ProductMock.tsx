"use client";

import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "./cx";
import styles from "./marketing.module.css";
import { CodeLines, type Line } from "./CodeLines";
import { RunGrid, TileLegend } from "./RunGrid";

/**
 * The four-screen product mock (Ask, Test plan, Running, Results). Static: every
 * number in it is an illustrative example, and the mock says so on every screen.
 */

const TABS = [
  { id: "ask", label: "Ask" },
  { id: "plan", label: "Test plan" },
  { id: "run", label: "Running" },
  { id: "res", label: "Results" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export function ProductMock() {
  const [active, setActive] = useState<TabId>("res");
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TABS.length - 1;
    if (next === null) return;
    event.preventDefault();
    const tab = TABS[next];
    if (!tab) return;
    setActive(tab.id);
    refs.current[next]?.focus();
  }

  return (
    <div className={styles.app}>
      <div className={styles.appBar}>
        <span className={styles.dots} aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span className={styles.url}>anybench.jaxonp.com/b/tandem-workers</span>
        <span className={styles.example}>example numbers</span>
      </div>
      <div className={styles.appNav} role="tablist" aria-label="Anybench screens">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`mock-tab-${t.id}`}
            aria-controls={`mock-panel-${t.id}`}
            aria-selected={active === t.id}
            tabIndex={active === t.id ? 0 : -1}
            onClick={() => setActive(t.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            <span className={styles.tabNum} aria-hidden="true">
              {i + 1}
            </span>
            {t.label}
          </button>
        ))}
      </div>
      <Panel id="ask" active={active}>
        <AskPane />
      </Panel>
      <Panel id="plan" active={active}>
        <PlanPane />
      </Panel>
      <Panel id="run" active={active}>
        <RunPane />
      </Panel>
      <Panel id="res" active={active}>
        <ResultsPane />
      </Panel>
    </div>
  );
}

function Panel({ id, active, children }: { id: TabId; active: TabId; children: ReactNode }) {
  return (
    <div
      className={styles.pane}
      id={`mock-panel-${id}`}
      role="tabpanel"
      aria-labelledby={`mock-tab-${id}`}
      hidden={active !== id}
      tabIndex={0}
    >
      {children}
    </div>
  );
}

const SETUPS = [
  ["A", "Claude Code solo", "baseline · from your .claude/ folder, subagents removed"],
  ["B", "Claude Code + subagents", "from your .claude/ folder"],
  ["C", "Tandem ×3", "github.com/jaximus808/tandem · WORKERS=3"],
  ["D", "Tandem ×5", "same harness · WORKERS=5"],
] as const;

function AskPane() {
  return (
    <div className={styles.formGrid}>
      <div className={styles.stack}>
        <div className={cx(styles.stack, styles.stackSm)}>
          <span className={styles.lbl}>Your question</span>
          <div className={styles.input}>
            Does Tandem with 3 or 5 workers beat plain Claude Code with subagents?
          </div>
        </div>
        <div className={cx(styles.stack, styles.stackSm)}>
          <span className={styles.lbl}>Setups to compare</span>
          {SETUPS.map(([letter, name, detail]) => (
            <div key={letter} className={styles.setup}>
              <span className={styles.sl}>{letter}</span>
              <div>
                <b>{name}</b>
                <small>{detail}</small>
              </div>
            </div>
          ))}
          <div className={cx(styles.setup, styles.setupAdd)}>+ Add a setup</div>
        </div>
      </div>
      <div className={styles.stack}>
        <KV label="Tasks">
          Let Anybench choose <em>(recommended)</em>
        </KV>
        <KV label="Runs per setup and task">5</KV>
        <KV label="Approvals">A reviewer agent plays the human</KV>
        <KV label="Token budget">$120 cap, on your Anthropic key</KV>
        <KV label="Send results to">Email and Slack</KV>
        <span className={styles.fakeBtn}>Design the test</span>
      </div>
    </div>
  );
}

function KV({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.kv}>
      <span className={styles.lbl}>{label}</span>
      <span>{children}</span>
    </div>
  );
}

const TASKS = [
  [
    "todo-api",
    "Build a REST API with auth and tests",
    "Splits cleanly into 5 tickets. This is where parallel workers should help.",
  ],
  [
    "auth-refactor",
    "Move sessions to JWT across 9 files",
    "Tightly coupled. This is where parallel workers may get in each other's way.",
  ],
  [
    "bug-hunt",
    "Fix the bug from your commit 3f2a1c",
    "Taken from your repo's history. The tests in that commit become the grader.",
  ],
] as const;

const REQUIREMENTS = [
  ["measured", "Hidden tests pass (42 tests across 3 tasks)", "all pass", 50],
  ["measured", "API p95 latency at 50 requests/s (todo-api)", "under 120 ms", 10],
  ["measured", "Wall-clock time to finish", "lower is better", 10],
  ["measured", "Cost per task (tokens × price)", "lower is better", 10],
  [
    "reviewed",
    "Code quality: follows the repo's patterns, handles errors, tests check real behavior, no dead code",
    "4-point rubric",
    20,
  ],
] as const;

const CHECKS = [
  "oracle 3/3 at 100%",
  "do-less 3/3 caught",
  "smoke run passed",
  "planted regression caught",
  "baseline in range",
];

function PlanPane() {
  return (
    <>
      <p className={styles.panehead}>
        Anybench designed this test for your setups. Edit anything, or run it as is.
      </p>
      <div className={styles.tasks}>
        {TASKS.map(([id, title, why]) => (
          <div key={id} className={styles.task}>
            <span className={styles.tid}>{id}</span>
            <b>{title}</b>
            <p>
              <span className={styles.lbl}>why</span> {why}
            </p>
          </div>
        ))}
      </div>
      <div className={styles.reqs}>
        <div className={styles.reqhead}>
          <span className={styles.lbl}>Requirements</span>
          <span className={styles.muted}>The weights make up the score. Edit any line.</span>
        </div>
        <div className={styles.scroll} role="group" aria-label="Requirements" tabIndex={0}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Requirement</th>
                <th scope="col">Target</th>
                <th scope="col" className={styles.num}>
                  Weight
                </th>
              </tr>
            </thead>
            <tbody>
              {REQUIREMENTS.map(([type, req, target, weight]) => (
                <tr key={req}>
                  <td>
                    <span
                      className={cx(styles.type, type === "measured" ? styles.typeM : styles.typeV)}
                    >
                      {type}
                    </span>
                  </td>
                  <td>{req}</td>
                  <td>{target}</td>
                  <td className={styles.num}>{weight}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={styles.reqnote}>
          A separate review model scores reviewed requirements against the written rubric. Every
          score quotes the lines of code it&apos;s based on, and a sample is scored twice to check
          that it&apos;s consistent.
        </p>
      </div>
      <div className={styles.checks}>
        <span className={styles.lbl}>Proof the test works</span>
        {CHECKS.map((c) => (
          <span key={c} className={styles.ck}>
            ✓ {c}
          </span>
        ))}
      </div>
      <div className={styles.estimate}>
        <span>
          <b>60 trials</b> · about 40 min · about $19 for the run and computer time · $40–120 in
          tokens on your key
        </span>
        <span className={styles.fakeBtn}>Run 60 trials</span>
      </div>
    </>
  );
}

const FEED: Line[] = [
  [["23:04", "d"], ["  C · todo-api · run 3        "], ["passed", "g"], ["  11m 40s · $3.80"]],
  [
    ["23:03", "d"],
    ["  D · auth-refactor · run 2   "],
    ["failed", "r"],
    ["  merge conflict in src/session.ts"],
  ],
  [
    ["23:02", "d"],
    [
      '  reviewer                    rejected "add a Redis cache" (not in the spec) · C · todo-api · run 4',
    ],
  ],
  [["23:01", "d"], ["  B · bug-hunt · run 5        started on a fresh Naïve computer"]],
];

function RunPane() {
  return (
    <>
      <div className={styles.stats}>
        <div>
          <span className={styles.lbl}>Done</span>
          <b>38 / 60</b>
        </div>
        <div>
          <span className={styles.lbl}>Running now</span>
          <b>14</b>
          <small>on Naïve computers</small>
        </div>
        <div>
          <span className={styles.lbl}>Spent</span>
          <b>$31</b>
          <small>of $120 cap</small>
        </div>
        <div>
          <span className={styles.lbl}>Elapsed</span>
          <b>23 min</b>
        </div>
      </div>
      <RunGrid compact />
      <TileLegend extra="columns: todo-api ×5 · auth-refactor ×5 · bug-hunt ×5" />
      <div className={styles.feed}>
        <CodeLines lines={FEED} label="Example live feed of trial events" />
      </div>
    </>
  );
}

const RESULTS = [
  ["A · claude code solo", 54, "8/15", "140 ms", "31 min", "$5.10", "0"],
  ["B · claude code + subagents", 61, "9/15", "118 ms", "22 min", "$5.80", "0"],
  ["C · tandem ×3", 74, "11/15", "96 ms", "13 min", "$4.90", "6"],
  ["D · tandem ×5", 66, "10/15", "101 ms", "12 min", "$6.70", "7"],
] as const;

function ResultsPane() {
  return (
    <div className={styles.report}>
      <div className={styles.reportHead}>
        <span className={styles.example}>example report · made-up numbers</span>
        <span className={styles.reportQ}>
          Q: does tandem with 3 or 5 workers beat plain claude code with subagents?
        </span>
        <span className={styles.reportAns}>
          Tandem ×3 scores 74, 13 points above Claude Code with subagents. It passes more tests,
          finishes 41% faster and serves the API faster. On the tightly coupled refactor it does
          worse. ×5 scores lower than ×3.
        </span>
      </div>
      <div className={styles.scroll} role="group" aria-label="Example results" tabIndex={0}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Setup</th>
              <th scope="col" className={styles.num}>
                Score
              </th>
              <th scope="col" className={styles.num}>
                Tasks solved
              </th>
              <th scope="col" className={styles.num}>
                API p95
              </th>
              <th scope="col" className={styles.num}>
                Median time
              </th>
              <th scope="col" className={styles.num}>
                Cost per solved task
              </th>
              <th scope="col" className={styles.num}>
                Human minutes
              </th>
            </tr>
          </thead>
          <tbody>
            {RESULTS.map(([setup, score, solved, p95, time, cost, human]) => (
              <tr key={setup} className={score === 74 ? styles.best : undefined}>
                <th scope="row">{setup}</th>
                <td className={styles.num}>
                  <span className={styles.bar} aria-hidden="true">
                    <i style={{ width: `${score}%` }} />
                  </span>
                  {score}
                </td>
                <td className={styles.num}>{solved}</td>
                <td className={styles.num}>{p95}</td>
                <td className={styles.num}>{time}</td>
                <td className={styles.num}>{cost}</td>
                <td className={styles.num}>{human}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={styles.reportFoot}>
        <span>
          <b>How C got 74:</b> tests 39/50 · latency 9/10 · time 9/10 · cost 7/10 · code quality
          10/20 (error handling was weak in 3 of 5 runs, with the lines quoted in the full report).
        </span>
        <span>
          <b>Where it breaks:</b> on auth-refactor, Tandem ×3 passed 2/5 against 3/5 for subagents.
          Workers edited the same files, and 3 of 5 runs hit merge conflicts.
        </span>
        <span className={styles.proof}>
          kit proof: oracle 3/3 · do-less 3/3 caught · smoke pass · planted regression caught ·
          baseline in range · 60 trials · 95% intervals in the full report
        </span>
        <div className={styles.actions}>
          <span className={cx(styles.fakeBtn, styles.fakeGhost)}>Share report</span>
          <span className={cx(styles.fakeBtn, styles.fakeGhost)}>Rerun on next release</span>
          <span className={cx(styles.fakeBtn, styles.fakeGhost)}>Download the test kit</span>
        </div>
      </div>
    </div>
  );
}
