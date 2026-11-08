"use client";
// One row per agent session (our Naïve agents: understander, researcher, kit designer, reviewer,
// investigator, ...): status, tool count, spend, and what it is doing right now.
import { memo } from "react";
import { liveAgents, type LiveAgent, type LiveRun } from "../../lib/live/model";
import { ms, usdSmall } from "./format";
import styles from "./live.module.css";

/** An agent is "working" if it did something in the last 8 s of run time. */
export const ACTIVE_WINDOW_MS = 8000;

export type AgentPhase = "working" | "waiting" | "idle" | "queued" | "done" | "failed";

export function agentPhase(a: LiveAgent, nowMs: number): AgentPhase {
  if (a.status === "failed" || a.status === "cancelled") return "failed";
  if (a.status === "done") return "done";
  if (a.status === "waiting" || a.pending) return "waiting";
  if (!a.lastAt) return "queued";
  return nowMs - ms(a.lastAt) <= ACTIVE_WINDOW_MS ? "working" : "idle";
}

export function agentNow(a: LiveAgent): string {
  const last = a.activity[a.activity.length - 1];
  if (!last) return a.lastTool ? `→ ${a.lastTool}` : "waiting to start";
  return last.kind === "tool" ? `→ ${last.text}` : `“${last.text}”`;
}

export const AgentsPanel = memo(function AgentsPanel({
  live,
  nowMs,
  selectedId,
  onOpen,
}: {
  live: LiveRun;
  nowMs: number;
  selectedId: string | null;
  onOpen: (id: string) => void;
}) {
  const agents = liveAgents(live);
  const working = agents.filter((a) => agentPhase(a, nowMs) === "working").length;
  return (
    <section className={styles.panel} aria-labelledby="agents-h">
      <header className={styles.panelHead}>
        <h2 id="agents-h" className={styles.panelTitle}>
          Agents
        </h2>
        <span className={styles.panelMeta}>
          <span className="num">{working}</span> working ·{" "}
          <span className="num">{agents.length}</span> sessions
        </span>
      </header>
      <ul className={styles.agents}>
        {agents.map((a) => {
          const phase = agentPhase(a, nowMs);
          return (
            <li key={a.id}>
              <button
                type="button"
                className={styles.agent}
                data-phase={phase}
                data-selected={selectedId === a.id || undefined}
                onClick={() => onOpen(a.id)}
                aria-label={`${a.role}: ${phase}, ${a.toolCalls} tool calls, ${usdSmall(a.costMicroUsd)}`}
              >
                <span className={styles.agentDot} aria-hidden="true" />
                <span className={styles.agentRole}>{a.role}</span>
                <span className={styles.agentStat}>
                  <span className="num">{a.toolCalls}</span> tools
                </span>
                <span className={`num ${styles.agentCost}`}>{usdSmall(a.costMicroUsd)}</span>
                <span className={styles.agentNow} key={a.activity.length}>
                  {agentNow(a)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
});
