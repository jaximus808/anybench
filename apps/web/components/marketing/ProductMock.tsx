"use client";

import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "./cx";
import styles from "./marketing.module.css";
import { CodeLines, type Line } from "./CodeLines";
import { RunGrid, TileLegend } from "./RunGrid";

/**
 * The four-screen product mock (Ask, Test plan, Running, Results). Static.
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
    "Fix a planted bug in the session middleware",
    "A bug planted on purpose, with hidden tests that catch it. Every setup gets the same broken repo.",
  ],
] as const;

const REQUIREMENTS = [
  ["measured", "Hidden tests pass (42 tests across 3 tasks)", "all pass"],
  ["measured", "API p95 latency at 50 requests/s (todo-api)", "under 120 ms"],
  ["measured", "Time to solve (failures counted at the cap)", "lower is better · cap 45 min"],
  ["measured", "Cost per solved task (all spend ÷ solved)", "lower is better"],
  [
    "reviewed",
    "Code quality: follows the repo's patterns, handles errors, tests check real behavior, no dead code",
    "4-point rubric",
  ],
] as const;

const CHECKS = [
  "oracle 3/3 at 100%",
  "do-less 3/3 caught",
  "smoke run passed",
  "planted regression caught",
  "baseline in range",
];

/**
 * Cost model, kept consistent everywhere it appears: about $1.60 of
 * tokens and $0.25 of compute (30 min on 4 vCPU / 8 GiB) per trial, 14 trials at a
 * time. 60 trials ≈ $15 compute + $2 run fee ≈ $17, plus ≈ $96 of tokens.
 */
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
          <span className={styles.muted}>Each one gets its own verdict. Edit any line.</span>
        </div>
        <div className={styles.scroll} role="group" aria-label="Requirements" tabIndex={0}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Requirement</th>
                <th scope="col">Target</th>
              </tr>
            </thead>
            <tbody>
              {REQUIREMENTS.map(([type, req, target]) => (
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={styles.reqnote}>
          Power: at 3 tasks × 5 runs, the smallest detectable pass-rate difference is ≈45 pts. Add
          runs to detect smaller ones. Reviewed requirements are scored by separate review models
          against the written rubric, and every score quotes the lines of code it&apos;s based on.
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
          <b>60 trials</b> · about 2 h, 14 at a time · ≈ $15 compute + $2 run fee ≈ $17 · tokens ≈
          $96 on your key
        </span>
        <span className={styles.fakeBtn}>Run 60 trials</span>
      </div>
    </>
  );
}

const FEED: Line[] = [
  [
    ["1:19", "d"],
    ["  C · todo-api · run 3        "],
    ["passed", "g"],
    ["  11m 40s · $1.58 tokens"],
  ],
  [
    ["1:18", "d"],
    ["  D · auth-refactor · run 2   "],
    ["failed", "r"],
    ["  merge conflict in src/session.ts"],
  ],
  [
    ["1:17", "d"],
    [
      '  reviewer                    rejected "add a Redis cache" (not in the spec) · C · todo-api · run 4',
    ],
  ],
  [["1:16", "d"], ["  B · bug-hunt · run 5        started on a fresh Naïve computer"]],
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
          <span className={styles.lbl}>Tokens spent</span>
          <b>$61</b>
          <small>of $120 cap</small>
        </div>
        <div>
          <span className={styles.lbl}>Elapsed</span>
          <b>1 h 20 min</b>
          <small>of about 2 h</small>
        </div>
      </div>
      <RunGrid />
      <TileLegend extra="columns: todo-api ×5 · auth-refactor ×5 · bug-hunt ×5" />
      <div className={styles.feed}>
        <CodeLines lines={FEED} label="Live feed of trial events" />
      </div>
    </>
  );
}

/** Verdict wording; every phrase used here must stay a plan.md 17.2 verdict. */
export const EXAMPLE_HEADLINE =
  "On these 3 tasks, Tandem ×3 solves faster than Claude Code with subagents (−9 min, 95% CI −14 to −3). Pass rate: no detectable difference at n=15 per setup (+13 pts, CI −19 to +42; smallest detectable ≈45 pts). ×5 vs ×3: no detectable difference.";

/** Per-requirement rows: Tandem ×3 (C) against Claude Code + subagents (B). */
const REQUIREMENT_ROWS: ReadonlyArray<
  readonly [requirement: string, b: string, c: string, diff: string, verdict: string]
> = [
  [
    "Trials passed (hidden tests)",
    "9/15, Wilson 36–80%",
    "11/15, Wilson 48–89%",
    "+13 pts (CI −19 to +42)",
    "no detectable difference at n=15",
  ],
  [
    "Time to solve (failures counted at the cap)",
    "22 min median, n=15",
    "13 min median, n=15",
    "−9 min (CI −14 to −3)",
    "better",
  ],
  [
    "API p95 at 50 requests/s (todo-api)",
    "118 ms, n=5",
    "96 ms, n=5",
    "−22 ms (CI −35 to −8)",
    "better",
  ],
  [
    "Cost per solved task (all spend ÷ solved)",
    "$3.08 (9 solved)",
    "$2.52 (11 solved)",
    "−$0.56 (CI −$1.40 to +$0.60)",
    "no detectable difference at n=15",
  ],
  [
    "Simulated approvals",
    "none (no approval step)",
    "14, median latency 40 s",
    "not compared",
    "not scored",
  ],
];

function ResultsPane() {
  return (
    <div className={styles.report}>
      <div className={styles.reportHead}>
        <span className={styles.reportQ}>
          Q: does tandem with 3 or 5 workers beat plain claude code with subagents?
        </span>
        <span className={styles.reportAns}>{EXAMPLE_HEADLINE}</span>
      </div>
      <div className={styles.scroll} role="group" aria-label="Results" tabIndex={0}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Requirement</th>
              <th scope="col">B · claude code + subagents</th>
              <th scope="col">C · tandem ×3</th>
              <th scope="col">Difference, 95% CI</th>
              <th scope="col">Verdict</th>
            </tr>
          </thead>
          <tbody>
            {REQUIREMENT_ROWS.map(([req, b, c, diff, verdict]) => (
              <tr key={req}>
                <th scope="row">{req}</th>
                <td>{b}</td>
                <td>{c}</td>
                <td>{diff}</td>
                <td>{verdict}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={styles.reportFoot}>
        <span>
          <b>Tandem ×5 vs ×3:</b> no detectable difference at n=15 (10/15 vs 11/15 passed, −7 pts,
          CI −36 to +24; 12 vs 13 min). <b>Claude Code solo:</b> 8/15 passed, 31 min; compared with
          subagents, no detectable difference in pass rate at n=15.
        </span>
        <span>
          <b>Where it breaks:</b> on auth-refactor, Tandem ×3 looked worse in this sample (2/5 vs
          3/5), no detectable difference at n=5. Workers edited the same files, and 3 of 5 runs hit
          merge conflicts.
        </span>
        <span className={styles.proof}>
          kit proof: oracle 3/3 · do-less 3/3 caught · smoke pass · planted regression caught ·
          baseline in range · 60 trials · Holm-corrected across the report&apos;s comparisons
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
