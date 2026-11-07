// Hono app factory (TDM-14). Pure: no listen, no env reads, no in-process state, no DB listeners.
// Entries: main.ts (node-server, local dev and the VM), entry-vercel.ts (Vercel Functions).
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requestId } from "hono/request-id";
import { registerRoutes } from "./routes/index.js";
import type { AppDeps, AppEnv, ErrorBody } from "./types.js";

export type { AppDeps, AppEnv, ErrorBody } from "./types.js";

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use(requestId());
  app.use(async (c, next) => {
    const start = performance.now();
    const log = deps.logger.child({ requestId: c.get("requestId") });
    c.set("log", log);
    await next();
    const ms = Math.round(performance.now() - start);
    const entry = { req: { method: c.req.method, path: c.req.path }, status: c.res.status, ms };
    if (c.res.status >= 500) log.error(entry, "request failed");
    else log.info(entry, "request");
  });

  registerRoutes(app, deps);

  app.notFound((c) =>
    c.json<ErrorBody>(
      { error: { code: "not_found", message: "Not found", requestId: c.get("requestId") } },
      404,
    ),
  );

  app.onError((err, c) => {
    const rid = c.get("requestId");
    if (err instanceof HTTPException && err.status < 500) {
      return c.json<ErrorBody>(
        { error: { code: "http_error", message: err.message, requestId: rid } },
        err.status,
      );
    }
    (c.get("log") ?? deps.logger).error({ err }, "unhandled error");
    deps.sentry.captureException(err, { requestId: rid, path: c.req.path });
    return c.json<ErrorBody>(
      { error: { code: "internal", message: "Internal server error", requestId: rid } },
      500,
    );
  });

  return app;
}
