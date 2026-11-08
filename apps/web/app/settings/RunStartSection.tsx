"use client";
// "Start runs automatically" (auto_start_runs): new runs skip the Go click once the test plan is
// proven. The server still checks the run's budget cap and the billing gate before it starts.
import type { UserSettings } from "@anybench/core";
import { useState } from "react";
import { apiErrorMessage } from "../../lib/api";
import { saveSettings } from "../../lib/session";
import styles from "./settings.module.css";

export function RunStartSection({ settings }: { settings: UserSettings }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const on = settings.auto_start_runs;
  return (
    <section className={styles.card} aria-labelledby="run-start-title" id="auto-start-runs">
      <h2 id="run-start-title">Starting runs</h2>
      <label className={styles.toggle}>
        <input
          type="checkbox"
          checked={on}
          disabled={busy}
          onChange={async (e) => {
            const next = e.target.checked;
            setBusy(true);
            setError(null);
            try {
              await saveSettings({ auto_start_runs: next });
            } catch (err) {
              setError(apiErrorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        />
        Start runs automatically when the test plan is proven (no Go button)
      </label>
      <p className="muted">
        Billing then starts on its own, within the run&rsquo;s budget cap. You can still choose per
        run on the New run form.
      </p>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
