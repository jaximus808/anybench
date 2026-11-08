// Step 1: create exactly ONE Anybench outreach inbox via Monid (agentmail /create-inboxes, $1).
// Idempotent: if /list-inboxes already has an inbox, it prints that and creates nothing.
import { monidGet, monidRun } from "./lib.js";

const before = await monidGet("/v1/wallet/balance");
const list = await monidRun("agentmail", "/list-inboxes", {}, 0);
const items = (list.body?.output?.items ?? list.body?.output?.inboxes ?? []) as unknown[];
if (Array.isArray(items) && items.length > 0) {
  console.log("inbox already exists; not creating another");
  process.exit(0);
}
const username = process.argv[2] ?? "anybench-outreach";
await monidRun(
  "agentmail",
  "/create-inboxes",
  { body: { username, displayName: "Anybench" } },
  1.0,
);
const after = await monidGet("/v1/wallet/balance");
console.log("balance before", before?.balance, "after", after?.balance);
