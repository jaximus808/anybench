"use client";
// The run's settings menu (⋯ in the live page's top bar): search, and Cancel run behind a
// confirm. Cancelling is a deliberate act, so it lives here, not as a bar on the monitor.
import { useEffect, useRef, useState } from "react";
import { CancelRun } from "./CancelRun";
import styles from "./live.module.css";

export function RunMenu({
  runId,
  canCancel,
  onSearch,
}: {
  runId: string;
  canCancel: boolean;
  onSearch: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) close();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    setCancelling(false);
  };

  return (
    <div className={styles.runMenu} ref={box}>
      <button
        type="button"
        className={styles.runMenuBtn}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Run settings"
        title="Run settings"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open ? (
        <div className={styles.runMenuPop} role="menu" aria-label="Run settings">
          {cancelling ? (
            <CancelRun runId={runId} confirmFirst onKeep={close} />
          ) : (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  close();
                  onSearch();
                }}
              >
                Search run <kbd>/</kbd>
              </button>
              <a role="menuitem" href="/runs">
                My runs
              </a>
              {canCancel ? (
                <button
                  type="button"
                  role="menuitem"
                  data-danger
                  onClick={() => setCancelling(true)}
                >
                  Cancel run…
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
