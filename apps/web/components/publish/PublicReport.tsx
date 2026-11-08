// The public benchmark page (/r/<slug>, E12 12.3): a frozen, signed snapshot anyone can read.
// Server component. Every report string is untrusted (agent and kit text): React text nodes only.
//
// Order: the verdict (hero) with the signature seal in the margin; the setups and how they ran;
// per-requirement results as charts (each setup's value with its interval, then the difference vs
// the baseline with its CI and verdict), with the exact numbers in a table under each chart;
// per-task results the same way, under their scope line; how it was evaluated; how to verify; the CTA.
// Honest wording (plan.md 17.2): the hero says better/worse only when the decision rule did, and
// the scope line is always next to any per-task claim.
import type { Publication, PublicPublication } from "@anybench/core";
import Link from "next/link";
import { DiffChart, RequirementChart } from "../bench/Charts";
import { requirementViews, taskViews } from "../bench/model";
import { perTaskRows, resultRows, VERDICT_WORD } from "../report/model";
import { heroSentence, publicationUrls, shortName } from "../../lib/publish/view";
import styles from "./publish.module.css";
import { Scoreboard } from "../report/Scoreboard";
import { buildBoard, cellsFromPublication, type Setup } from "../report/scoreboard-model";

/** The scoreboard bars from the snapshot's raw counts; null on snapshots made before them. */
function publicBoard(p: Publication) {
  const cells = p.evaluation.scoreboard;
  if (!cells?.length) return null;
  const setups: Setup[] = p.evaluation.setups.map((s) => ({
    id: s.contender_id,
    name: s.name,
    baseline: s.role === "baseline",
  }));
  const board = buildBoard(setups, cellsFromPublication(cells), "wall clock, gate-passing trials");
  return board ? { board, setups } : null;
}

type Live = Extract<PublicPublication, { status: "live" }>;

const DATE = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});
const DATETIME = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

const CHECK_LABEL: Record<string, string> = {
  oracle_passes: "The reference solution passes the gate",
  do_less_fails: "A do-nothing contender fails the gate",
  smoke_passes: "A smoke run passes on the real computer",
  regression_scores_lower: "A planted regression scores lower",
  baselines_in_range: "Known baselines land in range",
  no_secret_in_kit: "No secret in the kit",
};

const GATE_KIND: Record<string, string> = {
  "hidden-tests": "hidden tests",
  "output-match": "output match",
  custom: "custom check",
};

export function PublicReport({ data, origin }: { data: Live; origin?: string }) {
  const p = data.signed.payload;
  const urls = publicationUrls(p.slug, origin);
  const sb = publicBoard(p);
  const tone = sb ? "none" : (p.badge.verdict ?? "none");
  return (
    <article className={styles.page} data-testid="public-report">
      <header className={styles.hero}>
        <div className={styles.heroText}>
          <p className={styles.question}>{p.title}</p>
          <h1 className={styles.verdict} data-verdict={tone} data-testid="public-verdict">
            {sb && p.badge.baseline
              ? `${p.badge.subject} vs ${p.badge.baseline}`
              : heroSentence(p.badge)}
          </h1>
          <p className={styles.scope} data-testid="public-scope">
            {p.badge.scope ? `${capitalize(p.badge.scope)}, ` : ""}
            {p.evaluation.trials.graded} graded trials across {p.evaluation.setups.length} setups.
            {p.evaluation.stats.per_task_scope ? ` ${p.evaluation.stats.per_task_scope}` : ""}
          </p>
          <p className={styles.statement}>
            {p.verdict.replace(/no detectable difference/g, "not significant")}
          </p>
        </div>
        <Seal data={data} />
      </header>

      {sb ? (
        <section className={styles.section} aria-labelledby="score-h">
          <h2 id="score-h" className={styles.h2}>
            Scoreboard
          </h2>
          <Scoreboard board={sb.board} setups={sb.setups} />
        </section>
      ) : null}

      <Setups p={p} />

      <section className={styles.section} aria-labelledby="results-h">
        <h2 id="results-h" className={styles.h2}>
          Results by requirement
        </h2>
        <Results p={p} />
      </section>

      <PerTask p={p} />

      <Evaluation p={p} versions={data.versions} />

      <section className={styles.section} aria-labelledby="verify-h" id="verify">
        <h2 id="verify-h" className={styles.h2}>
          Verify this result
        </h2>
        <p className={styles.prose}>
          Anybench signed the snapshot below with Ed25519 when it was published. Nothing on this
          page can change without breaking the signature. To check it yourself, fetch the signed
          snapshot and our public keys, then verify the signature over the canonical JSON of{" "}
          <code>payload</code>.
        </p>
        <ul className={styles.linkList}>
          <li>
            <a href={urls.attestation}>Signed snapshot (attestation.json)</a>
          </li>
          <li>
            <a href={urls.keys}>Public keys (anybench-keys.json)</a>
          </li>
        </ul>
        <pre className={styles.code}>
          {`curl -s ${urls.attestation} > a.json
curl -s ${urls.keys} > keys.json
node -e '
const c=require("crypto"),fs=require("fs");
const a=JSON.parse(fs.readFileSync("a.json")),k=JSON.parse(fs.readFileSync("keys.json"));
const sort=v=>Array.isArray(v)?v.map(sort):v&&typeof v=="object"?Object.fromEntries(Object.keys(v).sort().map(x=>[x,sort(v[x])])):v;
const key=k.keys.find(x=>x.key_id===a.key_id);
const pub=c.createPublicKey({key:Buffer.from(key.public_key_spki_der_b64,"base64"),format:"der",type:"spki"});
console.log(c.verify(null,Buffer.from(JSON.stringify(sort(a.payload))),pub,Buffer.from(a.signature,"base64")));'`}
        </pre>
      </section>

      <aside className={styles.cta} aria-labelledby="cta-h">
        <div>
          <h2 id="cta-h" className={styles.ctaTitle}>
            Benchmark your own project
          </h2>
          <p className={styles.prose}>
            Point Anybench at a repo. Agents write the eval kit, fresh computers run it, and the
            report says whether it is better, with the statistics to back it.
          </p>
        </div>
        <Link href="/runs/new" className={styles.ctaButton}>
          Run your own benchmark
        </Link>
      </aside>
    </article>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function Seal({ data }: { data: Live }) {
  const v = data.verification;
  const sig = data.signed.signature;
  const p = data.signed.payload;
  return (
    <a
      href="#verify"
      className={styles.seal}
      data-valid={v.valid || undefined}
      data-testid="public-seal"
    >
      <span className={styles.sealStatus}>
        <span className={styles.sealMark} aria-hidden="true">
          {v.valid ? "✓" : "!"}
        </span>
        {v.valid ? "Signature verified" : "Signature not verified"}
      </span>
      <span className={styles.sealRow}>
        <span>Key</span>
        <code>{data.signed.key_id}</code>
      </span>
      <span className={styles.sealRow}>
        <span>Signed</span>
        <span>{DATE.format(new Date(p.published_at))}</span>
      </span>
      <span className={styles.sealRow}>
        <span>Version</span>
        <span>{p.version}</span>
      </span>
      <code className={styles.sealSig} title={sig}>
        {sig.slice(0, 22)}…
      </code>
      {!v.valid ? <span className={styles.sealReason}>{v.reason}</span> : null}
    </a>
  );
}

function Setups({ p }: { p: Publication }) {
  const versionsOf = (v: Record<string, string>) =>
    Object.entries(v).map(([k, val]) => {
      const name = k
        .replace(/_VERSION$/, "")
        .toLowerCase()
        .split("_")
        .map(capitalize)
        .join(" ")
        .replace(/^Mcp$/, "MCP")
        .replace(/ Mcp$/, " MCP");
      return `${name} ${val}`;
    });
  return (
    <section className={styles.setups} aria-labelledby="setups-h">
      <h2 id="setups-h" className={styles.h2}>
        Setups compared
      </h2>
      <ol className={styles.setupList}>
        {p.evaluation.setups.map((s) => (
          <li key={s.contender_id} data-role={s.role}>
            <span className={styles.setupName}>
              {shortName(s.name)}
              {s.role === "baseline" ? <span className={styles.role}>baseline</span> : null}
            </span>
            <span className={styles.setupMeta}>
              {[s.model, ...versionsOf(s.versions)].filter(Boolean).join(", ") ||
                "no pinned versions recorded"}
            </span>
            <span className={styles.setupN}>
              {s.graded_trials} trial{s.graded_trials === 1 ? "" : "s"}
            </span>
          </li>
        ))}
      </ol>
      {p.evaluation.disclosure ? (
        <p className={styles.disclosure} data-testid="public-disclosure">
          <span>How every setup ran:</span> {p.evaluation.disclosure}
        </p>
      ) : null}
    </section>
  );
}

function Results({ p }: { p: Publication }) {
  const rows = resultRows(p.report);
  const views = requirementViews(p.report);
  const m = p.evaluation.metrics;
  const missing = [!m.wall_clock && "wall-clock time", !m.cost && "cost"].filter(Boolean);
  if (!rows.length) return <p className={styles.prose}>No requirement was scored.</p>;
  return (
    <>
      {missing.length ? (
        <p className={styles.note} data-testid="public-metrics-note">
          This run did not record {missing.join(" or ")}, so only the requirements below are
          compared. Nothing is estimated in their place.
        </p>
      ) : null}
      {rows.map((row) => {
        const view = views.find((v) => v.id === row.requirementId);
        return (
          <div key={row.requirementId} className={styles.req} data-requirement={row.requirementId}>
            <h3 className={styles.h3}>
              {row.title}
              <code className={styles.reqId}>{row.requirementId}</code>
              {view ? (
                <span className={styles.direction}>
                  {view.lowerIsBetter ? "lower is better" : "higher is better"}
                </span>
              ) : null}
            </h3>
            {view ? <RequirementChart view={view} /> : null}
            <details className={styles.numbers}>
              <summary>Exact numbers</summary>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th scope="col">Setup</th>
                      <th scope="col" className={styles.num}>
                        Result
                      </th>
                      <th scope="col" className={styles.num}>
                        n
                      </th>
                      <th scope="col">Vs baseline</th>
                      <th scope="col">CI of the difference</th>
                      <th scope="col">Smallest detectable difference</th>
                    </tr>
                  </thead>
                  <tbody>
                    {row.cells.map((cell) => {
                      const v = row.verdicts.find((x) => x.contenderId === cell.contenderId);
                      return (
                        <tr key={cell.contenderId}>
                          <th scope="row">{shortName(cell.name)}</th>
                          <td className={styles.num} data-gated={cell.gated || undefined}>
                            {cell.value}
                            {cell.survivorship ? <small> solved only</small> : null}
                          </td>
                          <td className={styles.num}>{cell.n ?? "–"}</td>
                          <td>
                            {v ? (
                              <span className={styles.word} data-verdict={v.verdict}>
                                {v.word}
                                {v.claim === "these_tasks" ? (
                                  <small> on these {v.tasks} tasks</small>
                                ) : null}
                              </span>
                            ) : (
                              <span className={styles.dim}>baseline</span>
                            )}
                          </td>
                          <td className={styles.mono}>{v?.ci ?? "–"}</td>
                          <td className={styles.mono}>{v?.mde ?? "–"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </details>
          </div>
        );
      })}
    </>
  );
}

function PerTask({ p }: { p: Publication }) {
  const rows = perTaskRows(p.report);
  const views = taskViews(p.report);
  const scope = p.report.per_task?.scope ?? null;
  if (!p.report.per_task) return null;
  const tasks = p.report.per_task.tasks;
  return (
    <section className={styles.section} aria-labelledby="tasks-h" data-testid="public-per-task">
      <h2 id="tasks-h" className={styles.h2}>
        Results by task
      </h2>
      <p className={styles.scopeLine} data-testid="public-per-task-scope">
        {scope}
      </p>
      {p.report.per_task.headline.map((h) => (
        <p key={h} className={styles.prose}>
          {h}
        </p>
      ))}
      {rows.map((row) => {
        const view = views.find((v) => v.id === row.requirementId);
        return (
          <div key={row.requirementId} className={styles.req}>
            <h3 className={styles.h3}>
              {row.title}
              <code className={styles.reqId}>{row.requirementId}</code>
            </h3>
            {view ? <DiffChart view={view} testId={`public-task-diff-${view.id}`} /> : null}
            <details className={styles.numbers}>
              <summary>Exact numbers</summary>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th scope="col">Task</th>
                      <th scope="col">Setup</th>
                      <th scope="col">Vs baseline</th>
                      <th scope="col">CI of the difference</th>
                      <th scope="col">Smallest detectable difference</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tasks.flatMap((task) => {
                      const cells = row.cells.filter((c) => c.workloadId === task);
                      return cells.map((cell, i) => (
                        <tr key={`${task}:${cell.contenderId}`} data-first={i === 0 || undefined}>
                          {i === 0 ? (
                            <th scope="rowgroup" rowSpan={cells.length} className={styles.taskCell}>
                              {task}
                            </th>
                          ) : null}
                          <td>{shortName(cell.name)}</td>
                          <td>
                            <span className={styles.word} data-verdict={cell.verdict}>
                              {VERDICT_WORD[cell.verdict]}
                            </span>
                          </td>
                          <td className={styles.mono}>{cell.ci}</td>
                          <td className={styles.mono}>{cell.mde}</td>
                        </tr>
                      ));
                    })}
                  </tbody>
                </table>
              </div>
            </details>
          </div>
        );
      })}
    </section>
  );
}

function Evaluation({ p, versions }: { p: Publication; versions: Live["versions"] }) {
  const e = p.evaluation;
  const t = e.trials;
  const proofChecks = e.proof.checks;
  const alpha = e.stats.alpha ?? 0.05;
  return (
    <section className={styles.section} aria-labelledby="how-h" data-testid="public-how">
      <h2 id="how-h" className={styles.h2}>
        How it was evaluated
      </h2>
      <dl className={styles.facts}>
        <div>
          <dt>Tasks</dt>
          <dd>
            <ul className={styles.plain}>
              {e.tasks.map((task) => (
                <li key={task.id}>
                  <code>{task.id}</code> {task.title}
                  {task.hidden_tests !== null ? (
                    <span className={styles.dim}> ({task.hidden_tests} hidden tests)</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </dd>
        </div>
        <div>
          <dt>Correctness gate</dt>
          <dd>
            <p>
              A trial counts as solved only when it passes every gate. No speed or cost number is
              reported for a trial that failed its gate.
            </p>
            <ul className={styles.plain}>
              {e.gates.map((g) => (
                <li key={g.id}>
                  <code>{g.id}</code>{" "}
                  <span className={styles.dim}>({GATE_KIND[g.kind] ?? g.kind})</span>
                  {g.description ? <span> {g.description}</span> : null}
                </li>
              ))}
            </ul>
          </dd>
        </div>
        <div>
          <dt>Proof the gate works</dt>
          <dd>
            <p>
              <span className={styles.basis} data-basis={e.proof.basis}>
                {e.proof.basis === "proven" ? "Proven" : "Curated"}
              </span>{" "}
              {e.proof.label}
            </p>
            <ul className={styles.checks}>
              {proofChecks.map((c) => (
                <li key={c.check} data-pass={c.pass || undefined}>
                  <span aria-hidden="true">{c.pass ? "✓" : "–"}</span>{" "}
                  {CHECK_LABEL[c.check] ?? c.check}
                  {!c.pass ? <span className={styles.dim}> (not run)</span> : null}
                </li>
              ))}
            </ul>
          </dd>
        </div>
        <div>
          <dt>Trials</dt>
          <dd data-testid="public-trials">
            <p>
              {t.graded} graded, {t.gate_passed} passed every gate. {t.infra_excluded} failed on our
              infrastructure and were excluded from the result and not billed.
              {t.cancelled ? ` ${t.cancelled} cancelled.` : ""}
              {t.warmups ? ` ${t.warmups} warm-ups, not scored.` : ""}
            </p>
          </dd>
        </div>
        <div>
          <dt>Statistics</dt>
          <dd>
            <p>
              Pass rates use exact tests (Fisher, with a Newcombe interval on the difference).
              Continuous metrics use the exact Mann–Whitney test with Cliff’s δ and a Hodges–Lehmann
              interval. p-values are Holm-corrected
              {e.stats.family !== null ? ` across ${e.stats.family} comparisons` : ""} at α ={" "}
              {alpha}. Without a significant result the report says “no detectable difference” and
              gives the smallest difference this sample could have detected.
            </p>
            {e.stats.per_task_scope ? (
              <p>
                Per task, each task’s repeats are the unit
                {e.stats.per_task_family !== null
                  ? `, Holm across ${e.stats.per_task_family} task × requirement tests`
                  : ""}
                . {e.stats.per_task_scope}
              </p>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Kit</dt>
          <dd>
            <code className={styles.hash} data-testid="public-kit-hash">
              {e.kit_hash}
            </code>
            {e.kit_files_sha256 ? (
              <code className={styles.hash}>files {e.kit_files_sha256}</code>
            ) : null}
            <p className={styles.dim}>
              Kit version {e.kit_version}. The hash covers the kit spec: tasks, gates, setups and
              requirements.
              {e.preregistered_at
                ? ` It was frozen on ${DATETIME.format(new Date(e.preregistered_at))}, before the first trial ran.`
                : ""}
            </p>
          </dd>
        </div>
        <div>
          <dt>Dates</dt>
          <dd>
            <p>
              Run started {DATETIME.format(new Date(e.run_started_at))}
              {e.run_delivered_at
                ? `, delivered ${DATETIME.format(new Date(e.run_delivered_at))}`
                : ""}
              . Published {DATETIME.format(new Date(p.published_at))}
              {versions.length > 1 ? ` (version ${p.version} of ${versions.length})` : ""}.
            </p>
            {p.report.comped ? <p className={styles.dim}>This run was comped (free).</p> : null}
          </dd>
        </div>
      </dl>
    </section>
  );
}

/** Shown at /r/<slug> after the owner withdraws it. */
export function WithdrawnNotice({ withdrawnAt }: { withdrawnAt: string }) {
  return (
    <article className={styles.page} data-testid="public-withdrawn">
      <header className={styles.heroPlain}>
        <h1 className={styles.verdict}>This benchmark was withdrawn.</h1>
        <p className={styles.scope}>
          Its owner withdrew it on {DATE.format(new Date(withdrawnAt))}. The result is no longer
          public, and its badge now reads “withdrawn”.
        </p>
        <Link href="/runs/new" className={styles.ctaButton}>
          Run your own benchmark
        </Link>
      </header>
    </article>
  );
}
