import type { ReactNode } from "react";
import { LEGAL_LINKS } from "../site/nav";
import { SideNav } from "./DocsPage";
import { CONTACT_EMAIL } from "./links";
import { DraftNotice, Placeholder } from "./Notices";
import styles from "./docs.module.css";

export interface LegalPageProps {
  /** Route of this page, e.g. `/terms`; marks it current in the legal nav. */
  path: string;
  title: string;
  /** One or two sentences that say what the page covers. */
  summary: ReactNode;
  children: ReactNode;
}

/** Shared frame for /terms, /privacy, /refunds and /aup: draft banner, title, nav, contact. */
export function LegalPage({ path, title, summary, children }: LegalPageProps) {
  return (
    <div className={styles.shell}>
      <SideNav label="Legal pages" links={LEGAL_LINKS} current={path} />
      <article className={styles.prose}>
        <DraftNotice />
        <h1>{title}</h1>
        <p className={styles.meta}>
          Last updated: <Placeholder>effective date, set when this page is approved</Placeholder>
        </p>
        <p className={styles.lede}>{summary}</p>
        {children}
        <section aria-labelledby="legal-contact">
          <h2 id="legal-contact">Contact</h2>
          <p>
            Questions about this page, or a request it describes: email{" "}
            <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>. Postal address:{" "}
            <Placeholder>company postal address</Placeholder>.
          </p>
        </section>
      </article>
    </div>
  );
}
