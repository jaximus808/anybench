// CSRF (TDM-65, plan.md section 9): a mutating request (anything but GET/HEAD/OPTIONS) must carry
// an `Origin` in ALLOWED_ORIGINS.
//
// - A foreign Origin (or `Origin: null`) is refused with 403, whatever credentials it carries.
// - No Origin at all is refused when the request carries the session cookie: browsers always send
//   Origin on cross-site and same-site POSTs, so a cookie without one is not our web app.
// - No Origin and no session cookie passes: CLI, MCP, runner and webhook callers authenticate with
//   a Bearer token or a signature, which a third-party page cannot attach on its own.
import { apiError, SESSION_COOKIE } from "@anybench/core";
import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { Config } from "../config.js";
import type { AppEnv } from "../types.js";
import { isAllowedOrigin } from "./cors.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function csrfMiddleware(config: Pick<Config, "allowedOrigins">): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    const origin = c.req.header("origin");
    const refuse = (message: string) =>
      c.json(apiError("forbidden", message, { request_id: c.get("requestId") }), 403);
    if (origin !== undefined) {
      if (!isAllowedOrigin(config, origin)) return refuse("cross-site request refused");
    } else if (getCookie(c, SESSION_COOKIE) !== undefined) {
      return refuse("Origin header required with a session cookie");
    }
    return next();
  };
}
