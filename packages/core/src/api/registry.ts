// Every route, grouped by resource (TDM-10). The client, the server and the contract test all
// iterate this one object, so a route that is not here does not exist.
import { adminRoutes } from "./admin.js";
import { alertRoutes } from "./alerts.js";
import { apiKeyRoutes } from "./api-keys.js";
import { authRoutes } from "./auth.js";
import { billingRoutes } from "./billing.js";
import { eventRoutes } from "./events.js";
import { inviteRoutes } from "./invites.js";
import { kitRoutes } from "./kits.js";
import { notificationRoutes } from "./notifications.js";
import { outreachRoutes } from "./outreach.js";
import { publishRoutes } from "./publish.js";
import { reportRoutes } from "./reports.js";
import type { RouteSpec } from "./route.js";
import { runnerRoutes } from "./runner.js";
import { runRoutes } from "./runs.js";
import { scanRoutes } from "./scan.js";
import { secretRoutes } from "./secrets.js";
import { trialRoutes } from "./trials.js";
import { uploadRoutes } from "./uploads.js";

export const apiRoutes = {
  auth: authRoutes,
  runs: runRoutes,
  kits: kitRoutes,
  trials: trialRoutes,
  events: eventRoutes,
  runner: runnerRoutes,
  alerts: alertRoutes,
  billing: billingRoutes,
  admin: adminRoutes,
  publish: publishRoutes,
  scan: scanRoutes,
  apiKeys: apiKeyRoutes,
  secrets: secretRoutes,
  uploads: uploadRoutes,
  reports: reportRoutes,
  notifications: notificationRoutes,
  outreach: outreachRoutes,
  invites: inviteRoutes,
} as const;

export type ApiRoutes = typeof apiRoutes;

/** Every route as a flat list. */
export const ALL_ROUTES: readonly RouteSpec[] = Object.values(apiRoutes).flatMap((g) =>
  Object.values(g as Record<string, RouteSpec>),
);

/** Look a route up by its id (`runs.get`). */
export function routeById(id: string): RouteSpec | undefined {
  return ALL_ROUTES.find((r) => r.id === id);
}
