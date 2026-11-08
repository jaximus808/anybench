// The public benchmark page (TDM-204): what people get when you share a benchmark link. The
// verdict first, big; then every requirement with its values (with n) and its difference vs the
// baseline (with a CI); per-task results with the scope line; where it breaks; how it was proven;
// the signed attestation; and a share bar. Every setup and every task is always shown.
import type { apiRoutes } from "@anybench/core";
import Link from "next/link";
import { splitAnswer } from "../report/model";
import styles from "./bench.module.css";
import {
  FailuresAndBreaks,
  PassRateBars,
  ProofChecklist,
  RequirementCharts,
  TaskGridChart,
} from "./Charts";
import { requirementViews, VERDICT_WORD } from "./model";
import { ShareBar } from "./ShareBar";

export type BenchPageData = ReturnType<typeof apiRoutes.publish.page.response.parse>;

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });

export function BenchmarkPage({ data }: { data: BenchPageData }) {
  const { benchmark: b, version: v, versions } = data;
  const report = v.report;
  const { headline, disclosure } = splitAnswer(report.answer);
  const withdrawn = b.visibility === "withdrawn";
  const views = requirementViews(report);
  const setups = report.contenders;
  const n = (i: number) => String(i).padStart(2, "0");
  let section = 0;

  return (
    <article className={styles.page} data-testid="benchmark-page">
      <header className={styles.pageHead}>
        <p className={styles.kicker}>
          <Link href="/benchmarks">Anybench benchmark</Link>
          <span>·</span>
          <span className="num">
            {b.owner}/{b.slug}
          </span>
          <span>·</span>
          <span className="num">v{v.version}</span>
          <span>· {fmtDate(v.created_at)}</span>
          {report.comped ? <span className={styles.tag}>comped run</span> : null}
          {b.visibility === "unlisted" ? <span className={styles.tag}>unlisted</span> : null}
        </p>
        <h1 className={styles.title}>{b.title}</h1>
        {withdrawn ? (
          <p className={styles.withdrawn} role="status" data-testid="withdrawn">
            <b>Withdrawn.</b> The owner withdrew this benchmark. Its signed versions stay verifiable
            below, but it no longer represents the project.
          </p>
        ) : null}
        <p className={styles.headline} data-testid="headline">
          {headline}
        </p>
        <ul className={styles.verdicts} aria-label="Verdicts vs the baseline">
          {views.flatMap((view) =>
            view.diffs.map((d) => (
              <li key={`${view.id}:${d.contenderId}`} data-verdict={d.verdict}>
                <b>{view.title}</b>
                <span>
                  {d.name}: {VERDICT_WORD[d.verdict]}
                  {d.claim === "these_tasks" ? ` on these ${d.tasks} tasks` : ""}
                </span>
              </li>
            )),
          )}
        </ul>
        <p className={styles.setups}>
          {setups.map((c, i) => (
            <span key={c.contender_id}>
              {i > 0 ? <em> vs </em> : null}
              {c.name}
              {c.role === "baseline" ? <small> (baseline)</small> : null}
            </span>
          ))}
          <span className={styles.setupsMeta}>
            {" "}
            · <span className="num">{v.attestation.trial_count}</span> trials, each on its own fresh
            computer
          </span>
        </p>
        <ShareBar benchmark={b} />
      </header>

      <section className={styles.section} aria-labelledby="s-gate">
        <h2 id="s-gate">
          <span>§ {n(++section)}</span> The correctness gate
        </h2>
        <p className={styles.lede}>
          Every number below counts only runs that passed this gate: hidden tests the agent never
          sees, checked on a separate computer. A result that fails it is never ranked.
        </p>
        <PassRateBars report={report} />
      </section>

      <section className={styles.section} aria-labelledby="s-results">
        <h2 id="s-results">
          <span>§ {n(++section)}</span> Results
        </h2>
        <p className={styles.lede}>
          Each requirement: every setup&apos;s value with how many runs it rests on, then the
          difference vs the baseline with its confidence interval. Verdicts are Holm-corrected; no
          setup is ranked by a composite score.
        </p>
        <RequirementCharts report={report} />
      </section>

      {report.per_task ? (
        <section className={styles.section} aria-labelledby="s-tasks">
          <h2 id="s-tasks">
            <span>§ {n(++section)}</span> Task by task
          </h2>
          <TaskGridChart report={report} />
        </section>
      ) : null}

      <section className={styles.section} aria-labelledby="s-breaks">
        <h2 id="s-breaks">
          <span>§ {n(++section)}</span> Where it breaks
        </h2>
        <FailuresAndBreaks report={report} />
      </section>

      <section className={styles.section} aria-labelledby="s-proof">
        <h2 id="s-proof">
          <span>§ {n(++section)}</span> How the test was proven fair
        </h2>
        <ProofChecklist report={report} />
        {disclosure ? <p className={styles.disclosure}>How the setups ran: {disclosure}</p> : null}
      </section>

      <section className={styles.section} aria-labelledby="s-signed">
        <h2 id="s-signed">
          <span>§ {n(section + 1)}</span> Signed
        </h2>
        <dl className={styles.attest} data-testid="attestation">
          <div>
            <dt>kit hash</dt>
            <dd className="num">{v.attestation.kit_hash}</dd>
          </div>
          <div>
            <dt>trials</dt>
            <dd className="num">{v.attestation.trial_count}</dd>
          </div>
          <div>
            <dt>setups</dt>
            <dd>
              {v.attestation.contenders
                .map((c) => `${c.name}${c.version ? ` (${c.version})` : ""}`)
                .join(" · ")}
            </dd>
          </div>
          <div>
            <dt>signed</dt>
            <dd className="num">
              Ed25519 · key {v.key_id} · {fmtDate(v.attestation.created_at)}
            </dd>
          </div>
          <div>
            <dt>signature</dt>
            <dd className={`num ${styles.sig}`}>{v.signature}</dd>
          </div>
        </dl>
        <p className={styles.verify}>
          Verify it yourself: <code>anybench verify {b.page_url}</code> checks the signature against
          the public keys at <code>/.well-known/anybench-keys.json</code>.
        </p>
      </section>

      {versions.length > 1 ? (
        <nav className={styles.versions} aria-label="Versions" data-testid="versions">
          <span>Versions</span>
          {versions.map((x) => (
            <Link
              key={x.version}
              href={`/b/${b.owner}/${b.slug}?version=${x.version}`}
              aria-current={x.version === v.version ? "page" : undefined}
            >
              v{x.version} <small>{fmtDate(x.created_at)}</small>
            </Link>
          ))}
        </nav>
      ) : null}

      <footer className={styles.pageFoot}>
        <Link href={`/runs/${b.run_id}/report`}>Full report</Link>
        <a href={`/api/runs/${b.run_id}/report/markdown`}>Markdown</a>
        <span>
          Made with Anybench: benchmarks where every number passed a correctness gate first.
        </span>
      </footer>
    </article>
  );
}
