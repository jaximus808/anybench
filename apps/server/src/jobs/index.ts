// Job registry (TDM-14). THE shared file every job ticket appends to.
//
// Pattern, one job per file:
//   1. Create src/jobs/<name>.ts exporting `export const <name>Job = defineJob({ name, payload, run })`
//      (types in ./types.ts). `name` is the dotted task name from plan.md section 5.
//   2. Add ONE import line and ONE array entry below. On a rebase conflict keep both sides' lines.
//   3. Enqueue from the API with graphile-worker `quickAddJob`/`addJob` on DATABASE_URL_DIRECT,
//      always with a `jobKey` (`<table>:<id>:<attempt>`), so retries and duplicates collapse.
//   Jobs must be idempotent: graphile-worker retries on throw.
import { heartbeatJob } from "./heartbeat.js";
import type { JobDef } from "./types.js";

export const JOBS: readonly JobDef[] = [heartbeatJob];

export { defineJob, type JobContext, type JobDef } from "./types.js";
