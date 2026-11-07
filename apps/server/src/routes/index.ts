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
import { corsMiddleware } from "../lib/cors.js";
import { csrfMiddleware } from "../lib/csrf.js";
import type { AppDeps, AppEnv } from "../types.js";
import { eventsRoutes } from "./events.js";
import { authRoutes } from "./auth.js";
import { healthRoutes } from "./health.js";

export function registerRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
  // TDM-65: CORS and CSRF must run before every route, so this line stays first.
  app.use(corsMiddleware(deps.config), csrfMiddleware(deps.config));
  app.route("/auth", authRoutes(deps));
  app.route("/health", healthRoutes(deps));
  app.route("/runs", eventsRoutes(deps));
}
