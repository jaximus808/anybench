"use client";
// The Trace view: what every agent session in a trial did, on one time axis. One lane per session
// (the solo agent; or Tandem's planner and workers), model turns and tool calls as blocks, idle
// stretches hatched, the board's events on their own lane, and for a failed trial the failing
// test with the steps that touched what it tests. All transcript text is agent-written: it renders
// as React text nodes only.
import {
  ApiClientError,
  apiRoutes,
  type TraceActor,
  type TraceCoordEvent,
  type TraceStep,
  type TrialId,
  type TrialTrace,
} from "@anybench/core";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useLiveApi } from "../../lib/live/client";
import { describeApiError } from "../../lib/live/useLiveRun";
import { usdSmall } from "../live/format";
import { dur, KIND_WORD, pct, tickLabel, ticks, tok, traceSentences, traceTotals } from "./model";
import s from "./trace.module.css";

type Pick = { actor: string; step: number };

const COORD_WORD: Record<TraceCoordEvent["kind"], string> = {
  epic_proposed: "Plan proposed",
  approved: "Plan approved",
  task_created: "Ticket created",
  claimed: "Ticket claimed",
  lost_claim: "Claim lost (someone else had it)",
  task_done: "Ticket done",
};

const ROLE_WORD: Record<TraceActor["role"], string> = {
  solo: "agent",
  planner: "planner",
  worker: "worker",
  subagent: "subagent",
};

/** Fetches GET /trials/:id/trace and renders it (the trial drawer's Trace tab). */
export function TrialTraceSection({ trialId, final }: { trialId: string; final: boolean }) {
  const client = useLiveApi();
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "none" }
    | { kind: "error"; message: string }
    | { kind: "ok"; trace: TrialTrace }
  >({ kind: "loading" });
  useEffect(() => {
    let stop = false;
    client
      .call(apiRoutes.trials.trace, { params: { id: trialId as TrialId } })
      .then((r) => !stop && setState({ kind: "ok", trace: r.trace }))
      .catch((e: unknown) => {
        if (stop) return;
        if (e instanceof ApiClientError && e.status === 404) setState({ kind: "none" });
        else setState({ kind: "error", message: describeApiError(e) });
      });
    return () => {
      stop = true;
    };
  }, [client, trialId, final]);
  if (state.kind === "loading") return <p className={s.empty}>Loading the trace…</p>;
  if (state.kind === "none")
    return (
      <p className={s.empty}>
        {final
          ? "No trace for this trial. It is built from the agent transcripts once the trial is graded."
          : "The trace appears when this trial has been graded."}
      </p>
    );
  if (state.kind === "error")
    return <p className={s.empty}>Couldn’t load the trace: {state.message}</p>;
  return <TraceView trace={state.trace} />;
}

export function TraceView({ trace }: { trace: TrialTrace }) {
  const [selected, setSelected] = useState<Pick | null>(null);
  const related = useMemo(
    () => new Set((trace.failure?.related ?? []).map((r) => `${r.actor}#${r.step}`)),
    [trace.failure],
  );
  const lead = traceSentences(trace);
  const sel = selected
    ? trace.actors.find((a) => a.id === selected.actor)?.steps[selected.step]
    : undefined;

  return (
    <div className={s.trace} data-testid="trace-view">
      <div className={s.lead}>
        {lead.map((l) => (
          <p key={l}>{l}</p>
        ))}
      </div>
      <WallBar trace={trace} />
      {trace.failure ? <WhyFailed trace={trace} onPick={setSelected} /> : null}
      <Lanes trace={trace} related={related} selected={selected} onPick={setSelected} />
      {sel && selected ? (
        <section className={s.pinned} aria-live="polite" data-testid="trace-selected">
          <StepDetail actor={selected.actor} step={sel} />
          <button type="button" className={s.unpin} onClick={() => setSelected(null)}>
            Clear
          </button>
        </section>
      ) : null}
      <SessionTable trace={trace} />
      {trace.notes.length ? (
        <ul className={s.notes}>
          {trace.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function WallBar({ trace }: { trace: TrialTrace }) {
  const d = trace.duration_ms || 1;
  const parts = [
    { k: "model", label: "model in flight", v: trace.wall.model_ms },
    { k: "tool", label: "tools", v: trace.wall.tool_ms },
    { k: "coord", label: "board only", v: trace.wall.coordination_ms },
    { k: "idle", label: "nothing running", v: trace.wall.idle_ms },
  ];
  return (
    <figure className={s.wall} aria-label="Where the wall time went">
      <div className={s.wallBar}>
        {parts.map((p) =>
          p.v > 0 ? (
            <i
              key={p.k}
              data-kind={p.k}
              style={{ width: `${(p.v / d) * 100}%` }}
              title={`${p.label}: ${dur(p.v)}`}
            />
          ) : null,
        )}
      </div>
      <figcaption className={s.legend}>
        {parts
          .filter((p) => p.v > 0)
          .map((p) => (
            <span key={p.k} data-kind={p.k}>
              <b aria-hidden="true" />
              {p.label} <span className="num">{dur(p.v)}</span>
            </span>
          ))}
      </figcaption>
    </figure>
  );
}

function WhyFailed({ trace, onPick }: { trace: TrialTrace; onPick: (p: Pick) => void }) {
  const f = trace.failure!;
  const decisive = f.gates.filter((g) => g.applicable);
  return (
    <section className={s.why} aria-labelledby="why-h" data-testid="trace-why">
      <h3 id="why-h">Why it failed</h3>
      {f.tests.length ? (
        <>
          {f.passed !== null && f.total !== null ? (
            <p className={s.whyCount}>
              <span className="num">
                {f.passed}/{f.total}
              </span>{" "}
              hidden tests passed. The first one that failed:
            </p>
          ) : null}
          {f.tests.map((t) => (
            <div key={`${t.gate}${t.name}`} className={s.whyTest}>
              <p className={s.whyName}>
                {t.file ? <span className={s.whyFile}>{t.file}</span> : null}
                {t.name}
              </p>
              <pre className={s.whyMsg}>{t.message}</pre>
            </div>
          ))}
        </>
      ) : (
        <ul className={s.whyGates}>
          {decisive.map((g) => (
            <li key={g.gate}>
              <code>{g.gate}</code> {g.reason}
            </li>
          ))}
        </ul>
      )}
      {f.related.length ? (
        <>
          <p className={s.whySub}>
            Steps that touched what this test checks
            {f.terms.length ? <> ({f.terms.join(", ")})</> : null}. A lead to read first, not a
            proven cause:
          </p>
          <ol className={s.whySteps}>
            {f.related.map((r) => {
              const step = trace.actors.find((a) => a.id === r.actor)?.steps[r.step];
              if (!step) return null;
              return (
                <li key={`${r.actor}#${r.step}`}>
                  <button type="button" onClick={() => onPick({ actor: r.actor, step: r.step })}>
                    <span className={s.whyWho}>{r.actor}</span>
                    <span className="num">{tickLabel(step.start_ms)}</span>
                    <span className={s.whyWhat}>
                      {step.name}
                      {step.input ? `: ${step.input.split("\n")[0]}` : ""}
                    </span>
                  </button>
                  <span className={s.whyBecause}>{r.why}</span>
                </li>
              );
            })}
          </ol>
        </>
      ) : null}
      {decisive.length > f.tests.length ? (
        <p className={s.whyOther}>
          Also failed:{" "}
          {decisive
            .filter((g) => !f.tests.some((t) => t.gate === g.gate))
            .map((g) => `${g.gate} (${g.reason})`)
            .join("; ")}
        </p>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Swimlanes

const KEY = [
  { k: "model", label: "model turn" },
  { k: "board-turn", label: "model turn that only called the board" },
  { k: "tool", label: "tool call" },
  { k: "test", label: "test run (green: passed, red: failures)" },
  { k: "board", label: "board call" },
  { k: "wait", label: "waiting on the board" },
  { k: "gap", label: "not running" },
  { k: "related", label: "touched the failing test’s subject" },
] as const;

interface Hover {
  x: number;
  y: number;
  actor: string;
  step?: TraceStep;
  event?: TraceCoordEvent;
}

function Lanes({
  trace,
  related,
  selected,
  onPick,
}: {
  trace: TrialTrace;
  related: Set<string>;
  selected: Pick | null;
  onPick: (p: Pick) => void;
}) {
  const d = Math.max(1, trace.duration_ms);
  const at = (ms: number) => `${(ms / d) * 100}%`;
  const width = (a: number, b: number) => `${(Math.max(0, b - a) / d) * 100}%`;
  const tracksRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const show = (el: HTMLElement, h: Omit<Hover, "x" | "y">) => {
    const box = tracksRef.current?.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (!box) return;
    setHover({ ...h, x: r.left - box.left + r.width / 2, y: r.top - box.top });
  };
  const board = trace.coordination.filter((c) => c.kind !== "task_created");
  const present = new Set<string>();
  for (const a of trace.actors) {
    for (const st of a.steps) {
      present.add(st.kind === "model" && st.board_turn ? "board-turn" : st.kind);
      if (st.test) present.add("test");
    }
    if (a.gaps.length) present.add("gap");
  }
  if (trace.failure?.related.length) present.add("related");

  return (
    <figure className={s.lanesWrap} aria-label="Timeline of every session">
      <div className={s.lanes} onMouseLeave={() => setHover(null)}>
        <div className={s.labels} aria-hidden="true">
          <div className={s.phaseLabel}>phase</div>
          {board.length ? <div className={s.boardLabel}>board</div> : null}
          {trace.actors.map((a) => (
            <LaneLabel key={a.id} actor={a} />
          ))}
        </div>
        <div className={s.tracks} ref={tracksRef}>
          <div className={s.grid} aria-hidden="true">
            {ticks(d).map((t) => (
              <i key={t} style={{ left: at(t) }} />
            ))}
          </div>
          <div className={s.phaseTrack}>
            {trace.phases.map((p) => (
              <span
                key={p.name}
                data-phase={p.name}
                style={{ left: at(p.start_ms), width: width(p.start_ms, p.end_ms) }}
                title={`${p.name}: ${dur(p.end_ms - p.start_ms)}`}
              >
                {p.end_ms - p.start_ms > d * 0.07 ? p.name : ""}
              </span>
            ))}
          </div>
          {board.length ? (
            <div className={s.boardTrack}>
              {board.map((e, i) => (
                <button
                  type="button"
                  key={`${e.kind}${e.at_ms}${i}`}
                  className={s.mark}
                  data-kind={e.kind}
                  style={{ left: at(e.at_ms) }}
                  aria-label={`${COORD_WORD[e.kind]} ${e.ticket ?? ""} ${e.actor ?? ""} at ${tickLabel(e.at_ms)}`}
                  onMouseEnter={(ev) =>
                    show(ev.currentTarget, { actor: e.actor ?? "board", event: e })
                  }
                  onFocus={(ev) => show(ev.currentTarget, { actor: e.actor ?? "board", event: e })}
                  onBlur={() => setHover(null)}
                />
              ))}
            </div>
          ) : null}
          {trace.actors.map((a) => (
            <div key={a.id} className={s.track} data-role={a.role}>
              {a.gaps.map((g) => (
                <span
                  key={`${g.kind}${g.start_ms}`}
                  className={s.gap}
                  data-kind={g.kind}
                  style={{ left: at(g.start_ms), width: width(g.start_ms, g.end_ms) }}
                  title={
                    g.kind === "not_started"
                      ? `not started yet: ${dur(g.end_ms - g.start_ms)}`
                      : g.kind === "finished"
                        ? `session over: ${dur(g.end_ms - g.start_ms)}`
                        : `idle: ${dur(g.end_ms - g.start_ms)}`
                  }
                />
              ))}
              {a.steps.map((st, i) => {
                const key = `${a.id}#${i}`;
                return (
                  <button
                    type="button"
                    key={key}
                    className={s.block}
                    data-kind={st.kind}
                    data-board-turn={st.board_turn || undefined}
                    data-error={st.ok === false || undefined}
                    data-test={
                      st.test
                        ? /fail [1-9]/.test(st.test_summary ?? "")
                          ? "fail"
                          : "pass"
                        : undefined
                    }
                    data-related={related.has(key) || undefined}
                    data-selected={(selected?.actor === a.id && selected.step === i) || undefined}
                    style={
                      {
                        left: at(st.start_ms),
                        width: width(st.start_ms, st.end_ms),
                      } as CSSProperties
                    }
                    aria-label={`${a.id}: ${KIND_WORD[st.kind]} ${st.name}, ${dur(st.end_ms - st.start_ms)} at ${tickLabel(st.start_ms)}`}
                    onMouseEnter={(ev) => show(ev.currentTarget, { actor: a.id, step: st })}
                    onFocus={(ev) => show(ev.currentTarget, { actor: a.id, step: st })}
                    onBlur={() => setHover(null)}
                    onClick={() => onPick({ actor: a.id, step: i })}
                  />
                );
              })}
            </div>
          ))}
          <div className={s.axis} aria-hidden="true">
            {ticks(d).map((t) => (
              <span key={t} style={{ left: at(t) }}>
                {tickLabel(t)}
              </span>
            ))}
          </div>
          {hover ? (
            <div
              className={s.tip}
              role="tooltip"
              style={{ left: `clamp(8px, ${hover.x}px, calc(100% - 8px))`, top: hover.y }}
              data-flip={hover.x > (tracksRef.current?.clientWidth ?? 0) * 0.6 || undefined}
              data-testid="trace-tip"
            >
              {hover.step ? (
                <StepDetail actor={hover.actor} step={hover.step} compact />
              ) : hover.event ? (
                <>
                  <p className={s.tipHead}>
                    {COORD_WORD[hover.event.kind]}
                    {hover.event.ticket ? `: ${hover.event.ticket}` : ""}
                  </p>
                  <p className={s.tipMeta}>
                    <span className="num">{tickLabel(hover.event.at_ms)}</span>
                    {hover.event.actor ? ` by ${hover.event.actor}` : ""}
                  </p>
                  {hover.event.title ? <p className={s.tipBody}>{hover.event.title}</p> : null}
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <figcaption className={s.key}>
        {KEY.filter((k) => present.has(k.k)).map((k) => (
          <span key={k.k} data-kind={k.k}>
            {k.label}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

function LaneLabel({ actor }: { actor: TraceActor }) {
  const t = actor.totals;
  return (
    <div className={s.laneLabel} data-role={actor.role}>
      <span className={s.laneName}>{actor.id}</span>
      <span className={s.laneMeta}>
        <span className="num">{dur(t.model_ms)}</span> model
        {t.tokens ? (
          <>
            {" "}
            <span className="num">
              {tok(t.tokens.input + t.tokens.output + t.tokens.cache_read + t.tokens.cache_write)}
            </span>{" "}
            tok
          </>
        ) : null}
        {t.cost_micro_usd !== null ? (
          <>
            {" "}
            <span className="num">{usdSmall(t.cost_micro_usd)}</span>
          </>
        ) : null}
      </span>
    </div>
  );
}

function StepDetail({
  actor,
  step,
  compact = false,
}: {
  actor: string;
  step: TraceStep;
  compact?: boolean;
}) {
  const len = step.end_ms - step.start_ms;
  return (
    <div className={s.detail} data-compact={compact || undefined}>
      <p className={s.tipHead} data-kind={step.kind}>
        {step.kind === "model"
          ? step.board_turn
            ? "Model turn (board only)"
            : "Model turn"
          : `${KIND_WORD[step.kind]}: ${step.name}`}
      </p>
      <p className={s.tipMeta}>
        {actor} at <span className="num">{tickLabel(step.start_ms)}</span> for{" "}
        <span className="num">{dur(len)}</span>
        {step.ok === false ? <span className={s.err}> error</span> : null}
        {step.open ? <span className={s.err}> no result</span> : null}
        {step.test_summary ? <span className={s.testSum}> tests {step.test_summary}</span> : null}
      </p>
      {step.input ? (
        <pre className={s.tipIn}>{compact ? clip(step.input, 180) : step.input}</pre>
      ) : null}
      {step.output ? (
        <pre className={s.tipOut}>{compact ? clip(step.output, 220) : step.output}</pre>
      ) : null}
      {step.files?.length ? (
        <p className={s.tipMeta}>
          wrote <span className="num">{step.files.join(", ")}</span>
        </p>
      ) : null}
      {step.tokens ? (
        <p className={s.tipMeta}>
          tokens in <span className="num">{tok(step.tokens.input)}</span> out{" "}
          <span className="num">{tok(step.tokens.output)}</span> cache read{" "}
          <span className="num">{tok(step.tokens.cache_read)}</span>
        </p>
      ) : null}
    </div>
  );
}

function clip(t: string, n: number): string {
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function SessionTable({ trace }: { trace: TrialTrace }) {
  const tt = traceTotals(trace);
  return (
    <div className={s.tableWrap}>
      <table className={s.table}>
        <caption>Per session (tokens and cost from each session’s own result line)</caption>
        <thead>
          <tr>
            <th scope="col">Session</th>
            <th scope="col">Model</th>
            <th scope="col">of it board-only</th>
            <th scope="col">Tools</th>
            <th scope="col">Waiting</th>
            <th scope="col">Turns</th>
            <th scope="col">Tool calls</th>
            <th scope="col">Board calls</th>
            <th scope="col">Tokens in / out</th>
            <th scope="col">Cache read / write</th>
            <th scope="col">Est. cost</th>
          </tr>
        </thead>
        <tbody>
          {trace.actors.map((a) => {
            const t = a.totals;
            return (
              <tr key={a.id}>
                <th scope="row">
                  {a.id}
                  {a.role !== "solo" && a.id !== a.role ? (
                    <small> {ROLE_WORD[a.role]}</small>
                  ) : null}
                </th>
                <td className="num">{dur(t.model_ms)}</td>
                <td className="num">
                  {t.model_board_ms ? `${pct(t.model_board_ms, t.model_ms)}%` : "–"}
                </td>
                <td className="num">{dur(t.tool_ms)}</td>
                <td className="num">{t.wait_ms ? dur(t.wait_ms) : "–"}</td>
                <td className="num">{t.turns}</td>
                <td className="num">
                  {t.tool_calls}
                  {t.tool_errors ? <span className={s.err}> ({t.tool_errors} err)</span> : null}
                </td>
                <td className="num">{t.board_calls || "–"}</td>
                <td className="num">
                  {t.tokens ? `${tok(t.tokens.input)} / ${tok(t.tokens.output)}` : "not reported"}
                </td>
                <td className="num">
                  {t.tokens ? `${tok(t.tokens.cache_read)} / ${tok(t.tokens.cache_write)}` : "–"}
                </td>
                <td className="num">
                  {t.cost_micro_usd !== null ? usdSmall(t.cost_micro_usd) : "–"}
                </td>
              </tr>
            );
          })}
        </tbody>
        {trace.actors.length > 1 ? (
          <tfoot>
            <tr>
              <th scope="row">All</th>
              <td className="num">{dur(tt.modelMs)}</td>
              <td className="num">
                {tt.modelBoardMs ? `${pct(tt.modelBoardMs, tt.modelMs)}%` : "–"}
              </td>
              <td className="num">{dur(trace.actors.reduce((n, a) => n + a.totals.tool_ms, 0))}</td>
              <td className="num">{tt.waitMs ? dur(tt.waitMs) : "–"}</td>
              <td className="num">{tt.turns}</td>
              <td className="num">{tt.toolCalls}</td>
              <td className="num">{tt.boardCalls || "–"}</td>
              <td className="num">
                {tt.tokens ? `${tok(tt.tokens.input)} / ${tok(tt.tokens.output)}` : "–"}
                {tt.tokens && tt.tokenSessions < tt.sessions
                  ? ` (${tt.tokenSessions}/${tt.sessions})`
                  : ""}
              </td>
              <td className="num">
                {tt.tokens ? `${tok(tt.tokens.cacheRead)} / ${tok(tt.tokens.cacheWrite)}` : "–"}
              </td>
              <td className="num">{tt.costMicroUsd !== null ? usdSmall(tt.costMicroUsd) : "–"}</td>
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}
