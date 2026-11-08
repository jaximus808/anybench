"use client";
// Drill-downs as slide-over drawers on the same page (deep-linked with ?trial= / ?agent=), so
// you never leave the live view. Real runs fetch the trial detail and tail its log; the demo
// synthesizes a transcript tail from the trial's own events and says so.
import {
  apiRoutes,
  isFinalTrialState,
  TRIAL_PHASES,
  type TrialDetail,
  type TrialId,
} from "@anybench/core";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../../lib/api";
import {
  tileTone,
  trialLabel,
  type FeedItem,
  type LiveAgent,
  type LiveRun,
  type LiveTrial,
} from "../../lib/live/model";
import { agentPhase } from "./AgentsPanel";
import { bytes, clock, ms, pctOf, span, usd, usdSmall } from "./format";
import styles from "./live.module.css";

function Drawer({
  title,
  kicker,
  onClose,
  children,
}: {
  title: string;
  kicker: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
  }, [title]);
  return (
    <aside className={styles.drawer} role="dialog" aria-modal="false" aria-label={title}>
      <header className={styles.drawerHead}>
        <div>
          <p className="eyebrow">{kicker}</p>
          <h2 className={styles.drawerTitle}>{title}</h2>
        </div>
        <button
          ref={closeRef}
          type="button"
          className={styles.drawerClose}
          onClick={onClose}
          aria-label="Close (Esc)"
        >
          Esc ✕
        </button>
      </header>
      <div className={styles.drawerBody}>{children}</div>
    </aside>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.stat}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const TONE_TEXT = {
  queued: "Queued",
  active: "Running",
  passed: "Passed gate",
  failed: "Failed",
  infra: "Infra failure (retried)",
  cancelled: "Cancelled",
} as const;

/** Synthesized log lines for the demo, one or two per event; labelled as simulated. */
function demoTail(live: LiveRun, t: LiveTrial, items: FeedItem[]): string[] {
  const start = ms(live.createdAt);
  const contender = live.contenders.find((c) => c.id === t.contenderId)?.name ?? "contender";
  const out: string[] = [];
  for (const it of items) {
    const ts = `[${clock(ms(it.at) - start)}]`;
    switch (it.phaseTo) {
      case "forking":
        out.push(`${ts} runner: fork agent-cc snapshot → fresh computer`);
        break;
      case "installing":
        out.push(`${ts} $ ./adapters/${contender.replace(/\W+/g, "-")}/install.sh`);
        break;
      case "warming":
        out.push(`${ts} $ git clone workloads/${t.workload} && npm ci`);
        break;
      case "running":
        out.push(
          `${ts} $ claude -p "$(cat workloads/${t.workload}/task.md)" --output-format stream-json`,
        );
        break;
      case "collecting":
        out.push(`${ts} runner: freeze outputs → diff.patch, test-report.json`);
        break;
      case "gating":
        out.push(`${ts} $ ./gates/tests-pass.sh`);
        break;
      case "reviewing":
        out.push(`${ts} reviewer: scoring rubric with quoted evidence`);
        break;
      case "done":
        out.push(`${ts} runner: done, computer destroyed`);
        break;
      case "failed_infra":
        out.push(`${ts} runner: lost heartbeat, retrying on a new computer`);
        break;
      case "failed_subject":
        out.push(`${ts} runner: subject failed (${t.failureClass ?? "subject"})`);
        break;
      default:
        if (it.type === "trial.log_chunk")
          out.push(`${ts} ${it.text.split(": ").slice(1).join(": ")}`);
        else if (it.type === "trial.gate")
          out.push(`${ts} gate: ${it.text.split(": gate ")[1] ?? it.text}`);
        else if (it.type === "trial.network")
          out.push(`${ts} net: ${it.text.split(": ")[1] ?? it.text}`);
    }
  }
  return out;
}

export function TrialDrawer({
  live,
  trial,
  isDemo,
  nowMs,
  onClose,
}: {
  live: LiveRun;
  trial: LiveTrial;
  isDemo: boolean;
  nowMs: number;
  onClose: () => void;
}) {
  const items = useMemo(
    () => live.feed.filter((f) => f.sourceId === trial.id),
    [live.feed, trial.id],
  );
  const phases = items.filter((i) => i.phaseTo);
  const tone = tileTone(trial);
  const final = isFinalTrialState(trial.state);
  const start = ms(live.createdAt);

  // Real runs: the trial detail and a polled log tail.
  const [detail, setDetail] = useState<TrialDetail | null>(null);
  const [log, setLog] = useState<string>("");
  const [logErr, setLogErr] = useState<string | null>(null);
  useEffect(() => {
    if (isDemo) return;
    let stop = false;
    let offset = 0;
    let timer: number | undefined;
    const id = trial.id as TrialId;
    api()
      .call(apiRoutes.trials.get, { params: { id } })
      .then((r) => !stop && setDetail(r.trial))
      .catch(() => undefined);
    const poll = async () => {
      try {
        const r = await api().call(apiRoutes.trials.log, {
          params: { id },
          query: { stream: "stdout", offset, bytes: 64 * 1024 },
        });
        if (stop) return;
        offset = r.next_offset;
        if (r.text) setLog((prev) => (prev + r.text).slice(-64 * 1024));
        if (!r.eof) timer = window.setTimeout(poll, 3000);
      } catch (e) {
        if (!stop) setLogErr(e instanceof Error ? e.message : String(e));
      }
    };
    void poll();
    return () => {
      stop = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [isDemo, trial.id]);

  const tail = isDemo ? demoTail(live, trial, items).join("\n") : log;
  const tailRef = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    const el = tailRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [tail]);

  const gate = trial.gate;
  const detailGate = detail?.gate ?? null;

  return (
    <Drawer title={trialLabel(live, trial)} kicker="Trial" onClose={onClose}>
      <div className={styles.drawerStatus} data-tone={tone}>
        <span className={styles.statusDot} aria-hidden="true" />
        {TONE_TEXT[tone]}
        {tone === "active" ? <span className={styles.statusPhase}>{trial.state}</span> : null}
      </div>

      <section
        className={styles.gateBox}
        data-pass={gate ? String(gate.passed) : "pending"}
        aria-labelledby="gate-h"
      >
        <h3 id="gate-h">Correctness gate</h3>
        {gate ? (
          <>
            <p className={styles.gateVerdict}>
              {gate.passed ? "Passed" : "Failed"} <code>{gate.gate}</code>
            </p>
            {gate.summary ? <p className={styles.gateSummary}>{gate.summary}</p> : null}
            {detailGate?.evidence.length ? (
              <ul className={styles.evidence}>
                {detailGate.evidence.map((e) => (
                  <li key={e}>
                    <code>{e}</code>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <p className={styles.gateSummary}>
            Not gated yet. No number from this trial counts until its gate passes.
          </p>
        )}
      </section>

      <dl className={styles.stats}>
        <Stat label="attempt">
          <span className="num">{trial.attempt}</span>
        </Stat>
        <Stat label="elapsed">
          <span className="num">
            {trial.startedAt
              ? span((trial.endedAt ? ms(trial.endedAt) : nowMs) - ms(trial.startedAt))
              : "–"}
          </span>
        </Stat>
        <Stat label="cost">
          <span className="num">{usdSmall(trial.costMicroUsd)}</span>
        </Stat>
        <Stat label="log">
          <span className="num">{bytes(trial.logBytes)}</span>
        </Stat>
        {detail?.provider ? <Stat label="provider">{detail.provider}</Stat> : null}
        {detail?.computer_id ? (
          <Stat label="computer">
            <code>{detail.computer_id.slice(0, 8)}</code>
          </Stat>
        ) : null}
      </dl>

      {detail?.metrics && detailGate?.pass ? (
        <section className={styles.drawerSection}>
          <h3>Raw readings (gate passed)</h3>
          <dl className={styles.stats}>
            {Object.entries(detail.metrics).map(([k, v]) => (
              <Stat key={k} label={k}>
                <span className="num">{v}</span>
              </Stat>
            ))}
          </dl>
        </section>
      ) : null}

      <section className={styles.drawerSection} aria-labelledby="phases-h">
        <h3 id="phases-h">Phases</h3>
        <ol className={styles.timeline}>
          {TRIAL_PHASES.slice(1).map((p) => {
            const hits = phases.filter((x) => x.phaseTo === p);
            const hit = hits[hits.length - 1];
            const idx = phases.indexOf(hit!);
            const nextAt = idx >= 0 && phases[idx + 1] ? ms(phases[idx + 1]!.at) : null;
            const dur = hit ? (nextAt ?? (final ? ms(hit.at) : nowMs)) - ms(hit.at) : 0;
            return (
              <li
                key={p}
                data-state={hit ? (trial.state === p && !final ? "now" : "done") : "todo"}
              >
                <span className={styles.tlName}>{p}</span>
                <span className="num">{hit ? clock(ms(hit.at) - start) : ""}</span>
                <span className="num">{hit && dur > 0 ? span(dur) : ""}</span>
              </li>
            );
          })}
          {phases
            .filter((x) => x.phaseTo === "failed_infra" || x.phaseTo === "failed_subject")
            .map((x) => (
              <li key={x.seq} data-state="fail">
                <span className={styles.tlName}>{x.phaseTo}</span>
                <span className="num">{clock(ms(x.at) - start)}</span>
                <span />
              </li>
            ))}
        </ol>
      </section>

      <section className={styles.drawerSection} aria-labelledby="tail-h">
        <h3 id="tail-h">
          Log tail{" "}
          {isDemo ? (
            <span className={styles.simTag}>simulated</span>
          ) : final ? null : (
            <span className={styles.liveTag}>live</span>
          )}
        </h3>
        {logErr ? <p className={styles.gateSummary}>Couldn’t read the log: {logErr}</p> : null}
        <pre className={styles.tail} ref={tailRef}>
          {tail || "Waiting for output…"}
        </pre>
      </section>

      <section className={styles.drawerSection}>
        <h3>Events</h3>
        <ol className={styles.miniFeed}>
          {items.slice(-60).map((i) => (
            <li key={i.seq}>
              <span className="num">{clock(ms(i.at) - start)}</span> {i.text}
            </li>
          ))}
        </ol>
      </section>
    </Drawer>
  );
}

export function AgentDrawer({
  live,
  agent,
  nowMs,
  onClose,
}: {
  live: LiveRun;
  agent: LiveAgent;
  nowMs: number;
  onClose: () => void;
}) {
  const start = ms(live.createdAt);
  const listRef = useRef<HTMLOListElement>(null);
  const [follow, setFollow] = useState(true);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [agent.activity.length, follow]);
  const phase = agentPhase(agent, nowMs);
  return (
    <Drawer title={agent.role} kicker="Agent session" onClose={onClose}>
      <div
        className={styles.drawerStatus}
        data-tone={phase === "working" ? "active" : phase === "failed" ? "failed" : "queued"}
      >
        <span className={styles.statusDot} aria-hidden="true" />
        {phase}
        {agent.lastTool ? (
          <span className={styles.statusPhase}>last tool: {agent.lastTool}</span>
        ) : null}
      </div>
      <dl className={styles.stats}>
        <Stat label="tool calls">
          <span className="num">{agent.toolCalls}</span>
        </Stat>
        <Stat label="spent">
          <span className="num">{usdSmall(agent.costMicroUsd)}</span>
        </Stat>
        <Stat label="budget">
          <span className="num">{agent.budgetMicroUsd > 0n ? usd(agent.budgetMicroUsd) : "–"}</span>
        </Stat>
        <Stat label="started">
          <span className="num">{agent.startedAt ? clock(ms(agent.startedAt) - start) : "–"}</span>
        </Stat>
      </dl>
      {agent.budgetMicroUsd > 0n ? (
        <div className={styles.bar} aria-hidden="true">
          <i style={{ width: `${pctOf(agent.costMicroUsd, agent.budgetMicroUsd)}%` }} />
        </div>
      ) : null}
      {agent.pending ? (
        <section className={styles.gateBox} data-pass="pending">
          <h3>Waiting on you</h3>
          <p className={styles.gateSummary}>
            {agent.pending.kind === "confirm_tool"
              ? `Confirm ${agent.pending.tool}: ${agent.pending.input_preview}`
              : agent.pending.question}
          </p>
        </section>
      ) : null}
      <section className={styles.drawerSection}>
        <h3>Activity</h3>
        <ol
          className={styles.agentLog}
          ref={listRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
          }}
        >
          {agent.activity.length === 0 ? <li className={styles.feedEmpty}>Nothing yet.</li> : null}
          {agent.activity.map((a) => (
            <li key={a.seq} data-kind={a.kind}>
              <span className="num">{clock(ms(a.at) - start)}</span>
              <span>{a.kind === "tool" ? `→ ${a.text}` : a.text}</span>
            </li>
          ))}
        </ol>
      </section>
    </Drawer>
  );
}
