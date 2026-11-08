/** Retention windows from plan.md section 6 (Observability). Keep in sync with the server jobs. */
export const RETENTION_ROWS: readonly { what: string; kept: string }[] = [
  { what: "Run events (the live activity feed, trial phases, alerts)", kept: "90 days" },
  { what: "Mirrored transcripts of our own agents' sessions", kept: "30 days" },
  {
    what: "Logs, trial transcripts, kits and artifacts in object storage",
    kept: "1 year for paid runs, 30 days for free runs",
  },
  { what: "Published benchmark versions", kept: "Indefinitely, so signed versions stay verifiable (unless you ask us to delete them)" },
];
