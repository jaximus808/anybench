"use client";
// "Where the time went" for a run: per setup, the average trial's wall time split by what was in
// flight (model / tools / board only / nothing), the agent time summed over its sessions, and per
// task the turns, board traffic and tokens. Averages over the trials that have a trace; every row
// says its n. Only what the traces carry: no number here is a score or a verdict.
import { ApiClientError, apiRoutes, type RunId, type RunTraceSummary } from "@anybench/core";
import { useEffect, useState } from "react";
import { useLiveApi } from "../../lib/live/client";
import { differenceSentence, dur, pct, setupRows, tok, type SetupRow } from "./model";
import s from "./breakdown.module.css";

export function TimeBreakdownSection({
  runId,
  names,
}: {
  runId: string;
  names: Record<string, string>;
}) {
  const client = useLiveApi();
  const [summary, setSummary] = useState<RunTraceSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    client
      .call(apiRoutes.trials.traceSummary, { params: { id: runId as RunId } })
      .then((r) => !stop && setSummary(r))
      .catch((e: unknown) => {
        if (stop) return;
        // No trace storage or an old run: leave the section out.
        if (e instanceof ApiClientError && (e.status === 404 || e.status === 503)) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      stop = true;
    };
  }, [client, runId]);
  if (error) return <p className={s.note}>Couldn’t load where the time went: {error}</p>;
  if (!summary) return null;
  return <TimeBreakdown summary={summary} names={names} />;
}

const WALL = [
  { k: "model", label: "model call in flight" },
  { k: "tool", label: "tools only" },
  { k: "coord", label: "board calls or waits only" },
  { k: "idle", label: "nothing running" },
] as const;

function wallParts(r: SetupRow) {
  const w = r.avg.wall;
  return { model: w.model_ms, tool: w.tool_ms, coord: w.coordination_ms, idle: w.idle_ms };
}

export function TimeBreakdown({
  summary,
  names,
}: {
  summary: RunTraceSummary;
  names: Record<string, string>;
}) {
  const rows = setupRows(summary, names);
  if (rows.length === 0) return null;
  const maxWall = Math.max(...rows.map((r) => r.avg.duration_ms), 1);
  const agentTotal = (r: SetupRow) =>
    r.avg.agent_ms.model_ms +
    r.avg.agent_ms.tool_ms +
    r.avg.agent_ms.board_ms +
    r.avg.agent_ms.wait_ms;
  const maxAgent = Math.max(...rows.map(agentTotal), 1);
  const diff = differenceSentence(rows);
  const tasks = [
    ...new Set(summary.setups.flatMap((x) => x.by_task.map((t) => t.workload_id))),
  ].sort();

  return (
    <section className={s.box} aria-labelledby="where-h" data-testid="time-breakdown">
      <h3 id="where-h" className={s.title}>
        Where the time went
      </h3>
      <p className={s.lede}>
        The average trial, from its agent transcripts. Each moment counts once, as the busiest thing
        running: a model call, else a tool, else a board call or wait, else nothing.
      </p>
      {diff ? <p className={s.diff}>{diff}</p> : null}

      <div className={s.chart} role="list" aria-label="Wall time per trial">
        {rows.map((r) => {
          const p = wallParts(r);
          return (
            <div key={r.contenderId} className={s.row} role="listitem">
              <div className={s.who}>
                <span className={s.name}>{r.name}</span>
                <span className={s.n}>
                  n={r.avg.n}, {r.avg.passed} passed
                  {r.missing ? `, ${r.missing} without a trace` : ""}
                </span>
              </div>
              <div className={s.barTrack}>
                <div className={s.bar} style={{ width: `${(r.avg.duration_ms / maxWall) * 100}%` }}>
                  {WALL.map(({ k, label }) =>
                    p[k] > 0 ? (
                      <i
                        key={k}
                        data-kind={k}
                        style={{ width: `${(p[k] / r.avg.duration_ms) * 100}%` }}
                        title={`${label}: ${dur(p[k])}`}
                      >
                        {p[k] / maxWall > 0.09 ? dur(p[k]) : ""}
                      </i>
                    ) : null,
                  )}
                </div>
                <span className={s.total}>{dur(r.avg.duration_ms)}</span>
              </div>
            </div>
          );
        })}
      </div>
      <p className={s.keyRow}>
        {WALL.map(({ k, label }) => (
          <span key={k} data-kind={k}>
            {label}
          </span>
        ))}
      </p>

      <h4 className={s.sub}>Agent time, summed over every session of a trial</h4>
      <div className={s.chart} role="list" aria-label="Agent time per trial">
        {rows.map((r) => {
          const a = r.avg.agent_ms;
          const parts = [
            { k: "model", v: a.model_ms - a.model_board_ms, label: "model turns doing the work" },
            {
              k: "modelBoard",
              v: a.model_board_ms,
              label: "model turns that only called the board",
            },
            { k: "tool", v: a.tool_ms, label: "tools" },
            { k: "wait", v: a.wait_ms + a.board_ms, label: "board calls and waits" },
          ];
          const total = agentTotal(r);
          return (
            <div key={r.contenderId} className={s.row} role="listitem">
              <div className={s.who}>
                <span className={s.name}>{r.name}</span>
                <span className={s.n}>
                  n={r.avg.n}, {r.avg.sessions.toFixed(r.avg.sessions % 1 ? 1 : 0)} session
                  {r.avg.sessions === 1 ? "" : "s"}
                </span>
              </div>
              <div className={s.barTrack}>
                <div className={s.bar} style={{ width: `${(total / maxAgent) * 100}%` }}>
                  {parts.map((x) =>
                    x.v > 0 ? (
                      <i
                        key={x.k}
                        data-kind={x.k}
                        style={{ width: `${(x.v / total) * 100}%` }}
                        title={`${x.label}: ${dur(x.v)}`}
                      >
                        {x.v / maxAgent > 0.09 ? dur(x.v) : ""}
                      </i>
                    ) : null,
                  )}
                </div>
                <span className={s.total}>{dur(total)}</span>
              </div>
            </div>
          );
        })}
      </div>
      <p className={s.keyRow}>
        <span data-kind="model">model turns doing the work</span>
        <span data-kind="modelBoard">model turns that only called the board</span>
        <span data-kind="tool">tools</span>
        <span data-kind="wait">board calls and waits</span>
      </p>

      <div className={s.tableWrap}>
        <table className={s.table}>
          <caption>Per task, average per trial</caption>
          <thead>
            <tr>
              <th scope="col">Task</th>
              <th scope="col">Setup</th>
              <th scope="col">n</th>
              <th scope="col">Wall</th>
              <th scope="col">Model in flight</th>
              <th scope="col">Board only</th>
              <th scope="col">Turns</th>
              <th scope="col">Board-only share of model time</th>
              <th scope="col">Board calls</th>
              <th scope="col">Lost claims</th>
              <th scope="col">Output tokens</th>
              <th scope="col">Cache-read tokens</th>
            </tr>
          </thead>
          <tbody>
            {tasks.flatMap((task) =>
              summary.setups.flatMap((setup, i) => {
                const t = setup.by_task.find((b) => b.workload_id === task);
                if (!t) return [];
                const name =
                  names[setup.contender_id] ?? setup.setup ?? setup.contender_id.slice(0, 8);
                return [
                  <tr key={`${task}:${setup.contender_id}`} data-first={i === 0 || undefined}>
                    <th scope="row">{i === 0 ? task : ""}</th>
                    <td>{name}</td>
                    <td className="num">{t.n}</td>
                    <td className="num">{dur(t.duration_ms)}</td>
                    <td className="num">{dur(t.wall.model_ms)}</td>
                    <td className="num">
                      {t.wall.coordination_ms ? dur(t.wall.coordination_ms) : "–"}
                    </td>
                    <td className="num">{t.turns.toFixed(1)}</td>
                    <td className="num">
                      {t.agent_ms.model_board_ms
                        ? `${pct(t.agent_ms.model_board_ms, t.agent_ms.model_ms)}%`
                        : "–"}
                    </td>
                    <td className="num">{t.board_calls ? t.board_calls.toFixed(1) : "–"}</td>
                    <td className="num">{t.lost_claims ? t.lost_claims.toFixed(1) : "–"}</td>
                    <td className="num">
                      {t.tokens ? tok(t.tokens.output) : "–"}
                      {t.tokens && t.tokens.n < t.n ? <small> n={t.tokens.n}</small> : null}
                    </td>
                    <td className="num">
                      {t.tokens ? tok(t.tokens.cache_read) : "–"}
                      {t.tokens && t.tokens.n < t.n ? <small> n={t.tokens.n}</small> : null}
                    </td>
                  </tr>,
                ];
              }),
            )}
          </tbody>
        </table>
      </div>
      <p className={s.note}>
        Tokens come from each session’s own result line; a session stopped before it wrote one (a
        worker still waiting when the board drained) leaves its trial out of the token columns,
        shown as a smaller n. Pass rates and the verdict are in the table above, not here.
      </p>
    </section>
  );
}
