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
import { createRunSuggester, slidingWindowLimiter } from "../lib/suggest.js";
import { createNaiveClient } from "@anybench/naive";
import type { AppDeps, AppEnv } from "../types.js";
import { stripeBillingFromConfig } from "../lib/stripe-billing.js";
import { apiKeysRoutes } from "./api-keys.js";
import { authRoutes } from "./auth.js";
import { billingRoutes, stripeWebhookRoutes } from "./billing.js";
import { eventsRoutes } from "./events.js";
import { healthRoutes } from "./health.js";
import { kitsRoutes } from "./kits.js";
import { publicationsRoutes } from "./publications.js";
import { reportsRoutes } from "./reports.js";
import { runnerRoutes } from "./runner.js";
import { runsRoutes } from "./runs.js";
import { scanRoutes } from "./scan.js";
import { secretsRoutes } from "./secrets.js";
import { suggestRoutes } from "./suggest.js";
import { trialLogsRoutes } from "./trial-logs.js";
import { runTrialsRoutes, trialsRoutes } from "./trials.js";

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
    billingGate: deps.billingGate ?? defaultBillingGate(deps.config, deps.db),
    jobs: deps.jobs ?? graphileJobQueue(),
  };
  // TDM-65: CORS and CSRF must run before every route, so this line stays first.
  app.use(corsMiddleware(deps.config), csrfMiddleware(deps.config));
  app.route("/api-keys", apiKeysRoutes(deps));
  app.route("/auth", authRoutes(deps));
  // stripe-onboarding: link a card (Checkout), the portal, the summary, and the Stripe webhook.
  const billing = {
    ...deps,
    stripeBilling:
      deps.stripeBilling !== undefined
        ? deps.stripeBilling
        : stripeBillingFromConfig(deps.config, deps.logger),
  };
  app.route("/billing", billingRoutes(billing));
  app.route("/health", healthRoutes(deps));
  app.route("/kits", kitsRoutes(tenant));
  // TDM-66: events need `events:read`; a run-scoped key only reaches its own runs.
  app.use("/runs/:id/events", requireScope(deps, "events:read", { runIdParam: "id" }));
  app.use("/runs/:id/stream", requireScope(deps, "events:read", { runIdParam: "id" }));
  app.route("/runs", eventsRoutes(deps));
  // New run screen: POST /runs/suggest (one bounded Naïve session; session cookie only).
  app.route(
    "/runs",
    suggestRoutes({
      ...deps,
      suggester:
        deps.suggester !== undefined
          ? deps.suggester
          : deps.config.NAIVE_API_KEY
            ? createRunSuggester({
                client: createNaiveClient({
                  apiKey: deps.config.NAIVE_API_KEY,
                  ...(deps.config.NAIVE_BASE_URL ? { baseUrl: deps.config.NAIVE_BASE_URL } : {}),
                }),
                model: deps.config.ANYBENCH_SUGGEST_MODEL,
                githubToken: deps.config.GITHUB_TOKEN,
              })
            : null,
      suggestLimiter: deps.suggestLimiter ?? slidingWindowLimiter(),
    }),
  );
  app.route("/runs", runsRoutes(tenant));
  // Run page fix: trials.list (runs:read; a run-scoped key only reaches its own runs).
  app.route("/runs", runTrialsRoutes(deps));
  // Demo: reports.get / reports.markdown (runs:read; a run-scoped key only reaches its own run).
  app.route("/runs", reportsRoutes(deps));
  // Publish: POST/GET /runs/:id/publication(/unpublish), public /public/r/:slug and the keyset.
  app.route("/", publicationsRoutes(deps));
  app.route("/scans", scanRoutes(deps));
  // TDM-224: BYOK model keys (write-only; session users only). Onboarding and Settings store them.
  app.route("/secrets", secretsRoutes(deps));
  // TDM-74: trial logs need `logs:read`; the handler checks a run-scoped key against the trial's run.
  app.use("/trials/:id/log", requireScope(deps, "logs:read"));
  app.use("/trials/:id/logs", requireScope(deps, "logs:read"));
  app.use("/trials/:id/log/stream", requireScope(deps, "logs:read"));
  app.route("/trials", trialLogsRoutes(deps));
  // Run page fix: trials.get (runs:read; the handler checks a run-scoped key against the trial's run).
  app.route("/trials", trialsRoutes(deps));
  app.route("/v1/trials", runnerRoutes(deps));
  app.route("/webhooks", stripeWebhookRoutes(billing));
}
