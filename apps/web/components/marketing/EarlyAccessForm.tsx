"use client";

import { useId, useState, type FormEvent } from "react";
import { cx } from "./cx";
import styles from "./marketing.module.css";
import { normalizeRepoUrl } from "./repo-url";

/** The founder's contact for early access. Shown as text: mailto links are unreliable. */
export const EARLY_ACCESS_EMAIL = "jaxonp808@gmail.com";

type Status =
  | { kind: "idle" }
  | { kind: "invalid" }
  | { kind: "copied"; display: string }
  | { kind: "not-copied"; display: string };

/**
 * Hero "Start a bench" form. Until sign-in and New run ship ([11.3]/[11.4]), it
 * doesn't start anything: it copies the repo URL to the clipboard and tells the
 * visitor how to get their first benchmark run for them. No network calls.
 */
export function EarlyAccessForm() {
  const inputId = useId();
  const noteId = useId();
  const statusId = useId();
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const repo = normalizeRepoUrl(value);
    if (!repo) {
      setStatus({ kind: "invalid" });
      return;
    }
    try {
      await navigator.clipboard.writeText(repo.url);
      setStatus({ kind: "copied", display: repo.display });
    } catch {
      setStatus({ kind: "not-copied", display: repo.display });
    }
  }

  const invalid = status.kind === "invalid";

  return (
    <div className={styles.formBlock}>
      <form
        className={styles.start}
        onSubmit={onSubmit}
        noValidate
        aria-label="Start a bench"
        data-invalid={invalid || undefined}
      >
        <label htmlFor={inputId} className={styles.srOnly}>
          Your project&apos;s repo URL
        </label>
        <input
          id={inputId}
          name="repo"
          type="text"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="github.com/you/your-project"
          className={styles.field}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (status.kind === "invalid") setStatus({ kind: "idle" });
          }}
          aria-invalid={invalid || undefined}
          aria-describedby={`${noteId} ${statusId}`}
        />
        <button type="submit" className={styles.btn}>
          Start a bench
        </button>
      </form>
      <p id={noteId} className={styles.access}>
        <strong>Early access:</strong> we&apos;ll run your first benchmark for you. Send your repo
        and the question you want answered to{" "}
        <span className={styles.email}>{EARLY_ACCESS_EMAIL}</span>.
      </p>
      <p
        id={statusId}
        role="status"
        aria-live="polite"
        className={cx(styles.status, invalid && styles.statusError)}
      >
        {status.kind !== "idle" && <StatusIcon ok={!invalid} />}
        {status.kind === "invalid" && (
          <span>That doesn&apos;t look like a repo. Try github.com/you/your-project.</span>
        )}
        {status.kind === "copied" && (
          <span>
            Copied <code>{status.display}</code> to your clipboard. Paste it into an email to{" "}
            <span className={styles.email}>{EARLY_ACCESS_EMAIL}</span> and we&apos;ll run your first
            benchmark.
          </span>
        )}
        {status.kind === "not-copied" && (
          <span>
            Send <code>{status.display}</code> to{" "}
            <span className={styles.email}>{EARLY_ACCESS_EMAIL}</span> and we&apos;ll run your first
            benchmark.
          </span>
        )}
      </p>
    </div>
  );
}

function StatusIcon({ ok }: { ok: boolean }) {
  return (
    <svg className={styles.statusIcon} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="8.25" stroke="currentColor" strokeWidth="1.5" />
      {ok ? (
        <path
          d="M6.2 10.3l2.5 2.5 5.1-5.4"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M10 5.8v5.2M10 13.6v.4"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}
