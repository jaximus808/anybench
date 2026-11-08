import { Fragment } from "react";
import styles from "./marketing.module.css";

/** One run of text in a terminal line, optionally coloured: d dim, a accent, g ok, r bad. */
export type Segment = readonly [text: string, tone?: "d" | "a" | "g" | "r"];
export type Line = readonly Segment[];

const TONE = { d: styles.cd, a: styles.ca, g: styles.cg, r: styles.cr } as const;

/**
 * Renders terminal-style output in a <pre> that keeps its spacing. The <pre>
 * scrolls sideways on narrow screens, so it is focusable and labelled for
 * keyboard users.
 */
export function CodeLines({ lines, label }: { lines: readonly Line[]; label: string }) {
  return (
    <pre tabIndex={0} role="group" aria-label={label}>
      {lines.map((line, i) => (
        <Fragment key={i}>
          {line.map(([text, tone], j) =>
            tone ? (
              <span key={j} className={TONE[tone]}>
                {text}
              </span>
            ) : (
              <Fragment key={j}>{text}</Fragment>
            ),
          )}
          {i < lines.length - 1 ? "\n" : null}
        </Fragment>
      ))}
    </pre>
  );
}
