import type { ReactNode } from "react";
import styles from "./docs.module.css";

export const DRAFT_NOTICE = "Draft — pending founder/legal review";

/** Top-of-page banner on every legal page. Nothing here is final until a person signs it off. */
export function DraftNotice() {
  return (
    <div className={styles.draft} role="note" aria-label="Draft notice">
      <strong>{DRAFT_NOTICE}</strong>
      <span>
        This is a plain-language draft written to match how Anybench works today. It is not yet
        reviewed by a lawyer, and items marked as placeholders are still to be filled in.
      </span>
    </div>
  );
}

/** A fact we do not have yet (company entity, address, jurisdiction). Never guess these. */
export function Placeholder({ children }: { children: ReactNode }) {
  return <mark className={styles.placeholder}>[Placeholder: {children}]</mark>;
}

export type FeatureStatus = "available" | "coming-soon" | "planned";

const STATUS_LABEL: Record<FeatureStatus, string> = {
  available: "Available",
  "coming-soon": "Coming soon",
  planned: "Planned",
};

/** Marks whether a documented feature exists yet, so the docs never promise what isn't built. */
export function StatusTag({ status }: { status: FeatureStatus }) {
  return (
    <span className={`${styles.status} ${status === "available" ? styles.statusOk : ""}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

export function CodeBlock({ code, label }: { code: string; label: string }) {
  return (
    <figure className={styles.code}>
      <figcaption>{label}</figcaption>
      {/* Focusable so keyboard users can scroll long lines. */}
      <pre tabIndex={0}>
        <code>{code}</code>
      </pre>
    </figure>
  );
}

/** Lets a wide table scroll sideways on phones instead of widening the page. */
export function TableWrap({ children }: { children: ReactNode }) {
  return <div className={styles.tableWrap}>{children}</div>;
}

export function Callout({ children }: { children: ReactNode }) {
  return <div className={styles.callout}>{children}</div>;
}
