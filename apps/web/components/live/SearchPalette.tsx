"use client";
// "/" or ⌘K: one search over trials, agents and events. Enter opens the hit.
import { useEffect, useMemo, useRef, useState } from "react";
import { searchRun, type LiveRun, type SearchHit } from "../../lib/live/model";
import styles from "./live.module.css";

const KIND_TAG: Record<SearchHit["kind"], string> = { trial: "TRL", agent: "AGT", event: "EVT" };

export function SearchPalette({
  live,
  onPick,
  onClose,
}: {
  live: LiveRun;
  onPick: (hit: SearchHit) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const hits = useMemo(() => searchRun(live, q, 40), [live, q]);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => setSel(0), [q]);

  return (
    <div className={styles.paletteBackdrop} onMouseDown={onClose}>
      <div
        className={styles.palette}
        role="dialog"
        aria-modal="true"
        aria-label="Search this run"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={input}
          className={styles.paletteInput}
          placeholder="Search trials, agents, events…"
          value={q}
          role="combobox"
          aria-expanded={hits.length > 0}
          aria-controls="palette-list"
          aria-activedescendant={hits[sel] ? `hit-${sel}` : undefined}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.min(hits.length - 1, s + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(0, s - 1));
            } else if (e.key === "Enter" && hits[sel]) {
              e.preventDefault();
              onPick(hits[sel]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <ul id="palette-list" role="listbox" className={styles.paletteList}>
          {q && hits.length === 0 ? (
            <li className={styles.feedEmpty}>Nothing matches “{q}”.</li>
          ) : null}
          {!q ? (
            <li className={styles.paletteHint}>
              Try <kbd>tandem ×5</kbd>, <kbd>failed</kbd>, <kbd>researcher</kbd>,{" "}
              <kbd>bug-hunt</kbd>
            </li>
          ) : null}
          {hits.map((h, i) => (
            <li
              key={`${h.kind}-${h.id}`}
              id={`hit-${i}`}
              role="option"
              aria-selected={i === sel}
              className={styles.paletteHit}
              onMouseEnter={() => setSel(i)}
              onClick={() => onPick(h)}
            >
              <span
                className={styles.feedTag}
                data-source={
                  h.kind === "agent" ? "agent_session" : h.kind === "trial" ? "trial" : "run"
                }
              >
                {KIND_TAG[h.kind]}
              </span>
              <span className={styles.hitLabel}>{h.label}</span>
              <span className={styles.hitDetail}>{h.detail}</span>
            </li>
          ))}
        </ul>
        <p className={styles.paletteFoot}>
          <kbd>↑</kbd>
          <kbd>↓</kbd> move · <kbd>Enter</kbd> open · <kbd>Esc</kbd> close
        </p>
      </div>
    </div>
  );
}
