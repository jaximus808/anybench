// DEV ONLY: the Trace view and "where the time went" rendered from trace JSON on disk (e.g. the
// traces the backfill stored for a real run, read back with the artifact store), for screenshots
// and design work without a signed-in session. `.dev.tsx` keeps it out of production builds.
//
//   ANYBENCH_TRACE_DIR=/path/to/traces pnpm --filter web dev
//   /dev/traces?trial=<trial id>    one trial's Trace view (file: stored-<trial id>.json)
//   /dev/traces?view=summary        the run summary (file: summary.json)
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Metadata } from "next";
import { TraceDev } from "./TraceDev";

export const metadata: Metadata = { title: "Trace (dev)", robots: { index: false } };

export default async function TracesDevPage({
  searchParams,
}: {
  searchParams: Promise<{ trial?: string; view?: string }>;
}) {
  const q = await searchParams;
  const dir = process.env.ANYBENCH_TRACE_DIR;
  if (!dir) return <p style={{ padding: 24 }}>Set ANYBENCH_TRACE_DIR to a folder of trace JSON.</p>;
  const files = (await readdir(dir)).filter((f) => f.startsWith("stored-") && f.endsWith(".json"));
  if (q.view === "summary") {
    const summary = await readFile(path.join(dir, "summary.json"), "utf8");
    return <TraceDev summaryJson={summary} />;
  }
  const id = q.trial && /^[0-9a-f-]{36}$/.test(q.trial) ? q.trial : null;
  const file = id ? `stored-${id}.json` : files[0];
  if (!file || !files.includes(file)) return <p style={{ padding: 24 }}>No such trace.</p>;
  return <TraceDev traceJson={await readFile(path.join(dir, file), "utf8")} />;
}
