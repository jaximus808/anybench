// CORS (TDM-65, plan.md section 9): exact-origin allowlist from ALLOWED_ORIGINS, with credentials,
// so the web app (anybench.jaxonp.com) can call the API with `credentials: "include"`.
//
// An origin outside the list gets no CORS headers at all (the browser then refuses to expose the
// response), and its preflight is answered 403. Never `*`: with credentials it would be invalid
// and, reflected, it would hand the session to any site.
import { apiError } from "@anybench/core";
import type { MiddlewareHandler } from "hono";
import type { Config } from "../config.js";
import type { AppEnv } from "../types.js";

export const CORS_ALLOW_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;
export const CORS_ALLOW_HEADERS = [
  "Content-Type",
  "Authorization",
  "Idempotency-Key",
  "Last-Event-ID",
] as const;
export const CORS_EXPOSE_HEADERS = ["X-Request-Id", "Retry-After"] as const;
export const CORS_MAX_AGE_SEC = 600;

export function isAllowedOrigin(
  config: Pick<Config, "allowedOrigins">,
  origin: string | undefined,
): origin is string {
  return origin !== undefined && config.allowedOrigins.includes(origin);
}

export function corsMiddleware(config: Pick<Config, "allowedOrigins">): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const origin = c.req.header("origin");
    const allowed = isAllowedOrigin(config, origin);
    const preflight =
      c.req.method === "OPTIONS" && c.req.header("access-control-request-method") !== undefined;

    if (preflight) {
      if (!allowed) {
        return c.json(
          apiError("forbidden", "origin not allowed", { request_id: c.get("requestId") }),
          403,
          { Vary: "Origin" },
        );
      }
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Allow-Methods": CORS_ALLOW_METHODS.join(", "),
          "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS.join(", "),
          "Access-Control-Max-Age": String(CORS_MAX_AGE_SEC),
          Vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
        },
      });
    }

    await next();
    c.res.headers.append("Vary", "Origin");
    if (allowed) {
      c.res.headers.set("Access-Control-Allow-Origin", origin);
      c.res.headers.set("Access-Control-Allow-Credentials", "true");
      c.res.headers.set("Access-Control-Expose-Headers", CORS_EXPOSE_HEADERS.join(", "));
    }
  };
}
