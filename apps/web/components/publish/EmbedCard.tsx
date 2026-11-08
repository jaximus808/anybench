// The embed card (/r/<slug>/embed, E12 12.5): verdict, scope, the primary requirement per setup,
// the signature state and a link to the full method. Server component; text nodes only.
import type { PublicPublication } from "@anybench/core";
import type { CSSProperties } from "react";
import { resultRows } from "../report/model";
import { Mark } from "../site/Mark";
import { heroSentence, publicationUrls, shortName, trialLine } from "../../lib/publish/view";
import styles from "./publish.module.css";

/** Hide the site chrome on the embed route only (the root layout renders it everywhere). */
const CHROME_OFF = `body:has([data-embed])>header,body:has([data-embed])>footer,body:has([data-embed])>.skip-link{display:none!important}body:has([data-embed]){background:transparent;min-height:0}body:has([data-embed]) main{padding:0;margin:0}`;

const LIGHT = {
  "--bg": "#f3f1ea",
  "--surface": "#fbfaf6",
  "--fg": "#16170f",
  "--muted": "#5d6052",
  "--dim": "#8a8c7e",
  "--line": "#dad5c8",
  "--line-strong": "#c2bcac",
  "--pass": "#1e7a43",
  "--fail": "#c2321f",
  colorScheme: "light",
} as CSSProperties;

export function EmbedCard({
  data,
  theme,
  origin,
}: {
  data: PublicPublication;
  theme: "light" | "dark" | "auto";
  origin?: string;
}) {
  const wrapClass = theme === "dark" ? "instrument" : undefined;
  const style = theme === "light" ? LIGHT : undefined;
  if (data.status === "withdrawn") {
    return (
      <div data-embed className={wrapClass} style={style}>
        <style>{CHROME_OFF}</style>
        <div className={styles.embed}>
          <div className={styles.embedTop}>
            <span className={styles.embedBrand}>
              <Mark size={14} /> Anybench
            </span>
          </div>
          <p className={styles.embedVerdict}>This benchmark was withdrawn by its owner.</p>
        </div>
      </div>
    );
  }
  const p = data.signed.payload;
  const urls = publicationUrls(p.slug, origin);
  const row = resultRows(p.report).find((r) => r.requirementId === p.badge.requirement) ?? null;
  return (
    <div data-embed className={wrapClass} style={style}>
      <style>{CHROME_OFF}</style>
      <div className={styles.embed} data-testid="embed-card">
        <div className={styles.embedTop}>
          <a className={styles.embedBrand} href={urls.page} target="_blank" rel="noopener">
            <Mark size={14} /> Anybench
          </a>
          <span className={styles.embedSigned} data-valid={data.verification.valid || undefined}>
            {data.verification.valid ? "✓ signed" : "signature not verified"}
          </span>
        </div>
        <p className={styles.embedQuestion}>{p.title}</p>
        <p className={styles.embedVerdict}>{heroSentence(p.badge)}</p>
        <p className={styles.embedScope}>{trialLine(p)}.</p>
        {row ? (
          <ul className={styles.embedRows} aria-label={row.title}>
            {row.cells.map((c) => (
              <li key={c.contenderId}>
                <span>{shortName(c.name)}</span>
                <b>{c.value}</b>
              </li>
            ))}
          </ul>
        ) : null}
        <div className={styles.embedFoot}>
          <span>{row ? row.title : ""}</span>
          <a href={urls.page} target="_blank" rel="noopener">
            Full report and method
          </a>
        </div>
      </div>
    </div>
  );
}
