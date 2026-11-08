// Route registry (TDM-14). THE shared file every API-route ticket appends to.
//
// Pattern, one resource per file:
//   1. Create src/routes/<resource>.ts exporting `export function <resource>Routes(deps: AppDeps)`
//      that returns `new Hono<AppEnv>()` with paths RELATIVE to its mount point.
//   2. Add ONE import line and ONE `app.route(...)` line below, in your ticket's slot. Keep lines
//      sorted by mount path; on a rebase conflict keep both sides' lines.
//   3. Validate params/body with zod (@anybench/core contracts); errors are `ErrorBody` JSON.
//   4. Use deps.db (pooled) through scopedDb(actor, deps.db) for tenant data; c.get("log") to log.
//   No module-level state in route files: everything comes from deps.
import type { Hono } from "hono";
import { defaultBillingGate } from "../lib/billing-gate.js";
import { corsMiddleware } from "../lib/cors.js";
import { csrfMiddleware } from "../lib/csrf.js";
import {
  apiKeyOrSessionAuthenticator,
  memoizeAuthenticate,
  requireScope,
} from "../lib/auth-key.js";
import { graphileJobQueue } from "../lib/job-queue.js";
import type { AppDeps, AppEnv } from "../types.js";
import { apiKeysRoutes } from "./api-keys.js";
import { authRoutes } from "./auth.js";
import { eventsRoutes } from "./events.js";
import { healthRoutes } from "./health.js";
import { kitsRoutes } from "./kits.js";
import { runnerRoutes } from "./runner.js";
import { runsRoutes } from "./runs.js";
import { scanRoutes } from "./scan.js";

export function registerRoutes(app: Hono<AppEnv>, appDeps: AppDeps): void {
  // TDM-65/TDM-66: tenant routes take a Bearer API key or the session cookie unless the caller
  // wired its own authenticator; either way each Request is resolved once.
  const deps: AppDeps = {
    ...appDeps,
    authenticate: memoizeAuthenticate(
      appDeps.authenticate ?? apiKeyOrSessionAuthenticator(appDeps),
    ),
  };
  // TDM-67: the run gate's billing port and the job queue, defaulted for the runs/kits routers.
  const tenant = {
    ...deps,
    billingGate: deps.billingGate ?? defaultBillingGate(deps.config),
    jobs: deps.jobs ?? graphileJobQueue(),
  };
  // TDM-65: CORS and CSRF must run before every route, so this line stays first.
  app.use(corsMiddleware(deps.config), csrfMiddleware(deps.config));
  app.route("/api-keys", apiKeysRoutes(deps));
  app.route("/auth", authRoutes(deps));
  app.route("/health", healthRoutes(deps));
  app.route("/kits", kitsRoutes(tenant));
  // TDM-66: events need `events:read`; a run-scoped key only reaches its own runs.
  app.use("/runs/:id/events", requireScope(deps, "events:read", { runIdParam: "id" }));
  app.use("/runs/:id/stream", requireScope(deps, "events:read", { runIdParam: "id" }));
  app.route("/runs", eventsRoutes(deps));
  app.route("/runs", runsRoutes(tenant));
  app.route("/scans", scanRoutes(deps));
  app.route("/v1/trials", runnerRoutes(deps));
}
