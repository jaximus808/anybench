// The embed widget (TDM-205): the benchmark's title, its one-line answer, a compact bar chart
// of every setup's score and a link to the full public page. Pure: app/embed/[slug]/page.tsx
// loads the state (embed-model.ts) and passes it in, so tests render it from a fixture.
//
// Everything in the payload is publisher text: it renders as React text nodes, never as HTML.
import type { CSSProperties } from "react";
import { EmbedFrame } from "./EmbedFrame";
import { embedRows, formatScore, type EmbedState, type EmbedTheme } from "./embed-model";
import styles from "./Embed.module.css";

const SITE_URL = "https://anybench.jaxonp.com";

function Foot({ version, href }: { version: number | null; href: string }) {
  return (
    <footer className={styles.foot}>
      <span>
        verified by <strong>Anybench</strong>
        {version !== null ? <span className={styles.ver}> · v{version}</span> : null}
      </span>
      <a href={href} target="_blank" rel="noopener noreferrer" className={styles.more}>
        {version !== null ? "Full benchmark" : "anybench"} <span aria-hidden="true">↗</span>
      </a>
    </footer>
  );
}

export function EmbedView({ state, theme }: { state: EmbedState; theme: EmbedTheme }) {
  if (state.kind !== "ok") {
    return (
      <EmbedFrame slug={state.slug} theme={theme}>
        <p className={styles.notice} role="status">
          {state.kind === "missing"
            ? "No published benchmark at this address."
            : "These results can't be loaded right now."}
        </p>
        <Foot version={null} href={SITE_URL} />
      </EmbedFrame>
    );
  }

  const e = state.embed;
  if (e.withdrawn) {
    return (
      <EmbedFrame slug={e.slug} theme={theme}>
        <header className={styles.head}>
          <h1 className={styles.title}>{e.title}</h1>
          <span className={styles.stamp}>withdrawn</span>
        </header>
        <p className={styles.notice}>
          The owner withdrew this benchmark. Its results are no longer published.
        </p>
        <Foot version={e.version} href={e.page_url} />
      </EmbedFrame>
    );
  }

  const rows = embedRows(e.rows);
  const baseline = rows.find((r) => r.baseline && r.score !== null)?.score ?? null;
  const unscored = rows.some((r) => r.score === null);

  return (
    <EmbedFrame slug={e.slug} theme={theme}>
      <header className={styles.head}>
        <h1 className={styles.title}>
          <a href={e.page_url} target="_blank" rel="noopener noreferrer">
            {e.title}
          </a>
        </h1>
      </header>
      <p className={styles.answer}>{e.answer}</p>
      {rows.length > 0 ? (
        <ol className={styles.chart} aria-label="Score per setup, 0 to 100">
          {rows.map((r) => (
            <li
              key={`${r.name}:${r.role}`}
              className={styles.row}
              data-baseline={r.baseline || undefined}
              data-unscored={r.score === null || undefined}
            >
              <span className={styles.rank} aria-label={r.rank ? `rank ${r.rank}` : "not ranked"}>
                {r.rank ?? "–"}
              </span>
              <span className={styles.name}>
                <span className={styles.nameText}>{r.name}</span>
                <span className={styles.role}>{r.role}</span>
              </span>
              <span className={styles.track} aria-hidden="true">
                {r.score !== null ? (
                  <span
                    className={styles.bar}
                    style={{ "--w": `${Math.max(0, Math.min(100, r.score))}%` } as CSSProperties}
                  />
                ) : (
                  <span className={styles.hatch} />
                )}
                {baseline !== null && !r.baseline ? (
                  <span
                    className={styles.ref}
                    style={{ "--x": `${Math.max(0, Math.min(100, baseline))}%` } as CSSProperties}
                  />
                ) : null}
              </span>
              <span className={styles.score}>
                {r.score !== null ? formatScore(r.score) : "no gated score"}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      <p className={styles.legend}>
        score 0–100
        {baseline !== null ? (
          <>
            {" · "}
            <span className={styles.legendRef} aria-hidden="true" /> baseline
          </>
        ) : null}
        {unscored ? " · hatched: no gated score, not ranked" : null}
      </p>
      <Foot version={e.version} href={e.page_url} />
    </EmbedFrame>
  );
}
