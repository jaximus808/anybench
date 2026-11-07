// Admin check (TDM-65, plan.md section 9). Admin is decided on EVERY request from
// ADMIN_GITHUB_LOGINS (config.adminGithubLogins, lowercased). It is never stored in the session or
// read back from users.is_admin_cache, so removing a login from the env revokes admin on the next
// request without touching the database.
//
// Usage for `auth: ["admin"]` routes: `r.post("/x", requireSession(deps), adminOnly, handler)`.
import { apiError } from "@anybench/core";
import type { MiddlewareHandler } from "hono";
import type { Config } from "../config.js";
import type { SessionEnv } from "./session.js";

/** True only when `githubLogin` is in ADMIN_GITHUB_LOGINS (GitHub logins are case-insensitive). */
export function isAdminLogin(
  config: Pick<Config, "adminGithubLogins">,
  githubLogin: string,
): boolean {
  const login = githubLogin.trim().toLowerCase();
  return login !== "" && config.adminGithubLogins.includes(login);
}

/** After requireSession: 403 unless the signed-in user is an admin for this request. */
export const adminOnly: MiddlewareHandler<SessionEnv> = async (c, next) => {
  if (!c.get("session").isAdmin) {
    return c.json(apiError("forbidden", "admin only", { request_id: c.get("requestId") }), 403);
  }
  await next();
};
