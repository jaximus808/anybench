"use client";
// The scoreboard at the top of Results: every setup's success rate, time and cost as bars, side
// by side, overall and per task. Raw numbers only; the verdicts and CIs sit under "Statistics".
import { apiRoutes, type RunId, type RunTraceSummary, type Trial } from "@anybench/core";
import { useEffect, useState } from "react";
import { useLiveApi } from "../../lib/live/client";
import { scoreboard, type BarGroup, type Board, type Setup } from "./scoreboard-model";
import s from "./scoreboard.module.css";

async function loadTrials(client: ReturnType<typeof useLiveApi>, id: RunId): Promise<Trial[]> {
  const out: Trial[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await client.call(apiRoutes.trials.list, {
      params: { id },
      query: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    out.push(...res.items);
    if (!res.next_cursor) break;
    cursor = res.next_cursor;
  }
  return out;
}

export function ScoreboardSection({ runId, setups }: { runId: string; setups: Setup[] }) {
  const client = useLiveApi();
  const [trials, setTrials] = useState<Trial[] | null>(null);
  const [trace, setTrace] = useState<RunTraceSummary | null>(null);
  useEffect(() => {
    let stop = false;
    loadTrials(client, runId as RunId)
      .then((t) => !stop && setTrials(t))
      .catch(() => !stop && setTrials([]));
    client
      .call(apiRoutes.trials.traceSummary, { params: { id: runId as RunId } })
      .then((r) => !stop && setTrace(r))
      .catch(() => undefined);
    return () => {
      stop = true;
    };
  }, [client, runId]);
  if (!trials) return null;
  const board = scoreboard(setups, trials, trace);
  if (!board) return null;
  return <Scoreboard board={board} setups={setups} />;
}

function tone(i: number, setup: Setup): string {
  if (setup.baseline) return "base";
  return ["a", "b", "c", "d"][i % 4]!;
}

export function Scoreboard({ board, setups }: { board: Board; setups: Setup[] }) {
  const subjects = setups.filter((x) => !x.baseline);
  const toneOf = (id: string) => {
    const setup = setups.find((x) => x.id === id)!;
    return tone(subjects.indexOf(setup), setup);
  };
  return (
    <div className={s.board} data-testid="scoreboard">
      <ul className={s.legend}>
        {setups.map((x) => (
          <li key={x.id}>
            <i className={s.swatch} data-tone={toneOf(x.id)} />
            {x.name}
            {x.baseline ? <small> baseline</small> : null}
          </li>
        ))}
      </ul>
      <div className={s.groups}>
        {board.headline.map((g) => (
          <Group key={g.key} g={g} toneOf={toneOf} big />
        ))}
      </div>
      {board.tasks.length ? (
        <>
          <h4 className={s.taskHead}>By task</h4>
          <div className={s.taskGrid}>
            {board.tasks.map((t) => (
              <div key={t.task} className={s.task}>
                <p className={s.taskName}>{t.task}</p>
                <div className={s.groups}>
                  {t.groups.map((g) => (
                    <Group key={g.key} g={g} toneOf={toneOf} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function Group({
  g,
  toneOf,
  big = false,
}: {
  g: BarGroup;
  toneOf: (id: string) => string;
  big?: boolean;
}) {
  return (
    <figure className={s.group} data-big={big || undefined}>
      <figcaption>
        <span className={s.gTitle}>{g.title}</span>
        {big ? <span className={s.gHint}>{g.hint}</span> : null}
      </figcaption>
      <div className={s.plot} role="list">
        {g.bars.map((b) => (
          <div
            key={b.setupId}
            className={s.col}
            role="listitem"
            aria-label={`${b.name}: ${b.label}`}
          >
            <span className={s.val} data-best={b.best || undefined}>
              {b.label}
            </span>
            <div className={s.track}>
              <div
                className={s.bar}
                data-tone={toneOf(b.setupId)}
                style={{ height: `${Math.round(b.frac * 100)}%` }}
              />
            </div>
            <span className={s.sub}>{b.sub}</span>
          </div>
        ))}
      </div>
    </figure>
  );
}
