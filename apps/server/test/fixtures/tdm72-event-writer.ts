// TDM-72 test fixture: the "worker process" side. Appends `count` events to a run through
// appendEvents, in uneven batches, then moves the run to `cancelled` and appends the matching
// run.state_changed event IN THE SAME transaction (seq = count). Run with `node --import tsx`.
//   argv: <database url> <run id> <count> [final state]
import { eq } from "drizzle-orm";
import { createDb } from "../../src/db/client.js";
import { runs } from "../../src/db/schema/runs.js";
import { appendEvents } from "../../src/lib/events.js";
import { messageEventTdm72, stateChangedEventTdm72 } from "../helpers/events-tdm72.js";

const [url, runId, countArg] = process.argv.slice(2);
if (!url || !runId || !countArg) throw new Error("usage: <url> <runId> <count>");
const count = Number(countArg);
const dbh = createDb(url, { max: 2 });
try {
  let written = 0;
  let batch = 1;
  while (written < count - 1) {
    const n = Math.min(batch, count - 1 - written);
    const evs = Array.from({ length: n }, (_, i) => messageEventTdm72(runId, written + i + 1));
    await appendEvents(dbh.db, runId as never, evs);
    written += n;
    batch = (batch % 37) + 1;
    if (written % 100 < n) await new Promise((r) => setTimeout(r, 5));
  }
  await dbh.db.transaction(async (tx) => {
    await tx.update(runs).set({ state: "cancelled" }).where(eq(runs.id, runId));
    await appendEvents(tx, runId as never, [stateChangedEventTdm72(runId, "running", "cancelled")]);
  });
  process.stdout.write(`wrote ${count}\n`);
} finally {
  await dbh.close();
}
